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
} from './types.js';

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

// ── authorization helpers (mirrored from identity.ts / policy.ts) ────────────
//
// '*' is the wildcard in BOTH projectId and permissions (per the grant model).

/** Instance-admin = a grant over every project ('*') with every permission ('*'). */
function isInstanceAdmin(principal: Principal): boolean {
  return (principal.grants ?? []).some((g) => g.projectId === '*' && g.permissions.includes('*'));
}

/** True when the caller carries `permission` in any grant, regardless of project
 *  scope (or a wildcard '*' permission). Landscape capabilities are instance-wide. */
function carriesPermission(principal: Principal, permission: string): boolean {
  return (principal.grants ?? []).some(
    (g) => g.permissions.includes('*') || g.permissions.includes(permission),
  );
}

/** Authenticate the caller credential or throw (401-mapping). */
function requirePrincipal(cfg: HostConfig, credential: string | null): Principal {
  const principal = authenticateCredential(cfg.dataDir, credential);
  if (!principal.authenticated) throw new UnauthenticatedError();
  return principal;
}

/** Require a landscape:manage grant or an instance-admin grant for a landscape write. */
function requireManage(principal: Principal, action: string): void {
  if (!carriesPermission(principal, LANDSCAPE_MANAGE_PERMISSION) && !isInstanceAdmin(principal)) {
    throw new ForbiddenError(`${action} requires a landscape:manage grant or an instance-admin grant`);
  }
}

/** Require a landscape:read (or manage/admin) grant for a landscape control-plane read. */
function requireRead(principal: Principal, action: string): void {
  if (
    !carriesPermission(principal, LANDSCAPE_READ_PERMISSION) &&
    !carriesPermission(principal, LANDSCAPE_MANAGE_PERMISSION) &&
    !isInstanceAdmin(principal)
  ) {
    throw new ForbiddenError(
      `${action} requires a landscape:read, landscape:manage, or instance-admin grant`,
    );
  }
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
  requireManage(principal, 'managing organization units');
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
  requireManage(principal, 'placing a project');
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
  requireManage(principal, "refreshing a project's public surface");

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
  requireManage(principal, 'managing cross-project relations');

  const targetProjectId = relation.targetPublicInterface.projectId;
  const targetInterfaceId = relation.targetPublicInterface.systemInterfaceId;

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
  requireRead(principal, 'listing cross-project relations');
  return listProjectRelations(cfg.dataDir, projectId);
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
  requireRead(principal, 'generating the landscape');

  const units = listOrganizationUnits(cfg.dataDir);
  const placements = listProjectPlacements(cfg.dataDir);
  const projects = listProjectRecords(cfg.dataDir);
  const relations = listProjectRelations(cfg.dataDir);

  const snapshots: ProjectPublicSurfaceSnapshot[] = [];
  for (const project of projects) {
    const snap = getPublicSurfaceSnapshot(cfg.dataDir, project.id);
    if (snap) snapshots.push(snap);
  }

  const graph = buildLandscapeGraph(units, projects, placements, snapshots, relations);
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
  return snapshot.interfaces;
}

/**
 * Authenticate the caller, require a landscape:manage or instance-admin grant,
 * remove one cross-project relation by id, and append a redacted relation.remove
 * audit event (info, best-effort).
 */
export function removeRelation(cfg: HostConfig, credential: string | null, id: string): void {
  const principal = requirePrincipal(cfg, credential);
  requireManage(principal, 'managing cross-project relations');
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
