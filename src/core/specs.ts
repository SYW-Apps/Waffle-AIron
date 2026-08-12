import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { aiPathsAt, loadProjectConfig, WaiPaths } from '../config/loader.js';
import { ensureDir, listFiles, listFilesRecursive, pathExists, getProjectRoot, runWithProjectRoot } from '../utils/fs.js';
import { computeStateId, hashGateState, stateIdEquals, type StateId, type GateConfig } from './statehash.js';
import { loadProjectExtensions } from './extensions.js';
import { readLockRecord, type LockRecord } from './lockfile.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';
import {
  SystemSpec,
  SystemSpecSchema,
  SubsystemSpec,
  SubsystemSpecSchema,
  ComponentSpec,
  ComponentSpecSchema,
  InterfaceSpec,
  InterfaceSpecSchema,
  ImplementationSpec,
  ImplementationSpecSchema,
  TypeSpec,
  TypeSpecSchema,
  GroupSpec,
  GroupSpecSchema,
  SpecStatus,
} from '../models/index.js';
import type { ValidationIssue } from './validation.js';
import { resolveNarrativeLabels } from './narrative-labels.js';
import { buildGraphModel } from './diagram.js';
import type { WebGraphModel } from '../server/types.js';

// ---------------------------------------------------------------------------
// Spec workspace
//
// All spec-tree state (index cache, loader issues, freshness signature, root
// subsystem set) lives on a SpecWorkspace instance keyed by project root.
// Nested subproject resolution asks for the CHILD's workspace instead of
// temporarily overriding a global project root — the override juggling that
// used to live here was the main source of namespacing regressions.
//
// The module-level functions at the bottom keep the historical flat API and
// delegate to the workspace of the current project root.
// ---------------------------------------------------------------------------

interface SpecIndex {
  subsystems: SubsystemSpec[];
  components: ComponentSpec[];
  interfaces: InterfaceSpec[];
  implementations: ImplementationSpec[];
  types: TypeSpec[];
  groups: GroupSpec[];
  paths: {
    subsystem: Record<string, string>;
    component: Record<string, string>;
    interface: Record<string, string>;
    implementation: Record<string, string>;
    type: Record<string, string>;
    group: Record<string, string>;
  };
}

function emptyIndex(): SpecIndex {
  return {
    subsystems: [],
    components: [],
    interfaces: [],
    implementations: [],
    types: [],
    groups: [],
    paths: {
      subsystem: {},
      component: {},
      interface: {},
      implementation: {},
      type: {},
      group: {},
    },
  };
}

// ---------------------------------------------------------------------------
// Pure namespace helpers
// ---------------------------------------------------------------------------

function qualifyId(id: string, prefix: string, rootSubsystems: ReadonlySet<string>): string;
function qualifyId(id: string | undefined, prefix: string, rootSubsystems: ReadonlySet<string>): string | undefined;
function qualifyId(id: string | undefined, prefix: string, rootSubsystems: ReadonlySet<string>): string | undefined {
  if (!id) return id;
  if (id.startsWith('::')) {
    return id.slice(2);
  }
  if (id.startsWith('super::')) {
    const prefixParts = prefix.split('::');
    const idParts = id.split('::');
    while (idParts[0] === 'super') {
      idParts.shift();
      prefixParts.pop();
    }
    return [...prefixParts, ...idParts].join('::');
  }
  const firstSegment = id.split('::')[0];
  if (rootSubsystems.has(firstSegment)) {
    return id;
  }
  return prefix ? `${prefix}::${id}` : id;
}

export function splitNamespace(qualifiedId: string): { prefix: string; localId: string } {
  if (!qualifiedId.includes('::')) {
    return { prefix: '', localId: qualifiedId };
  }
  const parts = qualifiedId.split('::');
  const localId = parts.pop()!;
  return { prefix: parts.join('::'), localId };
}

/**
 * The exact inverse of `qualifyId`: turn an in-memory qualified id back into
 * the relative form that re-qualifies to the same id when the file is loaded
 * again from `prefix`'s namespace context.
 *
 * - `::`/`super::` forms are already relative — passed through.
 * - Ids under `prefix` lose it (the local case).
 * - Ids in a DIFFERENT namespace climb to the common ancestor with `super::`
 *   hops, or anchor `::`-absolute when there is none. Never truncate to the
 *   last segment: that re-qualifies into the LOCAL namespace on the next load
 *   and silently corrupts the reference (the cross-tree targetComponent bug).
 * - At the root context (empty prefix) qualified ids are already absolute in
 *   the loading namespace and round-trip as-is.
 */
function relativizeId(id: string, prefix: string): string {
  if (id.startsWith('::') || id.startsWith('super::')) {
    return id;
  }
  // Root context: in-memory ids are already absolute in the loading namespace
  // and round-trip as-is.
  if (!prefix) {
    return id;
  }
  if (id.startsWith(`${prefix}::`)) {
    return id.slice(prefix.length + 2);
  }
  // The mount namespace itself (a flat external subsystem's own id, e.g. a
  // child component's `subsystem` field): stored bare, it resolves in BOTH
  // load contexts — as the child's root subsystem standalone, and via the
  // root-subsystem anchor when loaded through the parent.
  if (id === prefix) {
    return id.split('::').pop()!;
  }
  // NOT under the save prefix — including a BARE id, which in a prefixed
  // context is a root-level reference (what qualifyId('super::x'/'::x')
  // resolves to), never a local one: locals carry the prefix in memory.
  // Emit super:: hops to the deepest common ancestor — a RELATIVE path whose hop
  // count is the physical nesting between source and target, which is invariant
  // across WHICH ancestor is the loading root. This is the key to a chained
  // subproject validating identically from the top project and from its own dir
  // as a standalone root: an absolute ::-anchor instead encodes the depth from
  // the current root and silently breaks the moment the root changes (the
  // "different root, different verdict" bug).
  const prefixParts = prefix.split('::');
  const idParts = id.split('::');
  let common = 0;
  while (common < prefixParts.length && common < idParts.length && prefixParts[common] === idParts[common]) {
    common++;
  }
  // The id IS an ancestor namespace: step out one more hop so it can be named.
  if (common === idParts.length) common--;
  return `${'super::'.repeat(prefixParts.length - common)}${idParts.slice(common).join('::')}`;
}

/** True when `file` is the same as, or nested under, directory `dir`. */
function isWithin(dir: string, file: string): boolean {
  const d = path.resolve(dir);
  const f = path.resolve(file);
  return f === d || f.startsWith(d + path.sep);
}

// ---------------------------------------------------------------------------
// projectPath chaining containment (Fix B2)
//
// A subsystem's `projectPath` is resolved with path.resolve, which honors
// absolute paths and ../ traversal. Left unchecked, a chained subproject could
// escape the bound project root and federate — and, via a code pack living
// there, execute — another tenant's spec tree. The single invariant enforced
// everywhere a projectPath is written or resolved: the child directory must
// stay strictly within its owning project root. Empty/undefined projectPath is
// not chaining and is never checked here (callers skip it).
// ---------------------------------------------------------------------------

/**
 * Whether a subproject's already-resolved child directory escapes `projectRoot`.
 * `resolvedChildDir` is resolved by the caller because for multi-hop chains the
 * resolution base is an intermediate parent, while the containment boundary is
 * always the bound top root. An absolute `projectPath` or a `../`-escape fails.
 */
function projectPathEscapesRoot(
  projectRoot: string,
  projectPath: string,
  resolvedChildDir: string,
): boolean {
  return path.isAbsolute(projectPath) || !isWithin(projectRoot, resolvedChildDir);
}

/**
 * Assert a subsystem `projectPath` resolves strictly within `projectRoot`, and
 * return the resolved absolute child directory. Throws a clear Error naming the
 * offending path when `projectPath` is absolute or `../`-escapes the root.
 * Applied on every write/setter path that persists a projectPath; the load-time
 * loader uses projectPathEscapesRoot directly (it collects issues, not throws).
 */
export function assertContainedProjectPath(projectRoot: string, projectPath: string): string {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, projectPath);
  if (projectPathEscapesRoot(root, projectPath, resolved)) {
    throw new Error(
      `projectPath "${projectPath}" must resolve within the project root "${root}", but resolves ` +
        `to "${resolved}"; absolute paths and ../-escaping paths are rejected so a chained ` +
        `subproject is always contained by its parent.`,
    );
  }
  return resolved;
}

/**
 * The detected chaining-mount context of a project root: which parent project
 * mounts this tree as a chained subsystem. Produced by a filesystem walk-up
 * (never configured), so it reflects where the tree ACTUALLY sits.
 */
export interface ChainingParentRef {
  /** Absolute root directory of the parent project whose subsystem projectPath resolves to this project's root. */
  parentRoot: string;
  /** Id of the parent-tree subsystem that mounts this project. */
  subsystemId: string;
}

/**
 * Walk UP from a project root to find a PARENT wairon project that chains to it
 * — a subsystem (anywhere in the parent's spec tree) whose `projectPath` resolves
 * to this exact root. Returns the parent root + the subsystem id it mounts as, or
 * null when this is a top-level root.
 *
 * This is how a STANDALONE validation of a subproject knows it is a subproject:
 * references INTO the parent tree (shared types, sibling subsystems, cross-tree
 * components — all of which live ABOVE this root and are physically absent here)
 * cannot be resolved standalone, so they are honest cross-tree edges to warn on,
 * not spec defects to error on. Pure filesystem read; no cache mutation.
 */
export function findChainingParent(childRoot: string): ChainingParentRef | null {
  let childResolved: string;
  try {
    childResolved = path.resolve(childRoot);
  } catch {
    return null;
  }
  let dir = path.dirname(childResolved);
  for (let hops = 0; hops < 32; hops++) {
    const specsDir = aiPathsAt(dir).specsDir();
    if (pathExists(specsDir)) {
      for (const file of listFilesRecursive(specsDir, '.yaml')) {
        let raw: unknown;
        try {
          raw = readYamlFile(file);
        } catch {
          continue;
        }
        // A subsystem spec (has parentSystem) that mounts a child via projectPath.
        if (raw && typeof raw === 'object' && 'parentSystem' in raw) {
          const projectPath = (raw as { projectPath?: unknown }).projectPath;
          if (typeof projectPath === 'string' && projectPath.trim() !== '') {
            try {
              if (path.resolve(dir, projectPath) === childResolved) {
                const id = (raw as { id?: unknown }).id;
                return { parentRoot: dir, subsystemId: typeof id === 'string' ? id : '?' };
              }
            } catch {
              /* malformed projectPath — not our mount */
            }
          }
        }
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * Walk DOWN from a project root and list every chained subproject root beneath
 * it, as project-relative POSIX directories in walk order (parents before their
 * own children). The downward companion to findChainingParent, and what a
 * WHOLE-TREE operation — archiving a project for transfer — needs in order to
 * know which trees belong to this project.
 *
 * Mirrors the loader's recursion guards exactly, but silently: a mount that
 * escapes the root (absolute / `../`), points at a missing directory, or forms a
 * cycle is SKIPPED rather than reported, because this is a pure locator and the
 * loader already raises those as issues on every scan. Returns [] for a project
 * that chains nothing.
 */
export function listChainedRoots(rootDir: string = getProjectRoot()): string[] {
  const root = path.resolve(rootDir);
  const found: string[] = [];
  const visited = new Set<string>([root]);

  const walk = (projectDir: string, depth: number): void => {
    if (depth > 32) return; // the loader's own bound on chain depth
    const specsDir = aiPathsAt(projectDir).specsDir();
    if (!pathExists(specsDir)) return;
    for (const file of listFilesRecursive(specsDir, '.yaml')) {
      let raw: unknown;
      try {
        raw = readYamlFile(file);
      } catch {
        continue;
      }
      // A subsystem spec (has parentSystem) that mounts a child via projectPath.
      if (!raw || typeof raw !== 'object' || !('parentSystem' in raw)) continue;
      const projectPath = (raw as { projectPath?: unknown }).projectPath;
      if (typeof projectPath !== 'string' || projectPath.trim() === '') continue;

      let childDir: string;
      try {
        childDir = path.resolve(projectDir, projectPath);
      } catch {
        continue; // malformed projectPath — not a resolvable mount
      }
      // Containment is checked against the BOUND root, so no hop however deep
      // may escape it; nesting still resolves against the immediate parent.
      if (projectPathEscapesRoot(root, projectPath, childDir)) continue;
      if (visited.has(childDir)) continue;
      if (!fs.existsSync(childDir)) continue;

      visited.add(childDir);
      found.push(path.relative(root, childDir).split(path.sep).join('/'));
      walk(childDir, depth + 1);
    }
  };

  walk(root, 0);
  return found;
}

/**
 * Collapse a mount subsystem (has projectPath) and its same-id child realization
 * into a single flat external subsystem: the child provides the content, the
 * mount contributes projectPath. Genuine duplicates (both internal or both
 * external) are left intact for the validator to flag.
 */
function mergeMountRealizations(subs: SubsystemSpec[]): SubsystemSpec[] {
  const result: SubsystemSpec[] = [];
  const indexById = new Map<string, number>();
  for (const sub of subs) {
    const at = indexById.get(sub.id);
    if (at === undefined) {
      indexById.set(sub.id, result.length);
      result.push(sub);
      continue;
    }
    const prev = result[at];
    const prevExternal = !!prev.projectPath;
    const subExternal = !!sub.projectPath;
    if (prevExternal !== subExternal) {
      const mount = prevExternal ? prev : sub;
      const child = prevExternal ? sub : prev;
      result[at] = { ...child, projectPath: mount.projectPath };
    } else {
      result.push(sub);
    }
  }
  return result;
}

function stripNamespaceFromSubsystem(spec: SubsystemSpec, prefix: string): SubsystemSpec {
  // MUST mirror the loader (scanSpecsForProject step 2): an external
  // (projectPath) subsystem's members are qualified with the subsystem's own
  // qualified id, not with its surrounding namespace — so they relativize
  // against that same prefix. Deriving both from the subsystem id's namespace
  // left a root-mounted external subsystem's members fully qualified on save,
  // which the writer schema then refused (the lock-blocking asymmetry).
  // A BARE member is already in load form (a freshly constructed spec that
  // never went through scan qualification) and passes through untouched —
  // subsystem members bind the subsystem's OWN components, never cross-tree.
  const memberPrefix = spec.projectPath ? spec.id : prefix;
  const relMember = (id: string): string => (id.includes('::') ? relativizeId(id, memberPrefix) : id);
  return {
    ...spec,
    id: relativizeId(spec.id, prefix),
    publicInterfaces: spec.publicInterfaces.map(pi => ({
      ...pi,
      component: pi.component ? relMember(pi.component) : undefined,
      interface: pi.interface ? relMember(pi.interface) : undefined,
    })),
    lifecycle: spec.lifecycle?.map(le => ({
      ...le,
      component: relMember(le.component),
    })),
  };
}

function stripNamespaceFromComponent(spec: ComponentSpec, prefix: string): ComponentSpec {
  return {
    ...spec,
    id: relativizeId(spec.id, prefix),
    subsystem: relativizeId(spec.subsystem, prefix),
    owns: spec.owns.map(o => relativizeId(o, prefix)),
    dependsOn: spec.dependsOn.map(d => relativizeId(d, prefix)),
    dispatch: spec.dispatch?.map(b => ({
      ...b,
      component: relativizeId(b.component, prefix),
    })),
  };
}

function stripNamespaceFromInterface(spec: InterfaceSpec, prefix: string): InterfaceSpec {
  return {
    ...spec,
    id: relativizeId(spec.id, prefix),
    component: relativizeId(spec.component, prefix),
  };
}

function stripNamespaceFromImplementation(spec: ImplementationSpec, prefix: string): ImplementationSpec {
  return {
    ...spec,
    id: relativizeId(spec.id, prefix),
    contract: relativizeId(spec.contract, prefix),
    methods: spec.methods.map(m => ({
      ...m,
      narrative: m.narrative.map(step => ({
        ...step,
        targetComponent: step.targetComponent ? relativizeId(step.targetComponent, prefix) : undefined,
      })),
    })),
  };
}

function stripNamespaceFromType(spec: TypeSpec, prefix: string): TypeSpec {
  return {
    ...spec,
    id: relativizeId(spec.id, prefix),
    subsystem: spec.subsystem ? relativizeId(spec.subsystem, prefix) : undefined,
  };
}

function stripNamespaceFromGroup(spec: GroupSpec, prefix: string): GroupSpec {
  return {
    ...spec,
    id: relativizeId(spec.id, prefix),
  };
}

// ---------------------------------------------------------------------------
// Pure structural helpers
// ---------------------------------------------------------------------------

/**
 * The pattern component that owns `id` via its `owns` list (at most one — the
 * SHARED_OWNED_MEMBER rule forbids two owners), or null. An owned member nests
 * physically under its owner because the owner owns its *implementation*; an
 * interface/port reference uses `dependsOn` and stays a flat sibling instead.
 */
function findOwner(id: string, components: ComponentSpec[]): ComponentSpec | null {
  const { localId } = splitNamespace(id);
  return components.find((c) => {
    const { localId: cLocalId } = splitNamespace(c.id);
    if (cLocalId === localId) return false;
    return (c.owns ?? []).some(ownedId => {
      const { localId: ownedLocalId } = splitNamespace(ownedId);
      return ownedLocalId === localId;
    });
  }) ?? null;
}

function moveComponentFolder(fromDir: string, toDir: string): boolean {
  if (path.normalize(fromDir) === path.normalize(toDir)) return false;
  if (!fs.existsSync(fromDir) || fs.existsSync(toDir)) return false; // don't clobber
  ensureDir(path.dirname(toDir));
  fs.renameSync(fromDir, toDir);
  return true;
}

/** Helper to clean up empty parent directories up to the given specs root. */
function cleanEmptyDirs(filePath: string, specsRoot: string): void {
  let dir = path.dirname(filePath);
  while (dir !== specsRoot && dir.startsWith(specsRoot)) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    } else {
      break;
    }
  }
}

/**
 * Validate a spec object against its schema before it is written to disk, so a
 * malformed delta (e.g. via sdd_update_spec) fails loudly instead of writing a
 * corrupt file that only surfaces on the next scan. Returns the parsed value
 * (with schema defaults applied).
 */
/** One rendering for writer-schema refusals — shared by parseOrThrow and the dry-run so validate-time output is byte-comparable with the mid-write error it predicts. */
function formatZodIssues(error: z.ZodError): string {
  return error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown, kind: string, id: string): z.infer<S> {
  const res = schema.safeParse(value);
  if (!res.success) {
    throw new Error(`Refusing to write invalid ${kind} spec "${id}": ${formatZodIssues(res.error)}`);
  }
  return res.data;
}

// Freshness signature over file paths + mtimes + sizes, so a long-running
// process (the MCP server) notices external YAML edits.
const SIGNATURE_TTL_MS = 2000;

function computeSpecTreeSignature(dirs: string[]): string {
  const parts: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      parts.push(`${dir}:missing`);
      continue;
    }
    for (const f of listFilesRecursive(dir, '.yaml')) {
      try {
        const st = fs.statSync(f);
        parts.push(`${f}:${st.mtimeMs}:${st.size}`);
      } catch {
        parts.push(`${f}:gone`);
      }
    }
  }
  return parts.join('|');
}

// ---------------------------------------------------------------------------
// Status promotion types (see collectPromotableSpecs)
// ---------------------------------------------------------------------------

export type SpecKind = 'subsystem' | 'component' | 'interface' | 'implementation';

export interface PromotableSpec {
  kind: SpecKind;
  id: string;
  /** The current (pre-promotion) status — captured so callers can revert. */
  status: SpecStatus;
}

/**
 * Options for the spec save functions.
 * `allowStatusDemotion`: by default a re-save carrying status 'draft' does NOT
 * demote an existing 'design'/'complete' spec (the add tools always pass
 * 'draft', and re-adding must not silently reopen a locked spec). An explicit
 * status change via sdd_update_spec sets this to make deliberate demotion work.
 */
export interface SaveSpecOptions {
  allowStatusDemotion?: boolean;
}

/**
 * Hooks an AUTHORING caller injects into a write.
 *
 * `gate` sees the fully merged spec immediately before it is persisted, and
 * throws to refuse the write. It exists as an injected hook rather than a direct
 * call because the spec store must not depend on the rule engine — rules/
 * coupling.ts and rules/namespace.ts already read this module, so importing the
 * validator here would close an import cycle. Inversion keeps the dependency
 * pointing one way and keeps mechanical re-saves (status promotion, layout
 * normalization, migrations) ungated: they pass no hooks and behave exactly as
 * before, which matters because a spec that predates a rule must stay loadable
 * and repairable.
 *
 * Return notices to surface alongside the write's own.
 */
export interface SpecWriteHooks {
  gate?(
    kind: 'system' | 'subsystem' | 'component' | 'interface' | 'implementation' | 'type',
    merged: Record<string, any>,
  ): string[] | void;
}

// ---------------------------------------------------------------------------
// SpecWorkspace
// ---------------------------------------------------------------------------

export class SpecWorkspace {
  readonly rootDir: string;
  readonly paths: WaiPaths;

  private cachedIndex: SpecIndex | null = null;
  private cachedRecursive: boolean | number | null = null;
  private cachedSpecDirs: string[] = [];
  private cachedSignature: string | null = null;
  private lastSignatureCheckMs = 0;
  private rootSubsystems = new Set<string>();
  private scanVisitedSpecDirs: string[] = [];
  loaderIssues: ValidationIssue[] = [];

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    this.paths = aiPathsAt(this.rootDir);
  }

  invalidate(): void {
    this.cachedIndex = null;
    this.cachedRecursive = null;
    this.cachedSpecDirs = [];
    this.cachedSignature = null;
    this.lastSignatureCheckMs = 0;
    this.rootSubsystems.clear();
  }

  // -------------------------------------------------------------------------
  // Scanning
  // -------------------------------------------------------------------------

  scanAll(options?: { recursive?: boolean | number }): SpecIndex {
    const recursive = options?.recursive ?? true;
    if (this.cachedIndex && this.cachedRecursive === recursive) {
      // Cache hit — but the files may have been edited externally (hand edits,
      // another process) since we scanned. Re-verify via mtime signature at
      // most once per TTL.
      const now = Date.now();
      if (now - this.lastSignatureCheckMs <= SIGNATURE_TTL_MS) return this.cachedIndex;
      this.lastSignatureCheckMs = now;
      if (computeSpecTreeSignature(this.cachedSpecDirs) === this.cachedSignature) return this.cachedIndex;
      this.invalidate();
    }

    this.loaderIssues = [];
    this.rootSubsystems.clear();
    this.cachedRecursive = recursive;
    this.scanVisitedSpecDirs = [];
    const visited = new Set<string>([path.resolve(this.rootDir)]);

    const maxDepth = typeof recursive === 'number' ? recursive : (recursive ? Infinity : 0);
    this.cachedIndex = this.scanSpecsForProject(this.rootDir, '', visited, maxDepth, 0);
    this.cachedSpecDirs = this.scanVisitedSpecDirs;
    this.cachedSignature = computeSpecTreeSignature(this.cachedSpecDirs);
    this.lastSignatureCheckMs = Date.now();
    return this.cachedIndex;
  }

  private scanSpecsForProject(
    projectDir: string,
    namespacePrefix: string,
    visitedDirs: Set<string>,
    maxDepth: number,
    currentDepth: number,
  ): SpecIndex {
    const index = emptyIndex();
    const projectPaths = aiPathsAt(projectDir);

    const specsDir = projectPaths.specsDir();
    // Track every visited specs dir (even absent ones, so their later creation
    // is picked up) for the freshness signature.
    this.scanVisitedSpecDirs.push(specsDir);
    if (!pathExists(specsDir)) return index;

    const files = listFilesRecursive(specsDir, '.yaml');
    const systemYaml = path.normalize(projectPaths.specsSystem());

    const localSubprojects: { subsystemId: string; projectPath: string }[] = [];

    for (const file of files) {
      const normFile = path.normalize(file);
      if (normFile === systemYaml) continue;

      let detectedType = 'spec';
      try {
        const raw = readYamlFile(file);
        if (raw === null || typeof raw !== 'object') {
          this.loaderIssues.push({
            severity: 'error',
            code: 'INVALID_YAML',
            message: `Spec file "${file}" is not a valid YAML object or is empty.`,
            specId: path.basename(file, '.yaml'),
          });
          continue;
        }

        if ('parentSystem' in raw) {
          detectedType = 'subsystem';
          const parsed = SubsystemSpecSchema.parse(raw);
          if (currentDepth === 0) {
            this.rootSubsystems.add(parsed.id);
          }
          if (parsed.projectPath) {
            localSubprojects.push({
              subsystemId: parsed.id,
              projectPath: parsed.projectPath,
            });
          }
          index.subsystems.push(parsed);
          index.paths.subsystem[parsed.id] = file;
        } else if ('componentType' in raw) {
          detectedType = 'component';
          const parsed = ComponentSpecSchema.parse(raw);
          index.components.push(parsed);
          index.paths.component[parsed.id] = file;
        } else if ('component' in raw) {
          detectedType = 'interface';
          const parsed = InterfaceSpecSchema.parse(raw);
          index.interfaces.push(parsed);
          index.paths.interface[parsed.id] = file;
        } else if ('contract' in raw) {
          detectedType = 'implementation';
          const parsed = ImplementationSpecSchema.parse(raw);
          if (parsed.sourcePath) {
            const absSourcePath = path.resolve(projectDir, parsed.sourcePath);
            parsed.sourcePath = path.relative(projectDir, absSourcePath).replace(/\\/g, '/');
          }
          index.implementations.push(parsed);
          index.paths.implementation[parsed.id] = file;
        } else if ('kind' in raw) {
          if (raw.kind === 'group') {
            detectedType = 'group';
            const parsed = GroupSpecSchema.parse(raw);
            index.groups.push(parsed);
            index.paths.group[parsed.id] = file;
          } else {
            detectedType = 'type';
            const parsed = TypeSpecSchema.parse(raw);
            index.types.push(parsed);
            index.paths.type[parsed.id] = file;
          }
        }

        if (detectedType === 'spec') {
          this.loaderIssues.push({
            severity: 'error',
            code: 'UNKNOWN_SPEC_TYPE',
            message: `Spec file "${file}" does not match any recognized L1-L4 schema structure.`,
            specId: path.basename(file, '.yaml'),
          });
        }
      } catch (e: any) {
        const filename = path.basename(file, '.yaml');
        this.loaderIssues.push({
          severity: 'error',
          code: 'SCHEMA_VALIDATION_ERROR',
          message: `Failed to parse ${detectedType} spec "${file}": ${e.message || String(e)}`,
          specId: filename,
        });
      }
    }

    // 2. Namespace local subsystems (runs always to handle projectPath delegation)
    index.subsystems = index.subsystems.map(sub => {
      const qualifiedSubId = namespacePrefix ? qualifyId(sub.id, namespacePrefix, this.rootSubsystems) : sub.id;
      const componentPrefix = sub.projectPath ? qualifiedSubId : namespacePrefix;
      return {
        ...sub,
        id: qualifiedSubId,
        publicInterfaces: sub.publicInterfaces.map(p => ({
          ...p,
          component: p.component ? qualifyId(p.component, componentPrefix, this.rootSubsystems) : undefined,
          interface: p.interface ? qualifyId(p.interface, componentPrefix, this.rootSubsystems) : undefined,
        })),
        lifecycle: sub.lifecycle?.map(le => ({
          ...le,
          component: qualifyId(le.component, componentPrefix, this.rootSubsystems),
        })),
      };
    });

    const originalSubsystemPaths = index.paths.subsystem;
    index.paths.subsystem = {};
    for (const [k, v] of Object.entries(originalSubsystemPaths)) {
      const qualifiedK = namespacePrefix ? qualifyId(k, namespacePrefix, this.rootSubsystems) : k;
      index.paths.subsystem[qualifiedK] = v;
    }

    if (namespacePrefix) {
      index.components = index.components.map(comp => ({
        ...comp,
        id: qualifyId(comp.id, namespacePrefix, this.rootSubsystems),
        subsystem: qualifyId(comp.subsystem, namespacePrefix, this.rootSubsystems),
        owns: comp.owns.map(o => qualifyId(o, namespacePrefix, this.rootSubsystems)),
        dependsOn: comp.dependsOn.map(d => qualifyId(d, namespacePrefix, this.rootSubsystems)),
        dispatch: comp.dispatch?.map(b => ({
          ...b,
          component: qualifyId(b.component, namespacePrefix, this.rootSubsystems),
        })),
      }));

      index.interfaces = index.interfaces.map(intf => ({
        ...intf,
        id: qualifyId(intf.id, namespacePrefix, this.rootSubsystems),
        component: qualifyId(intf.component, namespacePrefix, this.rootSubsystems),
      }));

      index.implementations = index.implementations.map(impl => ({
        ...impl,
        id: qualifyId(impl.id, namespacePrefix, this.rootSubsystems),
        contract: qualifyId(impl.contract, namespacePrefix, this.rootSubsystems),
        methods: impl.methods.map(m => ({
          ...m,
          narrative: m.narrative.map(step => ({
            ...step,
            targetComponent: step.targetComponent ? qualifyId(step.targetComponent, namespacePrefix, this.rootSubsystems) : undefined,
          })),
        })),
      }));

      index.types = index.types.map(t => ({
        ...t,
        id: qualifyId(t.id, namespacePrefix, this.rootSubsystems),
        subsystem: t.subsystem ? qualifyId(t.subsystem, namespacePrefix, this.rootSubsystems) : undefined,
        group: t.group ? qualifyId(t.group, namespacePrefix, this.rootSubsystems) : undefined,
      }));

      index.groups = index.groups.map(g => ({
        ...g,
        id: qualifyId(g.id, namespacePrefix, this.rootSubsystems),
      }));

      const originalPaths = index.paths;
      index.paths = {
        subsystem: index.paths.subsystem,
        component: {},
        interface: {},
        implementation: {},
        type: {},
        group: {},
      };

      for (const [k, v] of Object.entries(originalPaths.component)) {
        index.paths.component[qualifyId(k, namespacePrefix, this.rootSubsystems)] = v;
      }
      for (const [k, v] of Object.entries(originalPaths.interface)) {
        index.paths.interface[qualifyId(k, namespacePrefix, this.rootSubsystems)] = v;
      }
      for (const [k, v] of Object.entries(originalPaths.implementation)) {
        index.paths.implementation[qualifyId(k, namespacePrefix, this.rootSubsystems)] = v;
      }
      for (const [k, v] of Object.entries(originalPaths.type)) {
        index.paths.type[qualifyId(k, namespacePrefix, this.rootSubsystems)] = v;
      }
      for (const [k, v] of Object.entries(originalPaths.group)) {
        index.paths.group[qualifyId(k, namespacePrefix, this.rootSubsystems)] = v;
      }
    }

    if (currentDepth < maxDepth) {
      for (const subproj of localSubprojects) {
        const childDir = path.resolve(projectDir, subproj.projectPath);

        // Containment guard (Fix B2) — THE critical read-time defense. The
        // resolution base is the immediate parent (projectDir) so nested chains
        // compose, but containment is always checked against this.rootDir, the
        // workspace's bound root (the tenant project root when hosted). No hop,
        // however deep, may escape it via an absolute or ../ projectPath. On a
        // violation, surface a loader error and SKIP the child (do not recurse).
        if (projectPathEscapesRoot(this.rootDir, subproj.projectPath, childDir)) {
          this.loaderIssues.push({
            severity: 'error',
            code: 'PROJECTPATH_ESCAPE',
            message: `Subproject path "${subproj.projectPath}" declared by subsystem "${subproj.subsystemId}" escapes the project root "${this.rootDir}" (resolves to "${childDir}"); absolute and ../-escaping projectPaths are rejected. Skipping this subproject.`,
            specId: subproj.subsystemId,
          });
          continue;
        }

        if (visitedDirs.has(childDir)) {
          this.loaderIssues.push({
            severity: 'error',
            code: 'CIRCULAR_SUBPROJECT_REFERENCE',
            message: `Circular reference detected: Subsystem "${subproj.subsystemId}" refers to subproject "${childDir}" which is already loaded.`,
            specId: subproj.subsystemId,
          });
          continue;
        }

        if (!fs.existsSync(childDir)) {
          this.loaderIssues.push({
            severity: 'error',
            code: 'SUBPROJECT_NOT_FOUND',
            message: `Subproject directory "${childDir}" declared by subsystem "${subproj.subsystemId}" does not exist.`,
            specId: subproj.subsystemId,
          });
          continue;
        }

        const childNamespace = namespacePrefix
          ? `${namespacePrefix}::${subproj.subsystemId}`
          : subproj.subsystemId;

        const newVisited = new Set(visitedDirs);
        newVisited.add(childDir);

        const childIndex = this.scanSpecsForProject(childDir, childNamespace, newVisited, maxDepth, currentDepth + 1);

        index.subsystems.push(...childIndex.subsystems);
        index.components.push(...childIndex.components);
        index.interfaces.push(...childIndex.interfaces);
        index.implementations.push(...childIndex.implementations);
        index.types.push(...childIndex.types);
        index.groups.push(...childIndex.groups);

        Object.assign(index.paths.subsystem, childIndex.paths.subsystem);
        Object.assign(index.paths.component, childIndex.paths.component);
        Object.assign(index.paths.interface, childIndex.paths.interface);
        Object.assign(index.paths.implementation, childIndex.paths.implementation);
        Object.assign(index.paths.type, childIndex.paths.type);
        Object.assign(index.paths.group, childIndex.paths.group);
      }
    }

    // Collapse a mount and its same-id child realization into one flat external
    // subsystem (child content + mount projectPath). index.paths.subsystem already
    // resolves the id to the child file (child scan Object.assign wins), so content
    // saves route to the child; saveSubsystemSpec strips projectPath there.
    index.subsystems = mergeMountRealizations(index.subsystems);

    return index;
  }

  // -------------------------------------------------------------------------
  // Namespace / subproject resolution
  // -------------------------------------------------------------------------

  resolveSubprojectForNamespace(namespace: string): string | null {
    const parts = namespace.split('::');
    let currentDir = this.rootDir;
    let resolvedAny = false;
    let currentPrefix = '';
    for (const part of parts) {
      currentPrefix = currentPrefix ? `${currentPrefix}::${part}` : part;
      const index = this.scanAll();
      const sub = index.subsystems.find((s) => s.id === currentPrefix);
      if (sub && sub.projectPath) {
        const nextDir = path.resolve(currentDir, sub.projectPath);
        // Containment guard (Fix B2): never resolve a namespace into a directory
        // that escapes the bound top root (this.rootDir). Surface a loader error
        // and SKIP the escaping hop, leaving currentDir contained, rather than
        // handing back an out-of-root directory for a save/lookup.
        if (projectPathEscapesRoot(this.rootDir, sub.projectPath, nextDir)) {
          this.loaderIssues.push({
            severity: 'error',
            code: 'PROJECTPATH_ESCAPE',
            message: `Subproject path "${sub.projectPath}" declared by subsystem "${currentPrefix}" escapes the project root "${this.rootDir}" (resolves to "${nextDir}"); absolute and ../-escaping projectPaths are rejected. Skipping this subproject.`,
            specId: currentPrefix,
          });
          continue;
        }
        currentDir = nextDir;
        resolvedAny = true;
      }
    }
    return resolvedAny ? currentDir : null;
  }

  getSubprojectPrefix(qualifiedId: string): string | null {
    const parts = qualifiedId.split('::');
    if (parts.length <= 1) return null;
    const index = this.scanAll();
    // The DEEPEST mount wins: for a nested chain a::b::x (both a and a::b are
    // mounts), the file lives in b's tree, so ids relativize against a::b.
    // Returning the first (shallowest) hit left one namespace level in the
    // written ids, which the strict id schema then refused — every depth-2+
    // spec became un-savable through the parent root.
    let deepest: string | null = null;
    let currentPrefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      currentPrefix = currentPrefix ? `${currentPrefix}::${parts[i]}` : parts[i];
      const sub = index.subsystems.find(s => s.id === currentPrefix);
      if (sub && sub.projectPath) {
        deepest = currentPrefix;
      }
    }
    return deepest;
  }

  // -------------------------------------------------------------------------
  // Path builders
  // -------------------------------------------------------------------------

  getSubsystemPath(id: string): string {
    const index = this.scanAll();
    if (index.paths.subsystem[id]) {
      return index.paths.subsystem[id];
    }
    if (id.includes('::')) {
      const parts = id.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        return workspaceFor(childProj).getSubsystemPath(parts[parts.length - 1]);
      }
    }

    // Suffix match for bare IDs matching a unique qualified subsystem
    const suffix = `::${id}`;
    const matches = Object.keys(index.paths.subsystem).filter(key => key.endsWith(suffix));
    if (matches.length === 1) {
      return index.paths.subsystem[matches[0]];
    }

    if (pathExists(this.paths.specsSubsystemsDir()) && listFiles(this.paths.specsSubsystemsDir(), '.yaml').length > 0) {
      return path.join(this.paths.specsSubsystemsDir(), `${id}.yaml`);
    }
    return path.join(this.paths.specsDir(), id, '.index.yaml');
  }

  getComponentPath(id: string, subsystemId?: string): string {
    const index = this.scanAll();
    if (index.paths.component[id]) {
      return index.paths.component[id];
    }

    if (id.includes('::')) {
      const parts = id.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        const remainingId = parts[parts.length - 1];
        const remainingSubsystem = subsystemId ? subsystemId.split('::').pop() : undefined;
        return workspaceFor(childProj).getComponentPath(remainingId, remainingSubsystem);
      }
    }

    // Owned members nest one level deep inside their owning pattern's folder
    // (patterns never own patterns, so it is exactly one level).
    const owner = findOwner(id, index.components);
    if (owner) {
      const ownerPath = index.paths.component[owner.id];
      if (ownerPath && ownerPath.endsWith('.index.yaml')) {
        return path.join(path.dirname(ownerPath), id, '.index.yaml');
      }
    }

    if (subsystemId) {
      const subPath = this.getSubsystemPath(subsystemId);
      const subDir = path.dirname(subPath);
      if (subPath.endsWith('.index.yaml')) {
        return path.join(subDir, id, '.index.yaml');
      }
    }

    if (pathExists(this.paths.specsComponentsDir()) && listFiles(this.paths.specsComponentsDir(), '.yaml').length > 0) {
      return path.join(this.paths.specsComponentsDir(), `${id}.yaml`);
    }

    const targetSubsystem = subsystemId || 'default';
    return path.join(this.paths.specsDir(), targetSubsystem, id, '.index.yaml');
  }

  getInterfacePath(id: string, componentId?: string): string {
    const index = this.scanAll();
    if (index.paths.interface[id]) {
      return index.paths.interface[id];
    }

    if (id.includes('::')) {
      const parts = id.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        const remainingId = parts[parts.length - 1];
        const remainingComponent = componentId ? componentId.split('::').pop() : undefined;
        return workspaceFor(childProj).getInterfacePath(remainingId, remainingComponent);
      }
    }

    if (componentId && componentId.includes('::')) {
      const parts = componentId.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        const remainingComponent = parts[parts.length - 1];
        return workspaceFor(childProj).getInterfacePath(id, remainingComponent);
      }
    }

    if (componentId) {
      const compPath = this.getComponentPath(componentId);
      const compDir = path.dirname(compPath);
      if (compPath.endsWith('.index.yaml')) {
        return path.join(compDir, '.interface.yaml');
      }
    }

    if (pathExists(this.paths.specsInterfacesDir()) && listFiles(this.paths.specsInterfacesDir(), '.yaml').length > 0) {
      return path.join(this.paths.specsInterfacesDir(), `${id}.yaml`);
    }

    const targetComponent = componentId || 'default';
    return path.join(this.paths.specsDir(), 'default', targetComponent, '.interface.yaml');
  }

  getImplementationPath(id: string, contractId?: string): string {
    const index = this.scanAll();
    if (index.paths.implementation[id]) {
      return index.paths.implementation[id];
    }

    if (id.includes('::')) {
      const parts = id.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        const remainingId = parts[parts.length - 1];
        const remainingContract = contractId ? contractId.split('::').pop() : undefined;
        return workspaceFor(childProj).getImplementationPath(remainingId, remainingContract);
      }
    }

    if (contractId && contractId.includes('::')) {
      const parts = contractId.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        const remainingContract = parts[parts.length - 1];
        return workspaceFor(childProj).getImplementationPath(id, remainingContract);
      }
    }

    if (contractId) {
      const intfPath = this.getInterfacePath(contractId);
      const intfDir = path.dirname(intfPath);
      if (intfPath.endsWith('.interface.yaml')) {
        return path.join(intfDir, '.implementation.yaml');
      }
    }

    if (pathExists(this.paths.specsImplementationsDir()) && listFiles(this.paths.specsImplementationsDir(), '.yaml').length > 0) {
      return path.join(this.paths.specsImplementationsDir(), `${id}.yaml`);
    }

    const targetContract = contractId ? contractId.replace(/^i/, '') : 'default';
    return path.join(this.paths.specsDir(), 'default', targetContract, '.implementation.yaml');
  }

  getTypePath(id: string, subsystemId?: string, group?: string): string {
    const index = this.scanAll();
    if (index.paths.type[id]) return index.paths.type[id];

    if (id.includes('::')) {
      const parts = id.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        const remainingId = parts[parts.length - 1];
        const remainingSubsystem = subsystemId ? subsystemId.split('::').pop() : undefined;
        const remainingGroup = group ? group.split('::').pop() : undefined;
        return workspaceFor(childProj).getTypePath(remainingId, remainingSubsystem, remainingGroup);
      }
    }

    if (subsystemId && subsystemId.includes('::')) {
      const parts = subsystemId.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        const remainingSubsystem = parts[parts.length - 1];
        const remainingGroup = group ? group.split('::').pop() : undefined;
        return workspaceFor(childProj).getTypePath(id, remainingSubsystem, remainingGroup);
      }
    }

    const { localId: plainId } = splitNamespace(id);
    const targetGroup = group || index.types.find((t) => t.id === id || t.id === plainId)?.group;
    if (targetGroup) {
      const { localId: plainGroup } = splitNamespace(targetGroup);
      const groupPath = index.paths.group[targetGroup] || index.paths.group[plainGroup];
      if (groupPath) {
        const localId = id.split('::').pop()!;
        return path.join(path.dirname(groupPath), `${localId}.yaml`);
      }
    }

    let localId = id;
    if (id.includes('::')) {
      const parts = id.split('::');
      localId = parts[parts.length - 1];
      if (!subsystemId) {
        subsystemId = parts.slice(0, -1).join('::');
      }
    }

    if (subsystemId) {
      const subPath = this.getSubsystemPath(subsystemId);
      const subDir = path.dirname(subPath);
      if (subPath.endsWith('.index.yaml')) {
        return path.join(subDir, 'types', `${localId}.yaml`);
      }
    }
    return path.join(this.paths.specsTypesDir(), `${localId}.yaml`);
  }

  getGroupPath(id: string, subsystemId?: string): string {
    const index = this.scanAll();
    const { localId: plainId } = splitNamespace(id);
    if (index.paths.group[id]) return index.paths.group[id];
    if (index.paths.group[plainId]) return index.paths.group[plainId];

    if (id.includes('::')) {
      const parts = id.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        const remainingId = parts[parts.length - 1];
        const remainingSubsystem = subsystemId ? subsystemId.split('::').pop() : undefined;
        return workspaceFor(childProj).getGroupPath(remainingId, remainingSubsystem);
      }
    }

    if (subsystemId && subsystemId.includes('::')) {
      const parts = subsystemId.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        const remainingSubsystem = parts[parts.length - 1];
        return workspaceFor(childProj).getGroupPath(id, remainingSubsystem);
      }
    }

    let localId = id;
    if (id.includes('::')) {
      const parts = id.split('::');
      localId = parts[parts.length - 1];
      if (!subsystemId) {
        subsystemId = parts.slice(0, -1).join('::');
      }
    }

    if (subsystemId) {
      const subPath = this.getSubsystemPath(subsystemId);
      const subDir = path.dirname(subPath);
      if (subPath.endsWith('.index.yaml')) {
        return path.join(subDir, 'types', localId, '.index.yaml');
      }
    }
    return path.join(this.paths.specsTypesDir(), localId, '.index.yaml');
  }

  // -------------------------------------------------------------------------
  // Level 0: System
  // -------------------------------------------------------------------------

  loadSystemSpec(): SystemSpec | null {
    const p = this.paths.specsSystem();
    if (!pathExists(p)) return null;
    try {
      const raw = readYamlFile(p);
      return SystemSpecSchema.parse(raw);
    } catch (e: any) {
      this.loaderIssues.push({
        severity: 'error',
        code: 'SCHEMA_VALIDATION_ERROR',
        message: `Failed to parse system spec: ${e.message || String(e)}`,
        specId: 'system',
      });
      return null;
    }
  }

  saveSystemSpec(spec: SystemSpec): void {
    const p = this.paths.specsSystem();
    ensureDir(path.dirname(p));
    writeYamlFile(p, parseOrThrow(SystemSpecSchema, spec, 'system', spec.name));
    invalidateSpecCache();
  }

  // -------------------------------------------------------------------------
  // Level 1: Subsystems
  // -------------------------------------------------------------------------

  loadSubsystemSpecs(): SubsystemSpec[] {
    return this.scanAll().subsystems;
  }

  loadSubsystemSpec(id: string): SubsystemSpec | null {
    const index = this.scanAll();
    const cached = index.subsystems.find((s) => s.id === id);
    if (cached) return cached;

    const p = this.getSubsystemPath(id);
    if (!pathExists(p)) return null;
    try {
      const raw = readYamlFile(p);
      return SubsystemSpecSchema.parse(raw);
    } catch (e: any) {
      this.loaderIssues.push({
        severity: 'error',
        code: 'SCHEMA_VALIDATION_ERROR',
        message: `Failed to parse subsystem spec "${id}": ${e.message || String(e)}`,
        specId: id,
      });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Write-pipeline preparation — the single serialization path shared by the
  // real saves and dryRunSerializeSpecs, so the round-trip check can never
  // drift from what a write would actually do.
  // ---------------------------------------------------------------------------

  /**
   * The namespace context a spec's file is written in: the deepest subproject
   * mount containing the id, else the id's own namespace. THE single prefix
   * derivation for the whole write pipeline — every prepare*ForWrite and every
   * ancillary relativization must use this, never re-derive it inline, or the
   * dry-run check and the real saves could drift apart.
   */
  writePrefixFor(qualifiedId: string): string {
    return this.getSubprojectPrefix(qualifiedId) || splitNamespace(qualifiedId).prefix;
  }

  prepareSubsystemForWrite(spec: SubsystemSpec): SubsystemSpec {
    const { prefix } = splitNamespace(spec.id);
    return stripNamespaceFromSubsystem(spec, prefix);
  }

  prepareComponentForWrite(spec: ComponentSpec): ComponentSpec {
    const prefix = this.writePrefixFor(spec.id);
    return prefix ? stripNamespaceFromComponent(spec, prefix) : spec;
  }

  prepareInterfaceForWrite(spec: InterfaceSpec): InterfaceSpec {
    const prefix = this.writePrefixFor(spec.id);
    return prefix ? stripNamespaceFromInterface(spec, prefix) : spec;
  }

  prepareImplementationForWrite(spec: ImplementationSpec): ImplementationSpec {
    const prefix = this.writePrefixFor(spec.id);
    return prefix ? stripNamespaceFromImplementation(spec, prefix) : spec;
  }

  prepareTypeForWrite(spec: TypeSpec): TypeSpec {
    const prefix = this.writePrefixFor(spec.id);
    return prefix ? stripNamespaceFromType(spec, prefix) : spec;
  }

  prepareGroupForWrite(spec: GroupSpec): GroupSpec {
    const prefix = this.writePrefixFor(spec.id);
    return prefix ? stripNamespaceFromGroup(spec, prefix) : spec;
  }

  /**
   * Re-serialize every loaded spec through the exact write pipeline the save
   * paths use — same relativization, same schema — without touching disk.
   * Returns one ROUNDTRIP_SERIALIZATION issue per spec the writer would
   * refuse, so validate reports at validate time every refusal that lock's
   * status promotion or any later save would otherwise raise mid-write.
   * `include` (when given) skips out-of-scope specs BEFORE the expensive
   * clone+parse, so scoped validation pays scoped cost.
   */
  dryRunSerializeSpecs(include?: (specId: string) => boolean): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const index = this.scanAll();
    const inScope = include ?? ((): boolean => true);

    const check = (kind: string, id: string, result: z.SafeParseReturnType<unknown, unknown>): void => {
      if (result.success) return;
      issues.push({
        severity: 'error',
        code: 'ROUNDTRIP_SERIALIZATION',
        message: `${kind} spec "${id}" cannot be re-serialized through the writer schema (any save or lock would refuse it): ${formatZodIssues(result.error)}`,
        specId: id,
      });
    };

    for (const sub of index.subsystems) {
      if (!inScope(sub.id)) continue;
      check('subsystem', sub.id, SubsystemSpecSchema.safeParse(this.prepareSubsystemForWrite(sub)));
    }
    for (const comp of index.components) {
      if (!inScope(comp.id)) continue;
      check('component', comp.id, ComponentSpecSchema.safeParse(this.prepareComponentForWrite(comp)));
    }
    for (const intf of index.interfaces) {
      if (!inScope(intf.id)) continue;
      check('interface', intf.id, InterfaceSpecSchema.safeParse(this.prepareInterfaceForWrite(intf)));
    }
    for (const impl of index.implementations) {
      if (!inScope(impl.id)) continue;
      check('implementation', impl.id, ImplementationSpecSchema.safeParse(this.prepareImplementationForWrite(impl)));
    }
    for (const t of index.types) {
      if (!inScope(t.id)) continue;
      check('type', t.id, TypeSpecSchema.safeParse(this.prepareTypeForWrite(t)));
    }
    for (const g of index.groups) {
      if (!inScope(g.id)) continue;
      check('group', g.id, GroupSpecSchema.safeParse(this.prepareGroupForWrite(g)));
    }
    return issues;
  }

  saveSubsystemSpec(spec: SubsystemSpec): void {
    const p = this.getSubsystemPath(spec.id);
    ensureDir(path.dirname(p));

    const { prefix } = splitNamespace(spec.id);
    // Fix B2 (defense in depth): never persist an escaping projectPath, so no
    // later code path can resolve+act on it. Only for a top-level (non-prefixed)
    // subsystem, whose projectPath is relative to this.rootDir; a namespaced
    // subsystem's projectPath is child-relative and is contained by the
    // load-time guards (resolveSubprojectForNamespace + the recursive loader).
    if (!prefix && spec.projectPath && spec.projectPath.trim() !== '') {
      assertContainedProjectPath(this.rootDir, spec.projectPath);
    }
    // ALWAYS strip: an external subsystem's members carry the subsystem's own
    // id prefix even when the subsystem itself is mounted at the root (empty
    // prefix) — skipping the strip there wrote qualified member ids the
    // schema refuses, blocking lock.
    let specToWrite = this.prepareSubsystemForWrite(spec);

    if (prefix) {
      const childProj = this.resolveSubprojectForNamespace(prefix);
      if (childProj) {
        const childSystem = workspaceFor(childProj).loadSystemSpec();
        if (childSystem) {
          specToWrite = {
            ...specToWrite,
            parentSystem: childSystem.name,
          };
        }
      }
    }

    // A flat external subsystem carries projectPath ONLY in its parent mount.
    // getSubsystemPath routes a bare id whose realization lives in a subproject to
    // the child file; never write projectPath there or the child becomes a mount
    // that recurses into itself (e.g. lock's promote re-saving every subsystem).
    if (!spec.id.includes('::') && specToWrite.projectPath && !isWithin(this.paths.specsDir(), p)) {
      specToWrite = { ...specToWrite, projectPath: undefined };
    }

    const existing = this.loadSubsystemSpec(spec.id);
    if (existing) {
      specToWrite.createdAt = existing.createdAt;
    }
    specToWrite.updatedAt = new Date().toISOString();
    writeYamlFile(p, parseOrThrow(SubsystemSpecSchema, specToWrite, 'subsystem', spec.id));
    invalidateSpecCache();
  }

  deleteSubsystemSpec(id: string): boolean {
    const p = this.getSubsystemPath(id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    cleanEmptyDirs(p, path.resolve(this.paths.specsDir()));
    invalidateSpecCache();
    return true;
  }

  // -------------------------------------------------------------------------
  // Level 2: Components
  // -------------------------------------------------------------------------

  loadComponentSpecs(): ComponentSpec[] {
    return this.scanAll().components;
  }

  loadComponentSpec(id: string): ComponentSpec | null {
    const index = this.scanAll();
    const spec = index.components.find((c) => c.id === id);
    if (spec) return spec;

    const p = this.getComponentPath(id);
    if (!pathExists(p)) return null;
    try {
      const raw = readYamlFile(p);
      return ComponentSpecSchema.parse(raw);
    } catch (e: any) {
      this.loaderIssues.push({
        severity: 'error',
        code: 'SCHEMA_VALIDATION_ERROR',
        message: `Failed to parse component spec "${id}": ${e.message || String(e)}`,
        specId: id,
      });
      return null;
    }
  }

  /** Returns non-fatal placement notices (see saveTypeSpec) — empty when there is nothing to clarify. */
  saveComponentSpec(spec: ComponentSpec, opts?: SaveSpecOptions): string[] {
    const notices: string[] = [];
    const p = this.getComponentPath(spec.id, spec.subsystem);
    ensureDir(path.dirname(p));

    const specToWrite = this.prepareComponentForWrite(spec);

    const existing = this.loadComponentSpec(spec.id);
    if (existing) {
      specToWrite.createdAt = existing.createdAt;
      if (!opts?.allowStatusDemotion && existing.status && (!spec.status || spec.status === 'draft')) {
        specToWrite.status = existing.status;
      }
    }
    // Doctrine guidance at the moment it helps: fire once, at creation,
    // BEFORE the usual member-first authoring order creates the owner — it
    // tells the agent the two sanctioned paths and pre-empts the forbidden
    // third one (folding the state into a consumer).
    if (!existing && spec.componentType === 'Store'
      && !findOwner(spec.id, this.scanAll().components)) {
      notices.push(
        `Store "${spec.id}" has no owning pattern yet. Recommended: create the Repository that owns it `
        + `(plus its Registry and Index) and point consumers at the facade. For genuinely simple held state, `
        + `a standalone Store is the sanctioned lightweight form — keep the state visible here (workflow-layer `
        + `consumers only) and acknowledge the UNOWNED_STORE warning with a lint.allow reason. `
        + `Never fold the state into a consuming component instead.`,
      );
    }
    // The nested layout normalizes folders after the write; the flat legacy
    // layout keeps the file where it is — say so when the subsystem changed,
    // or a re-add reads as "the parameter was ignored".
    const subsystemChanged = existing
      && existing.subsystem !== spec.subsystem
      && splitNamespace(existing.subsystem).localId !== splitNamespace(spec.subsystem).localId;
    if (subsystemChanged && !p.endsWith('.index.yaml')) {
      notices.push(
        `component "${spec.id}" already exists at ${path.relative(this.rootDir, p)} — the flat layout re-saves in place and never relocates the file. `
        + `The subsystem field is now "${spec.subsystem}" (was "${existing.subsystem}").`,
      );
    }
    specToWrite.updatedAt = new Date().toISOString();
    writeYamlFile(p, parseOrThrow(ComponentSpecSchema, specToWrite, 'component', spec.id));
    invalidateSpecCache();
    // Keep the physical layout in sync with ownership: nest owned members under
    // their pattern, and move anything an `owns` change has displaced.
    this.normalizeComponentLayout();
    return notices;
  }

  deleteComponentSpec(id: string): boolean {
    const p = this.getComponentPath(id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    cleanEmptyDirs(p, path.resolve(this.paths.specsDir()));
    invalidateSpecCache();
    return true;
  }

  /** The directory a component's folder should live in, given current ownership. */
  private desiredComponentDir(comp: ComponentSpec, index: SpecIndex): string | null {
    const currentPath = index.paths.component[comp.id];
    // Only the nested-tree layout is normalized (skip the legacy flat components/ dir).
    if (!currentPath || !currentPath.endsWith('.index.yaml')) return null;
    if (comp.id.includes('::')) return null;

    const owner = findOwner(comp.id, index.components);
    if (owner) {
      const ownerPath = index.paths.component[owner.id];
      if (ownerPath && ownerPath.endsWith('.index.yaml')) {
        // The owner (a pattern) lives flat under its subsystem; the member nests inside it.
        const ownerSubDir = path.dirname(this.getSubsystemPath(owner.subsystem));
        return path.join(ownerSubDir, owner.id, comp.id);
      }
    }
    // Patterns, standalone blocks, and shared (interface-referenced) blocks stay flat.
    const subDir = path.dirname(this.getSubsystemPath(comp.subsystem));
    return path.join(subDir, comp.id);
  }

  /**
   * Move component folders so the physical tree mirrors ownership: each owned
   * member sits inside its pattern's folder, everything else flat under its
   * subsystem. Idempotent — only misplaced folders move. Returns the ids moved.
   * The interface.yaml / implementation.yaml travel with the folder.
   */
  normalizeComponentLayout(): string[] {
    const index = this.scanAll();
    const moved: string[] = [];
    for (const comp of index.components) {
      const currentPath = index.paths.component[comp.id];
      if (!currentPath) continue;
      const desiredDir = this.desiredComponentDir(comp, index);
      if (!desiredDir) continue;
      if (moveComponentFolder(path.dirname(currentPath), desiredDir)) moved.push(comp.id);
    }
    if (moved.length) invalidateSpecCache();
    return moved;
  }

  // -------------------------------------------------------------------------
  // Level 3: Interfaces
  // -------------------------------------------------------------------------

  loadInterfaceSpecs(): InterfaceSpec[] {
    return this.scanAll().interfaces;
  }

  loadInterfaceSpec(id: string): InterfaceSpec | null {
    const index = this.scanAll();
    const spec = index.interfaces.find((i) => i.id === id);
    if (spec) return spec;

    const p = this.getInterfacePath(id);
    if (!pathExists(p)) return null;
    try {
      const raw = readYamlFile(p);
      return InterfaceSpecSchema.parse(raw);
    } catch (e: any) {
      this.loaderIssues.push({
        severity: 'error',
        code: 'SCHEMA_VALIDATION_ERROR',
        message: `Failed to parse interface spec "${id}": ${e.message || String(e)}`,
        specId: id,
      });
      return null;
    }
  }

  /** Returns non-fatal placement notices (see saveTypeSpec) — empty when there is nothing to clarify. */
  saveInterfaceSpec(spec: InterfaceSpec, opts?: SaveSpecOptions): string[] {
    const notices: string[] = [];
    const p = this.getInterfacePath(spec.id, spec.component);
    ensureDir(path.dirname(p));

    const specToWrite = this.prepareInterfaceForWrite(spec);

    const existing = this.loadInterfaceSpec(spec.id);
    if (existing && existing.component !== spec.component
      && splitNamespace(existing.component).localId !== splitNamespace(spec.component).localId) {
      notices.push(
        `interface "${spec.id}" already exists at ${path.relative(this.rootDir, p)} — re-saving updates the component binding field in place `
        + `(now "${spec.component}", was "${existing.component}") and never moves the file.`,
      );
    }
    if (existing) {
      specToWrite.createdAt = existing.createdAt;
      if (!opts?.allowStatusDemotion && existing.status && (!spec.status || spec.status === 'draft')) {
        specToWrite.status = existing.status;
      }
      // Preserve endpoint bindings for matching methods that don't carry their own
      for (const m of specToWrite.methods) {
        if (m.endpoint) continue;
        const existingMethod = existing.methods.find(x => x.name === m.name);
        if (existingMethod && existingMethod.endpoint) {
          m.endpoint = existingMethod.endpoint;
        }
      }
    }
    specToWrite.updatedAt = new Date().toISOString();
    writeYamlFile(p, parseOrThrow(InterfaceSpecSchema, specToWrite, 'interface', spec.id));
    invalidateSpecCache();
    return notices;
  }

  deleteInterfaceSpec(id: string): boolean {
    const p = this.getInterfacePath(id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    cleanEmptyDirs(p, path.resolve(this.paths.specsDir()));
    invalidateSpecCache();
    return true;
  }

  // -------------------------------------------------------------------------
  // Level 4: Implementations
  // -------------------------------------------------------------------------

  loadImplementationSpecs(): ImplementationSpec[] {
    return this.scanAll().implementations;
  }

  loadImplementationSpec(id: string): ImplementationSpec | null {
    const index = this.scanAll();
    const spec = index.implementations.find((impl) => impl.id === id);
    if (spec) return spec;

    const p = this.getImplementationPath(id);
    if (!pathExists(p)) return null;
    try {
      const raw = readYamlFile(p);
      return ImplementationSpecSchema.parse(raw);
    } catch (e: any) {
      this.loaderIssues.push({
        severity: 'error',
        code: 'SCHEMA_VALIDATION_ERROR',
        message: `Failed to parse implementation spec "${id}": ${e.message || String(e)}`,
        specId: id,
      });
      return null;
    }
  }

  /** Returns non-fatal placement notices (see saveTypeSpec) — empty when there is nothing to clarify. */
  saveImplementationSpec(spec: ImplementationSpec, opts?: SaveSpecOptions): string[] {
    const notices: string[] = [];
    const p = this.getImplementationPath(spec.id, spec.contract);
    ensureDir(path.dirname(p));

    const specToWrite = this.prepareImplementationForWrite(spec);

    const existing = this.loadImplementationSpec(spec.id);
    if (existing && existing.contract !== spec.contract
      && splitNamespace(existing.contract).localId !== splitNamespace(spec.contract).localId) {
      notices.push(
        `implementation "${spec.id}" already exists at ${path.relative(this.rootDir, p)} — re-saving updates the contract binding field in place `
        + `(now "${spec.contract}", was "${existing.contract}") and never moves the file.`,
      );
    }
    if (existing) {
      specToWrite.createdAt = existing.createdAt;
      if (!opts?.allowStatusDemotion && existing.status && (!spec.status || spec.status === 'draft')) {
        specToWrite.status = existing.status;
      }
    }
    specToWrite.updatedAt = new Date().toISOString();
    writeYamlFile(p, parseOrThrow(ImplementationSpecSchema, specToWrite, 'implementation', spec.id));
    invalidateSpecCache();
    return notices;
  }

  deleteImplementationSpec(id: string): boolean {
    const p = this.getImplementationPath(id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    cleanEmptyDirs(p, path.resolve(this.paths.specsDir()));
    invalidateSpecCache();
    return true;
  }

  // -------------------------------------------------------------------------
  // Types (entities / value objects)
  // -------------------------------------------------------------------------

  loadTypeSpecs(): TypeSpec[] {
    return this.scanAll().types;
  }

  loadTypeSpec(id: string): TypeSpec | null {
    return this.scanAll().types.find((t) => t.id === id) ?? null;
  }

  /**
   * Returns non-fatal placement notices (empty when there is nothing to
   * clarify): the flat legacy layout records subsystem ownership as a FIELD
   * while the file stays in the shared types/ directory, and a re-save never
   * relocates an existing file — both are by design, but silent they read as
   * "the subsystem parameter was ignored".
   */
  saveTypeSpec(spec: TypeSpec): string[] {
    const notices: string[] = [];
    const existing = this.loadTypeSpec(spec.id);
    const group = spec.group || (existing ? existing.group : undefined);
    const p = this.getTypePath(spec.id, spec.subsystem, group);
    ensureDir(path.dirname(p));

    const subsystemChanged = existing
      && (existing.subsystem ?? '') !== (spec.subsystem ?? '')
      && splitNamespace(existing.subsystem ?? '').localId !== splitNamespace(spec.subsystem ?? '').localId;
    if (subsystemChanged) {
      notices.push(
        `type "${spec.id}" already exists at ${path.relative(this.rootDir, p)} — re-saving updates fields in place and never relocates the file. `
        + `The subsystem field is now "${spec.subsystem ?? '(none)'}" (was "${existing.subsystem ?? '(none)'}").`,
      );
    }
    if (spec.subsystem && (!existing || subsystemChanged)
      && !this.getSubsystemPath(spec.subsystem).endsWith('.index.yaml')) {
      notices.push(
        `flat layout: type "${spec.id}" is recorded under subsystem "${spec.subsystem}" via its subsystem field, `
        + `and the file lives in the shared types/ directory — per-subsystem type folders exist only in the nested layout `
        + `(subsystem indexes as .index.yaml). The subsystem parameter took effect: ownership is the field, not the folder.`,
      );
    }

    const specToWrite = this.prepareTypeForWrite(spec);

    if (existing) {
      specToWrite.createdAt = existing.createdAt;
      if (!specToWrite.group && existing.group) {
        specToWrite.group = relativizeId(existing.group, this.writePrefixFor(spec.id));
      }
    }
    specToWrite.updatedAt = new Date().toISOString();
    writeYamlFile(p, parseOrThrow(TypeSpecSchema, specToWrite, 'type', spec.id));
    invalidateSpecCache();
    return notices;
  }

  deleteTypeSpec(id: string): boolean {
    const spec = this.loadTypeSpec(id);
    const p = this.getTypePath(id, spec?.subsystem, spec?.group);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    cleanEmptyDirs(p, path.resolve(this.paths.specsDir()));
    invalidateSpecCache();
    return true;
  }

  // -------------------------------------------------------------------------
  // Groups (folders/categories for types)
  // -------------------------------------------------------------------------

  loadGroupSpecs(): GroupSpec[] {
    return this.scanAll().groups;
  }

  loadGroupSpec(id: string): GroupSpec | null {
    return this.scanAll().groups.find((g) => g.id === id) ?? null;
  }

  saveGroupSpec(spec: GroupSpec): void {
    const p = this.getGroupPath(spec.id);
    ensureDir(path.dirname(p));

    const specToWrite = this.prepareGroupForWrite(spec);

    const existing = this.loadGroupSpec(spec.id);
    if (existing) {
      specToWrite.createdAt = existing.createdAt;
    }
    specToWrite.updatedAt = new Date().toISOString();
    writeYamlFile(p, parseOrThrow(GroupSpecSchema, specToWrite, 'group', spec.id));
    invalidateSpecCache();
  }

  deleteGroupSpec(id: string): boolean {
    const p = this.getGroupPath(id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    cleanEmptyDirs(p, path.resolve(this.paths.specsDir()));
    invalidateSpecCache();
    return true;
  }

  // -------------------------------------------------------------------------
  // Spec status promotion (draft/design → complete)
  // -------------------------------------------------------------------------

  /** Every spec whose status is not yet 'complete', with its current status captured. */
  collectPromotableSpecs(scopeSubsystem?: string): PromotableSpec[] {
    const out: PromotableSpec[] = [];
    const subsystems = this.loadSubsystemSpecs();
    const components = this.loadComponentSpecs();
    const interfaces = this.loadInterfaceSpecs();
    const implementations = this.loadImplementationSpecs();

    const isSpecInSubsystemScope = (specSubsystem: string | undefined): boolean => {
      if (!scopeSubsystem) return true;
      if (!specSubsystem) return false;
      return specSubsystem === scopeSubsystem || specSubsystem.startsWith(`${scopeSubsystem}::`);
    };

    for (const s of subsystems) {
      if (s.status !== 'complete' && (!scopeSubsystem || s.id === scopeSubsystem || s.id.startsWith(scopeSubsystem + '::'))) {
        out.push({ kind: 'subsystem', id: s.id, status: (s.status ?? 'complete') as SpecStatus });
      }
    }
    for (const c of components) {
      if (c.status !== 'complete' && isSpecInSubsystemScope(c.subsystem)) {
        out.push({ kind: 'component', id: c.id, status: (c.status ?? 'complete') as SpecStatus });
      }
    }
    for (const i of interfaces) {
      if (i.status !== 'complete') {
        const comp = components.find(c => c.id === i.component);
        if (comp && isSpecInSubsystemScope(comp.subsystem)) {
          out.push({ kind: 'interface', id: i.id, status: (i.status ?? 'complete') as SpecStatus });
        }
      }
    }
    for (const m of implementations) {
      if (m.status !== 'complete') {
        const intf = interfaces.find(i => i.id === m.contract);
        const comp = intf ? components.find(c => c.id === intf.component) : null;
        if (comp && isSpecInSubsystemScope(comp.subsystem)) {
          out.push({ kind: 'implementation', id: m.id, status: (m.status ?? 'complete') as SpecStatus });
        }
      }
    }
    return out;
  }

  /** Set a single spec's status (bumps updatedAt). Caller invalidates the cache. */
  applySpecStatus(kind: SpecKind, id: string, status: SpecStatus): void {
    switch (kind) {
      case 'subsystem':      { const s = this.loadSubsystemSpec(id);      if (s) this.saveSubsystemSpec({ ...s, status }); break; }
      case 'component':      { const s = this.loadComponentSpec(id);      if (s) this.saveComponentSpec({ ...s, status }); break; }
      case 'interface':      { const s = this.loadInterfaceSpec(id);      if (s) this.saveInterfaceSpec({ ...s, status }); break; }
      case 'implementation': { const s = this.loadImplementationSpec(id); if (s) this.saveImplementationSpec({ ...s, status }); break; }
    }
  }

  /**
   * Snapshot the raw bytes of every spec file under .wai/specs. Paired with
   * restoreSpecFiles() to give a byte-exact revert — used by `wairon lock` to
   * dry-run a promotion (write 'complete' → validate → restore) without leaving
   * any change behind if validation fails or the user cancels.
   */
  snapshotSpecFiles(): Map<string, string> {
    const index = this.scanAll();
    const snapshot = new Map<string, string>();
    const files = new Set<string>();

    const sysPath = this.paths.specsSystem();
    if (pathExists(sysPath)) {
      files.add(path.resolve(sysPath));
    }

    for (const group of Object.values(index.paths)) {
      for (const file of Object.values(group)) {
        files.add(path.resolve(file));
      }
    }

    for (const file of files) {
      if (fs.existsSync(file)) {
        snapshot.set(file, fs.readFileSync(file, 'utf8'));
      }
    }

    return snapshot;
  }

  // -------------------------------------------------------------------------
  // Legacy layout detection
  // -------------------------------------------------------------------------

  findLegacySpecFiles(): { path: string; expected: string }[] {
    const specsDir = this.paths.specsDir();
    if (!pathExists(specsDir)) return [];
    const files = listFilesRecursive(specsDir, '.yaml');
    const legacy: { path: string; expected: string }[] = [];
    for (const f of files) {
      const base = path.basename(f);
      const dir = path.dirname(f);
      if (base === 'system.yaml') {
        legacy.push({ path: f, expected: path.join(dir, '.index.yaml') });
      } else if (base === 'subsystem.yaml') {
        legacy.push({ path: f, expected: path.join(dir, '.index.yaml') });
      } else if (base === 'component.yaml') {
        legacy.push({ path: f, expected: path.join(dir, '.index.yaml') });
      } else if (base === 'group.yaml') {
        legacy.push({ path: f, expected: path.join(dir, '.index.yaml') });
      } else if (base === 'interface.yaml') {
        legacy.push({ path: f, expected: path.join(dir, '.interface.yaml') });
      } else if (base === 'implementation.yaml') {
        legacy.push({ path: f, expected: path.join(dir, '.implementation.yaml') });
      }
    }
    return legacy;
  }

  // -------------------------------------------------------------------------
  // Granular delta updates (sdd_update_spec)
  // -------------------------------------------------------------------------

  /**
   * Returns non-fatal notices about the merge (e.g. an insert whose position
   * was a jump target, so the relocated jumps now bypass the inserted step) —
   * empty when the merge had nothing to warn about.
   */
  updateSpec(
    kind: 'system' | 'subsystem' | 'component' | 'interface' | 'implementation' | 'type',
    id: string,
    delta: Record<string, any>,
    hooks?: SpecWriteHooks,
  ): string[] {
    const notices: string[] = [];
    const result = (() => {
      switch (kind) {
        case 'system':         return this.loadSystemSpec(); // singleton — id is informational
        case 'subsystem':      return this.loadSubsystemSpec(id);
        case 'component':      return this.loadComponentSpec(id);
        case 'interface':      return this.loadInterfaceSpec(id);
        case 'implementation': return this.loadImplementationSpec(id);
        case 'type':           return this.loadTypeSpec(id);
      }
    })();

    if (!result) {
      throw new Error(`Spec of kind "${kind}" with ID "${id}" does not exist. Define it first.`);
    }

    // The L0 is a singleton and its load ignores the id — reject a mismatched
    // id loudly so a mis-selected kind can't silently rewrite the system spec.
    if (kind === 'system' && id && id !== 'system' && id !== (result as SystemSpec).name) {
      throw new Error(
        `kind "system" targets the singleton L0 spec (system name "${(result as SystemSpec).name}") — pass id "system" or the system name, got "${id}". For a subsystem, use kind "subsystem".`,
      );
    }

    // Flow-step jump fields relocate with renumbering, exactly like an
    // assembler relocating addresses: inserts/deletes shift every jump field
    // in the SAME narrative that points at or beyond the mutation point.
    const JUMP_FIELDS = ['onTrueStep', 'onFalseStep', 'defaultStep', 'endStep', 'finallyStep', 'toStep'] as const;
    const JUMP_LIST_FIELDS = ['cases', 'catches', 'branches'] as const;

    // captureInsertTarget: ENTRY jumps pointing exactly at the insertion point
    // stay put, so they land on the inserted step instead of following the
    // shifted original ("execute this first" insert semantics). endStep is a
    // region TAIL (last step of a loop/try body), not an entry: capturing it
    // would shrink the region and evict its original last step, so it always
    // relocates with the body.
    const relocateJumps = (step: any, shiftFrom: number, deltaN: number, captureInsertTarget = false): any => {
      const hit = (v: number, isRegionTail = false) =>
        (deltaN > 0 ? ((captureInsertTarget && !isRegionTail) ? v > shiftFrom : v >= shiftFrom) : v > shiftFrom);
      const out = { ...step };
      for (const f of JUMP_FIELDS) {
        if (typeof out[f] === 'number' && hit(out[f], f === 'endStep')) out[f] = out[f] + deltaN;
      }
      for (const lf of JUMP_LIST_FIELDS) {
        if (Array.isArray(out[lf])) {
          out[lf] = out[lf].map((c: any) =>
            typeof c?.step === 'number' && hit(c.step) ? { ...c, step: c.step + deltaN } : c,
          );
        }
      }
      return out;
    };

    const jumpRefsTo = (step: any, target: number): string[] => {
      const refs: string[] = [];
      for (const f of JUMP_FIELDS) if (step[f] === target) refs.push(f);
      for (const lf of JUMP_LIST_FIELDS) {
        (Array.isArray(step[lf]) ? step[lf] : []).forEach((c: any, i: number) => {
          if (c?.step === target) refs.push(`${lf}[${i}].step`);
        });
      }
      return refs;
    };

    const mergeNarrative = (existingSteps: any[], deltaSteps: any[]): any[] => {
      let steps = [...existingSteps];
      const sortedDeltas = [...deltaSteps].sort((a, b) => a.stepNumber - b.stepNumber);
      for (const deltaStep of sortedDeltas) {
        const stepNum = deltaStep.stepNumber;
        if (deltaStep.action === 'delete' || deltaStep.remove === true) {
          const idx = steps.findIndex(s => s.stepNumber === stepNum);
          if (idx !== -1) {
            const referrers = steps
              .filter(s => s.stepNumber !== stepNum)
              .map(s => ({ n: s.stepNumber, refs: jumpRefsTo(s, stepNum) }))
              .filter(r => r.refs.length > 0);
            if (referrers.length) {
              throw new Error(
                `Cannot delete narrative step ${stepNum}: it is a jump target of step(s) `
                + referrers.map(r => `${r.n} (${r.refs.join(', ')})`).join(', ')
                + '. Retarget or delete the referring steps first.',
              );
            }
            steps.splice(idx, 1);
            steps = steps.map(s => relocateJumps(
              s.stepNumber > stepNum ? { ...s, stepNumber: s.stepNumber - 1 } : s,
              stepNum,
              -1,
            ));
          }
        } else if (deltaStep.action === 'insert') {
          // The inserted step's own jump fields are taken as-is: they refer
          // to the POST-insert numbering the author is creating. Existing
          // jumps AT the insertion point follow their old referent to N+1 by
          // default (assembler-style relocation) — captureJumps: true keeps
          // them on N so they hit the inserted step first.
          const capture = deltaStep.captureJumps === true;
          if (!capture) {
            const incoming = steps
              .map(s => ({ n: s.stepNumber, refs: jumpRefsTo(s, stepNum) }))
              .filter(r => r.refs.length > 0);
            if (incoming.length) {
              notices.push(
                `Inserted step ${stepNum} was a jump target: `
                + incoming.map(r => `step ${r.n} (${r.refs.join(', ')})`).join(', ')
                + ` now target the shifted original step ${stepNum + 1} and BYPASS the inserted step — it is only reached by fall-through.`
                + ` If those jumps should hit the new step first, insert with "captureJumps": true or retarget them.`,
              );
            }
          }
          steps = steps.map(s => relocateJumps(
            s.stepNumber >= stepNum ? { ...s, stepNumber: s.stepNumber + 1 } : s,
            stepNum,
            1,
            capture,
          ));
          const { action, remove, captureJumps, ...cleanStep } = deltaStep;
          steps.push(cleanStep);
        } else {
          const idx = steps.findIndex(s => s.stepNumber === stepNum);
          if (idx !== -1) {
            const { action, remove, ...cleanStep } = deltaStep;
            steps[idx] = {
              ...steps[idx],
              ...cleanStep,
            };
          } else {
            const { action, remove, ...cleanStep } = deltaStep;
            steps.push(cleanStep);
          }
        }
      }
      return steps.sort((a, b) => a.stepNumber - b.stepNumber);
    };

    /**
     * Opaque `ext` maps key-merge at EVERY level. Spec-level ext already does
     * (mergeDelta's object recursion); a METHOD-level ext delta went through
     * the shallow method spread instead, clobbering the whole map. This mirrors
     * mergeDelta's semantics for a plain data map — delta keys win, absent keys
     * survive, nested objects merge, arrays replace, null/undefined skipped —
     * without mergeDelta's named-key special cases (ext content is opaque; a
     * pack key spelled "methods" must never trigger the methods merge).
     */
    const isPlainObject = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v);
    const mergeExt = (existing: any, delta: any): any => {
      if (!isPlainObject(existing) || !isPlainObject(delta)) return delta ?? existing;
      const res: Record<string, unknown> = { ...existing };
      for (const [key, value] of Object.entries(delta)) {
        if (value === undefined || value === null) continue;
        res[key] = isPlainObject(value) && isPlainObject(res[key]) ? mergeExt(res[key], value) : value;
      }
      return res;
    };

    const mergeMethods = (existingMethods: any[], deltaMethods: any[]): any[] => {
      const merged = [...existingMethods];
      for (const deltaMethod of deltaMethods) {
        const idx = merged.findIndex(m => m.name === deltaMethod.name);
        if (idx !== -1) {
          if (deltaMethod.remove === true || deltaMethod.action === 'delete') {
            merged.splice(idx, 1);
          } else {
            const existingMethod = merged[idx];
            let narrative = existingMethod.narrative ? [...existingMethod.narrative] : [];
            if (deltaMethod.narrative && Array.isArray(deltaMethod.narrative)) {
              narrative = mergeNarrative(narrative, deltaMethod.narrative);
            }
            const { narrative: _, ...cleanMethod } = deltaMethod;
            merged[idx] = {
              ...existingMethod,
              ...cleanMethod,
              ...(deltaMethod.ext !== undefined ? { ext: mergeExt(existingMethod.ext, deltaMethod.ext) } : {}),
              narrative,
            };
          }
        } else {
          if (deltaMethod.remove !== true && deltaMethod.action !== 'delete') {
            merged.push(deltaMethod);
          }
        }
      }
      return merged;
    };

    const mergeNamedArray = (existing: any[], delta: any[]): any[] => {
      const merged = [...existing];
      for (const deltaItem of delta) {
        const idx = merged.findIndex(item => item.name === deltaItem.name);
        if (idx !== -1) {
          if (deltaItem.remove === true || deltaItem.action === 'delete') {
            merged.splice(idx, 1);
          } else {
            merged[idx] = {
              ...merged[idx],
              ...deltaItem,
              ...(deltaItem.ext !== undefined ? { ext: mergeExt(merged[idx].ext, deltaItem.ext) } : {}),
            };
          }
        } else {
          if (deltaItem.remove !== true && deltaItem.action !== 'delete') {
            merged.push(deltaItem);
          }
        }
      }
      return merged;
    };

    // Upsert-by-key for arrays whose elements have no `name`/`id`: dispatch
    // bindings key on capability, lifecycle entrypoints on phase+component+
    // method. Without this they fell to the wholesale-replace branch and a
    // one-entry delta silently erased the rest of the table.
    const mergeKeyedArray = (existing: any[], delta: any[], keyOf: (item: any) => string): any[] => {
      const merged = [...existing];
      for (const deltaItem of delta) {
        const idx = merged.findIndex(item => keyOf(item) === keyOf(deltaItem));
        if (idx !== -1) {
          if (deltaItem.remove === true || deltaItem.action === 'delete') {
            merged.splice(idx, 1);
          } else {
            merged[idx] = { ...merged[idx], ...deltaItem };
          }
        } else if (deltaItem.remove !== true && deltaItem.action !== 'delete') {
          merged.push(deltaItem);
        }
      }
      return merged.map(({ action, remove, ...item }) => item);
    };

    const mergePublicInterfaces = (existing: any[], delta: any[]): any[] => {
      const merged = [...existing];
      for (const deltaItem of delta) {
        const idx = merged.findIndex(item => item.component === deltaItem.component && item.interface === deltaItem.interface);
        if (idx !== -1) {
          if (deltaItem.remove === true || deltaItem.action === 'delete') {
            merged.splice(idx, 1);
          } else {
            merged[idx] = {
              ...merged[idx],
              ...deltaItem,
            };
          }
        } else {
          if (deltaItem.remove !== true && deltaItem.action !== 'delete') {
            merged.push(deltaItem);
          }
        }
      }
      return merged;
    };

    /**
     * The identity key for an element of a delta-mergeable array, or null when the
     * array has no per-element identity (a list of plain strings like `owns` or
     * `guarantees`, where wholesale replacement is the only sane semantic).
     *
     * This table is what makes the documented contract true. Arrays used to be
     * upserted only if they were explicitly listed below; everything else fell to
     * wholesale replacement, so a delta naming ONE element silently deleted every
     * element it did not mention — the same data loss already fixed for `dispatch`
     * and `lifecycle`, still live for trustedLinks, invariants, patterns, lint
     * allows, boundaries, and global requirements. Keyed here rather than guessed,
     * with a name/id fallback so a future array field inherits upsert semantics
     * instead of silently regressing to destructive replace.
     */
    const identityKeyOf = (field: string, item: unknown): string | null => {
      if (item === null || typeof item !== 'object') return null; // string lists: replace wholesale
      const o = item as Record<string, unknown>;
      const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
      switch (field) {
        case 'dispatch':           return str(o.capability);
        case 'lifecycle':          return `${String(o.phase)} ${String(o.component)} ${String(o.method)}`;
        case 'emits':
        case 'subscribesTo':       return `${String(o.topic)} ${o.event === undefined ? '' : String(o.event)}`;
        case 'trustedLinks':       return str(o.subsystem);
        case 'allow':              return str(o.code);       // lint.allow
        case 'invariants':         return str(o.id);
        case 'patterns':           return str(o.id);
        case 'boundaries':         return str(o.name);
        case 'globalRequirements': return str(o.description);
        case 'databases':          return str(o.id) ?? str(o.name);
        default:                   return str(o.name) ?? str(o.id);
      }
    };

    /** Upsert an array whose elements carry an identity, honouring delete markers. */
    const mergeIdentifiedArray = (field: string, existing: any[], delta: any[]): any[] => {
      const merged = [...existing];
      for (const deltaItem of delta) {
        const key = identityKeyOf(field, deltaItem);
        // An element with no resolvable identity cannot be addressed; fall back to
        // appending it rather than guessing which existing entry it replaces.
        const idx = key === null
          ? -1
          : merged.findIndex((item) => identityKeyOf(field, item) === key);
        const isDelete = deltaItem?.remove === true || deltaItem?.action === 'delete';
        if (idx !== -1) {
          if (isDelete) merged.splice(idx, 1);
          else merged[idx] = { ...merged[idx], ...deltaItem };
        } else if (!isDelete) {
          merged.push(deltaItem);
        }
      }
      return merged.map((item) =>
        (item && typeof item === 'object' ? (({ action, remove, ...rest }) => rest)(item) : item));
    };

    /** True when every element of both sides can be addressed by identity. */
    const isIdentifiedArray = (field: string, a: unknown[], b: unknown[]): boolean =>
      a.every((i) => identityKeyOf(field, i) !== null) && b.every((i) => identityKeyOf(field, i) !== null);

    const mergeDelta = (existing: any, delta2: any): any => {
      const res = { ...existing };
      for (const [key, value] of Object.entries(delta2)) {
        if (value === undefined || value === null) {
          continue;
        }
        if (key === 'methods' && Array.isArray(value) && Array.isArray(existing.methods)) {
          if (kind === 'implementation') {
            res.methods = mergeMethods(existing.methods, value);
          } else {
            res.methods = mergeNamedArray(existing.methods, value);
          }
        } else if (key === 'fields' && Array.isArray(value) && Array.isArray(existing.fields)) {
          res.fields = mergeNamedArray(existing.fields, value);
        } else if (key === 'publicInterfaces' && Array.isArray(value) && Array.isArray(existing.publicInterfaces)) {
          res.publicInterfaces = mergePublicInterfaces(existing.publicInterfaces, value);
        } else if (key === 'dispatch' && Array.isArray(value) && Array.isArray(existing.dispatch)) {
          res.dispatch = mergeKeyedArray(existing.dispatch, value, b => String(b?.capability));
        } else if (key === 'lifecycle' && Array.isArray(value) && Array.isArray(existing.lifecycle)) {
          res.lifecycle = mergeKeyedArray(existing.lifecycle, value, le => `${le?.phase} ${le?.component} ${le?.method}`);
        } else if (Array.isArray(value) && value.length > 0 && Array.isArray(existing[key])
                   && isIdentifiedArray(key, existing[key], value)) {
          // Every other array whose elements carry an identity: upsert by it and
          // honour delete markers, instead of replacing the list wholesale and
          // silently dropping whatever the delta did not mention.
          res[key] = mergeIdentifiedArray(key, existing[key], value);
        } else if (Array.isArray(value)) {
          // No per-element identity (a list of plain strings), or an explicitly
          // EMPTY array. Empty stays a wholesale clear on purpose: under upsert
          // semantics it would otherwise mean "change nothing", leaving no way to
          // empty a keyed list short of enumerating a delete per key.
          res[key] = value;
        } else if (typeof value === 'object' && typeof existing[key] === 'object' && existing[key] !== null) {
          res[key] = mergeDelta(existing[key], value);
        } else {
          res[key] = value;
        }
      }
      return res;
    };

    // Callers write DELTAS with LOCAL names (the natural form inside a
    // namespace) while the loaded spec is fully qualified. Qualify the
    // delta's id-bearing references BEFORE the merge, exactly as the loader
    // would have — never after, because post-merge a bare id is ambiguous
    // (a loaded root-level ref and a delta-local ref read identically).
    // Only fields PRESENT in the delta are touched, so nothing new is merged.
    const qualifyDeltaRefs = (d: Record<string, any>): Record<string, any> => {
      if (kind === 'system') return d;
      const prefix = this.writePrefixFor(id);
      if (!prefix) return d;
      const q = (ref: unknown): unknown =>
        typeof ref === 'string' ? qualifyId(ref, prefix, this.rootSubsystems) : ref;
      const out: Record<string, any> = { ...d };
      switch (kind) {
        case 'subsystem': {
          const isExternal = !!(out.projectPath ?? (result as SubsystemSpec).projectPath);
          const memberPrefix = isExternal ? id : prefix;
          const qm = (ref: unknown): unknown =>
            typeof ref === 'string' ? qualifyId(ref, memberPrefix, this.rootSubsystems) : ref;
          if (Array.isArray(out.publicInterfaces)) {
            out.publicInterfaces = out.publicInterfaces.map((pi: any) => ({
              ...pi,
              ...(typeof pi?.component === 'string' ? { component: qm(pi.component) } : {}),
              ...(typeof pi?.interface === 'string' ? { interface: qm(pi.interface) } : {}),
            }));
          }
          if (Array.isArray(out.lifecycle)) {
            out.lifecycle = out.lifecycle.map((le: any) =>
              (typeof le?.component === 'string' ? { ...le, component: qm(le.component) } : le));
          }
          break;
        }
        case 'component':
          if (typeof out.subsystem === 'string') out.subsystem = q(out.subsystem);
          if (Array.isArray(out.owns)) out.owns = out.owns.map(q);
          if (Array.isArray(out.dependsOn)) out.dependsOn = out.dependsOn.map(q);
          if (Array.isArray(out.dispatch)) {
            out.dispatch = out.dispatch.map((b: any) =>
              (typeof b?.component === 'string' ? { ...b, component: q(b.component) } : b));
          }
          break;
        case 'interface':
          if (typeof out.component === 'string') out.component = q(out.component);
          break;
        case 'implementation':
          if (typeof out.contract === 'string') out.contract = q(out.contract);
          if (Array.isArray(out.methods)) {
            out.methods = out.methods.map((m: any) =>
              (Array.isArray(m?.narrative)
                ? {
                  ...m,
                  narrative: m.narrative.map((s: any) =>
                    (typeof s?.targetComponent === 'string' ? { ...s, targetComponent: q(s.targetComponent) } : s)),
                }
                : m));
          }
          break;
        case 'type':
          if (typeof out.subsystem === 'string') out.subsystem = q(out.subsystem);
          if (typeof out.group === 'string') out.group = q(out.group);
          break;
      }
      return out;
    };

    // `unset` REMOVES optional fields, and is not itself a spec field.
    //
    // Without it an optional scalar could be set but never cleared: null and
    // undefined are skipped by the merge (so a caller passing them for "no change"
    // is not punished), and the only workaround — writing "" — leaves the field
    // PRESENT and empty, which is a different, usually wrong spec (a Portal with
    // basePath: "" or a component with variant: "" is not the same as one without).
    // Explicit rather than overloading null: a destructive meaning must be asked
    // for, never inferred from an absent value.
    //
    // Unsetting a REQUIRED field is not special-cased — schema validation refuses
    // the write and names the field, which is the honest failure.
    const unsetFields: string[] = Array.isArray((delta as Record<string, unknown>).unset)
      ? ((delta as Record<string, unknown>).unset as unknown[]).filter((f): f is string => typeof f === 'string')
      : [];
    const { unset: _unset, ...mergeableDelta } = delta as Record<string, unknown>;

    const mergedResult = mergeDelta(result, qualifyDeltaRefs(mergeableDelta));
    for (const field of unsetFields) delete mergedResult[field];
    mergedResult.updatedAt = new Date().toISOString();

    // Symbolic step-label references resolve AFTER the merge, so a delta can
    // reference labels anchored on pre-existing steps. Unresolved references
    // abort the whole update — a dropped reference would silently become a
    // dangling numeric jump.
    if (kind === 'implementation' && Array.isArray(mergedResult.methods)) {
      const labelErrors: string[] = [];
      for (const m of mergedResult.methods) {
        if (m && Array.isArray(m.narrative)) labelErrors.push(...resolveNarrativeLabels(String(m.name), m.narrative));
      }
      if (labelErrors.length) {
        throw new Error(`Unresolved narrative label references — nothing was saved:\n- ${labelErrors.join('\n- ')}`);
      }
    }

    // Write-boundary gate, on the MERGED result — the only point where the spec
    // the caller will actually get exists as one object, and still the last
    // point before anything touches disk. A refusal throws, so "nothing was
    // saved" stays literally true.
    const gateNotices = hooks?.gate?.(kind, mergedResult);
    if (gateNotices?.length) notices.push(...gateNotices);

    // An explicit status in the delta is a deliberate change — allow demotion
    // (e.g. reopening a completed spec to 'draft' for revision).
    const opts: SaveSpecOptions = {
      allowStatusDemotion: Object.prototype.hasOwnProperty.call(delta, 'status'),
    };

    switch (kind) {
      case 'system':         this.saveSystemSpec(mergedResult); break;
      case 'subsystem':      this.saveSubsystemSpec(mergedResult); break;
      case 'component':      notices.push(...this.saveComponentSpec(mergedResult, opts)); break;
      case 'interface':      notices.push(...this.saveInterfaceSpec(mergedResult, opts)); break;
      case 'implementation': notices.push(...this.saveImplementationSpec(mergedResult, opts)); break;
      case 'type':           notices.push(...this.saveTypeSpec(mergedResult)); break;
    }

    return notices;
  }
}

// ---------------------------------------------------------------------------
// Workspace registry + flat module API (delegates to the current root)
// ---------------------------------------------------------------------------

const workspaces = new Map<string, SpecWorkspace>();

/** The workspace for an explicit project root (created on first use). */
export function workspaceFor(rootDir: string): SpecWorkspace {
  const key = path.resolve(rootDir);
  let ws = workspaces.get(key);
  if (!ws) {
    ws = new SpecWorkspace(key);
    workspaces.set(key, ws);
  }
  return ws;
}

/** The workspace for the current project root (override, else resolved cwd). */
function current(): SpecWorkspace {
  return workspaceFor(getProjectRoot());
}

/**
 * Invalidate every workspace's cache and drop the instances. Invalidation must
 * hit the instances themselves (not just the map) because a workspace method
 * may still be mid-flight holding `this` — e.g. saveComponentSpec invalidates
 * globally and then runs normalizeComponentLayout on the same instance, which
 * must rescan rather than serve its stale index.
 */
export function invalidateSpecCache(): void {
  // Invalidate IN PLACE — never clear the registry. A caller holding a
  // workspaceFor() reference (tests, the hosted server's per-project scopes)
  // must keep receiving invalidations; evicting the instance orphaned such
  // references on a permanently-stale index whose path lookups then
  // mis-routed writes into specs/default fallbacks.
  for (const ws of workspaces.values()) ws.invalidate();
}

export function getLoaderIssues(): ValidationIssue[] {
  return current().loaderIssues;
}

export function clearLoaderIssues(): void {
  current().loaderIssues = [];
  invalidateSpecCache();
}

export function scanAllSpecs(options?: { recursive?: boolean | number }): SpecIndex {
  return current().scanAll(options);
}

export function resolveSubprojectForNamespace(namespace: string): string | null {
  return current().resolveSubprojectForNamespace(namespace);
}

export function getSubprojectPrefix(qualifiedId: string): string | null {
  return current().getSubprojectPrefix(qualifiedId);
}

export function getSubsystemPath(id: string): string {
  return current().getSubsystemPath(id);
}

export function getComponentPath(id: string, subsystemId?: string): string {
  return current().getComponentPath(id, subsystemId);
}

export function getInterfacePath(id: string, componentId?: string): string {
  return current().getInterfacePath(id, componentId);
}

export function getImplementationPath(id: string, contractId?: string): string {
  return current().getImplementationPath(id, contractId);
}

export function getTypePath(id: string, subsystemId?: string, group?: string): string {
  return current().getTypePath(id, subsystemId, group);
}

export function getGroupPath(id: string, subsystemId?: string): string {
  return current().getGroupPath(id, subsystemId);
}

export function loadSystemSpec(): SystemSpec | null {
  return current().loadSystemSpec();
}

export function saveSystemSpec(spec: SystemSpec): void {
  current().saveSystemSpec(spec);
}

export function loadSubsystemSpecs(): SubsystemSpec[] {
  return current().loadSubsystemSpecs();
}

export function loadSubsystemSpec(id: string): SubsystemSpec | null {
  return current().loadSubsystemSpec(id);
}

export function saveSubsystemSpec(spec: SubsystemSpec): void {
  current().saveSubsystemSpec(spec);
}

export function deleteSubsystemSpec(id: string): boolean {
  return current().deleteSubsystemSpec(id);
}

export function loadComponentSpecs(): ComponentSpec[] {
  return current().loadComponentSpecs();
}

export function loadComponentSpec(id: string): ComponentSpec | null {
  return current().loadComponentSpec(id);
}

export function saveComponentSpec(spec: ComponentSpec, opts?: SaveSpecOptions): string[] {
  return current().saveComponentSpec(spec, opts);
}

export function deleteComponentSpec(id: string): boolean {
  return current().deleteComponentSpec(id);
}

export function normalizeComponentLayout(): string[] {
  return current().normalizeComponentLayout();
}

export function loadInterfaceSpecs(): InterfaceSpec[] {
  return current().loadInterfaceSpecs();
}

export function loadInterfaceSpec(id: string): InterfaceSpec | null {
  return current().loadInterfaceSpec(id);
}

export function saveInterfaceSpec(spec: InterfaceSpec, opts?: SaveSpecOptions): string[] {
  return current().saveInterfaceSpec(spec, opts);
}

export function deleteInterfaceSpec(id: string): boolean {
  return current().deleteInterfaceSpec(id);
}

export function loadImplementationSpecs(): ImplementationSpec[] {
  return current().loadImplementationSpecs();
}

export function loadImplementationSpec(id: string): ImplementationSpec | null {
  return current().loadImplementationSpec(id);
}

export function saveImplementationSpec(spec: ImplementationSpec, opts?: SaveSpecOptions): string[] {
  return current().saveImplementationSpec(spec, opts);
}

export function deleteImplementationSpec(id: string): boolean {
  return current().deleteImplementationSpec(id);
}

export function loadTypeSpecs(): TypeSpec[] {
  return current().loadTypeSpecs();
}

export function loadTypeSpec(id: string): TypeSpec | null {
  return current().loadTypeSpec(id);
}

export function saveTypeSpec(spec: TypeSpec): string[] {
  return current().saveTypeSpec(spec);
}

export function dryRunSerializeSpecs(include?: (specId: string) => boolean): ValidationIssue[] {
  return current().dryRunSerializeSpecs(include);
}

/** Project the current project's spec tree into a level-filtered WebGraphModel,
 *  forwarded to the diagram specialist's pure graph projection (core_orchestrator
 *  → diagram_specialist). */
export function buildProjectGraph(level: number): WebGraphModel {
  return buildGraphModel(level);
}

/**
 * Report whether the CURRENTLY BOUND project root is a chained subproject of a
 * parent project (parent root + mounting subsystem id), or null for a genuine
 * top root (icore_orchestrator/icore_portal.resolveChainingParent). Read-only
 * detection through the spec loader's chaining walk — never rebinds, never
 * mutates.
 */
export function resolveChainingParent(): ChainingParentRef | null {
  return findChainingParent(getProjectRoot());
}

/**
 * Compute the CURRENT spec-tree state hash of the project at the given root
 * (icore_orchestrator/icore_portal.computeStateIdAt). The root is bound
 * strictly READ-ONLY for the duration of the computation via the async-scoped
 * project-root binding, which restores the previous binding unconditionally —
 * also on failure paths. Serves freshness comparisons of vendored surface
 * snapshots against what the (parent) tree looks like NOW; returns null when
 * the root holds no loadable spec tree.
 */
/**
 * Compute the GATE state identity of the current project
 * (icore_orchestrator/icore_portal.computeGateStateId): load the governing
 * extension packs, then digest the spec tree together with that doctrine.
 *
 * This is the identity `wairon lock` records and promotion re-checks, so a
 * doctrine change invalidates a lock by state mismatch exactly as a spec edit
 * does — nobody has to remember to invalidate it. Loading the doctrine here (not
 * inside the hash specialist) keeps that specialist pure and makes every caller
 * use the same doctrine source, so a lock and its promote-time re-check can never
 * disagree about which rule set applied.
 */
export function computeGateStateId(): StateId {
  // The gate is the packs AND the project's own governing configuration: which
  // profile applies, and how it tuned the rules. A lock taken under one and
  // promoted under another was never validated by the gate it claims to have
  // passed. Config is read here and passed in, so the hash itself stays pure.
  let gate: GateConfig = {};
  try {
    const config = loadProjectConfig();
    gate = { projectType: config.projectType, rules: config.rules };
  } catch { /* uninitialized project: the tree hash still stands on its own */ }
  return hashGateState(loadProjectExtensions(), gate);
}

/** Whether a lock is in force, void, or absent. */
export type LockState = 'unlocked' | 'locked' | 'stale';

export interface LockStatus {
  state: LockState;
  /** The persisted record, or null when the project was never locked. */
  record: LockRecord | null;
  /** The gate identity as it stands NOW — what `state` was decided against. */
  current: StateId;
}

/**
 * Resolve the project's lock into one of three honest states, comparing the
 * recorded gate identity against the current one.
 *
 * The ONE authority for the question "is this project locked?". Before this,
 * `promote` compared StateIds while the project config view answered from the mere
 * EXISTENCE of a record — so a project whose specs changed after locking still
 * reported itself locked, and the freeze it claimed did not exist. Two answers to
 * one question is how a time-of-check gap gets reintroduced after being closed, so
 * every caller now shares this.
 */
export function readLockState(): LockStatus {
  const record = readLockRecord();
  const current = computeGateStateId();
  if (!record) return { state: 'unlocked', record: null, current };
  return { state: stateIdEquals(record.stateId, current) ? 'locked' : 'stale', record, current };
}

export function computeStateIdAt(root: string): string | null {
  const resolved = path.resolve(root);
  return runWithProjectRoot(resolved, () => {
    // Fresh read of THAT root's tree: never serve a stale cache as "current".
    workspaceFor(resolved).invalidate();
    const system = loadSystemSpec();
    if (!system) return null;
    const s = computeStateId();
    return `${s.algorithm}:${s.digest}`;
  });
}

export function deleteTypeSpec(id: string): boolean {
  return current().deleteTypeSpec(id);
}

export function loadGroupSpecs(): GroupSpec[] {
  return current().loadGroupSpecs();
}

export function loadGroupSpec(id: string): GroupSpec | null {
  return current().loadGroupSpec(id);
}

export function saveGroupSpec(spec: GroupSpec): void {
  current().saveGroupSpec(spec);
}

export function deleteGroupSpec(id: string): boolean {
  return current().deleteGroupSpec(id);
}

export function collectPromotableSpecs(scopeSubsystem?: string): PromotableSpec[] {
  return current().collectPromotableSpecs(scopeSubsystem);
}

export function applySpecStatus(kind: SpecKind, id: string, status: SpecStatus): void {
  current().applySpecStatus(kind, id, status);
}

export function snapshotSpecFiles(): Map<string, string> {
  return current().snapshotSpecFiles();
}

/** Restore files captured by snapshotSpecFiles(). Caller invalidates the cache. */
export function restoreSpecFiles(snapshot: Map<string, string>): void {
  for (const [file, content] of snapshot) {
    fs.writeFileSync(file, content);
  }
}

export function findLegacySpecFiles(): { path: string; expected: string }[] {
  return current().findLegacySpecFiles();
}

export function updateSpec(
  kind: 'system' | 'subsystem' | 'component' | 'interface' | 'implementation' | 'type',
  id: string,
  delta: Record<string, any>,
  hooks?: SpecWriteHooks,
): string[] {
  return current().updateSpec(kind, id, delta, hooks);
}
