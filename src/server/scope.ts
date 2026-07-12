import { listOrganizationUnits, listProjectPlacements } from './organization.js';
import type {
  HostConfig,
  OrganizationUnitRecord,
  Principal,
  ProjectGrant,
  ProjectPlacement,
  ScopeResolution,
} from './types.js';

// ---------------------------------------------------------------------------
// Authorization scope (sdd_host) — Phase 6 tenancy.
//
// Two layers, mirroring the spec tree:
//   1. scope_specialist (resolveScope, permits) — PURE. Given a principal's
//      grants plus the org unit tree and placements, compute the set of hosted
//      project ids and unit ids the principal may act on for a permission, or
//      `all` for an instance-wide ('*') super-admin. No I/O.
//   2. resolveScopeFor — the impure convenience the orchestrators call: gather
//      the org data once (units + placements) and delegate to the pure
//      specialist. Centralizes the gather+resolve so every scoped control-plane
//      method reads the same way and the scope logic lives in one audited place.
// ---------------------------------------------------------------------------

/** The '*' wildcard matches any projectId and any permission. */
const WILDCARD = '*';

/** A grant carries a permission when it lists the exact string or the wildcard. */
function grantCarries(grant: ProjectGrant, permission: string): boolean {
  return grant.permissions.includes(WILDCARD) || grant.permissions.includes(permission);
}

/**
 * The recursive descendant subtree of a unit: the unit itself plus every unit
 * transitively reachable through parentId. Iterative worklist over the supplied
 * units (no I/O); a cycle in parentId (shouldn't occur — the registry rejects
 * them) terminates because each id is visited once.
 */
function subtreeUnitIds(rootUnitId: string, units: OrganizationUnitRecord[]): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const u of units) {
    if (!u.parentId) continue;
    const siblings = childrenByParent.get(u.parentId) ?? [];
    siblings.push(u.id);
    childrenByParent.set(u.parentId, siblings);
  }
  const inScope = new Set<string>();
  const worklist = [rootUnitId];
  while (worklist.length > 0) {
    const id = worklist.pop()!;
    if (inScope.has(id)) continue;
    inScope.add(id);
    for (const child of childrenByParent.get(id) ?? []) worklist.push(child);
  }
  return inScope;
}

/**
 * scope_specialist.resolveScope — pure. Compute the caller's authorization scope
 * for `permission`. A '*' grant carrying the permission → all=true (super-admin,
 * no filtering). Otherwise each carrying grant contributes: an orgUnitId grant
 * expands to that unit's recursive subtree of units plus every project placed in
 * that subtree; a specific projectId adds itself. Deduplicated union.
 */
export function resolveScope(
  grants: ProjectGrant[],
  permission: string,
  units: OrganizationUnitRecord[],
  placements: ProjectPlacement[],
): ScopeResolution {
  // First pass: an instance-wide super-admin grant short-circuits all filtering.
  // A grant that names an orgUnitId is unit-scoped by intent even if its
  // projectId is '*' (contradictory) — it must NOT confer super-admin.
  for (const grant of grants) {
    if (grant.projectId === WILDCARD && !grant.orgUnitId && grantCarries(grant, permission)) {
      return { all: true, projectIds: [], unitIds: [] };
    }
  }

  // Second pass: accumulate unit- and project-scoped authority.
  const projectIds = new Set<string>();
  const unitIds = new Set<string>();
  for (const grant of grants) {
    if (!grantCarries(grant, permission)) continue;
    if (grant.orgUnitId) {
      const subtree = subtreeUnitIds(grant.orgUnitId, units);
      for (const uid of subtree) unitIds.add(uid);
      for (const placement of placements) {
        if (subtree.has(placement.unitId)) projectIds.add(placement.projectId);
      }
    } else if (grant.projectId && grant.projectId !== WILDCARD) {
      projectIds.add(grant.projectId);
    }
  }
  return { all: false, projectIds: [...projectIds], unitIds: [...unitIds] };
}

/** scope_specialist.permits — a point check: does this scope reach `projectId`? */
export function permits(scope: ScopeResolution, projectId: string): boolean {
  return scope.all || scope.projectIds.includes(projectId);
}

/**
 * The impure convenience the orchestrators call: gather the org data (units +
 * placements) and delegate to the pure specialist. One place to audit how a
 * principal's scope is computed for every scoped control-plane method.
 */
export function resolveScopeFor(
  cfg: HostConfig,
  principal: Principal,
  permission: string,
): ScopeResolution {
  const units = listOrganizationUnits(cfg.dataDir);
  const placements = listProjectPlacements(cfg.dataDir);
  return resolveScope(principal.grants ?? [], permission, units, placements);
}
