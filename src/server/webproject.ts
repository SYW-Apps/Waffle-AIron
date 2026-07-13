import { authenticateSession } from './auth.js';
import { listOrganizationUnits, listProjectPlacements } from './organization.js';
import { resolveScope } from './scope.js';
import { listProjectRecords } from './projects.js';
import {
  createProject as adminCreateProject,
  lockProject as adminLockProject,
  promoteProject as adminPromoteProject,
  destroyProject as adminDestroyProject,
} from './admin.js';
import type { LockRecord } from '../core/lockfile.js';
import type { HostConfig, HostedProjectRecord, PromoteResult } from './types.js';

// ---------------------------------------------------------------------------
// Web Project Orchestrator (sdd_host)
//
// Server-side project-lifecycle workflows for the unified web UI, on the PUBLIC
// data plane. Every method is browser-session authenticated (a ws_ session is a
// first-class data-plane credential that resolves to a Principal exactly like a
// bearer token).
//
// create/lock/promote/destroy are THIN forwards to the admin orchestrator,
// passing the session id AS the credential. Those admin functions authorize by
// the caller's GRANT SCOPE (project:create / lock:create / promote:mark-ready /
// project:destroy over the org tree) and re-validate, so a signed-in human
// manages exactly the projects their grants permit — no new authorization
// surface is introduced here.
//
// listProjects is OWNED here because the admin orchestrator's list is
// master-only (requireAdmin). It resolves the session to a Principal, resolves
// the caller's project-access scope over the organization tree (mcp:read, the
// same access level the web context derives visibleProjectIds from), and returns
// only the project records within that scope (a super-admin sees all).
// ---------------------------------------------------------------------------

/**
 * Resolve the session to a Principal, resolve the caller's project-access scope
 * over the organization tree, and return the hosted project records within that
 * scope — every record for a super-admin (scope.all), otherwise those whose id
 * is in the resolved scope's projectIds. An expired or absent session yields an
 * unauthenticated principal (no grants → an empty result), never a throw. A read;
 * not audited.
 */
export function listProjects(cfg: HostConfig, sessionId: string): HostedProjectRecord[] {
  // step 1: resolve the browser session to a Principal (unauthenticated → no grants).
  const principal = authenticateSession(cfg.dataDir, sessionId);

  // steps 2–3: gather the org unit tree and project placements the scope is computed over.
  const units = listOrganizationUnits(cfg.dataDir);
  const placements = listProjectPlacements(cfg.dataDir);

  // step 4: resolve the caller's project-access scope (unit-scoped grants expand
  // across each unit's subtree). mcp:read is the access level the web context
  // derives visibleProjectIds from, so the managed set matches what the UI shows.
  const scope = resolveScope(principal.grants ?? [], 'mcp:read', units, placements);

  // step 5: list all hosted project records.
  const records = listProjectRecords(cfg.dataDir);

  // step 6: keep only the records within the caller's scope (all for a super-admin).
  if (scope.all) return records;
  const inScope = new Set(scope.projectIds);
  return records.filter((r) => inScope.has(r.id)); // step 7
}

/**
 * Create a hosted project. Forwards to admin_orchestrator.createProject passing
 * the sessionId as the credential — project:create scope (and the required target
 * org unit for a unit-scoped creator) is enforced there.
 */
export function createProject(
  cfg: HostConfig,
  sessionId: string,
  id: string,
  unitId?: string,
): HostedProjectRecord {
  return adminCreateProject(cfg, sessionId, id, unitId); // step 1 (forward)
}

/**
 * Lock a project (validate-as-complete, then write the StateId-scoped lock).
 * Forwards to admin_orchestrator.lockProject passing the sessionId as the
 * credential — lock:create scope is enforced there.
 */
export function lockProject(cfg: HostConfig, sessionId: string, projectId: string): LockRecord {
  return adminLockProject(cfg, sessionId, projectId); // step 1 (forward)
}

/**
 * Mark a locked project ready for promotion after the StateId re-check. Forwards
 * to admin_orchestrator.promoteProject passing the sessionId as the credential —
 * promote:mark-ready scope is enforced there.
 */
export function promoteProject(cfg: HostConfig, sessionId: string, projectId: string): PromoteResult {
  return adminPromoteProject(cfg, sessionId, projectId); // step 1 (forward)
}

/**
 * Deregister a project and its tree. Forwards to admin_orchestrator.destroyProject
 * passing the sessionId as the credential — project:destroy scope is enforced there.
 */
export function destroyProject(cfg: HostConfig, sessionId: string, id: string): void {
  adminDestroyProject(cfg, sessionId, id); // step 1 (forward)
}
