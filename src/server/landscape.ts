import type { IncomingMessage, ServerResponse } from 'http';
import { runWithProjectRoot } from '../utils/fs.js';
import { readYamlFile } from '../utils/yaml.js';
import { AI_PATHS } from '../config/loader.js';
import { authenticateCredential } from './auth.js';
import { UnauthenticatedError, ForbiddenError } from './identity.js';
import { appendAuditEvent, DEFAULT_AUDIT_POLICY } from './audit.js';
import { resolveProjectRoot, listProjectRecords } from './projects.js';
import { hostCore } from './adapters.js';
import {
  upsertOrganizationUnit,
  placeProject as placeProjectInUnit,
  listOrganizationUnits,
  listProjectPlacements,
  getOrganizationUnit,
} from './organization.js';
import {
  upsertProjectRelation,
  removeProjectRelation,
  listProjectRelations,
} from './relations.js';
import {
  replacePublicSurfaceSnapshot,
  getPublicSurfaceSnapshot,
  findPublicInterface,
} from './surfaces.js';
import { sendJson } from './request.js';
import { resolveScope, resolveScopeFor, permits } from './scope.js';
import { resolveVisibility, isVisible, audienceDistance, audienceCovers } from './visibility.js';
import { hostSurfaces } from './adapters.js';
import * as yamlLib from 'js-yaml';
import type {
  AuditEvent,
  AuditRetentionPolicy,
  HostConfig,
  HostedProjectRecord,
  LandscapeEdge,
  LandscapeGraphModel,
  LandscapeNode,
  OrganizationUnitRecord,
  Principal,
  PrincipalSubject,
  ProjectPlacement,
  ProjectPublicSurfaceSnapshot,
  ProjectRelationRecord,
  PublicInterfaceSummary,
  ReachableProjectRef,
  ScopeResolution,
  VisibleSurfaceEntry,
  SurfaceArtifact,
} from './types.js';
import type { SurfaceSnapshot } from '../models/index.js';

// ---------------------------------------------------------------------------
// Landscape Orchestrator + Diagram Specialist + Portal (sdd_host) — Phase 4
//
// Hosted-instance landscape workflows: organization-unit administration, project
// placement, public-surface snapshot refresh, cross-project relation management,
// landscape graph generation, and the two data-plane MCP discovery workflows.
// Every credential-bearing method authenticates through the single auth authority
// (auth_specialist) and authorizes by Principal grants — landscape:manage or
// instance-admin for writes, landscape:read (or manage/admin) for control-plane
// reads. Reachability for discovery is DIRECTIONAL and RELATIONS-ONLY: a target
// is reachable from the current project only through an ACTIVE relation whose
// sourceProjectId is the current project — placements confer none and there is no
// transitive closure. Cross-project reads never touch target private specs; they
// read only the stored redacted public-surface snapshots. Audit appends
// (unit.upsert, project.place, relation.upsert, relation.remove, surface.refresh —
// all info) are best-effort and never fail the primary action; control-plane reads
// and MCP discovery are not audited (the data-plane mcp.tool.call append covers
// discovery). Exported as plain functions so both the HTTP portal and any
// in-process caller (the request orchestrator's MCP dispatch) reach the same logic.
// ---------------------------------------------------------------------------

const LANDSCAPE_MANAGE_PERMISSION = 'landscape:manage';
const LANDSCAPE_READ_PERMISSION = 'landscape:read';

// ── authorization helpers (scope-aware — Phase 6 tenancy) ────────────────────
//
// Every control-plane method resolves the caller's landscape scope for the
// permission it needs (landscape:manage for writes, landscape:read for reads),
// via scope_specialist over the org unit tree + placements. A '*'/'*' bootstrap
// or an instance-wide ({projectId:'*'}) grant carrying the permission resolves to
// `all` (super-admin, unfiltered). A unit-scoped grant expands to that unit's
// recursive subtree of units + every project placed in it: reads FILTER to that
// scope and writes require the write target to fall inside it.

/** Authenticate the caller credential or throw (401-mapping). */
function requirePrincipal(cfg: HostConfig, credential: string | null): Principal {
  const principal = authenticateCredential(cfg.dataDir, credential);
  if (!principal.authenticated) throw new UnauthenticatedError();
  return principal;
}

/** A scoped caller with neither an in-scope project nor an in-scope unit has no
 *  reach at all — the control-plane reads treat that as Forbidden. */
function scopeIsEmpty(scope: ScopeResolution): boolean {
  return !scope.all && scope.projectIds.length === 0 && scope.unitIds.length === 0;
}

/**
 * Resolve the caller's landscape READ scope: the union of their landscape:read and
 * landscape:manage scopes over the pre-gathered org tree — a manage grant (unit-
 * scoped or instance-wide) also confers read over the same subtree, and the
 * instance-admin/instance-wide wildcard yields `all`. Pure over the supplied
 * units/placements (no extra I/O).
 */
function resolveLandscapeReadScope(
  principal: Principal,
  units: OrganizationUnitRecord[],
  placements: ProjectPlacement[],
): ScopeResolution {
  const grants = principal.grants ?? [];
  const read = resolveScope(grants, LANDSCAPE_READ_PERMISSION, units, placements);
  if (read.all) return read;
  const manage = resolveScope(grants, LANDSCAPE_MANAGE_PERMISSION, units, placements);
  if (manage.all) return manage;
  return {
    all: false,
    projectIds: [...new Set([...read.projectIds, ...manage.projectIds])],
    unitIds: [...new Set([...read.unitIds, ...manage.unitIds])],
  };
}

// ── subject / audit helpers (mirrored from identity.ts / policy.ts) ──────────

/** The stable subject for a principal: its resolved subject, or a synthesized
 *  service identity keyed by the credential's token id for legacy credentials. */
function principalSubject(principal: Principal): PrincipalSubject {
  return (
    principal.subject ?? { userId: 'token:' + principal.tokenId, kind: 'service', issuer: 'local' }
  );
}

function resolveAuditPolicy(_cfg: HostConfig): AuditRetentionPolicy {
  return DEFAULT_AUDIT_POLICY;
}

function buildAuditEvent(
  principal: Principal,
  action: string,
  level: string,
  category: string,
  over: Partial<AuditEvent> = {},
): AuditEvent {
  const event: AuditEvent = {
    id: '',
    timestamp: '',
    level,
    category,
    action,
    outcome: 'success',
    actor: principalSubject(principal),
    ...over,
  };
  if (principal.tokenId) event.tokenId = principal.tokenId;
  return event;
}

/** Append a redacted audit event, best-effort: a failure is recorded as a server
 *  diagnostic and swallowed so an append can never fail the primary action. */
function tryAppendAudit(cfg: HostConfig, event: AuditEvent): void {
  try {
    appendAuditEvent(cfg.dataDir, event, resolveAuditPolicy(cfg));
  } catch (err) {
    console.error(
      `[landscape] audit append failed for "${event.action}": ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

// ── redaction helpers for the public-surface snapshot ────────────────────────
//
// The L0 SystemSpec.publicInterfaces field is NOT modeled by the SystemSpec zod
// schema, so loadSystemSpec() strips it. We read the raw .wai/specs/.index.yaml
// for that optional field directly (mirroring how policy.ts reads the un-schema'd
// profileSelection), tolerating its absence, and project each entry into a
// redacted PublicInterfaceSummary carrying ONLY safe scalar/name content — never
// component ids, narratives, implementations, root paths, secrets, or non-public
// types.

/** One raw, un-schema'd L0 public-interface entry as authored in the system spec.
 *  Every field is optional and read leniently. */
interface RawSystemPublicInterface {
  id?: unknown;
  systemInterfaceId?: unknown;
  name?: unknown;
  type?: unknown;
  audience?: unknown;
  version?: unknown;
  stability?: unknown;
  methods?: unknown;
  endpoints?: unknown;
  publicTypes?: unknown;
  details?: unknown;
  subsystem?: unknown;
  interface?: unknown;
  component?: unknown;
}

/** The subsystem public-interface shape backing an L0 surface (type + details). */
interface SubsystemPublicInterface {
  type: string;
  details: string;
  component?: string;
  interface?: string;
}

/** First non-empty string among the candidates, or undefined. */
function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return undefined;
}

/** Reduce an array to a list of plain NAMES (strings pass through; objects yield
 *  their name/id), dropping anything else. This is the redaction gate for
 *  methods / public types — a full signature or narrative can never leak. */
function toNameList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') {
      if (item.trim().length > 0) out.push(item);
    } else if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const name = firstString(rec.name, rec.id);
      if (name) out.push(name);
    }
  }
  return out;
}

/** Read the target project's raw L0 publicInterfaces (must run bound to the
 *  project root). A missing/absent field yields an empty list — private by
 *  default. */
function readRawSystemPublicInterfaces(): RawSystemPublicInterface[] {
  const raw = readYamlFile(AI_PATHS.specsSystem()) as { publicInterfaces?: unknown } | null;
  const list = raw?.publicInterfaces;
  return Array.isArray(list) ? (list as RawSystemPublicInterface[]) : [];
}

/** Resolve an L0 entry against a referenced subsystem public interface (by
 *  interface id, else component id) to source its type/details. */
function resolveSubsystemInterface(
  entry: RawSystemPublicInterface,
  subsystems: { id: string; publicInterfaces: SubsystemPublicInterface[] }[],
): SubsystemPublicInterface | undefined {
  const subId = firstString(entry.subsystem);
  const interfaceId = firstString(entry.interface);
  const componentId = firstString(entry.component);
  const pools = subId
    ? subsystems.filter((s) => s.id === subId).map((s) => s.publicInterfaces)
    : subsystems.map((s) => s.publicInterfaces);
  for (const pool of pools) {
    const match = pool.find(
      (pi) =>
        (interfaceId !== undefined && pi.interface === interfaceId) ||
        (componentId !== undefined && pi.component === componentId),
    );
    if (match) return match;
  }
  return undefined;
}

/** Project the raw L0 public interfaces into redacted PublicInterfaceSummary
 *  entries — public method/endpoint metadata and public DTO names only. */
function buildRedactedSummaries(
  rawList: RawSystemPublicInterface[],
  subsystems: { id: string; publicInterfaces: SubsystemPublicInterface[] }[],
): PublicInterfaceSummary[] {
  const out: PublicInterfaceSummary[] = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') continue;
    const id = firstString(entry.id, entry.systemInterfaceId, entry.interface, entry.component);
    if (!id) continue; // an entry with no stable id can never be targeted by a relation
    const matched = resolveSubsystemInterface(entry, subsystems);
    const summary: PublicInterfaceSummary = {
      id,
      name: firstString(entry.name) ?? id,
      type: firstString(entry.type, matched?.type) ?? 'Custom',
      audience: firstString(entry.audience) ?? 'public',
      methods: toNameList(entry.methods),
      details: firstString(entry.details, matched?.details) ?? '',
    };
    const version = firstString(entry.version);
    if (version) summary.version = version;
    const stability = firstString(entry.stability);
    if (stability) summary.stability = stability;
    const endpoints = toNameList(entry.endpoints);
    if (endpoints.length > 0) summary.endpoints = endpoints;
    const publicTypes = toNameList(entry.publicTypes);
    if (publicTypes.length > 0) summary.publicTypes = publicTypes;
    out.push(summary);
  }
  return out;
}

/** A spec-tree StateId rendered as a stable string for the snapshot. */
function stateIdToString(state: { algorithm: string; digest: string }): string {
  return `${state.algorithm}:${state.digest}`;
}

// ── Landscape Diagram Specialist (pure projection) ───────────────────────────
//
// No I/O, no authorization, no project-root or private-spec access — every input
// is supplied already-authorized by the orchestrator. Node ids are namespaced by
// kind so a unit and a project can never collide.

function unitNodeId(id: string): string {
  return `unit:${id}`;
}
function projectNodeId(id: string): string {
  return `project:${id}`;
}
function interfaceNodeId(projectId: string, interfaceId: string): string {
  return `iface:${projectId}:${interfaceId}`;
}

/** Map a placement role to a landscape edge kind. */
function placementEdgeKind(role: string): string {
  if (role === 'owner') return 'owns';
  if (role === 'shared') return 'shared_with';
  return 'contains';
}

/** Map a relation kind to a landscape edge kind. */
function relationEdgeKind(kind: string): string {
  switch (kind) {
    case 'consumes':
      return 'consumes';
    case 'depends_on':
      return 'depends_on';
    case 'mirrors':
      return 'mirrors';
    case 'publishes_to':
      return 'publishes';
    default:
      return 'consumes';
  }
}

/**
 * Build a hosted-instance landscape graph from already-authorized organization
 * units, projects, placements, redacted public-surface snapshots, and
 * cross-project relations. Pure — no I/O, no authorization.
 */
export function buildLandscapeGraph(
  units: OrganizationUnitRecord[],
  projects: HostedProjectRecord[],
  placements: ProjectPlacement[],
  snapshots: ProjectPublicSurfaceSnapshot[],
  relations: ProjectRelationRecord[],
): LandscapeGraphModel {
  const nodes: LandscapeNode[] = [];
  const edges: LandscapeEdge[] = [];
  const generatedAt = new Date().toISOString();
  const interfaceNodeIds = new Set<string>();

  // Organization units + hierarchy edges.
  for (const unit of units) {
    nodes.push({
      id: unitNodeId(unit.id),
      label: unit.name,
      nodeKind: 'orgUnit',
      unitId: unit.id,
      status: unit.status,
    });
    if (unit.parentId !== undefined && unit.parentId !== '') {
      edges.push({
        from: unitNodeId(unit.parentId),
        to: unitNodeId(unit.id),
        edgeKind: 'contains',
      });
    }
  }

  // Project nodes.
  for (const project of projects) {
    nodes.push({
      id: projectNodeId(project.id),
      label: project.id,
      nodeKind: 'project',
      projectId: project.id,
    });
  }

  // Placement edges (organization unit → placed project).
  for (const placement of placements) {
    edges.push({
      from: unitNodeId(placement.unitId),
      to: projectNodeId(placement.projectId),
      edgeKind: placementEdgeKind(placement.role),
      label: placement.role,
    });
  }

  // Public-interface nodes + publishes edges.
  for (const snapshot of snapshots) {
    for (const iface of snapshot.interfaces) {
      const nodeId = interfaceNodeId(snapshot.projectId, iface.id);
      interfaceNodeIds.add(nodeId);
      nodes.push({
        id: nodeId,
        label: iface.name,
        nodeKind: 'publicInterface',
        projectId: snapshot.projectId,
        publicInterfaceId: iface.id,
      });
      edges.push({
        from: projectNodeId(snapshot.projectId),
        to: nodeId,
        edgeKind: 'publishes',
      });
    }
  }

  // Cross-project relation edges (source project → target public interface,
  // falling back to the target project node when that interface node is absent).
  for (const relation of relations) {
    const targetInterfaceId = relation.targetPublicInterface?.systemInterfaceId;
    const ifaceNode =
      targetInterfaceId !== undefined
        ? interfaceNodeId(relation.targetProjectId, targetInterfaceId)
        : undefined;
    const to =
      ifaceNode !== undefined && interfaceNodeIds.has(ifaceNode)
        ? ifaceNode
        : projectNodeId(relation.targetProjectId);
    edges.push({
      from: projectNodeId(relation.sourceProjectId),
      to,
      edgeKind: relationEdgeKind(relation.kind),
      relationId: relation.id,
      label: targetInterfaceId ? `${relation.kind} → ${targetInterfaceId}` : relation.kind,
    });
  }

  return { nodes, edges, generatedAt, scope: 'instance' };
}

// ── Landscape Orchestrator ───────────────────────────────────────────────────

/**
 * Authenticate the caller, require a landscape:manage or instance-admin grant,
 * create or update one organization unit, and append a redacted unit.upsert audit
 * event (info, best-effort).
 */
export function upsertUnit(
  cfg: HostConfig,
  credential: string | null,
  unit: OrganizationUnitRecord,
): OrganizationUnitRecord {
  const principal = requirePrincipal(cfg, credential);
  const scope = resolveScopeFor(cfg, principal, LANDSCAPE_MANAGE_PERMISSION);
  // Authorize by whether the unit ALREADY exists, to close the reparent-capture
  // hole (updating a foreign unit while only its NEW parent is in scope would
  // graft that unit's whole subtree + projects into the caller's scope):
  //   - existing unit → the caller must already own it (its CURRENT position);
  //     if reparenting, the new parent must also be in scope.
  //   - new unit → requires an in-scope parent (a new root requires super-admin).
  if (!scope.all) {
    const existing = unit.id ? getOrganizationUnit(cfg.dataDir, unit.id) : null;
    if (existing) {
      if (!scope.unitIds.includes(unit.id)) {
        throw new ForbiddenError('managing an existing unit requires landscape:manage scope over that unit');
      }
      if (unit.parentId && unit.parentId !== existing.parentId && !scope.unitIds.includes(unit.parentId)) {
        throw new ForbiddenError('reparenting a unit requires landscape:manage scope over the new parent');
      }
    } else if (!unit.parentId || !scope.unitIds.includes(unit.parentId)) {
      throw new ForbiddenError(
        'creating an organization unit requires landscape:manage scope over its parent (a new root requires a super-admin)',
      );
    }
  }
  const stored = upsertOrganizationUnit(cfg.dataDir, unit);
  tryAppendAudit(cfg, buildAuditEvent(principal, 'unit.upsert', 'info', 'landscape', { target: stored.id }));
  return stored;
}

/**
 * Authenticate the caller, require a landscape:manage or instance-admin grant,
 * verify the target organization unit exists, place the hosted project in it, and
 * append a redacted project.place audit event (info, best-effort).
 */
export function placeProject(
  cfg: HostConfig,
  credential: string | null,
  placement: ProjectPlacement,
): ProjectPlacement {
  const principal = requirePrincipal(cfg, credential);
  const scope = resolveScopeFor(cfg, principal, LANDSCAPE_MANAGE_PERMISSION);
  // The caller's scope must cover BOTH the target unit AND the project being
  // placed. Checking only the destination unit was a scope-capture hole: a unit
  // admin could adopt any project into their unit and thereby pull it into their
  // scope (→ destroy/lock/promote/audit it). The project's authority comes from
  // its CURRENT placements, so require it already be in the caller's scope; a
  // super-admin places anything anywhere.
  if (!scope.all && !scope.unitIds.includes(placement.unitId)) {
    throw new ForbiddenError('placing a project requires landscape:manage scope over the target unit');
  }
  if (!scope.all && !permits(scope, placement.projectId)) {
    throw new ForbiddenError('placing a project requires landscape:manage scope over the project being placed');
  }
  if (!getOrganizationUnit(cfg.dataDir, placement.unitId)) {
    throw new Error('the target organization unit does not exist');
  }
  const stored = placeProjectInUnit(cfg.dataDir, placement);
  tryAppendAudit(
    cfg,
    buildAuditEvent(principal, 'project.place', 'info', 'landscape', {
      target: stored.id,
      projectId: stored.projectId,
    }),
  );
  return stored;
}

/**
 * Authenticate the caller, require a landscape:manage or instance-admin grant,
 * resolve+bind the target project root within the principal's authorized set,
 * capture its StateId and read its L0 system spec + L1 subsystem specs through the
 * host core adapter, build a redacted public-surface snapshot (public method /
 * endpoint / DTO NAMES only — never paths, narratives, or private components),
 * replace it in the repository, and append a redacted surface.refresh audit event.
 */
export function refreshPublicSurface(
  cfg: HostConfig,
  credential: string | null,
  projectId: string,
): ProjectPublicSurfaceSnapshot {
  const principal = requirePrincipal(cfg, credential);
  const scope = resolveScopeFor(cfg, principal, LANDSCAPE_MANAGE_PERMISSION);
  if (!permits(scope, projectId)) {
    throw new ForbiddenError(
      "refreshing a project's public surface requires landscape:manage scope over the project",
    );
  }

  const root = resolveProjectRoot(cfg.dataDir, principal, projectId);
  if (!root) throw new Error(`Unknown project "${projectId}".`);

  const snapshot = runWithProjectRoot(root, (): ProjectPublicSurfaceSnapshot => {
    const stateId = hostCore.computeStateId();
    const system = hostCore.loadSystemSpec();
    const subsystems = hostCore.loadSubsystemSpecs();
    const rawInterfaces = readRawSystemPublicInterfaces();
    const interfaces = buildRedactedSummaries(rawInterfaces, subsystems);
    return {
      projectId,
      stateId: stateIdToString(stateId),
      systemName: system?.name ?? projectId,
      interfaces,
      exportedAt: '', // stamped server-side by the repository
      exportedBy: principalSubject(principal),
    };
  });

  const stored = replacePublicSurfaceSnapshot(cfg.dataDir, snapshot);
  tryAppendAudit(
    cfg,
    buildAuditEvent(principal, 'surface.refresh', 'info', 'landscape', {
      target: projectId,
      projectId,
    }),
  );
  return stored;
}

/**
 * Authenticate the caller, require a landscape:manage or instance-admin grant,
 * validate the relation's targetPublicInterface against the target project's
 * stored public-surface snapshot (no snapshot → reject with refresh guidance;
 * unknown interface → reject), create or update the relation, and append a
 * redacted relation.upsert audit event (info, best-effort).
 */
export function upsertRelation(
  cfg: HostConfig,
  credential: string | null,
  relation: ProjectRelationRecord,
): ProjectRelationRecord {
  const principal = requirePrincipal(cfg, credential);
  const scope = resolveScopeFor(cfg, principal, LANDSCAPE_MANAGE_PERMISSION);
  if (!permits(scope, relation.sourceProjectId)) {
    throw new ForbiddenError(
      'managing a cross-project relation requires landscape:manage scope over its source project',
    );
  }

  const targetProjectId = relation.targetPublicInterface.projectId;
  const targetInterfaceId = relation.targetPublicInterface.systemInterfaceId;

  // Stage 2: a relation may only consume a surface the unit graph exposes to
  // the SOURCE — a snapshot merely existing is no longer enough. An instance
  // with NO organization units defined retains the pre-visibility behavior:
  // the unit graph gates only once it exists (otherwise every simple
  // single-team instance would need an org tree before its first relation).
  const units = listOrganizationUnits(cfg.dataDir);
  if (units.length > 0) {
    const placements = listProjectPlacements(cfg.dataDir);
    const sourceView = resolveVisibility(relation.sourceProjectId, units, placements);
    if (!isVisible(sourceView, targetProjectId)) {
      throw new ForbiddenError(
        "the target project's surface is not exposed to the source project's organization units",
      );
    }
  }

  if (!getPublicSurfaceSnapshot(cfg.dataDir, targetProjectId)) {
    throw new Error(
      'the target project has no public-surface snapshot — run refreshPublicSurface for it before creating a relation',
    );
  }
  if (!findPublicInterface(cfg.dataDir, targetProjectId, targetInterfaceId)) {
    throw new Error(
      "unknown target public interface — a relation must target a system public interface present in the target project's public-surface snapshot",
    );
  }

  const stored = upsertProjectRelation(cfg.dataDir, relation);
  tryAppendAudit(
    cfg,
    buildAuditEvent(principal, 'relation.upsert', 'info', 'landscape', {
      target: stored.id,
      projectId: stored.sourceProjectId,
    }),
  );
  return stored;
}

/**
 * Authenticate the caller, require a landscape:read (or manage/admin) grant, and
 * list cross-project relations, optionally narrowed to the given project as
 * source. Reads are not audited.
 */
export function listRelations(
  cfg: HostConfig,
  credential: string | null,
  projectId?: string,
): ProjectRelationRecord[] {
  const principal = requirePrincipal(cfg, credential);
  const units = listOrganizationUnits(cfg.dataDir);
  const placements = listProjectPlacements(cfg.dataDir);
  const scope = resolveLandscapeReadScope(principal, units, placements);
  if (scopeIsEmpty(scope)) {
    throw new ForbiddenError('listing cross-project relations requires landscape:read scope');
  }
  const relations = listProjectRelations(cfg.dataDir, projectId);
  if (scope.all) return relations;
  // A relation is visible when its source OR target project is in the caller's
  // scope (per ilandscape_orchestrator.listRelations).
  return relations.filter(
    (r) => scope.projectIds.includes(r.sourceProjectId) || scope.projectIds.includes(r.targetProjectId),
  );
}

/**
 * Authenticate the caller, require a landscape:read (or manage/admin) grant,
 * gather organization units, placements, projects, relations, and per-project
 * public-surface snapshots, and return a landscape graph built only from hosted
 * metadata and redacted snapshots. Reads are not audited.
 */
export function generateLandscape(
  cfg: HostConfig,
  credential: string | null,
  scope?: string,
): LandscapeGraphModel {
  const principal = requirePrincipal(cfg, credential);

  const units = listOrganizationUnits(cfg.dataDir);
  const placements = listProjectPlacements(cfg.dataDir);
  const readScope = resolveLandscapeReadScope(principal, units, placements);
  if (scopeIsEmpty(readScope)) {
    throw new ForbiddenError('generating the landscape requires landscape:read scope');
  }

  const projects = listProjectRecords(cfg.dataDir);
  const relations = listProjectRelations(cfg.dataDir);

  // Narrow the inputs to the caller's scope BEFORE projecting the graph (a
  // super-admin keeps everything). Relations are kept only when BOTH endpoints
  // are in scope so the scoped graph never carries a dangling edge to — or leaks
  // the id of — an out-of-scope project. Equivalent to filtering the built graph's
  // nodes to scope and dropping edges that reference a dropped node.
  let scopedUnits = units;
  let scopedProjects = projects;
  let scopedPlacements = placements;
  let scopedRelations = relations;
  if (!readScope.all) {
    const projSet = new Set(readScope.projectIds);
    const unitSet = new Set(readScope.unitIds);
    scopedUnits = units.filter((u) => unitSet.has(u.id));
    scopedProjects = projects.filter((p) => projSet.has(p.id));
    scopedPlacements = placements.filter((pl) => unitSet.has(pl.unitId) && projSet.has(pl.projectId));
    scopedRelations = relations.filter(
      (r) => projSet.has(r.sourceProjectId) && projSet.has(r.targetProjectId),
    );
  }

  const snapshots: ProjectPublicSurfaceSnapshot[] = [];
  for (const project of scopedProjects) {
    const snap = getPublicSurfaceSnapshot(cfg.dataDir, project.id);
    if (snap) snapshots.push(snap);
  }

  const graph = buildLandscapeGraph(scopedUnits, scopedProjects, scopedPlacements, snapshots, scopedRelations);
  if (!readScope.all) {
    // Coherence: a narrowed unit whose parent is out of scope would otherwise leave
    // a `contains` edge pointing at an absent parent node. Drop any edge whose
    // endpoints are not both present nodes so the scoped graph never dangles or
    // leaks an out-of-scope id.
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    graph.edges = graph.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
  }
  if (scope !== undefined && scope !== '') graph.scope = scope;
  return graph;
}

/**
 * MCP tool workflow `sdd_landscape_list_reachable_projects`: authenticate the
 * caller, then return only the projects reachable from currentProjectId.
 * Reachability is DIRECTIONAL and RELATIONS-ONLY — the reachable targets are
 * exactly the projects with an ACTIVE relation whose sourceProjectId is
 * currentProjectId. Placements confer none; there is no transitive closure.
 */
export function listReachableProjectsForMcp(
  cfg: HostConfig,
  credential: string | null,
  currentProjectId: string,
): ReachableProjectRef[] {
  requirePrincipal(cfg, credential);

  const active = listProjectRelations(cfg.dataDir, currentProjectId, undefined, 'active');
  const byTarget = new Map<string, ReachableProjectRef>();
  for (const relation of active) {
    let ref = byTarget.get(relation.targetProjectId);
    if (!ref) {
      ref = { projectId: relation.targetProjectId, relationIds: [], relationKinds: [], publicInterfaceIds: [] };
      byTarget.set(relation.targetProjectId, ref);
    }
    ref.relationIds.push(relation.id);
    if (!ref.relationKinds.includes(relation.kind)) ref.relationKinds.push(relation.kind);
    const interfaceId = relation.targetPublicInterface?.systemInterfaceId;
    if (interfaceId && !ref.publicInterfaceIds.includes(interfaceId)) {
      ref.publicInterfaceIds.push(interfaceId);
    }
  }
  return [...byTarget.values()];
}

/**
 * MCP tool workflow `sdd_landscape_list_reachable_project_interfaces`:
 * authenticate the caller, reject any target outside the reachable set (no ACTIVE
 * relation from currentProjectId → Forbidden, no existence leak), then return the
 * redacted PublicInterfaceSummary entries from the target's stored snapshot. A
 * target with no snapshot yields an empty list (private by default).
 */
export function listReachableProjectInterfacesForMcp(
  cfg: HostConfig,
  credential: string | null,
  currentProjectId: string,
  targetProjectId: string,
): PublicInterfaceSummary[] {
  requirePrincipal(cfg, credential);

  const active = listProjectRelations(cfg.dataDir, currentProjectId, targetProjectId, 'active');
  if (active.length === 0) {
    throw new ForbiddenError(
      'the target project is not reachable from the current project through an active relation',
    );
  }

  const snapshot = getPublicSurfaceSnapshot(cfg.dataDir, targetProjectId);
  if (!snapshot) return [];

  // Stage 2: entries are AUDIENCE-FILTERED by the observer's unit-graph
  // distance to the target. An instance with no org units keeps legacy
  // behavior (all entries); an invisible target (e.g. a legacy relation
  // predating a closure) classifies as the farthest distance, so only
  // external/public entries survive.
  const units = listOrganizationUnits(cfg.dataDir);
  if (units.length === 0) return snapshot.interfaces;
  const placements = listProjectPlacements(cfg.dataDir);
  const view = resolveVisibility(currentProjectId, units, placements);
  const distance = audienceDistance(view, targetProjectId);
  return snapshot.interfaces.filter((i) => audienceCovers(i.audience, distance));
}

/**
 * Stage 2 discovery catalog: authenticate the caller, resolve the observer
 * project's unit-graph visibility (open-within-tenant, closed groups hidden,
 * exposeTo grants honored, cross-tenant grant-only), and return each visible
 * target with its audience distance and the redacted catalog summaries whose
 * audience ceiling covers that distance. The honest complete picture —
 * everything in the observer's subtree plus everything granted to it —
 * without any relation existing yet. Reads are not audited.
 */
export function listVisibleSurfaces(
  cfg: HostConfig,
  credential: string | null,
  currentProjectId: string,
): VisibleSurfaceEntry[] {
  requirePrincipal(cfg, credential);

  const units = listOrganizationUnits(cfg.dataDir);
  const placements = listProjectPlacements(cfg.dataDir);
  const view = resolveVisibility(currentProjectId, units, placements);

  const out: VisibleSurfaceEntry[] = [];
  for (const visible of view.visibleProjects) {
    const snapshot = getPublicSurfaceSnapshot(cfg.dataDir, visible.projectId);
    const interfaces = snapshot
      ? snapshot.interfaces.filter((i) => audienceCovers(i.audience, visible.distance))
      : [];
    out.push({ projectId: visible.projectId, distance: visible.distance, interfaces });
  }
  return out;
}

/**
 * MCP tool workflow `sdd_landscape_get_project_surface`: the CONSUMER path of
 * the surface exchange. Authenticate the caller, gate by unit-graph
 * visibility (or, on an instance with no org units, by relations-only
 * reachability — the legacy posture), then generate the target's
 * CONTRACT-GRADE snapshot with the audience ceiling set to the observer's
 * distance, stamped origin 'exchanged' — ready for `wairon surface import`
 * on the consumer side. The server acts as the trusted intermediary: it reads
 * the target tree only to produce the audience-filtered artifact.
 */
export function getProjectSurfaceForMcp(
  cfg: HostConfig,
  credential: string | null,
  currentProjectId: string,
  targetProjectId: string,
): SurfaceSnapshot {
  requirePrincipal(cfg, credential);

  const units = listOrganizationUnits(cfg.dataDir);
  let maxAudience: string;
  if (units.length === 0) {
    // Legacy (no org graph): relations-only reachability, instance-grade ceiling.
    const active = listProjectRelations(cfg.dataDir, currentProjectId, targetProjectId, 'active');
    if (active.length === 0) {
      throw new ForbiddenError(
        'the target project is not reachable from the current project through an active relation',
      );
    }
    maxAudience = 'instance';
  } else {
    const placements = listProjectPlacements(cfg.dataDir);
    const view = resolveVisibility(currentProjectId, units, placements);
    const distance = audienceDistance(view, targetProjectId);
    if (!distance) {
      throw new ForbiddenError(
        "the target project's surface is not exposed to the current project's organization units",
      );
    }
    maxAudience = distance;
  }

  const record = listProjectRecords(cfg.dataDir).find((p) => p.id === targetProjectId);
  if (!record?.rootPath) throw new Error(`Unknown project "${targetProjectId}".`);
  const result = runWithProjectRoot(record.rootPath, () =>
    hostSurfaces.exportBoundSurface(maxAudience, 'native'));
  return { ...result.snapshot, origin: 'exchanged' };
}

/**
 * Generate-and-download a project's surface artifact on request — the diagram
 * pattern applied to surfaces (Swagger UI SERVING is deliberately out of
 * scope; this only renders the document). Requires landscape:manage scope
 * over the project (the contract grade exposes full method contracts).
 * format: 'native' (snapshot YAML) | 'openapi' (OpenAPI 3.1 JSON).
 */
export function exportProjectSurface(
  cfg: HostConfig,
  credential: string | null,
  projectId: string,
  format: string,
  maxAudience: string,
): SurfaceArtifact {
  const principal = requirePrincipal(cfg, credential);
  const scope = resolveScopeFor(cfg, principal, LANDSCAPE_MANAGE_PERMISSION);
  if (!permits(scope, projectId)) {
    throw new ForbiddenError(
      "exporting a project's surface artifact requires landscape:manage scope over the project",
    );
  }
  if (format !== 'native' && format !== 'openapi') {
    throw new Error(`Unknown surface format "${format}" (supported: native, openapi).`);
  }

  const root = resolveProjectRoot(cfg.dataDir, principal, projectId);
  if (!root) throw new Error(`Unknown project "${projectId}".`);

  const result = runWithProjectRoot(root, () => hostSurfaces.exportBoundSurface(maxAudience, format));
  if (format === 'openapi') {
    return {
      body: result.rendered ?? '{}',
      contentType: 'application/json',
      filename: `${projectId}-surface.openapi.json`,
    };
  }
  return {
    body: yamlLib.dump(result.snapshot),
    contentType: 'application/yaml',
    filename: `${projectId}-surface.yaml`,
  };
}

/**
 * Authenticate the caller, require a landscape:manage or instance-admin grant,
 * remove one cross-project relation by id, and append a redacted relation.remove
 * audit event (info, best-effort).
 */
export function removeRelation(cfg: HostConfig, credential: string | null, id: string): void {
  const principal = requirePrincipal(cfg, credential);
  const scope = resolveScopeFor(cfg, principal, LANDSCAPE_MANAGE_PERMISSION);
  // Resolve the relation to point-check its source project. A missing relation
  // yields no source, which a scoped caller can never cover — fail closed.
  const target = listProjectRelations(cfg.dataDir).find((r) => r.id === id);
  if (!permits(scope, target?.sourceProjectId ?? '')) {
    throw new ForbiddenError(
      'removing a cross-project relation requires landscape:manage scope over its source project',
    );
  }
  removeProjectRelation(cfg.dataDir, id);
  tryAppendAudit(cfg, buildAuditEvent(principal, 'relation.remove', 'info', 'landscape', { target: id }));
}

// ── Landscape Portal (HTTP) ──────────────────────────────────────────────────
//
// Pure forwarding to the orchestrator functions above. Rides the ADMIN-plane
// listener (mirroring identity.ts / policy.ts), owning its own error → status
// mapping (401/403/404/400) so faults never fall through to the admin-plane catch.
// Endpoints match ilandscape_portal exactly. Called by http.ts when the admin
// listener sees a `/landscape/*` path.

export function handleLandscapeRequest(
  cfg: HostConfig,
  credential: string | null,
  req: IncomingMessage,
  res: ServerResponse,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any,
  url: URL,
): void {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['landscape', ...]
  try {
    if (parts[1] === 'units') {
      // PUT /landscape/units/{id}
      if (req.method === 'PUT' && parts.length === 3) {
        const unit = { ...(body as OrganizationUnitRecord), id: parts[2] };
        return sendJson(res, 200, upsertUnit(cfg, credential, unit));
      }
    }

    if (parts[1] === 'projects') {
      // PUT /landscape/projects/{id}/placements/{unitId}
      if (req.method === 'PUT' && parts.length === 5 && parts[3] === 'placements') {
        const placement = { ...(body as ProjectPlacement), projectId: parts[2], unitId: parts[4] };
        return sendJson(res, 200, placeProject(cfg, credential, placement));
      }
      // POST /landscape/projects/{id}/public-surface/refresh
      if (req.method === 'POST' && parts.length === 5 && parts[3] === 'public-surface' && parts[4] === 'refresh') {
        return sendJson(res, 200, refreshPublicSurface(cfg, credential, parts[2]));
      }
      // GET /landscape/projects/{id}/visible-surfaces
      if (req.method === 'GET' && parts.length === 4 && parts[3] === 'visible-surfaces') {
        return sendJson(res, 200, listVisibleSurfaces(cfg, credential, parts[2]));
      }
      // GET /landscape/projects/{id}/surface?format=native|openapi&audience=<level>
      // Generate-and-download (the diagram pattern) — never a served UI.
      if (req.method === 'GET' && parts.length === 4 && parts[3] === 'surface') {
        const artifact = exportProjectSurface(
          cfg,
          credential,
          parts[2],
          url.searchParams.get('format') ?? 'native',
          url.searchParams.get('audience') ?? 'instance',
        );
        res.writeHead(200, {
          'content-type': artifact.contentType,
          'content-disposition': `attachment; filename="${artifact.filename}"`,
        });
        res.end(artifact.body);
        return;
      }
    }

    if (parts[1] === 'relations') {
      // GET /landscape/relations?project=
      if (req.method === 'GET' && parts.length === 2) {
        return sendJson(res, 200, listRelations(cfg, credential, url.searchParams.get('project') ?? undefined));
      }
      // PUT /landscape/relations/{id}
      if (req.method === 'PUT' && parts.length === 3) {
        const relation = { ...(body as ProjectRelationRecord), id: parts[2] };
        return sendJson(res, 200, upsertRelation(cfg, credential, relation));
      }
      // DELETE /landscape/relations/{id}
      if (req.method === 'DELETE' && parts.length === 3) {
        removeRelation(cfg, credential, parts[2]);
        return sendJson(res, 200, { ok: true });
      }
    }

    // GET /landscape/graph?scope=
    if (req.method === 'GET' && parts[1] === 'graph' && parts.length === 2) {
      return sendJson(res, 200, generateLandscape(cfg, credential, url.searchParams.get('scope') ?? undefined));
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof UnauthenticatedError) return sendJson(res, 401, { error: 'unauthorized' });
    if (err instanceof ForbiddenError) return sendJson(res, 403, { error: 'forbidden' });
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|unknown project|does not exist/i.test(msg)) return sendJson(res, 404, { error: msg });
    return sendJson(res, 400, { error: msg });
  }
}
