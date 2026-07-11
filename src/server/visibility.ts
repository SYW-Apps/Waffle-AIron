import type {
  OrganizationUnitRecord,
  ProjectPlacement,
  VisibilityResolution,
} from './types.js';

// ---------------------------------------------------------------------------
// Surface visibility (sdd_host / visibility_specialist) — Phase 7 Stage 2.
//
// PURE unit-graph visibility resolution: the visibility sibling of scope.ts.
// Given the org unit tree (postures + exposeTo grants) and the placements,
// compute which projects' PUBLIC SURFACES an observer project may discover,
// and at what audience distance. No I/O, no authorization side effects.
//
// Semantics (locked in the spec tree):
// - Within a tenant subtree: open unless a CLOSED posture intervenes.
// - A closed unit hides its subtree placements from everyone outside that
//   unit's subtree, except units granted via exposeTo. (A team-private group
//   under a team is `closed` + exposeTo: [team-unit] — grants are explicit.)
// - Tenant roots are ALWAYS closed toward other tenant roots: cross-tenant
//   visibility exists only through an exposeTo grant on the target's path
//   (fail-closed). No deny-lists anywhere.
// - Distance classes intersect with entry audience ceilings downstream:
//   department (same branch) | instance (same tenant) | partner (cross-tenant).
// ---------------------------------------------------------------------------

/** Ascending audience reach; 'public' is a legacy alias of 'external'. */
const AUDIENCE_RANKS: Record<string, number> = {
  project: 0,
  department: 1,
  instance: 2,
  partner: 3,
  external: 4,
  public: 4,
};

/** Rank of an entry's declared audience ceiling; absent/unknown defaults to 'instance'. */
export function audienceRank(audience: string | undefined): number {
  return AUDIENCE_RANKS[audience ?? 'instance'] ?? AUDIENCE_RANKS.instance;
}

/**
 * Whether an entry's audience ceiling covers an observer at `distance`.
 * A null distance (target not visible through the unit graph — e.g. a legacy
 * relation predating a closure) is the farthest class: only external/public
 * entries remain visible.
 */
export function audienceCovers(entryAudience: string | undefined, distance: string | null): boolean {
  const required = distance === null ? AUDIENCE_RANKS.external : (AUDIENCE_RANKS[distance] ?? AUDIENCE_RANKS.partner);
  return audienceRank(entryAudience) >= required;
}

/** Self-to-root ancestor chain (self first); cycle-guarded, missing parents tolerated. */
function chainOf(unitId: string, unitById: Map<string, OrganizationUnitRecord>): OrganizationUnitRecord[] {
  const chain: OrganizationUnitRecord[] = [];
  const seen = new Set<string>();
  let current = unitById.get(unitId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.parentId ? unitById.get(current.parentId) : undefined;
  }
  return chain;
}

/** A unit's effective posture: first explicit open/closed on its inherit walk; roots default open. */
function effectivePosture(unit: OrganizationUnitRecord, unitById: Map<string, OrganizationUnitRecord>): 'open' | 'closed' {
  for (const u of chainOf(unit.id, unitById)) {
    if (u.visibility === 'open' || u.visibility === 'closed') return u.visibility;
  }
  return 'open';
}

/**
 * visibility_specialist.resolveVisibility — pure. Compute the observer
 * project's visibility view over the instance. An observer with no placements
 * sees nothing (fail-closed: an unplaced project has no organizational
 * standpoint to see FROM).
 */
export function resolveVisibility(
  observerProjectId: string,
  units: OrganizationUnitRecord[],
  placements: ProjectPlacement[],
): VisibilityResolution {
  const unitById = new Map(units.map((u) => [u.id, u]));

  // Observer standpoint: direct placement units + their full ancestor chains.
  const directUnits = placements
    .filter((p) => p.projectId === observerProjectId)
    .map((p) => p.unitId)
    .filter((id) => unitById.has(id));
  const membership = new Set<string>();
  const tenantRoots = new Set<string>();
  for (const id of directUnits) {
    const chain = chainOf(id, unitById);
    for (const u of chain) membership.add(u.id);
    if (chain.length) tenantRoots.add(chain[chain.length - 1].id);
  }

  const observerInside = (unitId: string): boolean => membership.has(unitId);
  const grantedTo = (u: OrganizationUnitRecord): boolean =>
    (u.exposeTo ?? []).some((g) => membership.has(g));

  /** Same branch: the target unit lies on an observer chain, or an observer direct unit lies on the target's chain. */
  const sameBranch = (targetUnitId: string): boolean => {
    const targetChainIds = new Set(chainOf(targetUnitId, unitById).map((u) => u.id));
    for (const obs of directUnits) {
      if (targetChainIds.has(obs)) return true;           // observer unit is an ancestor of (or is) the target unit
      if (chainOf(obs, unitById).some((u) => u.id === targetUnitId)) return true; // target unit is an ancestor of the observer unit
    }
    return false;
  };

  const distanceRankOrder = { department: 0, instance: 1, partner: 2 } as const;
  const best = new Map<string, { projectId: string; distance: 'department' | 'instance' | 'partner'; via: string }>();

  for (const placement of placements) {
    if (placement.projectId === observerProjectId) continue;
    const path = chainOf(placement.unitId, unitById);
    if (!path.length) continue;

    // Every effectively-CLOSED unit on the path must be individually opened
    // for this observer: observer inside its subtree, or granted via exposeTo.
    const closedOk = path.every((u) =>
      effectivePosture(u, unitById) !== 'closed' || observerInside(u.id) || grantedTo(u));
    if (!closedOk) continue;

    // Tenant roots are implicitly closed across tenants: a foreign observer
    // needs at least one exposeTo grant somewhere on the path.
    const crossTenant = !tenantRoots.has(path[path.length - 1].id);
    if (crossTenant && !path.some(grantedTo)) continue;
    if (crossTenant && directUnits.length === 0) continue; // unplaced observer: no standpoint

    const distance: 'department' | 'instance' | 'partner' = crossTenant
      ? 'partner'
      : sameBranch(placement.unitId)
        ? 'department'
        : 'instance';

    const existing = best.get(placement.projectId);
    if (!existing || distanceRankOrder[distance] < distanceRankOrder[existing.distance]) {
      best.set(placement.projectId, { projectId: placement.projectId, distance, via: placement.unitId });
    }
  }

  return {
    observerProjectId,
    observerUnitIds: [...membership],
    visibleProjects: [...best.values()],
  };
}

/** visibility_specialist.isVisible — point check over a resolution. */
export function isVisible(resolution: VisibilityResolution, targetProjectId: string): boolean {
  return resolution.visibleProjects.some((v) => v.projectId === targetProjectId);
}

/** visibility_specialist.audienceDistance — the distance class of a visible target, or null. */
export function audienceDistance(resolution: VisibilityResolution, targetProjectId: string): string | null {
  return resolution.visibleProjects.find((v) => v.projectId === targetProjectId)?.distance ?? null;
}
