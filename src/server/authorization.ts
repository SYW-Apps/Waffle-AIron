import { listOrganizationUnits, listProjectPlacements } from './organization.js';
import { listAssignments } from './permissions.js';
import { listRoles, BUILTIN_ROLES, isBuiltinRoleId } from './roles.js';
import { resolvePermission, resolveVisibleScopes } from './permission-rules.js';
import { listProjectRecords } from './projects.js';
import type {
  EffectivePermission,
  FamilyReach,
  HostedProjectRecord,
  PermissionWorld,
  Principal,
  ProjectParentLink,
  Role,
  VisibleScope,
} from './types.js';

// ---------------------------------------------------------------------------
// Authorization (sdd_host) — the single I/O-backed authorization seam.
//
// The caller has already authenticated (it holds a Principal carrying its
// permissionSubject); this gathers the permission world ONCE and delegates to
// the pure permission rules. It performs no authentication and no workflow
// routing, and holds no state.
//
// Consumers use exactly two calls:
//   - authorize(...)      -> a point check: yes acts, approval gates, no denies.
//   - visibleScopes(...)  -> a set filter: actionable scopes + their breadcrumb.
// ---------------------------------------------------------------------------

/**
 * The role set permission rules walk: the intrinsic BUILT-IN roles merged over the
 * stored admin-defined ones. Built-ins are code constants, never stored rows, so
 * a binding to one ALWAYS resolves — there is no seeding step to forget and no
 * silent admin lockout. A stray stored row carrying a reserved id can never
 * shadow the built-in definition.
 */
function mergeRoles(stored: Role[]): Role[] {
  return [...stored.filter((r) => !isBuiltinRoleId(r.id)), ...BUILTIN_ROLES];
}

/**
 * Gather the read-only world the pure permission rules walk: the organization tree,
 * project placements, the member records' parent links, the assignment grid, and
 * the role definitions. This is the only I/O in the authorization path.
 */
function gatherWorld(dataDir: string): PermissionWorld {
  // Step 1: gather all organization units.
  const units = listOrganizationUnits(dataDir);
  // Step 2: gather all project placements.
  const placements = listProjectPlacements(dataDir);
  // Step 3: gather the hosted records and project the member records' parent links.
  const parents = parentLinksOf(listProjectRecords(dataDir));
  // Step 4: gather the relevant permission assignments.
  const assignments = listAssignments(dataDir);
  // Step 5: gather the role definitions the subject's bindings reference.
  const roles = listRoles(dataDir);
  // Step 6: assemble the world, merging the intrinsic built-in roles.
  return { assignments, roles: mergeRoles(roles), units, placements, parents };
}

/** Each member record's link to its parent — the project rungs of a member's chain. */
function parentLinksOf(records: HostedProjectRecord[]): ProjectParentLink[] {
  return records
    .filter((r) => r.parentProjectId !== undefined)
    .map((r) => ({ projectId: r.id, parentProjectId: r.parentProjectId as string }));
}

/**
 * Gather the permission world exactly as authorize resolves over it, for a
 * caller that must reason about resolution itself (the member upgrade's reach
 * proof, a membership change's reach listing). A read; no authentication.
 */
export function gatherPermissionWorld(dataDir: string): PermissionWorld {
  return gatherWorld(dataDir);
}

/**
 * Which of the given hosted records the principal may read and write, each
 * resolved through its OWN chain (its own scope, its parents', its family root's
 * units) over one gathered world. An unauthenticated principal reaches nothing.
 */
export function resolveFamilyReach(dataDir: string, principal: Principal, projectIds: string[]): FamilyReach {
  const reach: FamilyReach = { readable: [], writable: [] };
  if (!principal.authenticated || !principal.permissionSubject) return reach;
  // Step 1: gather the permission world once.
  const world = gatherPermissionWorld(dataDir);
  // Steps 2-4: each record's read and write over its own project scope.
  for (const id of projectIds) {
    if (resolvePermission(principal.permissionSubject, 'project:read', 'project', id, world).value === 'yes') reach.readable.push(id);
    if (resolvePermission(principal.permissionSubject, 'project:write', 'project', id, world).value === 'yes') reach.writable.push(id);
  }
  // Step 5.
  return reach;
}

/**
 * Resolve the principal's effective permission (yes/approval/no) for a
 * capability at a target scope. An unauthenticated principal — or one carrying
 * no resolved permissionSubject — fails CLOSED to `no` before any world gather.
 */
export function authorize(
  dataDir: string,
  principal: Principal,
  capability: string,
  scopeKind: string,
  scopeId: string,
): EffectivePermission {
  if (!principal.authenticated || !principal.permissionSubject) {
    return { value: 'no', source: 'instance-default' };
  }
  // Steps 1-6: gather the permission world once.
  const world = gatherWorld(dataDir);
  // Step 7: resolve the effective permission through pure permission rules.
  return resolvePermission(principal.permissionSubject, capability, scopeKind, scopeId, world);
}

/**
 * Compute the scopes on which the principal's effective permission for a
 * capability is yes or approval (actionable), plus their ancestor breadcrumb
 * (context) — for scope-filtered control-plane listings and the hierarchical UI.
 * An unauthenticated principal sees nothing.
 */
export function visibleScopes(
  dataDir: string,
  principal: Principal,
  capability: string,
): VisibleScope[] {
  if (!principal.authenticated || !principal.permissionSubject) {
    return [];
  }
  // Steps 1-6: gather the permission world once.
  const world = gatherWorld(dataDir);
  // Step 7: compute the actionable scopes plus their ancestor breadcrumb.
  return resolveVisibleScopes(principal.permissionSubject, capability, world);
}

/**
 * True for the env-anchored instance super-admin (built-in admin / master /
 * devMode local developer) — the permission-rules bypass.
 *
 * Listings short-circuit on this. A visibility view enumerates the ORG TREE
 * (units and PLACED projects), so an unplaced project is in nobody's visible
 * set; without this short-circuit an instance-admin would stop seeing unplaced
 * projects that the previous instance-wide scope showed them. Leaving unplaced
 * projects out of a NON-admin listing is correct and fail-closed: they sit in no
 * organization unit, so no unit-scoped permission can reach them.
 */
export function isInstanceAdmin(principal: Principal): boolean {
  return principal.permissionSubject?.instanceAdmin === true;
}

/** The actionable (non-breadcrumb) project ids from a visibility view. */
export function actionableProjectIds(scopes: VisibleScope[]): string[] {
  return scopes.filter((s) => !s.context && s.scopeKind === 'project').map((s) => s.scopeId);
}

/** The actionable (non-breadcrumb) unit ids from a visibility view. */
export function actionableUnitIds(scopes: VisibleScope[]): string[] {
  return scopes.filter((s) => !s.context && s.scopeKind === 'unit').map((s) => s.scopeId);
}
