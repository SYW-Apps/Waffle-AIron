import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { aiPathsAt, WaiPaths } from '../config/paths.js';
import { projectConfigRepository } from '../config/project-config.js';
import {
  declaredExternals,
  declaredMembers,
  effectiveProjectId,
  type MemberKind,
  type MemberStorage,
  type PartOf,
  type ProjectConfig,
  type PackSelection,
  type ProjectProfileSelection,
  type ExternalDeclaration,
  type ExternalSource,
  type NetworkDeclaration,
} from '../models/project.js';
import { ensureDir, listFiles, pathExists, getProjectRoot, runWithProjectRoot, getRequestParentReach, currentRootBinding, getHostedLookup, getWriteReach, writeReachPermits, type WriteReach } from '../utils/fs.js';
import { computeStateId, stateIdEquals, type StateId } from './statehash.js';
import { canonicalize } from '../utils/canonical-json.js';
import { readLockRecord, writeLockRecord as persistLockRecord, type LockRecord } from './lockfile.js';
import { readYamlFile } from '../utils/yaml.js';
import { listSpecFiles, readSpecFile, removeSpecFile, writeSpecFile } from './spec-files.js';
// git_source_adapter: a git part is read from the content-addressed fetch cache at its pinned commit (stage 8).
import * as gitSource from './adapters/git-source.js';
import * as crypto from 'crypto';
import { WaironError } from '../utils/errors.js';
// TYPE-ONLY, and it has to be: the report NAMES the tests a write invalidated,
// while the search that finds them belongs to the validator. A runtime import
// here would be the store reaching into the rule engine that already reads it
// — the cycle `authoring` exists to keep open.
import type { TestsToRevisit } from './source-analysis.js';
import { rekeyAnchor, type CarriedRekey, type IdentityRename } from '../models/identity-rename.js';
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
  parseTypeExpression,
  canonicalTypeText,
  type TypeExpression,
  SpecStatus,
  SurfaceSnapshot,
  SurfaceSnapshotSchema,
  splitNamespace,
  type LintAllow,
  // One `calls` entry read apart into the component it names and the method on
  // it, so the reference table below can rewrite either half.
  parseDeclaredCall,
  MethodSignature,
  MethodImplementation,
  // The ONE per-type step-field table (models/step-config.ts). The writer
  // rebuilds a retyped step against it; the narrative-step-config rule judges
  // a stored step against the same table, so neither can drift from the other.
  STEP_TYPE_FIELDS,
  STEP_LABEL_TWINS,
  stepFieldsFor,
  // The bare-name reading of stage 4's imports: one nameKey, the local type
  // match, and the type identifiers a spec names.
  isTypeVocabulary,
  nameKey,
  typeMatchesRef,
  methodTypeRefs,
  methodGenericParameters,
  interfaceGenericParameters,
  typeGenericParameters,
  fieldTypeRefs,
  signatureTypeRefs,
  storedMethodSignature,
  storedTypeMethod,
  deriveMethodSignature,
  // The neutral type grammar: the scan, the writer and the delta update read
  // every spec's type positions through the same two type methods.
  interfaceCanonicalTypes,
  typeCanonicalTypes,
  emptyTypeSpellingFacts,
  type TypeRespelling,
  type TypeSpellingFacts,
  type StoredInterfaceSpec,
  type StoredTypeSpec,
  type ProjectRelations,
  type RetiredReachFact,
  attachRetiredMounts,
  carryRetiredReachForms,
  readRetiredReachForms,
  retiredInvocationReadAs,
  retiredMountsOf,
} from '../models/index.js';
import type { ValidationIssue } from './validation.js';
import { resolveNarrativeLabels } from './narrative-labels.js';
import { buildGraphModel, renderDiagram as renderArchitectureDiagram, type DiagramFormat } from './diagram.js';
// The export index is an owned face of this Repository: the facade forwards
// its two reads 1:1 (spec_loader resolveSubsystemExports / resolveProjectExports).
import { resolveProjectExportTable, resolveSubsystemExportTable, exportUsageOf, pinnedUsageOf } from './exports.js';
// The pure export resolver the scan resolves every project's tables through,
// before it binds any `alias::name` against them.
import { followProducerRenames, resolveProjectTable, resolveSubsystemTables } from './exports.js';
import type { ExportUsage, ExportUse, ResolvedExport, ResolvedExportTable } from '../models/exports.js';
import {
  approvalKeyIn,
  keyIn,
  landReference,
  type AuthoredReference,
  type ProjectFamily,
  type ProjectFamilyProblem,
  type ReadableProject,
  type ReferenceBinding,
  type ReferenceEdit,
} from '../models/project-family.js';
import { projectConfigRepositoryAt } from '../config/project-config.js';
// The project family index is an owned face of this Repository: the facade
// forwards its graph 1:1 (spec_loader graph).
import { projectFamilyGraph } from './project-family.js';
import type { ExternalConsumer, ImportSection, MountForm } from '../models/project-family.js';
import type { WebGraphModel } from '../server/types.js';
// The pure signature resolver the scan runs last, once every reference of the
// family is bound: sourced methods filled, every params-bearing method's text derived.
import { resolveTree, type SignatureFacts } from './signature-sources.js';
import { dict, ownGet } from '../utils/own.js';

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

/** spec_index — the bound tree as one scan read it: every spec by kind, and the file each is stored in. */
export interface SpecIndex {
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
  /** What the scan's signature resolution recorded: each signatureFrom it met and how it resolved, and each stored text its params contradict. */
  signatures: SignatureFacts;
  /**
   * What the scan's type canonicalisation recorded: each stored type position
   * that is an alias of its canonical spelling, and each that is not canonical
   * at all. The loaded interfaces and types hold canonical text, so this is the
   * only place the stored spellings are still visible.
   */
  typeSpellings: TypeSpellingFacts;
  /**
   * What the scan met in the forms the reachability model retired (each
   * Portal's portalType and listener mounts, each invokedBy of a retired kind,
   * each authored export type, each in-process Custom endpoint), with what the
   * stored spec held there. The loaded specs hold the compatible reading, so
   * this is the only place the stored form is still visible to the migration.
   */
  retiredReach: RetiredReachFact[];
}

// spec_index.retiredBy is pure and lives with the trace schemas
// (models/specs.ts), so every subsystem holding an index asks it alike.
export { specIndexRetiredBy } from '../models/specs.js';

/**
 * spec_scan_options — how deep a scan reads into chained subprojects:
 * `memberDepth` absent reads every level, 0 the bound project alone, n that
 * many levels.
 */
export interface SpecScanOptions {
  memberDepth?: number;
}

/** legacy_spec_file — a spec file stored under a legacy (undotted) name, and the name the current layout expects. */
export interface LegacySpecFile {
  path: string;
  expected: string;
}

/**
 * scanned_project_root — what one scan read at one project root, beyond the
 * specs it put in the index: its key and where it sits among its family's
 * members, its own L0 (never merged into the index), its configuration, its
 * alias table, its resolved export tables, the keys of the specs it declared,
 * and every reference with `::` its authors wrote, as bound. The raw material
 * of the project graph and the export tables, and what the writer relativizes
 * a save against.
 */
export interface ScannedProjectRoot {
  /** '' for the bound root, else its effective project id (or its alias path when the id is taken or missing). */
  namespace: string;
  /** The key of the root that declares this one as a member. */
  parent?: string;
  /** The alias its parent declares it under. */
  mountAlias?: string;
  /** How the parent declares it; absent for the bound root. */
  mountForm?: MountForm;
  /** The legacy L1 mount subsystem as the parent wrote it; null for a members-declared root and the bound root. */
  legacyMount: SubsystemSpec | null;
  /** What its parent's declaration says the member is (the `members` description, or a legacy mount's). */
  memberDescription?: string;
  /** The root directory, absolute. */
  directory: string;
  /** The root's own L0, its export entries keyed into its key; null when it has none. */
  system: SystemSpec | null;
  /** The root's configuration, read through that root's binding; null when unreadable. */
  config: ProjectConfig | null;
  /** alias → the key of the project it names in this scan (members and family externals). */
  aliases: Map<string, string>;
  /** The root's L0 export table, resolved once in the scan. */
  exports: ResolvedExportTable;
  /** Each of the root's subsystems' L1 export tables, by subsystem key. */
  subsystemExports: Map<string, ResolvedExportTable>;
  /** The keys of every spec this root's files declared. */
  specIds: string[];
  /** Every reference with `::` this root's files wrote, as bound. */
  authoredReferences: AuthoredReference[];
  /** The family problems the scan met at this root: its identity, its members, its duplicate keys. */
  problems: ProjectFamilyProblem[];
  /** The parts this root declares (stage 8), in declaration order: its own subsystems stored elsewhere. */
  parts: ScannedPart[];
  /**
   * The referenced project members this root declares (stage 8): a `../` or
   * git source whose content is a project's, located where it is stored — the
   * sibling checkout, or the fetch cache at its pinned commit — and never read
   * into this root. A hosted member is located by the hosting server instead.
   */
  referenced: ScannedPart[];
}

/** Whether, and from where, a part's files could be read. */
export type PartAvailability = 'live' | 'cache' | 'unavailable';

/**
 * scanned_part — one part of a project as the scan read it (stage 8): where
 * its files came from and which of the declaring project's specs they hold. A
 * part is not a project root — no key, no alias table, no L0, no export table
 * — so it is recorded on the root that declares it, and every spec it holds is
 * keyed under that root exactly as if the files lay in the root's own specs
 * folder (part-is-the-parents-subsystem).
 */
export interface ScannedPart {
  /** The `members` key the declaring project gives it. */
  alias: string;
  /** contained | path | git: where its files live (a part is never a hosted record). */
  storage: MemberStorage;
  /** The directory its specs were read from, absolute; absent when it could not be read. */
  directory?: string;
  /** git: the pinned commit; contained or path: the head of the work tree holding it, when in one. Provenance only. */
  commit?: string;
  /** What a non-contained part's own configuration says it belongs to; null for a contained part and for one that declares none. */
  partOf: PartOf | null;
  /** The keys of the subsystems its files declare. */
  subsystems: string[];
  /** The keys of every spec its files declare, under the declaring root's key. */
  specIds: string[];
  /** sha256:… over its spec documents in canonical form, keyed by their path inside the part (storage-independent). */
  contentDigest?: string;
  availability: PartAvailability;
  /** Why it is unavailable. */
  reason?: string;
}

/**
 * Thrown when a write would land in a part fetched from git (stage 8): its
 * files are the fetch cache's, read-only — it is edited in its own repository
 * and taken in by `wairon member update`.
 */
export class PartReadOnly extends WaironError {
  constructor(message: string) {
    super(message);
    this.name = 'PartReadOnly';
  }
}

/** The kinds of spec document the store writes. */
type SpecDocumentKind = 'system' | 'subsystem' | 'component' | 'interface' | 'implementation' | 'type' | 'group';

/**
 * Thrown inside a hosted request when a write would change a spec of a
 * subsystem the request may not change (a hosted subsystem rule), or a spec of
 * no subsystem when the request may not write the project — before anything is
 * written, naming every subsystem the write would have touched and the rung
 * that decided each.
 */
export class SubsystemWriteDenied extends WaironError {
  constructor(message: string) {
    super(message);
    this.name = 'SubsystemWriteDenied';
  }
}

/** One owner a spec write lands in: a project root and the subsystem owning the spec (null: none). */
export interface SpecWriteOwner {
  root: string;
  /** The project's id, for the refusal's wording. */
  project: string;
  subsystemId: string | null;
}

/** The owners the write reach refuses, in words; empty when every owner is permitted. */
function deniedOwners(reach: WriteReach, owners: SpecWriteOwner[]): string[] {
  const seen = new Set<string>();
  const denied: string[] = [];
  for (const o of owners) {
    const key = `${path.resolve(o.root)}|${o.subsystemId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (writeReachPermits(reach, o.root, o.subsystemId)) continue;
    const rule = o.subsystemId === null ? undefined
      : reach.subsystems.find((s) => s.subsystemId === o.subsystemId && path.resolve(s.root) === path.resolve(o.root));
    denied.push(o.subsystemId === null
      ? `project "${o.project}" itself (a spec of no subsystem, decided at the project rung)`
      : `subsystem "${o.subsystemId}" of project "${o.project}" (decided by ${rule?.decidedBy ?? 'the project rung'})`);
  }
  return denied;
}

/** Refuse, writing nothing, when the current hosted request may not change every owner named. Outside a hosted request nothing is judged. */
export function assertSpecWritesPermitted(owners: SpecWriteOwner[], what: string): void {
  const reach = getWriteReach();
  if (!reach) return;
  const denied = deniedOwners(reach, owners);
  if (denied.length === 0) return;
  throw new SubsystemWriteDenied(
    `SubsystemWriteDenied: ${what} would change ${denied.length === 1 ? 'a spec' : 'specs'} this request may not change — `
    + `${denied.join('; ')}. Nothing was written.`,
  );
}

/**
 * Top-level keys older writers stamped on every spec file and the schema no
 * longer reads: harmless, and no author meant anything by them.
 */
const TOLERATED_KEYS: ReadonlySet<string> = new Set(['schemaVersion']);

/** What an unknown key most likely meant, by `<kind>.<key>`: said beside the finding. */
const UNKNOWN_KEY_HINTS: Readonly<Record<string, string>> = {
  'system.exports': 'The L0 export table is `publicInterfaces` (sdd_set_public_interfaces writes it).',
  'system.export': 'The L0 export table is `publicInterfaces` (sdd_set_public_interfaces writes it).',
  'subsystem.exports': 'A subsystem publishes through `publicInterfaces`.',
  'component.type': 'A component\'s stereotype is `componentType`.',
  'implementation.symbol': 'A symbol names the code realizing ONE contract method: set it on that method (`methods[].symbol`).',
};

/**
 * The keys of `raw` that `parsed` (its schema's reading) no longer carries,
 * appended to `out` as `path: value`. Follows an object the schema kept, and
 * an array element by element when the schema kept every element.
 */
function unknownKeysIn(raw: unknown, parsed: unknown, at: string, out: string[]): void {
  if (Array.isArray(raw)) {
    if (!Array.isArray(parsed) || parsed.length !== raw.length) return;
    raw.forEach((item, i) => unknownKeysIn(item, parsed[i], `${at}[${i}]`, out));
    return;
  }
  if (!raw || typeof raw !== 'object' || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const keyPath = at ? `${at}.${key}` : key;
    if (!(key in (parsed as Record<string, unknown>))) {
      out.push(`${keyPath}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
      continue;
    }
    unknownKeysIn(value, (parsed as Record<string, unknown>)[key], keyPath, out);
  }
}

function emptyIndex(): SpecIndex {
  return {
    subsystems: [],
    components: [],
    interfaces: [],
    implementations: [],
    types: [],
    groups: [],
    // No prototype: an id that is also a prototype name (constructor) is a key like any other.
    paths: {
      subsystem: dict<string>(),
      component: dict<string>(),
      interface: dict<string>(),
      implementation: dict<string>(),
      type: dict<string>(),
      group: dict<string>(),
    },
    signatures: { sources: [], staleTexts: [] },
    typeSpellings: emptyTypeSpellingFacts(),
    retiredReach: [],
  };
}

/** A stored spec document as written, or null when there is none or it does not read as an object. */
function storedDocument(file: string): Record<string, unknown> | null {
  if (!pathExists(file)) return null;
  try {
    const doc = readSpecFile(file);
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A stored interface document with every method's invokedBy of one retired kind left out (a copy; the document is not touched). */
function withoutRetiredKind(doc: Record<string, unknown> | null, kind: string): Record<string, unknown> | null {
  if (!doc || !Array.isArray(doc.methods)) return doc;
  const methods = doc.methods.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const invokedBy = (m as Record<string, unknown>).invokedBy as Record<string, unknown> | undefined;
    if (invokedBy?.kind !== kind) return m;
    const { invokedBy: _retired, ...rest } = m as Record<string, unknown>;
    return rest;
  });
  return { ...doc, methods };
}

/**
 * The retired reachability forms only the whole family can read, once every
 * spec is keyed and every reference bound: a method's stored `external`
 * invokedBy is an entry when its contract belongs to a Portal (the per-file
 * read made it a runtime hook), and a Portal whose retired portalType was
 * Custom and that binds no endpoint on any verb is recorded as in-process,
 * the reading the migration rewrites it to. In place, on the index.
 */
function readRetiredReachAcrossSpecs(index: SpecIndex): void {
  const componentsById = new Map(index.components.map((c) => [c.id, c]));
  for (const fact of index.retiredReach) {
    if (fact.form !== 'invoked-by-kind' || fact.stored !== 'external' || fact.at === undefined) continue;
    const intf = index.interfaces.find((i) => i.id === fact.specId);
    if (!intf || componentsById.get(intf.component)?.componentType !== 'Portal') continue;
    const method = intf.methods.find((m) => m.name === fact.at);
    if (method?.invokedBy) method.invokedBy = { ...method.invokedBy, kind: retiredInvocationReadAs('external', true) };
  }
  for (const fact of [...index.retiredReach]) {
    if (fact.form !== 'portal-type' || fact.stored !== 'Custom') continue;
    const portal = componentsById.get(fact.specId);
    if (!portal || portal.componentType !== 'Portal') continue;
    const binds = index.interfaces.some((i) => i.component === portal.id && i.methods.some((m) => m.endpoint !== undefined));
    if (!binds) index.retiredReach.push({ form: 'in-process-endpoint', specId: portal.id, stored: { transport: 'Custom', endpoints: [] } });
  }
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

const NO_ROOT_SUBSYSTEMS: ReadonlySet<string> = new Set();

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

/**
 * Re-express a reference stored by a spec that moves ONE mount hop — from a
 * namespace N into the mount `mount` beneath it (`into`), or from `N::mount` back
 * out to N (`outOf`) — so it names the same target from where the spec now
 * loads. The target never changes, only the namespace the reference is written
 * relative to. The primitive behind externalize/internalize.
 *
 * - A root-anchored `::x` names the same target at every depth: kept as written.
 * - Every other form is resolved where it was written (qualifyId) and written
 *   again relative to where it is now read (relativizeId). A target that travels
 *   with the spec moves first: going `into` the mount, the ids `isMoved` accepts
 *   (named relative to N); going `outOf` it, everything inside the mount, whose
 *   namespace the move dissolves into N.
 * - Only the hop between the two namespaces decides the result, never where N
 *   sits — the property that makes relativizeId's super:: chains root-invariant.
 *   So N is a stand-in: deep enough that the reference's own super:: hops stay
 *   inside it, spelled with segments no spec id can contain so no common ancestor
 *   is found by accident, and without the root-subsystem anchor, which belongs
 *   to whichever root happens to be loading.
 */
export function rebaseReference(
  ref: string,
  mount: string,
  direction: 'into' | 'outOf',
  isMoved: (id: string) => boolean = () => false,
): string {
  if (!ref || ref.startsWith('::')) return ref;
  const segments = ref.split('::');
  let hops = 0;
  while (segments[hops] === 'super') hops++;
  if (hops === segments.length) return ref; // hops alone name nothing

  const outer = Array.from({ length: hops + 1 }, (_, i) => `<n${i}>`).join('::');
  const inner = `${outer}::${mount}`;
  const [from, to] = direction === 'into' ? [outer, inner] : [inner, outer];
  const target = qualifyId(ref, from, NO_ROOT_SUBSYSTEMS);
  // The target as named from the namespace the spec leaves — a super:: form
  // exactly when it lies outside that namespace, and then it stays put.
  const left = relativizeId(target, from);
  const travels = !left.startsWith('super::') && (direction === 'outOf' || isMoved(left));
  return relativizeId(travels ? qualifyId(left, to, NO_ROOT_SUBSYSTEMS) : target, to);
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
// stay strictly within its OWNING project root — the project that declares the
// mount, not whichever root the tree happens to be loaded from, so one
// declaration is accepted or refused identically from every root — both
// lexically and as the filesystem resolves it (through links). Empty/undefined
// projectPath is not chaining and is never checked here (callers skip it).
// ---------------------------------------------------------------------------

/**
 * A path as the filesystem resolves it: its nearest existing ancestor followed
 * through links, with the part that does not exist yet re-appended. Null when an
 * entry exists but cannot be resolved (a dangling link), which containment
 * treats as escaping.
 */
function canonicalPath(target: string): string | null {
  let existing = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(existing);
      break;
    } catch {
      const up = path.dirname(existing);
      if (up === existing) return path.resolve(target);
      rest.unshift(path.basename(existing));
      existing = up;
    }
  }
  try {
    return path.join(fs.realpathSync.native(existing), ...rest);
  } catch {
    return null;
  }
}

/** A chained directory's identity for cycle detection: reached through a link, it is still the same directory. */
function chainDirKey(dir: string): string {
  return canonicalPath(dir) ?? path.resolve(dir);
}

/**
 * Whether a subproject's already-resolved child directory escapes `projectRoot`,
 * the root of the project that DECLARES the mount; `resolvedChildDir` is
 * resolved by the caller against that same project. An absolute `projectPath`, a
 * `../`-escape, or a path that leaves the root through a link fails. Each hop is
 * contained by its own declaring project, which is itself contained, so no chain
 * however deep leaves the bound root.
 */
function projectPathEscapesRoot(
  projectRoot: string,
  projectPath: string,
  resolvedChildDir: string,
): boolean {
  if (path.isAbsolute(projectPath) || !isWithin(projectRoot, resolvedChildDir)) return true;
  const root = canonicalPath(projectRoot);
  const child = canonicalPath(resolvedChildDir);
  return root === null || child === null || !isWithin(root, child);
}

/**
 * Assert a subsystem `projectPath` resolves strictly within `projectRoot`, and
 * return the resolved absolute child directory. Throws a clear Error naming the
 * offending path when `projectPath` is absolute, `../`-escapes the root, or
 * leaves it through a link. Applied on every write/setter path that persists a
 * projectPath; the load-time loader uses projectPathEscapesRoot directly (it
 * collects issues, not throws).
 */
export function assertContainedProjectPath(projectRoot: string, projectPath: string): string {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, projectPath);
  if (projectPathEscapesRoot(root, projectPath, resolved)) {
    throw new Error(
      `projectPath "${projectPath}" must resolve within the project root "${root}", but resolves ` +
        `to "${resolved}"; absolute, ../-escaping and link-escaping paths are rejected so a chained ` +
        `subproject is always contained by its parent.`,
    );
  }
  return resolved;
}

/**
 * The detected membership context of a project root: which parent project
 * declares this tree as a member. Produced by a filesystem walk-up (never
 * configured), so it reflects where the tree ACTUALLY sits.
 */
export interface ChainingParentRef {
  /** Absolute root directory of the parent project that declares this project's root as a member. */
  parentRoot: string;
  /** The alias the parent declares this project under: its `members` key, or the legacy mount subsystem's id. */
  alias: string;
  /** Which form the parent declares it in. */
  form: MountForm;
}

/** One member a project declares, in either form, as read before its directory is looked at. */
interface MemberDeclarationRead {
  alias: string;
  /** The location as written, relative to the declaring root (a git source's URL for git). */
  path: string;
  form: MountForm;
  /** contained | path | git | hosted (stage 8); a legacy mount is contained. */
  storage: MemberStorage;
  /** The source parsed (members form). */
  source?: ExternalSource;
  /** The `as` the declaration asserts. */
  as?: string;
  /** The declaration's `use`. */
  use: string[];
  /** Whether the entry used the deprecated long-form `path` key. */
  deprecatedPath?: boolean;
  /** Decided from the member's content by the scan (stage 8). */
  kind?: MemberKind;
  description?: string;
  /** The legacy L1 mount subsystem as written, for the mount form (and a mount a `members` entry shadows). */
  legacyMount?: SubsystemSpec;
  /** The spec file the legacy mount is stored in. */
  legacyFile?: string;
  /** Why the declaration is not followed. */
  problem?: string;
}

/** A project's configuration read through that root's binding; null when it has none or it fails its schema. */
function configAt(dir: string): ProjectConfig | null {
  try {
    return projectConfigRepositoryAt(dir).load();
  } catch {
    return null;
  }
}

/** A root's .wai/project.yaml exactly as YAML produced it, or null when there is none or it cannot be read. */
function rawConfigAt(dir: string): Record<string, unknown> | null {
  try {
    const document = readYamlFile(aiPathsAt(dir).projectConfig());
    return document && typeof document === 'object' && !Array.isArray(document) ? document as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Whether a member's root holds PROJECT content (stage 8): its configuration
 * declares an id, its specs hold an L0, or it carries a lock. Anything else is
 * a part. What a member is follows from this, never from a declaration.
 */
function projectContentAt(dir: string): boolean {
  const paths = aiPathsAt(dir);
  if (pathExists(paths.specsSystem())) return true;
  if (pathExists(path.join(paths.root(), 'lock.json'))) return true;
  return rawConfigAt(dir)?.id !== undefined;
}

/**
 * Whether a root's own externals lock pins a member as a referenced PROJECT
 * (stage 8): what an uncached member's kind falls back to offline.
 */
function pinnedAsMember(dir: string, alias: string): boolean {
  try {
    const lock = readYamlFile(path.join(aiPathsAt(dir).root(), 'externals.lock.yaml')) as { externals?: Record<string, { role?: string }> } | null;
    return ownGet(lock?.externals, alias)?.role === 'member';
  } catch {
    return false;
  }
}

/**
 * The commit of a `../` sibling's work tree, only when it is another git
 * repository than the declaring root's (stage 8): a contained or
 * same-repository member records none and runs no git process.
 */
function headAcross(rootDir: string, dir: string): string | undefined {
  const theirs = gitSource.repositoryRoot(dir);
  if (theirs === null) return undefined;
  const ours = gitSource.repositoryRoot(rootDir);
  const key = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (ours !== null && key(ours) === key(theirs)) return undefined;
  return gitSource.head(dir) ?? undefined;
}

/**
 * Whether a member's project is followed and composed live by the scan: one
 * contained in the declaring root, or a `../` sibling checkout beside it — a
 * folder of the same family on disk, read where it is, never through a pin.
 * A git member (the fetch cache at its pinned commit) and a hosted one stay
 * referenced. A hosted instance never reads a `../` source: there its root is
 * unavailable before this is asked.
 */
function followsLive(decl: { storage: MemberStorage }): boolean {
  return decl.storage === 'contained' || decl.storage === 'path';
}

/** The fields a part's configuration must not declare: they are a project's (stage 8). */
const PART_FORBIDDEN_FIELDS = ['members', 'externals', 'rules', 'extensions', 'composition', 'targets', 'network'];

/** Where a part's configuration is edited: the file on disk, or — for a git part — in which repository. */
function whereToEdit(decl: { storage: MemberStorage; source?: ExternalSource }, dir: string): string {
  if (decl.storage === 'git') {
    const inside = decl.source?.dir ? `${decl.source.dir.replace(/\\/g, '/')}/.wai/project.yaml` : '.wai/project.yaml';
    return `in ${inside} of the repository ${decl.source?.git} (commit there, then move this project's pin with \`wairon member update\`)`;
  }
  return `in ${path.join(dir, '.wai', 'project.yaml')}`;
}

/**
 * The finding for a non-contained part whose configuration names no parent:
 * exactly which line to add, and in which file or repository.
 */
function missingPartOfDetail(decl: { alias: string; storage: MemberStorage; source?: ExternalSource }, dir: string, parentId: string | undefined): string {
  const project = parentId ?? '<this project\'s id>';
  return `the part "${decl.alias}" is stored outside this project and does not say what it is a part of — add the line \`partOf: { project: ${project} }\` ${whereToEdit(decl, dir)}, so it can say what it belongs to when it is opened alone`;
}

/**
 * A part's content digest: sha256 over its spec documents in canonical form,
 * keyed by their path inside the part — so it does not move when the part's
 * storage does (storage-is-orthogonal).
 */
function contentDigestOf(dir: string, files: string[]): string {
  const documents: Record<string, unknown> = {};
  for (const file of files) {
    let document: unknown = null;
    try {
      document = readSpecFile(file);
    } catch {
      document = null;
    }
    documents[path.relative(dir, file).split(path.sep).join('/')] = document;
  }
  return `sha256:${crypto.createHash('sha256').update(canonicalize(documents)).digest('hex')}`;
}

/** Every legacy L1 mount a root's spec files declare (a subsystem carrying projectPath), with its file. */
function legacyMountsAt(dir: string): { spec: SubsystemSpec; file: string }[] {
  const specsDir = aiPathsAt(dir).specsDir();
  if (!pathExists(specsDir)) return [];
  const out: { spec: SubsystemSpec; file: string }[] = [];
  for (const file of listSpecFiles(specsDir)) {
    let raw: unknown;
    try {
      raw = readSpecFile(file);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object' || !('parentSystem' in raw)) continue;
    const projectPath = (raw as { projectPath?: unknown }).projectPath;
    if (typeof projectPath !== 'string' || projectPath.trim() === '') continue;
    const parsed = SubsystemSpecSchema.safeParse(raw);
    if (parsed.success) out.push({ spec: parsed.data, file });
  }
  return out;
}

/**
 * The members a root declares: its `members` entries first, in declaration
 * order, then each legacy L1 mount whose alias `members` does not hold. A
 * `members` entry and a mount under one alias are one member, the entry
 * winning (the mount is kept on it, to be reported as ignored); an alias also
 * declared under `externals` is not followed.
 */
function memberDeclarationsOf(config: ProjectConfig | null, mounts: { spec: SubsystemSpec; file: string }[]): MemberDeclarationRead[] {
  const out: MemberDeclarationRead[] = [];
  const byAlias = new Map<string, { spec: SubsystemSpec; file: string }>(mounts.map((m) => [m.spec.id, m]));
  for (const member of config ? declaredMembers(config) : []) {
    const shadowed = byAlias.get(member.alias);
    out.push({
      alias: member.alias,
      path: member.path ?? member.source.path ?? member.source.git ?? member.source.hosted ?? '',
      form: 'members',
      storage: member.storage,
      source: member.source,
      ...(member.as !== undefined ? { as: member.as } : {}),
      use: member.use,
      deprecatedPath: member.deprecatedPath,
      ...(member.description !== undefined ? { description: member.description } : {}),
      ...(shadowed ? { legacyMount: shadowed.spec, legacyFile: shadowed.file } : {}),
      ...(member.problem ? { problem: member.problem } : {}),
    });
    byAlias.delete(member.alias);
  }
  for (const mount of mounts) {
    if (!byAlias.has(mount.spec.id)) continue;
    const conflict = ownGet(config?.externals, mount.spec.id) !== undefined
      ? `the alias "${mount.spec.id}" is also declared under \`externals\` — one alias names one project`
      : undefined;
    out.push({
      alias: mount.spec.id,
      path: mount.spec.projectPath!,
      form: 'mount',
      storage: 'contained',
      use: [],
      kind: 'project',
      ...(mount.spec.description ? { description: mount.spec.description } : {}),
      legacyMount: mount.spec,
      legacyFile: mount.file,
      ...(conflict ? { problem: conflict } : {}),
    });
  }
  return out;
}

/** The members a root declares, read from its configuration and its spec files. */
function memberDeclarationsAt(dir: string): MemberDeclarationRead[] {
  return memberDeclarationsOf(configAt(dir), legacyMountsAt(dir));
}

/**
 * Walk UP from a project root to find a PARENT wairon project that declares it
 * as a member — a `members` entry of its configuration or, for one release, a
 * legacy L1 subsystem whose `projectPath` resolves to this exact root. Returns
 * the parent root with the alias and form, or null when this is a top-level
 * root.
 *
 * Only a member the ancestor itself would follow counts: its path stays within
 * that ancestor's own root. `ceiling`, when given, bounds the walk — no
 * directory above it is probed. Request-scoped callers go through
 * resolveChainingParent, which supplies both the ceiling and the reach gate.
 */
export function findChainingParent(childRoot: string, ceiling?: string): ChainingParentRef | null {
  let childResolved: string;
  try {
    childResolved = path.resolve(childRoot);
  } catch {
    return null;
  }
  const bound = ceiling ? path.resolve(ceiling) : undefined;
  let dir = path.dirname(childResolved);
  for (let hops = 0; hops < 32; hops++) {
    if (bound && !isWithin(bound, dir)) break;
    if (pathExists(aiPathsAt(dir).specsDir()) || pathExists(aiPathsAt(dir).projectConfig())) {
      for (const member of memberDeclarationsAt(dir)) {
        if (member.problem || member.storage !== 'contained' || member.path.trim() === '') continue;
        try {
          const memberDir = path.resolve(dir, member.path);
          if (chainDirKey(memberDir) === chainDirKey(childResolved) && !projectPathEscapesRoot(dir, member.path, memberDir)) {
            return { parentRoot: dir, alias: member.alias, form: member.form };
          }
        } catch {
          /* a malformed path is not our member */
        }
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Why a whole-tree walk cannot follow a member. */
export type ChainedRootSkipReason = 'escapes' | 'missing' | 'cyclic' | 'too-deep';

/**
 * Every member beneath a project root (ispec_index.inspectChainedRoots): the
 * roots a whole-tree walk follows, and the members it cannot.
 */
export interface ChainedRootsInspection {
  /** Project-relative POSIX roots in walk order, parents before their own members. */
  roots: string[];
  /** Members that cannot be followed: the member's key, its alias and form, its path as declared, and why. */
  skipped: { mount: string; alias: string; form: 'members' | 'mount'; projectPath: string; reason: ChainedRootSkipReason }[];
}

/**
 * Walk DOWN from a project root over every member beneath it, exactly as the
 * scan recurses: each path resolved against the project that declares it and
 * contained by that project's root, whether declared under `members` or as a
 * legacy L1 mount. A member that escapes its project, points at a missing
 * directory, forms a cycle, or nests past the walk bound is reported in
 * `skipped` rather than silently dropped. A directory two members reach is
 * listed once.
 */
export function inspectChainedRoots(rootDir: string = getProjectRoot()): ChainedRootsInspection {
  const root = path.resolve(rootDir);
  const inspection: ChainedRootsInspection = { roots: [], skipped: [] };
  const listed = new Set<string>();

  const walk = (projectDir: string, prefix: string, ancestors: ReadonlySet<string>, depth: number): void => {
    for (const member of memberDeclarationsAt(projectDir)) {
      const key = prefix ? `${prefix}::${member.alias}` : member.alias;
      // A referenced member (a `../`, git or hosted source) is no chained root (stage 8).
      if (member.storage !== 'contained') continue;
      let childDir: string;
      try {
        childDir = path.resolve(projectDir, member.path);
      } catch {
        continue; // malformed path — not a resolvable member
      }
      if (member.problem && !path.isAbsolute(member.path)) continue;
      let reason: ChainedRootSkipReason | undefined;
      if (projectPathEscapesRoot(projectDir, member.path, childDir)) reason = 'escapes';
      else if (ancestors.has(chainDirKey(childDir))) reason = 'cyclic';
      else if (!fs.existsSync(childDir)) reason = 'missing';
      else if (depth >= 32) reason = 'too-deep'; // the bound on chain depth
      if (reason) {
        inspection.skipped.push({ mount: key, alias: member.alias, form: member.form, projectPath: member.path, reason });
        continue;
      }
      // A part is its declaring project's own subsystems, not a root of its own (stage 8).
      if (member.form === 'members' && !projectContentAt(childDir)) continue;
      const dirKey = chainDirKey(childDir);
      if (listed.has(dirKey)) continue;
      listed.add(dirKey);
      inspection.roots.push(path.relative(root, childDir).split(path.sep).join('/'));
      walk(childDir, key, new Set([...ancestors, dirKey]), depth + 1);
    }
  };

  walk(root, '', new Set([chainDirKey(root)]), 0);
  return inspection;
}

// ---------------------------------------------------------------------------
// References: the positions a spec names other specs in.
//
// ONE table of positions drives the scan's binding and the writer's inverse,
// so the two can never disagree about where a reference lives. The loader
// rewrites the positions below into in-memory keys; the raw positions
// (trustedLinks, declared calls, auth sources, type names) stay as written
// and are only recorded.
// ---------------------------------------------------------------------------

/** The spec kinds whose references the scan binds. */
type ReferenceKind = 'subsystem' | 'component' | 'interface' | 'implementation' | 'type' | 'group';

/** Rewrites one reference at one position. */
type ReferenceMapper = (position: string, value: string) => string;

/**
 * A signatureFrom read as a method source: the head before its last dot (the
 * component) and the tail after it (the method); null when the value has no
 * dot to split at, which only a type reference can be. Whether the head
 * really names a component is the reader's question — the scan binds it as
 * one when it does, and keeps the value as a type reference when it does not.
 */
export function signatureSourceParts(value: string): { head: string; tail: string } | null {
  const dot = value.lastIndexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  return { head: value.slice(0, dot), tail: value.slice(dot + 1) };
}

/** A signatureFrom with its head passed through `map` at position `signatureFrom`; a value with no head is untouched. */
function mapSignatureSource(value: string, map: ReferenceMapper): string {
  const parts = signatureSourceParts(value);
  if (!parts) return value;
  const head = map('signatureFrom', parts.head);
  return head === parts.head ? value : `${head}.${parts.tail}`;
}

/**
 * A path to a type-expression slot of a stored spec: dotted field names, each
 * list field walked element by element (`methods.params.type` is the type of
 * every parameter of every method).
 */
export type TypeExpressionPath =
  | 'methods.params.type' | 'methods.returns' | 'methods.signature' | 'methods.signatureFrom'
  | 'fields.type' | 'params.type' | 'returns';

/**
 * The type-expression positions — ONE list of where a spec writes a type
 * string. Every reader and writer of a type position walks it (the scan's raw
 * and bare references, the respelling writer, the canonical re-save, a boundary
 * move's crossings), so a position added here is read and respelled
 * everywhere at once, and one left out is missed everywhere at once — which the
 * reference-position test enumerates against the schemas. An interface
 * method's `signatureFrom` is a type position only when it names no
 * `component.method` source; its readers decide that per value.
 */
export const TYPE_EXPRESSION_PATHS: Readonly<Record<'interface' | 'type', readonly TypeExpressionPath[]>> = {
  interface: ['methods.params.type', 'methods.returns', 'methods.signature', 'methods.signatureFrom'],
  type: ['fields.type', 'params.type', 'returns', 'methods.params.type', 'methods.returns', 'methods.signature'],
};

/** One type-expression slot of a document: the object holding it, its key, its path, and the method it belongs to. */
export interface TypeExpressionSlot {
  holder: Record<string, any>;
  key: string;
  path: TypeExpressionPath;
  method?: Record<string, any>;
}

/** Every string slot of `doc` at a type-expression path of its kind (TYPE_EXPRESSION_PATHS), in table order. */
export function typeExpressionSlots(kind: string, doc: unknown): TypeExpressionSlot[] {
  const out: TypeExpressionSlot[] = [];
  const paths = kind === 'interface' || kind === 'type' ? TYPE_EXPRESSION_PATHS[kind] : [];
  const walk = (node: unknown, segments: string[], at: TypeExpressionPath, method: Record<string, any> | undefined): void => {
    if (!node || typeof node !== 'object') return;
    const holder = node as Record<string, any>;
    const [head, ...rest] = segments;
    if (rest.length === 0) {
      if (typeof holder[head] === 'string') out.push({ holder, key: head, path: at, ...(method ? { method } : {}) });
      return;
    }
    const next = holder[head];
    const items = Array.isArray(next) ? next : next && typeof next === 'object' ? [next] : [];
    for (const item of items) walk(item, rest, at, head === 'methods' ? item : method);
  };
  for (const at of paths) walk(doc, at.split('.'), at, undefined);
  return out;
}

/**
 * A spec with every bound reference passed through `map` (the spec's own id untouched).
 *
 * The write path calls this BEFORE the schema fills its defaults, so a list the
 * schema defaults to [] may be absent here — a delta's new element that left
 * it out, or an `unset` that removed it. Absent reads as empty, as the schema
 * will read it; it is never a reason to throw.
 */
function mapSpecReferences<T>(kind: ReferenceKind, spec: T, map: ReferenceMapper): T {
  switch (kind) {
    case 'subsystem': {
      const s = spec as unknown as SubsystemSpec;
      return {
        ...s,
        publicInterfaces: (s.publicInterfaces ?? []).map((p) => ({
          ...p,
          ...(p.component !== undefined ? { component: map('publicInterfaces', p.component) } : {}),
          ...(p.interface !== undefined ? { interface: map('publicInterfaces', p.interface) } : {}),
          ...(p.typeDef !== undefined ? { typeDef: map('publicInterfaces', p.typeDef) } : {}),
          ...(p.from !== undefined ? { from: map('publicInterfaces', p.from) } : {}),
          ...(p.consumers ? { consumers: p.consumers.map((c) => map('publicInterfaces', c)) } : {}),
        })),
        ...(s.lifecycle ? { lifecycle: s.lifecycle.map((le) => ({ ...le, component: map('lifecycle', le.component) })) } : {}),
      } as unknown as T;
    }
    case 'component': {
      const c = spec as unknown as ComponentSpec;
      return {
        ...c,
        subsystem: map('subsystem', c.subsystem),
        owns: (c.owns ?? []).map((o) => map('owns', o)),
        dependsOn: (c.dependsOn ?? []).map((d) => map('dependsOn', d)),
        ...(c.dispatch ? { dispatch: c.dispatch.map((b) => ({ ...b, component: map('dispatch', b.component) })) } : {}),
        // Retired listener mounts stay read (untyped) until the reachability
        // migration rewrites them, so their portal references bind as before.
        ...(retiredMountsOf(c).declared ? { mounts: retiredMountsOf(c).mounts.map((m) => ({ ...m, portal: map('mounts', m.portal) })) } : {}),
      } as unknown as T;
    }
    case 'interface': {
      const i = spec as unknown as InterfaceSpec;
      return {
        ...i,
        component: map('contract', i.component),
        // A method source's head is a component reference; a value with no
        // head is a raw type position the mapper is never asked about.
        ...(i.methods?.some((m) => m.signatureFrom !== undefined) ? {
          methods: i.methods.map((m) => (m.signatureFrom !== undefined
            ? { ...m, signatureFrom: mapSignatureSource(m.signatureFrom, map) }
            : m)),
        } : {}),
      } as unknown as T;
    }
    case 'implementation': {
      const impl = spec as unknown as ImplementationSpec;
      return {
        ...impl,
        contract: map('contract', impl.contract),
        methods: (impl.methods ?? []).map((m) => ({
          ...m,
          narrative: (m.narrative ?? []).map((step) => (step.targetComponent !== undefined
            ? { ...step, targetComponent: map('narrative', step.targetComponent) }
            : step)),
        })),
      } as unknown as T;
    }
    case 'type': {
      const t = spec as unknown as TypeSpec;
      return {
        ...t,
        ...(t.subsystem !== undefined ? { subsystem: map('subsystem', t.subsystem) } : {}),
        ...(t.group !== undefined ? { group: map('group', t.group) } : {}),
      } as unknown as T;
    }
    case 'group':
      return spec;
  }
}

/** A type string's identifiers that carry `::` (a leading `::` and `super::` included). */
function qualifiedTypeNames(typeStr: string | undefined): string[] {
  const out: string[] = [];
  for (const m of (typeStr ?? '').matchAll(/(?:^|[^A-Za-z0-9_:-])((?:::)?[A-Za-z0-9_][A-Za-z0-9_-]*(?:::[A-Za-z0-9_][A-Za-z0-9_-]*)+)/g)) {
    if (m[1].includes('::')) out.push(m[1]);
  }
  return out;
}

/** The type reference of an asserted invariant (`<type-ref>.<invariant-id>`, split at its last dot); undefined when it has none. */
function invariantTypeRef(ref: string): string | undefined {
  const at = ref.lastIndexOf('.');
  return at > 0 && at < ref.length - 1 ? ref.slice(0, at) : undefined;
}

/** An asserted invariant with its type reference passed through `map`, its invariant id kept. */
function mapInvariantRef(ref: string, map: ReferenceMapper): string {
  const typeRef = invariantTypeRef(ref);
  if (typeRef === undefined || !typeRef.includes('::')) return ref;
  const next = map('type', typeRef);
  return next === typeRef ? ref : `${next}${ref.slice(typeRef.length)}`;
}

/** The references a spec names in positions the loader leaves raw — recorded only when they carry `::`. */
function rawReferences(kind: ReferenceKind, spec: unknown): { position: string; value: string }[] {
  const out: { position: string; value: string }[] = [];
  const add = (position: string, value: string | undefined): void => {
    if (value && value.includes('::')) out.push({ position, value });
  };
  switch (kind) {
    case 'subsystem':
      for (const link of (spec as SubsystemSpec).trustedLinks ?? []) add('trustedLinks', link.subsystem);
      break;
    case 'interface':
    case 'type':
      typeSlotReferences(kind, spec).forEach((t) => add('type', t));
      // The extension point a contract realizes: another project's export.
      if (kind === 'interface') add('implements', (spec as InterfaceSpec).implements);
      break;
    case 'implementation':
      for (const m of (spec as ImplementationSpec).methods) {
        for (const entry of m.calls ?? []) add('calls', parseDeclaredCall(entry)?.compId);
        for (const step of m.narrative) {
          const source = (step as { auth?: { from?: string } }).auth?.from;
          if (typeof source === 'string' && source.startsWith(COMPONENT_AUTH_SOURCE)) add('auth', source.slice(COMPONENT_AUTH_SOURCE.length));
          // An asserted invariant's type reference is a type position the loader leaves raw.
          for (const ref of step.assertsInvariants ?? []) add('type', invariantTypeRef(ref));
        }
      }
      break;
    default:
      break;
  }
  return out;
}

/**
 * The qualified names (`::` forms) every type-expression slot of an interface
 * or a type writes, in table order. A display signature is read for the names
 * its structured params and returns do not already carry — a type method's
 * prose signature is its only statement of its parameter types — and a
 * signatureFrom only when it names no `component.method` source.
 */
function typeSlotReferences(kind: string, spec: unknown): string[] {
  const out: string[] = [];
  const structured = new Set<string>();
  const slots = typeExpressionSlots(kind, spec);
  for (const slot of slots) {
    const value = slot.holder[slot.key] as string;
    if (slot.path === 'methods.signature') continue;
    if (slot.path === 'methods.signatureFrom') {
      if (!signatureSourceParts(value)) out.push(value);
      continue;
    }
    for (const name of qualifiedTypeNames(value)) {
      out.push(name);
      structured.add(name);
    }
  }
  for (const slot of slots.filter((s) => s.path === 'methods.signature')) {
    for (const name of qualifiedTypeNames(slot.holder[slot.key] as string)) {
      if (structured.has(name)) continue;
      structured.add(name);
      out.push(name);
    }
  }
  return out;
}

/** The positions whose bare names may be bound through a `use` import (stage 4): collaborators. */
const IMPORTABLE_POSITIONS = new Set(['dependsOn', 'dispatch', 'mounts', 'narrative']);

/**
 * The bare names (no `::`) a spec writes in positions the loader leaves raw
 * and an import may supply: every type identifier of an interface method or a
 * type field, builtins and generic parameters excepted, and every declared-call
 * target. Each name once per spec and position.
 */
function bareRawReferences(kind: ReferenceKind, spec: unknown): { position: string; value: string }[] {
  const out: { position: string; value: string }[] = [];
  const seen = new Set<string>();
  const add = (position: string, value: string | undefined, generics: ReadonlySet<string> = new Set()): void => {
    if (!value || value.includes('::') || isTypeVocabulary(value) || generics.has(value.toLowerCase())) return;
    const k = `${position}|${value}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ position, value });
  };
  const lower = (set: Set<string>): Set<string> => new Set([...set].map((g) => g.toLowerCase()));
  switch (kind) {
    case 'interface': {
      const intf = spec as InterfaceSpec;
      const own = lower(interfaceGenericParameters(intf));
      for (const m of intf.methods) {
        const generics = new Set([...own, ...lower(methodGenericParameters(m))]);
        for (const ref of methodTypeRefs(m)) add('type', ref, generics);
      }
      break;
    }
    case 'type': {
      const t = spec as TypeSpec;
      for (const f of t.fields) for (const ref of fieldTypeRefs(t, f.type)) add('type', ref);
      for (const ref of signatureTypeRefs(t)) add('type', ref);
      // A type method's params and returns — or, without params, its prose signature — as the type rules read them.
      const own = lower(typeGenericParameters(t));
      for (const m of t.methods ?? []) {
        const generics = new Set([...own, ...lower(methodGenericParameters(m))]);
        for (const ref of methodTypeRefs(m)) add('type', ref, generics);
      }
      break;
    }
    case 'implementation':
      for (const m of (spec as ImplementationSpec).methods) {
        for (const entry of m.calls ?? []) add('calls', parseDeclaredCall(entry)?.compId);
      }
      break;
    default:
      break;
  }
  return out;
}

/**
 * Each qualified name inside a type string passed through `map`, the rest of
 * the string untouched: the `::` forms, and the dotted `project.name` form a
 * self-prefixed reference is written in (stage 4 records it; stage 3's
 * re-save missed it). A name the mapper does not know comes back as it was.
 */
export function respellTypeNames(typeStr: string, map: (name: string) => string): string {
  return mapTypeNames(typeStr, (_position, name) => map(name))!;
}

/** mapTypeNames, by position: each qualified name inside a type string passed through `map`. */
function mapTypeNames(typeStr: string | undefined, map: ReferenceMapper): string | undefined {
  if (typeStr === undefined) return undefined;
  return typeStr.replace(
    /(^|[^A-Za-z0-9_:.-])((?:::)?[A-Za-z0-9_][A-Za-z0-9_-]*(?:(?:::[A-Za-z0-9_][A-Za-z0-9_-]*)+|(?:\.[A-Za-z0-9_][A-Za-z0-9_-]*)+))/g,
    (_m, lead: string, name: string) => `${lead}${map('type', name)}`,
  );
}

/**
 * A component whose `dependsOn` and `owns` name each target once, in
 * first-written order. The same object when neither list repeats a target.
 */
function withUniqueTargets(spec: ComponentSpec): ComponentSpec {
  const unique = (list: string[] | undefined): string[] | undefined => (list ? [...new Set(list)] : list);
  const dependsOn = unique(spec.dependsOn);
  const owns = unique(spec.owns);
  if (dependsOn?.length === spec.dependsOn?.length && owns?.length === spec.owns?.length) return spec;
  return { ...spec, dependsOn, owns } as ComponentSpec;
}

/**
 * Every reference position of one STORED spec document, rewritten in place
 * through `map` by position — the positions the scan records an
 * AuthoredReference at (the bound ones of mapSpecReferences and the raw ones
 * of mapRawReferences), plus an L0 export entry's `from`, `component`,
 * `interface` and `typeDef`. A type position is read token by token, the
 * display signature beside it included. A field the document does not hold is
 * skipped: this reads the file as written, before any schema default.
 */
function respellStoredReferences(kind: string, doc: Record<string, unknown>, map: ReferenceMapper): void {
  const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter((v) => v && typeof v === 'object') : []);
  const at = (holder: Record<string, unknown>, key: string, position: string): void => {
    if (typeof holder[key] === 'string') holder[key] = map(position, holder[key] as string);
  };
  const each = (holder: Record<string, unknown>, key: string, position: string): void => {
    const values = holder[key];
    if (Array.isArray(values)) holder[key] = values.map((v) => (typeof v === 'string' ? map(position, v) : v));
  };
  // An L0 entry's legacy `subsystem` is its `from`, as the loader reads it.
  const published = (entries: unknown): void => {
    for (const e of list(entries)) {
      for (const key of ['from', 'subsystem', 'component', 'interface', 'typeDef']) at(e, key, 'publicInterfaces');
      each(e, 'consumers', 'publicInterfaces');
    }
  };
  switch (kind) {
    case 'system':
      published(doc.publicInterfaces);
      break;
    case 'subsystem':
      published(doc.publicInterfaces);
      for (const le of list(doc.lifecycle)) at(le, 'component', 'lifecycle');
      for (const link of list(doc.trustedLinks)) at(link, 'subsystem', 'trustedLinks');
      break;
    case 'component':
      at(doc, 'subsystem', 'subsystem');
      each(doc, 'owns', 'owns');
      each(doc, 'dependsOn', 'dependsOn');
      for (const b of list(doc.dispatch)) at(b, 'component', 'dispatch');
      for (const m of list(doc.mounts)) at(m, 'portal', 'mounts');
      break;
    case 'interface':
      at(doc, 'component', 'contract');
      typedSlots('interface', doc, map);
      break;
    case 'implementation':
      at(doc, 'contract', 'contract');
      for (const m of list(doc.methods)) {
        for (const step of list(m.narrative)) {
          at(step, 'targetComponent', 'narrative');
          if (Array.isArray(step.assertsInvariants)) {
            step.assertsInvariants = step.assertsInvariants.map((ref: unknown) => (typeof ref === 'string' ? mapInvariantRef(ref, map) : ref));
          }
          const auth = step.auth as Record<string, unknown> | undefined;
          if (auth && typeof auth.from === 'string' && auth.from.startsWith(COMPONENT_AUTH_SOURCE)) {
            auth.from = `${COMPONENT_AUTH_SOURCE}${map('auth', auth.from.slice(COMPONENT_AUTH_SOURCE.length))}`;
          }
        }
        if (Array.isArray(m.calls)) {
          m.calls = m.calls.map((entry: unknown) => {
            const call = typeof entry === 'string' ? parseDeclaredCall(entry) : null;
            const next = call ? map('calls', call.compId) : undefined;
            return call && next !== call.compId ? `${next}.${call.methodName}` : entry;
          });
        }
      }
      break;
    case 'type':
      at(doc, 'subsystem', 'subsystem');
      at(doc, 'group', 'group');
      typedSlots('type', doc, map);
      break;
    default:
      break;
  }
}

/**
 * Every type-expression slot of a document (TYPE_EXPRESSION_PATHS) passed
 * through `map` token by token, in place. A signatureFrom that names a
 * `component.method` source has its component head mapped instead.
 */
function typedSlots(kind: 'interface' | 'type', doc: Record<string, unknown>, map: ReferenceMapper): void {
  for (const slot of typeExpressionSlots(kind, doc)) {
    const value = slot.holder[slot.key] as string;
    slot.holder[slot.key] = slot.path === 'methods.signatureFrom' && signatureSourceParts(value)
      ? mapSignatureSource(value, map)
      : mapTypeNames(value, map);
  }
}

/**
 * A spec with every reference at a raw position (rawReferences) passed through
 * `map` — the inverse table of rawReferences, used where a raw reference is
 * rewritten into its canonical text. An interface method's display signature
 * follows its parameter and return types, token by token.
 */
function mapRawReferences<T>(kind: ReferenceKind, spec: T, map: ReferenceMapper): T {
  switch (kind) {
    case 'subsystem': {
      const s = spec as unknown as SubsystemSpec;
      return { ...s, trustedLinks: (s.trustedLinks ?? []).map((l) => ({ ...l, subsystem: map('trustedLinks', l.subsystem) })) } as unknown as T;
    }
    case 'interface':
    case 'type': {
      // Every type-expression slot (TYPE_EXPRESSION_PATHS), on a copy. A type
      // source is a raw type position; a method source's head is bound, never raw.
      const copy = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
      for (const slot of typeExpressionSlots(kind, copy)) {
        const value = slot.holder[slot.key] as string;
        if (slot.path === 'methods.signatureFrom' && signatureSourceParts(value)) continue;
        slot.holder[slot.key] = mapTypeNames(value, map);
      }
      return copy as unknown as T;
    }
    case 'implementation': {
      const impl = spec as unknown as ImplementationSpec;
      return {
        ...impl,
        methods: impl.methods.map((m) => ({
          ...m,
          ...(m.calls ? {
            calls: m.calls.map((entry) => {
              const call = parseDeclaredCall(entry);
              const next = call ? map('calls', call.compId) : undefined;
              return call && next !== call.compId ? `${next}.${call.methodName}` : entry;
            }),
          } : {}),
          narrative: m.narrative.map((authored) => {
            const step = authored.assertsInvariants
              ? { ...authored, assertsInvariants: authored.assertsInvariants.map((ref) => mapInvariantRef(ref, map)) }
              : authored;
            const source = (step as { auth?: { from?: string } }).auth?.from;
            if (typeof source !== 'string' || !source.startsWith(COMPONENT_AUTH_SOURCE)) return step;
            const auth = (step as { auth: Record<string, unknown> }).auth;
            return { ...step, auth: { ...auth, from: `${COMPONENT_AUTH_SOURCE}${map('auth', source.slice(COMPONENT_AUTH_SOURCE.length))}` } };
          }),
        })),
      } as unknown as T;
    }
    default:
      return spec;
  }
}

/**
 * A chained subproject's implementation file paths (sourcePath, each method's
 * sourcePath, simPath) are relative to ITS root: the loader reads them against
 * it, and the member's own gate checks them there.
 * A path authored through a parent — relative to the authoring root — that
 * lands inside the member is re-expressed against the member root. Any other
 * path is taken as already member-relative (as every loaded one is) and kept
 * verbatim, so load → save stays a fixpoint.
 */
function childRelativeFilePaths(spec: ImplementationSpec, authoringRoot: string, childRoot: string): ImplementationSpec {
  const reexpress = (p: string): string => {
    if (path.isAbsolute(p)) return p;
    const rel = path.relative(childRoot, path.resolve(authoringRoot, p));
    const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    return inside ? rel.replace(/\\/g, '/') : p;
  };
  return {
    ...spec,
    ...(spec.sourcePath ? { sourcePath: reexpress(spec.sourcePath) } : {}),
    ...(spec.simPath ? { simPath: reexpress(spec.simPath) } : {}),
    ...(spec.bindings ? { bindings: spec.bindings.map(reexpress) } : {}),
    methods: spec.methods.map((m) => (m.sourcePath ? { ...m, sourcePath: reexpress(m.sourcePath) } : m)),
  };
}

/**
 * An implementation's file paths — sourcePath, each method's sourcePath,
 * simPath — re-expressed from the root that holds the part in memory to the
 * part's own root (stage 8), where its file reads them: the inverse of the
 * scan's normalization, inside the part or not.
 */
function partRelativeFilePaths(spec: ImplementationSpec, authoringRoot: string, partRoot: string): ImplementationSpec {
  const reexpress = (p: string): string =>
    (path.isAbsolute(p) ? p : (path.relative(partRoot, path.resolve(authoringRoot, p)) || '.').split(path.sep).join('/'));
  return {
    ...spec,
    ...(spec.sourcePath ? { sourcePath: reexpress(spec.sourcePath) } : {}),
    ...(spec.simPath ? { simPath: reexpress(spec.simPath) } : {}),
    ...(spec.bindings ? { bindings: spec.bindings.map(reexpress) } : {}),
    methods: spec.methods.map((m) => (m.sourcePath ? { ...m, sourcePath: reexpress(m.sourcePath) } : m)),
  };
}

/**
 * A type's file paths — its sourcePath and each method's — re-expressed from
 * the root that holds the part in memory to the part's own root, exactly as
 * partRelativeFilePaths does an implementation's.
 */
function partRelativeTypePaths(spec: StoredTypeSpec, authoringRoot: string, partRoot: string): StoredTypeSpec {
  const reexpress = (p: string): string =>
    (path.isAbsolute(p) ? p : (path.relative(partRoot, path.resolve(authoringRoot, p)) || '.').split(path.sep).join('/'));
  return {
    ...spec,
    ...(spec.sourcePath ? { sourcePath: reexpress(spec.sourcePath) } : {}),
    ...(spec.methods ? { methods: spec.methods.map((m) => (m.sourcePath ? { ...m, sourcePath: reexpress(m.sourcePath) } : m)) } : {}),
  } as StoredTypeSpec;
}

// ---------------------------------------------------------------------------
// The scan without position: its per-root working state and the pure steps of
// its three phases (tables, then binding). The workspace owns the I/O half.
// ---------------------------------------------------------------------------

/** One reference with `::` set aside in phase one, bound in phase three. */
interface PendingReference {
  kind: ReferenceKind;
  specKey: string;
  position: string;
  authored: string;
  /** A position the loader leaves raw: recorded, never rewritten. */
  raw: boolean;
}

/** One root as the scan works on it. */
interface RawRoot {
  record: ScannedProjectRoot;
  /** The alias path from the bound root ('' for it): the key of a member whose id is taken or missing. */
  aliasPath: string;
  dir: string;
  /** Its specs: as written in phase one, keyed and bound after. */
  index: SpecIndex;
  /** Its legacy L1 mounts, with their files. */
  mounts: { spec: SubsystemSpec; file: string }[];
  members: MemberDeclarationRead[];
  /** Each followed member's alias → its key. */
  memberKeys: Map<string, string>;
  rawSystem: SystemSpec | null;
  localSubsystems: Set<string>;
  pending: PendingReference[];
  /** Every bare name set aside in phase one because it names no spec of the root: bound through the root's `use` imports in phase three. */
  pendingImports: PendingReference[];
}

function emptyExportTable(owner: string, level: 'subsystem' | 'project'): ResolvedExportTable {
  return { owner, level, entries: [], problems: [] };
}

/** A root's effective project id, when its configuration yields one. */
function idOf(raw: RawRoot): string | undefined {
  return raw.record.config ? effectiveProjectId(raw.record.config) ?? undefined : undefined;
}

/** A key's local id in the project keyed `project`. */
function localOf(project: string, key: string): string {
  return project && key.startsWith(`${project}::`) ? key.slice(project.length + 2) : key;
}

/** The first alias a root declares for a producer key. */
function aliasFor(raw: RawRoot, producer: string): string | undefined {
  for (const [alias, key] of raw.record.aliases) if (key === producer) return alias;
  return undefined;
}

/** The in-memory key an export entry binds to: its component, or its type. */
function exportedKey(entry: ResolvedExport): string | undefined {
  return entry.kind === 'type' ? entry.typeDef : entry.component;
}

/** A root as reference reading sees it. */
function readableOf(raw: RawRoot): ReadableProject {
  const id = idOf(raw);
  return {
    namespace: raw.record.namespace,
    ...(raw.record.parent !== undefined ? { parent: raw.record.parent } : {}),
    ...(id !== undefined ? { id } : {}),
    aliases: raw.record.aliases,
    declaredAliases: new Set([
      ...raw.members.map((m) => m.alias),
      ...(raw.record.config ? Object.keys(raw.record.config.externals ?? {}) : []),
    ]),
    subsystems: raw.localSubsystems,
  };
}

/**
 * A root's own L0 keyed into its key: `from` against its subsystems (an alias
 * of a member or external stays as written), `component`, `interface` and
 * `typeDef` against their source — an item re-exported from another project is
 * a public name there and stays as written.
 */
function keyedSystem(system: SystemSpec | null, key: string, subsystems: ReadonlySet<string>): SystemSpec | null {
  if (!system || !key) return system;
  return {
    ...system,
    publicInterfaces: system.publicInterfaces?.map((e) => {
      const source = e.from ?? e.subsystem;
      const fromProject = source !== undefined && !subsystems.has(source);
      const item = (value: string | undefined): string | undefined =>
        value === undefined || fromProject || value.includes('::') ? value : keyIn(key, value);
      const src = (value: string | undefined): string | undefined =>
        value === undefined || !subsystems.has(value) ? value : keyIn(key, value);
      return {
        ...e,
        ...(e.from !== undefined ? { from: src(e.from) } : {}),
        ...(e.subsystem !== undefined ? { subsystem: src(e.subsystem) } : {}),
        ...(e.component !== undefined ? { component: item(e.component) } : {}),
        ...(e.interface !== undefined ? { interface: item(e.interface) } : {}),
        ...(e.typeDef !== undefined ? { typeDef: item(e.typeDef) } : {}),
      };
    }),
  };
}

/** A type expression with every named reference rewritten through `rename`; a text that does not parse is kept. */
function referrerSpelling(text: string | undefined, rename: (name: string) => string): string | undefined {
  if (text === undefined) return undefined;
  const parsed = parseTypeExpression(text, 'returns');
  if (!parsed.expression) return text;
  const walk = (expr: TypeExpression): TypeExpression => {
    const args = expr.args.map(walk);
    return (expr.form === 'named' || expr.form === 'applied') && !isTypeVocabulary(expr.name!) ? { ...expr, name: rename(expr.name!), args } : { ...expr, args };
  };
  return canonicalTypeText(walk(parsed.expression));
}

/** One export method spelled as the referrer writes it: every named type through `rename`, no source of its own. */
function spelledForReferrer(method: MethodSignature, rename: (name: string) => string): MethodSignature {
  const { signatureFrom: _source, ...rest } = method;
  return {
    ...rest,
    returns: referrerSpelling(method.returns, rename) ?? method.returns,
    ...(method.params ? { params: method.params.map((p) => ({ ...p, type: referrerSpelling(p.type, rename) ?? p.type })) } : {}),
  };
}

/**
 * The methods of other projects' export entries a signatureFrom may name, per
 * referring root: `<namespace>|<alias>::<public name>.<method>` → the method,
 * its named types written as the referrer spells them (`<alias>::<public
 * name>`). A declared external's entries come from the root's own pinned
 * snapshot (.wai/externals/<alias>.yaml); a contained member's from its live
 * L0 table. A method that names a source of its own is left out: sources do
 * not chain.
 */
function exportMethodsOf(raws: RawRoot[]): Map<string, MethodSignature> {
  const out = new Map<string, MethodSignature>();
  const byKey = new Map(raws.map((r) => [r.record.namespace, r] as const));
  const last = (id: string): string => id.split('::').pop()!.split('.').pop()!;
  for (const raw of raws) {
    const ns = raw.record.namespace;
    // A contained member's live L0 entries.
    for (const [alias, key] of raw.record.aliases) {
      const producer = byKey.get(key);
      const table = producer?.record.exports;
      if (!producer || !table) continue;
      const typeNames = new Map<string, string>();
      for (const e of table.entries) if (e.kind === 'type' && e.typeDef) typeNames.set(last(e.typeDef), e.publicName);
      const rename = (name: string): string => `${alias}::${typeNames.get(last(name)) ?? last(name)}`;
      for (const entry of table.entries) {
        if (entry.kind !== 'component' || !entry.component) continue;
        const contracts = producer.index.interfaces.filter((i) => (entry.interface ? i.id === entry.interface : i.component === entry.component));
        for (const method of contracts.flatMap((i) => i.methods)) {
          if (method.signatureFrom !== undefined) continue;
          out.set(`${ns}|${alias}::${entry.publicName}.${method.name}`, spelledForReferrer(method, rename));
        }
      }
    }
    // A declared external's pinned entries.
    const config = raw.record.config;
    if (!config) continue;
    for (const declared of declaredExternals(config)) {
      if (declared.problem || raw.record.aliases.has(declared.alias)) continue;
      let snapshot: SurfaceSnapshot;
      try {
        const file = path.join(aiPathsAt(raw.dir).root(), 'externals', `${declared.alias}.yaml`);
        if (!fs.existsSync(file)) continue;
        snapshot = SurfaceSnapshotSchema.parse(readYamlFile(file));
      } catch {
        continue;
      }
      const publicOf = new Map((snapshot.exportedTypes ?? []).map((t) => [t.type, t.id] as const));
      const closure = new Set(snapshot.types.map((t) => t.id));
      const rename = (name: string): string => (closure.has(name) ? `${declared.alias}::${publicOf.get(name) ?? last(name)}` : name);
      for (const entry of snapshot.interfaces) {
        for (const method of entry.methods) {
          out.set(`${ns}|${declared.alias}::${entry.id}.${method.name}`, spelledForReferrer(method as MethodSignature, rename));
        }
      }
    }
  }
  return out;
}

/**
 * Phase two: every root's L1 tables and L0 table through the pure export
 * resolver, each after the producers its L0 re-exports from; a producer met
 * again on its own resolution path is handed on as null (a named cycle).
 */
function resolveFamilyTables(raws: RawRoot[]): void {
  const byKey = new Map(raws.map((r) => [r.record.namespace, r] as const));
  const done = new Set<string>();
  const resolving = new Set<string>();
  const resolve = (raw: RawRoot): ResolvedExportTable | null => {
    const key = raw.record.namespace;
    if (done.has(key)) return raw.record.exports;
    if (resolving.has(key)) return null;
    resolving.add(key);
    try {
      const { subsystems, components, interfaces, types } = raw.index;
      // Step 10: the root's L1 tables.
      const subsystemTables = resolveSubsystemTables(subsystems, components, interfaces, types);
      // Step 11: the L0 table, after every producer its entries name.
      const producerTables = new Map<string, ResolvedExportTable | null>();
      const audienceOf = new Map<string, string>();
      for (const e of raw.record.system?.publicInterfaces ?? []) {
        const source = e.from ?? e.subsystem;
        const producerKey = source !== undefined ? raw.record.aliases.get(source) : undefined;
        if (producerKey === undefined || producerTables.has(producerKey)) continue;
        const producer = byKey.get(producerKey);
        producerTables.set(producerKey, producer ? resolve(producer) : null);
        audienceOf.set(producerKey, 'project');
      }
      raw.record.subsystemExports = subsystemTables;
      raw.record.exports = resolveProjectTable(raw.record.system, subsystems, components, interfaces, types, subsystemTables, {
        namespace: key,
        aliases: raw.record.aliases,
        producerTables,
        audienceOf,
      });
      // A re-export of a name its producer renamed is told the new name.
      followProducerRenames(raw.record.exports, (source) => {
        const key = raw.record.aliases.get(source);
        const producer = key !== undefined ? byKey.get(key) : undefined;
        return producer?.record.exports ? { table: producer.record.exports, specs: producer.index } : undefined;
      });
      done.add(key);
      return raw.record.exports;
    } finally {
      resolving.delete(key);
    }
  };
  raws.forEach((raw) => resolve(raw));
}

/**
 * Step 13: bind one reference with `::` written in `raw` — local first, then
 * by form — and say what it bound to, the value the loader keeps in memory,
 * and the text the writer would emit for it.
 */
function bindAuthored(
  raw: RawRoot,
  raws: RawRoot[],
  readables: ReadableProject[],
  authored: string,
): { value: string; reference?: Omit<AuthoredReference, 'specId' | 'position'> } {
  const key = raw.record.namespace;
  // A PART's alias names no namespace (stage 8): its specs are this root's own.
  const first = authored.split('::')[0];
  if (raw.members.some((m) => m.kind === 'part' && m.alias === first)) {
    const local = authored.slice(first.length + 2);
    return {
      value: authored,
      reference: {
        authored, form: 'alias', binding: 'unresolved', resolved: authored,
        hint: `"${first}" is a part of this project, so its specs are this project's own: write the local id "${local}"`,
      },
    };
  }
  const landing = landReference(readables, authored, key);
  if (landing.kind === 'outside' || landing.kind === 'unresolved') {
    return { value: authored, reference: { authored, form: landing.form, binding: landing.kind, resolved: authored } };
  }
  // A subsystem segment of the referring project qualifies a local item.
  if (!landing.form) return { value: keyIn(key, authored) };
  const producer = raws.find((r) => r.record.namespace === landing.project)!;
  const target = keyIn(landing.project, landing.name);
  const entries = producer.record.exports.entries;
  if (landing.form === 'alias') {
    const entry = entries.find((e) => e.publicName === landing.name);
    const resolved = (entry && exportedKey(entry)) ?? target;
    return {
      value: resolved,
      reference: {
        authored, form: 'alias', binding: entry ? 'exported' : 'unexported', resolved, producer: landing.project,
        ...(entry ? { publicName: entry.publicName } : {}), rewrite: authored,
      },
    };
  }
  if (landing.project === key) {
    return { value: target, reference: { authored, form: landing.form, binding: 'local', resolved: target, producer: key, rewrite: landing.name } };
  }
  const alias = aliasFor(raw, landing.project);
  const entry = entries.find((e) => e.publicName === landing.name && exportedKey(e) === target)
    ?? entries.find((e) => exportedKey(e) === target);
  const aliasText = alias ?? idOf(producer);
  const binding: ReferenceBinding = alias !== undefined ? (entry ? 'exported' : 'unexported') : 'undeclared';
  return {
    value: target,
    reference: {
      authored, form: landing.form, binding, resolved: target, producer: landing.project,
      ...(entry && binding === 'exported' ? { publicName: entry.publicName } : {}),
      ...(aliasText ? { rewrite: `${aliasText}::${entry?.publicName ?? landing.name}` } : {}),
    },
  };
}

/** One `use` import of a root: the alias, the producer the scan read (absent for one it did not), and what it imports. */
interface ImportSupplier {
  alias: string;
  /** Where the alias is declared, for the `use` line a hint names. */
  section: ImportSection;
  producer?: RawRoot;
  /** Whether it imports every public name (`*`). */
  star: boolean;
  /** The nameKeys it imports by name. */
  names: Set<string>;
}

/** Every alias the root declares with its `use` imports — members and externals alike. */
function importSuppliers(raw: RawRoot, raws: RawRoot[]): ImportSupplier[] {
  const config = raw.record.config;
  if (!config) return [];
  const producerOf = (alias: string): RawRoot | undefined => {
    const key = raw.record.aliases.get(alias);
    return key === undefined ? undefined : raws.find((r) => r.record.namespace === key);
  };
  const supplier = (alias: string, section: ImportSupplier['section'], use: string[]): ImportSupplier => ({
    alias, section, producer: producerOf(alias), star: use.includes('*'), names: new Set(use.filter((u) => u !== '*').map(nameKey)),
  });
  return [
    // A part supplies nothing: its names are the root's own (stage 8).
    ...declaredMembers(config).filter((m) => !m.problem && !raw.members.some((d) => d.kind === 'part' && d.alias === m.alias))
      .map((m) => supplier(m.alias, 'members', m.use)),
    ...declaredExternals(config).filter((e) => !e.problem).map((e) => supplier(e.alias, 'externals', e.use)),
  ];
}

/** The public name of a kind a producer's L0 table exports under a nameKey, if any. */
function exportedUnder(producer: RawRoot, key: string, kind: 'component' | 'type'): ResolvedExport | undefined {
  return producer.record.exports.entries.find((e) => e.kind === kind && nameKey(e.publicName) === key);
}

/**
 * Step 14 for one bare name: bind it through the root's imports. An explicit
 * name beats a `*`; exactly one supplier binds it (exported), two are
 * ambiguous; none the scan read, while an import names an external it did not
 * read, keeps it as written (outside: the owner's gate resolves it against the
 * pin); otherwise it is unresolved, with a hint naming a declared alias whose
 * table exports the key without importing it. Nothing outside the root's own
 * alias table is ever consulted.
 */
function bindImport(raw: RawRoot, suppliers: ImportSupplier[], p: PendingReference): { value: string; reference: AuthoredReference } {
  const key = nameKey(p.authored);
  const kind = p.position === 'type' ? 'type' : 'component';
  const local = keyIn(raw.record.namespace, p.authored);
  const base = { specId: p.specKey, position: p.position, authored: p.authored, form: 'import' as const };
  const supplies = (s: ImportSupplier): boolean => s.star || s.names.has(key);
  const found = (s: ImportSupplier): ResolvedExport | undefined => (s.producer ? exportedUnder(s.producer, key, kind) : undefined);
  const explicit = suppliers.filter((s) => s.names.has(key) && (!s.producer || found(s)));
  const pool = explicit.length > 0 ? explicit : suppliers.filter((s) => s.star && (!s.producer || found(s)));
  const read = pool.filter((s) => s.producer);
  const unread = pool.filter((s) => !s.producer);
  if (read.length + unread.length > 1 && (explicit.length > 0 || read.length > 1)) {
    return { value: local, reference: { ...base, binding: 'ambiguous', resolved: local, importedVia: pool.map((s) => s.alias).join(', ') } };
  }
  if (read.length === 1 && unread.length === 0) {
    const s = read[0];
    const entry = found(s)!;
    const target = exportedKey(entry) ?? local;
    return {
      value: target,
      reference: {
        ...base, binding: 'exported', resolved: target, producer: s.producer!.record.namespace, publicName: entry.publicName,
        rewrite: p.authored, importedVia: `${s.alias} (${s.names.has(key) ? 'by name' : 'by *'})`,
      },
    };
  }
  if (unread.length > 0) {
    return { value: local, reference: { ...base, binding: 'outside', resolved: local, importedVia: unread.map((s) => s.alias).join(', ') } };
  }
  const hinted = suppliers.find((s) => !supplies(s) && found(s));
  const entry = hinted ? found(hinted) : undefined;
  return {
    value: local,
    reference: {
      ...base, binding: 'unresolved', resolved: local,
      ...(hinted && entry ? { hint: `${hinted.section}.${hinted.alias}.use: [${entry.publicName}]` } : {}),
    },
  };
}

/** Phase three at one root: bind every reference set aside, record it, and put the bound value in the spec. */
/**
 * The text one type position of an interface or a type holds, addressed by the
 * path a respelling names (methods.save.params.key, methods.save.returns,
 * fields.createdAt, params.listener, returns); undefined when the spec no
 * longer holds it.
 */
function typePositionText(spec: Record<string, any>, at: string): string | undefined {
  const [head, name, member, param] = at.split('.');
  const named = (list: unknown, key: string | undefined): Record<string, any> | undefined =>
    (Array.isArray(list) ? list.find((x) => x?.name === key) : undefined);
  if (head === 'returns') return spec.returns;
  if (head === 'params') return named(spec.params, name)?.type;
  if (head === 'fields') return named(spec.fields, name)?.type;
  if (head !== 'methods') return undefined;
  const method = named(spec.methods, name);
  return member === 'returns' ? method?.returns : named(method?.params, param)?.type;
}

/**
 * The text every params-bearing method of every root derives from its params
 * AS THE FILE SPELLS THEM, keyed `<interface|type>|<spec key>|<method>` — what
 * step 23 compares a stale stored text against, so a text that differs only
 * because its params are stored in alias spellings is not reported twice. A
 * sourced method stores no text and is left out.
 */
function writtenSignatureTexts(raws: RawRoot[]): Map<string, string> {
  const texts = new Map<string, string>();
  const record = (kind: 'interface' | 'type', specId: string, methods: ReadonlyArray<Parameters<typeof deriveMethodSignature>[0] & { signatureFrom?: string }>): void => {
    for (const m of methods) {
      if (m.signatureFrom !== undefined) continue;
      const derived = deriveMethodSignature(m);
      if (derived !== undefined) texts.set(`${kind}|${specId}|${m.name}`, derived);
    }
  };
  for (const raw of raws) {
    for (const intf of raw.index.interfaces) record('interface', intf.id, intf.methods ?? []);
    for (const type of raw.index.types) record('type', type.id, type.methods ?? []);
  }
  return texts;
}

/**
 * spec_index_impl.listProjectRoots step 18 — every root's interfaces and types
 * read under the type grammar (interface_spec.canonicalTypes,
 * type_spec.canonicalTypes), in place on the root's index: each structured
 * type position respelled to its canonical text in memory, so every consumer
 * reads one spelling. Run on the specs as read, before any reference is
 * bound, so a respelling compares the file's own text. Answers the stored
 * aliases and the positions that are not canonical, located by spec and path.
 */
function canonicalizeRootTypes(raws: RawRoot[]): TypeSpellingFacts {
  const facts = emptyTypeSpellingFacts();
  for (const raw of raws) {
    raw.index.interfaces = raw.index.interfaces.map((intf) => {
      const read = interfaceCanonicalTypes(intf);
      facts.respellings.push(...read.respellings);
      facts.problems.push(...read.problems);
      return read.spec;
    });
    raw.index.types = raw.index.types.map((type) => {
      const read = typeCanonicalTypes(type);
      facts.respellings.push(...read.respellings);
      facts.problems.push(...read.problems);
      return read.spec;
    });
  }
  return facts;
}

function bindRootReferences(raw: RawRoot, raws: RawRoot[], readables: ReadableProject[]): void {
  const bound = new Map<string, Map<string, string>>();
  for (const p of raw.pending) {
    const { value, reference } = bindAuthored(raw, raws, readables, p.authored);
    if (reference) raw.record.authoredReferences.push({ specId: p.specKey, position: p.position, ...reference });
    if (p.raw) continue;
    const perSpec = bound.get(p.specKey) ?? new Map<string, string>();
    perSpec.set(`${p.position}|${p.authored}`, value);
    bound.set(p.specKey, perSpec);
  }
  // Step 14: every bare name set aside, bound through the root's imports.
  const suppliers = importSuppliers(raw, raws);
  for (const p of raw.pendingImports) {
    const { value, reference } = bindImport(raw, suppliers, p);
    raw.record.authoredReferences.push(reference);
    if (p.raw || reference.binding !== 'exported') continue;
    const perSpec = bound.get(p.specKey) ?? new Map<string, string>();
    perSpec.set(`${p.position}|${keyIn(raw.record.namespace, p.authored)}`, value);
    bound.set(p.specKey, perSpec);
  }
  if (bound.size === 0) return;
  const rebind = <T extends { id: string }>(kind: ReferenceKind, spec: T): T => {
    const perSpec = bound.get(spec.id);
    return perSpec ? mapSpecReferences(kind, spec, (position, value) => perSpec.get(`${position}|${value}`) ?? value) : spec;
  };
  const index = raw.index;
  index.subsystems = index.subsystems.map((s) => rebind('subsystem', s));
  index.components = index.components.map((c) => rebind('component', c));
  index.interfaces = index.interfaces.map((i) => rebind('interface', i));
  index.implementations = index.implementations.map((m) => rebind('implementation', m));
  index.types = index.types.map((t) => rebind('type', t));
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

function computeSpecTreeSignature(dirs: string[], files: string[] = []): string {
  const parts: string[] = [];
  // Each walked root's .wai/project.yaml: an edit to a root's externals re-scans.
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      parts.push(`${f}:${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push(`${f}:missing`);
    }
  }
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      parts.push(`${dir}:missing`);
      continue;
    }
    for (const f of listSpecFiles(dir)) {
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
  /**
   * Keep the existing `updatedAt` instead of re-stamping it — for a MECHANICAL
   * re-save that changes no authored content (the lock's status promotion).
   * Stamping there claimed the spec had been edited, so freezing a tree was
   * indistinguishable from designing it in a diff, and every lock dirtied two
   * lines per spec where the status flip alone is one.
   */
  preserveUpdatedAt?: boolean;
  /**
   * The reachability migration's own write: the retired reachability forms it
   * rewrote are retired, not carried back — a component's stored listener
   * `mounts`, an interface method's stored retired invokedBy kind, and a stored
   * endpoint the written method leaves out (an in-process Custom address the
   * migration dropped). Every other write keeps carrying them.
   */
  retireReachForms?: boolean;
}

/**
 * Hooks an AUTHORING caller injects into a write.
 *
 * `gate` sees the fully merged spec immediately before it is persisted, and
 * throws to refuse the write. It exists as an injected hook rather than a direct
 * call because the spec store must not depend on the rule engine —
 * core/validation.ts (the rule engine's entry point) already reads this
 * module, so importing the validator here would close an import cycle.
 * Inversion keeps the dependency pointing one way and keeps mechanical
 * re-saves (status promotion, layout normalization, migrations) ungated: they
 * pass no hooks and behave exactly as before, which matters because a spec
 * that predates a rule must stay loadable and repairable.
 *
 * Return notices to surface alongside the write's own.
 */
export interface SpecWriteHooks {
  gate?(
    kind: 'system' | 'subsystem' | 'component' | 'interface' | 'implementation' | 'type',
    merged: Record<string, any>,
  ): string[] | void;
  /**
   * Judge a spec the same way `gate` does but ANSWER with the rule codes
   * instead of throwing, so a caller can ask whether a shape WOULD be legal
   * without attempting the write.
   *
   * This exists for the move's alternatives search. The store holds the tree
   * and can enumerate candidate homes; the gate holds the judgement; neither
   * can answer "where could these methods live" alone. Driving that search
   * through `gate` would mean running it on caught exceptions — a search whose
   * control flow is a throw per candidate, where a genuine bug in the gate is
   * indistinguishable from a refusal.
   */
  assess?(
    kind: 'system' | 'subsystem' | 'component' | 'interface' | 'implementation' | 'type',
    merged: Record<string, any>,
  ): string[];
}

/** The kinds `updateSpec` addresses — every level of the tree. */
export type WritableSpecKind =
  'system' | 'subsystem' | 'component' | 'interface' | 'implementation' | 'type';

/** One stored spec of any level — what the kind-generic load answers and save takes. */
type StoredSpec = SystemSpec | SubsystemSpec | ComponentSpec | InterfaceSpec | ImplementationSpec | TypeSpec;

/** What a write did at one path of a stored spec. */
export type SpecChangeKind = 'set' | 'added' | 'removed' | 'cleared' | 'renumbered' | 'relocated' | 'reordered';

/**
 * ONE change a write made to a stored spec, addressed by a dotted path with
 * names and indexes: `methods.createMember.narrative.step 7.type`,
 * `dependsOn`, `description`.
 */
export interface SpecChange {
  path: string;
  /**
   * `set` a value, `added` a key/element, `removed` one, `cleared` a list. A
   * narrative is compared by step identity, so it adds two more: `renumbered`,
   * a run of unchanged steps an insert or delete shifted (before and after name
   * the ranges), and `relocated`, a jump field that followed its target.
   */
  change: SpecChangeKind;
  /** The previous value, summarized; absent when there was none. */
  before?: string;
  /** The new value, summarized; absent when there is none. */
  after?: string;
}

/**
 * The answer to an authoring write: exactly what changed, or that nothing did.
 *
 * A write that changes nothing writes nothing — `written` is false, the file's
 * `updatedAt` is untouched, and `summary` says so. Reporting success for a
 * write that changed nothing is how a typo'd delta ("dependson", a method-level
 * `unset` that no-opped) read as a completed edit for a whole session.
 */
export interface SpecChangeReport {
  kind: WritableSpecKind;
  id: string;
  /** False when the merged spec equals what is stored: nothing reached disk. */
  written: boolean;
  /**
   * True when the caller asked what the delta would do and nothing was written.
   * `written` is false for a dry run exactly as it is for a delta that changed
   * nothing, and only this field tells the two apart.
   */
  dryRun: boolean;
  /** Every change the write made; empty exactly when `written` is false. */
  changes: SpecChange[];
  /**
   * Every path the delta named that the write did not act on, each with why: a
   * key the level's schema drops (a nested typo the permissive delta cannot
   * refuse), or a value the stored spec already held. Named rather than
   * stripped — a key silently dropped is how a typo reads as a completed edit.
   */
  ineffective: string[];
  /** Store placement notices, gate warnings and delta notices. */
  notices: string[];
  /**
   * Each type position of the merged spec the write normalised (or, on a dry
   * run, would): what the delta or the stored file wrote against the canonical
   * spelling stored. Empty when every position was already canonical, and on a
   * write that changes nothing.
   */
  respellings: TypeRespelling[];
  /** One line for people. */
  summary: string;
  /**
   * The tests that encode a method this write changed or deleted, one entry per
   * such method. Empty when the write touched no method, when the project
   * declares no test roots, or when nothing references them.
   *
   * This is what a spec pass never said: eight hosted tests once encoded
   * behaviour a committed spec had changed, and a brief that said "keep
   * existing tests green" collided with the spec because nothing listed them.
   * The write that creates the collision is the one that reports it.
   */
  testsToRevisit: TestsToRevisit[];
  /**
   * Keys the stored document on disk carries that its level's schema does not
   * know — read from the raw file, since the parse already discarded them —
   * which this write drops (or, on a dry run, would drop), each as
   * `path: value` (`status: draft` on an L0). Absent when there are none, and
   * on a write that changes nothing, because nothing is re-serialized then.
   */
  strippedKeys?: string[];
  /**
   * Each implementation method entry the write removed with a contract method
   * it removed, as `<implementation>.<method>` (on a dry run, would remove).
   * Absent when the write removed no contract method.
   */
  cascaded?: string[];
  /**
   * Every public name a consumer reaches a contract method this write removed
   * through, read before the write. Absent when no removed method is published.
   */
  published?: ExportUse[];
  /** The consumers whose specs call a removed method on a published name. Filled by the door that read them. */
  breaks?: ExternalConsumer[];
}

/**
 * One component considered as a home for a set of moved methods, and what
 * putting them there would cost (method_move_candidate).
 *
 * Produced when a move is refused: a refusal that only says which rule fired
 * leaves the caller to work out where the methods CAN live, which is the search
 * this type answers. Ranked by `newDependencies` length, so the cheapest legal
 * home is first.
 */
export interface MethodMoveCandidate {
  /** The candidate component's id. */
  component: string;
  /** True when the methods could move here with no rule refusing it. */
  legal: boolean;
  /**
   * The dependencies this component does not have yet but the moved methods
   * call. Empty when it already reaches everything they need — the cheapest
   * possible home.
   */
  newDependencies: string[];
  /** What this component's dependency count would become after the move, counting `newDependencies`. */
  dependencyCount: number;
  /**
   * The project's `maxComponentDependencies` at the time of the answer, so
   * `dependencyCount` can be read without looking up the config.
   */
  dependencyLimit: number;
  /** The rule codes that would refuse the move into this component. Empty exactly when `legal` is true. */
  refusals: string[];
}

/**
 * The answer to a method move (method_move_report): what moved, every reference
 * that was re-pointed to follow it, and — when a rule refused the move — which
 * rule and where the methods could live instead.
 *
 * A move is several gated writes at once (both contracts, both implementations,
 * the target component, and every caller whose steps name the old home), so
 * `edits` carries one SpecChangeReport per spec touched rather than one flat
 * change list. Either all of them land or none do: a partial move leaves callers
 * pointing at a method that is no longer there.
 */
export interface MethodMoveReport {
  /**
   * True only when the methods now live on `to` and every edit reached disk.
   * False for a refusal and for a dry run alike; `refusals` and `dryRun` tell
   * those apart.
   */
  moved: boolean;
  /** The component the methods were taken from. */
  from: string;
  /** The component asked to receive them. */
  to: string;
  /** The method names the caller asked to move, in the order given. */
  methods: string[];
  /** One report per spec the move touched. Empty when the move was refused. */
  edits: SpecChangeReport[];
  /**
   * How many references were re-pointed to follow the methods, across every
   * kind that names a component: narrative `call`, `register` and `dispatch`
   * steps by their targetComponent, dispatch-table bindings, lifecycle
   * entrypoints, and `calls` entries by their `<component>.<method>` string.
   */
  repointed: number;
  /**
   * The rule codes that refused the move, each with what it judged. Empty
   * exactly when nothing refused it; a non-empty list means nothing reached disk.
   */
  refusals: string[];
  /**
   * Where these methods could live instead, cheapest legal home first,
   * including `to` itself so its shortfall can be read beside the others.
   * Populated only on a refusal.
   */
  alternatives: MethodMoveCandidate[];
  /** What the caller should know but nothing refused. */
  notices: string[];
  /** One line for people. */
  summary: string;
  /** True when the caller asked what the move would do and nothing was written. */
  dryRun: boolean;
  /**
   * Ids of the specs whose prose still names the old home, and wire endpoint
   * bindings that keep it. Nothing here was rewritten.
   */
  mentions: string[];
  /**
   * The specs the move created to receive the methods, each named with its kind
   * and id — `i<to>` for a target that declared no contract, `<to>_impl` for a
   * receiving contract no implementation realized — and, for an implementation,
   * the sourcePath it inherited. Empty when the target already had both, and on
   * a refusal; a dry run names what it would create.
   */
  created: string[];
  /**
   * Every edit to the debt register (.wai/project.yaml rules.conformance.carried)
   * the move made — or, on a dry run, would make: an entry anchored at a moved
   * method on the spec it left now anchors on the spec it arrived in, and a
   * covered `<from>.<method>` unit names `<to>.<method>`. Empty on a refusal.
   */
  carried: CarriedRekey[];
}

// ---------------------------------------------------------------------------
// The reference-field table — ONE list of where a spec names another spec.
//
// A component id and a method name are not written in one place. They sit in a
// component's dependsOn, owns and dispatch table; a subsystem's lifecycle
// entrypoints and published interfaces; the system's published interfaces; an
// interface's component and parameter types; an implementation's contract, its
// narrative targets, its `component:` credential sources and its `calls`
// entries; and an entity's componentClass and field types.
//
// Every operation that MOVES an identity has to walk that list, and the list is
// the part that goes stale: a kind added here and missed there leaves a dangling
// reference nobody finds until a later validate. So it is written once, and the
// operations differ only in their remap. `renameComponent` and `renameMethod`
// (core/provision.ts) drive it over raw files; `moveMethods` drives it over the
// typed store, because a move must be able to compute every edit before writing
// any of them.
//
// The rename traces (`previousIds` on a spec, `previousNames` on a contract
// method) are deliberately NOT in this table: they name keys that no longer
// exist, so no remap may rewrite them and no binding may qualify them. The
// loader and the writer carry them verbatim.
// ---------------------------------------------------------------------------

/** Where in a spec a reference sits, which is what decides how a remap should read it. */
export type RefPosition = 'component' | 'entity-class' | 'auth-source' | 'interface' | 'type' | 'method';

/** The `auth.from` prefix that makes a credential source a component reference. */
export const COMPONENT_AUTH_SOURCE = 'component:';

/** The level a spec file holds. */
export type SpecRefKind = 'system' | 'subsystem' | 'component' | 'interface' | 'implementation' | 'type';

/**
 * What a spec object holds, read from its shape as the loader reads it;
 * undefined for an object holding no spec at all. The order is the loader's: a
 * component and a subsystem are recognized before an interface, whose
 * `component` field a component spec would otherwise answer to.
 */
export function specKind(raw: any): SpecRefKind | undefined {
  if ('componentType' in raw) return 'component';
  if ('parentSystem' in raw) return 'subsystem';
  if ('vision' in raw) return 'system';
  if ('component' in raw && Array.isArray(raw.methods)) return 'interface';
  if ('contract' in raw && Array.isArray(raw.methods)) return 'implementation';
  if ('kind' in raw && Array.isArray(raw.fields)) return 'type';
  // A signature type carries params and returns instead of fields, and an enum
  // values instead, and a named scalar holds; a file written by hand may leave
  // its empty fields list out.
  if (raw.kind === 'signature' || raw.kind === 'enum') return 'type';
  if ('kind' in raw && typeof raw.holds === 'string') return 'type';
  return undefined;
}

/**
 * Rewrite every reference field of ONE spec object, in place, through `remap`;
 * answers whether anything changed.
 *
 * A method position is read with the component it hangs off — a dispatch
 * binding's and a lifecycle entrypoint's method, a narrative step's
 * targetMethod, and the method half of a `calls` entry — so a remap can
 * retarget the method of exactly one component. A component position is read
 * the same way round, with the method it serves where there is one, so a remap
 * can move exactly the methods it is moving and leave that component's other
 * references alone. Both halves are read as the spec WROTE them, before either
 * is rewritten.
 */
export function rewriteSpecRefs(
  raw: any,
  remap: (ref: string, position: RefPosition, owner?: string) => string,
): boolean {
  if (!raw || typeof raw !== 'object') return false;
  let changed = false;

  /** Rewrite `holder[key]` in place when it holds a reference. */
  const rewrite = (holder: any, key: string | number, position: RefPosition, owner?: string): void => {
    const ref = holder?.[key];
    if (typeof ref !== 'string') return;
    const next = remap(ref, position, owner);
    if (next !== ref) {
      holder[key] = next;
      changed = true;
    }
  };
  /** Rewrite the method name at `holder[key]`, read against the component `owner` names. */
  const rewriteMethod = (holder: any, key: string, owner: unknown): void => {
    const name = holder?.[key];
    if (typeof name !== 'string' || typeof owner !== 'string') return;
    const next = remap(name, 'method', owner);
    if (next !== name) {
      holder[key] = next;
      changed = true;
    }
  };
  /** A component/method pair, rewritten as one: the method against the component, then the component against the method. */
  const rewritePair = (holder: any, componentKey: string, methodKey: string): void => {
    const component = holder?.[componentKey];
    const method = holder?.[methodKey];
    rewriteMethod(holder, methodKey, component);
    rewrite(holder, componentKey, 'component', typeof method === 'string' ? method : undefined);
  };
  /** The entries of a list field; none when the field holds no list. */
  const entries = (list: unknown): any[] => (Array.isArray(list) ? list : []);
  /** Rewrite each reference a list field holds. */
  const rewriteEach = (list: unknown, position: RefPosition): void => {
    entries(list).forEach((_, i) => rewrite(list, i, position));
  };
  /** A published interface names the component realizing it and, optionally, its contract. */
  const rewritePublished = (list: unknown): void => {
    for (const published of entries(list)) {
      rewrite(published, 'component', 'component');
      rewrite(published, 'interface', 'interface');
    }
  };

  const kind = specKind(raw);
  if (kind === 'component') {
    rewriteEach(raw.dependsOn, 'component');
    rewriteEach(raw.owns, 'component');
    // A Portal's dispatch table carries component refs of its own, each with
    // the method that component serves the capability with.
    for (const binding of entries(raw.dispatch)) rewritePair(binding, 'component', 'method');
    // A listener's mount names the portal it serves. It carries no method, so
    // it reads like a dependsOn entry: left out, renaming a mounted portal
    // leaves the listener routing requests to nothing.
    for (const mount of entries(raw.mounts)) rewrite(mount, 'portal', 'component');
  } else if (kind === 'subsystem') {
    // Lifecycle entrypoints name components (same-subsystem by rule, but
    // rewrite defensively so a legacy/misdeclared tree can't silently dangle
    // across a migration) and the method the runtime invokes at that phase.
    for (const entrypoint of entries(raw.lifecycle)) rewritePair(entrypoint, 'component', 'method');
    rewritePublished(raw.publicInterfaces);
  } else if (kind === 'system') {
    rewritePublished(raw.publicInterfaces);
  } else if (kind === 'interface') {
    rewrite(raw, 'component', 'component');
    for (const method of entries(raw.methods)) {
      for (const param of entries(method?.params)) rewrite(param, 'type', 'type');
      // A signatureFrom is read both ways, as its resolver reads it: as a
      // `component.method` pair (a remap retargets the half it matches), and,
      // when that leaves it alone, as a type reference.
      const source = method?.signatureFrom;
      if (typeof source !== 'string') continue;
      const parts = signatureSourceParts(source);
      const name = parts ? remap(parts.tail, 'method', parts.head) : undefined;
      const component = parts ? remap(parts.head, 'component', parts.tail) : undefined;
      const next = parts && (component !== parts.head || name !== parts.tail)
        ? `${component}.${name}`
        : remap(source, 'type');
      if (next !== source) {
        method.signatureFrom = next;
        changed = true;
      }
    }
  } else if (kind === 'implementation') {
    rewrite(raw, 'contract', 'interface');
    for (const method of entries(raw.methods)) {
      for (const step of entries(method?.narrative)) {
        // A call, register or dispatch step names the method on its target.
        rewritePair(step, 'targetComponent', 'targetMethod');
        // A credential source names its component after the component: prefix.
        const source = step?.auth?.from;
        if (typeof source === 'string' && source.startsWith(COMPONENT_AUTH_SOURCE)) {
          const id = source.slice(COMPONENT_AUTH_SOURCE.length);
          const next = remap(id, 'auth-source');
          if (next !== id) {
            step.auth.from = `${COMPONENT_AUTH_SOURCE}${next}`;
            changed = true;
          }
        }
      }
      // `calls` is the narrative-less spelling of a call, and names the same
      // pair in one string. A reference that reads differently is still a
      // reference: left out of this table it dangles exactly as a step would.
      entries(method?.calls).forEach((entry: unknown, i: number) => {
        if (typeof entry !== 'string') return;
        const call = parseDeclaredCall(entry);
        if (!call) return;
        const component = remap(call.compId, 'component', call.methodName);
        const name = remap(call.methodName, 'method', call.compId);
        if (component === call.compId && name === call.methodName) return;
        method.calls[i] = `${component}.${name}`;
        changed = true;
      });
    }
  } else if (kind === 'type') {
    rewrite(raw, 'componentClass', 'entity-class');
    for (const field of entries(raw.fields)) rewrite(field, 'type', 'type');
    for (const param of entries(raw.params)) rewrite(param, 'type', 'type');
    rewrite(raw, 'returns', 'type');
    for (const method of entries(raw.methods)) {
      for (const param of entries(method?.params)) rewrite(param, 'type', 'type');
    }
  }

  return changed;
}

/** A value as a change report shows it: compact, and never a wall of YAML. */
function summarizeValue(value: unknown): string {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

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
function identityKeyOf(field: string, item: unknown): string | null {
  if (item === null || typeof item !== 'object') return null; // string lists: replace wholesale
  const o = item as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  switch (field) {
    case 'publicInterfaces':   return publicInterfaceKey(o);
    case 'dispatch':           return str(o.capability);
    // A listener mounts each portal once, so the portal IS the mount's identity.
    case 'mounts':             return str(o.portal);
    case 'lifecycle':          return `${String(o.phase)} ${String(o.component)} ${String(o.method)}`;
    case 'emits':
    case 'subscribesTo':       return `${String(o.topic)} ${o.event === undefined ? '' : String(o.event)}`;
    case 'trustedLinks':       return str(o.subsystem);
    // lint.allow: an allow is one decision about one OCCURRENCE, so several
    // may share a code on one spec, each naming its own site. Keyed by code
    // alone a delta for one site would overwrite its neighbours.
    case 'allow':              return `${String(o.code)} ${o.at === undefined ? '' : String(o.at)}`;
    case 'findings':           return str(o.code);       // an interface method's findings
    case 'invariants':         return str(o.id);
    case 'patterns':           return str(o.id);
    case 'boundaries':         return str(o.name);
    case 'globalRequirements': return str(o.description);
    case 'databases':          return str(o.id) ?? str(o.name);
    // A flow step's own arrays, addressed by the thing the author named them
    // for. Their `step` is a RELOCATABLE number, never an identity — a switch
    // case is the value it matches and a catch clause is the error it catches,
    // and both survive the renumbering that moves their target. (A parallel
    // arm falls to the default: named, it merges by name; unnamed, it carries
    // no identity at all and the list replaces wholesale, which is the same
    // rule everywhere else.)
    case 'cases':              return str(o.value);
    case 'catches':            return str(o.error);
    default:                   return str(o.name) ?? str(o.id);
  }
}

/**
 * A published interface's identity: the component it is bound to (and the
 * interface, when it names one). An entry NOT YET BOUND — the design-first state
 * a subsystem is authored in before its components exist — names no component,
 * so it is identified by the only things it does say, its type and details.
 * Keyed by component + interface alone, every unbound entry shared one identity
 * and a delta naming one of them folded it into the first.
 *
 * Binding an unbound entry therefore changes its identity: a delta that adds a
 * component adds a bound entry beside the unbound one, which stays until it is
 * deleted by its type and details.
 */
function publicInterfaceKey(o: Record<string, unknown>): string | null {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  // A re-export or a type export is addressed by its source, item and name:
  // two re-exports of one component from different sources are two entries.
  const from = str(o.from);
  const typeDef = str(o.typeDef);
  if (from || typeDef) {
    const item = typeDef ? `type ${typeDef}` : str(o.component) ?? '*';
    const narrowed = str(o.interface) ? `.${String(o.interface)}` : '';
    const renamed = str(o.as) ? ` as ${String(o.as)}` : '';
    return `${from ? `${from}:` : ''}${item}${narrowed}${renamed}`;
  }
  const component = str(o.component);
  if (component) return str(o.interface) ? `${component}.${String(o.interface)}` : component;
  if (typeof o.type === 'string' && typeof o.details === 'string') return `${o.type} ${o.details}`;
  return null;
}

/**
 * The identity a CHANGE REPORT addresses an array element by: the merge's own
 * identity where it has one, and the step number for a narrative — so a
 * changed step reads as `narrative.step 7.type` rather than a bare index.
 */
function reportIdentityOf(field: string, item: unknown): string | null {
  if (item !== null && typeof item === 'object') {
    const step = (item as Record<string, unknown>).stepNumber;
    if (field === 'narrative' && typeof step === 'number') return `step ${step}`;
  }
  return identityKeyOf(field, item);
}

/**
 * Every difference between the stored spec and the one a write would persist,
 * as addressed paths. Arrays whose elements carry an identity are matched by
 * it, so a reordered list is not reported as a rewrite; everything else is
 * compared as a value.
 */
export function specChanges(before: unknown, after: unknown, prefix = ''): SpecChange[] {
  const at = (key: string): string => (prefix ? `${prefix}.${key}` : key);
  const isPlain = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  if (Array.isArray(before) && Array.isArray(after)) {
    if (after.length === 0 && before.length > 0) {
      return [{ path: prefix, change: 'cleared', before: summarizeValue(before) }];
    }
    // A narrative is compared by step identity, never by position: an insert
    // renumbers every later step, which is not a rewrite of every later step.
    if ((prefix.split('.').pop() ?? prefix) === 'narrative'
      && [...before, ...after].every(i => i !== null && typeof i === 'object' && !Array.isArray(i))) {
      return narrativeChanges(before as Rec[], after as Rec[], prefix);
    }
    const field = prefix.split('.').pop() ?? prefix;
    // A list of plain values (a requirement written as text or as its
    // description alike) is compared value by value: a mixed edit reads as the
    // values it added and removed, never as the whole list "set" and truncated.
    const plainKeys = (list: unknown[]): (string | null)[] => list.map((v) => plainReportKey(field, v));
    const beforePlain = plainKeys(before);
    const afterPlain = plainKeys(after);
    if ([...beforePlain, ...afterPlain].every((k) => k !== null) && (before.length > 0 || after.length > 0)) {
      if (JSON.stringify(before) === JSON.stringify(after)) return [];
      const changes: SpecChange[] = [];
      before.forEach((item, i) => {
        if (!afterPlain.includes(beforePlain[i])) changes.push({ path: prefix, change: 'removed', before: summarizeValue(item) });
      });
      after.forEach((item, i) => {
        if (!beforePlain.includes(afterPlain[i])) changes.push({ path: prefix, change: 'added', after: summarizeValue(item) });
      });
      changes.push(...reorderOf(prefix, beforePlain as string[], afterPlain as string[]));
      // The same values in the same order, written in another form (text and { description }).
      if (changes.length === 0) changes.push({ path: prefix, change: 'set', before: summarizeValue(before), after: summarizeValue(after) });
      return changes;
    }
    const identified = [...before, ...after].every(i => reportIdentityOf(field, i) !== null);
    if (!identified) {
      return JSON.stringify(before) === JSON.stringify(after)
        ? []
        : [{ path: prefix, change: 'set', before: summarizeValue(before), after: summarizeValue(after) }];
    }
    const keyOf = (i: unknown): string => String(reportIdentityOf(field, i));
    const changes: SpecChange[] = [];
    for (const item of before) {
      const match = after.find(a => keyOf(a) === keyOf(item));
      if (match === undefined) changes.push({ path: at(keyOf(item)), change: 'removed', before: summarizeValue(item) });
      else changes.push(...specChanges(item, match, at(keyOf(item))));
    }
    for (const item of after) {
      if (!before.some(b => keyOf(b) === keyOf(item))) {
        changes.push({ path: at(keyOf(item)), change: 'added', after: summarizeValue(item) });
      }
    }
    // Matched by identity, a moved element is not a rewrite — but the move
    // itself is an edit, and is said once for the list.
    if (field !== 'narrative') changes.push(...reorderOf(prefix, before.map(keyOf), after.map(keyOf)));
    return changes;
  }

  if (isPlain(before) && isPlain(after)) {
    const changes: SpecChange[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const b = before[key];
      const a = after[key];
      if (b === undefined && a !== undefined) changes.push({ path: at(key), change: 'added', after: summarizeValue(a) });
      else if (b !== undefined && a === undefined) changes.push({ path: at(key), change: 'removed', before: summarizeValue(b) });
      else changes.push(...specChanges(b, a, at(key)));
    }
    return changes;
  }

  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  // Two long texts are shown from just before where they differ: cut at the
  // same 120 characters from the start, an edit late in a description read as
  // two identical summaries.
  if (typeof before === 'string' && typeof after === 'string') {
    const [b, a] = differingWindow(before, after);
    return [{ path: prefix, change: 'set', before: summarizeValue(b), after: summarizeValue(a) }];
  }
  return [{ path: prefix, change: 'set', before: summarizeValue(before), after: summarizeValue(after) }];
}

/** The identity a change report compares a plain-value list by: the value as text, a requirement object by its description. */
function plainReportKey(field: string, value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (field === 'globalRequirements' && value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).description === 'string') {
    return (value as Record<string, unknown>).description as string;
  }
  return null;
}

/** A `reordered` change when the elements both lists hold appear in another order; none otherwise. */
function reorderOf(path: string, before: string[], after: string[]): SpecChange[] {
  const kept = before.filter((k) => after.includes(k));
  const keptAfter = after.filter((k) => before.includes(k));
  if (kept.length < 2 || kept.every((k, i) => k === keptAfter[i])) return [];
  return [{ path, change: 'reordered', before: summarizeValue(kept), after: summarizeValue(keptAfter) }];
}

/** Two texts from shortly before their first difference, each marked as cut when it is. */
function differingWindow(before: string, after: string): [string, string] {
  if (before.length <= 120 && after.length <= 120) return [before, after];
  let at = 0;
  while (at < before.length && at < after.length && before[at] === after[at]) at++;
  const start = Math.max(0, at - 40);
  return start === 0 ? [before, after] : [`...${before.slice(start)}`, `...${after.slice(start)}`];
}

// ---------------------------------------------------------------------------
// Narrative changes by step IDENTITY.
//
// A narrative is numbered by position, so one inserted step renumbers every
// step after it and shifts every jump that points past it. Compared by number,
// inserting one step into a 97-step narrative read as 124 changes — each later
// step "set" to its predecessor's description, type and target — which buried
// the one line that mattered and made a real accidental rewrite impossible to
// spot beside it. Steps are matched by what they ARE instead: first by their
// content with every number left out, then (between those anchors) by the same
// description, label or call target, and a same-sized leftover run position by
// position — an edit in place. What is left over was added or removed.
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

/** The numeric jump fields a step can set directly. */
const STEP_JUMP_FIELDS = ['onTrueStep', 'onFalseStep', 'defaultStep', 'endStep', 'finallyStep', 'toStep'] as const;
/** The lists whose entries each carry a jump `step`, with the field that names an entry. */
const STEP_JUMP_LISTS = [['cases', 'value'], ['catches', 'error'], ['branches', 'name']] as const;

/** Every jump a step sets, keyed by the dotted field it sits in. */
function jumpsOf(step: Rec): Map<string, number> {
  const jumps = new Map<string, number>();
  for (const field of STEP_JUMP_FIELDS) {
    if (typeof step[field] === 'number') jumps.set(field, step[field] as number);
  }
  for (const [list, name] of STEP_JUMP_LISTS) {
    const entries = step[list];
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry: Rec, i) => {
      if (entry && typeof entry.step === 'number') jumps.set(`${list}.${String(entry[name] ?? i)}.step`, entry.step);
    });
  }
  return jumps;
}

/** A step with its own number and every jump number left out: what it says, not where it sits. */
function withoutNumbers(step: Rec): Rec {
  const out: Rec = { ...step };
  delete out.stepNumber;
  for (const field of STEP_JUMP_FIELDS) delete out[field];
  for (const [list] of STEP_JUMP_LISTS) {
    if (Array.isArray(out[list])) {
      out[list] = (out[list] as Rec[]).map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const { step: _step, ...rest } = entry;
        return rest;
      });
    }
  }
  return out;
}

/** A value serialized with sorted keys, so two equal steps compare equal whatever order they were written in. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Rec)[k]]))
    : v));
}

/** Monotonic index pairs of a longest common subsequence under `same`. */
function commonRun<A, B>(a: A[], b: B[], same: (x: A, y: B) => boolean): [number, number][] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] = same(a[i], b[j])
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (same(a[i], b[j])) { pairs.push([i, j]); i++; j++; }
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Two steps that are recognisably the same step, one of them edited: same description, label or call target. */
function recognisablySame(a: Rec, b: Rec): boolean {
  if (typeof a.description === 'string' && a.description === b.description) return true;
  if (typeof a.label === 'string' && a.label === b.label) return true;
  return typeof a.targetComponent === 'string' && a.type === b.type
    && a.targetComponent === b.targetComponent && a.targetMethod === b.targetMethod;
}

/**
 * Pair the steps of two narratives by identity: exact content first, then
 * recognisably-same steps between those anchors, then equal-sized leftover
 * runs position by position. Answers ascending (old index, new index) pairs.
 */
function pairSteps(before: Rec[], after: Rec[]): [number, number][] {
  const keysBefore = before.map((s) => canonicalJson(withoutNumbers(s)));
  const keysAfter = after.map((s) => canonicalJson(withoutNumbers(s)));
  const anchors = commonRun(keysBefore, keysAfter, (x, y) => x === y);
  const pairs: [number, number][] = [];
  // Each gap between two anchors (and before the first / after the last).
  const bounds: [number, number][] = [[-1, -1], ...anchors, [before.length, after.length]];
  for (let g = 0; g < bounds.length - 1; g++) {
    const [oi, ni] = bounds[g];
    const [oj, nj] = bounds[g + 1];
    const gapBefore = before.slice(oi + 1, oj).map((step, k) => ({ step, at: oi + 1 + k }));
    const gapAfter = after.slice(ni + 1, nj).map((step, k) => ({ step, at: ni + 1 + k }));
    const similar = commonRun(gapBefore, gapAfter, (x, y) => recognisablySame(x.step, y.step))
      .map(([x, y]) => [gapBefore[x].at, gapAfter[y].at] as [number, number]);
    // Between the similar pairs, a run left over on both sides at the same
    // length is an edit in place; any other leftover is an insert or delete.
    const inner: [number, number][] = [[oi, ni], ...similar, [oj, nj]];
    for (let k = 0; k < inner.length - 1; k++) {
      const [a0, b0] = inner[k];
      const [a1, b1] = inner[k + 1];
      if (a1 - a0 === b1 - b0) for (let d = 1; d < a1 - a0; d++) pairs.push([a0 + d, b0 + d]);
      if (k < inner.length - 2) pairs.push(inner[k + 1]);
    }
    if (g < bounds.length - 2) pairs.push(bounds[g + 1]);
  }
  return pairs.sort((x, y) => x[0] - y[0]);
}

/** A step's number, or its 1-based position when it carries none. */
function numberOf(step: Rec, index: number): number {
  return typeof step.stepNumber === 'number' ? step.stepNumber : index + 1;
}

/** Contiguous runs of numbers shifted by the same amount, as `steps a-b`. */
function renumberedRuns(moves: [number, number][]): { from: string; to: string }[] {
  const runs: { from: string; to: string }[] = [];
  const range = (a: number, b: number): string => (a === b ? `step ${a}` : `steps ${a}-${b}`);
  let start = 0;
  for (let k = 1; k <= moves.length; k++) {
    const continues = k < moves.length
      && moves[k][0] === moves[k - 1][0] + 1
      && moves[k][1] - moves[k][0] === moves[start][1] - moves[start][0];
    if (continues) continue;
    const [firstOld, firstNew] = moves[start];
    const [lastOld, lastNew] = moves[k - 1];
    runs.push({ from: range(firstOld, lastOld), to: range(firstNew, lastNew) });
    start = k;
  }
  return runs;
}

/**
 * Every change between two versions of one narrative, by step identity: steps
 * added and removed, each run of unchanged steps an insert or delete shifted
 * (`renumbered`), each jump that merely followed its target (`relocated`), and
 * the field changes of a step that was really edited.
 */
function narrativeChanges(before: Rec[], after: Rec[], prefix: string): SpecChange[] {
  const pairs = pairSteps(before, after);
  const oldToNew = new Map<number, number>();
  for (const [o, n] of pairs) oldToNew.set(numberOf(before[o], o), numberOf(after[n], n));
  const pairedOld = new Set(pairs.map(([o]) => o));
  const pairedNew = new Set(pairs.map(([, n]) => n));

  const removed: SpecChange[] = before.flatMap((step, o) => (pairedOld.has(o) ? [] : [{
    path: `${prefix}.step ${numberOf(step, o)}`, change: 'removed' as const, before: summarizeValue(step),
  }]));
  const added: SpecChange[] = after.flatMap((step, n) => (pairedNew.has(n) ? [] : [{
    path: `${prefix}.step ${numberOf(step, n)}`, change: 'added' as const, after: summarizeValue(step),
  }]));

  const edited: SpecChange[] = [];
  const relocated: SpecChange[] = [];
  const moves: [number, number][] = [];
  for (const [o, n] of pairs) {
    const oldNumber = numberOf(before[o], o);
    const newNumber = numberOf(after[n], n);
    const at = oldNumber === newNumber ? `${prefix}.step ${newNumber}` : `${prefix}.step ${newNumber} (was ${oldNumber})`;
    edited.push(...specChanges(withoutNumbers(before[o]), withoutNumbers(after[n]), at));
    const oldJumps = jumpsOf(before[o]);
    const newJumps = jumpsOf(after[n]);
    for (const field of new Set([...oldJumps.keys(), ...newJumps.keys()])) {
      const was = oldJumps.get(field);
      const now = newJumps.get(field);
      if (was === now) continue;
      if (was === undefined) edited.push({ path: `${at}.${field}`, change: 'added', after: String(now) });
      else if (now === undefined) edited.push({ path: `${at}.${field}`, change: 'removed', before: String(was) });
      else if (oldToNew.get(was) === now) relocated.push({ path: `${at}.${field}`, change: 'relocated', before: String(was), after: String(now) });
      else edited.push({ path: `${at}.${field}`, change: 'set', before: String(was), after: String(now) });
    }
    // A moved step that was also edited already reads as `step N (was M)`;
    // only the untouched ones make up the renumbered runs.
    if (oldNumber !== newNumber && !edited.some((c) => c.path.startsWith(`${at}.`))) moves.push([oldNumber, newNumber]);
  }
  const renumbered: SpecChange[] = renumberedRuns(moves).map(({ from, to }) => ({
    path: prefix, change: 'renumbered', before: from, after: to,
  }));
  return [...removed, ...added, ...edited, ...renumbered, ...relocated];
}

/**
 * The delta's own verbs, at every depth — addressing and instructions, never
 * content, so they are never judged as paths that "had no effect".
 */
const DELTA_VERBS = new Set(['action', 'remove', 'captureJumps']);

/**
 * A jump field's symbolic twin. It resolves into its numeric field during the
 * merge and is gone from the stored spec afterwards, which is an effect, not a
 * silent drop.
 */
const JUMP_LABEL_TWINS = new Set([
  'onTrueLabel', 'onFalseLabel', 'defaultLabel', 'endLabel', 'finallyLabel', 'toLabel',
]);

/** Array fields whose elements carry a `label` twin rather than a `label` field. */
const LABEL_TWIN_CONTAINERS = new Set(['cases', 'catches', 'branches']);

/**
 * The KEY NAMES an array field's elements are matched by — the same table
 * `identityKeyOf` reads values from. A delta restates them to ADDRESS an
 * element, so restating one unchanged is addressing, not a failed edit.
 */
function identityFieldsOf(field: string): string[] {
  switch (field) {
    case 'dispatch':           return ['capability'];
    // Bound: component + interface; not yet bound: type + details.
    // Re-exports and type exports: from + item + interface + as.
    case 'publicInterfaces':   return ['component', 'interface', 'type', 'details', 'from', 'typeDef', 'as'];
    case 'lifecycle':          return ['phase', 'component', 'method'];
    case 'emits':
    case 'subscribesTo':       return ['topic', 'event'];
    case 'trustedLinks':       return ['subsystem'];
    case 'allow':              return ['code', 'at'];
    case 'findings':           return ['code'];
    case 'invariants':
    case 'patterns':           return ['id'];
    case 'boundaries':         return ['name'];
    case 'globalRequirements': return ['description'];
    case 'databases':          return ['id', 'name'];
    case 'cases':              return ['value'];
    case 'catches':            return ['error'];
    case 'narrative':          return ['stepNumber'];
    default:                   return ['name', 'id'];
  }
}

/**
 * A delta with every null/undefined field removed from every object in it, at
 * every depth (array elements kept, each cleaned). Null and undefined mean "no
 * change" in a delta; removing them before the merge is what makes that true
 * below the top level too, where the element merge spreads the delta over the
 * stored element and a present-but-empty key would otherwise replace it.
 */
export function withoutAbsentFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAbsentFields);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (field === undefined || field === null) continue;
    out[key] = withoutAbsentFields(field);
  }
  return out;
}

/** Whether a delta element carries an insert/delete marker — its paths do not compare. */
function carriesEditMarker(item: unknown): boolean {
  if (item === null || typeof item !== 'object') return false;
  const o = item as Record<string, unknown>;
  return o.action !== undefined || o.remove !== undefined;
}

/**
 * Every path the delta named that the write did not act on.
 *
 * The delta arrives as a permissive record BY DESIGN — the shapes nest further
 * than any schema at the tool boundary should restate — so the top-level
 * unknown-key refusal cannot reach a typo one level down. `methods[0].descriptoin`
 * merges, is stripped by the level's schema on write, and is never mentioned:
 * the same silent drop, one depth lower. This names it instead.
 *
 * Judged against the spec the write would PERSIST and the one it replaced, both
 * read through the level's canonical schema, so a key the writer drops shows up
 * as missing and a value the stored spec already held shows up as already held.
 * Narrative arrays carrying an insert or delete are skipped whole: renumbering
 * moves every step, so a path through them proves nothing either way.
 */
export function ineffectiveDeltaPaths(
  delta: Record<string, unknown>,
  merged: Record<string, any>,
  stored: Record<string, any>,
  respellings?: ReadonlyArray<{ written: string; stored: string }>,
): string[] {
  const out: string[] = [];
  const isPlain = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const at = (prefix: string, key: string): string => (prefix ? `${prefix}.${key}` : key);
  const say = (path: string, why: string): void => { out.push(`${path} — ${why}`); };

  const walkValue = (d: unknown, m: unknown, s: unknown, path: string, field: string): void => {
    if (Array.isArray(d)) {
      if (!Array.isArray(m)) { say(path, 'the level does not have this field, so the write dropped it'); return; }
      // A narrative whose delta inserts or deletes renumbers everything after
      // the mutation point; no path through it can be compared honestly.
      if (field === 'narrative' && d.some(carriesEditMarker)) return;
      // A list of plain values merges value by value: each value named must be
      // in the written list, and one every value of which was held already
      // changed nothing.
      const plain = d.filter((x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean');
      if (plain.length > 0) {
        const text = (v: unknown): string => (v && typeof v === 'object' ? String((v as Record<string, unknown>).description ?? JSON.stringify(v)) : String(v));
        const holds = (list: unknown, x: unknown): boolean => Array.isArray(list) && list.some((y) => text(y) === String(x));
        // A list the write reordered was acted on: its values were held, their order was not.
        const order = (list: unknown): string[] => (Array.isArray(list) ? list.map(text) : []);
        if (plain.some((x) => !holds(m, x))) say(path, 'the level does not keep this value, so the write dropped it');
        else if (plain.every((x) => holds(s, x)) && d.every((x) => plain.includes(x)) && same(order(m), order(s))) say(path, 'the stored spec already held this value');
        if (d.every((x) => plain.includes(x) || carriesEditMarker(x))) return;
      }
      for (const element of d) {
        if (carriesEditMarker(element)) continue;      // its own refusals and notices cover it
        if (plain.includes(element)) continue;           // judged above, value by value
        const key = reportIdentityOf(field, element);
        if (key === null) {                             // no identity: compared as written
          if (!same(m, d)) say(path, 'the level does not keep this value, so the write dropped it');
          else if (same(s, d)) say(path, 'the stored spec already held this value');
          return;
        }
        const mMatch = (m as unknown[]).find(i => reportIdentityOf(field, i) === key);
        const sMatch = Array.isArray(s) ? s.find(i => reportIdentityOf(field, i) === key) : undefined;
        if (mMatch === undefined) { say(at(path, key), 'the write did not store this element'); continue; }
        walk(element as Record<string, unknown>, mMatch, sMatch, at(path, key), field);
      }
      return;
    }
    if (isPlain(d)) {
      if (!isPlain(m)) { say(path, 'the level does not have this field, so the write dropped it'); return; }
      walk(d, m, s, path, field);
      return;
    }
    // A type position the write respelled to its canonical form was stored, in that form.
    const respelled = typeof d === 'string' && typeof m === 'string'
      && (respellings ?? []).some((r) => r.written === d && r.stored === m);
    if (!same(m, d) && !respelled) say(path, 'the write did not store it — the level\'s schema does not keep this value');
    else if (same(s, d) || (respelled && same(s, m))) say(path, 'the stored spec already held this value');
  };

  function walk(d: Record<string, unknown>, m: unknown, s: unknown, path: string, container: string): void {
    for (const [key, value] of Object.entries(d)) {
      if (DELTA_VERBS.has(key) || JUMP_LABEL_TWINS.has(key)) continue;
      if (key === 'label' && LABEL_TWIN_CONTAINERS.has(container)) continue;
      if (identityFieldsOf(container).includes(key)) continue;   // addressing, not content
      // `unset` is a verb whose effect IS observable: the field it names must
      // have been there and must be gone.
      if (key === 'unset') {
        for (const name of Array.isArray(value) ? value : []) {
          if (typeof name !== 'string') continue;
          // A list the schema defaults comes back as [] once unset: that is the
          // removal, not a failure of it (and an empty list held nothing to remove).
          const present = (v: unknown): boolean => v !== undefined && !(Array.isArray(v) && v.length === 0);
          const had = isPlain(s) && present(s[name]);
          const still = isPlain(m) && present(m[name]);
          if (!had) say(at(path, name), 'unset named a field the stored spec did not have');
          else if (still) say(at(path, name), 'unset did not remove it');
        }
        continue;
      }
      // null/undefined mean "no change" by contract — never a failed edit.
      if (value === undefined || value === null) continue;
      const here = at(path, key);
      const mValue = isPlain(m) ? m[key] : undefined;
      const sValue = isPlain(s) ? s[key] : undefined;
      if (mValue === undefined) { say(here, 'the level does not have this field, so the write dropped it'); continue; }
      walkValue(value, mValue, sValue, here, key);
    }
  }

  walk(delta, merged, stored, '', '');
  return out;
}

// ---------------------------------------------------------------------------
// SpecWorkspace
// ---------------------------------------------------------------------------

export class SpecWorkspace {
  readonly rootDir: string;
  readonly paths: WaiPaths;

  private cachedIndex: SpecIndex | null = null;
  private cachedDepth: number | null = null;
  private cachedSpecDirs: string[] = [];
  private cachedSignature: string | null = null;
  private lastSignatureCheckMs = 0;
  private scanVisitedSpecDirs: string[] = [];
  private scanVisitedConfigFiles: string[] = [];
  private cachedConfigFiles: string[] = [];
  private cachedRoots: ScannedProjectRoot[] = [];
  private cachedRawRoots: RawRoot[] = [];
  private cachedReadables: ReadableProject[] = [];
  private cachedOwners: Map<string, string> | null = null;
  private carryIndex: Map<string, string[]> | null = null;
  /** Set while normalizeReferences writes: every reference in its canonical form, no authored text carried. */
  private carryDisabled = false;
  loaderIssues: ValidationIssue[] = [];

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    this.paths = aiPathsAt(this.rootDir);
  }

  /**
   * The next scan re-verifies the tree's file signature whatever the TTL says.
   * Called when the bound project root switches to this workspace: a caller that
   * just bound a root reads it as it is NOW, even if another process changed it
   * a moment after this workspace last looked.
   */
  expireFreshness(): void {
    this.lastSignatureCheckMs = 0;
  }

  invalidate(): void {
    this.cachedIndex = null;
    this.cachedDepth = null;
    this.cachedSpecDirs = [];
    this.cachedConfigFiles = [];
    this.cachedRoots = [];
    this.cachedRawRoots = [];
    this.cachedReadables = [];
    this.cachedOwners = null;
    this.carryIndex = null;
    this.cachedSignature = null;
    this.lastSignatureCheckMs = 0;
  }

  // -------------------------------------------------------------------------
  // Scanning
  // -------------------------------------------------------------------------

  scanAll(options?: SpecScanOptions): SpecIndex {
    const maxDepth = options?.memberDepth ?? Infinity;
    if (this.cachedIndex && this.cachedDepth === maxDepth) {
      // Cache hit — but the files may have been edited externally (hand edits,
      // another process) since we scanned. Re-verify via mtime signature at
      // most once per TTL.
      const now = Date.now();
      if (now - this.lastSignatureCheckMs <= SIGNATURE_TTL_MS) return this.cachedIndex;
      this.lastSignatureCheckMs = now;
      if (computeSpecTreeSignature(this.cachedSpecDirs, this.cachedConfigFiles) === this.cachedSignature) return this.cachedIndex;
      this.invalidate();
    }

    this.loaderIssues = [];
    this.cachedDepth = maxDepth;
    this.scanVisitedSpecDirs = [];
    this.scanVisitedConfigFiles = [];

    const scan = this.scanFamily(maxDepth);
    this.cachedIndex = scan.index;
    this.cachedRoots = scan.raws.map((raw) => raw.record);
    this.cachedReadables = scan.readables;
    this.cachedRawRoots = scan.raws;
    this.carryIndex = null;
    this.cachedOwners = null;
    this.cachedSpecDirs = this.scanVisitedSpecDirs;
    this.cachedConfigFiles = this.scanVisitedConfigFiles;
    this.cachedSignature = computeSpecTreeSignature(this.cachedSpecDirs, this.cachedConfigFiles);
    this.lastSignatureCheckMs = Date.now();
    return this.cachedIndex;
  }

  /**
   * The id a scan-time loader issue is anchored to: the refused spec's own id
   * when the file got far enough to carry one, else its name on disk (the
   * containing directory in the nested layout, where every file is `.index` /
   * `.interface`), keyed under its project exactly as the scan keys the spec
   * itself — so scoping a validate to a member keeps it.
   */
  private loaderIssueSpecId(file: string, rawId: string | undefined, key: string): string {
    const stem = path.basename(file, '.yaml');
    const local = rawId ?? (stem.startsWith('.') ? path.basename(path.dirname(file)) : stem);
    return keyIn(key, local);
  }

  /**
   * ispec_index.listProjectRoots, uncached — the scan without position.
   * Phase one reads every root (the bound root and each member it declares,
   * either form) and keys its declarations by project id; phase two resolves
   * every root's export tables through the pure export resolver, producers
   * first; phase three binds every reference with `::` through the referring
   * root's alias table. Nothing is folded into another root's namespace.
   */
  private scanFamily(maxDepth: number): { index: SpecIndex; raws: RawRoot[]; readables: ReadableProject[] } {
    // Steps 1-8: phase one, every root read and keyed, members followed.
    const raws: RawRoot[] = [];
    this.readRoot(this.rootDir, null, undefined, new Set([chainDirKey(this.rootDir)]), maxDepth, 0, raws, new Set());
    raws.forEach((raw) => this.keyRoot(raw));
    raws.forEach((raw) => this.bindAliases(raw, raws));
    const readables = raws.map((raw) => readableOf(raw));
    // Steps 9-11: phase two, every root's tables, producers before consumers.
    resolveFamilyTables(raws);
    // The text each params-bearing method's params derive as the file spells
    // them, read before step 18 respells them (step 23 compares against it).
    const writtenTexts = writtenSignatureTexts(raws);
    // Step 18: before any reference is bound, every root's type positions read
    // under the grammar — respelled in memory, the stored spellings kept as facts.
    const typeSpellings = canonicalizeRootTypes(raws);
    // Steps 12-13: phase three, every reference with `::` bound.
    raws.forEach((raw) => bindRootReferences(raw, raws, readables));
    // Steps 14-15: the index, every root's specs under their keys.
    const index = emptyIndex();
    for (const raw of raws) {
      index.subsystems.push(...raw.index.subsystems);
      index.components.push(...raw.index.components);
      index.interfaces.push(...raw.index.interfaces);
      index.implementations.push(...raw.index.implementations);
      index.types.push(...raw.index.types);
      index.groups.push(...raw.index.groups);
      for (const kind of Object.keys(index.paths) as (keyof SpecIndex['paths'])[]) Object.assign(index.paths[kind], raw.index.paths[kind]);
      index.retiredReach.push(...raw.index.retiredReach.map((fact) => ({ ...fact, specId: keyIn(raw.record.namespace, fact.specId) })));
    }
    // The retired reachability forms that need the whole family to read:
    // `external` on a Portal's contract is an entry, and a retired Custom
    // portalType whose Portal binds no endpoint at all is an in-process one.
    readRetiredReachAcrossSpecs(index);
    // Step 22: once every reference of the family is bound, its signatures —
    // sourced methods filled, every params-bearing method's text derived; the
    // facts kept on the index, the one place the stored form stays visible.
    // Every root's authored references go with them, so an `alias::` signature
    // type lands where the scan bound it, as every other type reference does.
    // Other projects' export entries a signatureFrom may name (`alias::name.method`):
    // each root's pinned externals and its contained members' live L0 entries.
    const signatures = resolveTree(index.interfaces, index.components, index.types, raws.flatMap((r) => r.record.authoredReferences), exportMethodsOf(raws));
    index.interfaces = signatures.interfaces;
    index.types = signatures.types;
    // Step 23: a stored text stale only because its params are stored in alias
    // spellings is the type-spelling facts' to report, not a second finding.
    index.signatures = {
      ...signatures.facts,
      staleTexts: signatures.facts.staleTexts.filter((stale) => writtenTexts.get(`${stale.kind}|${stale.specId}|${stale.method}`) !== stale.stored),
    };
    index.typeSpellings = typeSpellings;
    return { index, raws, readables };
  }

  /**
   * Phase one at one root: record it, key it, read its configuration, its L0,
   * its member declarations and every spec document as written, then follow
   * each member it declares (containment decided against THIS root).
   */
  private readRoot(
    dir: string,
    parent: RawRoot | null,
    member: MemberDeclarationRead | undefined,
    ancestors: ReadonlySet<string>,
    maxDepth: number,
    depth: number,
    raws: RawRoot[],
    taken: Set<string>,
  ): void {
    // Step 2: the root's configuration, through its own binding.
    const config = configAt(dir);
    this.scanVisitedConfigFiles.push(aiPathsAt(dir).projectConfig());
    // The bound root's configuration keys its schema does not know: the parse
    // drops them, so a misspelt setting (`requireCod`) would silently do nothing.
    if (!parent && config) this.reportUnknownConfigKeys(aiPathsAt(dir).projectConfig(), rawConfigAt(dir), config);
    const id = config ? effectiveProjectId(config) : null;
    // Step 5: the key — '' for the bound root, else the effective id unless a
    // member already holds it, then the alias path.
    const aliasPath = parent && member ? keyIn(parent.aliasPath, member.alias) : '';
    const key = !parent ? '' : (id && !taken.has(id) ? id : aliasPath);
    if (key) taken.add(key);
    if (!parent && id) taken.add(id);
    const record: ScannedProjectRoot = {
      namespace: key,
      ...(parent ? { parent: parent.record.namespace } : {}),
      ...(member ? { mountAlias: member.alias, mountForm: member.form } : {}),
      legacyMount: member?.legacyMount ?? null,
      ...(member?.description !== undefined ? { memberDescription: member.description } : {}),
      directory: path.resolve(dir),
      system: null,
      config,
      aliases: new Map(),
      exports: emptyExportTable(key, 'project'),
      subsystemExports: new Map(),
      specIds: [],
      authoredReferences: [],
      problems: [],
      parts: [],
      referenced: [],
    };
    const raw: RawRoot = {
      record, aliasPath, dir: path.resolve(dir), index: emptyIndex(), mounts: [], members: [],
      memberKeys: new Map(), rawSystem: null, localSubsystems: new Set(), pending: [], pendingImports: [],
    };
    raws.push(raw);
    // Step 4: every spec document as written, and the root's own L0.
    this.readRootSpecs(raw);
    // Step 3: the member declarations — `members`, then legacy mounts.
    raw.members = memberDeclarationsOf(config, raw.mounts);
    // Steps 6-11 (stage 8): what each member is, from its content; each part
    // read into THIS root before anything is keyed or bound — its specs are
    // the root's own, at every depth bound.
    for (const decl of raw.members) this.readMemberKind(raw, decl);
    if (depth >= maxDepth) return;
    // Steps 13-14: follow each project member stored in reach — contained, or
    // a `../` sibling checkout, which composes exactly as a contained one (a
    // part is the root's own; a git or hosted project member is referenced,
    // judged against its pin).
    for (const decl of raw.members) {
      if (decl.kind === 'part' || !followsLive(decl)) continue;
      // One the scan could not open (a hosted instance never reads a `../` source) stays referenced, unavailable.
      if (raw.record.referenced.some((r) => r.alias === decl.alias)) continue;
      const childDir = this.followableMember(raw, decl, ancestors);
      if (!childDir) continue;
      const before = raws.length;
      this.readRoot(childDir, raw, decl, new Set([...ancestors, chainDirKey(childDir)]), maxDepth, depth + 1, raws, taken);
      raw.memberKeys.set(decl.alias, raws[before].record.namespace);
    }
  }

  /**
   * Whether a member can be followed, recording why not: a declaration with a
   * problem, an escaping path, a directory already on the walk, a missing one.
   * Every loader issue carries the member's key.
   */
  private followableMember(raw: RawRoot, decl: MemberDeclarationRead, ancestors: ReadonlySet<string>): string | null {
    const memberKey = keyIn(raw.record.namespace, decl.alias);
    const by = decl.form === 'mount' ? 'subsystem' : 'member';
    const absolute = path.isAbsolute(decl.path) || path.win32.isAbsolute(decl.path);
    if (decl.problem && !absolute) {
      if (decl.problem.includes('`externals`')) {
        raw.record.problems.push({ kind: 'alias-conflict', id: decl.alias, projects: [raw.record.namespace], detail: decl.problem });
      }
      return null;
    }
    const childDir = path.resolve(raw.dir, decl.path);
    // A `../` sibling leaves the root by its declaration: only a contained path is held to it.
    if (decl.storage !== 'path' && projectPathEscapesRoot(raw.dir, decl.path, childDir)) {
      this.loaderIssues.push({
        severity: 'error',
        code: 'PROJECTPATH_ESCAPE',
        message: `Subproject path "${decl.path}" declared by ${by} "${memberKey}" escapes the root of the project declaring it, "${raw.dir}" (resolves to "${childDir}"); absolute, ../-escaping and link-escaping paths are rejected. Skipping this subproject.`,
        specId: memberKey,
      });
      return null;
    }
    if (ancestors.has(chainDirKey(childDir))) {
      this.loaderIssues.push({
        severity: 'error',
        code: 'CIRCULAR_SUBPROJECT_REFERENCE',
        message: `Circular reference detected: ${by === 'subsystem' ? 'Subsystem' : 'Member'} "${memberKey}" refers to subproject "${childDir}" which is already loaded.`,
        specId: memberKey,
      });
      return null;
    }
    if (!fs.existsSync(childDir)) {
      // No loader issue (stage 4 retires SUBPROJECT_NOT_FOUND): a family run
      // reports the absent member, and the declaring project's own gate reports
      // its references into it as unavailable.
      raw.record.problems.push({
        kind: 'member-absent',
        id: decl.alias,
        projects: [raw.record.namespace],
        detail: `the member "${decl.alias}" declared at "${decl.path}" has no directory there`,
      });
      return null;
    }
    return childDir;
  }

  /** Read every spec document of one root as written; a legacy mount is a declaration, never a subsystem. */
  private readRootSpecs(raw: RawRoot): void {
    const projectPaths = aiPathsAt(raw.dir);
    const systemYaml = path.normalize(projectPaths.specsSystem());
    if (pathExists(systemYaml)) {
      try {
        const doc = readSpecFile(systemYaml);
        if (doc && typeof doc === 'object') raw.index.retiredReach.push(...readRetiredReachForms('system', doc as Record<string, unknown>));
        raw.rawSystem = SystemSpecSchema.parse(doc);
        this.reportUnknownKeys(systemYaml, 'system', doc, raw.rawSystem, keyIn(raw.record.namespace, 'system'));
      } catch {
        raw.rawSystem = null; // the bound root's L0 is reported by the loader's own read
      }
    }
    this.readSpecDocuments(raw, projectPaths.specsDir(), systemYaml, raw.dir);
  }

  // -------------------------------------------------------------------------
  // Stage 8: what a member is, and reading a part into its parent
  // -------------------------------------------------------------------------

  /** A family problem the scan met at this root about one of its members. */
  private memberProblem(raw: RawRoot, kind: 'part-unavailable' | 'kind-mismatch', alias: string, detail: string): void {
    raw.record.problems.push({ kind, id: alias, projects: [raw.record.namespace], detail });
  }

  /**
   * Step 6 at one member: decide what it is FROM ITS CONTENT — its root
   * declaring an id, holding an L0 or carrying a lock makes it a project,
   * anything else a part; a hosted source is a project — and read each part
   * into the root (steps 7-11). An asserted `as` the content contradicts is a
   * kind-mismatch, and the content still decides. A contained member whose
   * directory is absent, escapes or loops is left undecided: following it
   * reports why, exactly as before stage 8.
   */
  private readMemberKind(raw: RawRoot, decl: MemberDeclarationRead): void {
    if (decl.form === 'mount') return;
    const asserted = decl.as;
    if (decl.problem) {
      this.reportDeclarationProblem(raw, decl);
      return;
    }
    if (decl.storage === 'hosted') {
      decl.kind = 'project';
      return;
    }
    const located = this.memberRoot(raw, decl);
    if (located === null) return;
    if ('unavailable' in located) {
      // An uncached project member falls back to its pin (stage 8): asserted, or pinned as a member.
      if (asserted === 'project' || pinnedAsMember(raw.dir, decl.alias)) {
        decl.kind = 'project';
        raw.record.referenced.push({ alias: decl.alias, storage: decl.storage, partOf: null, subsystems: [], specIds: [], availability: 'unavailable', reason: located.unavailable });
        return;
      }
      decl.kind = 'part';
      this.memberProblem(raw, 'part-unavailable', decl.alias, located.unavailable);
      raw.record.parts.push({ alias: decl.alias, storage: decl.storage, partOf: null, subsystems: [], specIds: [], availability: 'unavailable', reason: located.unavailable });
      return;
    }
    const kind = projectContentAt(located.dir) ? 'project' : 'part';
    decl.kind = kind;
    if (asserted !== undefined && asserted !== kind) {
      this.memberProblem(raw, 'kind-mismatch', decl.alias, `the member "${decl.alias}" is asserted \`as: ${asserted}\`, but its content makes it a ${kind}: ${kind === 'project'
        ? 'its tree declares an id, holds an L0 or carries a lock — drop the `as`, or remove that content with `wairon member demote`'
        : 'its tree declares no id, holds no L0 and carries no lock — drop the `as`, or create the project content with `wairon member promote`'}`);
    }
    if (kind === 'part') this.readPart(raw, decl, located.dir, located.commit);
    else if (!followsLive(decl)) this.recordReferenced(raw, decl, located.dir, located.commit);
  }

  /**
   * A referenced project member (stage 8): where its root is — the sibling
   * checkout or the fetch cache at its pinned commit — for the family run and
   * the externals plane to open; nothing of it is read into this root.
   */
  private recordReferenced(raw: RawRoot, decl: MemberDeclarationRead, dir: string, commit: string | undefined): void {
    const provenance = commit ?? (decl.storage === 'path' ? headAcross(raw.dir, dir) : undefined);
    raw.record.referenced.push({
      alias: decl.alias, storage: decl.storage, directory: dir, ...(provenance ? { commit: provenance } : {}),
      partOf: null, subsystems: [], specIds: [], availability: decl.storage === 'git' ? 'cache' : 'live',
    });
  }

  /**
   * Where a member's root is on disk: the contained directory (undecided —
   * null — when it escapes or is absent, so following it reports why), the
   * `../` sibling directory, or a git member's pinned commit materialized in
   * the fetch cache — or why it cannot be read.
   */
  private memberRoot(raw: RawRoot, decl: MemberDeclarationRead): { dir: string; commit?: string } | { unavailable: string } | null {
    // A hosted project's roots are isolated (stage 8): it reaches another root
    // only by a `hosted:` source, so a `../` or git source is never read there.
    if ((decl.storage === 'git' || decl.storage === 'path') && getHostedLookup() !== null) {
      return { unavailable: `the member "${decl.alias}" is declared with a ${decl.storage === 'git' ? 'git' : '`../` sibling'} source, which a hosted instance does not read: a hosted project reaches another root only by a \`hosted:\` source` };
    }
    if (decl.storage === 'git') {
      const url = decl.source?.git ?? '';
      const commit = decl.source?.commit;
      if (!commit) return { unavailable: `the git part "${decl.alias}" (${url}) has no pinned commit` };
      try {
        // Step 9: the pinned commit in the fetch cache — a cached commit needs no network.
        return { dir: gitSource.fetch(url, commit, decl.source?.dir), commit };
      } catch (e) {
        return { unavailable: `the git part "${decl.alias}" (${url} at ${commit}) cannot be read: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    const dir = path.resolve(raw.dir, decl.path);
    if (decl.storage === 'path') {
      return fs.existsSync(dir) ? { dir } : { unavailable: `the part "${decl.alias}" declared at "${decl.path}" has no directory there (${dir})` };
    }
    // Contained: the containment guard, lexically and through links.
    if (projectPathEscapesRoot(raw.dir, decl.path, dir)) return null;
    if (!fs.existsSync(dir)) {
      return decl.as === 'part' ? { unavailable: `the part "${decl.alias}" declared at "${decl.path}" has no directory there` } : null;
    }
    return { dir };
  }

  /**
   * A member declaration the location grammar rejects or that contradicts
   * itself: an inner `..` is refused as an escape; a hosted part or a bad
   * `as` is a kind-mismatch; a declaration nothing can read is a part that is
   * unavailable, unless it asserts a project — never silently passed over. An
   * alias conflict and an absolute path are reported when it is followed.
   */
  private reportDeclarationProblem(raw: RawRoot, decl: MemberDeclarationRead): void {
    const problem = decl.problem!;
    const memberKey = keyIn(raw.record.namespace, decl.alias);
    if (problem.includes('inner `..`')) {
      this.loaderIssues.push({
        severity: 'error',
        code: 'PROJECTPATH_ESCAPE',
        message: `Member "${memberKey}": ${problem.replace(/^the member "[^"]*": /, '')}; skipping it.`,
        specId: memberKey,
      });
      return;
    }
    if (/asserts `as: |hosted record asserted/.test(problem)) {
      this.memberProblem(raw, 'kind-mismatch', decl.alias, problem);
      return;
    }
    if (problem.includes('`externals`') || problem.includes('`use`') || problem.includes('breaks [a-z0-9-_]+') || decl.as === 'project') return;
    if (decl.storage === 'contained' && problem.includes('absolute path')) return; // refused as an escape when followed
    decl.kind = 'part';
    this.memberProblem(raw, 'part-unavailable', decl.alias, problem);
    raw.record.parts.push({ alias: decl.alias, storage: decl.storage === 'hosted' ? 'contained' : decl.storage, partOf: null, subsystems: [], specIds: [], availability: 'unavailable', reason: problem });
  }

  /**
   * Steps 10-11 for one part: judge what its configuration says (a contained
   * part needs none; a non-contained one must name this root as its partOf;
   * neither may declare project fields), refuse a `use` on it, read every spec
   * document it holds into THIS root's index — keyed exactly as the root's
   * own, a key the root or another part already declares a duplicate-spec —
   * and record the ScannedPart with its content digest.
   */
  private readPart(raw: RawRoot, decl: MemberDeclarationRead, dir: string, commit: string | undefined): void {
    const paths = aiPathsAt(dir);
    this.scanVisitedConfigFiles.push(paths.projectConfig());
    const config = configAt(dir);
    const partOf = config?.partOf ?? null;
    this.judgePartConfiguration(raw, decl, dir, partOf, rawConfigAt(dir));
    if (decl.use.length > 0) {
      this.memberProblem(raw, 'kind-mismatch', decl.alias, `the member "${decl.alias}" is a part, and its \`use\` imports nothing: a part's names are already this project's own — drop the \`use\``);
    }
    const files = this.readSpecDocuments(raw, paths.specsDir(), null, dir);
    const provenance = commit ?? (decl.storage === 'path' ? headAcross(raw.dir, dir) : undefined);
    raw.record.parts.push({
      alias: decl.alias,
      storage: decl.storage,
      directory: dir,
      ...(provenance ? { commit: provenance } : {}),
      partOf,
      subsystems: [],
      specIds: [],
      contentDigest: contentDigestOf(dir, files),
      availability: decl.storage === 'git' ? 'cache' : 'live',
    });
  }

  /** Whether a part's configuration says what the part is and nothing a project says. */
  private judgePartConfiguration(raw: RawRoot, decl: MemberDeclarationRead, dir: string, partOf: PartOf | null, document: Record<string, unknown> | null): void {
    const fields = document ? PART_FORBIDDEN_FIELDS.filter((f) => document[f] !== undefined) : [];
    if (fields.length > 0) {
      this.memberProblem(raw, 'kind-mismatch', decl.alias, `the part "${decl.alias}" declares ${fields.map((f) => `\`${f}\``).join(', ')} without the id that would make it a project ${whereToEdit(decl, dir)} — add the id (\`wairon member promote ${decl.alias}\`), or move those fields to this project's configuration: a part is governed by its parent's`);
    }
    const ownId = idOf(raw);
    if (decl.storage === 'contained') {
      if (partOf !== null) {
        this.memberProblem(raw, 'kind-mismatch', decl.alias, `the contained part "${decl.alias}" declares \`partOf\` ${whereToEdit(decl, dir)}, which only a part stored outside its parent needs — delete that configuration: its parent finds it`);
      }
      return;
    }
    if (partOf === null) {
      this.memberProblem(raw, 'kind-mismatch', decl.alias, missingPartOfDetail(decl, dir, ownId));
    } else if (ownId !== undefined && partOf.project !== ownId) {
      this.memberProblem(raw, 'kind-mismatch', decl.alias, `the part "${decl.alias}" says it is a part of "${partOf.project}", but "${ownId}" declares it — correct \`partOf.project\` to "${ownId}" ${whereToEdit(decl, dir)}`);
    }
  }

  /**
   * A spec file's keys its schema does not know — which the parse drops, so
   * they would mean nothing without a word — reported as UNKNOWN_SPEC_KEY,
   * once per file. A retired reachability form is read compatibly and
   * reported by its own rule, so a component's `mounts` is no unknown key.
   */
  private reportUnknownKeys(file: string, kind: string, doc: unknown, parsed: unknown, specId: string): void {
    const unknown: string[] = [];
    unknownKeysIn(doc, parsed, '', unknown);
    const keys = unknown.map((entry) => entry.slice(0, entry.indexOf(':')))
      .filter((key) => !(kind === 'component' && key.startsWith('mounts')) && !TOLERATED_KEYS.has(key));
    if (keys.length === 0) return;
    const hint = keys.map((key) => UNKNOWN_KEY_HINTS[`${kind}.${key}`]).filter(Boolean);
    this.loaderIssues.push({
      severity: 'warning',
      code: 'UNKNOWN_SPEC_KEY',
      message: `Spec file "${file}" holds ${keys.length === 1 ? 'a key' : 'keys'} its ${kind} schema does not know, which ${keys.length === 1 ? 'is' : 'are'} ignored: ${keys.join(', ')}. `
        + `${hint.length ? `${hint.join(' ')} ` : ''}Remove ${keys.length === 1 ? 'it' : 'them'}, or move what ${keys.length === 1 ? 'it means' : 'they mean'} into a field the schema has — a spec edited through the sdd_* tools never holds one.`,
      specId,
    });
  }

  /**
   * The bound root's .wai/project.yaml keys its schema does not know, reported
   * as UNKNOWN_CONFIG_KEY (a warning): the configuration's parse drops them, so
   * a misspelt setting would otherwise silently configure nothing.
   */
  private reportUnknownConfigKeys(file: string, raw: Record<string, unknown> | null, config: ProjectConfig): void {
    if (!raw) return;
    const unknown: string[] = [];
    unknownKeysIn(raw, config, '', unknown);
    const keys = unknown.map((entry) => entry.slice(0, entry.indexOf(':')));
    if (keys.length === 0) return;
    this.loaderIssues.push({
      severity: 'warning',
      code: 'UNKNOWN_CONFIG_KEY',
      message: `"${file}" holds ${keys.length === 1 ? 'a setting' : 'settings'} wairon does not know, which ${keys.length === 1 ? 'is' : 'are'} ignored: ${keys.join(', ')}. `
        + 'Check the spelling against docs/cli.md (configuration) — a misspelt setting configures nothing.',
    });
  }

  /**
   * Read every spec document under a specs directory into a root's index, as
   * written: the root's own (`systemYaml` is its L0, skipped here) or a part's
   * (stage 8). Each implementation's file paths are re-expressed from
   * `baseDir` — the folder holding them — against the root. Answers the files
   * read, for a part's content digest.
   */
  private readSpecDocuments(raw: RawRoot, specsDir: string, systemYaml: string | null, baseDir: string): string[] {
    const key = raw.record.namespace;
    // Track every visited specs dir (even absent ones, so their later creation
    // is picked up) for the freshness signature.
    this.scanVisitedSpecDirs.push(specsDir);
    if (!pathExists(specsDir)) return [];
    const index = raw.index;
    // The first declaration of a key in one root stays; a second is a duplicate.
    const keep = <T extends { id: string }>(kind: keyof SpecIndex['paths'], list: T[], spec: T, file: string): void => {
      const first = index.paths[kind][spec.id];
      if (first !== undefined) {
        raw.record.problems.push({
          kind: 'duplicate-spec',
          id: keyIn(key, spec.id),
          projects: [key],
          detail: `"${spec.id}" is declared by two ${kind} files of one project: "${first}" and "${file}"`,
        });
        return;
      }
      list.push(spec);
      index.paths[kind][spec.id] = file;
    };
    const files: string[] = [];
    for (const file of listSpecFiles(specsDir)) {
      if (systemYaml !== null && path.normalize(file) === systemYaml) continue;
      files.push(file);
      let detectedType = 'spec';
      // The refused spec's own id, once the file got far enough to have one.
      let rawId: string | undefined;
      try {
        const doc = readSpecFile(file);
        if (doc === null || typeof doc !== 'object') {
          this.loaderIssues.push({
            severity: 'error',
            code: 'INVALID_YAML',
            message: `Spec file "${file}" is not a valid YAML object or is empty.`,
            specId: this.loaderIssueSpecId(file, undefined, key),
          });
          continue;
        }
        const idField = (doc as { id?: unknown }).id;
        if (typeof idField === 'string' && idField) rawId = idField;
        if ('parentSystem' in doc) {
          detectedType = 'subsystem';
          const parsed = SubsystemSpecSchema.parse(doc);
          this.reportUnknownKeys(file, 'subsystem', doc, parsed, keyIn(key, parsed.id));
          if (!(parsed.projectPath && parsed.projectPath.trim() !== '')) {
            index.retiredReach.push(...readRetiredReachForms('subsystem', doc as Record<string, unknown>));
          }
          if (parsed.projectPath && parsed.projectPath.trim() !== '') raw.mounts.push({ spec: parsed, file });
          else keep('subsystem', index.subsystems, parsed, file);
        } else if ('componentType' in doc) {
          detectedType = 'component';
          // Retired reachability forms are read compatibly and kept as facts;
          // a listener's mounts stay read (untyped) on the loaded spec.
          const facts = readRetiredReachForms('component', doc as Record<string, unknown>);
          const parsed = attachRetiredMounts(ComponentSpecSchema.parse(doc), doc as Record<string, unknown>);
          this.reportUnknownKeys(file, 'component', doc, parsed, keyIn(key, parsed.id));
          index.retiredReach.push(...facts);
          keep('component', index.components, parsed, file);
        } else if ('component' in doc) {
          detectedType = 'interface';
          // A retired invokedBy kind reads as runtime here; the scan re-reads
          // `external` as an entry once it knows the contract is a Portal's.
          const facts = readRetiredReachForms('interface', doc as Record<string, unknown>);
          const parsed = InterfaceSpecSchema.parse(doc);
          this.reportUnknownKeys(file, 'interface', doc, parsed, keyIn(key, parsed.id));
          index.retiredReach.push(...facts);
          keep('interface', index.interfaces, parsed, file);
        } else if ('contract' in doc) {
          detectedType = 'implementation';
          const parsed = ImplementationSpecSchema.parse(doc);
          this.reportUnknownKeys(file, 'implementation', doc, parsed, keyIn(key, parsed.id));
          // Every source file the implementation names, its own and each
          // method's, is normalized against the root of the project holding it.
          const normalizeSourcePath = (p: string): string =>
            path.relative(raw.dir, path.resolve(baseDir, p)).replace(/\\/g, '/');
          if (parsed.sourcePath) parsed.sourcePath = normalizeSourcePath(parsed.sourcePath);
          for (const method of parsed.methods) {
            if (method.sourcePath) method.sourcePath = normalizeSourcePath(method.sourcePath);
          }
          // A part's simulation harness is named from the part's root too.
          if (baseDir !== raw.dir && parsed.simPath) parsed.simPath = normalizeSourcePath(parsed.simPath);
          // And its binding modules, named like its source files.
          if (parsed.bindings) parsed.bindings = parsed.bindings.map(normalizeSourcePath);
          keep('implementation', index.implementations, parsed, file);
        } else if ('kind' in doc) {
          if ((doc as { kind?: unknown }).kind === 'group') {
            detectedType = 'group';
            keep('group', index.groups, GroupSpecSchema.parse(doc), file);
          } else {
            detectedType = 'type';
            const parsed = TypeSpecSchema.parse(doc);
            this.reportUnknownKeys(file, 'type', doc, parsed, keyIn(key, parsed.id));
            // A part's type names its files from the part's root, as its
            // implementations do: normalized against the project holding it.
            if (baseDir !== raw.dir) {
              const normalizeSourcePath = (p: string): string =>
                (path.isAbsolute(p) ? p : path.relative(raw.dir, path.resolve(baseDir, p)).split(path.sep).join('/'));
              if (parsed.sourcePath) parsed.sourcePath = normalizeSourcePath(parsed.sourcePath);
              for (const method of parsed.methods ?? []) {
                if (method.sourcePath) method.sourcePath = normalizeSourcePath(method.sourcePath);
              }
            }
            keep('type', index.types, parsed, file);
          }
        }
        if (detectedType === 'spec') {
          this.loaderIssues.push({
            severity: 'error',
            code: 'UNKNOWN_SPEC_TYPE',
            message: `Spec file "${file}" does not match any recognized L1-L4 schema structure.`,
            specId: this.loaderIssueSpecId(file, rawId, key),
          });
        }
      } catch (e: any) {
        this.loaderIssues.push({
          severity: 'error',
          code: 'SCHEMA_VALIDATION_ERROR',
          // A schema refusal reads as `path: message` per issue, never zod's JSON dump.
          message: `Failed to parse ${detectedType} spec "${file}": ${e instanceof z.ZodError ? formatZodIssues(e) : e.message || String(e)}`,
          specId: this.loaderIssueSpecId(file, rawId, key),
        });
      }
    }
    return files;
  }

  /**
   * Steps 5-6 at one root: key every declaration under the root's key, bind
   * every local reference (no `::`) inside the root, and set aside every
   * reference with `::` exactly as written for phase three.
   */
  private keyRoot(raw: RawRoot): void {
    const key = raw.record.namespace;
    const index = raw.index;
    raw.localSubsystems = new Set(index.subsystems.map((s) => s.id));
    // Step 6: a bare name binds locally when it names a spec of the root
    // (compared by nameKey, as local resolution always has); its own id used
    // as a prefix binds locally too and is recorded as a self-prefix; every
    // other bare name in an importable position is set aside for the imports.
    const ownId = idOf(raw);
    // A member that declares no id answers after `doctor --fix` to the alias its
    // parent declares it under, so that alias used as a prefix names its own spec too.
    const ownIds = [ownId, raw.record.config?.id === undefined ? raw.record.mountAlias : undefined]
      .filter((id): id is string => id !== undefined).map(nameKey);
    const localKeys = new Set([
      ...index.subsystems, ...index.components, ...index.interfaces,
      ...index.implementations, ...index.types, ...index.groups,
    ].map((s) => nameKey(s.id.split('::').pop()!)));
    const rawTypes = index.types;
    const selfPrefixed = (value: string): string | undefined => {
      const dot = value.indexOf('.');
      if (ownIds.length === 0 || dot <= 0 || value.includes('::')) return undefined;
      const rest = value.slice(dot + 1);
      return ownIds.includes(nameKey(value.slice(0, dot))) && rest && !rest.includes('.') ? rest : undefined;
    };
    const recordSelfPrefix = (specKey: string, position: string, value: string, local: string): void => {
      raw.record.authoredReferences.push({
        specId: specKey, position, authored: value, form: 'path', binding: 'local', resolved: keyIn(key, local), producer: key, rewrite: local,
      });
    };
    // A signatureFrom's head binds as a component only when it names one: local
    // first, then `alias::component` through phase three. Anything else is a
    // type reference (`billing.change_listener`), which stays as written.
    const localComponents = new Set(index.components.map((c) => nameKey(c.id.split('::').pop()!)));
    const bindLocal = (kind: ReferenceKind, specKey: string): ReferenceMapper => (position, value) => {
      if (position === 'signatureFrom' && !value.includes('::') && !localComponents.has(nameKey(value))) return value;
      if (value.includes('::')) {
        raw.pending.push({ kind, specKey, position, authored: value, raw: false });
        return value;
      }
      const self = selfPrefixed(value);
      if (self !== undefined) {
        recordSelfPrefix(specKey, position, value, self);
        return keyIn(key, self);
      }
      if (IMPORTABLE_POSITIONS.has(position) && !localKeys.has(nameKey(value))) {
        raw.pendingImports.push({ kind, specKey, position, authored: value, raw: false });
      }
      return keyIn(key, value);
    };
    const keyed = <T extends { id: string }>(kind: ReferenceKind, spec: T): T => {
      const specKey = keyIn(key, spec.id);
      for (const r of rawReferences(kind, spec)) raw.pending.push({ kind, specKey, position: r.position, authored: r.value, raw: true });
      // Raw positions read per identifier: a bare type name no local type
      // matches, and a bare declared-call target no local spec names.
      for (const r of bareRawReferences(kind, spec)) {
        if (r.position === 'type') {
          const self = selfPrefixed(r.value);
          if (self !== undefined) { recordSelfPrefix(specKey, 'type', r.value, self); continue; }
          if (r.value.includes('.') || rawTypes.some((t) => typeMatchesRef(t, r.value))) continue;
        } else if (localKeys.has(nameKey(r.value))) continue;
        raw.pendingImports.push({ kind, specKey, position: r.position, authored: r.value, raw: true });
      }
      return { ...mapSpecReferences(kind, spec, bindLocal(kind, specKey)), id: specKey };
    };
    index.subsystems = index.subsystems.map((s) => keyed('subsystem', s));
    index.components = index.components.map((c) => keyed('component', c));
    index.interfaces = index.interfaces.map((i) => keyed('interface', i));
    index.implementations = index.implementations.map((m) => keyed('implementation', m));
    index.types = index.types.map((t) => keyed('type', t));
    index.groups = index.groups.map((g) => keyed('group', g));
    if (key) {
      for (const kind of Object.keys(index.paths) as (keyof SpecIndex['paths'])[]) {
        index.paths[kind] = dict(Object.entries(index.paths[kind]).map(([id, file]) => [keyIn(key, id), file] as const));
      }
    }
    raw.record.specIds = [
      ...index.subsystems, ...index.components, ...index.interfaces,
      ...index.implementations, ...index.types, ...index.groups,
    ].map((s) => s.id);
    raw.record.problems.forEach((p) => { if (p.kind === 'duplicate-spec' && p.id && !p.id.includes('::') && key) p.id = keyIn(key, p.id); });
    raw.record.system = keyedSystem(raw.rawSystem, key, raw.localSubsystems);
    // Step 11: each part's spec keys — the root's own keys whose files the part holds.
    for (const part of raw.record.parts) {
      if (part.directory === undefined) continue;
      const dir = part.directory;
      const held = (kind: keyof SpecIndex['paths']): string[] =>
        Object.entries(index.paths[kind]).filter(([, file]) => isWithin(dir, file)).map(([id]) => id);
      part.subsystems = held('subsystem');
      part.specIds = (Object.keys(index.paths) as (keyof SpecIndex['paths'])[]).flatMap(held);
    }
  }

  /**
   * The root's alias table: each member it followed, and each declared
   * external whose producer the scan read — by source.path, else by the one
   * project of the family answering to its id.
   */
  private bindAliases(raw: RawRoot, raws: RawRoot[]): void {
    for (const [alias, memberKey] of raw.memberKeys) raw.record.aliases.set(alias, memberKey);
    if (!raw.record.config) return;
    for (const decl of declaredExternals(raw.record.config)) {
      if (decl.problem || raw.record.aliases.has(decl.alias)) continue;
      const others = raws.filter((r) => r !== raw);
      let producer: RawRoot | undefined;
      if (decl.sourcePath !== undefined) {
        const at = chainDirKey(path.resolve(raw.dir, decl.sourcePath));
        producer = others.find((r) => chainDirKey(r.dir) === at && idOf(r) === decl.project);
      } else {
        const holders = others.filter((r) => idOf(r) === decl.project);
        if (holders.length === 1) producer = holders[0];
      }
      if (producer) raw.record.aliases.set(decl.alias, producer.record.namespace);
    }
  }

  /** The file of the legacy L1 mount a key names (its declaring root's key, then its alias), if any. */
  private legacyMountFile(key: string): string | undefined {
    for (const raw of this.cachedRawRoots) {
      const mount = raw.mounts.find((m) => keyIn(raw.record.namespace, m.spec.id) === key);
      if (mount) return mount.file;
    }
    return undefined;
  }

  /** ispec_index.listProjectRoots — the project roots the current scan read, bound root first. */
  listProjectRoots(): ScannedProjectRoot[] {
    this.scanAll();
    return this.cachedRoots;
  }

  // -------------------------------------------------------------------------
  // Stage 8: a spec's home
  // -------------------------------------------------------------------------

  /** The part whose folder holds a file (stage 8), with the declaration it was read under; null when none does. */
  partHolding(file: string): { part: ScannedPart; source?: ExternalSource } | null {
    this.scanAll();
    for (const raw of this.cachedRawRoots) {
      for (const part of raw.record.parts) {
        if (part.directory === undefined || !isWithin(part.directory, file)) continue;
        return { part, source: raw.members.find((m) => m.alias === part.alias)?.source };
      }
    }
    return null;
  }

  /**
   * spec_registry.save step 2-4 (stage 8): the home a typed writer resolved is
   * refused before anything is written when it lies in a part fetched from
   * git — its files are the fetch cache's, read-only.
   */
  private assertHomeWritable(file: string): void {
    const held = this.partHolding(file);
    if (held?.part.storage !== 'git') return;
    throw new PartReadOnly(
      `The spec file ${file} belongs to the part "${held.part.alias}", fetched from git (${held.source?.git ?? 'its repository'} at ${held.part.commit ?? 'its pinned commit'}): `
      + 'a git part is read-only here. Edit it in its own repository, commit it there, and take it in with `wairon member update '
      + `${held.part.alias}\`. Nothing was written.`,
    );
  }

  /**
   * spec_registry.save step 5 / delete step 2: inside a hosted request, may the
   * request change this spec? Judged against the request's write reach with the
   * home's project root and the spec's owning subsystem — the document written
   * and, when a stored document is replaced or removed, the one stored (a
   * component moved out of a subsystem changes that subsystem too). Outside a
   * hosted request nothing is judged.
   */
  private assertHomeInReach(file: string, kind: SpecDocumentKind, document: unknown): void {
    if (!getWriteReach()) return;
    const raw = this.homeRootOf(file);
    const owners: SpecWriteOwner[] = [];
    if (document !== null) owners.push(this.documentOwner(raw, kind, document));
    if (pathExists(file)) {
      try {
        owners.push(this.documentOwner(raw, kind, readSpecFile(file)));
      } catch {
        // An unreadable stored document names no owner beyond the one written.
      }
    }
    assertSpecWritesPermitted(owners, `writing ${kind} spec ${path.basename(path.dirname(file))}/${path.basename(file)}`);
  }

  /** The project root a spec file is homed under: the root whose specs folder, or one of whose parts' folders, holds it (deepest wins). */
  private homeRootOf(file: string): { dir: string; namespace: string; project: string } {
    this.scanAll();
    let best: RawRoot | undefined;
    let depth = -1;
    for (const raw of this.cachedRawRoots) {
      const homes = [aiPathsAt(raw.dir).specsDir(), ...raw.record.parts.map((p) => p.directory).filter((d): d is string => d !== undefined)];
      for (const home of homes) {
        if (isWithin(home, file) && path.resolve(home).length > depth) {
          best = raw;
          depth = path.resolve(home).length;
        }
      }
    }
    if (!best) return { dir: this.rootDir, namespace: '', project: path.basename(this.rootDir) };
    return { dir: best.dir, namespace: best.record.namespace, project: idOf(best) ?? (best.record.namespace || path.basename(best.dir)) };
  }

  /**
   * The owner of one spec DOCUMENT as stored in its root (its references local
   * to that root): a subsystem is its own, a component or type names its
   * subsystem, an interface or implementation follows its component; the L0, a
   * system-level type and a type group belong to no subsystem.
   */
  private documentOwner(root: { dir: string; namespace: string; project: string }, kind: SpecDocumentKind, document: unknown): SpecWriteOwner {
    const doc = (document ?? {}) as Record<string, unknown>;
    const local = (v: unknown): string | null => (typeof v === 'string' && v ? splitNamespace(v).localId : null);
    const key = (v: unknown): string | null => (typeof v === 'string' && v ? keyIn(root.namespace, splitNamespace(v).localId) : null);
    let subsystemId: string | null = null;
    if (kind === 'subsystem') subsystemId = local(doc.id);
    else if (kind === 'component' || kind === 'type') subsystemId = local(doc.subsystem);
    else if (kind === 'interface') subsystemId = this.componentSubsystem(key(doc.component));
    else if (kind === 'implementation') {
      const contract = key(doc.contract);
      subsystemId = this.componentSubsystem(contract ? this.loadInterfaceSpec(contract)?.component ?? null : null);
    }
    return { root: root.dir, project: root.project, subsystemId };
  }

  /** The local id of a component's subsystem, by the component's key; null when no such component is stored. */
  private componentSubsystem(componentKey: string | null): string | null {
    if (!componentKey) return null;
    const subsystem = this.loadComponentSpec(componentKey)?.subsystem;
    return subsystem ? splitNamespace(subsystem).localId : null;
  }

  /**
   * The owner of one IN-MEMORY spec (its references keys, as the loader binds
   * them) — what a multi-spec write (a rename, a method move) judges before its
   * first write. `staged` answers a spec the write itself creates.
   */
  specOwner(kind: string, spec: { id?: string; subsystem?: string; component?: string; contract?: string } | null, staged?: (kind: string, id: string) => { component?: string } | undefined): SpecWriteOwner {
    this.scanAll();
    const id = kind === 'system' ? '' : String(spec?.id ?? '');
    const namespace = (kind === 'system' ? '' : this.ownerKeyOf(id)) ?? '';
    const raw = this.cachedRawRoots.find((r) => r.record.namespace === namespace);
    const root = raw ? { dir: raw.dir, project: idOf(raw) ?? (namespace || path.basename(raw.dir)) } : { dir: this.rootDir, project: path.basename(this.rootDir) };
    const localOfKey = (v: string | undefined | null): string | null => (v ? splitNamespace(v).localId : null);
    let subsystemId: string | null = null;
    if (kind === 'subsystem') subsystemId = localOfKey(id);
    else if (kind === 'component' || kind === 'type') subsystemId = localOfKey(spec?.subsystem);
    else if (kind === 'interface') subsystemId = this.componentSubsystem(spec?.component ?? null);
    else if (kind === 'implementation' && spec?.contract) {
      const component = this.loadInterfaceSpec(spec.contract)?.component ?? staged?.('interface', spec.contract)?.component ?? null;
      subsystemId = this.componentSubsystem(component);
    }
    return { root: root.dir, project: root.project, subsystemId };
  }

  /**
   * The key one spec file is approved under (stage 8): its path from the bound
   * root, POSIX — or, for a part's file, `members/<alias>/<path inside the
   * part>`, so moving a part's storage changes no key.
   */
  approvalKeyOf(file: string): string {
    this.scanAll();
    return approvalKeyIn(file, this.rootDir, this.cachedRoots[0]?.parts ?? []);
  }

  /** The file store's write, at a home the writer resolved — a part's folder included, a git part's refused. */
  private writeHome(file: string, document: unknown, kind: SpecDocumentKind): void {
    this.assertHomeWritable(file);
    this.assertHomeInReach(file, kind, document);
    writeSpecFile(file, document);
  }

  /** The file store's delete, pruning up to the specs folder the file lives in (its part's, for a part's file). */
  private removeHome(file: string, kind: SpecDocumentKind): boolean {
    this.assertHomeWritable(file);
    this.assertHomeInReach(file, kind, null);
    const part = this.partHolding(file)?.part;
    return removeSpecFile(file, part?.directory ? aiPathsAt(part.directory).specsDir() : this.paths.specsDir());
  }

  // -------------------------------------------------------------------------
  // Namespace / member resolution
  // -------------------------------------------------------------------------

  /** A member's key → its project root, as the scan recorded it; null for a key no followed member has. */
  resolveSubprojectForNamespace(namespace: string): string | null {
    const root = this.rootCovering(namespace);
    return root ? root.directory : null;
  }

  /** The deepest member key that prefixes a key: the project whose files hold that spec. */
  getSubprojectPrefix(qualifiedId: string): string | null {
    let deepest: string | null = null;
    for (const root of this.listProjectRoots()) {
      if (!root.namespace || !qualifiedId.startsWith(`${root.namespace}::`)) continue;
      if (deepest === null || root.namespace.length > deepest.length) deepest = root.namespace;
    }
    return deepest;
  }

  /** The member root whose key is the namespace, or its longest prefix. */
  private rootCovering(namespace: string): ScannedProjectRoot | null {
    let best: ScannedProjectRoot | null = null;
    for (const root of this.listProjectRoots()) {
      if (!root.namespace) continue;
      if (namespace !== root.namespace && !namespace.startsWith(`${root.namespace}::`)) continue;
      if (!best || root.namespace.length > best.namespace.length) best = root;
    }
    return best;
  }

  /** The root that owns a key: the one that declared it, else the one whose key is its longest prefix; '' for a bare id. */
  private ownerKeyOf(key: string): string | null {
    if (!this.cachedOwners) {
      this.cachedOwners = new Map();
      for (const root of this.listProjectRoots()) for (const id of root.specIds) if (!this.cachedOwners.has(id)) this.cachedOwners.set(id, root.namespace);
    }
    const owner = this.cachedOwners.get(key);
    if (owner !== undefined) return owner;
    // A key lies in a member only strictly under its key: a bare `billing` is
    // the bound root's own id even where a member is keyed `billing`.
    const covering = this.getSubprojectPrefix(key);
    if (covering) return covering;
    return key.includes('::') ? null : '';
  }

  /**
   * Bind one reference written in the project `rootKey` the way the scan binds
   * it: a bare id is local, `alias::name` goes through the alias table to the
   * producer's public name, a deprecated form lands where the scan reads it.
   * The write-side twin of phase three, for a delta written with local names.
   */
  bindReference(rootKey: string, reference: string): string {
    if (!reference.includes('::')) return keyIn(rootKey, reference);
    this.scanAll();
    const raw = this.cachedRawRoots.find((r) => r.record.namespace === rootKey);
    if (!raw) return reference;
    return bindAuthored(raw, this.cachedRawRoots, this.cachedReadables, reference).value;
  }

  /**
   * Write one in-memory reference back relative to the project owning the
   * spec — the exact inverse of the scan's binding. With `carry`, a value that
   * still equals what the scan bound its authored text to is written back as
   * authored, byte for byte. Otherwise: a key in the owning project is bare,
   * a key in another project is `alias::publicName`, anything else as it came.
   * Never `super::`, a leading `::` or a member path.
   */
  private writeReference(from: string, specKey: string, position: string, value: string, carry: Map<string, number> | null): string {
    if (carry) {
      const authored = this.carriedAuthoredText(specKey, position, value, carry);
      if (authored !== undefined) return authored;
    }
    const owner = this.ownerKeyOf(value);
    if (owner === null) return value;
    if (owner === from) return localOf(owner, value);
    const target = this.cachedRawRoots.find((r) => r.record.namespace === owner);
    const referrer = this.cachedRawRoots.find((r) => r.record.namespace === from);
    if (!target || !referrer) return value;
    const alias = aliasFor(referrer, owner) ?? idOf(target);
    if (!alias) return value;
    const entry = target.record.exports.entries.find((e) => exportedKey(e) === value);
    return `${alias}::${entry?.publicName ?? localOf(owner, value)}`;
  }

  /**
   * The authored text the scan bound to this value at this position of this
   * spec, when it did. Two texts that bound to one value (`super::x` and
   * `::a::x` side by side) are carried in the order they were written, one
   * each: `used` counts the ones this spec's write already spent.
   */
  private carriedAuthoredText(specKey: string, position: string, value: string, used: Map<string, number>): string | undefined {
    if (!this.carryIndex) {
      this.carryIndex = new Map();
      for (const root of this.cachedRoots) {
        for (const ref of root.authoredReferences) {
          const k = `${ref.specId}|${ref.position}|${ref.resolved}`;
          this.carryIndex.set(k, [...(this.carryIndex.get(k) ?? []), ref.authored]);
        }
      }
    }
    const k = `${specKey}|${position}|${value}`;
    const texts = this.carryIndex.get(k);
    if (!texts) return undefined;
    const n = used.get(k) ?? 0;
    used.set(k, n + 1);
    return texts[Math.min(n, texts.length - 1)];
  }

  /** A spec written back relative to the project that owns it: its own id local, every reference through writeReference. */
  private relativizeSpec<T extends { id: string }>(kind: ReferenceKind, spec: T, carry = true): T {
    this.scanAll();
    const from = this.getSubprojectPrefix(spec.id) ?? '';
    const carrying = carry && !this.carryDisabled ? new Map<string, number>() : null;
    // A signatureFrom's head is written back only when the scan bound it as a
    // component; a type reference stays as it came, exactly as it was read.
    const components = new Set(this.scanAll().components.map((c) => c.id));
    const mapped = mapSpecReferences(kind, spec, (position, value) => (position === 'signatureFrom' && !components.has(value)
      ? value
      : this.writeReference(from, spec.id, position, value, carrying)));
    // A local id never carries `::`: a subsystem-qualified own id is written by its last segment.
    return { ...mapped, id: localOf(from, spec.id).split('::').pop()! };
  }

  // -------------------------------------------------------------------------
  // Path builders
  // -------------------------------------------------------------------------

  getSubsystemPath(id: string): string {
    const index = this.scanAll();
    if (index.paths.subsystem[id]) {
      return index.paths.subsystem[id];
    }
    // A legacy mount is never a subsystem, but its document stays addressable
    // by its alias, so a writer of the old form still finds its file.
    const mount = this.legacyMountFile(id);
    if (mount) return mount;
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
    const problem = this.systemSpecProblem();
    if (problem === null) return SystemSpecSchema.parse(readSpecFile(p));
    // One line that says what is wrong, said once however often the L0 is read.
    const message = `The L0 System spec (.wai/specs/.index.yaml) cannot be read: ${problem}. Restore it from version control (\`git checkout -- .wai/specs/.index.yaml\`) or fix it by hand.`;
    if (!this.loaderIssues.some((i) => i.specId === 'system' && i.message === message)) {
      this.loaderIssues.push({ severity: 'error', code: 'SCHEMA_VALIDATION_ERROR', message, specId: 'system' });
    }
    return null;
  }

  /**
   * Why the L0 file that is there cannot be read as an L0, in one line —
   * empty, null, not YAML, or failing its schema (each complaint as
   * `path: message`) — or null when it reads (or is absent).
   */
  systemSpecProblem(): string | null {
    const p = this.paths.specsSystem();
    if (!pathExists(p)) return null;
    let raw: unknown;
    try {
      raw = readSpecFile(p);
    } catch (e) {
      const first = String((e as Error)?.message ?? e).split('\n')[0];
      return `it is not valid YAML (${first})`;
    }
    if (raw === undefined || raw === null || raw === '') {
      const text = fs.readFileSync(p, 'utf8');
      return text.trim() === '' ? 'the file is empty' : 'it holds null, not an L0 mapping';
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) return `it holds ${Array.isArray(raw) ? 'a list' : `a ${typeof raw}`}, not an L0 mapping`;
    const parsed = SystemSpecSchema.safeParse(raw);
    if (parsed.success) return null;
    return parsed.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(the document)'}: ${i.message}`).join('; ');
  }

  saveSystemSpec(spec: SystemSpec): void {
    const p = this.paths.specsSystem();
    // The L0 belongs to no subsystem: inside a hosted request it is judged at the project rung.
    this.assertHomeInReach(p, 'system', spec);
    ensureDir(path.dirname(p));
    writeSpecFile(p, parseOrThrow(SystemSpecSchema, spec, 'system', spec.name));
    registryInvalidateCache();
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
      const raw = readSpecFile(p);
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
   * The key of the project whose files hold a spec: the deepest member key
   * prefixing it, else the bound root (''). THE single derivation for the whole
   * write pipeline — every prepare*ForWrite and every ancillary relativization
   * uses it, so the dry-run check and the real saves cannot drift apart.
   */
  writePrefixFor(qualifiedId: string): string {
    return this.getSubprojectPrefix(qualifiedId) ?? '';
  }

  prepareSubsystemForWrite(spec: SubsystemSpec): SubsystemSpec {
    return this.relativizeSpec('subsystem', spec);
  }

  prepareComponentForWrite(spec: ComponentSpec): ComponentSpec {
    return this.relativizeSpec('component', spec);
  }

  /**
   * spec_registry.saveInterfaceSpec steps 1-2: every method in its stored form
   * (method_signature.storedForm — the text a method's params derive, nothing
   * a signatureFrom supplies), then every reference written back relative to
   * the owning project.
   */
  prepareInterfaceForWrite(spec: InterfaceSpec | StoredInterfaceSpec): StoredInterfaceSpec {
    // Every type position canonical (a position that is not canonical is
    // written as it stands), then each method's text derived from them.
    const canonical = interfaceCanonicalTypes(spec).spec;
    const stored = { ...canonical, methods: (canonical.methods ?? []).map((m) => storedMethodSignature(m)) };
    return this.relativizeSpec('interface', stored as InterfaceSpec) as StoredInterfaceSpec;
  }

  prepareImplementationForWrite(spec: ImplementationSpec, carry = true): ImplementationSpec {
    const relative = this.relativizeSpec('implementation', spec, carry);
    // A member's implementation lives in the member's tree, where its file
    // paths are read against the member root.
    const member = this.getSubprojectPrefix(spec.id);
    const memberRoot = member ? this.resolveSubprojectForNamespace(member) : null;
    if (memberRoot) return childRelativeFilePaths(relative, this.rootDir, memberRoot);
    // A part's implementation (stage 8) names its files from the part's root.
    const partDir = this.partHolding(this.getImplementationPath(spec.id, spec.contract))?.part.directory;
    return partDir ? partRelativeFilePaths(relative, this.rootDir, partDir) : relative;
  }

  /**
   * A type written in its stored form — every type position canonical (one
   * that is not canonical written as it stands), every params-bearing method's
   * text derived from them — relative to the owning project.
   */
  prepareTypeForWrite(spec: TypeSpec | StoredTypeSpec): StoredTypeSpec {
    const canonical = typeCanonicalTypes(spec).spec;
    const stored = { ...canonical, methods: (canonical.methods ?? []).map((m) => storedTypeMethod(m)) };
    const relative = this.relativizeSpec('type', stored as TypeSpec) as StoredTypeSpec;
    // A part's type (stage 8) names its files from the part's root, as its
    // implementations do: the inverse of the scan's normalization.
    const partDir = this.partHolding(this.getTypePath(spec.id, spec.subsystem, (spec as { group?: string }).group))?.part.directory;
    return partDir ? partRelativeTypePaths(relative, this.rootDir, partDir) : relative;
  }

  prepareGroupForWrite(spec: GroupSpec): GroupSpec {
    return this.relativizeSpec('group', spec);
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

  /**
   * The subsystem writer behind save('subsystem', ...). Private: the generic
   * save is the one write door, and a subsystem is never a mount — the
   * authoring seam refuses a projectPath before anything reaches here, and a
   * stored legacy mount is read as a member declaration, not loaded as a
   * subsystem, so no mount document is re-saved through this path.
   */
  private writeSubsystemSpec(spec: SubsystemSpec, opts?: SaveSpecOptions): void {
    const p = this.getSubsystemPath(spec.id);
    this.assertHomeWritable(p);
    ensureDir(path.dirname(p));

    const { prefix } = splitNamespace(spec.id);
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
    // that recurses into itself (e.g. a bulk re-save touching every subsystem).
    if (!spec.id.includes('::') && specToWrite.projectPath && !isWithin(this.paths.specsDir(), p)) {
      specToWrite = { ...specToWrite, projectPath: undefined };
    }

    const existing = this.loadSubsystemSpec(spec.id);
    if (existing) {
      specToWrite.createdAt = existing.createdAt;
      // The same no-demotion guard its four sibling savers have had all along.
      // Without it, re-authoring a subsystem through a create tool — which
      // always states 'draft' — quietly reopened a frozen one, taking its whole
      // subtree back into draft context with it. A deliberate demotion still
      // works: the caller says so with allowStatusDemotion.
      if (!opts?.allowStatusDemotion && existing.status && (!spec.status || spec.status === 'draft')) {
        specToWrite.status = existing.status;
      }
    }
    specToWrite.updatedAt = opts?.preserveUpdatedAt && existing?.updatedAt ? existing.updatedAt : new Date().toISOString();
    this.writeHome(p, parseOrThrow(SubsystemSpecSchema, specToWrite, 'subsystem', spec.id), 'subsystem');
    registryInvalidateCache();
  }

  deleteSubsystemSpec(id: string): boolean {
    const p = this.getSubsystemPath(id);
    if (!this.removeHome(p, 'subsystem')) return false;
    registryInvalidateCache();
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
      const raw = readSpecFile(p) as Record<string, unknown>;
      readRetiredReachForms('component', raw);
      return attachRetiredMounts(ComponentSpecSchema.parse(raw), raw);
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
    this.assertHomeWritable(p);
    ensureDir(path.dirname(p));

    const specToWrite = this.prepareComponentForWrite(spec);
    // A caller still handing the retired portalType is read as the loader
    // reads a stored file: the spelling becomes the transport it names.
    readRetiredReachForms('component', specToWrite as unknown as Record<string, unknown>);

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
    specToWrite.updatedAt = opts?.preserveUpdatedAt && existing?.updatedAt ? existing.updatedAt : new Date().toISOString();
    const componentOut = parseOrThrow(ComponentSpecSchema, specToWrite, 'component', spec.id);
    // Retired listener mounts the schema no longer types: the spec's own (read
    // untyped by the loader), else the stored file's, until doctor --fix
    // rewrites them — never dropped by a write that did not decide to.
    const retainedMounts = retiredMountsOf(specToWrite).declared
      ? { mounts: (specToWrite as unknown as Record<string, unknown>).mounts }
      : storedDocument(p);
    if (!opts?.retireReachForms) carryRetiredReachForms('component', retainedMounts, componentOut as unknown as Record<string, unknown>);
    this.writeHome(p, componentOut, 'component');
    registryInvalidateCache();
    // Keep the physical layout in sync with ownership: nest owned members under
    // their pattern, and move anything an `owns` change has displaced.
    this.normalizeComponentLayout();
    return notices;
  }

  deleteComponentSpec(id: string): boolean {
    const p = this.getComponentPath(id);
    if (!this.removeHome(p, 'component')) return false;
    registryInvalidateCache();
    return true;
  }

  /** The directory a component's folder should live in, given current ownership. */
  private desiredComponentDir(comp: ComponentSpec, index: SpecIndex): string | null {
    const currentPath = index.paths.component[comp.id];
    // Only the nested-tree layout is normalized (skip the legacy flat components/ dir).
    if (!currentPath || !currentPath.endsWith('.index.yaml')) return null;
    if (comp.id.includes('::')) return null;
    // A git part's layout is its repository's: its files are never moved here.
    if (this.partHolding(currentPath)?.part.storage === 'git') return null;

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
    if (moved.length) registryInvalidateCache();
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
      const raw = readSpecFile(p) as Record<string, unknown>;
      const owner = typeof raw.component === 'string' ? index.components.find((c) => c.id === raw.component) : undefined;
      readRetiredReachForms('interface', raw, owner?.componentType === 'Portal');
      // A file the scan did not index is resolved alone, against the index's components and types.
      return resolveTree([interfaceCanonicalTypes(InterfaceSpecSchema.parse(raw)).spec], index.components, index.types).interfaces[0];
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

  /**
   * Refuse a write that would land on a file already holding a DIFFERENT spec.
   *
   * In the nested layout a spec's path is derived from its parent — a component
   * for an interface, a contract for an implementation — and the spec's own id
   * is not part of it (see getInterfacePath / getImplementationPath, which take
   * the id but ignore it once the parent resolves). So a second id bound to the
   * same parent resolves to the SAME file.
   *
   * Left unguarded that is silent data loss, and doubly invisible: the caller's
   * `existing` lookup is by the NEW id, finds nothing, and every re-author
   * notice ("REMOVED …", the carry-forward seam) stays quiet. An agent renaming
   * an interface by defining a new one destroys the old contract, its
   * narratives and its lint.allows, and is told "Successfully defined".
   */
  private assertPathHoldsNoOtherSpec(p: string, id: string, kind: string, parentLabel: string): void {
    if (!pathExists(p)) return;
    let occupantId: string | undefined;
    try {
      occupantId = (readSpecFile(p) as { id?: string } | null)?.id;
    } catch {
      return; // unreadable/legacy — the write is the repair
    }
    if (!occupantId) return;
    // A namespaced read of the same spec is not a different spec.
    if (occupantId === id || splitNamespace(occupantId).localId === splitNamespace(id).localId) return;
    throw new Error(
      `Cannot write ${kind} "${id}": ${parentLabel} is already ${kind === 'interface' ? 'served by' : 'implemented by'} `
      + `"${occupantId}" at ${path.relative(this.rootDir, p)}, and both ids resolve to that one file. `
      + `Re-author "${occupantId}" instead, or delete it first if you meant to replace it.`,
    );
  }

  /** Returns non-fatal placement notices (see saveTypeSpec) — empty when there is nothing to clarify. */
  saveInterfaceSpec(spec: InterfaceSpec, opts?: SaveSpecOptions): string[] {
    const notices: string[] = [];
    const p = this.getInterfacePath(spec.id, spec.component);
    this.assertPathHoldsNoOtherSpec(p, spec.id, 'interface', `component "${spec.component}"`);
    this.assertHomeWritable(p);
    ensureDir(path.dirname(p));

    const specToWrite = this.prepareInterfaceForWrite(spec);
    // A caller still handing a retired invokedBy kind is read as the loader
    // reads a stored file (the carry below keeps a stored one as stored).
    const contractOwner = this.scanAll().components.find((c) => c.id === spec.component);
    readRetiredReachForms('interface', specToWrite as unknown as Record<string, unknown>, contractOwner?.componentType === 'Portal');

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
      // Preserve endpoint bindings for matching methods that don't carry their
      // own — unless the reachability migration dropped them deliberately.
      for (const m of opts?.retireReachForms ? [] : specToWrite.methods) {
        if (m.endpoint) continue;
        const existingMethod = existing.methods.find(x => x.name === m.name);
        if (existingMethod && existingMethod.endpoint) {
          m.endpoint = existingMethod.endpoint;
        }
      }
    }
    specToWrite.updatedAt = opts?.preserveUpdatedAt && existing?.updatedAt ? existing.updatedAt : new Date().toISOString();
    const interfaceOut = parseOrThrow(InterfaceSpecSchema, specToWrite, 'interface', spec.id);
    // A retired invokedBy kind the author left as it was read stays as stored
    // until doctor --fix rewrites it.
    // The reachability migration retires a stored `external` it rewrote, but
    // never a stored `sibling-subsystem`: that one it only reports.
    const storedInterface = storedDocument(p);
    carryRetiredReachForms('interface', opts?.retireReachForms ? withoutRetiredKind(storedInterface, 'external') : storedInterface, interfaceOut as unknown as Record<string, unknown>);
    this.writeHome(p, interfaceOut, 'interface');
    registryInvalidateCache();
    return notices;
  }

  deleteInterfaceSpec(id: string): boolean {
    const p = this.getInterfacePath(id);
    if (!this.removeHome(p, 'interface')) return false;
    registryInvalidateCache();
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
      const raw = readSpecFile(p);
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
    this.assertPathHoldsNoOtherSpec(p, spec.id, 'implementation', `contract "${spec.contract}"`);
    this.assertHomeWritable(p);
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
    specToWrite.updatedAt = opts?.preserveUpdatedAt && existing?.updatedAt ? existing.updatedAt : new Date().toISOString();
    this.writeHome(p, parseOrThrow(ImplementationSpecSchema, specToWrite, 'implementation', spec.id), 'implementation');
    registryInvalidateCache();
    return notices;
  }

  deleteImplementationSpec(id: string): boolean {
    const p = this.getImplementationPath(id);
    if (!this.removeHome(p, 'implementation')) return false;
    registryInvalidateCache();
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
  saveTypeSpec(spec: TypeSpec, opts?: SaveSpecOptions): string[] {
    const notices: string[] = [];
    const existing = this.loadTypeSpec(spec.id);
    const group = spec.group || (existing ? existing.group : undefined);
    const p = this.getTypePath(spec.id, spec.subsystem, group);
    this.assertHomeWritable(p);
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
        specToWrite.group = localOf(this.writePrefixFor(spec.id), existing.group);
      }
    }
    specToWrite.updatedAt = opts?.preserveUpdatedAt && existing?.updatedAt ? existing.updatedAt : new Date().toISOString();
    this.writeHome(p, parseOrThrow(TypeSpecSchema, specToWrite, 'type', spec.id), 'type');
    registryInvalidateCache();
    return notices;
  }

  deleteTypeSpec(id: string): boolean {
    const spec = this.loadTypeSpec(id);
    const p = this.getTypePath(id, spec?.subsystem, spec?.group);
    if (!this.removeHome(p, 'type')) return false;
    registryInvalidateCache();
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

  saveGroupSpec(spec: GroupSpec, opts?: SaveSpecOptions): void {
    const p = this.getGroupPath(spec.id);
    this.assertHomeWritable(p);
    ensureDir(path.dirname(p));

    const specToWrite = this.prepareGroupForWrite(spec);

    const existing = this.loadGroupSpec(spec.id);
    if (existing) {
      specToWrite.createdAt = existing.createdAt;
    }
    specToWrite.updatedAt = opts?.preserveUpdatedAt && existing?.updatedAt ? existing.updatedAt : new Date().toISOString();
    this.writeHome(p, parseOrThrow(GroupSpecSchema, specToWrite, 'group', spec.id), 'group');
    registryInvalidateCache();
  }

  deleteGroupSpec(id: string): boolean {
    const p = this.getGroupPath(id);
    if (!this.removeHome(p, 'group')) return false;
    registryInvalidateCache();
    return true;
  }

  // -------------------------------------------------------------------------
  // Kind-generic access (spec_index.load, spec_registry.save / delete)
  //
  // The one place a kind held as DATA becomes the typed loader, writer or
  // delete of that kind. Every caller that holds the kind as a value — the
  // gated whole-spec write, a delete by kind, the delta update, the method
  // move — used to repeat this switch, and each copy could drift from the
  // others (one of them forgot that a type's writer takes no status).
  // -------------------------------------------------------------------------

  /** One stored spec of the named kind, or null. The L0 is a singleton: its id is informational. */
  load(kind: WritableSpecKind, id: string): StoredSpec | null {
    switch (kind) {
      case 'system':         return this.loadSystemSpec();
      case 'subsystem':      return this.loadSubsystemSpec(id);
      case 'component':      return this.loadComponentSpec(id);
      case 'interface':      return this.loadInterfaceSpec(id);
      case 'implementation': return this.loadImplementationSpec(id);
      case 'type':           return this.loadTypeSpec(id);
    }
  }

  /**
   * spec_change_report.strippedKeys — every key the stored document of one
   * spec carries on disk that its level's schema does not know, each as
   * `path: value`. Read from the RAW file: the parsed spec has already lost
   * them. Nested objects are followed where the schema kept the object, and
   * arrays element by element where it kept every element.
   */
  strippedKeysOf(kind: WritableSpecKind, id: string): string[] {
    const file = kind === 'system' ? this.paths.specsSystem() : this.scanAll().paths[kind][id];
    if (!file || !pathExists(file)) return [];
    let raw: unknown;
    try {
      raw = readSpecFile(file);
    } catch {
      return [];
    }
    const schema = {
      system: SystemSpecSchema,
      subsystem: SubsystemSpecSchema,
      component: ComponentSpecSchema,
      interface: InterfaceSpecSchema,
      implementation: ImplementationSpecSchema,
      type: TypeSpecSchema,
    }[kind];
    // The retired reachability forms are read compatibly, never stripped: a
    // portalType becomes the transport it names, and a listener's mounts are
    // carried by the writer until the migration rewrites them.
    if ((kind === 'component' || kind === 'interface') && raw && typeof raw === 'object' && !Array.isArray(raw)) {
      raw = { ...(raw as Record<string, unknown>) };
      readRetiredReachForms(kind, raw as Record<string, unknown>);
      if (kind === 'component') delete (raw as Record<string, unknown>).mounts;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return [];
    const out: string[] = [];
    unknownKeysIn(raw, parsed.data, '', out);
    return out;
  }

  /**
   * Persist one spec through the typed writer of its kind, answering with that
   * writer's placement notices (none for the L0 and a subsystem). A draft or
   * status-less save keeps the stored status, exactly as the typed writers do.
   */
  save(kind: WritableSpecKind, spec: StoredSpec): string[] {
    return this.saveOfKind(kind, spec);
  }

  /** The typed writer of a kind, with the caller's save options — the delta update and the move state a demotion. */
  private saveOfKind(kind: WritableSpecKind, spec: StoredSpec, opts?: SaveSpecOptions): string[] {
    switch (kind) {
      case 'system':         this.saveSystemSpec(spec as SystemSpec); return [];
      case 'subsystem':      this.writeSubsystemSpec(spec as SubsystemSpec, opts); return [];
      case 'component':      return this.saveComponentSpec(spec as ComponentSpec, opts);
      case 'interface':      return this.saveInterfaceSpec(spec as InterfaceSpec, opts);
      case 'implementation': return this.saveImplementationSpec(spec as ImplementationSpec, opts);
      case 'type':           return this.saveTypeSpec(spec as TypeSpec, opts);
    }
  }

  /** Delete one spec document of the named kind; false when none was stored. The L0 cannot be deleted. */
  delete(kind: WritableSpecKind, id: string): boolean {
    switch (kind) {
      case 'system':
        throw new Error('The L0 system spec cannot be deleted: it is the root every other spec hangs from.');
      case 'subsystem':      return this.deleteSubsystemSpec(id);
      case 'component':      return this.deleteComponentSpec(id);
      case 'interface':      return this.deleteInterfaceSpec(id);
      case 'implementation': return this.deleteImplementationSpec(id);
      case 'type':           return this.deleteTypeSpec(id);
    }
  }

  /**
   * spec_registry.deleteMount (removeLegacyMount) — delete the bound project's legacy L1 mount
   * document for one alias: the subsystem carrying projectPath that the scan
   * reads as a member declaration. A subsystem without projectPath is content,
   * not a mount, and is refused by name; no document answers false.
   */
  removeLegacyMount(alias: string): boolean {
    this.scanAll();
    const bound = this.cachedRawRoots.find((r) => r.record.namespace === '');
    const mount = bound?.mounts.find((m) => m.spec.id === alias);
    if (!mount) {
      if (bound?.index.subsystems.some((s) => s.id === alias)) {
        throw new Error(`Refusing to delete "${alias}" as a legacy mount: it is a subsystem of this project with content (it carries no projectPath), not a member declaration.`);
      }
      return false;
    }
    if (!removeSpecFile(mount.file, this.paths.specsDir())) return false;
    registryInvalidateCache();
    return true;
  }

  /**
   * spec_registry.normalizeReferences (writeCanonicalReferences) — re-save one spec with every reference
   * the loader binds in its canonical form (bare when it lands in the owning
   * project, `alias::publicName` elsewhere), targets unchanged. Refuses before
   * writing when a reference carries a deprecated form and bound outside or
   * unresolved, since no canonical text exists for it. Writes only when the
   * text changes, and answers whether it did; the stamp and the lock are
   * never touched.
   */
  writeCanonicalReferences(kind: string, id: string): boolean {
    const refKind = kind as WritableSpecKind;
    if (!['subsystem', 'component', 'interface', 'implementation', 'type'].includes(kind)) {
      throw new Error(`Cannot normalize the references of a "${kind}": only a subsystem, component, interface, implementation or type holds bound references.`);
    }
    const spec = this.load(refKind, id);
    if (!spec) throw new Error(`Cannot normalize the references of ${kind} "${id}": no such spec.`);
    const bound = new Set(['publicInterfaces', 'lifecycle', 'subsystem', 'owns', 'dependsOn', 'dispatch', 'mounts', 'contract', 'narrative', 'group']);
    const stuck = this.cachedRoots
      .flatMap((r) => r.authoredReferences)
      .filter((r) => r.specId === id && bound.has(r.position) && r.form !== 'alias' && (r.binding === 'outside' || r.binding === 'unresolved'));
    if (stuck.length > 0) {
      throw new Error(
        `Refusing to normalize ${kind} "${id}": ${stuck.map((r) => `"${r.authored}" (${r.position}, ${r.binding})`).join(', ')} `
        + 'carries a deprecated form with no canonical text — its target is out of the scan\'s reach or nothing names it.',
      );
    }
    const asStored = JSON.stringify(this.prepareForKind(refKind, spec));
    // The raw positions stay as written in memory: each one the scan recorded
    // a canonical text for is rewritten to it here, token by token.
    const rawRewrites = new Map(this.cachedRoots
      .flatMap((r) => r.authoredReferences)
      .filter((r) => r.specId === id && !bound.has(r.position) && r.rewrite !== undefined && r.rewrite !== r.authored)
      .map((r) => [`${r.position}|${r.authored}`, r.rewrite!] as const));
    const rewritten = rawRewrites.size === 0 ? spec
      : mapRawReferences(refKind as ReferenceKind, spec, (position, value) => rawRewrites.get(`${position}|${value}`) ?? value);
    // dependsOn and owns are sets: two authored texts that bound one target
    // (a member path and a leading `::` form, say) collapse to one entry once
    // both are written canonically, first-written position kept.
    const rawRewritten = refKind === 'component' ? withUniqueTargets(rewritten as ComponentSpec) : rewritten;
    this.carryDisabled = true;
    try {
      // Both sides are prepared forms, which derive every method's text from
      // its params — so a stored text a raw rewrite left stale (its params
      // respelled, its text not) is compared with the file itself, or the
      // re-save that writes the derived text would never happen.
      const prepared = this.prepareForKind(refKind, rawRewritten);
      if (JSON.stringify(prepared) === asStored && !this.storedTextsStale(refKind, id, prepared)) return false;
      this.saveOfKind(refKind, rawRewritten, { preserveUpdatedAt: true });
    } finally {
      this.carryDisabled = false;
    }
    return true;
  }

  /**
   * spec_registry.rewriteReferences (respellReferences) — respell references at parsed positions
   * of one spec: each edit replaces exactly its `from` at its position in the
   * STORED document (the authored text, never the bound in-memory value, whose
   * keys are the scan's), and nothing else in the document moves. Refuses the
   * whole spec, writing nothing, when an edit's `from` is not at its position.
   * Writes through the file store only when the text changed; the lock is
   * never touched.
   */
  respellReferences(kind: string, id: string, edits: ReferenceEdit[]): boolean {
    if (!['system', 'subsystem', 'component', 'interface', 'implementation', 'type'].includes(kind)) {
      throw new Error(`Cannot rewrite the references of a "${kind}": only a system, subsystem, component, interface, implementation or type holds references.`);
    }
    if (edits.length === 0) return false;
    const file = this.storedFileOf(kind, id);
    if (!file || !pathExists(file)) throw new Error(`Cannot rewrite the references of ${kind} "${id}": no such spec is stored.`);
    const stored = readSpecFile(file);
    const document = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
    const found = new Set<ReferenceEdit>();
    const respell: ReferenceMapper = (position, value) => {
      const edit = edits.find((e) => e.position === position && e.from === value);
      if (!edit) return value;
      found.add(edit);
      return edit.to;
    };
    respellStoredReferences(kind, document, respell);
    // An edit whose text already reads `to` at its position was applied before: idempotent, never refused.
    const applied = new Set<ReferenceEdit>();
    respellStoredReferences(kind, JSON.parse(JSON.stringify(stored)) as Record<string, unknown>, (position, value) => {
      for (const e of edits) if (!found.has(e) && e.position === position && e.to === value) applied.add(e);
      return value;
    });
    const missing = edits.filter((e) => !found.has(e) && !applied.has(e));
    if (missing.length > 0) {
      throw new Error(
        `Refusing to rewrite the references of ${kind} "${id}": ${missing.map((e) => `"${e.from}" (${e.position})`).join(', ')} `
        + `is not at its position any more, so the plan was made against a different tree — nothing was written. Plan again.`,
      );
    }
    if (JSON.stringify(document) === JSON.stringify(stored)) return false;
    // A method's text is derived from its params: a respelled param or returns
    // type moves the text with it, as any save writes it.
    if (kind === 'interface' || kind === 'type') deriveMergedTexts(kind, document);
    this.writeHome(file, document, kind as SpecDocumentKind);
    registryInvalidateCache();
    return true;
  }

  /**
   * Whether the stored file of one interface or type holds a method text its
   * prepared form re-derives differently: the text a raw rewrite of its params
   * left behind.
   */
  private storedTextsStale(kind: WritableSpecKind, id: string, prepared: unknown): boolean {
    if (kind !== 'interface' && kind !== 'type') return false;
    const file = this.storedFileOf(kind, id);
    if (!file || !pathExists(file)) return false;
    const stored = readSpecFile(file) as { methods?: { name?: unknown; signature?: unknown }[] } | null;
    const storedText = new Map((stored?.methods ?? []).filter((m) => m && typeof m === 'object').map((m) => [m.name, m.signature] as const));
    const methods = ((prepared as { methods?: { name: string; signature?: string }[] }).methods ?? []);
    return methods.some((m) => m.signature !== undefined && storedText.has(m.name) && storedText.get(m.name) !== m.signature);
  }

  /** The file holding one stored spec, by its in-memory key from the bound root; a system by its project's key. */
  private storedFileOf(kind: string, id: string): string | undefined {
    const index = this.scanAll();
    if (kind !== 'system') return index.paths[kind as keyof SpecIndex['paths']]?.[id];
    const key = id === 'system' ? '' : id;
    const root = this.cachedRawRoots.find((r) => r.record.namespace === key);
    return root ? aiPathsAt(root.dir).specsSystem() : undefined;
  }

  /** The write preparation of one kind: what the typed writer serializes. */
  private prepareForKind(kind: WritableSpecKind, spec: StoredSpec): unknown {
    switch (kind) {
      case 'subsystem':      return this.prepareSubsystemForWrite(spec as SubsystemSpec);
      case 'component':      return this.prepareComponentForWrite(spec as ComponentSpec);
      case 'interface':      return this.prepareInterfaceForWrite(spec as InterfaceSpec);
      case 'implementation': return this.prepareImplementationForWrite(spec as ImplementationSpec);
      case 'type':           return this.prepareTypeForWrite(spec as TypeSpec);
      default:               return spec;
    }
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

  /**
   * Every spec FILE inside a subsystem scope (absolute paths), regardless of
   * status. `collectPromotableSpecs` answers a different question — which specs
   * are not yet complete — so it cannot stand in for this: a scoped approval
   * must cover the specs it approves whether or not they were already settled.
   */
  specPathsInScope(scopeSubsystem?: string): string[] {
    const index = this.scanAll();
    const components = this.loadComponentSpecs();
    const interfaces = this.loadInterfaceSpecs();
    const implementations = this.loadImplementationSpecs();

    const inScope = (specSubsystem: string | undefined): boolean => {
      if (!scopeSubsystem) return true;
      if (!specSubsystem) return false;
      return specSubsystem === scopeSubsystem || specSubsystem.startsWith(`${scopeSubsystem}::`);
    };

    const out = new Set<string>();
    const add = (p: string | undefined): void => { if (p) out.add(path.resolve(p)); };

    for (const s of this.loadSubsystemSpecs()) {
      if (!scopeSubsystem || s.id === scopeSubsystem || s.id.startsWith(`${scopeSubsystem}::`)) {
        add(index.paths.subsystem[s.id]);
      }
    }
    for (const c of components) {
      if (inScope(c.subsystem)) add(index.paths.component[c.id]);
    }
    for (const i of interfaces) {
      const comp = components.find((c) => c.id === i.component);
      if (comp && inScope(comp.subsystem)) add(index.paths.interface[i.id]);
    }
    for (const m of implementations) {
      const intf = interfaces.find((i) => i.id === m.contract);
      const comp = intf ? components.find((c) => c.id === intf.component) : null;
      if (comp && inScope(comp.subsystem)) add(index.paths.implementation[m.id]);
    }
    // An unscoped call also covers the L0 and every type, which belong to no
    // subsystem — a whole-tree approval must approve them too.
    if (!scopeSubsystem) {
      add(this.paths.specsSystem());
      for (const p of Object.values(index.paths.type)) add(p);
      for (const p of Object.values(index.paths.group)) add(p);
    }
    return [...out];
  }

  /** Set a single spec's status (bumps updatedAt). Caller invalidates the cache. */
  /**
   * Flip one spec's lifecycle status, changing nothing else — the lock's freeze.
   *
   * `preserveUpdatedAt` because this is MECHANICAL: no authored content moves,
   * so re-stamping updatedAt would claim an edit that never happened and make a
   * freeze read like a design change in review.
   */
  applySpecStatus(kind: SpecKind, id: string, status: SpecStatus): void {
    const keepStamp: SaveSpecOptions = { preserveUpdatedAt: true };
    switch (kind) {
      case 'subsystem':      { const s = this.loadSubsystemSpec(id);      if (s) this.writeSubsystemSpec({ ...s, status }, keepStamp); break; }
      case 'component':      { const s = this.loadComponentSpec(id);      if (s) this.saveComponentSpec({ ...s, status }, keepStamp); break; }
      case 'interface':      { const s = this.loadInterfaceSpec(id);      if (s) this.saveInterfaceSpec({ ...s, status }, keepStamp); break; }
      case 'implementation': { const s = this.loadImplementationSpec(id); if (s) this.saveImplementationSpec({ ...s, status }, keepStamp); break; }
    }
  }

  /**
   * Snapshot the raw bytes of every spec file under .wai/specs. Paired with
   * restoreSpecFiles() to give a byte-exact revert — used by `wairon lock` to
   * dry-run a promotion (write 'complete' → validate → restore) without leaving
   * any change behind if validation fails or the user cancels.
   */
  /**
   * ispec_index.signatureFacts — what the current scan's signature resolution
   * recorded: every signatureFrom met and how it resolved, and every stored
   * text its params contradict. Read from the cached scan, rescanning first
   * when the tree changed.
   */
  signatureFacts(): SignatureFacts {
    // Step 1: serve the workspace scan, rescanning when the file signature no
    // longer holds (this index's own listProjectRoots, named as its type).
    const index: SpecWorkspace = this;
    index.listProjectRoots();
    // Step 2: the facts the scan kept on the index.
    return this.cachedIndex!.signatures;
  }

  /**
   * A delta's merged spec with every type position canonical, IN PLACE (an
   * interface or a type; nothing else holds type positions). Answers the
   * respellings the write applies: each alias the merge holds — written by the
   * delta — and each alias the stored file still holds at a position the merge
   * kept, which the scan recorded and the save rewrites with it. A position
   * that is not canonical stays as written.
   */
  private canonicalizeMerged(kind: WritableSpecKind, merged: Record<string, any>): TypeRespelling[] {
    if (kind !== 'interface' && kind !== 'type') return [];
    const read = kind === 'interface'
      ? interfaceCanonicalTypes(merged as unknown as StoredInterfaceSpec)
      : typeCanonicalTypes(merged as unknown as StoredTypeSpec);
    Object.assign(merged, read.spec);
    const respelled = new Set(read.respellings.map((r) => r.path));
    const fromFile = this.scanAll().typeSpellings.respellings.filter((r) => r.specId === merged.id && r.kind === kind
      && !respelled.has(r.path) && typePositionText(merged, r.path) === r.stored);
    return [...read.respellings, ...fromFile];
  }

  /**
   * ispec_index.retiredReachFacts — what the current scan met in the forms the
   * reachability model retired, with what the stored spec held there. The
   * loader reads them compatibly for one release, so the stored value would
   * otherwise be gone by the time the migration asks. Read from the cached
   * scan, rescanning first when the tree changed.
   */
  retiredReachFacts(): RetiredReachFact[] {
    // Step 1: serve the workspace scan, rescanning when the file signature no longer holds.
    const index: SpecWorkspace = this;
    index.listProjectRoots();
    // Step 2: the retired forms the scan recorded on the index.
    return this.cachedIndex!.retiredReach;
  }

  /**
   * ispec_index.typeSpellingFacts — what the current scan's type
   * canonicalisation recorded: every stored type position that is an alias of
   * its canonical spelling, and every one that is not canonical at all. Read
   * from the cached scan, rescanning first when the tree changed.
   */
  typeSpellingFacts(): TypeSpellingFacts {
    // Step 1: serve the workspace scan, rescanning when the file signature no longer holds.
    const index: SpecWorkspace = this;
    index.listProjectRoots();
    // Step 2: the facts the scan kept on the index.
    return this.cachedIndex!.typeSpellings;
  }

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
    const files = listSpecFiles(specsDir);
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

  /**
   * The spec files stored under the specs folder while it holds no L0 (no
   * `.index.yaml` at its root, nor a legacy `system.yaml`), as paths from the
   * project root with POSIX separators, sorted. Empty when the L0 is there or
   * nothing is. A tree whose root was deleted is not an empty tree: these are
   * the files every reader of it would silently stop judging.
   */
  findOrphanedSpecFiles(): string[] {
    const specsDir = this.paths.specsDir();
    if (!pathExists(specsDir)) return [];
    // An L0 that is there but does not read as one (empty, null, not YAML,
    // failing its schema) leaves the tree as unjudged as a deleted one.
    const l0 = this.paths.specsSystem();
    const readable = (pathExists(l0) && this.systemSpecProblem() === null) || pathExists(path.join(specsDir, 'system.yaml'));
    if (readable) return [];
    const root = this.paths.root();
    const projectRoot = path.dirname(root);
    return listSpecFiles(specsDir)
      .filter((f) => path.resolve(f) !== path.resolve(l0))
      .map((f) => path.relative(projectRoot, f).split(path.sep).join('/'))
      .sort();
  }

  // -------------------------------------------------------------------------
  // Granular delta updates (sdd_update_spec)
  // -------------------------------------------------------------------------

  /**
   * Apply a delta to one stored spec, in this ORDER — the order is the contract,
   * because every stage below can see what the stage above left:
   *
   *  1. LOAD the stored spec for the addressed kind and id; a spec that does
   *     not exist refuses, and a mis-selected `system` kind refuses by name.
   *  2. REFUSE unknown delta keys, whole. A key the level's schema does not
   *     know is dropped on write, so the edit would report a success it never
   *     performed.
   *  3. QUALIFY the delta's id-bearing references against the spec's namespace,
   *     BEFORE the merge — post-merge a bare id is ambiguous.
   *  4. MERGE. Identity-keyed arrays upsert element by element and honour their
   *     delete markers, at every depth. Narrative step deltas apply in ASCENDING
   *     stepNumber order, each against the numbering the earlier entries of the
   *     same delta left behind — delete step 3 and step 7 becomes step 6, so a
   *     second delete written as 7 addresses what used to be step 8. That is why
   *     a delete may restate the step's `label` or `description` as a guard, and
   *     why labels are the reliable way to name a jump target. Inserts and
   *     deletes relocate every STORED jump field in the same narrative around
   *     them; a jump the delta itself writes is already in the numbering the
   *     whole delta leaves behind, so none of its later steps moves it. A new
   *     implementation method with no narrative is intent-level ([]); a
   *     step whose `type` changes is REBUILT for its new type, keeping its
   *     description and label.
   *  5. UNSET the fields the delta names, at the level each `unset` sits in.
   *  6. RESOLVE symbolic `*Label` references against the MERGED numbering — after
   *     the merge, so a delta may anchor on a label that only pre-existing steps
   *     carry, and a label in the delta retargets the stored numeric jump it
   *     twins. An unresolved reference aborts the whole update.
   *  7. COMPARE with what is stored, both read through the level's canonical
   *     schema. Equal means nothing is written and `written` is false. The same
   *     comparison names every delta path the write did NOT act on — one the
   *     schema drops at a depth the permissive delta cannot refuse, one the
   *     stored spec already held, an `unset` that removed nothing.
   *  8. GATE the merged spec through the caller's hook. A DRY RUN stops here
   *     and answers with the report it would have produced — after the gate, so
   *     it accounts for a write that would really be accepted, and before the
   *     stamp, so not one byte of the stored file moves.
   *  9. STAMP updatedAt and SAVE.
   *
   * Returns the change report, whose `notices` carry the non-fatal effects (an
   * insert whose position was a jump target, so the relocated jumps now bypass
   * the inserted step; the fields a retype dropped) — empty when the merge had
   * nothing to say.
   */
  /**
   * core_orchestrator.updateSpec's stage step: the merged spec prepared for its
   * level's writer and parsed through the writer schema, and its home checked
   * as the save checks it (a git part's file is read-only; a hosted request's
   * write reach). Throws the save's own refusal; writes nothing.
   */
  private stageWrite(kind: WritableSpecKind, spec: Record<string, any>, id: string): void {
    const schema = {
      system: SystemSpecSchema,
      subsystem: SubsystemSpecSchema,
      component: ComponentSpecSchema,
      interface: InterfaceSpecSchema,
      implementation: ImplementationSpecSchema,
      type: TypeSpecSchema,
    }[kind];
    const document = parseOrThrow(schema, this.prepareForKind(kind, spec as StoredSpec), kind, id);
    const home = kind === 'system' ? this.paths.specsSystem()
      : kind === 'subsystem' ? this.getSubsystemPath(spec.id)
        : kind === 'component' ? this.getComponentPath(spec.id, spec.subsystem)
          : kind === 'interface' ? this.getInterfacePath(spec.id, spec.component)
            : kind === 'implementation' ? this.getImplementationPath(spec.id, spec.contract)
              : this.getTypePath(spec.id, spec.subsystem, spec.group);
    this.assertHomeWritable(home);
    this.assertHomeInReach(home, kind, document);
  }

  /**
   * Why a delta may not be applied because it changes WHICH spec this is or
   * WHERE it lives — its id, its createdAt, a component's or a type's
   * subsystem, a contract's component, an implementation's contract — by
   * value or by `unset`; undefined when it changes none of them. A value equal
   * to the stored one is a restatement, not a change. Setting a subsystem is
   * still the repair of a spec whose stored owner the tree does not have (or a
   * system-level type adopting one): there is nothing to move it from.
   */
  private identityEditRefusal(kind: WritableSpecKind, stored: Record<string, unknown>, delta: Record<string, unknown>): string | undefined {
    const unset = new Set(Array.isArray(delta.unset) ? (delta.unset as unknown[]).filter((f): f is string => typeof f === 'string') : []);
    const local = (value: unknown): string | undefined => (typeof value === 'string' ? splitNamespace(value).localId : undefined);
    const changes = (field: string): boolean => unset.has(field)
      || (delta[field] !== undefined && delta[field] !== null && local(delta[field]) !== local(stored[field]));
    const renamedBy: Partial<Record<WritableSpecKind, string>> = {
      component: 'rename it with sdd_rename_component, which moves its contract and implementation with it and rewrites every reference',
      type: 'rename it with sdd_rename_type, which rewrites every reference',
      interface: 'rename it with sdd_rename_spec (kind interface), which rewrites every implementation\'s contract and every export entry naming it',
      implementation: 'rename it with sdd_rename_spec (kind implementation), which moves its file and keys its findings to the new id',
      subsystem: 'no tool renames a subsystem yet',
    };
    if (kind !== 'system' && changes('id')) {
      return `"id" is the spec's identity, not a field a delta edits — a delta would write a second ${kind} beside this one and leave every reference on the old id; ${renamedBy[kind]}.`;
    }
    if (changes('createdAt')) {
      return '"createdAt" records when the spec was first written, and the store keeps it; a delta does not edit it.';
    }
    if ((kind === 'component' || kind === 'type') && changes('subsystem')) {
      const owner = typeof stored.subsystem === 'string' ? stored.subsystem : undefined;
      // A stray (an owner the tree does not have) is repaired, not moved. A
      // system-level type adopting a subsystem IS a move: its file, its
      // references and its exports follow its owner.
      if ((owner !== undefined && this.loadSubsystemSpec(owner) !== null) || (kind === 'type' && owner === undefined)) {
        return `"subsystem" is where the ${kind} lives, not a field a delta edits — a delta would rewrite the field and leave the file, its references and its published entries behind; move it with sdd_move_spec (kind ${kind}), which moves ${kind === 'component' ? 'the component with the members it owns, its contracts and implementations, and re-homes its export entries and lifecycle entrypoints' : 'the type\'s file, its export entries and every reference qualified by its subsystem'}.`;
      }
    }
    if (kind === 'interface' && changes('component')) {
      return '"component" is the component this contract belongs to, not a field a delta edits — move its methods to another component with sdd_move_methods, which carries their implementations and re-points every caller.';
    }
    if (kind === 'implementation' && changes('contract')) {
      return '"contract" is the contract this implementation realizes, not a field a delta edits — move methods between components with sdd_move_methods, which carries their implementation entries with them.';
    }
    return undefined;
  }

  /**
   * core_orchestrator.crossProjectWriteRefusal — the sentence refusing a write
   * any of whose targets lives in another project, or undefined when every one
   * is the bound project's own. A target lives elsewhere when its key carries a
   * member project's prefix (a stored spec read through this tree, or an
   * `alias::name` the bound alias table binds to a member), or when its first
   * segment is an external's alias. A legacy L1 mount keeps its old cross-tree
   * writes. Reads only.
   */
  crossProjectWriteRefusal(targets: ReadonlyArray<{ kind: string; id: string }>, tool: string): string | undefined {
    const verb = tool.replace(/^sdd_/, '').split('_')[0] || 'write';
    for (const target of targets) {
      // Steps 1-2: the L0 and a bare id are the bound project's own.
      if (target.kind === 'system' || typeof target.id !== 'string' || !target.id.includes('::')) continue;
      // Step 3: the key it lives under, and the member covering it.
      const writable = ['subsystem', 'component', 'interface', 'implementation', 'type'].includes(target.kind);
      const stored = writable ? (this.load(target.kind as WritableSpecKind, target.id) as { id?: string } | null)?.id : undefined;
      const key = stored ?? this.bindReference('', target.id);
      const alias = target.id.slice(0, target.id.indexOf('::'));
      const aliased = this.cachedRawRoots[0]?.record.aliases.get(alias);
      const member = this.getSubprojectPrefix(key) ?? this.getSubprojectPrefix(target.id)
        ?? (aliased !== undefined && this.rootCovering(aliased) !== null ? aliased : null);
      // Step 4: a member project — a legacy mount keeps its cross-tree writes.
      if (member !== null) {
        const root = this.rootCovering(member);
        if (root?.legacyMount) continue;
        const qualified = stored ?? target.id;
        const local = qualified.includes('::') ? qualified.slice(qualified.lastIndexOf('::') + 2) : qualified;
        const dir = this.resolveSubprojectForNamespace(member);
        const folder = dir ? path.relative(this.rootDir, dir).split(path.sep).join('/') || '.' : undefined;
        // Step 5.
        return `chained-spec: "${qualified}" lives in another project; ${verb} it from that project's own root. It belongs to the member project "${member}"${folder ? ` at ${folder}` : ''}: `
          + `open a session in that folder (its own guide and .mcp.json — run \`wairon generate\` and \`wairon mcp install --backend claude\` there first if it has none) `
          + `and call ${tool} ${target.kind} ${local} there. Nothing was written.`;
      }
      // An external's alias names a project this one only reads through its pin.
      const externals = this.cachedRawRoots[0]?.record.config?.externals ?? {};
      if (Object.prototype.hasOwnProperty.call(externals, alias)) {
        const producer = (externals as Record<string, { project?: string }>)[alias]?.project ?? alias;
        return `chained-spec: "${target.id}" names a spec of "${producer}", a project this one declares as the external "${alias}": a project's specs are written from its own root, and this project only reads them through its pin. Open a session in that project's folder and call ${tool} there. Nothing was written.`;
      }
    }
    // Step 6.
    return undefined;
  }

  updateSpec(
    kind: WritableSpecKind,
    id: string,
    delta: Record<string, any>,
    hooks?: SpecWriteHooks,
    dryRun = false,
  ): SpecChangeReport {
    const notices: string[] = [];
    // The L0 is a singleton — its id is informational to the load. The delta
    // merges onto the spec as STORED: a sourced method carries only its
    // signatureFrom, never the params and returns the scan resolved into it,
    // so a delta that leaves such a method alone cannot write them back.
    const result = storedFormOf(kind, this.load(kind, id));

    if (!result) {
      throw new Error(`Spec of kind "${kind}" with ID "${id}" does not exist. Define it first.`);
    }

    // A spec of a member project is written from that project's own root, as
    // every other write tool refuses it: from here the write would change a
    // design the member approves on its own, unnoticed until its lock-check.
    if (kind !== 'system') {
      // A member declared in `members` is its own project; a legacy L1 mount
      // (deprecated, `doctor --fix` rewrites it) keeps its old cross-tree writes.
      const refusal = this.crossProjectWriteRefusal([{ kind, id: String((result as { id?: string }).id ?? id) }], 'sdd_update_spec');
      if (refusal !== undefined) throw new Error(refusal);
    }

    // The L0 is a singleton and its load ignores the id — reject a mismatched
    // id loudly so a mis-selected kind can't silently rewrite the system spec.
    if (kind === 'system' && id && id !== 'system' && id !== (result as SystemSpec).name) {
      throw new Error(
        `kind "system" targets the singleton L0 spec (system name "${(result as SystemSpec).name}") — pass id "system" or the system name, got "${id}". For a subsystem, use kind "subsystem".`,
      );
    }

    // A delta key the canonical schema does not know is a typo, not a field.
    // The delta arrives as a permissive z.record, so an unknown key sails
    // through the tool boundary, gets merged into the spec object, and is then
    // stripped by the spec schema on write — leaving "Successfully updated",
    // an unchanged tree, and a clean validate. `dependson` for `dependsOn` was
    // reported exactly this way: the edit never happened and nothing said so.
    const deltaSchema = {
      system: SystemSpecSchema,
      subsystem: SubsystemSpecSchema,
      component: ComponentSpecSchema,
      interface: InterfaceSpecSchema,
      implementation: ImplementationSpecSchema,
      type: TypeSpecSchema,
    }[kind];
    const knownKeys = new Set(Object.keys(deltaSchema.shape));
    // `unset` is a delta-only verb, not a spec field.
    knownKeys.add('unset');
    const unknownKeys = Object.keys(delta ?? {}).filter((k) => !knownKeys.has(k));
    if (unknownKeys.length > 0) {
      const near = (k: string): string => {
        const norm = k.toLowerCase().replace(/[_\-\s]/g, '');
        const hit = [...knownKeys].find((v) => v.toLowerCase().replace(/[_\-\s]/g, '') === norm);
        return hit ? ` (did you mean "${hit}"?)` : '';
      };
      throw new Error(
        `Refusing to update ${kind} "${id}": unknown field(s) `
        + `${unknownKeys.map((k) => `"${k}"${near(k)}`).join(', ')}. `
        + 'An unknown key is dropped on write, so the edit would report success and change nothing. '
        + `Known fields: ${[...knownKeys].sort().join(', ')}.`,
      );
    }

    // A delta edits what a spec SAYS, never which spec it is or where it
    // lives. Merged and saved, a new `id` wrote a second spec beside the first
    // and a new `subsystem` moved the folder, each leaving every reference
    // behind and reporting "1 change" — so identity and placement are refused
    // here, naming the tool that owns the change.
    const identityRefusal = this.identityEditRefusal(kind, result as Record<string, unknown>, delta ?? {});
    if (identityRefusal) throw new Error(`Refusing to update ${kind} "${id}": ${identityRefusal} Nothing was written.`);

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
    //
    // Only STORED jumps relocate. A jump the delta itself writes — on an
    // inserted step, an appended one, or an in-place edit — names its target in
    // the numbering the WHOLE delta leaves behind, after all of its inserts and
    // deletes, which is the numbering its step addresses already use (they
    // apply in ascending order, each against what the earlier ones left). It is
    // pinned when it is merged, and no later insert or delete of the same delta
    // moves it: relocating it was how a branch inserted together with a later
    // step came out pointing one step too far.
    const isPinned = (step: any, field: string): boolean =>
      step?.[DELTA_JUMP_PINS] instanceof Set && step[DELTA_JUMP_PINS].has(field);
    const isPinnedEntry = (entry: any): boolean => entry?.[DELTA_JUMP_PINS] === true;

    const relocateJumps = (step: any, shiftFrom: number, deltaN: number, captureInsertTarget = false): any => {
      const hit = (v: number, isRegionTail = false) =>
        (deltaN > 0 ? ((captureInsertTarget && !isRegionTail) ? v > shiftFrom : v >= shiftFrom) : v > shiftFrom);
      const out = { ...step };
      for (const f of JUMP_FIELDS) {
        if (isPinned(step, f)) continue;
        if (typeof out[f] === 'number' && hit(out[f], f === 'endStep')) out[f] = out[f] + deltaN;
      }
      for (const lf of JUMP_LIST_FIELDS) {
        if (Array.isArray(out[lf])) {
          out[lf] = out[lf].map((c: any) =>
            !isPinnedEntry(c) && typeof c?.step === 'number' && hit(c.step) ? { ...c, step: c.step + deltaN } : c,
          );
        }
      }
      return out;
    };

    /** The STORED jump fields of a step naming `target` — a pinned jump names a final-numbering step, not this one. */
    const jumpRefsTo = (step: any, target: number): string[] => {
      const refs: string[] = [];
      for (const f of JUMP_FIELDS) if (step[f] === target && !isPinned(step, f)) refs.push(f);
      for (const lf of JUMP_LIST_FIELDS) {
        (Array.isArray(step[lf]) ? step[lf] : []).forEach((c: any, i: number) => {
          if (c?.step === target && !isPinnedEntry(c)) refs.push(`${lf}[${i}].step`);
        });
      }
      return refs;
    };

    /**
     * A step delta with every numeric jump it states pinned (see above): the
     * step-level fields by name, each cases/catches/branches entry on itself,
     * so the pin survives the identity merge that spreads an entry over its
     * stored counterpart.
     */
    const pinDeltaJumps = (deltaStep: any, carried?: Set<string>): any => {
      const pins = new Set<string>(carried ?? []);
      for (const f of JUMP_FIELDS) if (typeof deltaStep[f] === 'number') pins.add(f);
      const out: any = { ...deltaStep };
      for (const lf of JUMP_LIST_FIELDS) {
        if (!Array.isArray(out[lf])) continue;
        out[lf] = out[lf].map((c: any) =>
          (c && typeof c === 'object' && typeof c.step === 'number' ? { ...c, [DELTA_JUMP_PINS]: true } : c));
      }
      out[DELTA_JUMP_PINS] = pins;
      return out;
    };

    /** The step as it is stored: no pin left on it or on its entries. */
    const unpinned = (step: any): any => {
      const out: any = { ...step };
      delete out[DELTA_JUMP_PINS];
      for (const lf of JUMP_LIST_FIELDS) {
        if (!Array.isArray(out[lf])) continue;
        out[lf] = out[lf].map((c: any) => {
          if (!c || typeof c !== 'object' || !(DELTA_JUMP_PINS in c)) return c;
          const entry = { ...c };
          delete entry[DELTA_JUMP_PINS];
          return entry;
        });
      }
      return out;
    };

    // -----------------------------------------------------------------------
    // Delta intent guards
    //
    // Every keyed array here upserts: find by identity, merge if found, else
    // append. That makes a MISADDRESSED delta indistinguishable from an
    // addition — editing `compile_manifest_body` when the contract says
    // `compileManifestBody` silently added a fourth method, and the only
    // signal was an UNEXPECTED_IMPLEMENTATION_METHOD warning at a later
    // validate (a warning, not an error, while the spec is draft).
    //
    // The same shape made malformed delete markers silent no-ops: `action:
    // "remove"` or `remove: "true"` match no delete branch, get stripped on
    // write, and the caller is told it succeeded while nothing was removed.
    //
    // Genuine additions still append — refusing those would make update_spec
    // unable to add anything. What is refused is the pair of cases that can
    // only be mistakes: an identity that near-misses an existing one, and a
    // delete that addressed nothing.
    // -----------------------------------------------------------------------

    /** Identity with case and separators removed — how a near-miss is spotted. */
    const normalizeIdentity = (k: unknown): string =>
      String(k ?? '').toLowerCase().replace(/[_\-\s]/g, '');

    /**
     * `unset` is a delta verb at EVERY level, not only the spec's own fields.
     *
     * It used to be read off the top-level delta alone. Nested, it was neither
     * a field nor a verb: it merged onto the element as data, the writer schema
     * stripped it, and the tool answered "Successfully updated" for a spec it
     * had left exactly as it found it. A method's `symbol`, a param's default,
     * a step's `label` could be set and never cleared — with no way to tell
     * from the answer that the edit had not happened.
     */
    const unsetFieldsOf = (item: any): string[] => (Array.isArray(item?.unset)
      ? (item.unset as unknown[]).filter((f): f is string => typeof f === 'string')
      : []);

    /** An element merged from `delta` onto `existing`, with its `unset` honoured and the verb dropped. */
    const withUnset = (merged: any, deltaItem: any): any => {
      const fields = unsetFieldsOf(deltaItem);
      const out = { ...merged };
      delete out.unset;
      for (const field of fields) delete out[field];
      return out;
    };

    /** Refuse markers that look like a delete but match no delete branch. */
    const assertDeltaMarkers = (item: any, label: string): void => {
      if (!item || typeof item !== 'object') return;
      if ('remove' in item && typeof item.remove !== 'boolean') {
        throw new Error(
          `Refusing to update ${label}: "remove" must be the boolean true, got ${JSON.stringify(item.remove)}. `
          + 'A non-boolean is ignored, which would leave the element in place while reporting success.',
        );
      }
      if ('action' in item && item.action !== 'add' && item.action !== 'delete') {
        throw new Error(
          `Refusing to update ${label}: unknown action ${JSON.stringify(item.action)} — expected "add" or "delete". `
          + 'An unknown verb is ignored, which would leave the element in place while reporting success.',
        );
      }
    };

    /**
     * An unmatched delta element is an addition — unless it is a delete that
     * addressed nothing, or its identity differs from an existing one only by
     * case or separators, which is a typo far more often than a sibling.
     */
    const assertUnmatchedIsAnAddition = (
      deltaItem: any, key: unknown, existingKeys: unknown[], label: string,
    ): void => {
      if (deltaItem?.remove === true || deltaItem?.action === 'delete') {
        throw new Error(
          `Refusing to delete ${label} "${String(key)}": nothing with that identity exists. `
          + (existingKeys.length ? `Present: ${existingKeys.map(String).join(', ')}.` : 'The collection is empty.'),
        );
      }
      const near = existingKeys.find(
        (k) => String(k) !== String(key) && normalizeIdentity(k) === normalizeIdentity(key),
      );
      if (near !== undefined) {
        throw new Error(
          `Refusing to add ${label} "${String(key)}": "${String(near)}" already exists and differs only in case or `
          + 'separators. Use the existing identity to edit it, or pick a name that is not a near-duplicate.',
        );
      }
    };

    /**
     * A list of plain values — owns, dependsOn, guarantees, previousNames, a
     * technology's matches, the L0's requirements written as text — MERGES like
     * every other list (F-r6 M1). It used to be replaced wholesale, so a delta
     * naming one requirement silently deleted every other one while the tool
     * promised that arrays upsert. Now each value the delta names that the
     * list does not hold is appended, every value it holds is kept, and a
     * value leaves only by an explicit removal marker `{ value, action:
     * 'delete' }` (or `remove: true`) — a requirement also by `{ description,
     * action: 'delete' }`, since a requirement written as text and one written
     * as `{ description }` are the same requirement. `[]` still clears.
     */
    const isPlainValue = (v: unknown): v is string | number | boolean =>
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
    /** A requirement written as an object: its text is its identity. */
    const isRequirementObject = (field: string, v: unknown): boolean =>
      field === 'globalRequirements' && !!v && typeof v === 'object' && !Array.isArray(v)
      && typeof (v as Record<string, unknown>).description === 'string';
    /** A removal (or addition) marker addressing a plain value: `{ value, action?, remove? }`. */
    const isValueMarker = (v: unknown): boolean =>
      !!v && typeof v === 'object' && !Array.isArray(v) && isPlainValue((v as Record<string, unknown>).value)
      // Only the marker's own keys: a switch case carries `value` too, and is an element, not a marker.
      && Object.keys(v as Record<string, unknown>).every((k) => k === 'value' || k === 'action' || k === 'remove');
    /** The identity a plain-value list matches by: the value as text, a requirement object by its description. */
    const plainKeyOf = (field: string, v: unknown): string | null => {
      if (isPlainValue(v)) return String(v);
      if (isValueMarker(v)) return String((v as Record<string, unknown>).value);
      if (isRequirementObject(field, v)) return String((v as Record<string, unknown>).description);
      return null;
    };
    /** Whether a stored list and a delta for it are a list of plain values (requirements: text or objects). */
    const isPlainValueList = (field: string, stored: unknown, delta: unknown[]): boolean => {
      if (stored !== undefined && !Array.isArray(stored)) return false;
      const before = (stored ?? []) as unknown[];
      const plain = (v: unknown): boolean => isPlainValue(v) || isRequirementObject(field, v);
      if (!before.every(plain)) return false;
      if (!delta.every((d) => plain(d) || isValueMarker(d))) return false;
      // A list of requirement objects with a delta of them is the identified merge's already.
      if (field !== 'globalRequirements') return delta.some((d) => isPlainValue(d) || isValueMarker(d)) || before.some(isPlainValue);
      return true;
    };
    /** A plain-value list merged: values the delta names appended when absent, a marked value removed, nothing else lost. */
    const mergePlainValues = (field: string, stored: unknown[], delta: unknown[]): unknown[] => {
      const out = [...stored];
      for (const deltaItem of delta) {
        const key = plainKeyOf(field, deltaItem);
        if (key === null) continue;
        assertDeltaMarkers(deltaItem, `${field} value "${key}"`);
        const isDelete = !!deltaItem && typeof deltaItem === 'object'
          && ((deltaItem as Record<string, unknown>).remove === true || (deltaItem as Record<string, unknown>).action === 'delete');
        const at = out.findIndex((v) => plainKeyOf(field, v) === key);
        if (isDelete) {
          if (at < 0) {
            throw new Error(
              `Refusing to delete ${field} value "${key}": the list does not hold it. `
              + (out.length ? `It holds: ${out.map((v) => `"${plainKeyOf(field, v)}"`).join(', ')}.` : 'The list is empty.'),
            );
          }
          out.splice(at, 1);
          continue;
        }
        if (at >= 0) continue; // held already: restating a value never loses or duplicates it
        out.push(isValueMarker(deltaItem) ? (deltaItem as Record<string, unknown>).value
          : isRequirementObject(field, deltaItem) ? { description: (deltaItem as Record<string, unknown>).description }
            : deltaItem);
      }
      return out;
    };

    /**
     * A list the delta restates with EXACTLY its stored elements — the same
     * identities, none added, none removed, no marker — in another order takes
     * the delta's order. Under upsert a restated element merges in place, so a
     * reorder used to be a silent no-op answered "the delta matches what is
     * stored"; the order of requirements, boundaries or technologies is design
     * (priority, reading order), and a delta that states one is an edit. An
     * element the delta adds still appends: the order follows the delta only
     * when the delta names the whole list.
     */
    const inDeltaOrder = (field: string, stored: unknown[], delta: unknown[], merged: unknown[]): unknown[] => {
      if (delta.length < 2 || delta.length !== stored.length || merged.length !== stored.length) return merged;
      if (delta.some(carriesEditMarker)) return merged;
      const plain = [...stored, ...delta].every((v) => isPlainValue(v) || isRequirementObject(field, v));
      const keyOf = (v: unknown): string | null => (plain ? plainKeyOf(field, v) : identityKeyOf(field, v));
      const order = delta.map(keyOf);
      if (order.some((k) => k === null) || new Set(order).size !== order.length) return merged;
      const byKey = new Map(merged.map((m) => [keyOf(m), m] as const));
      if (byKey.size !== merged.length || !order.every((k) => byKey.has(k))) return merged;
      return order.map((k) => byKey.get(k));
    };

    /** Keys whose merge the enclosing level performs itself, so the generic one must not. */
    const NO_NESTED_MERGE: ReadonlySet<string> = new Set(['ext', 'narrative', 'unset']);

    /**
     * One element merged over its stored counterpart, with the identity promise
     * held one level DOWN.
     *
     * Arrays upsert by identity — that is the documented contract, and it was
     * true only of a spec's own top-level fields. An array INSIDE an element
     * fell to the shallow spread: a delta naming ONE of a method's `params`
     * replaced the whole list and silently deleted the rest, and a delta
     * retargeting ONE of a try step's `catches` dropped every other clause.
     * The same data loss the top level was fixed for, one level down, with the
     * tool still promising otherwise.
     */
    const mergeElement = (existing: any, deltaItem: any): any => {
      const out: Record<string, any> = { ...existing, ...deltaItem };
      if (!existing || typeof existing !== 'object' || !deltaItem || typeof deltaItem !== 'object') return out;
      for (const [key, value] of Object.entries(deltaItem as Record<string, unknown>)) {
        if (NO_NESTED_MERGE.has(key) || !Array.isArray(value) || value.length === 0) continue;
        const before = (existing as Record<string, unknown>)[key];
        if (before !== undefined && !Array.isArray(before)) continue;
        // An absent stored array still merges, into nothing: that is what keeps
        // a delete marker addressed at an empty collection a refusal rather than
        // a marker the writer strips while reporting success.
        const stored = Array.isArray(before) ? before : [];
        if (isPlainValueList(key, stored, value)) {
          out[key] = inDeltaOrder(key, stored, value, mergePlainValues(key, stored, value));
          continue;
        }
        if (!isIdentifiedArray(key, stored, value)) continue;
        out[key] = inDeltaOrder(key, stored, value, mergeIdentifiedArray(key, stored, value));
      }
      return out;
    };

    /**
     * A `*Label` in a step delta RETARGETS the numeric jump it twins.
     *
     * The stored narrative keeps plain numbers, so a delta that repointed a
     * jump symbolically merged its label onto the OLD number and label
     * resolution then saw both and refused the write as a contradiction
     * ("sets both onFalseStep=2 and onFalseLabel=... — they disagree"). In a
     * delta the number is what is stored and the label is the new intent, so
     * the stored twin gives way. A delta that sets BOTH itself is a genuine
     * contradiction and is still refused.
     */
    const retargetByLabel = (merged: any, deltaStep: any): any => {
      const out = { ...merged };
      for (const [stepField, labelField] of Object.entries(STEP_LABEL_TWINS)) {
        if (deltaStep?.[labelField] !== undefined && deltaStep?.[stepField] === undefined) delete out[stepField];
      }
      for (const key of ['cases', 'catches'] as const) {
        const deltaEntries = deltaStep?.[key];
        if (!Array.isArray(deltaEntries) || !Array.isArray(out[key])) continue;
        const retargeted = new Set(
          deltaEntries
            .filter((e: any) => e?.label !== undefined && e?.step === undefined)
            .map((e: any) => identityKeyOf(key, e))
            .filter((k): k is string => k !== null),
        );
        if (!retargeted.size) continue;
        out[key] = out[key].map((e: any) => {
          const k = identityKeyOf(key, e);
          if (k === null || !retargeted.has(k)) return e;
          const { step, ...rest } = e;
          return rest;
        });
      }
      return out;
    };

    /**
     * A step whose `type` changed is REBUILT for its new type: every field the
     * new type cannot carry is dropped, and the human's own content — the
     * description, the label other steps address it by — is kept.
     *
     * A delta that retypes AND sets a field the new type cannot carry is
     * refused rather than quietly stripped: dropping a stored leftover is
     * cleaning up after the old type, dropping what the caller just wrote is
     * ignoring them.
     */
    const rebuildOnRetype = (stored: any, deltaStep: any, merged: any, methodName: string): any => {
      const newType = merged?.type;
      if (typeof newType !== 'string' || stored?.type === newType) return merged;
      if (!Object.prototype.hasOwnProperty.call(STEP_TYPE_FIELDS, newType)) return merged; // unknown type: the schema names it
      const allowed = stepFieldsFor(newType);
      const stated = Object.keys(deltaStep).filter(
        (k) => k !== 'type' && deltaStep[k] !== undefined && !allowed.has(k),
      );
      if (stated.length) {
        throw new Error(
          `Refusing to retype narrative step ${stored.stepNumber} of "${methodName}" from "${stored.type}" to `
          + `"${newType}": the same delta sets ${stated.map((f) => `"${f}"`).join(', ')}, which a ${newType} step `
          + 'cannot carry. Drop those keys, or retype to a step type that carries them.',
        );
      }
      const out: Record<string, any> = {};
      const dropped: string[] = [];
      for (const [key, value] of Object.entries(merged as Record<string, unknown>)) {
        if (allowed.has(key)) out[key] = value;
        else dropped.push(key);
      }
      if (dropped.length) {
        notices.push(
          `Narrative step ${stored.stepNumber} of "${methodName}" was retyped ${stored.type} -> ${newType}: `
          + `${dropped.join(', ')} dropped — a ${newType} step cannot carry `
          + `${dropped.length === 1 ? 'it' : 'them'}. Its description and label are kept.`,
        );
      }
      return out;
    };

    const mergeNarrative = (methodName: string, existingSteps: any[], deltaSteps: any[]): any[] => {
      let steps = [...existingSteps];
      const sortedDeltas = [...deltaSteps].sort((a, b) => a.stepNumber - b.stepNumber);
      for (const deltaStep of sortedDeltas) {
        const stepNum = deltaStep.stepNumber;

        // The markers a STEP delta may carry. The keyed arrays have refused a
        // malformed marker since the intent guards went in; narrative steps,
        // which carry two more verbs than any of them, were skipped. `remove:
        // "true"`, `action: "remove"` and a `captureJumps` on anything but an
        // insert all match no branch, are stripped on write, and leave the
        // caller told a step was removed or captured over a narrative left
        // exactly as it was.
        if (typeof stepNum !== 'number') {
          throw new Error(
            `Refusing to update the narrative of "${methodName}": a step delta must carry the "stepNumber" `
            + `it addresses, got ${JSON.stringify(stepNum ?? null)}.`,
          );
        }
        if ('remove' in deltaStep && typeof deltaStep.remove !== 'boolean') {
          throw new Error(
            `Refusing to update narrative step ${stepNum} of "${methodName}": "remove" must be the boolean true, `
            + `got ${JSON.stringify(deltaStep.remove)}. A non-boolean is ignored, which would leave the step in `
            + 'place while reporting success.',
          );
        }
        if ('action' in deltaStep && deltaStep.action !== 'insert' && deltaStep.action !== 'delete') {
          throw new Error(
            `Refusing to update narrative step ${stepNum} of "${methodName}": unknown action `
            + `${JSON.stringify(deltaStep.action)} — expected "insert" or "delete", or no action at all to edit the `
            + 'step in place. An unknown verb is ignored, which would report success for an edit never made.',
          );
        }
        if ('captureJumps' in deltaStep && deltaStep.action !== 'insert') {
          throw new Error(
            `Refusing to update narrative step ${stepNum} of "${methodName}": "captureJumps" only means anything on `
            + 'an inserted step — it decides whether jumps aimed at that number follow the shifted original or land '
            + 'on the new step. On any other delta it is ignored.',
          );
        }

        if (deltaStep.action === 'delete' || deltaStep.remove === true) {
          const idx = steps.findIndex(s => s.stepNumber === stepNum);
          if (idx !== -1) {
            const victim = steps[idx];

            // IDENTITY guard. Step deltas apply in ascending order against the
            // numbering earlier entries of the same delta left behind, so a
            // delete written for step 7 after a delete of step 3 addresses what
            // used to be step 8. A delete may restate the step's label or
            // description; restated, it must match, which is the only way that
            // slip is ever noticed. Both were ignored outright before.
            for (const field of ['label', 'description'] as const) {
              if (deltaStep[field] === undefined) continue;
              if (victim[field] !== deltaStep[field]) {
                throw new Error(
                  `Refusing to delete narrative step ${stepNum}: the delta states ${field} `
                  + `${JSON.stringify(deltaStep[field])}, but step ${stepNum} holds `
                  + `${JSON.stringify(victim[field] ?? null)}. Step deltas apply in ascending order against the `
                  + 'numbering earlier entries of the same delta left behind, so a later delete can address a '
                  + 'step that has already moved.',
                );
              }
            }

            // REGION guard. A loop, try or parallel header owns the steps
            // between it and its endStep. Deleting the header alone left that
            // body standing with nothing looping, guarding or forking it — a
            // narrative that still validates and no longer means what it says,
            // reported as a clean one-step delete.
            if (typeof victim.endStep === 'number') {
              const body = steps.filter(s => s.stepNumber > stepNum && s.stepNumber <= victim.endStep);
              if (body.length) {
                const span = body.length === 1
                  ? `step ${body[0].stepNumber}`
                  : `steps ${body[0].stepNumber}-${body[body.length - 1].stepNumber}`;
                throw new Error(
                  `Cannot delete narrative step ${stepNum}: it is a ${victim.type} header and ${span} `
                  + `${body.length === 1 ? 'is' : 'are'} still its body. Deleting it would leave them in place `
                  + `with no ${victim.type} around them — a change of meaning nothing later reports. Dissolve the `
                  + `region first: retype step ${stepNum} to a type that carries no region (the region fields are `
                  + 'dropped and reported), then delete it.',
                );
              }
            }

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
          } else {
            // A delete that addressed nothing was a silent no-op: the marker is
            // stripped on write and the caller is told the update succeeded. A
            // keyed array has refused this since the intent guards went in; a
            // narrative step, which is the collection whose numbering MOVES
            // under the delta, did not.
            const present = steps.length
              ? ` — it has steps ${steps[0].stepNumber}-${steps[steps.length - 1].stepNumber}`
              : ' — it has no steps';
            throw new Error(
              `Refusing to delete narrative step ${stepNum}: this narrative has no step ${stepNum}${present}. `
              + 'Step deltas apply in ascending order against the numbering earlier entries of the same delta '
              + 'left behind, so a later delete can address a step that has already moved.',
            );
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
          steps.push(withUnset(pinDeltaJumps(cleanStep), deltaStep));
        } else {
          const idx = steps.findIndex(s => s.stepNumber === stepNum);
          if (idx !== -1) {
            const { action, remove, ...rawStep } = deltaStep;
            const stored = steps[idx];
            const cleanStep = pinDeltaJumps(rawStep, stored[DELTA_JUMP_PINS]);
            const merged = withUnset(retargetByLabel(mergeElement(stored, cleanStep), cleanStep), deltaStep);
            // A rebuild copies only the fields the new type carries, so the pins ride over explicitly.
            const rebuilt = rebuildOnRetype(stored, rawStep, merged, methodName);
            rebuilt[DELTA_JUMP_PINS] = cleanStep[DELTA_JUMP_PINS];
            steps[idx] = rebuilt;
          } else {
            const { action, remove, ...cleanStep } = deltaStep;
            steps.push(withUnset(pinDeltaJumps(cleanStep), deltaStep));
          }
        }
      }
      return steps.map(unpinned).sort((a, b) => a.stepNumber - b.stepNumber);
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
        assertDeltaMarkers(deltaMethod, `method "${deltaMethod?.name}"`);
        const idx = merged.findIndex(m => m.name === deltaMethod.name);
        if (idx !== -1) {
          if (deltaMethod.remove === true || deltaMethod.action === 'delete') {
            merged.splice(idx, 1);
          } else {
            const existingMethod = merged[idx];
            let narrative = existingMethod.narrative ? [...existingMethod.narrative] : [];
            if (deltaMethod.narrative !== undefined && deltaMethod.narrative !== null && !Array.isArray(deltaMethod.narrative)) {
              throw new Error(
                `Refusing to update implementation method "${String(deltaMethod.name)}": its "narrative" must be a list `
                + `of step deltas, got ${JSON.stringify(deltaMethod.narrative)}.`,
              );
            }
            if (Array.isArray(deltaMethod.narrative)) {
              // `[]` clears the list it names, at this level too: fed to the
              // step merge it means "upsert no steps", which left the narrative
              // in place and reported success for a write that did nothing.
              narrative = deltaMethod.narrative.length === 0
                ? []
                : mergeNarrative(String(deltaMethod.name), narrative, deltaMethod.narrative);
            }
            const { narrative: _, ...cleanMethod } = deltaMethod;
            merged[idx] = withUnset({
              ...mergeElement(existingMethod, cleanMethod),
              ...(deltaMethod.ext !== undefined ? { ext: mergeExt(existingMethod.ext, deltaMethod.ext) } : {}),
              narrative,
            }, deltaMethod);
          }
        } else {
          assertUnmatchedIsAnAddition(deltaMethod, deltaMethod.name, merged.map(m => m.name), 'method');
          merged.push(withUnset(newMethodOf(deltaMethod), deltaMethod));
        }
      }
      return merged;
    };

    /**
     * A method the delta ADDS, in the shape every stored method has.
     *
     * A stored implementation method always carries `narrative` (the schema
     * defaults it to []), and the write path reads it as a list before the
     * schema ever sees the spec. A new method the delta gave no narrative
     * reached that read as `undefined` and the write died with a raw TypeError.
     * Absent means what the schema already says it means — no steps, an
     * intent-level method — so it is filled in as []. A narrative that is
     * present but not a list is a mistake, not an omission, and is refused by
     * name.
     */
    const newMethodOf = (deltaMethod: any): any => {
      if (kind !== 'implementation') return deltaMethod;
      if (deltaMethod.narrative === undefined || deltaMethod.narrative === null) return { ...deltaMethod, narrative: [] };
      if (!Array.isArray(deltaMethod.narrative)) {
        throw new Error(
          `Refusing to add implementation method "${String(deltaMethod.name)}": its "narrative" must be a list of steps, `
          + `got ${JSON.stringify(deltaMethod.narrative)}. Leave it out (or pass []) for an intent-level method.`,
        );
      }
      return deltaMethod;
    };

    const mergeNamedArray = (existing: any[], delta: any[]): any[] => {
      const merged = [...existing];
      for (const deltaItem of delta) {
        assertDeltaMarkers(deltaItem, `entry "${deltaItem?.name}"`);
        const idx = merged.findIndex(item => item.name === deltaItem.name);
        if (idx !== -1) {
          if (deltaItem.remove === true || deltaItem.action === 'delete') {
            merged.splice(idx, 1);
          } else {
            // Nested identity-keyed arrays upsert through mergeElement: an
            // interface method's findings by code and its params by name, like
            // lint.allow one level up. An empty list still clears outright.
            merged[idx] = withUnset({
              ...mergeElement(merged[idx], deltaItem),
              ...(deltaItem.ext !== undefined ? { ext: mergeExt(merged[idx].ext, deltaItem.ext) } : {}),
            }, deltaItem);
          }
        } else {
          assertUnmatchedIsAnAddition(deltaItem, deltaItem.name, merged.map(i => i.name), 'entry');
          merged.push(withUnset(deltaItem, deltaItem));
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
        assertDeltaMarkers(deltaItem, `entry "${keyOf(deltaItem)}"`);
        const idx = merged.findIndex(item => keyOf(item) === keyOf(deltaItem));
        if (idx !== -1) {
          if (deltaItem.remove === true || deltaItem.action === 'delete') {
            merged.splice(idx, 1);
          } else {
            merged[idx] = withUnset(mergeElement(merged[idx], deltaItem), deltaItem);
          }
        } else {
          assertUnmatchedIsAnAddition(deltaItem, keyOf(deltaItem), merged.map(keyOf), 'entry');
          merged.push(withUnset(deltaItem, deltaItem));
        }
      }
      return merged.map(({ action, remove, ...item }) => item);
    };

    const mergePublicInterfaces = (existing: any[], delta: any[]): any[] => {
      const merged = [...existing];
      for (const deltaItem of delta) {
        // Bound: component + interface; not yet bound: type + details (publicInterfaceKey).
        const piKey = (i: any): string => String(identityKeyOf('publicInterfaces', i));
        assertDeltaMarkers(deltaItem, `publicInterface "${piKey(deltaItem)}"`);
        const key = identityKeyOf('publicInterfaces', deltaItem);
        const idx = key === null ? -1 : merged.findIndex(item => identityKeyOf('publicInterfaces', item) === key);
        if (idx !== -1) {
          if (deltaItem.remove === true || deltaItem.action === 'delete') {
            merged.splice(idx, 1);
          } else {
            merged[idx] = withUnset(mergeElement(merged[idx], deltaItem), deltaItem);
          }
        } else {
          assertUnmatchedIsAnAddition(deltaItem, piKey(deltaItem), merged.map(piKey), 'publicInterface');
          merged.push(withUnset(deltaItem, deltaItem));
        }
      }
      return merged;
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
        assertDeltaMarkers(deltaItem, `${field} entry "${String(key)}"`);
        const isDelete = deltaItem?.remove === true || deltaItem?.action === 'delete';
        if (idx !== -1) {
          if (isDelete) merged.splice(idx, 1);
          else merged[idx] = withUnset(mergeElement(merged[idx], deltaItem), deltaItem);
        } else {
          // An element with no resolvable identity cannot near-miss anything;
          // only the phantom-delete guard is meaningful for it.
          if (key !== null) {
            assertUnmatchedIsAnAddition(
              deltaItem, key, merged.map((i) => identityKeyOf(field, i)).filter((k) => k !== null), field,
            );
          } else if (isDelete) {
            throw new Error(`Refusing to delete a ${field} entry with no resolvable identity.`);
          }
          merged.push(withUnset(deltaItem, deltaItem));
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
        // `unset` is the verb, never a field — at this level as at the top.
        if (key === 'unset') continue;
        if (value === undefined || value === null) {
          continue;
        }
        // `[]` clears the list it names — every list, the keyed ones the
        // branches below upsert into included; under upsert an empty list
        // would otherwise mean "change nothing", and the delta's one honest way
        // to say "none" (`publicInterfaces: []`) would be silently ignored.
        if (Array.isArray(value) && value.length === 0) {
          res[key] = [];
          continue;
        }
        if (key === 'methods' && Array.isArray(value) && Array.isArray(existing.methods)) {
          if (kind === 'implementation') {
            res.methods = inDeltaOrder(key, existing.methods, value, mergeMethods(existing.methods, value));
          } else {
            res.methods = inDeltaOrder(key, existing.methods, value, mergeNamedArray(existing.methods, value));
          }
        } else if (key === 'fields' && Array.isArray(value) && Array.isArray(existing.fields)) {
          res.fields = inDeltaOrder(key, existing.fields, value, mergeNamedArray(existing.fields, value));
        } else if (key === 'publicInterfaces' && Array.isArray(value) && Array.isArray(existing.publicInterfaces)) {
          res.publicInterfaces = inDeltaOrder(key, existing.publicInterfaces, value, mergePublicInterfaces(existing.publicInterfaces, value));
        } else if (key === 'dispatch' && Array.isArray(value) && Array.isArray(existing.dispatch)) {
          res.dispatch = inDeltaOrder(key, existing.dispatch, value, mergeKeyedArray(existing.dispatch, value, b => String(b?.capability)));
        } else if (key === 'lifecycle' && Array.isArray(value) && Array.isArray(existing.lifecycle)) {
          res.lifecycle = inDeltaOrder(key, existing.lifecycle, value, mergeKeyedArray(existing.lifecycle, value, le => `${le?.phase} ${le?.component} ${le?.method}`));
        } else if (Array.isArray(value) && isPlainValueList(key, existing[key], value)) {
          // A list of plain values merges: values appended when absent, a marked
          // value removed, nothing the delta did not name lost.
          res[key] = inDeltaOrder(key, existing[key] ?? [], value, mergePlainValues(key, existing[key] ?? [], value));
        } else if (Array.isArray(value) && value.length > 0 && Array.isArray(existing[key])
                   && isIdentifiedArray(key, existing[key], value)) {
          // Every other array whose elements carry an identity: upsert by it and
          // honour delete markers, instead of replacing the list wholesale and
          // silently dropping whatever the delta did not mention.
          res[key] = inDeltaOrder(key, existing[key], value, mergeIdentifiedArray(key, existing[key], value));
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
      return withUnset(res, delta2);
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
      const q = (ref: unknown): unknown =>
        typeof ref === 'string' ? this.bindReference(prefix, ref) : ref;
      const qualifyListItem = (item: unknown): unknown =>
        (item && typeof item === 'object' && typeof (item as Record<string, unknown>).value === 'string'
          ? { ...(item as Record<string, unknown>), value: q((item as Record<string, unknown>).value) }
          : q(item));
      const out: Record<string, any> = { ...d };
      switch (kind) {
        case 'subsystem': {
          if (Array.isArray(out.publicInterfaces)) {
            out.publicInterfaces = out.publicInterfaces.map((pi: any) => ({
              ...pi,
              ...(typeof pi?.component === 'string' ? { component: q(pi.component) } : {}),
              ...(typeof pi?.interface === 'string' ? { interface: q(pi.interface) } : {}),
              ...(typeof pi?.typeDef === 'string' ? { typeDef: q(pi.typeDef) } : {}),
              ...(typeof pi?.from === 'string' ? { from: q(pi.from) } : {}),
              ...(Array.isArray(pi?.consumers) ? { consumers: pi.consumers.map(q) } : {}),
            }));
          }
          if (Array.isArray(out.lifecycle)) {
            out.lifecycle = out.lifecycle.map((le: any) =>
              (typeof le?.component === 'string' ? { ...le, component: q(le.component) } : le));
          }
          break;
        }
        case 'component':
          if (typeof out.subsystem === 'string') out.subsystem = q(out.subsystem);
          // A removal marker names the reference as its `value`: qualified the same way.
          if (Array.isArray(out.owns)) out.owns = out.owns.map(qualifyListItem);
          if (Array.isArray(out.dependsOn)) out.dependsOn = out.dependsOn.map(qualifyListItem);
          if (Array.isArray(out.dispatch)) {
            out.dispatch = out.dispatch.map((b: any) =>
              (typeof b?.component === 'string' ? { ...b, component: q(b.component) } : b));
          }
          if (Array.isArray(out.mounts)) {
            out.mounts = out.mounts.map((m: any) =>
              (typeof m?.portal === 'string' ? { ...m, portal: q(m.portal) } : m));
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
    // A field an element leaves out — or passes as null/undefined — is NOT
    // there to merge, at every depth, exactly as at the top level (F88). The
    // element merge is a shallow spread, so a key present with no value
    // overwrote the stored one: `{ name: 'run', params: undefined }` from an
    // in-process caller erased the method's params, and `catches: null` on a
    // step was refused by the schema instead of being the "no change" the
    // tool promises. Only `[]` or an `unset` clears a stored value.
    const { unset: _unset, ...mergeableDelta } = withoutAbsentFields(delta) as Record<string, unknown>;

    // The stored spec as it was BEFORE the merge. The merge shares nested
    // objects with it wherever the delta did not reach, so label resolution —
    // which edits steps in place — would otherwise edit the "before" too and
    // the comparison below would see no difference where there was one.
    const storedBefore = JSON.parse(JSON.stringify(result));

    // The delta with its references already resolved into the namespace the
    // spec is stored in — the only form whose values can be compared with what
    // the write persisted, since an unqualified id is rewritten on the way in.
    const qualifiedDelta = qualifyDeltaRefs(mergeableDelta);
    const mergedResult = mergeDelta(result, qualifiedDelta);
    for (const field of unsetFields) delete mergedResult[field];
    // Every type position the merged spec holds, canonical — so a delta writing
    // an alias of what is stored changes nothing, and the texts below are
    // derived from canonical types. A position that is not canonical stays as
    // written, for the caller's gate to judge.
    const respellings = this.canonicalizeMerged(kind, mergedResult);
    // A method's text is derived from its params on the write, never taken
    // from the delta. A sourced method is left as merged, so the caller's gate
    // sees a restatement the delta made (the writer drops it either way).
    deriveMergedTexts(kind, mergedResult);
    // A field the delta removed that the schema DEFAULTS (every top-level list
    // is one) is back at its default, which is what unsetting it means. Left
    // absent, the save path — which reads these lists before the schema runs —
    // threw a raw TypeError on it. Only absent keys are filled; nothing the
    // merge produced is replaced or stripped here.
    const withDefaults = deltaSchema.safeParse(mergedResult);
    if (withDefaults.success) {
      for (const [key, value] of Object.entries(withDefaults.data as Record<string, unknown>)) {
        if (!(key in mergedResult)) mergedResult[key] = value;
      }
    }

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

    // What actually changed, judged on the form that would be PERSISTED: the
    // level schema strips whatever it does not know, so a delta key the writer
    // would drop cannot be counted as a change. The stored side goes through
    // the same schema, so the two are compared like for like. A merged spec
    // the schema refuses (unsetting a required field) is compared raw and left
    // to the save, which names the offending field — the honest failure.
    const canonical = (spec: unknown): Record<string, any> => {
      const parsed = deltaSchema.safeParse(spec);
      const value: Record<string, any> = { ...(parsed.success ? parsed.data : (spec as object)) } as Record<string, any>;
      delete value.updatedAt; // a stamp, not authored content
      return value;
    };
    const canonicalStored = canonical(storedBefore);
    const canonicalMerged = canonical(mergedResult);
    const changes = specChanges(canonicalStored, canonicalMerged);

    // …and what the delta named that the write did NOT act on. The top-level
    // unknown-key refusal above cannot see one depth down, where the delta is
    // permissive by design, so a nested typo would merge, be stripped on write,
    // and never be mentioned. Named here instead of stripped in silence.
    const ineffective = ineffectiveDeltaPaths(
      { ...qualifiedDelta, ...(unsetFields.length ? { unset: unsetFields } : {}) },
      canonicalMerged,
      canonicalStored,
      respellings,
    );

    // A write that changes nothing writes NOTHING and says so. Re-stamping
    // updatedAt and answering "Successfully updated" is how a delta that
    // no-opped — a mistyped key, a marker the merge ignored — read as a
    // completed edit, sometimes for a whole session. A caller asking only what
    // the delta WOULD do is answered the same way: there is nothing it would do.
    if (changes.length === 0) {
      return {
        kind,
        id,
        written: false,
        dryRun,
        changes,
        ineffective,
        notices,
        respellings: [],
        testsToRevisit: [],
        summary: `No change to ${kind} "${id}" — the delta matches what is stored, so nothing ${dryRun ? 'would be' : 'was'} written.`,
      };
    }

    // Write-boundary gate, on the MERGED result — the only point where the spec
    // the caller will actually get exists as one object, and still the last
    // point before anything touches disk. A refusal throws, so "nothing was
    // saved" stays literally true. It runs for a DRY RUN too: an account of a
    // write that the write itself would be refused is not an account worth
    // having.
    const gateNotices = hooks?.gate?.(kind, mergedResult);
    // Staged exactly as the save will make it — the writer's parse and its
    // home's write checks — for a dry run too. The dry run used to answer
    // before the save ever parsed, so `technologies: [{name: …}]` and an unset
    // required field read "would be made" and were refused on the write: the
    // disk is now the only thing a dry run skips.
    this.stageWrite(kind, mergedResult, id);
    // The keys the stored FILE carries that the schema does not know: the
    // parse above already dropped them, and the save below re-serializes
    // through the schema, so without this they would vanish unannounced.
    const stripped = this.strippedKeysOf(kind, id);
    if (gateNotices?.length) notices.push(...gateNotices);

    // The account, and nothing else. Stamping happens below, so a dry run
    // leaves the stored file byte for byte as it was.
    if (dryRun) {
      return {
        kind,
        id,
        written: false,
        dryRun: true,
        changes,
        ineffective,
        notices,
        respellings,
        testsToRevisit: [],
        ...(stripped.length ? { strippedKeys: stripped } : {}),
        summary: `Dry run on ${kind} "${id}": ${changes.length} change${changes.length === 1 ? '' : 's'} would be made. Nothing was written.`,
      };
    }

    mergedResult.updatedAt = new Date().toISOString();

    // An explicit status in the delta is a deliberate change — allow demotion
    // (e.g. reopening a completed spec to 'draft' for revision).
    const opts: SaveSpecOptions = {
      allowStatusDemotion: Object.prototype.hasOwnProperty.call(delta, 'status'),
    };

    notices.push(...this.saveOfKind(kind, mergedResult, opts));

    return {
      kind,
      id,
      written: true,
      dryRun: false,
      changes,
      ineffective,
      notices,
      respellings,
      // The store never searches for tests: it holds the tree and knows
      // nothing about the rule engine that reads code. The GATED write above
      // it fills this in, which is also the only write path a human drives.
      testsToRevisit: [],
      ...(stripped.length ? { strippedKeys: stripped } : {}),
      summary: `Updated ${kind} "${id}": ${changes.length} change${changes.length === 1 ? '' : 's'}.`,
    };
  }

  // -------------------------------------------------------------------------
  // Method move (icore_orchestrator.moveMethods)
  //
  // A rename changes a NAME and can stay mechanical. A move changes which
  // component OWNS behaviour, which is exactly what the stereotype and
  // dependency rules judge — so the mechanics live here and the judgement
  // arrives as an injected hook, for the same reason `gate` does: this module
  // must not import the rule engine.
  //
  // It is several writes at once: both contracts, both implementations, the
  // target component (which gains the dependencies the moved narratives call),
  // and every caller whose steps, dispatch bindings, lifecycle entrypoints or
  // `calls` entries name the old home. Every edit is computed before the first
  // is written and a failed write restores the ones already made, because a
  // half-moved method leaves callers naming a home it no longer has.
  // -------------------------------------------------------------------------

  /**
   * Move contract methods from one component to another, and every reference
   * with them.
   *
   * Each method leaves the source component's contract and arrives on the
   * target's, carrying its signature, params, returns, guarantees and endpoint
   * binding unchanged; its implementation entry travels with it, carrying
   * narrative, sourcePath, symbol, detail, intent, calls and findings. Prose is
   * never rewritten and a wire endpoint keeps its address — moving a method
   * between components must not silently re-address an RPC — so both are
   * reported as mentions instead.
   *
   * Refuses before the first write (`unmovable request`): a component or method
   * that does not exist, a method name already declared on the target, a source
   * and target that are the same component, and a component inside a chained
   * subproject.
   */
  moveMethods(
    from: string,
    to: string,
    methods: string[],
    hooks?: SpecWriteHooks,
    dryRun = false,
  ): MethodMoveReport {
    // Step 1: the source component.
    const source = this.loadComponentSpec(from);

    // Step 2: what the caller named.
    const complaint = this.unmovableRequest(source, from, to, methods);

    // Steps 3-4: refuse before the first write, naming which check failed — a
    // mistyped id must read as a mistyped id, never as a rule refusing the design.
    if (complaint) throw new Error(`unmovable request: ${complaint}`);

    // Step 5: the interfaces of both components.
    const contracts = this.loadInterfaceSpecs();

    // Step 6: the plan, built entirely in memory.
    const plan = this.planMethodMove(source as ComponentSpec, to, methods, contracts);

    // Step 7: every reference that names the old home, re-pointed to follow the
    // methods; prose and wire addresses recorded and left alone.
    const repointed = this.repointToNewHome(from, to, methods, plan);
    const mentions = this.moveMentions(from, plan);
    // Step 8: findings keyed on a moved method follow it — its lint allows are
    // staged like any other reference, and the debt register is rekeyed below.
    const rename = moveRename(from, to, methods, plan);
    this.rekeyMoveAllows(plan, rename);

    // Step 9: a judgement was injected.
    if (hooks) {
      // Step 10: judge the resulting source and target at the write boundary.
      const verdict = judgeMoveResult(hooks, plan);
      plan.notices.push(...verdict.notices);

      // Step 11: the hook refused.
      if (verdict.refusals.length > 0) {
        // Step 12: where these methods COULD live, asked without throwing.
        const alternatives = this.rankMoveHomes(hooks, from, to, plan);
        // Step 13: the refusal. Nothing has reached disk.
        return {
          moved: false, from, to, methods, edits: [], repointed: 0,
          refusals: verdict.refusals, alternatives, notices: plan.notices,
          summary: refusedMoveSummary(from, to, methods, verdict.refusals, alternatives),
          dryRun, mentions, created: [], carried: [],
        };
      }
    }

    // Step 14: the debt register as the move leaves it — computed, and proven
    // editable without disturbing its formatting, before anything is written.
    const carried = projectConfigRepository.rekeyCarried(rename, true);

    // Inside a hosted request, every spec the move would write — the source,
    // the target, what it creates and every referrer it retargets — is judged
    // against the write reach together, before the first write; the debt
    // register is project configuration, judged at the project rung.
    this.assertMoveInReach(from, to, plan, carried.length > 0);

    // Step 15: the caller wanted the write.
    if (dryRun) {
      // Step 16: the edits it would have made, and not one byte moved.
      const edits = moveChangeReports([...plan.edits.values()], true);
      return {
        moved: false, from, to, methods, edits, repointed,
        refusals: [], alternatives: [], notices: plan.notices,
        summary: `Dry run: moving ${namedMethods(methods)} from "${from}" to "${to}" would touch `
          + `${edits.length} spec${edits.length === 1 ? '' : 's'}${createdClause(plan.created, 'would create')} and re-point ${repointed} reference${repointed === 1 ? '' : 's'}`
          + `${registerClause(carried, 'would rekey')}. Nothing was written.`,
        dryRun: true, mentions, created: plan.created, carried,
      };
    }

    // Steps 17-18: write every edit and then the register, restoring the specs
    // already written if either fails.
    const edits = this.writeMoveEdits([...plan.edits.values()], () => { projectConfigRepository.rekeyCarried(rename); });

    // Step 19: what moved, how many references followed it, and what still
    // names the old home.
    return {
      moved: true, from, to, methods, edits, repointed,
      refusals: [], alternatives: [], notices: plan.notices,
      summary: `Moved ${namedMethods(methods)} from "${from}" to "${to}": ${edits.length} spec`
        + `${edits.length === 1 ? '' : 's'} written${createdClause(plan.created, 'created')}, ${repointed} reference${repointed === 1 ? '' : 's'} re-pointed`
        + `${registerClause(carried, 'rekeyed')}`
        + `${mentions.length ? `, ${mentions.length} still naming the old home in prose or on the wire` : ''}.`,
      dryRun: false, mentions, created: plan.created, carried,
    };
  }

  /** Refuse a method move, naming every subsystem it may not change, before anything is written. */
  private assertMoveInReach(from: string, to: string, plan: MethodMovePlan, rekeysRegister: boolean): void {
    if (!getWriteReach()) return;
    const staged = (kind: string, id: string): { component?: string } | undefined => plan.edits.get(`${kind}:${id}`)?.after;
    const owners = [...plan.edits.values()].flatMap((e) => [e.before, e.after].filter((s) => s !== null && s !== undefined).map((s) => this.specOwner(e.kind, s, staged)));
    if (rekeysRegister) owners.push(this.specOwner('system', null));
    assertSpecWritesPermitted(owners, `moving methods from "${from}" to "${to}"`);
  }

  /**
   * Rekey every lint allow keyed on a moved method, staging each spec it
   * changes like any other reference the move follows. An allow anchored at a
   * moved method on a spec the method left moves to the spec it arrived in; a
   * covered `<from>.<method>` unit anywhere names `<to>.<method>`. An allow
   * whose new home the plan does not stage stays where it is.
   */
  private rekeyMoveAllows(plan: MethodMovePlan, rename: IdentityRename): void {
    const subjects: { kind: WritableSpecKind; id: string; spec: any }[] = [...this.everySpecInTree()];
    for (const edit of plan.edits.values()) if (edit.before === null) subjects.push({ kind: edit.kind, id: edit.id, spec: edit.after });
    const stagedAfter = (kind: WritableSpecKind, id: string): any => plan.edits.get(`${kind}:${id}`)?.after;
    for (const { kind, id, spec } of subjects) {
      if (id.includes('::')) continue;
      const allows = (spec?.lint?.allow ?? []) as LintAllow[];
      if (allows.length === 0) continue;
      const staged = plan.edits.get(`${kind}:${id}`);
      const subject = staged ? staged.after : cloneSpec(spec);
      const kept: LintAllow[] = [];
      let changed = false;
      for (const allow of (subject.lint?.allow ?? []) as LintAllow[]) {
        const next = rekeyAnchor(rename, { spec: id, ...(allow.at !== undefined ? { at: allow.at } : {}), ...(allow.covers ? { covers: allow.covers } : {}) });
        const rekeyed: LintAllow = { ...allow, ...(next.at !== undefined ? { at: next.at } : {}), ...(next.covers ? { covers: next.covers } : {}) };
        if (JSON.stringify(rekeyed) !== JSON.stringify(allow)) changed = true;
        const home = next.spec !== id ? stagedAfter(kind, next.spec) : undefined;
        if (home) {
          home.lint = { ...(home.lint ?? {}), allow: [...(home.lint?.allow ?? []), rekeyed] };
          changed = true;
          continue;
        }
        kept.push(rekeyed);
      }
      if (!changed) continue;
      subject.lint = { ...subject.lint, allow: kept };
      if (!staged) this.stageMoveEdit(plan, kind, id, spec, subject);
    }
  }

  /**
   * Why this move cannot be attempted at all, or null when the request is
   * answerable. Every check here is about what the CALLER named, so its answer
   * is a mistake to correct — never a rule refusing the design.
   */
  private unmovableRequest(
    source: ComponentSpec | null,
    from: string,
    to: string,
    methods: string[],
  ): string | null {
    const chained = [from, to].find((id) => id.includes('::'));
    if (chained) {
      return `"${chained}" lives in a chained subproject; move its methods from that project's own root.`;
    }
    if (!source) return `no component has the id "${from}".`;
    if (!this.loadComponentSpec(to)) return `no component has the id "${to}".`;
    if (from === to) return `"${from}" is both the source and the target; a method cannot move to where it already lives.`;
    if (methods.length === 0) return 'no method names were given.';

    const contracts = this.loadInterfaceSpecs();
    const ofSource = contracts.filter((i) => i.component === from);
    const ofTarget = contracts.filter((i) => i.component === to);

    for (const name of methods) {
      const declaring = ofSource.filter((i) => i.methods.some((m) => m.name === name));
      if (declaring.length === 0) return `no contract of "${from}" declares the method "${name}".`;
      if (declaring.length > 1) {
        return `${declaring.map((i) => `"${i.id}"`).join(' and ')} both declare "${name}" on "${from}" — `
          + 'a move has to know which contract the method leaves, so split or rename them first.';
      }
    }
    const taken = methods.filter((name) => ofTarget.some((i) => i.methods.some((m) => m.name === name)));
    if (taken.length > 0) {
      return `"${to}" already declares ${namedMethods(taken)}.`;
    }

    const receiving = this.moveTargetContract(to, ofTarget);
    if (typeof receiving === 'string') return receiving;
    // name-retired: a name the receiving contract retired cannot be taken
    // again there — a consumer holding the old key would read the arriving
    // method as the renamed one.
    if (receiving) {
      for (const name of methods) {
        const holder = receiving.methods.find((m) => (m.previousNames ?? []).includes(`${receiving.id}.${name}`));
        if (holder) {
          return `name-retired: "${receiving.id}" retired the name "${name}" — its method "${holder.name}" lists "${receiving.id}.${name}" in its previousNames. `
            + 'Unsetting that previousNames releases the name.';
        }
      }
    }

    // A target with no contract receives one, and moved implementation entries
    // with no implementation to arrive in receive one — under ids nothing else
    // may already hold, or the move would overwrite a spec it never read.
    const contractId = receiving?.id ?? `i${to}`;
    const holder = contracts.find((i) => i.id === contractId);
    if (!receiving && holder) {
      return `"${to}" declares no contract, and the one the move would create for it, "${contractId}", is already `
        + `the id of "${holder.component}"'s contract — rename that contract, or give "${to}" its own first.`;
    }
    const implementations = this.loadImplementationSpecs();
    const travelling = implementations.some((impl) =>
      ofSource.some((i) => i.id === impl.contract) && impl.methods.some((m) => methods.includes(m.name)));
    const implId = `${to}_impl`;
    const implHolder = implementations.find((i) => i.id === implId);
    if (travelling && !implementations.some((i) => i.contract === contractId) && implHolder) {
      return `no implementation realizes "${contractId}", and the one the move would create for it, "${implId}", is `
        + `already the id of the implementation of "${implHolder.contract}" — rename it, or realize "${contractId}" first.`;
    }
    return null;
  }

  /**
   * The contract of `to` that receives the methods; null when it declares none
   * yet, so the move creates `i<to>`; or why the choice cannot be decided.
   */
  private moveTargetContract(to: string, ofTarget: InterfaceSpec[]): InterfaceSpec | string | null {
    if (ofTarget.length === 0) return null;
    if (ofTarget.length === 1) return ofTarget[0];
    const named = ofTarget.find((i) => i.id === `i${to}` || i.id.endsWith(`::i${to}`));
    return named ?? `"${to}" declares ${ofTarget.length} contracts and none is named "i${to}", `
      + 'so which one receives the methods is not decidable.';
  }

  /**
   * The whole move as staged edits, computed before anything is written: the
   * contract entries that leave the source and arrive on the target, the
   * implementation entries that travel with them, and the dependencies the
   * moved narratives call that the target does not have yet.
   */
  private planMethodMove(
    source: ComponentSpec,
    to: string,
    methods: string[],
    contracts: InterfaceSpec[],
  ): MethodMovePlan {
    const target = this.loadComponentSpec(to) as ComponentSpec;
    const stated = this.moveTargetContract(to, contracts.filter((i) => i.component === to)) as InterfaceSpec | null;
    const implementations = this.loadImplementationSpecs();
    const plan: MethodMovePlan = {
      edits: new Map(), source, target, reach: [], newDependencies: [], wireBound: [], notices: [], created: [], rehomed: [],
    };
    // The implementations the moved entries leave, re-homed once the receiving
    // implementation is known.
    const leftImplementations: string[] = [];
    // A target with no contract yet receives i<to>, at the status of the
    // contract the methods leave: they arrive as designed as they were.
    const receiving: InterfaceSpec = stated ?? createdContract(target, source.id, methods, contracts);

    const arriving: MethodSignature[] = [];
    const travelling: MethodImplementation[] = [];
    // The file each travelling entry's implementation named as its default —
    // what an entry without a sourcePath of its own is realized in today.
    const realizedIn = new Map<string, string>();

    for (const contract of contracts.filter((i) => i.component === source.id)) {
      const leaving = contract.methods.filter((m) => methods.includes(m.name));
      if (leaving.length === 0) continue;
      // Each arriving entry carries its former key `<source contract>.<name>`
      // in its rename trace, so a consumer reads the move as a move.
      arriving.push(...cloneSpec(leaving).map((m) => ({ ...m, previousNames: [...(m.previousNames ?? []), `${contract.id}.${m.name}`] })));
      // The copy is filtered, never the stored array: `filter` hands back the
      // SAME element objects, so a plan built that way shares its methods with
      // the snapshot a failed write has to restore — and the sweep below, which
      // rewrites in place, would quietly edit both.
      const remaining = cloneSpec(contract);
      remaining.methods = remaining.methods.filter((m) => !methods.includes(m.name));
      this.stageMoveEdit(plan, 'interface', contract.id, contract, remaining);
      plan.rehomed.push({ from: contract.id, to: receiving.id });
      if (contract.methods.length === leaving.length) {
        plan.notices.push(`"${contract.id}" is left with no methods — "${source.id}" no longer declares anything on it.`);
      }
      for (const impl of implementations.filter((i) => i.contract === contract.id)) {
        const moving = impl.methods.filter((m) => methods.includes(m.name));
        if (moving.length === 0) continue;
        travelling.push(...cloneSpec(moving));
        for (const entry of moving) if (impl.sourcePath) realizedIn.set(entry.name, impl.sourcePath);
        const kept = cloneSpec(impl);
        kept.methods = kept.methods.filter((m) => !methods.includes(m.name));
        this.stageMoveEdit(plan, 'implementation', impl.id, impl, kept);
        leftImplementations.push(impl.id);
      }
    }

    this.stageMoveEdit(plan, 'interface', receiving.id, stated, {
      ...cloneSpec(receiving),
      methods: [...cloneSpec(receiving.methods), ...arriving],
    });
    if (!stated) plan.created.push(`interface "${receiving.id}"`);
    if (arriving.some((m) => m.endpoint)) plan.wireBound.push(receiving.id);
    if (stated && receiving.status !== undefined && receiving.status !== statusOfContracts(contracts, source.id)) {
      plan.notices.push(`"${receiving.id}" is ${receiving.status} where the methods came from a ${statusOfContracts(contracts, source.id)} contract — the status of a moved method is the status of its new home.`);
    }
    for (const entry of travelling) {
      if ((entry.narrative ?? []).length === 0 && !entry.intent) {
        plan.notices.push(`"${entry.name}" moves with an empty narrative and no intent — nothing followed it but its name.`);
      }
    }

    const targetImpl = implementations.find((i) => i.contract === receiving.id);
    if (travelling.length > 0 && targetImpl) {
      // An entry that relied on its old implementation's default file would
      // otherwise be realized, silently, in whatever file the target's
      // implementation names. It keeps its file as its own instead.
      for (const entry of travelling) {
        const file = realizedIn.get(entry.name);
        if (entry.sourcePath || !file || file === targetImpl.sourcePath) continue;
        entry.sourcePath = file;
        plan.notices.push(`"${entry.name}" keeps ${file} as its own sourcePath: it was realized there by default, and `
          + `"${targetImpl.id}" names ${targetImpl.sourcePath ? targetImpl.sourcePath : 'no file'} — moving a method is not moving its code.`);
      }
      this.stageMoveEdit(plan, 'implementation', targetImpl.id, targetImpl, {
        ...cloneSpec(targetImpl),
        methods: [...cloneSpec(targetImpl.methods), ...travelling],
      });
      for (const id of leftImplementations) plan.rehomed.push({ from: id, to: targetImpl.id });
    } else if (travelling.length > 0) {
      // No implementation realizes the receiving contract: <to>_impl is
      // created for the entries, so no narrative is lost on the way.
      const created = createdImplementation(target, receiving.id, source.id, travelling, implementations, contracts);
      this.stageMoveEdit(plan, 'implementation', created.spec.id, null, created.spec);
      for (const id of leftImplementations) plan.rehomed.push({ from: id, to: created.spec.id });
      plan.created.push(created.named);
      plan.notices.push(...created.notices);
    }

    // What the moved methods reach once they live on the target. A call back
    // into a method moving with them lands in the same component, so it is
    // reach nobody has to declare.
    plan.reach = reachOf(travelling, source.id, new Set(methods)).filter((id) => id !== to);
    const held = new Set([...(target.dependsOn ?? []), ...(target.owns ?? [])]);
    plan.newDependencies = plan.reach.filter((id) => !held.has(id) && id !== to);

    // Both components are judged as the move leaves them, so both are staged
    // even when the move changes neither — an edit that diffs to nothing is
    // never written.
    this.stageMoveEdit(plan, 'component', source.id, source, cloneSpec(source));
    this.stageMoveEdit(plan, 'component', target.id, target, {
      ...cloneSpec(target),
      dependsOn: [...(target.dependsOn ?? []), ...plan.newDependencies],
    });
    return plan;
  }

  /** Stage one spec's rewrite, keeping the version it started from as the snapshot a failed write restores. */
  private stageMoveEdit(plan: MethodMovePlan, kind: WritableSpecKind, id: string, before: any, after: any): void {
    plan.edits.set(`${kind}:${id}`, { kind, id, before, after });
  }

  /**
   * Re-point every reference that names the old home, through the one
   * reference-field table, and answer with how many followed.
   *
   * A reference is only re-pointed when it names BOTH the old home and a method
   * that is moving: another method of the same component, and another
   * component's method of the same name, stay exactly where they point.
   */
  private repointToNewHome(from: string, to: string, methods: string[], plan: MethodMovePlan): number {
    const moved = new Set(methods);
    let repointed = 0;
    const remap = (ref: string, position: RefPosition, owner?: string): string => {
      if (position !== 'component' || ref !== from || !owner || !moved.has(owner)) return ref;
      repointed += 1;
      return to;
    };

    for (const { kind, id, spec } of this.everySpecInTree()) {
      const staged = plan.edits.get(`${kind}:${id}`);
      const subject = staged ? staged.after : cloneSpec(spec);
      if (!rewriteSpecRefs(subject, remap)) continue;
      if (staged) continue;
      if (id.includes('::')) {
        // A chained subproject is written from its own root, never from here.
        plan.notices.push(`"${id}" lives in a chained subproject and still names "${from}" — re-point it from that project's own root.`);
        repointed -= 1;
        continue;
      }
      this.stageMoveEdit(plan, kind, id, spec, subject);
    }

    // A spec the move creates is not in the tree yet, so the walk above never
    // saw it — but its travelling narratives may call back into a moving method.
    for (const edit of plan.edits.values()) {
      if (edit.before === null) rewriteSpecRefs(edit.after, remap);
    }

    plan.notices.push(...this.callersOwingADependency(to, plan));
    return repointed;
  }

  /**
   * The components that now reach the new home without declaring it. The move
   * re-points the reference; it never edits another component's dependency
   * list, because a dependency nobody judged is exactly what the gate exists to
   * prevent.
   */
  private callersOwingADependency(to: string, plan: MethodMovePlan): string[] {
    const contracts = this.loadInterfaceSpecs();
    const owing = new Set<string>();
    for (const edit of plan.edits.values()) {
      const owner = edit.kind === 'component'
        ? edit.id
        : contracts.find((i) => i.id === (edit.after as ImplementationSpec).contract)?.component;
      if (!owner || owner === to) continue;
      const component = owner === plan.target.id ? plan.target : this.loadComponentSpec(owner);
      if (!component) continue;
      const held = new Set([...(component.dependsOn ?? []), ...(component.owns ?? [])]);
      if (!held.has(to)) owing.add(owner);
    }
    return [...owing].map((id) =>
      `"${id}" now reaches "${to}" but does not declare it — add the dependency, or the call is undeclared.`);
  }

  /**
   * Where these methods could live instead, cheapest legal home first, with the
   * requested target among them so its shortfall reads beside the others.
   *
   * The store enumerates, because the store holds the tree; the hook judges,
   * because the gate holds the judgement. `assess` answers rather than throws,
   * so this is a search and not a sequence of caught exceptions.
   */
  private rankMoveHomes(hooks: SpecWriteHooks, from: string, to: string, plan: MethodMovePlan): MethodMoveCandidate[] {
    const limit = this.dependencyLimit();
    const pool = this.loadComponentSpecs().filter((c) => c.subsystem === plan.source.subsystem && c.id !== from);
    if (!pool.some((c) => c.id === to)) pool.push(plan.target);
    return pool
      .map((candidate) => weighMoveHome(hooks, candidate, plan.reach, limit))
      .sort((a, b) => Number(b.legal) - Number(a.legal)
        || a.newDependencies.length - b.newDependencies.length
        || a.component.localeCompare(b.component));
  }

  /**
   * The project's `maxComponentDependencies`, so a candidate's dependency count
   * can be read without looking up the config. A project that sets none is read
   * against the same default the coupling-health rule applies.
   */
  private dependencyLimit(): number {
    try {
      return projectConfigRepository.load()?.rules?.complexity?.maxComponentDependencies ?? DEFAULT_DEPENDENCY_LIMIT;
    } catch {
      return DEFAULT_DEPENDENCY_LIMIT;
    }
  }

  /** Every spec in the bound tree, with the kind and id a staged edit addresses it by. */
  private *everySpecInTree(): Generator<{ kind: WritableSpecKind; id: string; spec: any }> {
    const system = this.loadSystemSpec();
    if (system) yield { kind: 'system', id: system.name, spec: system };
    for (const spec of this.loadSubsystemSpecs()) yield { kind: 'subsystem', id: spec.id, spec };
    for (const spec of this.loadComponentSpecs()) yield { kind: 'component', id: spec.id, spec };
    for (const spec of this.loadInterfaceSpecs()) yield { kind: 'interface', id: spec.id, spec };
    for (const spec of this.loadImplementationSpecs()) yield { kind: 'implementation', id: spec.id, spec };
    for (const spec of this.loadTypeSpecs()) yield { kind: 'type', id: spec.id, spec };
  }

  /**
   * What still names the old home once the move is written, every one of it
   * left exactly as it was: the specs whose prose carries the id, and the
   * receiving contract whose moved methods keep their wire address. A move
   * never edits prose and never re-addresses an RPC.
   */
  private moveMentions(from: string, plan: MethodMovePlan): string[] {
    const mentions = new Set<string>(plan.wireBound);
    const named = new RegExp(`(?<![A-Za-z0-9_])${from}(?![A-Za-z0-9_])`);
    for (const { kind, id, spec } of this.everySpecInTree()) {
      if (namesInProse(spec, named)) mentions.add(kind === 'system' ? 'system' : id);
    }
    return [...mentions];
  }

  /**
   * Write every staged edit, restoring the ones already written if one fails.
   *
   * The snapshots are the versions the plan started from, so a restore puts the
   * authored content back exactly; only `updatedAt` reads as touched, because
   * the store stamps every write it accepts. Nothing invalidates the cache
   * here: every save does it already, and a second call would only be a hop
   * across a component boundary that no narrative claims.
   */
  private writeMoveEdits(edits: MoveEdit[], finish?: () => void): SpecChangeReport[] {
    const reports = moveChangeReports(edits, false);
    const written: MoveEdit[] = [];
    try {
      for (const report of reports) {
        const edit = edits.find((e) => e.kind === report.kind && e.id === report.id) as MoveEdit;
        report.notices.push(...this.saveMovedSpec(edit.kind, edit.after));
        written.push(edit);
      }
      // The last write of the move — the debt register — inside the same
      // guard, so a register that cannot be written takes the specs back too.
      finish?.();
    } catch (e) {
      for (const edit of [...written].reverse()) {
        try {
          // A spec the move created is taken away again; any other is put back.
          if (edit.before === null) this.delete(edit.kind, edit.id);
          else this.saveMovedSpec(edit.kind, edit.before);
        } catch {
          // A restore that cannot be written is the one thing this cannot fix;
          // the throw below names how far the write got.
        }
      }
      throw new Error(
        `move-write-failed: ${String((e as Error)?.message ?? e)} — `
        + `${written.length} edit${written.length === 1 ? '' : 's'} already written ${written.length === 1 ? 'was' : 'were'} restored, so nothing moved.`,
      );
    }
    return reports;
  }

  /** Persist one moved spec through the store's own writer, and answer with its placement notices. */
  private saveMovedSpec(kind: WritableSpecKind, spec: any): string[] {
    return this.saveOfKind(kind, spec, { allowStatusDemotion: true });
  }
}

// ---------------------------------------------------------------------------
// Method move — the pure half
// ---------------------------------------------------------------------------

/** The dependency ceiling read when a project declares none; the coupling-health rule's own default. */
const DEFAULT_DEPENDENCY_LIMIT = 8;

/**
 * The fields a mention is read from — a spec's prose, wherever it nests: every
 * description, a method's intent, a finding's summary, and a narrative step's
 * own text. A signature, a symbol and a capability are not prose: the move
 * either carries them or leaves them by design.
 */
const PROSE_FIELDS = new Set([
  'description', 'intent', 'summary', 'condition', 'over', 'outcome', 'error', 'note', 'caller',
]);

/**
 * One spec the move rewrites, with the version it started from — the snapshot a
 * failed write restores. `before` is null for a spec the move creates, which a
 * failed write deletes.
 */
interface MoveEdit {
  kind: WritableSpecKind;
  id: string;
  before: any;
  after: any;
}

/** The whole move, computed before anything is written. */
interface MethodMovePlan {
  /** Every spec the move rewrites, keyed `<kind>:<id>`. */
  edits: Map<string, MoveEdit>;
  /** The source component as it stands. */
  source: ComponentSpec;
  /** The target component as it stands. */
  target: ComponentSpec;
  /** The components the moved methods reach once they live on their new home. */
  reach: string[];
  /** The dependencies the target does not have yet but the moved methods call. */
  newDependencies: string[];
  /** Contract ids whose moved methods keep a wire address. */
  wireBound: string[];
  notices: string[];
  /** The specs the move creates, named for the report. */
  created: string[];
  /**
   * Each spec the moved methods left, paired with the spec they arrived in —
   * the source contract with the receiving one, each source implementation
   * with the receiving implementation. How a finding keyed on a moved method
   * follows it.
   */
  rehomed: { from: string; to: string }[];
}

/** A spec copied so the plan can rewrite it without touching what the cache holds. */
/**
 * Marks, during one delta's narrative merge, the jump fields that delta wrote
 * itself — named in the delta's final numbering, so never relocated by its own
 * later inserts and deletes. A symbol, so it can never collide with a spec
 * field, and stripped before the merged narrative leaves the merge.
 */
const DELTA_JUMP_PINS = Symbol('jumps written by this delta');

/**
 * A loaded spec in its STORED form, for a delta to merge onto: an interface's
 * methods through method_signature.storedForm (a sourced method keeps only its
 * source), a type's methods with their derived text. Other kinds, and a
 * missing spec, as they came.
 */
function storedFormOf(kind: WritableSpecKind, spec: StoredSpec | null): StoredSpec | null {
  if (!spec) return spec;
  if (kind === 'interface') {
    const intf = spec as InterfaceSpec;
    return { ...intf, methods: intf.methods.map((m) => storedMethodSignature(m)) } as StoredSpec;
  }
  if (kind === 'type') {
    const type = spec as TypeSpec;
    return { ...type, methods: type.methods.map((m) => storedTypeMethod(m)) } as StoredSpec;
  }
  return spec;
}

/**
 * A merged spec's method texts re-derived in place: every method with params
 * and no signatureFrom shows the text its params derive, whatever text the
 * delta carried. A sourced method is left as merged.
 */
function deriveMergedTexts(kind: WritableSpecKind, merged: Record<string, any>): void {
  if ((kind !== 'interface' && kind !== 'type') || !Array.isArray(merged.methods)) return;
  merged.methods = merged.methods.map((m: any) => {
    if (!m || typeof m !== 'object' || m.signatureFrom !== undefined || !Array.isArray(m.params)) return m;
    const derived = deriveMethodSignature(m);
    return derived === undefined ? m : { ...m, signature: derived };
  });
}

function cloneSpec<T>(spec: T): T {
  return JSON.parse(JSON.stringify(spec)) as T;
}

/** Several method names as one readable list. */
function namedMethods(methods: string[]): string {
  return methods.map((m) => `"${m}"`).join(', ');
}

/** The status the source component's contracts carry, for the note about two homes disagreeing. */
function statusOfContracts(contracts: InterfaceSpec[], component: string): SpecStatus | undefined {
  return contracts.find((i) => i.component === component)?.status;
}

/**
 * The components a set of moved implementation entries reaches — narrative
 * call, register and dispatch targets, and `calls` entries. A reference back
 * into a method moving WITH them lands in the same component, so it is reach
 * nobody has to declare.
 */
function reachOf(entries: MethodImplementation[], from: string, moved: Set<string>): string[] {
  const reach = new Set<string>();
  for (const entry of entries) {
    for (const step of entry.narrative ?? []) {
      const target = (step as { targetComponent?: string }).targetComponent;
      const method = (step as { targetMethod?: string }).targetMethod;
      if (!target) continue;
      if (target === from && method && moved.has(method)) continue;
      reach.add(target);
    }
    for (const call of entry.calls ?? []) {
      const parsed = parseDeclaredCall(call);
      if (!parsed) continue;
      if (parsed.compId === from && moved.has(parsed.methodName)) continue;
      reach.add(parsed.compId);
    }
  }
  return [...reach].sort();
}

/** Whether any prose field this value nests names the old home. */
function namesInProse(value: unknown, named: RegExp): boolean {
  if (Array.isArray(value)) return value.some((v) => namesInProse(v, named));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => (typeof nested === 'string'
    ? PROSE_FIELDS.has(key) && named.test(nested)
    : namesInProse(nested, named)));
}

/** Judge the resulting source and target components; the hook throws to refuse. */
function judgeMoveResult(hooks: SpecWriteHooks, plan: MethodMovePlan): { refusals: string[]; notices: string[] } {
  const refusals: string[] = [];
  const notices: string[] = [];
  for (const resulting of [plan.edits.get(`component:${plan.source.id}`), plan.edits.get(`component:${plan.target.id}`)]) {
    if (!resulting) continue;
    try {
      const raised = hooks.gate?.('component', resulting.after);
      if (raised?.length) notices.push(...raised);
    } catch (e) {
      // The codes, not the exception: `assess` answers the same question the
      // gate just refused, and a refusal that names only its message cannot be
      // read beside a candidate's.
      const codes = hooks.assess?.('component', resulting.after) ?? [];
      refusals.push(...(codes.length ? codes : [String((e as Error)?.message ?? e)]));
    }
  }
  return { refusals: [...new Set(refusals)], notices };
}

/** One candidate home, and what putting the methods there would cost. */
function weighMoveHome(
  hooks: SpecWriteHooks,
  candidate: ComponentSpec,
  reach: string[],
  dependencyLimit: number,
): MethodMoveCandidate {
  const held = new Set([...(candidate.dependsOn ?? []), ...(candidate.owns ?? [])]);
  const newDependencies = reach.filter((id) => id !== candidate.id && !held.has(id));
  const resulting = { ...candidate, dependsOn: [...(candidate.dependsOn ?? []), ...newDependencies] };
  const refusals = hooks.assess?.('component', resulting) ?? [];
  return {
    component: candidate.id,
    legal: refusals.length === 0,
    newDependencies,
    dependencyCount: resulting.dependsOn.length,
    dependencyLimit,
    refusals,
  };
}

/** One change report per staged edit that actually changes something. */
function moveChangeReports(edits: MoveEdit[], dryRun: boolean): SpecChangeReport[] {
  return edits
    .map((edit) => ({ edit, changes: specChanges(edit.before ?? {}, edit.after) }))
    .filter(({ changes }) => changes.length > 0)
    .map(({ edit, changes }) => ({
      kind: edit.kind,
      id: edit.id,
      written: !dryRun,
      dryRun,
      changes,
      ineffective: [],
      notices: [] as string[],
      respellings: [] as TypeRespelling[],
      testsToRevisit: [] as TestsToRevisit[],
      summary: edit.before === null
        ? `${dryRun ? 'Would create' : 'Created'} ${edit.kind} "${edit.id}" to receive the moved methods.`
        : `${dryRun ? 'Would move' : 'Moved'} into ${edit.kind} "${edit.id}": `
          + `${changes.length} change${changes.length === 1 ? '' : 's'}.`,
    }));
}

/**
 * The move as the debt register and the lint allows are keyed by it: each
 * spec the methods left re-homes the findings anchored at a moved method to
 * the spec they arrived in, and `<from>.<method>` becomes `<to>.<method>`
 * wherever a unit names it.
 */
function moveRename(from: string, to: string, methods: string[], plan: MethodMovePlan): IdentityRename {
  return {
    specs: plan.rehomed.map(({ from: left, to: arrived }) => ({ from: left, to: arrived, sites: [...methods] })),
    methods: methods.map((method) => ({ component: from, method, toComponent: to, toMethod: method })),
  };
}

/** The register edits as a clause of the move's summary, or nothing when there were none. */
function registerClause(carried: CarriedRekey[], verb: string): string {
  return carried.length ? `, ${verb} ${carried.length} debt-register key${carried.length === 1 ? '' : 's'}` : '';
}

/** The created specs as a clause of the move's summary, or nothing when it created none. */
function createdClause(created: string[], verb: string): string {
  return created.length ? `, ${verb} ${created.join(' and ')}` : '';
}

/**
 * The contract a target with none receives: `i<to>`, at the status of the
 * contract the methods leave.
 */
function createdContract(target: ComponentSpec, from: string, methods: string[], contracts: InterfaceSpec[]): InterfaceSpec {
  const now = new Date().toISOString();
  const status = statusOfContracts(contracts, from);
  return {
    id: `i${target.id}`,
    name: `${target.name} Interface`,
    description: `The contract of ${target.name}, created by moving ${namedMethods(methods)} here from "${from}".`,
    component: target.id,
    methods: [],
    ...(status ? { status } : {}),
    createdAt: now,
    updatedAt: now,
  } as InterfaceSpec;
}

/**
 * The implementation a receiving contract with none receives: `<to>_impl`, at
 * the status of the implementation the entries leave, inheriting its
 * sourcePath. Entries leaving implementations with DIFFERENT sourcePaths leave
 * the new one's unset instead, and each entry that relied on its old
 * implementation's default keeps that file as its own — never silently realized
 * somewhere else.
 */
function createdImplementation(
  target: ComponentSpec,
  contractId: string,
  from: string,
  travelling: MethodImplementation[],
  implementations: ImplementationSpec[],
  contracts: InterfaceSpec[],
): { spec: ImplementationSpec; named: string; notices: string[] } {
  const ofSource = new Set(contracts.filter((i) => i.component === from).map((i) => i.id));
  const leaving = implementations.filter((impl) => ofSource.has(impl.contract)
    && impl.methods.some((m) => travelling.some((t) => t.name === m.name)));
  const paths = [...new Set(leaving.map((impl) => impl.sourcePath))];
  const inherited = paths.length === 1 ? paths[0] : undefined;
  const notices: string[] = [];
  if (paths.length > 1) {
    for (const entry of travelling) {
      if (entry.sourcePath) continue;
      const home = leaving.find((impl) => impl.methods.some((m) => m.name === entry.name));
      if (home?.sourcePath) entry.sourcePath = home.sourcePath;
    }
    notices.push(`"${target.id}_impl" is created without a sourcePath: the moved entries come from implementations `
      + 'with different ones, so each keeps the file it was realized in as its own sourcePath.');
  }
  const now = new Date().toISOString();
  const status = leaving[0]?.status;
  const spec = {
    id: `${target.id}_impl`,
    name: `${target.name} Implementation`,
    description: `The implementation of ${target.name}, created by moving methods here from "${from}".`,
    contract: contractId,
    ...(inherited ? { sourcePath: inherited } : {}),
    methods: travelling,
    ...(status ? { status } : {}),
    createdAt: now,
    updatedAt: now,
  } as ImplementationSpec;
  const origin = leaving.length === 1 ? ` from "${leaving[0].id}"` : '';
  const named = inherited
    ? `implementation "${spec.id}" (sourcePath ${inherited}, inherited${origin})`
    : `implementation "${spec.id}" (no sourcePath)`;
  return { spec, named, notices };
}

/** The one line a refusal reads by: which rule fired, and the cheapest home that would not. */
function refusedMoveSummary(
  from: string,
  to: string,
  methods: string[],
  refusals: string[],
  alternatives: MethodMoveCandidate[],
): string {
  const cheapest = alternatives.find((c) => c.legal);
  return `Refused: moving ${namedMethods(methods)} from "${from}" to "${to}" is refused by `
    + `${refusals.join(', ')}. Nothing was written. `
    + (cheapest
      ? `The cheapest legal home is "${cheapest.component}" (${cheapest.newDependencies.length} new dependenc`
        + `${cheapest.newDependencies.length === 1 ? 'y' : 'ies'}, ${cheapest.dependencyCount} of ${cheapest.dependencyLimit}).`
      : `No component of this subsystem can take them as they stand — ${alternatives.length} were weighed.`);
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

/** The binding (or, outside any binding, the root) the last read was served under. */
let lastServedBinding: object | string | null = null;

/**
 * The workspace for the current project root (override, else resolved cwd).
 *
 * A new root BINDING expires the workspace's freshness window: the first read
 * inside each runWithProjectRoot / runWithProjectBinding (or, with no binding,
 * after the resolved root changes) re-checks that tree's file signature instead
 * of trusting a scan up to SIGNATURE_TTL_MS old. That is what lets a caller
 * reading another project's tree (a chained child resolving through its parent,
 * a pin projecting the parent's surfaces) see an edit made outside this process
 * without invalidating the cache itself.
 */
function current(): SpecWorkspace {
  const ws = workspaceFor(getProjectRoot());
  const binding = currentRootBinding() ?? ws.rootDir;
  if (binding !== lastServedBinding) {
    lastServedBinding = binding;
    ws.expireFreshness();
  }
  return ws;
}

/**
 * spec_registry.invalidateCache — invalidate every workspace's cache and drop the instances. Invalidation must
 * hit the instances themselves (not just the map) because a workspace method
 * may still be mid-flight holding `this` — e.g. saveComponentSpec invalidates
 * globally and then runs normalizeComponentLayout on the same instance, which
 * must rescan rather than serve its stale index.
 */
function registryInvalidateCache(): void {
  // Invalidate IN PLACE — never clear the registry. A caller holding a
  // workspaceFor() reference (tests, the hosted server's per-project scopes)
  // must keep receiving invalidations; evicting the instance orphaned such
  // references on a permanently-stale index whose path lookups then
  // mis-routed writes into specs/default fallbacks.
  for (const ws of workspaces.values()) ws.invalidate();
}

/** spec_loader.invalidateCache — forwarded 1:1 to the registry write face. */
export function invalidateSpecCache(): void {
  registryInvalidateCache();
}

export function getLoaderIssues(): ValidationIssue[] {
  return current().loaderIssues;
}

export function clearLoaderIssues(): void {
  current().loaderIssues = [];
  invalidateSpecCache();
}

export function scanAllSpecs(options?: SpecScanOptions): SpecIndex {
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

/** ispec_loader.resolveSubsystemExports — one subsystem's resolved export table, forwarded 1:1 to the export index. */
export function resolveSubsystemExports(subsystemId: string): ResolvedExportTable {
  return resolveSubsystemExportTable(subsystemId);
}

/** ispec_loader.resolveProjectExports — a project's resolved L0 export table, forwarded 1:1 to the export index. */
export function resolveProjectExports(project?: string): ResolvedExportTable {
  return resolveProjectExportTable(project);
}

/** ispec_loader.exportUsage — one consumer's references into one producer, forwarded 1:1 to the export index. */
export function exportUsage(consumer: string, producer: string): ExportUsage {
  return exportUsageOf(consumer, producer);
}

/**
 * ispec_loader.pinnedUsage — one consumer's references into a producer the
 * scan did not read, counted by the public name they spell (stage 8),
 * forwarded 1:1 to the export index.
 */
export function pinnedUsage(consumer: string, alias: string): ExportUsage {
  return pinnedUsageOf(consumer, alias);
}

/** ispec_loader.graph — the project graph of the current scan, forwarded 1:1 to the project family index. */
export function graph(): ProjectFamily {
  return projectFamilyGraph();
}

/** ispec_index.listProjectRoots — the project roots the current scan read, bound root first. */
export function listProjectRoots(): ScannedProjectRoot[] {
  return current().listProjectRoots();
}

export function saveTypeSpec(spec: TypeSpec): string[] {
  return current().saveTypeSpec(spec);
}

export function dryRunSerializeSpecs(include?: (specId: string) => boolean): ValidationIssue[] {
  return current().dryRunSerializeSpecs(include);
}

/** Project the current project's spec tree into a level-filtered WebGraphModel,
 *  forwarded to the architecture diagrams component's pure graph projection
 *  (core_orchestrator → architecture_diagrams). */
export function buildProjectGraph(level: number): WebGraphModel {
  return buildGraphModel(level);
}

/**
 * Report whether the CURRENTLY BOUND project root is a chained subproject of a
 * parent project (parent root + mounting subsystem id), or null for a genuine
 * top root (icore_orchestrator/icore_portal.resolveChainingParent). Read-only
 * detection through the spec loader's chaining walk — never rebinds, never
 * mutates.
 *
 * Reach: the parent is out of bounds for a hosted request whose credential is
 * narrowed to the child, and so is anything above the request's top project
 * root — both answer null, exactly as a top root would, and neither is so much
 * as probed: a narrowed request returns before the walk, and every other walk
 * stops at the request's top root. Every caller that reads above the bound root
 * through here (validation, surface freshness, pinning, the bind-time
 * announcement) inherits the gate instead of having to remember it.
 */
export function resolveChainingParent(): ChainingParentRef | null {
  const reach = getRequestParentReach();
  if (reach && !reach.parentReach) return null;
  return findChainingParent(getProjectRoot(), reach?.topRoot);
}

/**
 * Reduce a stored surface snapshot to its content key: provenance (stateId,
 * generatedAt, origin) stripped, then canonicalized so YAML key order never
 * moves the identity. Mirrors `surfaceContentKey` in src/core/surfaces.ts, but
 * lives here rather than being imported from it — sdd_core must not depend on
 * sdd_surfaces, and importing that module would cycle straight back through
 * this one.
 */
function snapshotInputKey(snapshot: SurfaceSnapshot): string {
  const { stateId, generatedAt, origin, ...content } = snapshot;
  return canonicalize(content);
}

/**
 * The snapshots stored in one directory, reduced to content keys that name
 * their kind. A malformed file is skipped exactly as the surface repository's
 * own listSnapshots skips one — a corrupt pin never blocks (or silently
 * varies) the gate identity.
 */
function snapshotInputsIn(dir: string, kind: 'surface' | 'external'): string[] {
  if (!pathExists(dir)) return [];
  const keys: string[] = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    try {
      keys.push(`${kind}:${snapshotInputKey(SurfaceSnapshotSchema.parse(readYamlFile(path.join(dir, file))))}`);
    } catch {
      // A malformed snapshot never aborts the read — it simply is not a consumed input.
    }
  }
  return keys;
}

/**
 * Every consumed contract input a project root holds: its stored surface
 * snapshots under .wai/surfaces, its pinned external snapshots under
 * .wai/externals, and its .wai/externals.lock.yaml canonicalized whole — its
 * digests and `used` map are what a verdict consults. Each key names its kind,
 * so equal content in two kinds never collides. Read locally: the snapshot and
 * lock files are modelled in sdd_surfaces, which sdd_core must not depend on.
 */
function consumedSurfaceInputsAt(rootDir: string): string[] {
  const keys = [
    ...snapshotInputsIn(path.join(rootDir, '.wai', 'surfaces'), 'surface'),
    ...snapshotInputsIn(path.join(rootDir, '.wai', 'externals'), 'external'),
  ];
  const lock = path.join(rootDir, '.wai', 'externals.lock.yaml');
  if (pathExists(lock)) {
    try {
      keys.push(`lock:${canonicalize(readYamlFile(lock))}`);
    } catch {
      // A malformed lock never aborts the read — it simply is not a consumed input.
    }
  }
  return keys;
}

/**
 * The consumed contract inputs a verdict at the bound project can consult
 * (icore_orchestrator/icore_portal.consumedContractInputs): THIS root's stored
 * surface snapshots, pinned external snapshots and externals lock, as
 * canonical content keys. A member's inputs are left out since stage 5: they
 * are that member's own gate's, and reach this project's gate identity through
 * the member's composition subject. The gate identity covers them, so swapping
 * a pinned contract invalidates a lock.
 */
export function consumedContractInputs(): string[] {
  return consumedSurfaceInputsAt(getProjectRoot());
}

/** Whether a lock is in force, void, or absent. */
export type LockState = 'unlocked' | 'locked' | 'stale';

/**
 * The resolved verdict on a project's lock, plus the evidence it was decided
 * from. `stale` covers a record the design or anything it was approved under
 * moved past — and a record taken under an earlier gate identity algorithm
 * (lockUpgraded).
 */
export interface LockStatus {
  state: LockState;
  /** The persisted record, or null when the project was never locked. */
  record: LockRecord | null;
  /** The gate identity the caller computed now — what `state` was decided against. */
  current: StateId;
}

/**
 * Resolve the project's lock into one of three honest states, comparing the
 * recorded gate identity against the one the caller computed now
 * (validator_portal.computeGateStateId) — or, for a format-2 record, against
 * its asRecorded reading. Nothing is hashed here: the gate
 * identity is the validator's, because the doctrine it covers is the
 * validator's rule set.
 *
 * The ONE authority for the question "is this project locked?". Before this, the
 * promote gate compared StateIds while the project config view answered from the mere
 * EXISTENCE of a record — so a project whose specs changed after locking still
 * reported itself locked, and the freeze it claimed did not exist. Two answers to
 * one question is how a time-of-check gap gets reintroduced after being closed, so
 * every caller now shares this.
 */
export function readLockState(current: StateId): LockStatus {
  const record = readLockRecord();
  if (!record) return { state: 'unlocked', record: null, current };
  // A format-2 record is judged under its own algorithm: current.asRecorded
  // is the same gate identity recomputed the way that record was taken, so a
  // lock taken before code linkage left the approval stays valid as long as
  // nothing it covered moved.
  const holds = stateIdEquals(record.stateId, current) || stateIdEquals(record.stateId, current.asRecorded);
  return { state: holds ? 'locked' : 'stale', record, current };
}

/**
 * core_orchestrator.writeLockRecord — the lock record written through the lock
 * store. The approval portal publishes THIS function, so a Portal never reaches
 * the store's write itself: writes route through the Orchestrator.
 */
export function writeLockRecord(record: LockRecord): void {
  persistLockRecord(record);
}

/**
 * core_orchestrator.renderDiagram — the spec tree rendered in the requested
 * format by the architecture diagrams, with the relation health passed through
 * (only the canvas draws it). The spec tree portal publishes this function.
 */
export function renderDiagram(format: DiagramFormat, relations?: ProjectRelations[]): string {
  return renderArchitectureDiagram(format, relations);
}

/**
 * lock_status.upgraded — whether a stale verdict comes from the identity itself
 * changing shape rather than from anything it covers: the state is stale and
 * the record's algorithm differs from the current one. A lock taken before
 * stage 5 answers true — every lock reads stale once, and a surface that says
 * so can tell the human that nothing in the design is KNOWN to have moved.
 * Pure over the status's own fields.
 */
export function lockUpgraded(status: LockStatus): boolean {
  return status.state === 'stale' && !!status.record && status.record.stateId.algorithm !== status.current.algorithm;
}

// ---------------------------------------------------------------------------
// Project configuration writes (icore_orchestrator createProjectConfig …
// markSelectionsBundled). Each is one intent-level write through the project
// config Repository, the only way into .wai/project.yaml. The core portal
// routes every published configuration write through here.
// ---------------------------------------------------------------------------

/** Write a fresh configuration for a project that has none; refuses when one exists. */
export function createProjectConfig(config: ProjectConfig): void {
  projectConfigRepository.create(config);
}

/** Select a pack by name, moving a re-selected pack last; returns whether an earlier selection was replaced. */
export function upsertPackSelection(selection: PackSelection): boolean {
  return projectConfigRepository.upsertPackSelection(selection);
}

/** Deselect a pack by name, leaving path references alone; returns whether anything was dropped. */
export function removePackSelection(packName: string): boolean {
  return projectConfigRepository.removePackSelection(packName);
}

/** Set the governing `projectType`. */
export function setProjectType(projectType: string): void {
  projectConfigRepository.setProjectType(projectType);
}

/** Set the project's human-readable `name` and, when given, its `description`. */
export function describeProject(name: string, description?: string): void {
  projectConfigRepository.describeProject(name, description);
}

/**
 * core_orchestrator.setNetwork — declare (or, with null, remove) the bound
 * project's network, through the project config Repository. Returns whether
 * it wrote.
 */
export function setNetwork(network: NetworkDeclaration | null): boolean {
  return projectConfigRepository.setNetwork(network);
}

/** Record the profile selection hosted policy applied. */
export function recordProfileSelection(selection: ProjectProfileSelection): void {
  projectConfigRepository.recordProfileSelection(selection);
}

/** Set `execution.tier`. */
export function setExecutionTier(tier: string): void {
  projectConfigRepository.setExecutionTier(tier);
}

/** Register a legacy pack path reference when it is absent; returns whether it was added. */
export function registerPackRef(ref: string): boolean {
  return projectConfigRepository.registerPackRef(ref);
}

/** Drop a legacy pack path reference that matches exactly; returns whether anything was dropped. */
export function deregisterPackRef(ref: string): boolean {
  return projectConfigRepository.deregisterPackRef(ref);
}

/** Record bundled packs on their selections in place, in one write. */
export function markSelectionsBundled(bundled: PackSelection[]): void {
  projectConfigRepository.markSelectionsBundled(bundled);
}

/**
 * Declare the bound project's id through the project config Repository:
 * refused for a malformed id or when a different id is already declared, a
 * no-op when the same one is. Returns whether it wrote.
 */
export function setProjectId(id: string): boolean {
  return projectConfigRepository.setId(id);
}

/**
 * Declare one external of the bound project under an alias through the project
 * config Repository: refused for a malformed alias or producer id, or when the
 * alias holds a different declaration, a no-op when it holds the same one.
 * Returns whether it wrote.
 */
export function declareExternal(alias: string, declaration: ExternalDeclaration): boolean {
  return projectConfigRepository.declareExternal(alias, declaration);
}

/**
 * core_orchestrator.importNames — add public names to the `use` of the bound
 * project's external or member under an alias, through the project config
 * Repository: refused for a malformed name or an undeclared alias, a no-op for
 * names already imported. Returns whether it wrote.
 */
export function importNames(alias: string, names: string[]): boolean {
  return projectConfigRepository.importNames(alias, names);
}

/**
 * core_orchestrator.renameProjectId — move the bound project's id through the
 * project config Repository, the old one kept in previousIds: refused for a
 * malformed new id or when the project no longer answers to the old one, a
 * no-op once done. The rename migration's write; it touches no reference and
 * no lock. Returns whether it wrote.
 */
export function renameProjectId(from: string, to: string): boolean {
  return projectConfigRepository.renameId(from, to);
}

/** core_orchestrator.renameAlias — rekey one member or external alias of the bound project, value and place kept. Returns whether it wrote. */
export function renameAlias(from: string, to: string): boolean {
  return projectConfigRepository.renameAlias(from, to);
}

/** core_orchestrator.repointExternal — revise one external's producer id and explicit source, `use` and description kept. Returns whether it wrote. */
export function repointExternal(alias: string, project: string | null, source: ExternalSource | null): boolean {
  return projectConfigRepository.repointExternal(alias, project, source);
}

/** core_orchestrator.removeExternal — remove one external declaration of the bound project. Returns whether it wrote. */
export function removeExternal(alias: string): boolean {
  return projectConfigRepository.removeExternal(alias);
}

/** core_orchestrator.removeMember — remove one member declaration of the bound project, its directory left as it is. Returns whether it wrote. */
export function removeMember(alias: string): boolean {
  return projectConfigRepository.removeMember(alias);
}

/**
 * Compute the CURRENT spec-tree state hash of the project at the given root
 * (icore_orchestrator/icore_portal.computeStateIdAt). The root is bound
 * strictly READ-ONLY for the duration of the computation via the async-scoped
 * project-root binding, which restores the previous binding unconditionally —
 * also on failure paths. Returns null when the root holds no loadable spec
 * tree.
 */
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

export function specPathsInScope(scopeSubsystem?: string): string[] {
  return current().specPathsInScope(scopeSubsystem);
}

export function snapshotSpecFiles(): Map<string, string> {
  return current().snapshotSpecFiles();
}

/** ispec_loader.signatureFacts — forwarded 1:1 to the index read face. */
export function signatureFacts(): SignatureFacts {
  return current().signatureFacts();
}

/** ispec_loader.typeSpellingFacts — forwarded 1:1 to the index read face. */
export function typeSpellingFacts(): TypeSpellingFacts {
  return current().typeSpellingFacts();
}

/** ispec_loader.retiredReachFacts — forwarded 1:1 to the index read face. */
export function retiredReachFacts(): RetiredReachFact[] {
  return current().retiredReachFacts();
}

/** Restore files captured by snapshotSpecFiles(). Caller invalidates the cache. */
export function restoreSpecFiles(snapshot: Map<string, string>): void {
  for (const [file, content] of snapshot) {
    fs.writeFileSync(file, content);
  }
}

export function findLegacySpecFiles(): LegacySpecFile[] {
  return current().findLegacySpecFiles();
}

/**
 * core_orchestrator.findOrphanedSpecFiles — the bound tree's spec files left
 * standing while its specs folder holds no L0: what `validate` and
 * `lock-check` report as an error instead of reading the tree as empty.
 */
export function findOrphanedSpecFiles(): string[] {
  return current().findOrphanedSpecFiles();
}

/**
 * spec_loader.loadSpec / icore_orchestrator.loadSpec — one stored spec of the
 * named kind in the bound tree, or null: for a caller that holds the kind as
 * data. The L0 is a singleton, so its id is informational.
 */
export function loadSpec(kind: WritableSpecKind, id: string): StoredSpec | null {
  const workspace: SpecWorkspace = current();
  return workspace.load(kind, id);
}

/**
 * spec_loader.saveSpec / icore_orchestrator.saveSpec — persist one spec through
 * the typed writer of its kind and answer with its placement notices. Ungated:
 * the authoring seam judges before it calls this.
 */
export function saveSpec(kind: WritableSpecKind, spec: StoredSpec): string[] {
  const workspace: SpecWorkspace = current();
  return workspace.save(kind, spec);
}

/**
 * spec_loader.deleteSpec / icore_orchestrator.deleteSpec — delete one spec
 * document of the named kind; false when none was stored. The L0 is refused.
 */
export function deleteSpec(kind: WritableSpecKind, id: string): boolean {
  const workspace: SpecWorkspace = current();
  return workspace.delete(kind, id);
}

export function updateSpec(
  kind: WritableSpecKind,
  id: string,
  delta: Record<string, any>,
  hooks?: SpecWriteHooks,
  dryRun?: boolean,
): SpecChangeReport {
  return current().updateSpec(kind, id, delta, hooks, dryRun);
}

/**
 * icore_orchestrator.moveMethods — move contract methods from one component to
 * another in the bound tree, and every reference with them. All-or-nothing: a
 * failed write restores what it already wrote, because a half-moved method
 * leaves callers naming a home it no longer has.
 */
/** spec_loader.deleteMount — forwarded 1:1 to the registry write face. */
export function deleteMount(alias: string): boolean {
  return current().removeLegacyMount(alias);
}

/** spec_loader.normalizeReferences — forwarded 1:1 to the registry write face. */
export function normalizeReferences(kind: WritableSpecKind, id: string): boolean {
  return current().writeCanonicalReferences(kind, id);
}

/** spec_loader.rewriteReferences — forwarded 1:1 to the registry write face. */
export function rewriteReferences(kind: WritableSpecKind, id: string, edits: ReferenceEdit[]): boolean {
  return current().respellReferences(kind, id, edits);
}

/**
 * Inside a hosted request, judge every spec a multi-spec write would change —
 * by kind and id, as the loader keys them — against the request's write reach
 * before the first write, refusing (SubsystemWriteDenied) with every subsystem
 * it may not change named. `projectRung` adds a write of project configuration
 * (the debt register). Outside a hosted request nothing is judged.
 */
/**
 * core_orchestrator.crossProjectWriteRefusal — the project boundary of every
 * authored write: the sentence refusing a write any of whose targets lives in
 * another project (a member's spec, or one named through an external's alias),
 * naming that project's folder and the call to make in a session there; or
 * undefined when every target is the bound project's own. Reads only.
 */
export function crossProjectWriteRefusal(targets: { kind: string; id: string }[], tool: string): string | undefined {
  return current().crossProjectWriteRefusal(targets, tool);
}

export function assertSpecsInReach(targets: { kind: string; id: string }[], what: string, projectRung = false): void {
  if (!getWriteReach()) return;
  const ws = current();
  const writable = ['system', 'subsystem', 'component', 'interface', 'implementation', 'type'];
  const owners = targets.map((t) => ws.specOwner(t.kind, t.kind === 'system' ? null
    : (writable.includes(t.kind) ? ws.load(t.kind as WritableSpecKind, t.id) as { id: string } | null : null) ?? { id: t.id }));
  if (projectRung) owners.push(ws.specOwner('system', null));
  assertSpecWritesPermitted(owners, what);
}

export function moveMethods(
  from: string,
  to: string,
  methods: string[],
  hooks?: SpecWriteHooks,
  dryRun?: boolean,
): MethodMoveReport {
  return current().moveMethods(from, to, methods, hooks, dryRun);
}
