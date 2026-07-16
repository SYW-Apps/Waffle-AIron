import { authenticateSession } from './auth.js';
import { visibleScopes, actionableProjectIds, isInstanceAdmin } from './authorization.js';
import { listProjectRecords } from './projects.js';
import {
  lockProject as adminLockProject,
  promoteProject as adminPromoteProject,
  destroyProject as adminDestroyProject,
} from './admin.js';
import { initializeProjectWithProfile } from './policy.js';
import type { LockRecord } from '../core/lockfile.js';
import type {
  HostConfig,
  HostedProjectRecord,
  ProjectInitRequest,
  ProjectProfileSelection,
  PromoteResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Web Project Orchestrator (sdd_host)
//
// Server-side project-lifecycle workflows for the unified web UI, on the PUBLIC
// data plane. Every method is browser-session authenticated (a ws_ session is a
// first-class data-plane credential that resolves to a Principal exactly like a
// bearer token).
//
// create/lock/promote/destroy are THIN forwards to the admin orchestrator,
// passing the session id AS the credential. Those admin functions authorize
// through the permission resolver (project:create / project:write /
// project:admin over the org tree) and re-validate, so a signed-in human manages
// exactly the projects their permissions allow — no new authorization surface is
// introduced here.
//
// listProjects is OWNED here because the admin orchestrator's list is
// master-only (requireAdmin). It resolves the session to a Principal, computes
// the caller's project:read visible scopes, and returns only the project records
// they can act on.
// ---------------------------------------------------------------------------

/**
 * Resolve the session to a Principal, compute the caller's project:read visible
 * scopes over the organization tree, and return the hosted project records they
 * can act on. Breadcrumb (context) scopes are deliberately excluded: an ancestor
 * shown only for navigation is not a project the caller may open. An expired or
 * absent session yields an unauthenticated principal (an empty result), never a
 * throw. A read; not audited.
 */
export function listProjects(cfg: HostConfig, sessionId: string): HostedProjectRecord[] {
  // step 1: resolve the browser session to a Principal (unauthenticated → sees nothing).
  const principal = authenticateSession(cfg.dataDir, sessionId);

  // step 2: list all hosted project records.
  const records = listProjectRecords(cfg.dataDir);

  // step 3: an instance-admin sees the whole instance, including projects not yet
  // placed in any organization unit (which no unit-scoped permission can reach).
  if (isInstanceAdmin(principal)) return records;

  // step 4: otherwise keep only the projects the caller can act on.
  const inScope = new Set(actionableProjectIds(visibleScopes(cfg.dataDir, principal, 'project:read')));
  return records.filter((r) => inScope.has(r.id));
}

/**
 * Create a hosted project placed in the REQUIRED owner unit, optionally with a
 * profile selection. Builds a ProjectInitRequest and forwards to
 * project_policy_orchestrator.initializeProjectWithProfile with the session as
 * the credential, so the instance pack policy (required/default packs, profile
 * requirements, enforcement mode) applies to a web create exactly as it does to
 * the MCP init — project:create over the unit is enforced there.
 */
export function createProject(
  cfg: HostConfig,
  sessionId: string,
  id: string,
  unitId: string,
  profileSelection?: ProjectProfileSelection,
): HostedProjectRecord {
  // step 1: the init request (id, REQUIRED owner unit, optional profile).
  const request: ProjectInitRequest = {
    id,
    ownerUnitId: unitId,
    ...(profileSelection !== undefined ? { profileSelection } : {}),
  };
  return initializeProjectWithProfile(cfg, sessionId, request); // steps 2–3 (forward)
}

/**
 * Lock a project (validate-as-complete, then write the StateId-scoped lock).
 * Forwards to admin_orchestrator.lockProject passing the sessionId as the
 * credential — project:write permission is enforced there.
 */
export function lockProject(cfg: HostConfig, sessionId: string, projectId: string): LockRecord {
  return adminLockProject(cfg, sessionId, projectId); // step 1 (forward)
}

/**
 * Mark a locked project ready for promotion after the StateId re-check. Forwards
 * to admin_orchestrator.promoteProject passing the sessionId as the credential —
 * project:write permission is enforced there.
 */
export function promoteProject(cfg: HostConfig, sessionId: string, projectId: string): PromoteResult {
  return adminPromoteProject(cfg, sessionId, projectId); // step 1 (forward)
}

/**
 * Deregister a project and its tree. Forwards to admin_orchestrator.destroyProject
 * passing the sessionId as the credential — project:admin permission is enforced there.
 */
export function destroyProject(cfg: HostConfig, sessionId: string, id: string): void {
  adminDestroyProject(cfg, sessionId, id); // step 1 (forward)
}
