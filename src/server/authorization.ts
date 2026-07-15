import { listOrganizationUnits, listProjectPlacements } from './organization.js';
import { listAssignments } from './permissions.js';
import { listRoles, BUILTIN_ROLES, isBuiltinRoleId } from './roles.js';
import { resolvePermission, resolveVisibleScopes } from './permission_resolver.js';
import type {
  EffectivePermission,
  PermissionWorld,
  Principal,
  Role,
  VisibleScope,
} from './types.js';

// ---------------------------------------------------------------------------
// Authorization Specialist (sdd_host) — the single I/O-backed authorization seam.
//
// The caller has already authenticated (it holds a Principal carrying its
// permissionSubject); this gathers the permission world ONCE and delegates to
// the pure permission resolver. It performs no authentication and no workflow
// routing, and holds no state.
//
// Consumers use exactly two calls:
//   - authorize(...)      -> a point check: yes acts, approval gates, no denies.
//   - visibleScopes(...)  -> a set filter: actionable scopes + their breadcrumb.
// ---------------------------------------------------------------------------

/**
 * The role set the resolver walks: the intrinsic BUILT-IN roles merged over the
 * stored admin-defined ones. Built-ins are code constants, never stored rows, so
 * a binding to one ALWAYS resolves — there is no seeding step to forget and no
 * silent admin lockout. A stray stored row carrying a reserved id can never
 * shadow the built-in definition.
 */
function mergeRoles(stored: Role[]): Role[] {
  return [...stored.filter((r) => !isBuiltinRoleId(r.id)), ...BUILTIN_ROLES];
}

/**
 * Gather the read-only world the pure resolver walks: the organization tree,
 * project placements, the assignment grid, and the role definitions. This is the
 * only I/O in the authorization path.
 */
function gatherWorld(dataDir: string): PermissionWorld {
  // Step 1: gather all organization units.
  const units = listOrganizationUnits(dataDir);
  // Step 2: gather all project placements.
  const placements = listProjectPlacements(dataDir);
  // Step 3: gather the relevant permission assignments.
  const assignments = listAssignments(dataDir);
  // Step 4: gather the role definitions the subject's bindings reference.
  const roles = listRoles(dataDir);
  // Step 5: assemble the world, merging the intrinsic built-in roles.
  return { assignments, roles: mergeRoles(roles), units, placements };
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
  // Steps 1-5: gather the permission world once.
  const world = gatherWorld(dataDir);
  // Step 6: resolve the effective permission through the pure resolver.
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
  // Steps 1-5: gather the permission world once.
  const world = gatherWorld(dataDir);
  // Step 6: compute the actionable scopes plus their ancestor breadcrumb.
  return resolveVisibleScopes(principal.permissionSubject, capability, world);
}

/**
 * True for the env-anchored instance super-admin (built-in admin / master /
 * devMode local developer) — the resolver bypass.
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
