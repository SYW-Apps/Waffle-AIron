import type { IncomingMessage, ServerResponse } from 'http';
import { authenticateCredential } from './auth.js';
import { UnauthenticatedError, ForbiddenError } from './errors.js';
import { listProjectRecords } from './projects.js';
import { sendJson } from './httpio.js';
import { resolveScopeFor } from './scope.js';
import * as packs from './packs.js';
import { listProjectRelations } from './relations.js';
import { getPublicSurfaceSnapshot } from './surfaces.js';
import type {
  DiagnosticCheckResult,
  HostConfig,
  HostedProjectRecord,
  InstanceHealthReport,
  Principal,
  ProjectPackReference,
  ResourceQuotaPolicy,
  ResourceUsageSnapshot,
  ScopeResolution,
  ProjectRelationRecord,
  ProjectPublicSurfaceSnapshot,
} from './types.js';

// ---------------------------------------------------------------------------
// Operations Orchestrator + Diagnostics/Quota Specialists + Portal (sdd_host)
//
// The slim read-only operations plane: instance health, resource usage, and
// advisory (observe/warn) quota reporting. The two specialists are PURE — they
// reason only over the inputs the orchestrator supplies (project records, pack
// listings, relations + target snapshots for relation health) and do
// no I/O of their own (per diagnostics_specialist / quota_specialist). The
// orchestrator authenticates through the single auth authority and authorizes by
// Principal grants (operations:read, or an instance-wide admin grant); it lists
// project records through the project registry and delegates all derivation to
// the specialists. It performs NO writes and NO audit (every method is a read).
// Exported as plain functions so both the HTTP operations portal
// (handleOperationsRequest, below) and any in-process caller reach the same
// logic — mirroring identity.ts / landscape.ts.
//
// Exposure decision: these routes ride the ADMIN-plane listener behind the
// HostExposurePolicy `operationsApiEnabled` flag; http.ts gates the mount.
// ---------------------------------------------------------------------------

const OPERATIONS_READ_PERMISSION = 'operations:read';

/** The advisory quota policy resolved when HostConfig.quotaPolicy is unset:
 *  disabled, so quota evaluation is a no-op until an operator opts in. */
const DISABLED_QUOTA_POLICY: ResourceQuotaPolicy = { enabled: false, mode: 'observe' };

// ── authorization helpers (scope-aware — Phase 6 tenancy) ────────────────────
//
// Operations reads authorize by an instance-wide OR unit-scoped operations:read
// grant. A '*'/'*' bootstrap or an instance-wide ({projectId:'*'}) operations:read
// grant resolves to `all` (unfiltered). A unit-scoped grant resolves to that
// unit's subtree of projects: the per-project inputs are narrowed to that set
// BEFORE the diagnostics/quota specialists run, so a scoped operator sees health
// and usage only for their subtree's projects.

/** Authenticate the caller credential or throw (401-mapping). */
function requirePrincipal(cfg: HostConfig, credential: string | null): Principal {
  const principal = authenticateCredential(cfg.dataDir, credential);
  if (!principal.authenticated) throw new UnauthenticatedError();
  return principal;
}

/** Resolve the caller's operations:read scope, rejecting a caller with no reach
 *  at all (scope.all is false and neither an in-scope project nor unit). */
function requireOperationsReadScope(cfg: HostConfig, principal: Principal): ScopeResolution {
  const scope = resolveScopeFor(cfg, principal, OPERATIONS_READ_PERMISSION);
  if (!scope.all && scope.projectIds.length === 0 && scope.unitIds.length === 0) {
    throw new ForbiddenError('operations read access required');
  }
  return scope;
}

/** Narrow hosted project records to the caller's scope (a super-admin keeps all). */
function narrowToScope(projects: HostedProjectRecord[], scope: ScopeResolution): HostedProjectRecord[] {
  if (scope.all) return projects;
  return projects.filter((p) => scope.projectIds.includes(p.id));
}

/** Resolve the advisory quota policy from host config, secure (disabled) default
 *  when unset. */
function resolveQuotaPolicy(cfg: HostConfig): ResourceQuotaPolicy {
  return cfg.quotaPolicy ?? DISABLED_QUOTA_POLICY;
}

// ── Diagnostics Specialist (pure) ────────────────────────────────────────────
//
// No I/O, no authorization, no disk or private-spec access — every input is the
// already-listed set of hosted project records supplied by the orchestrator.

/** Narrow the supplied records to a single project when a scope selector names
 *  one; 'instance' and an empty/absent selector leave the full set. */
function scopeRecords(projects: HostedProjectRecord[], scope?: string): HostedProjectRecord[] {
  if (scope && scope.length > 0 && scope !== 'instance') {
    return projects.filter((p) => p.id === scope);
  }
  return projects;
}

/**
 * Derive redacted operational diagnostic checks purely from the supplied inputs —
 * project-registry consistency (unique ids and resolvable roots), per-project
 * state presence, a project-count sanity check, pack-shadowing (an instance pack
 * shadowing a same-named image pack), and missing-pack-references (a project
 * referencing a pack that resolves in neither the image nor the instance tier).
 * Pure: the caller supplies the records, the two pack-tier name listings, and the
 * per-project references — this function does no I/O.
 */
export function runChecks(
  projects: HostedProjectRecord[],
  imagePackNames: string[],
  instancePackNames: string[],
  projectReferences: ProjectPackReference[],
  scope?: string,
  relations?: ProjectRelationRecord[],
  relationSnapshots?: ProjectPublicSurfaceSnapshot[],
): DiagnosticCheckResult[] {
  const scoped = scopeRecords(projects, scope);
  const observedAt = new Date().toISOString();
  const checks: DiagnosticCheckResult[] = [];

  // Registry consistency: unique ids AND a resolvable (non-empty) root for every
  // record. Derived purely from the records — the pure specialist never stats disk.
  const ids = scoped.map((p) => p.id);
  const duplicateIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  const unresolvedRoots = scoped.filter((p) => !p.rootPath || p.rootPath.trim() === '');
  if (duplicateIds.length > 0 || unresolvedRoots.length > 0) {
    const detailParts: string[] = [];
    if (duplicateIds.length > 0) detailParts.push(`${duplicateIds.length} duplicate project id(s)`);
    if (unresolvedRoots.length > 0) {
      detailParts.push(`${unresolvedRoots.length} record(s) with an unresolvable root`);
    }
    checks.push({
      id: 'project-registry-consistency',
      status: 'fail',
      message: `Project registry inconsistent: ${detailParts.join('; ')}.`,
      observedAt,
    });
  } else {
    checks.push({
      id: 'project-registry-consistency',
      status: 'pass',
      message: `Project registry consistent: ${scoped.length} record(s) with unique ids and resolvable roots.`,
      observedAt,
    });
  }

  // Per-project state presence: active vs. records without an active state.
  const activeCount = scoped.filter((p) => p.status === 'active').length;
  const inactiveCount = scoped.length - activeCount;
  checks.push({
    id: 'project-state-presence',
    status: inactiveCount > 0 ? 'warn' : 'pass',
    message: `${activeCount} active project(s); ${inactiveCount} without an active state.`,
    observedAt,
  });

  // Project-count sanity: an instance with zero active projects is a mild signal.
  checks.push({
    id: 'project-count-sanity',
    status: activeCount === 0 ? 'warn' : 'pass',
    message: `${activeCount} active hosted project(s).`,
    observedAt,
  });

  // Pack-shadowing: an instance pack shadowing a same-named image pack is drift —
  // the instance copy takes precedence over the immutable image copy. Derived
  // purely from the two tier name listings.
  const instanceSet = new Set(instancePackNames);
  const shadowed = [...new Set(imagePackNames.filter((n) => instanceSet.has(n)))];
  checks.push({
    id: 'pack-shadowing',
    status: shadowed.length > 0 ? 'warn' : 'pass',
    message:
      shadowed.length > 0
        ? `${shadowed.length} image-tier pack(s) shadowed by an instance pack (the instance copy takes precedence): ${shadowed.join(', ')}.`
        : 'No image-tier packs are shadowed by an instance pack.',
    observedAt,
  });

  // Missing-pack-references: a project referencing a pack absent from BOTH tiers
  // is invalidated (e.g. an instance pack was removed while a project still
  // depends on it). Fail and name each offending project with its missing refs
  // and any profile ids thereby invalidated. Derived purely from the supplied
  // per-project references and the two tier listings.
  const availablePacks = new Set([...imagePackNames, ...instancePackNames]);
  const referenceById = new Map(projectReferences.map((r) => [r.projectId, r]));
  const invalidatedProjects: string[] = [];
  for (const project of scoped) {
    const reference = referenceById.get(project.id);
    if (!reference) continue;
    const missingRefs = [...new Set(reference.packNames.filter((n) => !availablePacks.has(n)))];
    if (missingRefs.length === 0) continue;
    const invalidatedProfiles = reference.profileIds ?? [];
    invalidatedProjects.push(
      `${project.id} → missing pack(s): ${missingRefs.join(', ')}` +
        (invalidatedProfiles.length > 0
          ? `; invalidated profile(s): ${invalidatedProfiles.join(', ')}`
          : ''),
    );
  }
  checks.push({
    id: 'missing-pack-references',
    status: invalidatedProjects.length > 0 ? 'fail' : 'pass',
    message:
      invalidatedProjects.length > 0
        ? `${invalidatedProjects.length} project(s) reference packs absent from both tiers — ${invalidatedProjects.join(' | ')}.`
        : 'All project pack/profile references resolve in the image or instance tier.',
    observedAt,
  });

  // Relation health (Phase 7 Stage 3): an ACTIVE cross-project relation must
  // target a project that still HAS a public-surface snapshot, and that
  // snapshot must still expose the referenced interface — surface refreshes
  // can drift both out from under a standing relation. Only evaluated when
  // the caller supplies relation data (older callers stay unaffected).
  if (relations !== undefined) {
    const active = relations.filter((r) => r.status === 'active');
    const snapByProject = new Map((relationSnapshots ?? []).map((s) => [s.projectId, s]));
    const missingSnapshot = active.filter((r) => !snapByProject.has(r.targetProjectId));
    const drifted = active.filter((r) => {
      const snap = snapByProject.get(r.targetProjectId);
      const ifaceId = r.targetPublicInterface?.systemInterfaceId;
      return !!snap && !!ifaceId && !snap.interfaces.some((i) => i.id === ifaceId);
    });
    const problems: string[] = [];
    if (missingSnapshot.length > 0) {
      problems.push(
        `${missingSnapshot.length} active relation(s) target projects with no public-surface snapshot (${missingSnapshot.map((r) => r.id).join(', ')})`,
      );
    }
    if (drifted.length > 0) {
      problems.push(
        `${drifted.length} active relation(s) target interfaces no longer exposed by the target's snapshot (${drifted.map((r) => r.id).join(', ')}) — the consumed contract drifted; refresh and re-validate`,
      );
    }
    checks.push({
      id: 'relation-health',
      status: problems.length > 0 ? 'warn' : 'pass',
      message: problems.length > 0
        ? `Relation health degraded: ${problems.join('; ')}.`
        : 'Every active cross-project relation targets a present snapshot interface.',
      observedAt,
    });
  }

  return checks;
}

/**
 * Derive resource usage snapshots for the requested scope purely from the
 * supplied hosted project records: always an instance-level snapshot capturing
 * the active project count, plus a project-scoped snapshot from the record's
 * available metadata when the scope selects a single project. Quota messages are
 * left empty; advisory quota evaluation is applied separately by the quota specialist.
 */
export function collectUsage(
  projects: HostedProjectRecord[],
  scope?: string,
): ResourceUsageSnapshot[] {
  const capturedAt = new Date().toISOString();
  const snapshots: ResourceUsageSnapshot[] = [];

  // Instance-level snapshot: the active project count across the whole instance.
  snapshots.push({
    scope: 'instance',
    capturedAt,
    projectCount: projects.filter((p) => p.status === 'active').length,
    quotaMessages: [],
  });

  // Project-scoped snapshot from the record's available metadata (thin for now).
  if (scope && scope.length > 0 && scope !== 'instance') {
    const record = projects.find((p) => p.id === scope);
    if (record) {
      snapshots.push({ scope: record.id, capturedAt, quotaMessages: [] });
    }
  }

  return snapshots;
}

/**
 * Assemble an aggregated instance health report: overall status is unhealthy
 * when any check failed, degraded when any check warned, otherwise ok. Pure.
 */
export function buildHealthReport(
  checks: DiagnosticCheckResult[],
  usage: ResourceUsageSnapshot[],
): InstanceHealthReport {
  const status = checks.some((c) => c.status === 'fail')
    ? 'unhealthy'
    : checks.some((c) => c.status === 'warn')
      ? 'degraded'
      : 'ok';
  const report: InstanceHealthReport = { status, generatedAt: new Date().toISOString(), checks };
  if (usage) report.usage = usage;
  return report;
}

// ── Quota Specialist (pure, advisory) ────────────────────────────────────────

/**
 * Evaluate resource usage snapshots against the advisory ResourceQuotaPolicy,
 * annotating observe/warn messages for each exceeded limit. Advisory only: a
 * disabled policy returns the snapshots unchanged, and even a policy 'block' mode
 * is downgraded to an advisory observation — it never blocks or throttles.
 */
export function evaluateUsage(
  snapshots: ResourceUsageSnapshot[],
  policy: ResourceQuotaPolicy,
): ResourceUsageSnapshot[] {
  if (!policy.enabled) return snapshots;

  // Non-enforcing: a would-be 'block' outcome is downgraded to an observation.
  const advisory = policy.mode === 'block' ? 'observe' : policy.mode || 'observe';

  return snapshots.map((snapshot) => {
    const messages: string[] = [];
    const compare = (value: number | undefined, limit: number | undefined, label: string): void => {
      if (typeof value === 'number' && typeof limit === 'number' && value > limit) {
        messages.push(`[${advisory}] ${label} ${value} exceeds limit ${limit}`);
      }
    };
    compare(snapshot.projectCount, policy.maxProjectsPerUser, 'projectCount');
    compare(snapshot.projectBytes, policy.maxProjectBytes, 'projectBytes');
    compare(snapshot.mcpRequestsLastMinute, policy.maxMcpRequestsPerMinute, 'mcpRequestsPerMinute');
    compare(snapshot.auditEventsToday, policy.maxAuditEventsPerDay, 'auditEventsPerDay');
    if (messages.length === 0) return snapshot;
    return { ...snapshot, quotaMessages: [...snapshot.quotaMessages, ...messages] };
  });
}

// ── Operations Orchestrator ──────────────────────────────────────────────────

/**
 * Authenticate the caller, authorize operations read, list hosted projects, and
 * assemble a redacted instance health report (diagnostic checks plus usage
 * snapshots) via the diagnostics specialist. Read-only; no writes, no audit.
 */
export function getHealthReport(
  cfg: HostConfig,
  credential: string | null,
  scope?: string,
): InstanceHealthReport {
  const principal = requirePrincipal(cfg, credential);
  const readScope = requireOperationsReadScope(cfg, principal);

  const projects = narrowToScope(listProjectRecords(cfg.dataDir), readScope);

  // List the server-global packs across both tiers (image + instance), then
  // derive the per-tier name listings from the tier-tagged descriptors. A
  // shadowed image pack still counts as present in the image tier.
  const globalPacks = packs.storeListGlobalPacks();
  const imagePackNames = globalPacks.filter((p) => p.tier === 'image').map((p) => p.name);
  const instancePackNames = globalPacks.filter((p) => p.tier === 'instance').map((p) => p.name);

  // Read each project's declared pack/profile references from its isolated root.
  const projectReferences = projects.map((p) => packs.readProjectReferences(p.rootPath));

  // Relation health inputs: active relations sourced from in-scope projects,
  // plus the stored snapshots of their targets.
  const scopedIds = new Set(projects.map((p) => p.id));
  const relations = listProjectRelations(cfg.dataDir).filter((r) => scopedIds.has(r.sourceProjectId));
  const relationSnapshots = [...new Set(relations.map((r) => r.targetProjectId))]
    .map((id) => getPublicSurfaceSnapshot(cfg.dataDir, id))
    .filter((snap): snap is NonNullable<typeof snap> => !!snap);
  const checks = runChecks(projects, imagePackNames, instancePackNames, projectReferences, scope, relations, relationSnapshots);
  const usage = collectUsage(projects, scope);
  return buildHealthReport(checks, usage);
}

/**
 * Authenticate the caller, authorize operations read, and return redacted
 * resource usage snapshots derived from the hosted project records. Read-only.
 */
export function getUsage(
  cfg: HostConfig,
  credential: string | null,
  scope?: string,
): ResourceUsageSnapshot[] {
  const principal = requirePrincipal(cfg, credential);
  const readScope = requireOperationsReadScope(cfg, principal);

  const projects = narrowToScope(listProjectRecords(cfg.dataDir), readScope);
  return collectUsage(projects, scope);
}

/**
 * Authenticate the caller, authorize operations read, collect usage snapshots,
 * and evaluate them against the advisory ResourceQuotaPolicy (resolved from host
 * config, disabled default when unset), returning snapshots annotated with
 * observe/warn advisory quota messages. Advisory only — never blocks or throttles.
 */
export function evaluateQuota(
  cfg: HostConfig,
  credential: string | null,
  scope?: string,
): ResourceUsageSnapshot[] {
  const principal = requirePrincipal(cfg, credential);
  const readScope = requireOperationsReadScope(cfg, principal);

  const projects = narrowToScope(listProjectRecords(cfg.dataDir), readScope);
  const usage = collectUsage(projects, scope);
  const policy = resolveQuotaPolicy(cfg);
  return evaluateUsage(usage, policy);
}

// ── Operations Portal (HTTP) ─────────────────────────────────────────────────
//
// Pure forwarding to the orchestrator functions above. Rides the ADMIN-plane
// listener (mirroring identity.ts / landscape.ts), owning its own error → status
// mapping (401/403/404/400) so faults never fall through to the admin-plane
// catch. Endpoints match ioperations_portal exactly. Called by http.ts when the
// admin listener sees an `/operations/*` path AND the exposure policy enables it.

/**
 * Route one operations control-plane request to the orchestrator and write the
 * HTTP response. Read-only: three GET endpoints (health, usage, quota), each
 * taking an optional `scope` query selector.
 */
export function handleOperationsRequest(
  cfg: HostConfig,
  credential: string | null,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['operations', ...]
  const scope = url.searchParams.get('scope') ?? undefined;
  try {
    // GET /operations/health
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'health') {
      return sendJson(res, 200, getHealthReport(cfg, credential, scope));
    }
    // GET /operations/usage
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'usage') {
      return sendJson(res, 200, getUsage(cfg, credential, scope));
    }
    // GET /operations/quota
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'quota') {
      return sendJson(res, 200, evaluateQuota(cfg, credential, scope));
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof UnauthenticatedError) return sendJson(res, 401, { error: 'unauthorized' });
    if (err instanceof ForbiddenError) return sendJson(res, 403, { error: 'forbidden' });
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}
