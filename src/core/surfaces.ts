import * as fs from 'fs';
import * as path from 'path';
import { getHostedLookup, getProjectRoot, getRequestParentReach, runWithProjectRoot } from '../utils/fs.js';
import { canonicalize, compareOrdinal } from '../utils/canonical-json.js';
import { parseYaml, readYamlFile, writeYamlFile } from '../utils/yaml.js';
import { safeFilenamePart } from '../utils/filenames.js';
import {
  SurfaceSnapshot,
  SurfaceSnapshotSchema,
  SurfaceContractEntry,
  SurfaceTypeDef,
  SurfaceOrigin,
  SURFACE_AUDIENCES,
  NamedOpenApiSpec,
  TypeSpec,
  ComponentSpec,
  InterfaceSpec,
  ResolvedExport,
  effectiveProjectId,
  writtenTypeRefs,
  matchTypeRef,
  methodTypeRefs,
  isTypeVocabulary,
  canonicalTypeRef,
  contentDigest,
  memberDigest,
  carriedFactChanges,
  surfaceChanges,
  type SurfaceChange,
  declaredExternals,
  declaredMembers,
  type PinnedExternal,
  type ExportUsage,
  type CrossProjectReference,
  type ExternalBinding,
  type ExternalConsumer,
  type ExternalListing,
  type ExternalLockEntry,
  type ExternalPin,
  type ExternalStatus,
  type ExternalUseStatus,
  type ExternalsLock,
  type PinnedParent,
  type ResolvedExternal,
  isPart,
  type DesignApproval,
  type DesignExport,
} from '../models/index.js';
// surfaces_core_adapter: every name this subsystem takes from sdd_core lands on
// the adapter's own module, which re-exports it from the core portals.
import {
  loadSystemSpec,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadTypeSpecs,
  computeStateId,
  resolveProjectExports,
  loadProjectConfig,
  resolveExternals,
  excerptParent,
  listExternalConsumers,
  getLoaderIssues,
  approvedRevision,
} from './adapters/surfaces-core.js';
// The pinned-externals aggregate (externals_repository): the lock and the
// snapshots it names, apart from the legacy .wai/surfaces snapshots.
import { externalsRepository } from './externals.js';
import { fromOpenApi, isOpenApiDocument, toOpenApiSet } from './openapi.js';
// design_exporter: the design export's projector, beside the snapshot's.
import { exportDesign as projectDesign } from './design-export.js';

// ---------------------------------------------------------------------------
// Public Surface Exchange (sdd_surfaces)
//
// Contract-grade, portable public-surface snapshots. One artifact, three
// origins: generated (own family — written into chained children), exchanged
// (another wairon project), authored (an external 3rd-party system, declared
// by hand or imported from OpenAPI). The core semantic of the whole feature:
// an Adapter consumes a DECLARED surface — org governance layers on top.
// ---------------------------------------------------------------------------

const SURFACES_DIRNAME = 'surfaces';

function surfacesDir(rootDir: string): string {
  return path.join(rootDir, '.wai', SURFACES_DIRNAME);
}

/** Ascending reach rank of an audience level; unknown levels rank as 'instance'. */
export function audienceRank(audience: string | undefined): number {
  const idx = (SURFACE_AUDIENCES as readonly string[]).indexOf(audience ?? 'instance');
  return idx === -1 ? (SURFACE_AUDIENCES as readonly string[]).indexOf('instance') : idx;
}

export function stateIdString(): string {
  const s = computeStateId();
  return `${s.algorithm}:${s.digest}`;
}

// ---------------------------------------------------------------------------
// Projection (surface_projector)
// ---------------------------------------------------------------------------

/** A type's qualified id: its subsystem-qualified id when it has an owner, else its id. */
function qualifiedTypeId(spec: TypeSpec): string {
  return spec.subsystem && !spec.id.startsWith(`${spec.subsystem}::`) ? `${spec.subsystem}::${spec.id}` : spec.id;
}

/**
 * Transitive type closure: every type reachable from the exported method
 * signatures (params + returns) and from the exported types, following field
 * type references. The snapshot must be self-contained — types are the one
 * sanctioned cross-boundary "internal", so a consumer's type resolution has
 * to work without the producing tree.
 *
 * Types are gathered by QUALIFIED id: two subsystems that each own a type of
 * one name both arrive, where keying on the bare id kept whichever matched
 * first and silently dropped the other. The first keeps its id; a later one
 * with the same id is written under its qualified id, so no two definitions
 * in one snapshot share an id.
 */
function computeTypeClosure(entries: SurfaceContractEntry[], types: TypeSpec[], exported: TypeSpec[] = []): SurfaceTypeDef[] {
  const included = new Map<string, TypeSpec>();
  const queue: string[] = [];

  const include = (spec: TypeSpec): void => {
    const key = qualifiedTypeId(spec);
    if (included.has(key)) return;
    included.set(key, spec);
    queue.push(key);
  };
  const enqueueRef = (ref: string): void => {
    if (isTypeVocabulary(ref)) return;
    for (const spec of types) {
      if (matchTypeRef(ref, qualifiedTypeId(spec))) include(spec);
    }
  };

  for (const spec of exported) include(spec);
  for (const entry of entries) {
    for (const m of entry.methods) {
      for (const ref of methodTypeRefs(m)) enqueueRef(ref);
    }
  }
  while (queue.length) {
    const spec = included.get(queue.shift()!)!;
    // The named types each parsed type expression references (type_expression.namedRefs).
    for (const field of spec.fields) {
      for (const ref of writtenTypeRefs(field.type, 'field')) enqueueRef(ref);
    }
    // A signature type's closure runs through its params and returns, as a data type's runs through its fields.
    for (const param of spec.params ?? []) {
      for (const ref of writtenTypeRefs(param.type, 'signature-param')) enqueueRef(ref);
    }
    if (spec.returns) {
      for (const ref of writtenTypeRefs(spec.returns, 'signature-returns')) enqueueRef(ref);
    }
  }

  const usedIds = new Set<string>();
  return [...included.entries()].map(([qualified, t]) => {
    const id = usedIds.has(t.id) ? qualified : t.id;
    usedIds.add(id);
    const describe = <V extends { name: string; type: string; description?: string; optional?: boolean }>(v: V) => ({
      name: v.name,
      type: v.type,
      ...(v.description ? { description: v.description } : {}),
      ...(v.optional ? { optional: true } : {}),
    });
    return {
      id,
      name: t.name,
      kind: t.kind,
      fields: t.fields.map(describe),
      // A signature type travels complete: its params and returns with it.
      ...(t.kind === 'signature'
        ? { params: (t.params ?? []).map(describe), returns: t.returns ?? 'any' }
        : {}),
      // An enum travels with its values, in declared order.
      ...(t.kind === 'enum'
        ? { values: (t.values ?? []).map(v => ({ name: v.name, ...(v.description ? { description: v.description } : {}) })) }
        : {}),
      // A named scalar travels with the primitive it holds.
      ...(t.holds !== undefined ? { holds: t.holds } : {}),
      // Its own methods (checked constructors, pure operations) travel with it — carried, never digested.
      ...(t.methods && t.methods.length
        ? { methods: t.methods.map((m) => ({ name: m.name, signature: m.signature, ...(m.params ? { params: m.params.map(describe) } : {}), returns: m.returns, ...(m.description ? { description: m.description } : {}) })) }
        : {}),
      // A renamed type travels with its rename trace — provenance, outside every digest.
      ...formerlyOf(t.previousIds, t.id),
    };
  });
}

/** The last segment of a possibly-qualified id: the name a public table spells it by. */
function lastSegment(id: string): string {
  return id.split('::').pop() ?? id;
}

/**
 * A rename trace as a snapshot carries it (`formerly`): the former names, each
 * by its last segment, deduplicated in order, without the current name; no
 * field at all when nothing was renamed. Provenance, never signature — it
 * enters neither memberDigest nor contentDigest, so carrying it moves no pin.
 */
function formerlyOf(trace: readonly string[] | undefined, current: string): { formerly?: string[] } {
  const now = lastSegment(current);
  const names = [...new Set((trace ?? []).map(lastSegment))].filter((n) => n !== now);
  return names.length ? { formerly: names } : {};
}

/** The effective id of the bound project, when it has a configuration to take one from. */
function boundProjectId(): string | undefined {
  try {
    const config = loadProjectConfig();
    return config ? effectiveProjectId(config) ?? undefined : undefined;
  } catch {
    // A configuration that fails its schema is reported by the paths that
    // load it; the snapshot simply records no id.
    return undefined;
  }
}

/** One component export as a contract entry: the canonical target's contract, under its public name. */
function contractEntry(entry: ResolvedExport, comp: ComponentSpec, interfaces: InterfaceSpec[]): SurfaceContractEntry {
  const methods = interfaces
    .filter(i => i.component === comp.id && (!entry.interface || i.id === entry.interface))
    .flatMap(i => i.methods)
    // The loaded tree carries every method resolved: a sourced method already
    // holds its source's params and returns inline, so the snapshot drops the
    // signatureFrom — it names no producer-internal method. A rename trace
    // travels as `formerly` (each former key's method name), which no digest
    // reads: a renamed method moves no digest beyond the name it changed.
    .map(({ signatureFrom: _source, previousNames: trace, ...method }) => ({
      ...method,
      ...formerlyOf(trace?.map((key) => key.slice(key.lastIndexOf('.') + 1)), method.name),
    }));
  // The entry's own rename trace: the former public names, when the public
  // name is the one the narrowed interface's (else the component's) id gives —
  // an export renamed with `as` keeps its public name through a rename.
  const named = entry.interface ? interfaces.find((i) => i.id === entry.interface) : comp;
  const derived = lastSegment(entry.interface ?? comp.id) === entry.publicName;
  return {
    id: entry.publicName,
    name: entry.name ?? comp.name,
    audience: entry.audience ?? 'instance',
    type: entry.type ?? 'Custom',
    component: comp.id,
    methods,
    ...(comp.dispatch && comp.dispatch.length ? { dispatch: comp.dispatch } : {}),
    // Project the backing Portal's auth + basePath so the codec can emit
    // OpenAPI security + per-portal servers self-contained from the snapshot.
    ...(comp.auth && comp.auth.scheme !== 'none' ? { auth: comp.auth } : {}),
    ...(comp.basePath ? { basePath: comp.basePath } : {}),
    // The backing Portal's transport and abi, so a consumer tells a library
    // (InProcess, called directly) from a network or local surface, and the
    // entry's role (call, the default, or implement). Carried, never digested:
    // a pin taken before they were carried lacks them and reads as derived,
    // never as drifted (contentDigest and memberDigest leave them out).
    ...(comp.componentType === 'Portal' && comp.transport ? { transport: comp.transport } : {}),
    ...(comp.componentType === 'Portal' && comp.abi ? { abi: comp.abi } : {}),
    ...(entry.role ? { role: entry.role } : {}),
    details: entry.details ?? '',
    ...(entry.version ? { version: entry.version } : {}),
    ...(entry.stability ? { stability: entry.stability } : {}),
    componentType: comp.componentType,
    ...(entry.interface ? { interface: entry.interface } : {}),
    ...(derived ? formerlyOf(named?.previousIds, entry.publicName) : {}),
  };
}

/**
 * Project the own tree's resolved L0 export table into a contract-grade
 * snapshot. `maxAudience` is the consumer's distance class: an entry is
 * included when its declared reach covers that distance (rank(entry) >=
 * rank(maxAudience)). The family ceiling 'project' therefore includes
 * everything. Every re-export was followed to its canonical target by the
 * export index, so each entry carries its target's contract under its public
 * name, and a consumer never walks the producer's chain.
 */
export function projectOwnSurface(maxAudience: string): SurfaceSnapshot {
  // Step 1: the L0 (its name keys the snapshot).
  const system = loadSystemSpec();
  if (!system) {
    throw new Error('Cannot project a surface: the L0 system spec is missing.');
  }
  // Steps 2-5: the resolved table and the specs its targets name.
  const table = resolveProjectExports();
  const components = loadComponentSpecs();
  const interfaces = loadInterfaceSpecs();
  const types = loadTypeSpecs();

  // Step 6: the entries at or below the audience ceiling.
  const floor = audienceRank(maxAudience);
  const visible = table.entries.filter(e => audienceRank(e.audience ?? 'instance') >= floor);

  // Steps 7-8: each component entry's canonical contract, with its auth and basePath.
  const entries: SurfaceContractEntry[] = [];
  for (const entry of visible) {
    if (entry.kind !== 'component') continue;
    const comp = components.find(c => c.id === entry.component);
    if (comp) entries.push(contractEntry(entry, comp, interfaces));
  }

  // Step 9: exported types listed apart, and the closure over both.
  const exportedTypes = visible.filter(e => e.kind === 'type');
  const exportedSpecs = exportedTypes
    .map(e => types.find(t => t.id === e.typeDef && (t.subsystem ?? e.source) === e.source))
    .filter((t): t is TypeSpec => !!t);
  const closure = computeTypeClosure(entries, types, exportedSpecs);
  const closureIdOf = (e: ResolvedExport): string => {
    const spec = types.find(t => t.id === e.typeDef && (t.subsystem ?? e.source) === e.source);
    if (!spec) return String(e.typeDef);
    return closure.some(d => d.id === qualifiedTypeId(spec)) ? qualifiedTypeId(spec) : spec.id;
  };

  // Steps 10-12: the project's id, the StateId, and the stamp — with the
  // producer's targetLanguage, what a consumer in another language judges a
  // native-ABI library call against.
  const projectId = boundProjectId();
  const targetLanguage = system.targetLanguage?.trim().toLowerCase();
  // The public names the L0 declares that no longer resolve (a named
  // re-export whose source dropped or renamed the item): provenance a
  // consumer that used one is told, outside every digest.
  const unresolvedExports = table.problems
    .filter((p) => p.kind === 'invalid' && p.publicName !== undefined && p.source !== undefined
      && !table.entries.some((e) => e.publicName === p.publicName))
    .map((p) => ({ id: p.publicName!, source: p.source!, ...(p.renamedTo ? { renamedTo: p.renamedTo } : {}) }));
  return canonicalReferences(SurfaceSnapshotSchema.parse({
    projectName: system.name,
    ...(projectId ? { projectId } : {}),
    ...(targetLanguage ? { targetLanguage } : {}),
    origin: 'generated',
    stateId: stateIdString(),
    generatedAt: new Date().toISOString(),
    interfaces: entries,
    types: closure,
    ...(exportedTypes.length
      ? { exportedTypes: exportedTypes.map(e => ({ id: e.publicName, type: closureIdOf(e), audience: e.audience ?? 'instance' })) }
      : {}),
    ...(unresolvedExports.length ? { unresolvedExports } : {}),
  }));
}

/**
 * The snapshot with every type reference inside it — parameter and return
 * types, the display signature, and every closure field — written in its
 * canonical form (surface_snapshot.canonicalTypeRef), never as the author
 * spelled it: restating a reference in another legal spelling changes no byte.
 */
function canonicalReferences(snapshot: SurfaceSnapshot): SurfaceSnapshot {
  const canon = (expr: string): string => canonicalTypeRef(snapshot, expr);
  return {
    ...snapshot,
    interfaces: snapshot.interfaces.map((entry) => ({
      ...entry,
      methods: entry.methods.map((m) => ({
        ...m,
        signature: canon(m.signature),
        returns: canon(m.returns),
        ...(m.params ? { params: m.params.map((p) => ({ ...p, type: canon(p.type) })) } : {}),
      })),
    })),
    types: snapshot.types.map((def) => ({
      ...def,
      fields: def.fields.map((f) => ({ ...f, type: canon(f.type) })),
      ...(def.params ? { params: def.params.map((p) => ({ ...p, type: canon(p.type) })) } : {}),
      ...(def.returns !== undefined ? { returns: canon(def.returns) } : {}),
      ...(def.methods ? { methods: def.methods.map((m) => ({ ...m, returns: canon(m.returns), ...(m.params ? { params: m.params.map((p) => ({ ...p, type: canon(p.type) })) } : {}) })) } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Stored snapshots (surface_repository over .wai/surfaces/)
//
// Three components, one file (N:1), each an object over the one below it:
//   surface_fs_adapter  — the only block that touches .wai/surfaces/;
//   surface_store       — read-through state: every read is the file read,
//                         nothing is held in memory, so a CLI that pins and a
//                         hosted server that reads always see the same files;
//   surface_repository  — the facade consumers use, forwarding 1:1.
// ---------------------------------------------------------------------------

/** Snapshot filename for a storage key. The key itself (projectName, possibly
 *  '<systemName>::<subsystemId>' for sibling surfaces) lives IN the document —
 *  the filename is sanitized so keys with '::' (or any other unsafe character)
 *  stay writable on every platform (':' is not a legal Windows filename char). */
function snapshotFilename(projectName: string): string {
  return `${safeFilenamePart(projectName)}.yaml`;
}

/**
 * Write a snapshot only when its CONTENT differs from what is already on disk.
 *
 * Every projection stamps a fresh `generatedAt` and the tree's current
 * `stateId`, so an unconditional write would rewrite the bytes of every pinned
 * surface on every pin — even when the published contract is identical — and
 * show a child's whole surface set as modified in git after a parent changed
 * one subsystem.
 *
 * Provenance is exactly what `surfaceContentKey` strips: a file whose content
 * still matches does not need rewriting.
 */
function writeSnapshotIfChanged(
  snapshot: SurfaceSnapshot,
  rootDir: string,
): { path: string; changed: boolean } {
  const dir = surfacesDir(rootDir);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, snapshotFilename(snapshot.projectName));
  const next = SurfaceSnapshotSchema.parse(snapshot);

  if (fs.existsSync(p)) {
    try {
      const existing = SurfaceSnapshotSchema.parse(readYamlFile(p));
      if (surfaceContentKey(existing) === surfaceContentKey(next)) {
        return { path: p, changed: false };
      }
    } catch {
      // Unreadable or written by an older schema — rewrite it rather than
      // leaving something the loader cannot parse.
    }
  }

  writeYamlFile(p, next);
  return { path: p, changed: true };
}

// ── surface_fs_adapter ──────────────────────────────────────────────────────

/** isurface_fs_adapter. */
export interface SurfaceFsAdapter {
  readAllSnapshots(): SurfaceSnapshot[];
  writeSnapshot(snapshot: SurfaceSnapshot): string;
  deleteSnapshot(projectName: string): boolean;
}

export const surfaceFsAdapter: SurfaceFsAdapter = {
  readAllSnapshots() {
    const dir = surfacesDir(getProjectRoot());
    if (!fs.existsSync(dir)) return [];
    const out: SurfaceSnapshot[] = [];
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      try {
        out.push(SurfaceSnapshotSchema.parse(readYamlFile(path.join(dir, file))));
      } catch {
        // A malformed snapshot never aborts the read — it is simply not available.
      }
    }
    return out;
  },
  writeSnapshot(snapshot) {
    return writeSnapshotIfChanged(snapshot, getProjectRoot()).path;
  },
  deleteSnapshot(projectName) {
    const dir = surfacesDir(getProjectRoot());
    const direct = path.join(dir, snapshotFilename(projectName));
    if (fs.existsSync(direct)) {
      fs.unlinkSync(direct);
      return true;
    }
    // Legacy files written before filename sanitization (raw project names):
    // locate by the snapshot's stored key, not the filename.
    if (!fs.existsSync(dir)) return false;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      const p = path.join(dir, file);
      try {
        const snap = SurfaceSnapshotSchema.parse(readYamlFile(p));
        if (snap.projectName === projectName) {
          fs.unlinkSync(p);
          return true;
        }
      } catch {
        // A malformed snapshot is not the one we were asked to remove.
      }
    }
    return false;
  },
};

// ── surface_store ───────────────────────────────────────────────────────────

/** isurface_store — read-through: each method is one file operation. */
export interface SurfaceStore {
  put(snapshot: SurfaceSnapshot): string;
  get(projectName: string): SurfaceSnapshot | null;
  list(): SurfaceSnapshot[];
  remove(projectName: string): boolean;
}

export const surfaceStore: SurfaceStore = {
  put(snapshot) {
    return surfaceFsAdapter.writeSnapshot(snapshot);
  },
  get(projectName) {
    return surfaceFsAdapter.readAllSnapshots().find(s => s.projectName === projectName) ?? null;
  },
  list() {
    return surfaceFsAdapter.readAllSnapshots();
  },
  remove(projectName) {
    return surfaceFsAdapter.deleteSnapshot(projectName);
  },
};

// ── surface_repository ──────────────────────────────────────────────────────

/** isurface_repository — the facade: each method one call to the store. */
export interface SurfaceRepository {
  saveSnapshot(snapshot: SurfaceSnapshot): string;
  getSnapshot(projectName: string): SurfaceSnapshot | null;
  listSnapshots(): SurfaceSnapshot[];
  removeSnapshot(projectName: string): boolean;
}

export const surfaceRepository: SurfaceRepository = {
  saveSnapshot(snapshot) {
    return surfaceStore.put(snapshot);
  },
  getSnapshot(projectName) {
    return surfaceStore.get(projectName);
  },
  listSnapshots() {
    return surfaceStore.list();
  },
  removeSnapshot(projectName) {
    return surfaceStore.remove(projectName);
  },
};

// ── surface_orchestrator: the stored-snapshot reads and removal ─────────────

/** surface_orchestrator.listSnapshots — every snapshot the bound root holds. */
export function listSnapshots(): SurfaceSnapshot[] {
  return surfaceRepository.listSnapshots();
}

/** surface_orchestrator.getSnapshot — the named project's snapshot, or null. */
export function getSnapshot(projectName: string): SurfaceSnapshot | null {
  return surfaceRepository.getSnapshot(projectName);
}

/** surface_orchestrator.removeSnapshot — remove the named project's snapshot; whether one existed. */
export function removeSnapshot(projectName: string): boolean {
  return surfaceRepository.removeSnapshot(projectName);
}

/**
 * surface_orchestrator.listPinnedExternals — the owner's gate read of the bound
 * project's pins: each declared external's alias with its lock entry and the
 * snapshot that entry names, read from the bound root's own
 * .wai/externals.lock.yaml and .wai/externals/ through the externals
 * Repository. It never resolves a producer, never reads another root and never
 * climbs: an alias never pinned, or whose snapshot file is missing or
 * malformed, is answered with its problem instead of a snapshot. Writes nothing.
 */
export function listPinnedExternals(): PinnedExternal[] {
  // Step 1: the declared aliases and producer ids only — nothing is bound. A
  // referenced project member (stage 8: a `../`, git or hosted source) is
  // judged against its pin exactly as an external; a part among them is
  // dropped by the gate, which knows what the scan found it to be.
  let declared: { alias: string; project: string }[] = [];
  try {
    const config = loadProjectConfig();
    declared = config ? [
      ...declaredExternals(config),
      ...declaredMembers(config).filter((m) => !m.problem && m.storage !== 'contained').map((m) => ({ alias: m.alias, project: m.alias })),
    ] : [];
  } catch {
    // A configuration that fails its schema is reported by the paths that load it.
    return [];
  }
  // Step 2: the externals lock; one that cannot be read pins nothing.
  let lock: ExternalsLock | null = null;
  let lockProblem: string | undefined;
  try {
    lock = externalsRepository.readLock();
  } catch (e) {
    lockProblem = `the externals lock cannot be read: ${e instanceof Error ? e.message : String(e)}`;
  }
  // Steps 3-5: each declared alias, with its entry and snapshot — or the problem.
  return declared.map(({ alias, project }): PinnedExternal => {
    if (lockProblem) return { alias, project, problem: lockProblem };
    const entry = lock?.externals[alias];
    if (!entry) return { alias, project, problem: `the external "${alias}" was never pinned (run \`wairon externals pin\`)` };
    const snapshot = externalsRepository.readSnapshot(alias);
    if (!snapshot) return { alias, project: entry.project, entry, problem: `the pinned snapshot ${entry.snapshot} is missing or unreadable (re-pin with \`wairon externals pin\`)` };
    return { alias, project: entry.project, entry, snapshot };
  });
}

/**
 * surface_orchestrator.unrecordedUses — the uses of each PINNED external that
 * its pin does not record: every public name (and method of one) the bound
 * project's specs use now through the alias, counted offline exactly as a pin
 * counts them, that the lock entry's `used` map does not hold — keeping only
 * the ones the pinned snapshot carries (a use it does not carry is a design
 * error the gate reports, which no re-pin cures). Keyed by alias, each value
 * `<name>` or `<name>.<method>`, sorted; an alias with none is left out. No
 * producer is read; writes nothing.
 */
export function unrecordedUses(): Record<string, string[]> {
  // Step 1: the pinned externals, each with its entry and snapshot.
  const pinned = listPinnedExternals().filter((p) => p.entry !== undefined && p.snapshot !== undefined);
  // Steps 2-3: none pinned, nothing to resolve.
  if (pinned.length === 0) return {};
  // Step 4: the declared externals resolved offline — only their usages are read.
  const bindings = resolveExternals(true);
  // Step 5: each pinned alias's uses its lock entry does not hold.
  const out: Record<string, string[]> = {};
  for (const p of pinned) {
    const usage = bindings.find((b) => b.external.alias === p.alias)?.usage;
    const locked = p.entry!.used ?? {};
    const snapshot = p.snapshot!;
    const carriesName = (name: string): boolean => snapshot.interfaces.some((e) => e.id === name) || (snapshot.exportedTypes ?? []).some((t) => t.id === name);
    const missing = new Set<string>();
    for (const use of usage?.used ?? []) {
      const recorded = locked[use.publicName];
      // A name recorded with no members covers the whole name, as the live comparison reads it.
      if (recorded !== undefined && Object.keys(recorded).length === 0) continue;
      if (use.members.length === 0) {
        if (recorded === undefined && carriesName(use.publicName)) missing.add(use.publicName);
        continue;
      }
      for (const member of use.members) {
        if (recorded !== undefined && member in recorded) continue;
        if (memberDigest(snapshot, use.publicName, member) === null) continue;
        missing.add(member === 'type' ? use.publicName : `${use.publicName}.${member}`);
      }
    }
    if (missing.size > 0) out[p.alias] = [...missing].sort(compareOrdinal);
  }
  // Step 6.
  return out;
}

// ---------------------------------------------------------------------------
// Exchange workflows (surface_orchestrator)
// ---------------------------------------------------------------------------

export interface SurfaceExportResult {
  snapshot: SurfaceSnapshot;
  /** Rendered document body when format was openapi AND exactly one portal
   *  remains — either the project has one, or portalId selected one. */
  rendered?: string;
  /** One named OpenAPI document per public portal (openapi format) — the honest
   *  multi-spec result; never a single combined doc across distinct portals.
   *  Narrowed to a single entry when portalId selected one. */
  renderedSet?: NamedOpenApiSpec[];
  /** Written output path when exactly one file was written. */
  writtenTo?: string;
  /** EVERY written path. A multi-portal openapi export with no portal selection
   *  writes one file per portal, so callers can report all of them. */
  writtenPaths?: string[];
}

/** Narrow a rendered set to the named portal. An unknown portalId is REFUSED —
 *  never silently substituted with some other portal's document. */
function selectPortalSpec(renderedSet: NamedOpenApiSpec[], portalId: string): NamedOpenApiSpec[] {
  const hit = renderedSet.find(spec => spec.portalId === portalId);
  if (!hit) {
    const known = renderedSet.map(s => s.portalId).join(', ');
    throw new Error(`Unknown portal "${portalId}" — this surface renders: ${known || '(no portals)'}.`);
  }
  return [hit];
}

/** The per-portal output path: the out path's stem suffixed with the portal id
 *  (surface.json + "gateway" -> surface.gateway.json). The portal id is a
 *  SpecIdSchema component id (`[a-z0-9-_]`), but it is sanitized before it joins
 *  the path so no future caller feeding an imported/unvalidated id can escape
 *  the output directory. */
function perPortalPath(resolvedOut: string, portalId: string): string {
  const ext = path.extname(resolvedOut);
  const stem = ext ? resolvedOut.slice(0, -ext.length) : resolvedOut;
  return `${stem}.${safeFilenamePart(portalId)}${ext}`;
}

/** Write an export to disk, returning EVERY path written: the snapshot YAML for
 *  native format (and for an openapi export that renders no portals at all), the
 *  single document when one portal remains, else ONE FILE PER PORTAL — never just
 *  the first, which would silently drop the other APIs. */
function writeSurfaceFile(targetPath: string, snapshot: SurfaceSnapshot, renderedSet?: NamedOpenApiSpec[]): string[] {
  const resolved = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (!renderedSet || renderedSet.length === 0) {
    // A file is what its name says: `--out x.json` gets JSON (import reads it
    // back too — JSON is YAML), anything else the YAML snapshot.
    if (path.extname(resolved).toLowerCase() === '.json') fs.writeFileSync(resolved, `${JSON.stringify(snapshot, null, 2)}\n`);
    else writeYamlFile(resolved, snapshot);
    return [resolved];
  }
  if (renderedSet.length === 1) {
    fs.writeFileSync(resolved, renderedSet[0].document);
    return [resolved];
  }
  return renderedSet.map(spec => {
    const target = perPortalPath(resolved, spec.portalId);
    fs.writeFileSync(target, spec.document);
    return target;
  });
}

/** Assemble the export result. The single-document (`rendered`) and single-path
 *  (`writtenTo`) conveniences exist ONLY when exactly one of each does — with
 *  several portals they stay unset rather than standing for an arbitrary one. */
function exportResult(
  snapshot: SurfaceSnapshot,
  renderedSet: NamedOpenApiSpec[] | undefined,
  writtenPaths: string[],
): SurfaceExportResult {
  const rendered = renderedSet?.length === 1 ? renderedSet[0].document : undefined;
  return {
    snapshot,
    ...(rendered !== undefined ? { rendered } : {}),
    ...(renderedSet ? { renderedSet } : {}),
    ...(writtenPaths.length === 1 ? { writtenTo: writtenPaths[0] } : {}),
    ...(writtenPaths.length ? { writtenPaths } : {}),
  };
}

/**
 * Refusal of an OpenAPI export that has no HTTP Portal to describe — an
 * in-process library, or nothing exported at the audience: OpenAPI does not
 * apply, and the native snapshot is never written in its place.
 */
export class OpenApiNotApplicableError extends Error {
  constructor(snapshot: SurfaceSnapshot, maxAudience: string) {
    const kinds = [...new Set(snapshot.interfaces.map((e) => e.type))].sort();
    super(snapshot.interfaces.length
      ? `OpenAPI does not apply to "${snapshot.projectName}": it exposes no HTTP Portal at audience ≥ ${maxAudience} — its ${snapshot.interfaces.length} exported interface(s) are ${kinds.join(', ')}${kinds.includes('InProcess') ? ' (an in-process library is called, not requested over HTTP)' : ''}, which no OpenAPI document describes. Nothing was written; export the native snapshot (\`--format native\`) instead.`
      : `OpenAPI does not apply to "${snapshot.projectName}": it exports no interface at audience ≥ ${maxAudience}. Nothing was written.`);
    this.name = 'OpenApiNotApplicableError';
  }
}

export function exportSurface(maxAudience: string, format: string, outPath?: string, portalId?: string): SurfaceExportResult {
  const snapshot = projectOwnSurface(maxAudience);
  let renderedSet = format === 'openapi' ? toOpenApiSet(snapshot) : undefined;
  // No HTTP Portal: OpenAPI does not apply — a file asked for is refused, never written as the native snapshot.
  if (renderedSet && renderedSet.length === 0 && outPath) throw new OpenApiNotApplicableError(snapshot, maxAudience);
  if (renderedSet && portalId) renderedSet = selectPortalSpec(renderedSet, portalId);
  const writtenPaths = outPath ? writeSurfaceFile(outPath, snapshot, renderedSet) : [];
  return exportResult(snapshot, renderedSet, writtenPaths);
}

/** A value with every object's keys in ordinal order, recursively — the one byte sequence a design writes as. */
function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSortedKeys);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort(compareOrdinal)) if (src[k] !== undefined) out[k] = withSortedKeys(src[k]);
    return out;
  }
  return value;
}

/**
 * isurface_transfer_adapter.writeDesignTo — the design export written to the
 * target path as UTF-8 JSON (sorted object keys, two-space indent, one trailing
 * newline), creating missing directories and overwriting an existing file, so
 * the same design writes the same bytes. Fails naming the path. Returns the
 * path written.
 */
export function writeDesignTo(targetPath: string, design: DesignExport): string {
  const resolved = path.resolve(targetPath);
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(withSortedKeys(design), null, 2)}\n`, 'utf8');
  } catch (e) {
    throw new Error(`Cannot write the design export to ${resolved}: ${(e as Error).message}`);
  }
  return resolved;
}

/**
 * isurface_orchestrator.exportDesign — project the bound project's design
 * export (design_exporter) and, when an output path is given, write it there.
 * Answers with the export either way.
 */
export function exportDesign(outPath?: string, approval?: DesignApproval): DesignExport {
  const design = projectDesign(approval);
  if (outPath) writeDesignTo(outPath, design);
  return design;
}

/** Read a foreign surface document as UTF-8 text without interpreting it;
 *  decoding is the caller's concern. Fails naming the path when it is missing. */
function readSurfaceDocument(sourcePath: string): string {
  const resolved = path.resolve(sourcePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Surface document not found: ${resolved}`);
  }
  return fs.readFileSync(resolved, 'utf8');
}

export function importSurface(sourcePath: string, origin: SurfaceOrigin): SurfaceSnapshot {
  const resolved = path.resolve(sourcePath);
  const body = readSurfaceDocument(resolved);

  let snapshot: SurfaceSnapshot;
  if (isOpenApiDocument(body)) {
    const projectName = path.basename(resolved).replace(/\.(json|ya?ml)$/i, '');
    snapshot = fromOpenApi(body, projectName);
    snapshot = { ...snapshot, origin };
  } else {
    snapshot = SurfaceSnapshotSchema.parse(parseYaml(body, resolved));
    snapshot = { ...snapshot, origin };
  }
  surfaceRepository.saveSnapshot(snapshot);
  return snapshot;
}

// ---------------------------------------------------------------------------
// Stage-1 family pins (listFamilyPins) — the generated family and sibling
// snapshots `wairon surface pin` once wrote. Nothing reads them since stage 3;
// the chaining migration converts the family pin into an external and deletes
// them all.
// ---------------------------------------------------------------------------

/** Whose surface a stage-1 family pin holds: the parent's family surface, or one sibling's published surface. */
export type FamilyPinRole = 'parent' | 'sibling';

/**
 * family_pin — one stage-1 family pin a project root still holds in
 * .wai/surfaces/: its storage key, whether it pins the parent's family surface
 * or one sibling's, and when it was written.
 */
export interface FamilyPin {
  /** The snapshot's storage key: the parent's system name, or `<system>::<subsystem>` for a sibling pin. */
  key: string;
  role: FamilyPinRole;
  /** When the pin was written. */
  generatedAt?: string;
}

/**
 * surface_orchestrator.listFamilyPins — the stage-1 family pins the bound root
 * holds: every generated snapshot, classified by its key. Foreign imports
 * (exchanged or authored) are never family pins. Reads only the bound root.
 */
export function listFamilyPins(): FamilyPin[] {
  // Step 1: the snapshots the bound root holds.
  const snapshots = listSnapshots();
  // Step 2: the generated ones, classified by key.
  const pins = snapshots
    .filter((snapshot) => snapshot.origin === 'generated')
    .map((snapshot): FamilyPin => ({
      key: snapshot.projectName,
      role: snapshot.projectName.includes('::') ? 'sibling' : 'parent',
      ...(snapshot.generatedAt ? { generatedAt: snapshot.generatedAt } : {}),
    }));
  // Step 3: in key order.
  return pins.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Declared externals (surface_orchestrator pinExternals / getExternalsStatus /
// listExternals) — `wairon externals` and the sdd_pin_externals /
// sdd_get_externals_status tools. The core binds each declared external to its
// producer (the surfaces plane never walks the family itself); this plane
// projects the producer's export table, pins it under .wai/externals/ and
// records in the lock the digest of every member the consumer uses.
// ---------------------------------------------------------------------------

/** The code on every comparison that could not be made — never a pass. */
const CHECK_UNAVAILABLE = 'EXTERNAL_CHECK_UNAVAILABLE';

/** An alias the project does not declare, named to pin: refused before anything is written. */
export class UnknownExternalAliasError extends Error {
  constructor(unknown: string[], declared: string[]) {
    super(`Unknown external alias${unknown.length > 1 ? 'es' : ''} ${unknown.map((a) => `"${a}"`).join(', ')} — this project declares ${declared.length ? declared.map((a) => `"${a}"`).join(', ') : 'no externals'} in .wai/project.yaml.`);
    this.name = 'UnknownExternalAliasError';
  }
}

/** Why a producer was not read: its root lies outside the request's reach. */
const OUT_OF_REACH = 'its root is outside the request\'s reach';

/** Whether `target` is `dir` or lies under it. */
function isWithinDir(dir: string, target: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Why a producer's root cannot be read, or null when it can. The caller must
 * gate on reach itself: a root outside the request's reach is never read. A
 * hosted producer's root was answered by the hosting server's record lookup,
 * which answers only a record the request may read — that is its reach check.
 */
function producerUnreadable(external: ResolvedExternal): string | null {
  const directory = external.directory;
  if (!directory) return external.problem ?? 'the producer has no root directory';
  const reach = getRequestParentReach();
  // A git producer is a fetched commit, never a root above the family; a
  // referenced member is a root the declaring project names explicitly (stage
  // 8) — neither is the family's to read within a ceiling, and neither ever
  // has a directory on a hosted instance.
  if (reach && external.sourceKind !== 'hosted' && external.sourceKind !== 'git' && external.role !== 'member') {
    const bound = getProjectRoot();
    const ceiling = reach.parentReach ? reach.topRoot ?? bound : bound;
    if (!isWithinDir(ceiling, directory)) return OUT_OF_REACH;
  }
  if (!fs.existsSync(directory)) return `its root ${directory} does not exist`;
  return null;
}

/**
 * Project the producer's resolved export table at the external's audience
 * ceiling, the producer's root bound read-only for the projection and the
 * consumer's binding restored afterwards; the snapshot is stamped with the
 * audience it was filtered to. A root that holds no project throws.
 */
function projectProducer(external: ResolvedExternal): SurfaceSnapshot {
  const snapshot = runWithProjectRoot(external.directory!, () => {
    const projected = projectOwnSurface(external.audience);
    // A spec file of the producer that fails to parse leaves its table short:
    // what it held reads as gone. Never projected as a producer that removed
    // names — it is unreadable, naming the file, for the producer to fix.
    const broken = getLoaderIssues().find((i) => i.code === 'SCHEMA_VALIDATION_ERROR');
    if (broken) throw new Error(unreadableReason(broken.message));
    return projected;
  });
  return { ...snapshot, audience: external.audience };
}

/** The prefix every unreadable-producer reason starts with. */
const PRODUCER_UNREADABLE = 'producer unreadable';

/** `producer unreadable: <file>: <error>`, read off the loader's parse failure. */
function unreadableReason(message: string): string {
  const parsed = /^Failed to parse (?:\w+ )?spec(?: "([^"]+)")?: ([\s\S]*)$/.exec(message);
  if (!parsed) return `${PRODUCER_UNREADABLE}: ${message}`;
  return `${PRODUCER_UNREADABLE}: ${parsed[1] ?? 'its system spec'}: ${parsed[2]}`;
}

/** A failed producer read as a reason: an unreadable producer said as such, anything else prefixed. */
function readFailure(e: unknown): string {
  const detail = e instanceof Error ? e.message : String(e);
  return detail.startsWith(PRODUCER_UNREADABLE) ? detail : `the producer could not be read: ${detail}`;
}

/**
 * The lock's `used` map for one binding: each used member's digest in the
 * pinned snapshot; and each used member the snapshot does not carry, as the
 * reference that reaches it (the first referring spec), so every surface that
 * answers a pin — the CLI line and the MCP answer alike — names it.
 */
function usedDigests(usage: ExportUsage | undefined, snapshot: SurfaceSnapshot, alias: string): { used: Record<string, Record<string, string>>; missing: string[]; uncarried: CrossProjectReference[] } {
  const used: Record<string, Record<string, string>> = {};
  const missing: string[] = [];
  const uncarried: CrossProjectReference[] = [];
  for (const use of usage?.used ?? []) {
    const members: Record<string, string> = {};
    for (const member of use.members) {
      const digest = memberDigest(snapshot, use.publicName, member);
      if (digest !== null) {
        members[member] = digest;
        continue;
      }
      missing.push(`${use.publicName}.${member}`);
      uncarried.push({
        specId: use.specs?.[0] ?? '', position: 'uncarried', target: `${alias}::${use.publicName}`,
        ...(member !== 'type' ? { member } : {}), consumer: usage?.consumer ?? '', producer: alias, authored: `${alias}::${use.publicName}`,
      });
    }
    used[use.publicName] = members;
  }
  return { used, missing, uncarried };
}

/**
 * What a pin says beside its outcome: the used members it could not carry,
 * or — when no spec references the external yet — plainly that the pin
 * records none of this project's uses, and fills on the next pin.
 */
function pinDetail(missing: string[], usedNames: number, alias: string): { detail?: string } {
  if (missing.length) return { detail: `used members the snapshot does not carry cannot be pinned: ${missing.join(', ')}` };
  if (usedNames === 0) {
    return { detail: `no spec references "${alias}" yet, so this pin records none of its uses — it fills on the next pin (\`wairon externals pin ${alias}\` / sdd_pin_externals) once a spec writes \`${alias}::<name>\`; until then each new reference reads "used now, but not in the lock"` };
  }
  return {};
}

/** Pin one resolved binding: the snapshot written when its content moved, and the lock entry. */
function pinBinding(binding: ExternalBinding, lock: ExternalsLock): { pin: ExternalPin; changed: boolean } {
  const { external } = binding;
  const unexported = binding.usage?.unexported ?? [];
  // Step 8: bind the producer's root, when it can be read.
  const unreadable = producerUnreadable(external);
  let snapshot: SurfaceSnapshot;
  try {
    if (unreadable) throw new Error(unreadable);
    // Steps 9-10: project it at the audience ceiling, stamped with that audience.
    snapshot = projectProducer(external);
  } catch (e) {
    return { pin: { alias: external.alias, outcome: 'unreachable', project: external.project, usedNames: 0, unexported, detail: `${readFailure(e)}; its previous pin stays` }, changed: false };
  }
  const digest = contentDigest(snapshot);
  // Steps 11-13: the snapshot is rewritten only when its content moved.
  const pinned = externalsRepository.readSnapshot(external.alias);
  // Rewritten whenever anything the snapshot carries moved — not only its
  // digest: the rules read facts no digest covers (a library's abi, an
  // entry's transport and role), and a re-pin is how they are refreshed.
  const snapshotChanged = !pinned || contentDigest(pinned) !== digest || pinnedContentKey(pinned) !== pinnedContentKey(snapshot);
  if (snapshotChanged) externalsRepository.saveSnapshot(external.alias, snapshot);
  // Step 14: the lock entry — `used` maps each used member to its digest.
  const { used, missing, uncarried } = usedDigests(binding.usage, snapshot, external.alias);
  const entry: ExternalLockEntry = {
    project: external.project, snapshot: `.wai/externals/${external.alias}.yaml`, digest, used,
    ...(external.commit !== undefined ? { commit: external.commit } : {}),
    ...(external.role === 'member' ? { role: 'member' } : {}),
  };
  const entryChanged = canonicalize(lock.externals[external.alias] ?? null) !== canonicalize(entry);
  lock.externals[external.alias] = entry;
  return {
    pin: {
      alias: external.alias,
      outcome: snapshotChanged || entryChanged ? 'pinned' : 'unchanged',
      project: external.project,
      snapshot: entry.snapshot,
      digest,
      usedNames: Object.keys(used).length,
      unexported: [...unexported, ...uncarried],
      ...(pinDetail(missing, Object.keys(used).length, external.alias)),
    },
    changed: entryChanged,
  };
}

/**
 * surface_orchestrator.pinExternals — pin the bound project's declared
 * externals (the named aliases, else all) into .wai/externals/<alias>.yaml and
 * .wai/externals.lock.yaml. An alias the project does not declare is refused
 * before anything is written; an unresolved or unreachable producer is
 * reported and leaves its previous pin in place. With no aliases named, pins
 * for aliases no longer declared are removed.
 */
export function pinExternals(aliases?: string[]): ExternalPin[] {
  // Steps 1-4 (stage 8): a part declares no externals — what it pins is its parent.
  if (isPart(loadProjectConfig())) return pinParent(aliases);
  // Step 5: the declared externals, each bound to its producer.
  const bindings = resolveExternals();
  // Steps 6-8: the aliases asked for — an undeclared one refused before any write.
  const declared = bindings.map((b) => b.external.alias);
  const named = aliases && aliases.length > 0 ? aliases : undefined;
  const unknown = (named ?? []).filter((a) => !declared.includes(a));
  if (unknown.length) throw new UnknownExternalAliasError(unknown, declared);
  const kept = named ? bindings.filter((b) => named.includes(b.external.alias)) : bindings;
  // Step 9: the current lock (none yet reads as empty).
  const lock: ExternalsLock = externalsRepository.readLock() ?? { externals: {} };
  const pins: ExternalPin[] = [];
  let lockChanged = false;
  // Steps 6-17: each external to pin.
  for (const binding of kept) {
    if (binding.external.sourceKind === 'unresolved') {
      // Step 16: its previous pin stays.
      pins.push({ alias: binding.external.alias, outcome: 'unresolved', project: binding.external.project, usedNames: 0, unexported: [], detail: binding.external.problem });
      continue;
    }
    const { pin, changed } = pinBinding(binding, lock);
    pins.push(pin);
    lockChanged ||= changed;
  }
  // Step 22: with no aliases named, prune the aliases no longer declared.
  if (!named) lockChanged = prune(lock, declared) || lockChanged;
  // Steps 23-24: the lock, written only when an entry was added, changed or pruned.
  if (lockChanged) externalsRepository.saveLock(lock);
  // Step 25: one outcome per external handled, in declaration order.
  return pins;
}

/**
 * isurface_orchestrator.prune — drop every lock entry whose alias the
 * project no longer declares, with its snapshot; answers whether the lock
 * changed. The prune half of a pin with no aliases named.
 */
export function prune(lock: ExternalsLock, declared: string[]): boolean {
  // Step 1: the entries no longer declared.
  const dropped = Object.keys(lock.externals).filter((alias) => !declared.includes(alias));
  for (const alias of dropped) delete lock.externals[alias];
  // Steps 2-3: each one's snapshot goes with it.
  for (const alias of dropped) externalsRepository.removeSnapshot(alias);
  // Step 4.
  return dropped.length > 0;
}

/**
 * isurface_orchestrator.pinnedParent — the owner's gate read of a PART's
 * pinned parent (stage 8): its lock's `parent` entry and the excerpt it
 * names, from the bound root's own .wai/externals files — never the parent's
 * live tree. Null when the bound root is not a part.
 */
export function pinnedParent(): PinnedParent | null {
  // Step 1: the bound root's configuration; nothing is bound or climbed.
  const config = loadProjectConfig();
  // Steps 2 and 6: not a part, nothing to answer.
  if (!isPart(config)) return null;
  const project = config!.partOf!.project;
  // Step 3: the part's lock and its parent entry.
  const entry = externalsRepository.readLock()?.parent;
  // Step 4: the excerpt the entry names.
  const excerpt = entry ? externalsRepository.readExcerpt(entry.project) : null;
  // Step 5: the parent with its entry and excerpt — or the problem.
  const problem = !entry
    ? `part of "${project}"; validate from the parent — it has never been pinned here`
    : !excerpt
      ? `the pinned excerpt of "${entry.project}" (${entry.snapshot}) is missing or unreadable — re-pin with \`wairon externals pin\``
      : excerpt.project !== project
        ? `the pinned excerpt is of "${excerpt.project}", but this part's partOf names "${project}" — re-pin with \`wairon externals pin\``
        : undefined;
  return {
    project,
    ...(entry ? { entry } : {}),
    ...(excerpt && !problem ? { excerpt } : {}),
    ...(problem ? { problem } : {}),
  };
}

/**
 * isurface_orchestrator.pinParent — `wairon externals pin` at a PART (stage
 * 8): take the excerpt of the parent the part's files reference — read with
 * the parent on disk at PartOf.path — and pin it as the part's
 * .wai/externals/<parent id>.yaml and its lock's `parent` entry. A named alias
 * is refused before anything is written; a parent the core cannot read, or
 * one that does not claim the part, is answered unreachable with the reason,
 * and the previous pin stays. Never locks.
 */
export function pinParent(aliases?: string[]): ExternalPin[] {
  const project = loadProjectConfig()?.partOf?.project ?? '';
  // Steps 1-2: a part has no alias to name.
  if (aliases && aliases.length > 0) throw new UnknownExternalAliasError(aliases, []);
  // Step 3: the excerpt, read with the parent on disk.
  let excerpt;
  try {
    excerpt = excerptParent();
  } catch (e) {
    return [{ alias: project, outcome: 'unreachable', project, usedNames: 0, unexported: [], detail: e instanceof Error ? e.message : String(e) }];
  }
  // Step 4: the part's lock (none yet reads as empty).
  const lock: ExternalsLock = externalsRepository.readLock() ?? { externals: {} };
  const snapshot = `.wai/externals/${excerpt.project}.yaml`;
  const unchanged = lock.parent?.digest === excerpt.digest && lock.parent.project === excerpt.project
    && externalsRepository.readExcerpt(excerpt.project) !== null;
  // Step 5: the excerpt, written when its digest moved.
  if (!unchanged) externalsRepository.saveExcerpt(excerpt);
  // Step 6: the lock's parent entry, recorded when it changed.
  const entry: ExternalLockEntry = { project: excerpt.project, snapshot, digest: excerpt.digest, used: {}, role: 'parent', ...(excerpt.commit ? { commit: excerpt.commit } : {}) };
  const entryMoved = canonicalize(lock.parent ?? null) !== canonicalize(entry);
  if (entryMoved) externalsRepository.saveLock({ ...lock, parent: entry });
  // Step 7: one outcome, the parent's.
  return [{
    alias: excerpt.project, outcome: unchanged && !entryMoved ? 'unchanged' : 'pinned', project: excerpt.project,
    snapshot, digest: excerpt.digest, usedNames: 0, unexported: [],
  }];
}

/** Where the live producer's rename trace carries a used name, or null when it does not. */
interface RenamedUse {
  publicName: string;
  member?: string;
}

/**
 * A used name gone from the live table, followed through the producer's
 * rename trace (`formerly` on an entry, a method or an exported type's
 * definition): the live public name (and member) it was renamed to, or null —
 * then it was removed.
 */
function renamedIn(live: SurfaceSnapshot, publicName: string, member?: string): RenamedUse | null {
  if (member === undefined || member === 'type') {
    const entry = live.interfaces.find((e) => e.formerly?.includes(publicName));
    if (entry && member === undefined) return { publicName: entry.id };
    const exported = (live.exportedTypes ?? []).find((t) => t.id !== publicName
      && (live.types.find((d) => d.id === t.type)?.formerly ?? []).includes(publicName));
    return exported ? { publicName: exported.id, ...(member ? { member } : {}) } : null;
  }
  const entry = live.interfaces.find((e) => e.id === publicName) ?? live.interfaces.find((e) => e.formerly?.includes(publicName));
  if (!entry) return null;
  if (member.startsWith('capability:')) {
    const has = entry.dispatch?.some((b) => b.capability === member.slice('capability:'.length));
    return has && entry.id !== publicName ? { publicName: entry.id, member } : null;
  }
  const method = entry.methods.find((m) => m.name === member) ?? entry.methods.find((m) => m.formerly?.includes(member));
  if (!method || (entry.id === publicName && method.name === member)) return null;
  return { publicName: entry.id, member: method.name };
}

/** How a rename reads: `name` or `name.member` (a type keeps its bare name). */
function renamedName(to: RenamedUse): string {
  return to.member === undefined || to.member === 'type' ? to.publicName : `${to.publicName}.${to.member}`;
}

/**
 * Whether a renamed member still has the signature the lock recorded: the live
 * table read back under the former names (the entry, method or exported type
 * renamed back), so only the name — which a digest reads — is set aside.
 */
function sameSignatureAfterRename(live: SurfaceSnapshot, from: { publicName: string; member: string }, to: RenamedUse, digest: string): boolean {
  if (from.member === 'type') {
    const exported = (live.exportedTypes ?? []).find((t) => t.id === to.publicName);
    if (!exported) return false;
    const def = live.types.find((d) => d.id === exported.type);
    const defId = def && def.id === to.publicName ? from.publicName : exported.type;
    const back: SurfaceSnapshot = {
      ...live,
      exportedTypes: (live.exportedTypes ?? []).map((t) => (t === exported ? { ...t, id: from.publicName, type: defId } : t)),
      types: live.types.map((d) => (d === def ? { ...d, id: defId } : d)),
    };
    return memberDigest(back, from.publicName, 'type') === digest;
  }
  const back: SurfaceSnapshot = {
    ...live,
    interfaces: live.interfaces.map((e) => (e.id !== to.publicName ? e : {
      ...e,
      id: from.publicName,
      methods: e.methods.map((m) => (m.name === to.member ? { ...m, name: from.member } : m)),
    })),
  };
  return memberDigest(back, from.publicName, from.member) === digest;
}

/** A used member gone under its pinned name: renamed when the live rename trace names it, removed otherwise. */
function goneUse(live: SurfaceSnapshot, publicName: string, member: string | undefined, digest: string | undefined): ExternalUseStatus {
  const to = renamedIn(live, publicName, member);
  const at = { publicName, ...(member !== undefined ? { member } : {}) };
  if (!to) {
    // A name the producer still declares but no longer resolves: say where it
    // went — the rename trace of the source it re-exports from.
    const broken = (live.unresolvedExports ?? []).find((u) => u.id === publicName);
    if (!broken) return { ...at, state: 'removed' };
    return {
      ...at, state: 'removed',
      detail: `the producer re-exports it from "${broken.source}", which ${broken.renamedTo ? `renamed it to "${broken.renamedTo}"` : 'no longer exports it'}, so the producer's re-export no longer resolves — ${broken.renamedTo ? `the producer must re-export "${broken.renamedTo}", or depend on "${broken.source}" directly` : 'the producer must fix its re-export'}`,
    };
  }
  const renamedTo = renamedName(to);
  const signature = member === undefined || digest === undefined
    ? ''
    : sameSignatureAfterRename(live, { publicName, member }, to, digest) ? ' (its signature is unchanged)' : ' (and its signature changed)';
  return { ...at, state: 'renamed', renamedTo, detail: `renamed to "${renamedTo}"${signature} — follow the rename` };
}

/** Compare every used member — the lock's, and the one the references use now — with the live snapshot. */
function compareUses(entry: ExternalLockEntry | undefined, usage: ExportUsage | undefined, live: SurfaceSnapshot): ExternalUseStatus[] {
  const uses: ExternalUseStatus[] = [];
  const locked = entry?.used ?? {};
  const liveHas = (name: string): boolean => live.interfaces.some((e) => e.id === name) || (live.exportedTypes ?? []).some((t) => t.id === name);
  for (const [publicName, members] of Object.entries(locked)) {
    if (Object.keys(members).length === 0) {
      uses.push(liveHas(publicName) ? { publicName, state: 'unchanged' } : goneUse(live, publicName, undefined, undefined));
      continue;
    }
    for (const [member, digest] of Object.entries(members)) {
      const now = memberDigest(live, publicName, member);
      uses.push(now === null ? goneUse(live, publicName, member, digest) : { publicName, member, state: now === digest ? 'unchanged' : 'changed' });
    }
  }
  // A use the lock does not hold is still compared with the live producer: one
  // gone from its table is a break the live producer proves, pinned or not.
  const unlocked = (publicName: string, member?: string): ExternalUseStatus => {
    const present = member === undefined ? liveHas(publicName) : memberDigest(live, publicName, member) !== null;
    if (!present) return goneUse(live, publicName, member, undefined);
    return { publicName, ...(member !== undefined ? { member } : {}), state: 'unlocked', detail: entry === undefined ? 'used, and present in the live producer, but never pinned — pin it (`wairon externals pin`) to record what it is judged against' : 'used now, but not in the lock — re-pin' };
  };
  for (const use of usage?.used ?? []) {
    if (!(use.publicName in locked)) {
      const gone = use.members.map((m) => unlocked(use.publicName, m)).filter((u) => u.state !== 'unlocked');
      uses.push(...(gone.length ? gone : [unlocked(use.publicName)]));
      continue;
    }
    for (const member of use.members) {
      if (!(member in locked[use.publicName])) uses.push(unlocked(use.publicName, member));
    }
  }
  // A reference that bound to no public name: one whose name the live table
  // no longer holds at all is a break the live producer proves (removed, or
  // renamed per its trace), pinned or not; one it holds but does not show
  // this consumer cannot be compared.
  for (const ref of usage?.unexported ?? []) {
    const spelled = ref.authored.split('::');
    const name = spelled.length === 2 ? spelled[1] : spelled.length === 1 ? spelled[0] : undefined;
    if (name !== undefined && !liveHas(name)) {
      // A name already answered as renamed or removed — under any member, a
      // type's `type` included — is answered once.
      if (uses.some((u) => u.publicName === name && (ref.member === undefined || u.member === undefined || u.member === ref.member))) continue;
      uses.push(goneUse(live, name, ref.member, undefined));
      continue;
    }
    uses.push({ member: ref.member, state: 'unavailable', code: CHECK_UNAVAILABLE, detail: `"${ref.specId}" reaches "${ref.target}", which the producer does not export — nothing to compare` });
  }
  return uses;
}

/** Every locked used member — or, when none is locked, the external itself — as unavailable. */
function unavailableUses(entry: ExternalLockEntry | undefined, reason: string): ExternalUseStatus[] {
  const uses: ExternalUseStatus[] = [];
  for (const [publicName, members] of Object.entries(entry?.used ?? {})) {
    const names = Object.keys(members);
    if (names.length === 0) uses.push({ publicName, state: 'unavailable', code: CHECK_UNAVAILABLE, detail: reason });
    for (const member of names) uses.push({ publicName, member, state: 'unavailable', code: CHECK_UNAVAILABLE, detail: reason });
  }
  return uses.length ? uses : [{ state: 'unavailable', code: CHECK_UNAVAILABLE, detail: reason }];
}

/** The status of one declared external against its live producer. */
function externalStatus(binding: ExternalBinding, lock: ExternalsLock | null): ExternalStatus {
  const { external } = binding;
  const entry = lock?.externals[external.alias];
  // Step 4: its pinned snapshot, if any — and the lock entry's digest and
  // commit carried as provenance for a reader; neither is compared here.
  const pinned = entry !== undefined && externalsRepository.readSnapshot(external.alias) !== null;
  const base = {
    alias: external.alias, project: external.project, sourceKind: external.sourceKind, pinned,
    ...(entry !== undefined ? { pinnedDigest: entry.digest } : {}),
    ...(entry?.commit !== undefined ? { pinnedCommit: entry.commit } : {}),
  };
  // Step 5: can the live producer be read?
  const unreadable = external.sourceKind === 'unresolved'
    ? (hostedOnly(external) ? external.problem! : `the external does not resolve: ${external.problem}`)
    : producerUnreadable(external);
  let live: SurfaceSnapshot | null = null;
  let reason = unreadable;
  if (!reason) {
    try {
      // Steps 6-7: the producer's live table at the audience ceiling.
      live = projectProducer(external);
    } catch (e) {
      reason = readFailure(e);
    }
  }
  if (!live) {
    // Step 10: nothing could be compared - never a pass. A producer whose root
    // lies outside the request's reach, or one the climb could not look for
    // because the reach stopped it, was never read: it is out of reach.
    const outOfReach = reason === OUT_OF_REACH || hostedOutOfReach(external) || (!binding.reachable && external.sourceKind !== 'family');
    return {
      ...base, reachable: false, stale: false, uses: unavailableUses(entry, reason!), detail: reason!,
      ...(outOfReach ? { outOfReach: true } : {}),
    };
  }
  // Step 8: every used member compared at signature level, for every producer
  // alike — family, path, git, hosted, a referenced project (stage 8).
  const drifted = entry !== undefined ? contentDigest(live) !== entry.digest : undefined;
  const uses = compareUses(entry, binding.usage, live);
  // A pinned snapshot that no longer carries what the producer says (an abi,
  // a transport, a role) is stale even when its digest is not: never ok.
  const snapshot = entry !== undefined ? externalsRepository.readSnapshot(external.alias) : null;
  const staleFacts = snapshot ? carriedFactChanges(snapshot, live) : [];
  return {
    ...base,
    reachable: true,
    stale: uses.some((u) => u.state === 'changed' || u.state === 'removed' || u.state === 'renamed'),
    ...(drifted !== undefined ? { drifted } : {}),
    ...(staleFacts.length ? { staleFacts } : {}),
    uses,
  };
}

/** A source.hosted external read outside a hosted server: its problem says so, and nothing is wrong with the external. */
function hostedOnly(external: ResolvedExternal): boolean {
  return external.hosted !== undefined && external.sourceKind === 'unresolved' && getHostedLookup() === null;
}

/** A source.hosted external the hosting server's record lookup did not answer: unknown or outside the request's reach. */
function hostedOutOfReach(external: ResolvedExternal): boolean {
  return external.hosted !== undefined && external.sourceKind === 'unresolved' && getHostedLookup() !== null;
}

/**
 * surface_orchestrator.getExternalsStatus — each declared external's pin
 * compared with its live producer at signature level (decision 19). What
 * cannot be compared is EXTERNAL_CHECK_UNAVAILABLE, never a pass. It only
 * reports: it writes nothing and fails nothing.
 */
export function getExternalsStatus(offline?: boolean): ExternalStatus[] {
  // Step 1: the declared externals, with the references as they are now —
  // offline, no producer is read over the network.
  const bindings = resolveExternals(offline);
  // Step 2: the lock.
  const lock = externalsRepository.readLock();
  // Steps 3-12: one status per declared external, in declaration order.
  return bindings.map((binding) => externalStatus(binding, lock));
}

/**
 * surface_orchestrator.listExternals — each declared external with how it
 * resolves, the audience the consumer sees and the lock's entry when pinned.
 * No live comparison.
 */
export function listExternals(): ExternalListing[] {
  // Step 1: the declared externals.
  const bindings = resolveExternals();
  // Step 2: the lock.
  const lock = externalsRepository.readLock();
  // Step 3: one row per declared external, in declaration order.
  const declared = bindings.map(({ external }): ExternalListing => {
    const entry = lock?.externals[external.alias];
    return {
      alias: external.alias,
      project: external.project,
      sourceKind: external.sourceKind,
      ...(external.relation ? { relation: external.relation } : {}),
      ...(external.directory ? { directory: external.directory } : {}),
      audience: external.audience,
      ...(entry ? { lock: entry } : {}),
      ...(external.problem ? { problem: external.problem } : {}),
    };
  });
  // Then each orphaned pin: a lock entry whose alias is no longer declared.
  const aliases = new Set(bindings.map((b) => b.external.alias));
  const orphans = Object.entries(lock?.externals ?? {})
    .filter(([alias]) => !aliases.has(alias))
    .map(([alias, entry]): ExternalListing => ({
      alias, project: entry.project, sourceKind: 'unresolved', audience: 'instance', lock: entry,
      problem: `pinned but no longer declared — \`wairon externals remove ${alias}\` removes the pin`,
    }));
  // Step 4.
  return [...declared, ...orphans];
}

/**
 * surface_orchestrator.listConsumers — the family projects in reach that
 * consume the bound project, each with the alias and section it declares it
 * under and the public names its specs use, read through the core. Read-only.
 */
export function listConsumers(search?: string[]): ExternalConsumer[] {
  // Steps 1-2: the family in reach, and every project root in the searched folders.
  return listExternalConsumers(search);
}

/** What `wairon surface diff` and sdd_surface_diff answer: the baseline compared against, and every change since. */
export interface SurfaceDiff {
  /** The project whose surface was compared. */
  project: string;
  /** What the surface was compared with: the last committed approval, a named revision, or a saved snapshot file. */
  against: string;
  changes: SurfaceChange[];
}

/**
 * surface_orchestrator.diff — the bound project's public-surface
 * changelog: its export table now (the whole table, every audience) against
 * the same table at its last committed approval — or at a named git revision,
 * or in a saved native surface snapshot file — as added, removed, renamed
 * (traced) and signature-changed names and methods. What a producer writes
 * release notes from and judges impact by. Read-only.
 */
export function diff(against?: string): SurfaceDiff {
  // Step 1: the surface now.
  const current = projectOwnSurface('project');
  // Steps 2-4: the baseline — a saved snapshot file, else the tree at the revision.
  let baseline: SurfaceSnapshot;
  let label: string;
  if (against !== undefined && fs.existsSync(against) && fs.statSync(against).isFile()) {
    baseline = SurfaceSnapshotSchema.parse(parseYaml(fs.readFileSync(against, 'utf8'), against));
    label = `the saved surface ${path.resolve(against)}`;
  } else {
    const revision = approvedRevision(against);
    baseline = runWithProjectRoot(revision.directory, () => projectOwnSurface('project'));
    label = revision.label;
  }
  // Step 5: the changes.
  return { project: current.projectId ?? current.projectName, against: label, changes: surfaceChanges(current, baseline) };
}

// ---------------------------------------------------------------------------
// Snapshot content identity
// ---------------------------------------------------------------------------

/**
 * A pinned snapshot's content minus provenance, as the file holds it: read
 * through the schema and canonicalized, so a snapshot read back from YAML and
 * a fresh projection of the same producer compare equal.
 */
function pinnedContentKey(snapshot: SurfaceSnapshot): string {
  const { stateId: _s, generatedAt: _g, origin: _o, ...content } = SurfaceSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)));
  // The backing component is named by its local name, wherever inside the
  // producer it now lives: a move between the producer's own projects is no
  // change a consumer's pin can see.
  return canonicalize({ ...content, interfaces: content.interfaces.map((e) => ({ ...e, component: lastSegment(e.component) })) });
}

/** Snapshot content minus provenance — whether two snapshots say the same thing. */
function surfaceContentKey(snapshot: SurfaceSnapshot): string {
  const { stateId, generatedAt, origin, ...content } = snapshot;
  return JSON.stringify(content);
}
