import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { getProjectRoot } from '../utils/fs.js';
import { parseYaml, readYamlFile, writeYamlFile } from '../utils/yaml.js';
import { readFileOrNull, writeFile } from '../utils/fs.js';
import { ProjectNotInitializedError, WaironError } from '../utils/errors.js';
import { rekeyAnchor, type CarriedRekey, type IdentityRename } from '../models/identity-rename.js';
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
  rekeyCarried(rename: IdentityRename, dryRun?: boolean): CarriedRekey[];
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
  readText(): string | null;
  writeText(text: string): void;
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
    readText() {
      // The bytes as they are — comments, quoting and line endings included.
      return readFileOrNull(file());
    },
    writeText(text) {
      writeFile(file(), text);
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
  readField(field: string): ProjectConfigDocument | undefined;
  rewriteScalars(edits: ScalarEdit[], dryRun?: boolean): void;
}

/**
 * One scalar of the document to replace in place (scalar_edit): where it sits,
 * as a path of keys and sequence indexes from the document root, what it must
 * hold now, and what it holds after.
 */
export interface ScalarEdit {
  path: (string | number)[];
  from: string;
  to: string;
}

function storeOver(adapter: ProjectConfigFsAdapter, root: string): ProjectConfigStore {
  const currentDocument = (): ProjectConfigDocument | null =>
    (adapter.documentExists() ? adapter.readDocument() : null);

  return {
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
    readField(field) {
      // The raw document, before any schema parsing, so a configuration the schema
      // rejects still yields the field.
      return valueAt(currentDocument(), field);
    },
    rewriteScalars(edits, dryRun = false) {
      if (edits.length === 0) return;
      const text = adapter.readText();
      if (text === null) throw new ProjectNotInitializedError();
      const next = rewriteScalarsInText(text, edits, root);
      if (!dryRun) adapter.writeText(next);
    },
  };
}

// ── the comment-preserving scalar edit ──────────────────────────────────────
//
// `.wai/project.yaml` is written by people as well as by wairon: it carries
// comments that say why each carried group exists and how many findings it
// holds. A write through the parsed document drops every one of them. So a
// write that only changes some scalars changes those scalars in the TEXT, in
// their own quoting, and nothing else — and proves it: the edited text is
// parsed again and must equal the document with exactly those values changed.
// A layout this edit cannot address precisely (a flow collection, a
// multi-line scalar) is refused before anything is written, naming the path.

/** One line's structure, as far as locating a scalar needs it. */
interface LineToken {
  kind: 'key' | 'item' | 'scalar';
  /** The column the key, the item's dash, or the scalar starts at. */
  col: number;
  line: number;
  /** The key's name, for a key. */
  name?: string;
  /** Where the inline value starts in the line (a key's value, a scalar item's text), when the line has one. */
  valueStart?: number;
}

const KEY_RE = /^('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^\s'"#{}[\],&*!|>%@`][^:#]*?)\s*:(?=\s|$)/;

/** The key and item structure of the text, block scalars' bodies skipped. */
function tokenize(lines: string[]): LineToken[] {
  const tokens: LineToken[] = [];
  let blockAbove: number | null = null;
  lines.forEach((raw, line) => {
    const content = raw.replace(/\r?\n$/, '');
    const indent = content.length - content.trimStart().length;
    const trimmed = content.trim();
    if (blockAbove !== null) {
      if (trimmed === '' || indent > blockAbove) return;
      blockAbove = null;
    }
    if (trimmed === '' || trimmed.startsWith('#')) return;
    let col = indent;
    let rest = content.slice(indent);
    while (rest === '-' || rest.startsWith('- ')) {
      tokens.push({ kind: 'item', col, line });
      const after = rest.slice(1);
      const pad = after.length - after.trimStart().length;
      col += 1 + pad;
      rest = after.trimStart();
    }
    if (rest === '') return;
    const key = KEY_RE.exec(rest);
    if (key) {
      const name = key[1].startsWith("'") ? key[1].slice(1, -1).replace(/''/g, "'")
        : key[1].startsWith('"') ? JSON.parse(key[1]) as string : key[1].trim();
      const afterKey = rest.slice(key[0].length);
      const value = afterKey.trimStart();
      const token: LineToken = { kind: 'key', col, line, name };
      if (value !== '' && !value.startsWith('#')) token.valueStart = col + key[0].length + (afterKey.length - value.length);
      tokens.push(token);
      if (/^[|>][-+0-9]*\s*(#.*)?$/.test(value)) blockAbove = col;
      return;
    }
    tokens.push({ kind: 'scalar', col, line, valueStart: col });
    if (/^[|>][-+0-9]*\s*(#.*)?$/.test(rest)) blockAbove = col - 2;
  });
  return tokens;
}

/** The tokens nested under the token at `index`: everything after it until the structure returns to its column. */
function childrenOf(tokens: LineToken[], index: number): LineToken[] {
  const parent = tokens[index];
  const out: LineToken[] = [];
  for (let i = index + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    const nested = t.col > parent.col
      // A block sequence may sit at its key's own column: `key:\n- a`.
      || (parent.kind === 'key' && t.kind === 'item' && t.col === parent.col);
    if (!nested) break;
    out.push(t);
  }
  return out;
}

/** The token holding the scalar at `path`, or why it cannot be addressed precisely. */
function locateScalar(tokens: LineToken[], path: (string | number)[]): LineToken | string {
  let region = tokens;
  for (let k = 0; k < path.length; k += 1) {
    const segment = path[k];
    if (region.length === 0) return `nothing is nested at ${path.slice(0, k).join('.')}`;
    const base = Math.min(...region.map((t) => t.col));
    const last = k === path.length - 1;
    let at: number;
    if (typeof segment === 'string') {
      at = region.findIndex((t) => t.kind === 'key' && t.col === base && t.name === segment);
      if (at < 0) return `no block key "${segment}" at ${path.slice(0, k).join('.') || 'the document root'}`;
      if (last) return region[at].valueStart !== undefined ? region[at] : `"${segment}" holds no inline scalar`;
    } else {
      const items = region.map((t, i) => ({ t, i })).filter(({ t }) => t.kind === 'item' && t.col === base);
      if (segment >= items.length) return `no block sequence item ${segment} at ${path.slice(0, k).join('.')}`;
      at = items[segment].i;
      if (last) {
        const value = region[at + 1];
        return value && value.kind === 'scalar' && value.line === region[at].line ? value : `item ${segment} holds no inline scalar`;
      }
    }
    const regionStart = tokens.indexOf(region[at]);
    region = childrenOf(tokens, regionStart);
  }
  return 'an empty path addresses no scalar';
}

/** The scalar written at the start of `text`: its value, how it was quoted, and where it ends. */
function readScalar(text: string): { value: string; style: 'plain' | 'single' | 'double'; end: number } | null {
  if (text.startsWith("'")) {
    let i = 1;
    let value = '';
    while (i < text.length) {
      if (text[i] === "'") {
        if (text[i + 1] === "'") { value += "'"; i += 2; continue; }
        return { value, style: 'single', end: i + 1 };
      }
      value += text[i];
      i += 1;
    }
    return null;
  }
  if (text.startsWith('"')) {
    const closing = /^"(?:[^"\\]|\\.)*"/.exec(text);
    if (!closing) return null;
    try {
      return { value: JSON.parse(closing[0]) as string, style: 'double', end: closing[0].length };
    } catch {
      return null;
    }
  }
  const comment = text.search(/\s#/);
  const body = (comment < 0 ? text : text.slice(0, comment)).trimEnd();
  return { value: body, style: 'plain', end: body.length };
}

/** A value written in the style the old one was, falling back to single quotes where plain would read differently. */
function writeScalar(value: string, style: 'plain' | 'single' | 'double'): string {
  if (style === 'double') return JSON.stringify(value);
  if (style === 'plain' && /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

/** The document with the value at `path` set, for the proof. */
function setAt(document: unknown, path: (string | number)[], value: string): void {
  let node = document as Record<string | number, unknown>;
  for (const segment of path.slice(0, -1)) node = node[segment] as Record<string | number, unknown>;
  node[path[path.length - 1]] = value;
}

/**
 * Replace the named scalars in the document's text and nothing else: each is
 * located by walking its path through the block structure, checked to hold
 * `from`, and rewritten in its own quoting (plain stays plain where plain reads
 * the same). The result is parsed again and must equal the original document
 * with exactly those values changed — anything else is refused, and nothing is
 * returned for the caller to write.
 */
function rewriteScalarsInText(text: string, edits: ScalarEdit[], root: string): string {
  const refuse = (why: string): never => {
    throw new WaironError(`Cannot rewrite .wai/project.yaml at ${root} without disturbing its formatting: ${why}. Nothing was written.`);
  };
  const lines = text.split(/(?<=\n)/);
  const tokens = tokenize(lines);
  const expected = parseYaml(text);
  for (const edit of edits) {
    const where = edit.path.join('.');
    const token = locateScalar(tokens, edit.path);
    if (typeof token === 'string') refuse(`${where}: ${token}`);
    const { line, valueStart } = token as LineToken;
    const content = lines[line].replace(/\r?\n$/, '');
    const ending = lines[line].slice(content.length);
    const scalar = readScalar(content.slice(valueStart!));
    if (!scalar) refuse(`${where}: the scalar there is not written on one line`);
    if (scalar!.value !== edit.from) refuse(`${where} holds "${scalar!.value}", not "${edit.from}"`);
    lines[line] = content.slice(0, valueStart!) + writeScalar(edit.to, scalar!.style)
      + content.slice(valueStart! + scalar!.end) + ending;
    setAt(expected, edit.path, edit.to);
  }
  const next = lines.join('');
  if (JSON.stringify(parseYaml(next)) !== JSON.stringify(expected)) {
    refuse('the edited text does not read back as exactly the intended change');
  }
  return next;
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
  // A save never writes a defaulted id: an id is set only by a deliberate writer
  // (init, provisioning, doctor), which knows what the project should answer to.
  const save = (config: ProjectConfig): void => store.write(config);

  return {
    create(config) {
      if (store.exists()) {
        throw new WaironError(`A project configuration already exists at ${root}; creating one never overwrites it.`);
      }
      save(config);
    },
    upsertPackSelection(selection) {
      const config = current();
      const existing = packsOf(config);
      const without = existing.filter((entry) => typeof entry === 'string' || entry.name !== selection.name);
      save(withPacks(config, [...without, selection]));
      return without.length !== existing.length;
    },
    removePackSelection(packName) {
      const config = current();
      const existing = packsOf(config);
      const remaining = existing.filter((entry) => typeof entry === 'string' || entry.name !== packName);
      if (remaining.length === existing.length) return false;
      save(withPacks(config, remaining));
      return true;
    },
    setProjectType(projectType) {
      save({ ...current(), projectType });
    },
    recordProfileSelection(selection) {
      save({ ...current(), profileSelection: selection });
    },
    setExecutionTier(tier) {
      const config = current();
      // The contract takes a string; the store refuses a tier the schema does not know.
      save({ ...config, execution: { ...config.execution, tier: tier as ProjectConfig['execution']['tier'] } });
    },
    registerPackRef(ref) {
      const config = current();
      const packs = packsOf(config);
      if (packs.includes(ref)) return false;
      save(withPacks(config, [...packs, ref]));
      return true;
    },
    deregisterPackRef(ref) {
      const config = current();
      const packs = packsOf(config);
      const remaining = packs.filter((entry) => entry !== ref);
      if (remaining.length === packs.length) return false;
      save(withPacks(config, remaining));
      return true;
    },
    markSelectionsBundled(bundled) {
      const config = current();
      save(withPacks(config, bundleInPlace(packsOf(config), bundled)));
    },
    pinGlobalPacksAsSelections(selections) {
      const config = current();
      save({
        ...config,
        extensions: { ...config.extensions, packs: [...packsOf(config), ...selections], useGlobalPacks: false },
      });
    },
    rekeyCarried(rename, dryRun = false) {
      // The register as it is WRITTEN — before schema defaults — so every
      // index below is the index of the text the store edits.
      const groups = store.readField('rules.conformance.carried');
      if (!Array.isArray(groups)) return [];
      const edits: ScalarEdit[] = [];
      const rekeys: CarriedRekey[] = [];
      groups.forEach((group, g) => {
        const findings = (group as { findings?: unknown } | null)?.findings;
        if (!Array.isArray(findings)) return;
        findings.forEach((finding, f) => {
          const entry = finding as { code?: unknown; spec?: unknown; at?: unknown; covers?: unknown } | null;
          if (!entry || typeof entry.spec !== 'string') return;
          const at = typeof entry.at === 'string' ? entry.at : undefined;
          const covers = Array.isArray(entry.covers) ? entry.covers.filter((u): u is string => typeof u === 'string') : undefined;
          const next = rekeyAnchor(rename, { spec: entry.spec, at, covers });
          const base = ['rules', 'conformance', 'carried', g, 'findings', f];
          const named = { code: String(entry.code), spec: entry.spec, at: at ?? '' };
          const change = (path: (string | number)[], field: CarriedRekey['field'], from: string, to: string): void => {
            if (from === to) return;
            edits.push({ path: [...base, ...path], from, to });
            rekeys.push({ ...named, field, from, to });
          };
          change(['spec'], 'spec', entry.spec, next.spec);
          if (at !== undefined) change(['at'], 'at', at, next.at!);
          (covers ?? []).forEach((unit, u) => change(['covers', u], 'covers', unit, next.covers![u]));
        });
      });
      // A dry run still proves the text can be edited precisely.
      store.rewriteScalars(edits, dryRun);
      return rekeys;
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

function indexOver(store: ProjectConfigStore, root: string): ProjectConfigIndex {
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
      // Read through the store's readField (the raw document, before schema parsing),
      // so a configuration that fails the schema still locates its specs. Never throws:
      // an unreadable document falls back like a missing one.
      try {
        const declared = store.readField('paths.specsDir');
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
  const store = storeOver(adapter, root);
  const index = indexOver(store, root);
  const registry = registryOver(store, root);
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
    rekeyCarried(rename, dryRun) { return registry.rekeyCarried(rename, dryRun); },
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
  rekeyCarried(rename, dryRun) { return bound().rekeyCarried(rename, dryRun); },
};
