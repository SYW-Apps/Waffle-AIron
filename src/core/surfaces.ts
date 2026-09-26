import * as fs from 'fs';
import * as path from 'path';
import { getProjectRoot, getRequestParentReach, runWithProjectRoot } from '../utils/fs.js';
import { canonicalize } from '../utils/canonical-json.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';
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
  extractTypeIdentifiers,
  matchTypeRef,
  methodTypeRefs,
  BUILTIN_TYPES,
  contentDigest,
  memberDigest,
  type ExportUsage,
  type ExternalBinding,
  type ExternalListing,
  type ExternalLockEntry,
  type ExternalPin,
  type ExternalStatus,
  type ExternalUseStatus,
  type ExternalsLock,
  type ResolvedExternal,
} from '../models/index.js';
// surfaces_core_adapter: every name this subsystem takes from sdd_core lands on
// the adapter's own module, which re-exports it from the core portals.
import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadTypeSpecs,
  resolveChainingParent,
  resolveSubprojectForNamespace,
  computeStateId,
  resolveProjectExports,
  loadProjectConfig,
  resolveExternals,
} from './adapters/surfaces-core.js';
// The pinned-externals aggregate (externals_repository): the lock and the
// snapshots it names, apart from the legacy .wai/surfaces snapshots.
import { externalsRepository } from './externals.js';
import type { ChainingParentRef } from './specs.js';
import { fromOpenApi, isOpenApiDocument, toOpenApiSet } from './openapi.js';

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
    if (BUILTIN_TYPES.has(ref.toLowerCase())) return;
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
    for (const field of spec.fields) {
      for (const ref of extractTypeIdentifiers(field.type)) enqueueRef(ref);
    }
  }

  const usedIds = new Set<string>();
  return [...included.entries()].map(([qualified, t]) => {
    const id = usedIds.has(t.id) ? qualified : t.id;
    usedIds.add(id);
    return {
      id,
      name: t.name,
      kind: t.kind,
      fields: t.fields.map(f => ({
        name: f.name,
        type: f.type,
        ...(f.description ? { description: f.description } : {}),
        ...(f.optional ? { optional: true } : {}),
      })),
    };
  });
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
    .flatMap(i => i.methods);
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
    details: entry.details ?? '',
    ...(entry.version ? { version: entry.version } : {}),
    ...(entry.stability ? { stability: entry.stability } : {}),
    componentType: comp.componentType,
    ...(entry.interface ? { interface: entry.interface } : {}),
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

  // Steps 10-12: the project's id, the StateId, and the stamp.
  const projectId = boundProjectId();
  return SurfaceSnapshotSchema.parse({
    projectName: system.name,
    ...(projectId ? { projectId } : {}),
    origin: 'generated',
    stateId: stateIdString(),
    generatedAt: new Date().toISOString(),
    interfaces: entries,
    types: closure,
    ...(exportedTypes.length
      ? { exportedTypes: exportedTypes.map(e => ({ id: e.publicName, type: closureIdOf(e), audience: e.audience ?? 'instance' })) }
      : {}),
  });
}

/** The parent surface a chained child may see — the family ceiling includes project-audience entries. */
export function projectChildSurface(): SurfaceSnapshot {
  return projectOwnSurface('project');
}

/** The local (namespace-stripped) name of a possibly-qualified spec id. */
function localName(id: string): string {
  return id.split('::').pop()!;
}

/**
 * The stereotypes that can legally serve a cross-boundary caller, and therefore
 * the only ones a sibling surface may project. This is exactly the set the
 * boundary rules already sanction as a cross-subsystem dependency target
 * (a Portal — see rules/doctrine/subsystem-boundary-dependencies.ts) plus the Observer that may
 * back a MessageBus public interface (see rules/integrity/public-surface.ts). Anything
 * else is declarable as a published entry but never consumable across a
 * boundary, so projecting it would export a contract no sibling can call. A
 * gateway is a Portal with the gateway variant, so it projects as the Portal it is.
 */
const CROSS_BOUNDARY_TARGETS: ReadonlySet<string> = new Set(['Portal', 'Observer']);

/**
 * Project ONE subsystem's published surface — its L1 publicInterfaces realized
 * by a component that can legally serve a cross-boundary caller (a Portal, or
 * an Observer for an event surface), with full L3 contracts,
 * dispatch tables, and the transitive type closure — into a self-contained
 * contract-grade snapshot at the family ('project') audience ceiling. This is
 * the SIBLING view a chained child receives: siblings expose exactly what they
 * publish, nothing wider. The publishable set matches what the boundary rules
 * already sanction as a cross-subsystem dependency target, so a subsystem
 * publishing through a Portal or an Observer is projected rather than
 * silently absent from every child. A published entry whose backing
 * component can NEVER be a cross-boundary target is omitted and REPORTED as
 * a non-fatal diagnostic. The snapshot is keyed '<systemName>::<subsystemId>'
 * so sibling surfaces never collide with the parent family surface or
 * foreign imports, and carries the parent tree's StateId provenance.
 */
export function projectSubsystemSurface(subsystemId: string): SurfaceSnapshot {
  const system = loadSystemSpec();
  if (!system) {
    throw new Error('Cannot project a subsystem surface: the L0 system spec is missing.');
  }
  const subsystems = loadSubsystemSpecs();
  const target = subsystems.find(s => s.id === subsystemId);
  if (!target) {
    throw new Error(`Cannot project a subsystem surface: subsystem "${subsystemId}" does not exist.`);
  }
  const components = loadComponentSpecs();
  const interfaces = loadInterfaceSpecs();
  const types = loadTypeSpecs();

  const entries: SurfaceContractEntry[] = [];
  // Published entries whose backing component can never be a cross-boundary
  // target: omitted from the projection AND reported below, so an author learns
  // why a child cannot see them instead of finding an unexplained gap.
  const unprojectable: { component: string; componentType: string }[] = [];
  for (const pub of target.publicInterfaces ?? []) {
    // Unbound entries, and entries naming a component that does not exist, are
    // deliberately NOT reported here — the validator already raises those as
    // errors (PUBLIC_INTERFACE_UNBOUND / PUBLIC_INTERFACE_INVALID_COMPONENT), so
    // a diagnostic would be duplicate noise.
    if (!pub.component) continue; // unbound published entries cannot be exported
    // An external (chained) sibling's members load namespace-qualified; match both forms.
    const comp = components.find(c =>
      c.id === pub.component || c.id === `${subsystemId}::${pub.component}`);
    if (!comp) continue;
    // Siblings expose exactly what they publish, and only through a component a
    // cross-boundary caller can actually reach. A published entry backed by
    // anything else (a 'Custom' entry over an Orchestrator or a Store, say)
    // is unprojectable — collected for reporting rather than silently dropped.
    if (!CROSS_BOUNDARY_TARGETS.has(comp.componentType)) {
      unprojectable.push({ component: pub.component, componentType: comp.componentType });
      continue;
    }

    const compInterfaces = interfaces.filter(i =>
      i.component === comp.id
      && (!pub.interface || i.id === pub.interface || i.id === `${subsystemId}::${pub.interface}`));
    const methods = compInterfaces.flatMap(i => i.methods);

    entries.push({
      id: localName(pub.interface ?? comp.id),
      name: comp.name,
      // Family ceiling: a sibling surface is consumable by the system family only.
      audience: 'project',
      type: pub.type ?? 'Custom',
      // The snapshot carries the LOCAL portal name — consumers resolve cross-tree
      // refs by their final segment.
      component: localName(comp.id),
      methods,
      ...(comp.dispatch && comp.dispatch.length ? { dispatch: comp.dispatch } : {}),
      // Project the backing component's auth + basePath so the codec can emit
      // OpenAPI security + per-portal servers self-contained from the snapshot.
      ...(comp.auth && comp.auth.scheme !== 'none' ? { auth: comp.auth } : {}),
      ...(comp.basePath ? { basePath: comp.basePath } : {}),
      details: pub.details ?? '',
    });
  }

  // Report the skipped-what-and-why at generation time (same shape the variant
  // loader uses for a skipped variant file) — a gap in a child's sibling surface
  // is explained now rather than discovered later as a missing contract.
  for (const skipped of unprojectable) {
    console.error(
      `[surfaces] skipped "${subsystemId}::${skipped.component}": a published ${skipped.componentType} can never serve a cross-boundary caller, so it stays out of every chained child's sibling surface — publish this surface through a Portal, or an Observer (for events).`,
    );
  }

  return SurfaceSnapshotSchema.parse({
    projectName: `${system.name}::${subsystemId}`,
    origin: 'generated',
    stateId: stateIdString(),
    generatedAt: new Date().toISOString(),
    interfaces: entries,
    types: computeTypeClosure(entries, types),
  });
}

// ---------------------------------------------------------------------------
// Stored snapshots (surface_repository over .wai/surfaces/)
// ---------------------------------------------------------------------------

export function listSnapshots(rootDir: string = getProjectRoot()): SurfaceSnapshot[] {
  const dir = surfacesDir(rootDir);
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
}

export function getSnapshot(projectName: string, rootDir: string = getProjectRoot()): SurfaceSnapshot | null {
  return listSnapshots(rootDir).find(s => s.projectName === projectName) ?? null;
}

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

export function saveSnapshot(snapshot: SurfaceSnapshot, rootDir: string = getProjectRoot()): string {
  return writeSnapshotIfChanged(snapshot, rootDir).path;
}

export function removeSnapshot(projectName: string, rootDir: string = getProjectRoot()): boolean {
  const dir = surfacesDir(rootDir);
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
}

/**
 * surface_fs_adapter.readAllSnapshots (and the registry's and repository's
 * hydrate, which read through it) — every stored snapshot of the bound root.
 */
export function loadSurfaceSnapshots(): SurfaceSnapshot[] {
  return listSnapshots();
}

/**
 * surface_orchestrator.listMountSnapshots — the snapshots each chained mount
 * holds in its OWN `.wai/surfaces/`, keyed by the mount's namespace.
 *
 * A chained child may import a foreign project's surface. From the child's
 * root that snapshot is simply one of "this project's snapshots"; from the
 * parent root nothing ever read it, so the child's `super::crm-portal` — which
 * collapses to a bare `crm-portal` under the parent — was judged a local typo.
 *
 * Kept per mount, never pooled with the bound root's own snapshots: a contract
 * the child imported decides only the child's references.
 */
export function listMountSnapshots(mounts: string[]): { namespace: string; snapshots: SurfaceSnapshot[] }[] {
  const bound = path.resolve(getProjectRoot());
  const out: { namespace: string; snapshots: SurfaceSnapshot[] }[] = [];
  for (const namespace of mounts) {
    const dir = resolveSubprojectForNamespace(namespace);
    if (!dir || path.resolve(dir) === bound) continue;
    const snapshots = listSnapshots(dir);
    if (snapshots.length > 0) out.push({ namespace, snapshots });
  }
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
function writeSurfaceFile(outPath: string, snapshot: SurfaceSnapshot, renderedSet?: NamedOpenApiSpec[]): string[] {
  const resolved = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (!renderedSet || renderedSet.length === 0) {
    writeYamlFile(resolved, snapshot);
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

export function exportSurface(maxAudience: string, format: string, outPath?: string, portalId?: string): SurfaceExportResult {
  const snapshot = projectOwnSurface(maxAudience);
  let renderedSet = format === 'openapi' ? toOpenApiSet(snapshot) : undefined;
  if (renderedSet && portalId) renderedSet = selectPortalSpec(renderedSet, portalId);
  const writtenPaths = outPath ? writeSurfaceFile(outPath, snapshot, renderedSet) : [];
  return exportResult(snapshot, renderedSet, writtenPaths);
}

export function importSurface(sourcePath: string, origin: SurfaceOrigin): SurfaceSnapshot {
  const resolved = path.resolve(sourcePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Surface document not found: ${resolved}`);
  }
  const body = fs.readFileSync(resolved, 'utf8');

  let snapshot: SurfaceSnapshot;
  if (isOpenApiDocument(body)) {
    const projectName = path.basename(resolved).replace(/\.(json|ya?ml)$/i, '');
    snapshot = fromOpenApi(body, projectName);
    snapshot = { ...snapshot, origin };
  } else {
    snapshot = SurfaceSnapshotSchema.parse(readYamlFile(resolved));
    snapshot = { ...snapshot, origin };
  }
  saveSnapshot(snapshot);
  return snapshot;
}

/**
 * What a chained child's family publishes to it NOW, keyed as a pin stores it:
 * the family-scoped parent surface under the parent system name, then the
 * published surface of every sibling — each top-level parent subsystem but the
 * child's own mount — under '<systemName>::<subsystemId>'. The parent root is
 * bound read-only for the projection and the child's binding is restored
 * afterwards. A pin stores exactly this, and freshness is judged against it.
 */
function projectFamilySurfaces(parent: ChainingParentRef): SurfaceSnapshot[] {
  return runWithProjectRoot(parent.parentRoot, () => {
    // The parent is read as it is NOW without asking for it here: a write in
    // this process drops every workspace's cache, and the loader re-checks a
    // cached tree's file signature against the disk before it serves it.
    const siblings = loadSubsystemSpecs()
      .filter((s) => !s.id.includes('::') && s.id !== parent.subsystemId);
    return [projectChildSurface(), ...siblings.map((s) => projectSubsystemSurface(s.id))];
  });
}

/**
 * surface_orchestrator.pinFamilySurfaces — a chained child PULLS its family's
 * surfaces into its own `.wai/surfaces/`.
 *
 * It replaced delivery, which was pushed: every parent lock wrote (children x
 * subsystems) snapshots into every child's working tree on the parent's
 * schedule, and the hosted lock never delivered at all. A pin is the child
 * owner's own import,
 * taken while the parent is on disk and committed with the child, so a child
 * cloned WITHOUT its parent still has contracts to validate against.
 *
 * Projects exactly what a child may consume: the family-scoped parent surface,
 * and every sibling's published surface except the child's own mount. Returns
 * the paths whose content changed, or null when this root has no parent.
 */
export function pinFamilySurfaces(): string[] | null {
  const parent = resolveChainingParent();
  if (!parent) return null;
  const childRoot = getProjectRoot();

  const projected = projectFamilySurfaces(parent);

  const before = new Map(listSnapshots(childRoot).map((s) => [s.projectName, surfaceContentKey(s)]));
  const changed: string[] = [];
  for (const snapshot of projected) {
    const stored = saveSnapshot(snapshot, childRoot);
    if (before.get(snapshot.projectName) !== surfaceContentKey(SurfaceSnapshotSchema.parse(snapshot))) {
      changed.push(stored);
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// External-surface discovery (listExternalInterfaces) — the scope-aware
// catalog of this project's outward world: parent family surface, sibling
// surfaces, and foreign imports, each with a freshness verdict.
// ---------------------------------------------------------------------------

/**
 * One row of the external-interface discovery listing: a vendored surface
 * snapshot this project can consume, summarized with its origin, family role,
 * provenance, and a freshness verdict. The full contracts stay in the
 * referenced SurfaceSnapshot — this is the catalog view served to agents
 * (sdd_list_external_interfaces) and the CLI (`wairon surface externals`).
 */
export interface ExternalSurfaceEntry {
  /** The snapshot's storage key: the producing project's name, or '<systemName>::<subsystemId>' for a sibling surface. */
  projectName: string;
  /** Snapshot origin: 'generated' | 'exchanged' | 'authored'. */
  origin: SurfaceOrigin;
  /** Family role from THIS project's standpoint. */
  sourceKind: 'parent' | 'sibling' | 'foreign';
  /** ISO-8601 timestamp the snapshot was produced. */
  generatedAt: string;
  /** Producing tree's state hash at generation time, when stamped. */
  stateId?: string;
  /** Producer-declared version, for authored/exchanged snapshots carrying one. */
  version?: string;
  /**
   * 'fresh' when the snapshot's content equals what the chaining parent projects
   * for the same key now; 'stale' when it differs or that key is no longer
   * projected; 'unverifiable' when no parent is in reach or the snapshot is foreign.
   */
  freshness: 'fresh' | 'stale' | 'unverifiable';
  /** Ids of the interfaces the snapshot exposes — the discovery summary. */
  interfaceIds: string[];
  /** The producing project's id, when the snapshot records one — beside projectName, the display name and storage key. */
  projectId?: string;
}

/**
 * The content of every surface the chaining parent projects for this child
 * now, by storage key. Null when the parent's tree cannot be projected at all —
 * its L0 no longer loads, say — so there is nothing to judge a pin against.
 */
function projectedFamilyContent(parent: ChainingParentRef): Map<string, string> | null {
  try {
    return new Map(projectFamilySurfaces(parent).map((s) => [s.projectName, surfaceContentKey(s)]));
  } catch {
    return null;
  }
}

/**
 * Scope-aware discovery of this project's outward world: every vendored
 * surface snapshot as an ExternalSurfaceEntry. sourceKind classification:
 * 'parent' is the generated family surface keyed by the parent system name;
 * 'sibling' is a generated '<systemName>::<subsystemId>' key; 'foreign' is an
 * exchanged/authored import.
 *
 * Freshness is judged on content. When the chaining parent is in reach, what it
 * publishes now is projected exactly as a pin would store it, and a generated
 * snapshot is 'fresh' when its content equals the projection under the same
 * key, 'stale' when it differs or that key is no longer projected. Provenance
 * never decides: a pin leaves a snapshot whose content is unchanged untouched,
 * so its stateId rightly predates any unrelated parent edit — which is why a
 * re-pin always repairs a stale entry. Entries are 'unverifiable' when no
 * parent is in reach (standalone, or a request narrowed to the child), when the
 * parent cannot be projected, or when the snapshot is foreign.
 */
export function listExternalInterfaces(): ExternalSurfaceEntry[] {
  const snapshots = listSnapshots();
  // Reach-gated: null for a top root, and for a request that may not read above its root.
  const chainingParent = resolveChainingParent();
  const projected = chainingParent ? projectedFamilyContent(chainingParent) : null;

  return snapshots.map(snapshot => {
    const generated = snapshot.origin === 'generated';
    const sourceKind: ExternalSurfaceEntry['sourceKind'] = !generated
      ? 'foreign'
      : snapshot.projectName.includes('::') ? 'sibling' : 'parent';
    const freshness: ExternalSurfaceEntry['freshness'] = generated && projected
      ? (projected.get(snapshot.projectName) === surfaceContentKey(snapshot) ? 'fresh' : 'stale')
      : 'unverifiable';
    return {
      projectName: snapshot.projectName,
      origin: snapshot.origin,
      sourceKind,
      generatedAt: snapshot.generatedAt,
      ...(snapshot.stateId ? { stateId: snapshot.stateId } : {}),
      ...(snapshot.version ? { version: snapshot.version } : {}),
      freshness,
      interfaceIds: snapshot.interfaces.map(e => e.id),
      ...(snapshot.projectId ? { projectId: snapshot.projectId } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Declared externals (surface_orchestrator pinExternals / getExternalsStatus /
// listExternals) â€” `wairon externals` and the sdd_pin_externals /
// sdd_get_externals_status tools. The core binds each declared external to its
// producer (the surfaces plane never walks the family itself); this plane
// projects the producer's export table, pins it under .wai/externals/ and
// records in the lock the digest of every member the consumer uses.
// ---------------------------------------------------------------------------

/** The code on every comparison that could not be made â€” never a pass. */
const CHECK_UNAVAILABLE = 'EXTERNAL_CHECK_UNAVAILABLE';

/** Why nothing outside the family can be used or compared in stage 2. */
const OUTSIDE_FAMILY = 'no stage-2 reference form reaches a project outside the family, so nothing it exports can be used or compared until stage 3\'s `alias::name`';

/** An alias the project does not declare, named to pin: refused before anything is written. */
export class UnknownExternalAliasError extends Error {
  constructor(unknown: string[], declared: string[]) {
    super(`Unknown external alias${unknown.length > 1 ? 'es' : ''} ${unknown.map((a) => `"${a}"`).join(', ')} â€” this project declares ${declared.length ? declared.map((a) => `"${a}"`).join(', ') : 'no externals'} in .wai/project.yaml.`);
    this.name = 'UnknownExternalAliasError';
  }
}

/** Whether `target` is `dir` or lies under it. */
function isWithinDir(dir: string, target: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Why a producer's root cannot be read, or null when it can. The caller must
 * gate on reach itself: a root outside the request's reach is never read.
 */
function producerUnreadable(directory: string | undefined): string | null {
  if (!directory) return 'the producer has no root directory';
  const reach = getRequestParentReach();
  if (reach) {
    const bound = getProjectRoot();
    const ceiling = reach.parentReach ? reach.topRoot ?? bound : bound;
    if (!isWithinDir(ceiling, directory)) return 'its root is outside the request\'s reach';
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
  const snapshot = runWithProjectRoot(external.directory!, () => projectOwnSurface(external.audience));
  return { ...snapshot, audience: external.audience };
}

/** The lock's `used` map for one binding: each used member's digest in the pinned snapshot. */
function usedDigests(usage: ExportUsage | undefined, snapshot: SurfaceSnapshot): { used: Record<string, Record<string, string>>; missing: string[] } {
  const used: Record<string, Record<string, string>> = {};
  const missing: string[] = [];
  for (const use of usage?.used ?? []) {
    const members: Record<string, string> = {};
    for (const member of use.members) {
      const digest = memberDigest(snapshot, use.publicName, member);
      if (digest === null) missing.push(`${use.publicName}.${member}`);
      else members[member] = digest;
    }
    used[use.publicName] = members;
  }
  return { used, missing };
}

/** Pin one resolved binding: the snapshot written when its content moved, and the lock entry. */
function pinBinding(binding: ExternalBinding, lock: ExternalsLock): { pin: ExternalPin; changed: boolean } {
  const { external } = binding;
  const unexported = binding.usage?.unexported ?? [];
  // Step 8: bind the producer's root, when it can be read.
  const unreadable = producerUnreadable(external.directory);
  let snapshot: SurfaceSnapshot;
  try {
    if (unreadable) throw new Error(unreadable);
    // Steps 9-10: project it at the audience ceiling, stamped with that audience.
    snapshot = projectProducer(external);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { pin: { alias: external.alias, outcome: 'unreachable', project: external.project, usedNames: 0, unexported, detail: `the producer could not be read: ${detail}; its previous pin stays` }, changed: false };
  }
  const digest = contentDigest(snapshot);
  // Steps 11-13: the snapshot is rewritten only when its content moved.
  const pinned = externalsRepository.readSnapshot(external.alias);
  const snapshotChanged = !pinned || contentDigest(pinned) !== digest;
  if (snapshotChanged) externalsRepository.saveSnapshot(external.alias, snapshot);
  // Step 14: the lock entry â€” `used` maps each used member to its digest.
  const { used, missing } = usedDigests(binding.usage, snapshot);
  const entry: ExternalLockEntry = { project: external.project, snapshot: `.wai/externals/${external.alias}.yaml`, digest, used };
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
      unexported,
      ...(missing.length ? { detail: `used members the snapshot does not carry cannot be pinned: ${missing.join(', ')}` } : {}),
    },
    changed: entryChanged,
  };
}

/**
 * surface_orchestrator.pinExternals â€” pin the bound project's declared
 * externals (the named aliases, else all) into .wai/externals/<alias>.yaml and
 * .wai/externals.lock.yaml. An alias the project does not declare is refused
 * before anything is written; an unresolved or unreachable producer is
 * reported and leaves its previous pin in place. With no aliases named, pins
 * for aliases no longer declared are removed.
 */
export function pinExternals(aliases?: string[]): ExternalPin[] {
  // Step 1: the declared externals, each bound to its producer.
  const bindings = resolveExternals();
  // Steps 2-4: the aliases asked for â€” an undeclared one refused before any write.
  const declared = bindings.map((b) => b.external.alias);
  const named = aliases && aliases.length > 0 ? aliases : undefined;
  const unknown = (named ?? []).filter((a) => !declared.includes(a));
  if (unknown.length) throw new UnknownExternalAliasError(unknown, declared);
  const kept = named ? bindings.filter((b) => named.includes(b.external.alias)) : bindings;
  // Step 5: the current lock (none yet reads as empty).
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
  // Steps 18-20: with no aliases named, prune the aliases no longer declared.
  if (!named) {
    for (const alias of Object.keys(lock.externals)) {
      if (declared.includes(alias)) continue;
      delete lock.externals[alias];
      externalsRepository.removeSnapshot(alias);
      lockChanged = true;
    }
  }
  // Steps 21-22: the lock, written only when an entry was added, changed or pruned.
  if (lockChanged) externalsRepository.saveLock(lock);
  // Step 23: one outcome per external handled, in declaration order.
  return pins;
}

/** Compare every used member â€” the lock's, and the one the references use now â€” with the live snapshot. */
function compareUses(entry: ExternalLockEntry | undefined, usage: ExportUsage | undefined, live: SurfaceSnapshot): ExternalUseStatus[] {
  const uses: ExternalUseStatus[] = [];
  const locked = entry?.used ?? {};
  const liveHas = (name: string): boolean => live.interfaces.some((e) => e.id === name) || (live.exportedTypes ?? []).some((t) => t.id === name);
  for (const [publicName, members] of Object.entries(locked)) {
    if (Object.keys(members).length === 0) {
      uses.push({ publicName, state: liveHas(publicName) ? 'unchanged' : 'removed' });
      continue;
    }
    for (const [member, digest] of Object.entries(members)) {
      const now = memberDigest(live, publicName, member);
      uses.push({ publicName, member, state: now === null ? 'removed' : now === digest ? 'unchanged' : 'changed' });
    }
  }
  for (const use of usage?.used ?? []) {
    if (!(use.publicName in locked)) {
      uses.push({ publicName: use.publicName, state: 'unlocked', detail: 'used now, but not in the lock â€” re-pin' });
      continue;
    }
    for (const member of use.members) {
      if (!(member in locked[use.publicName])) uses.push({ publicName: use.publicName, member, state: 'unlocked', detail: 'used now, but not in the lock â€” re-pin' });
    }
  }
  for (const ref of usage?.unexported ?? []) {
    uses.push({ member: ref.member, state: 'unavailable', code: CHECK_UNAVAILABLE, detail: `"${ref.specId}" reaches "${ref.target}", which the producer does not export â€” nothing to compare` });
  }
  return uses;
}

/** Every locked used member â€” or, when none is locked, the external itself â€” as unavailable. */
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
  // Step 4: its pinned snapshot, if any.
  const pinned = entry !== undefined && externalsRepository.readSnapshot(external.alias) !== null;
  const base = { alias: external.alias, project: external.project, sourceKind: external.sourceKind, pinned };
  // Step 5: can the live producer be read?
  const unreadable = external.sourceKind === 'unresolved'
    ? `the external does not resolve: ${external.problem}`
    : producerUnreadable(external.directory);
  let live: SurfaceSnapshot | null = null;
  let reason = unreadable;
  if (!reason) {
    try {
      // Steps 6-7: the producer's live table at the audience ceiling.
      live = projectProducer(external);
    } catch (e) {
      reason = `the producer could not be read: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (!live) {
    // Step 10: nothing could be compared â€” never a pass.
    return { ...base, reachable: false, stale: false, uses: unavailableUses(entry, reason!), detail: reason! };
  }
  // Step 8: a producer outside the family has no used members to compare.
  const drifted = entry !== undefined ? contentDigest(live) !== entry.digest : undefined;
  if (external.sourceKind === 'path') {
    return { ...base, reachable: true, stale: false, ...(drifted !== undefined ? { drifted } : {}), uses: [{ state: 'unavailable', code: CHECK_UNAVAILABLE, detail: OUTSIDE_FAMILY }], detail: OUTSIDE_FAMILY };
  }
  const uses = compareUses(entry, binding.usage, live);
  return {
    ...base,
    reachable: true,
    stale: uses.some((u) => u.state === 'changed' || u.state === 'removed'),
    ...(drifted !== undefined ? { drifted } : {}),
    uses,
  };
}

/**
 * surface_orchestrator.getExternalsStatus â€” each declared external's pin
 * compared with its live producer at signature level (decision 19). What
 * cannot be compared is EXTERNAL_CHECK_UNAVAILABLE, never a pass. It only
 * reports: it writes nothing and fails nothing.
 */
export function getExternalsStatus(): ExternalStatus[] {
  // Step 1: the declared externals, with the references as they are now.
  const bindings = resolveExternals();
  // Step 2: the lock.
  const lock = externalsRepository.readLock();
  // Steps 3-12: one status per declared external, in declaration order.
  return bindings.map((binding) => externalStatus(binding, lock));
}

/**
 * surface_orchestrator.listExternals â€” each declared external with how it
 * resolves, the audience the consumer sees and the lock's entry when pinned.
 * No live comparison.
 */
export function listExternals(): ExternalListing[] {
  // Step 1: the declared externals.
  const bindings = resolveExternals();
  // Step 2: the lock.
  const lock = externalsRepository.readLock();
  // Steps 3-4: one row per declared external, in declaration order.
  return bindings.map(({ external }) => {
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
}

// ---------------------------------------------------------------------------
// Snapshot content identity
// ---------------------------------------------------------------------------

/** Snapshot content minus provenance — whether two snapshots say the same thing. */
function surfaceContentKey(snapshot: SurfaceSnapshot): string {
  const { stateId, generatedAt, origin, ...content } = snapshot;
  return JSON.stringify(content);
}
