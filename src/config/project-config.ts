import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { getProjectRoot } from '../utils/fs.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';
import { ProjectNotInitializedError, WaironError } from '../utils/errors.js';
import {
  ProjectConfigSchema,
  type ProjectConfig,
  type PackSelection,
  type ProjectProfileSelection,
} from '../models/project.js';

// ---------------------------------------------------------------------------
// Project configuration Repository (sdd_core project_config_repository)
//
// `.wai/project.yaml` is held state, so it takes the Repository shape all held
// state takes. This one module realizes the facade and its four owned members
// (N:1 sourcePath):
//
//   project_config_repository   the only way in: reads → index, writes → registry
//   project_config_index        the read path, projected from the store
//   project_config_registry     one intent-level write per method, via the store
//   project_config_store        read-through holding; round-trips unknown keys
//   project_config_fs_adapter   raw YAML in and out, nothing else
//
// The members stay private. Callers get the facade, bound either to the ambient
// project root (`projectConfigRepository`) or to an explicit one
// (`projectConfigRepositoryAt`). The facade's method names ARE the contract's:
// call-step conformance matches a narrative's callee by name.
// ---------------------------------------------------------------------------

/** One `extensions.packs` entry: a legacy path reference, or a by-name selection. */
type PackEntry = string | PackSelection;

/** The facade — iproject_config_repository. */
export interface ProjectConfigRepository {
  load(): ProjectConfig | null;
  exists(): boolean;
  declaresGlobalPacks(): boolean;
  specsDir(): string;
  create(config: ProjectConfig): void;
  upsertPackSelection(selection: PackSelection): boolean;
  removePackSelection(packName: string): boolean;
  setProjectType(projectType: string): void;
  recordProfileSelection(selection: ProjectProfileSelection): void;
  setExecutionTier(tier: string): void;
  registerPackRef(ref: string): boolean;
  deregisterPackRef(ref: string): boolean;
  markSelectionsBundled(bundled: PackSelection[]): void;
  pinGlobalPacksAsSelections(selections: PackSelection[]): void;
}

/** iproject_config_index — the read half of the facade. */
type ProjectConfigIndex = Pick<ProjectConfigRepository, 'load' | 'exists' | 'declaresGlobalPacks' | 'specsDir'>;

/** iproject_config_registry — the write half of the facade. */
type ProjectConfigRegistry = Omit<ProjectConfigRepository, keyof ProjectConfigIndex>;

// ── project_config_fs_adapter ───────────────────────────────────────────────

/** The raw document exactly as YAML produced it: no schema, no defaults. */
export type ProjectConfigDocument = unknown;

/** iproject_config_fs_adapter. */
export interface ProjectConfigFsAdapter {
  readDocument(): ProjectConfigDocument | null;
  writeDocument(document: ProjectConfigDocument): void;
  documentExists(): boolean;
}

/**
 * A project's `.wai` directory: `.wai/` first, then the legacy `.wairon/` of older
 * installs. The same rule as loader.ts's aiDirAt, restated here so this module
 * never imports the loader — the loader resolves its specs folder through it.
 */
function waiDirAt(root: string): string {
  const wai = path.join(root, '.wai');
  const legacy = path.join(root, '.wairon');
  return !fs.existsSync(wai) && fs.existsSync(legacy) ? legacy : wai;
}

/** The fs adapter for an explicit project root. Exported only as a test seam. */
export function projectConfigFsAdapterAt(rootDir: string): ProjectConfigFsAdapter {
  const root = path.resolve(rootDir);
  const file = (): string => path.join(waiDirAt(root), 'project.yaml');
  return {
    readDocument() {
      // null when the file is absent; a malformed document raises the YAML error naming the file.
      return readYamlFile(file());
    },
    writeDocument(document) {
      // A plain replacement, not an atomic rename — as the loader always wrote it.
      writeYamlFile(file(), document);
    },
    documentExists() {
      // existsSync answers false for an unreadable directory too.
      return fs.existsSync(file());
    },
  };
}

// ── project_config_store ────────────────────────────────────────────────────

/** iproject_config_store. */
interface ProjectConfigStore {
  read(): ProjectConfig | null;
  write(config: ProjectConfig): void;
  exists(): boolean;
  declares(field: string): boolean;
}

/**
 * The store, plus the one raw field read the index needs to locate the specs
 * folder of a configuration that fails the schema. iproject_config_store has no
 * method returning a raw value, so this stays a private seam between two members
 * of the same Repository.
 */
interface HeldProjectConfig {
  store: ProjectConfigStore;
  rawValueAt(field: string): unknown;
}

function storeOver(adapter: ProjectConfigFsAdapter, root: string): HeldProjectConfig {
  const currentDocument = (): ProjectConfigDocument | null =>
    (adapter.documentExists() ? adapter.readDocument() : null);

  const store: ProjectConfigStore = {
    read() {
      if (!adapter.documentExists()) return null;
      return parseConfig(adapter.readDocument(), root);
    },
    write(config) {
      const checked = ProjectConfigSchema.safeParse(config);
      if (!checked.success) {
        throw new WaironError(`Refusing to write an invalid .wai/project.yaml at ${root}: ${checked.error.message}`);
      }
      adapter.writeDocument(overlayKnownFields(ProjectConfigSchema, config, currentDocument()));
    },
    exists() {
      return adapter.documentExists();
    },
    declares(field) {
      return valueAt(currentDocument(), field) !== undefined;
    },
  };
  return { store, rawValueAt: (field) => valueAt(currentDocument(), field) };
}

/** Parse the document against the schema, defaults applied, with the loader's error on failure. */
function parseConfig(document: ProjectConfigDocument | null, root: string): ProjectConfig {
  try {
    return ProjectConfigSchema.parse(document);
  } catch (e: unknown) {
    throw new WaironError(
      `Invalid .wai/project.yaml: ${e instanceof Error ? e.message : String(e)}\n(project root: ${root})`,
    );
  }
}

/** The raw value at a top-level or dotted path, or undefined when the document does not set it. */
function valueAt(document: unknown, field: string): unknown {
  let current = document;
  for (const segment of field.split('.')) {
    if (!isPlainObject(current) || !hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** Peel the wrappers that do not change what shape a value has. */
function shapeOf(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodDefault) current = current._def.innerType;
    else if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) current = current.unwrap();
    else if (current instanceof z.ZodEffects) current = current.innerType();
    else if (current instanceof z.ZodLazy) current = current.schema;
    else return current;
  }
}

/**
 * The document to write: the typed value, with every key the schema does not know
 * carried over from the document on disk, at every object level.
 *
 * Known keys and every array come from the typed value, so an entry the caller
 * dropped stays dropped. Keys the schema does not know come back verbatim, so a
 * hand-added or newer key survives any write. The schema's object shapes say which
 * is which. Anything that is not an object level — arrays, scalars, unions no object
 * option accepts — is the typed value, whole.
 */
function overlayKnownFields(schema: z.ZodTypeAny, typed: unknown, onDisk: unknown): unknown {
  if (!isPlainObject(typed)) return typed;
  const shape = shapeOf(schema);
  if (shape instanceof z.ZodObject) {
    const fields = shape.shape as Record<string, z.ZodTypeAny>;
    // A passthrough or catchall object keeps foreign keys through the parse itself.
    const open = shape._def.unknownKeys === 'passthrough' || !(shape._def.catchall instanceof z.ZodNever);
    return overlayLevel(typed, onDisk, (key) => (hasOwn(fields, key) ? fields[key] : open ? z.unknown() : null));
  }
  if (shape instanceof z.ZodRecord) {
    // Every key of a record is data, so every key is known.
    const valueType = shape._def.valueType as z.ZodTypeAny;
    return overlayLevel(typed, onDisk, () => valueType);
  }
  if (shape instanceof z.ZodUnion) {
    const options = shape._def.options as z.ZodTypeAny[];
    const match = options.find((option) => shapeOf(option) instanceof z.ZodObject && option.safeParse(typed).success);
    return match ? overlayKnownFields(match, typed, onDisk) : typed;
  }
  return typed;
}

/**
 * One object level of the overlay. `schemaFor(key)` is the key's schema, or null
 * when the level does not know the key. The document's key order is kept; keys new
 * to the document are appended in the typed value's order.
 */
function overlayLevel(
  typed: Record<string, unknown>,
  onDisk: unknown,
  schemaFor: (key: string) => z.ZodTypeAny | null,
): Record<string, unknown> {
  const document = isPlainObject(onDisk) ? onDisk : {};
  const out: Record<string, unknown> = {};
  for (const [key, stored] of Object.entries(document)) {
    const schema = schemaFor(key);
    if (schema === null) out[key] = stored;
    else if (typed[key] !== undefined) out[key] = overlayKnownFields(schema, typed[key], stored);
  }
  for (const [key, value] of Object.entries(typed)) {
    if (hasOwn(document, key) || value === undefined) continue;
    const schema = schemaFor(key);
    if (schema !== null) out[key] = overlayKnownFields(schema, value, undefined);
  }
  return out;
}

// ── project_config_registry ─────────────────────────────────────────────────

/**
 * What an absent `extensions.useGlobalPacks` means: the schema's own default, read
 * from the schema so this writer and the parse can never disagree. It equals
 * extension_orchestrator's GLOBAL_PACKS_DEFAULT; a test pins the two together.
 */
const USE_GLOBAL_PACKS_DEFAULT: boolean = ProjectConfigSchema.shape.extensions.unwrap().parse({}).useGlobalPacks;

/** `extensions.useGlobalPacks` at its effective value — what globalPacksEnabled() answers. */
function effectiveUseGlobalPacks(config: ProjectConfig): boolean {
  return config.extensions?.useGlobalPacks ?? USE_GLOBAL_PACKS_DEFAULT;
}

function packsOf(config: ProjectConfig): PackEntry[] {
  return config.extensions?.packs ?? [];
}

/**
 * The configuration with `extensions.packs` replaced. It also records
 * `useGlobalPacks` at its effective value, so a project that changed its packs counts
 * as having decided about global packs.
 */
function withPacks(config: ProjectConfig, packs: PackEntry[]): ProjectConfig {
  return { ...config, extensions: { ...config.extensions, packs, useGlobalPacks: effectiveUseGlobalPacks(config) } };
}

function registryOver(store: ProjectConfigStore, root: string): ProjectConfigRegistry {
  /** The configuration to change; a project with none is refused. */
  const current = (): ProjectConfig => {
    const config = store.read();
    if (!config) throw new ProjectNotInitializedError();
    return config;
  };

  return {
    create(config) {
      if (store.exists()) {
        throw new WaironError(`A project configuration already exists at ${root}; creating one never overwrites it.`);
      }
      store.write(config);
    },
    upsertPackSelection(selection) {
      const config = current();
      const existing = packsOf(config);
      const without = existing.filter((entry) => typeof entry === 'string' || entry.name !== selection.name);
      store.write(withPacks(config, [...without, selection]));
      return without.length !== existing.length;
    },
    removePackSelection(packName) {
      const config = current();
      const existing = packsOf(config);
      const remaining = existing.filter((entry) => typeof entry === 'string' || entry.name !== packName);
      if (remaining.length === existing.length) return false;
      store.write(withPacks(config, remaining));
      return true;
    },
    setProjectType(projectType) {
      store.write({ ...current(), projectType });
    },
    recordProfileSelection(selection) {
      store.write({ ...current(), profileSelection: selection });
    },
    setExecutionTier(tier) {
      const config = current();
      // The contract takes a string; the store refuses a tier the schema does not know.
      store.write({ ...config, execution: { ...config.execution, tier: tier as ProjectConfig['execution']['tier'] } });
    },
    registerPackRef(ref) {
      const config = current();
      const packs = packsOf(config);
      if (packs.includes(ref)) return false;
      store.write(withPacks(config, [...packs, ref]));
      return true;
    },
    deregisterPackRef(ref) {
      const config = current();
      const packs = packsOf(config);
      const remaining = packs.filter((entry) => entry !== ref);
      if (remaining.length === packs.length) return false;
      store.write(withPacks(config, remaining));
      return true;
    },
    markSelectionsBundled(bundled) {
      const config = current();
      store.write(withPacks(config, bundleInPlace(packsOf(config), bundled)));
    },
    pinGlobalPacksAsSelections(selections) {
      const config = current();
      store.write({
        ...config,
        extensions: { ...config.extensions, packs: [...packsOf(config), ...selections], useGlobalPacks: false },
      });
    },
  };
}

/**
 * Each selection of a bundled pack gets that pack's version and `bundle: true`. The
 * entry stays where it is, and a pack the project does not select is skipped.
 */
function bundleInPlace(packs: PackEntry[], bundled: PackSelection[]): PackEntry[] {
  const next = [...packs];
  for (const pack of bundled) {
    next.forEach((entry, i) => {
      if (typeof entry === 'string' || entry.name !== pack.name) return;
      const marked: PackSelection = { ...entry, bundle: true };
      if (pack.version !== undefined) marked.version = pack.version;
      else delete marked.version;
      next[i] = marked;
    });
  }
  return next;
}

// ── project_config_index ────────────────────────────────────────────────────

function indexOver(held: HeldProjectConfig, root: string): ProjectConfigIndex {
  const { store } = held;
  return {
    load() {
      return store.read();
    },
    exists() {
      return store.exists();
    },
    declaresGlobalPacks() {
      return store.declares('extensions.useGlobalPacks');
    },
    specsDir() {
      // Read raw, not parsed, so a configuration that fails the schema still locates
      // its specs. Never throws: an unreadable document falls back like a missing one.
      try {
        const declared = held.rawValueAt('paths.specsDir');
        if (declared) return path.resolve(root, declared as string);
      } catch {
        // fall back below
      }
      return path.join(waiDirAt(root), 'specs');
    },
  };
}

// ── project_config_repository ───────────────────────────────────────────────

/**
 * The Repository over a given fs adapter. Exported only as a test seam: a test
 * wraps the real adapter to observe writes.
 */
export function projectConfigRepositoryOver(adapter: ProjectConfigFsAdapter, rootDir: string): ProjectConfigRepository {
  const root = path.resolve(rootDir);
  const held = storeOver(adapter, root);
  const index = indexOver(held, root);
  const registry = registryOver(held.store, root);
  return {
    load() { return index.load(); },
    exists() { return index.exists(); },
    declaresGlobalPacks() { return index.declaresGlobalPacks(); },
    specsDir() { return index.specsDir(); },
    create(config) { registry.create(config); },
    upsertPackSelection(selection) { return registry.upsertPackSelection(selection); },
    removePackSelection(packName) { return registry.removePackSelection(packName); },
    setProjectType(projectType) { registry.setProjectType(projectType); },
    recordProfileSelection(selection) { registry.recordProfileSelection(selection); },
    setExecutionTier(tier) { registry.setExecutionTier(tier); },
    registerPackRef(ref) { return registry.registerPackRef(ref); },
    deregisterPackRef(ref) { return registry.deregisterPackRef(ref); },
    markSelectionsBundled(bundled) { registry.markSelectionsBundled(bundled); },
    pinGlobalPacksAsSelections(selections) { registry.pinGlobalPacksAsSelections(selections); },
  };
}

/** The Repository bound to an explicit project root. */
export function projectConfigRepositoryAt(rootDir: string): ProjectConfigRepository {
  return projectConfigRepositoryOver(projectConfigFsAdapterAt(rootDir), rootDir);
}

const bound = (): ProjectConfigRepository => projectConfigRepositoryAt(getProjectRoot());

/**
 * The Repository bound to the ambient project root (a request's binding, else the
 * override, else the resolved cwd), resolved again on every call.
 */
export const projectConfigRepository: ProjectConfigRepository = {
  load() { return bound().load(); },
  exists() { return bound().exists(); },
  declaresGlobalPacks() { return bound().declaresGlobalPacks(); },
  specsDir() { return bound().specsDir(); },
  create(config) { bound().create(config); },
  upsertPackSelection(selection) { return bound().upsertPackSelection(selection); },
  removePackSelection(packName) { return bound().removePackSelection(packName); },
  setProjectType(projectType) { bound().setProjectType(projectType); },
  recordProfileSelection(selection) { bound().recordProfileSelection(selection); },
  setExecutionTier(tier) { bound().setExecutionTier(tier); },
  registerPackRef(ref) { return bound().registerPackRef(ref); },
  deregisterPackRef(ref) { return bound().deregisterPackRef(ref); },
  markSelectionsBundled(bundled) { bound().markSelectionsBundled(bundled); },
  pinGlobalPacksAsSelections(selections) { bound().pinGlobalPacksAsSelections(selections); },
};

/**
 * @deprecated Transitional seam for loader.ts's `saveProjectConfig` only; wave 3 of
 * stage 2a-0 deletes both. Saves the whole document at the ambient root through the
 * store: validated, with unknown keys round-tripped. It bypasses the registry's intent
 * methods, so it has no contract. Write through `projectConfigRepository` instead.
 */
export function replaceProjectConfigTransitional(config: ProjectConfig): void {
  const root = path.resolve(getProjectRoot());
  storeOver(projectConfigFsAdapterAt(root), root).store.write(config);
}

// ── project_config type behaviour ───────────────────────────────────────────

/** The extension a pack path reference carries — the pattern server/packs.ts's stem() strips. */
const PACK_EXT_RE = /\.(ya?ml|cjs|js)$/i;

/**
 * The names of the packs a configuration declares, deduplicated in first-seen order:
 * each `extensions.packs` entry (a selection's name, or a path reference's file stem),
 * then the required and default pack names its profile selection records.
 */
export function declaredPackNames(config: Pick<ProjectConfig, 'extensions' | 'profileSelection'>): string[] {
  const selection = config.profileSelection;
  return [...new Set([
    ...(config.extensions?.packs ?? []).map((entry) =>
      (typeof entry === 'string' ? path.basename(entry).replace(PACK_EXT_RE, '') : entry.name)),
    ...(selection?.requiredPackNames ?? []),
    ...(selection?.defaultPackNames ?? []),
  ])];
}

/** The profile ids a configuration's profile selection records, deduplicated; never `projectType`. */
export function declaredProfileIds(config: Pick<ProjectConfig, 'profileSelection'>): string[] {
  return [...new Set(config.profileSelection?.profileIds ?? [])];
}
