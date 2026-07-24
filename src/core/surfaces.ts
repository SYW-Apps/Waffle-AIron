import * as fs from 'fs';
import * as path from 'path';
import { getProjectRoot } from '../utils/fs.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';
import { safeFilenamePart } from '../utils/filenames.js';
import {
  SurfaceSnapshot,
  SurfaceSnapshotSchema,
  SurfaceContractEntry,
  SurfaceTypeDef,
  SurfaceOrigin,
  SURFACE_AUDIENCES,
  SystemPublicInterface,
  NamedOpenApiSpec,
  TypeSpec,
} from '../models/index.js';
import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadTypeSpecs,
} from './specs.js';
import { computeStateId } from './statehash.js';
import { extractTypeIdentifiers, matchTypeRef, methodTypeRefs, BUILTIN_TYPES } from './rules/type-analysis.js';
import { fromOpenApi, isOpenApiDocument, toOpenApiSet } from './openapi.js';
import type { ValidationIssue } from './validation.js';

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

/**
 * Transitive type closure: every type reachable from the exported method
 * signatures (params + returns), following field type references. The
 * snapshot must be self-contained — types are the one sanctioned
 * cross-boundary "internal", so a consumer's type resolution has to work
 * without the producing tree.
 */
function computeTypeClosure(entries: SurfaceContractEntry[], types: TypeSpec[]): SurfaceTypeDef[] {
  const included = new Map<string, TypeSpec>();
  const queue: string[] = [];

  const enqueueRef = (ref: string): void => {
    if (BUILTIN_TYPES.has(ref.toLowerCase())) return;
    for (const spec of types) {
      const qualifiedId = spec.subsystem && !spec.id.startsWith(`${spec.subsystem}::`)
        ? `${spec.subsystem}::${spec.id}`
        : spec.id;
      if (matchTypeRef(ref, qualifiedId) && !included.has(spec.id)) {
        included.set(spec.id, spec);
        queue.push(spec.id);
      }
    }
  };

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

  return [...included.values()].map(t => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    fields: t.fields.map(f => ({
      name: f.name,
      type: f.type,
      ...(f.description ? { description: f.description } : {}),
      ...(f.optional ? { optional: true } : {}),
    })),
  }));
}

/**
 * Project the own tree's L0 gateway surface into a contract-grade snapshot.
 * `maxAudience` is the consumer's distance class: an entry is included when
 * its declared reach covers that distance (rank(entry) >= rank(maxAudience)).
 * The family ceiling 'project' therefore includes everything.
 */
export function projectOwnSurface(maxAudience: string): SurfaceSnapshot {
  const system = loadSystemSpec();
  if (!system) {
    throw new Error('Cannot project a surface: the L0 system spec is missing.');
  }
  const subsystems = loadSubsystemSpecs();
  const components = loadComponentSpecs();
  const interfaces = loadInterfaceSpecs();
  const types = loadTypeSpecs();

  const floor = audienceRank(maxAudience);
  const rawEntries: SystemPublicInterface[] = system.publicInterfaces ?? [];

  const entries: SurfaceContractEntry[] = [];
  for (const raw of rawEntries) {
    const audience = raw.audience ?? 'instance';
    if (audienceRank(audience) < floor) continue;
    if (!raw.component) continue; // unbound gateway entries cannot be exported

    const comp = components.find(c => c.id === raw.component);
    if (!comp) continue;
    const compInterfaces = interfaces.filter(i =>
      i.component === comp.id && (!raw.interface || i.id === raw.interface));
    const methods = compInterfaces.flatMap(i => i.methods);

    const subsystemType = subsystems
      .find(s => s.id === comp.subsystem)?.publicInterfaces
      .find(pi => pi.component === comp.id)?.type;

    entries.push({
      id: raw.id ?? raw.interface ?? comp.id,
      name: raw.name ?? comp.name,
      audience,
      type: raw.type ?? subsystemType ?? 'Custom',
      component: comp.id,
      methods,
      ...(comp.dispatch && comp.dispatch.length ? { dispatch: comp.dispatch } : {}),
      // Project the backing Portal's auth + basePath so the codec can emit
      // OpenAPI security + per-portal servers self-contained from the snapshot.
      ...(comp.auth && comp.auth.scheme !== 'none' ? { auth: comp.auth } : {}),
      ...(comp.basePath ? { basePath: comp.basePath } : {}),
      details: raw.details ?? '',
      ...(raw.version ? { version: raw.version } : {}),
      ...(raw.stability ? { stability: raw.stability } : {}),
    });
  }

  return SurfaceSnapshotSchema.parse({
    projectName: system.name,
    origin: 'generated',
    stateId: stateIdString(),
    generatedAt: new Date().toISOString(),
    interfaces: entries,
    types: computeTypeClosure(entries, types),
  });
}

/** The parent surface a chained child may see — the family ceiling includes project-audience entries. */
export function projectChildSurface(): SurfaceSnapshot {
  return projectOwnSurface('project');
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

export function saveSnapshot(snapshot: SurfaceSnapshot, rootDir: string = getProjectRoot()): string {
  const dir = surfacesDir(rootDir);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${snapshot.projectName}.yaml`);
  writeYamlFile(p, SurfaceSnapshotSchema.parse(snapshot));
  return p;
}

export function removeSnapshot(projectName: string, rootDir: string = getProjectRoot()): boolean {
  const p = path.join(surfacesDir(rootDir), `${projectName}.yaml`);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

/** Validator-facing load (validator_surfaces_adapter realization). */
export function loadSurfaceSnapshots(): SurfaceSnapshot[] {
  return listSnapshots();
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
 * Write the family-scoped parent surface into every chained child project's
 * .wai/surfaces/, so children can validate cross-tree references standalone.
 */
export function generateChildSnapshots(rootDir: string = getProjectRoot()): string[] {
  const children = loadSubsystemSpecs().filter(s => s.projectPath && !s.id.includes('::'));
  if (!children.length) return [];
  const snapshot = projectChildSurface();
  const written: string[] = [];
  for (const child of children) {
    const childDir = path.resolve(rootDir, child.projectPath!);
    if (!fs.existsSync(childDir)) continue;
    written.push(saveSnapshot(snapshot, childDir));
  }
  return written;
}

// ---------------------------------------------------------------------------
// Freshness (SURFACE_STALE) — computable exactly where both sides are visible:
// validating from the parent, each chained child's stored parent-snapshot can
// be compared against the parent's CURRENT StateId.
// ---------------------------------------------------------------------------

/** Snapshot content minus provenance — what staleness is actually about. */
function surfaceContentKey(snapshot: SurfaceSnapshot): string {
  const { stateId, generatedAt, origin, ...content } = snapshot;
  return JSON.stringify(content);
}

export function checkChildSurfaceFreshness(rootDir: string = getProjectRoot()): ValidationIssue[] {
  const system = loadSystemSpec();
  if (!system) return [];
  const children = loadSubsystemSpecs().filter(s => s.projectPath && !s.id.includes('::'));
  if (!children.length) return [];

  // Compare CONTENT, not tree StateIds: a child editing its own specs shifts
  // the recursive StateId without changing the parent's exported contracts,
  // and that must not read as staleness.
  const current = surfaceContentKey(projectChildSurface());
  const issues: ValidationIssue[] = [];
  for (const child of children) {
    const childDir = path.resolve(rootDir, child.projectPath!);
    const held = getSnapshot(system.name, childDir);
    if (!held || held.origin !== 'generated') continue;
    if (surfaceContentKey(held) !== current) {
      issues.push({
        severity: 'warning',
        code: 'SURFACE_STALE',
        message: `Chained child "${child.id}" holds a parent surface snapshot whose contracts no longer match the current tree — rerun \`wairon surface generate-children\` so the child validates against the current surface.`,
        specId: child.id,
      });
    }
  }
  return issues;
}
