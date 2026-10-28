import { listOrganizationUnits, listProjectPlacements } from './organization.js';
import { listAssignments } from './permissions.js';
import { listEffectiveRoles } from './roles.js';
import { resolvePermission, resolveSubsystemReach, resolveVisibleScopes } from './permission-rules.js';
import { listProjectRecords } from './projects.js';
import type {
  EffectivePermission,
  FamilyReach,
  HostedProjectRecord,
  PermissionSubject,
  PermissionWorld,
  Principal,
  ProjectParentLink,
  VisibleScope,
} from './types.js';
import { SUBSYSTEM_SCOPE_SEPARATOR } from './types.js';

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
  // Step 5: gather the effective role set — the built-in roles merged over the stored ones.
  const roles = listEffectiveRoles(dataDir);
  // Step 6: assemble the world.
  return { assignments, roles, units, placements, parents };
}

/**
 * Whether a key narrowing confines the principal away from a target scope: an
 * instance or unit scope always, a project scope whose record no entry covers,
 * and a subsystem scope of such a project. An entry covers its record and every
 * member record whose parent chain climbs through it. A principal without a key
 * narrowing (a session, the master credential, an unnarrowed key) is never confined.
 */
function narrowedAway(principal: Principal, scopeKind: string, scopeId: string, world: PermissionWorld): boolean {
  const narrowing = principal.keyNarrowing;
  if (narrowing === undefined) return false;
  if (scopeKind === 'project') return !keyCovers(narrowing, scopeId, world);
  if (scopeKind === 'subsystem') return !keyCovers(narrowing, scopeId.split(SUBSYSTEM_SCOPE_SEPARATOR)[0], world);
  return true;
}

/** What a request naming a project hears when it is refused only because its key is narrowed to other projects: the same for a project that exists and one that does not. */
const PROJECT_NARROWING_NOTE = 'This key is narrowed to its projects, and this project is not one of them.';

/** The sentence for a request naming a project the principal's key is narrowed away from, or undefined. */
export function narrowingNote(dataDir: string, principal: Principal, projectId: string): string | undefined {
  const narrowing = principal.keyNarrowing;
  if (narrowing === undefined) return undefined;
  return keyCovers(narrowing, projectId, gatherPermissionWorld(dataDir)) ? undefined : PROJECT_NARROWING_NOTE;
}

/** Whether a key's entries cover a record: the record itself, or a project its parent chain climbs through. */
function keyCovers(narrowing: string[], projectId: string, world: PermissionWorld): boolean {
  if (narrowing.includes('*')) return true;
  const seen = new Set<string>();
  for (let at: string | undefined = projectId; at !== undefined && !seen.has(at); at = world.parents.find((p) => p.projectId === at)?.parentProjectId) {
    if (narrowing.includes(at)) return true;
    seen.add(at);
  }
  return false;
}

/**
 * A narrowed key's view: actionable only the project and subsystem scopes its
 * narrowing covers; context only the scopes above them that the view already
 * held (their parent projects and the units above their family root).
 */
function narrowView(principal: Principal, scopes: VisibleScope[], world: PermissionWorld): VisibleScope[] {
  if (principal.keyNarrowing === undefined) return scopes;
  const kept = scopes.filter((s) => s.scopeKind !== 'unit' && !narrowedAway(principal, s.scopeKind, s.scopeId, world));
  const above = new Set<string>();
  for (const s of kept) {
    let project = s.scopeKind === 'subsystem' ? s.scopeId.split(SUBSYSTEM_SCOPE_SEPARATOR)[0] : s.scopeId;
    for (let parent = world.parents.find((p) => p.projectId === project); parent !== undefined; parent = world.parents.find((p) => p.projectId === project)) {
      if (above.has(`project:${parent.parentProjectId}`)) break;
      above.add(`project:${parent.parentProjectId}`);
      project = parent.parentProjectId;
    }
    for (const placement of world.placements.filter((p) => p.projectId === project)) {
      const parts = placement.unitId.split('.');
      for (let i = 1; i <= parts.length; i++) above.add(`unit:${parts.slice(0, i).join('.')}`);
    }
  }
  const keptKeys = new Set(kept.map((s) => `${s.scopeKind}:${s.scopeId}`));
  const context = scopes
    .filter((s) => !keptKeys.has(`${s.scopeKind}:${s.scopeId}`) && above.has(`${s.scopeKind}:${s.scopeId}`))
    .map((s) => ({ ...s, context: true }));
  return [...context, ...kept];
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
  const reach: FamilyReach = { readable: [], writable: [], subsystems: [] };
  if (!principal.authenticated || !principal.permissionSubject) return reach;
  // Step 1: gather the permission world once.
  const world = gatherPermissionWorld(dataDir);
  // Steps 2-4: each record's read and write over its own project scope.
  for (const id of projectIds) {
    // Step 3: a record the key narrowing does not cover is neither read nor written.
    if (narrowedAway(principal, 'project', id, world)) continue;
    if (resolvePermission(principal.permissionSubject, 'project:read', 'project', id, world).value === 'yes') reach.readable.push(id);
    // A read-only key reads what its owner reads, but writes no record and meets no subsystem rung.
    if (principal.keyReadOnly === true) continue;
    if (resolvePermission(principal.permissionSubject, 'project:write', 'project', id, world).value === 'yes') reach.writable.push(id);
    // Step 5: the subsystem rungs the principal meets in the record.
    reach.subsystems.push(...resolveSubsystemReach(principal.permissionSubject, id, world));
  }
  // Step 6.
  return reach;
}

/**
 * Resolve a GIVEN subject's effective permission for a capability at a target
 * scope (unit, project or subsystem) through the same walk authorize takes —
 * the value, its source and the rung that decided it. It authenticates and
 * authorizes nobody: its caller must already have authorized the asker.
 */
export function explain(
  dataDir: string,
  subject: PermissionSubject,
  capability: string,
  scopeKind: string,
  scopeId: string,
): EffectivePermission {
  // Step 1: gather the permission world once, as world does.
  const world = gatherPermissionWorld(dataDir);
  // Steps 2-3.
  return resolvePermission(subject, capability, scopeKind, scopeId, world);
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
  // Steps 7-8: a key acts as its owner only within the projects it is narrowed to.
  if (narrowedAway(principal, scopeKind, scopeId, world)) {
    return { value: 'no', source: 'key-narrowing' };
  }
  // Steps 9-10: a read-only key reads what its owner reads and nothing more.
  if (principal.keyReadOnly === true && capability !== 'project:read') {
    return { value: 'no', source: 'key-read-only' };
  }
  // Step 11: resolve the effective permission through pure permission rules.
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
  const scopes = resolveVisibleScopes(principal.permissionSubject, capability, world);
  // Step 8: a narrowed key sees only what its narrowing covers; a read-only key acts on nothing but reads.
  if (principal.keyReadOnly === true && capability !== 'project:read') return [];
  return narrowView(principal, scopes, world);
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
  // A key narrowed to projects, or a read-only key, never holds the bypass, whoever owns it.
  return principal.permissionSubject?.instanceAdmin === true && principal.keyNarrowing === undefined && principal.keyReadOnly !== true;
}

/** The actionable (non-breadcrumb) project ids from a visibility view. */
export function actionableProjectIds(scopes: VisibleScope[]): string[] {
  return scopes.filter((s) => !s.context && s.scopeKind === 'project').map((s) => s.scopeId);
}

/** The actionable (non-breadcrumb) unit ids from a visibility view. */
export function actionableUnitIds(scopes: VisibleScope[]): string[] {
  return scopes.filter((s) => !s.context && s.scopeKind === 'unit').map((s) => s.scopeId);
}
