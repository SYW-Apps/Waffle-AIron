import { ensureInstanceIdentity } from './instance.js';
import { createUnit, getOrganizationUnit, listProjectPlacements, placeProject } from './organization.js';
import { listProjectRecords } from './projects.js';
import type { HostConfig, PrincipalSubject } from './types.js';

// ---------------------------------------------------------------------------
// Instance Bootstrap (sdd_host)
//
// One-time boot initialization of a hosted instance, run BEFORE its listeners
// bind: seeds or loads the persisted instance identity and, under devMode,
// creates the synthetic local development unit when it is missing.
// ---------------------------------------------------------------------------

/** The stable id of the synthetic local development unit `wairon dev` boots
 *  with, so dev projects can always be placed (unitId is required at creation). */
export const DEV_UNIT_ID = 'local';

/**
 * One-time boot initialization — the sdd_host lifecycle init entrypoint, run
 * BEFORE the listeners bind (idempotent):
 *   1. Seed-or-load the persisted instance identity: the first boot generates
 *      the boot-reserved built-in subject UUIDs into <dataDir>/instance.json;
 *      every later boot loads them unchanged.
 *   2. Under devMode, ensure the synthetic local development organization unit
 *      exists so dev projects can always be placed.
 *   3. Under devMode, place every project the data dir holds in no unit into
 *      that unit, so `wairon dev`'s own fresh data dir never reads as an
 *      instance awaiting the permission-model migration.
 */
export function bootstrapInstance(config: HostConfig): void {
  ensureInstanceIdentity(config.dataDir);
  if (!config.devMode) return;
  const system: PrincipalSubject = { userId: 'system', kind: 'service', issuer: 'local' };
  if (!getOrganizationUnit(config.dataDir, DEV_UNIT_ID)) {
    createUnit(config.dataDir, {
      id: DEV_UNIT_ID,
      name: 'Local Development',
      kind: 'team',
      slug: DEV_UNIT_ID, // a root unit's qualified id IS its slug
      status: 'active',
      createdAt: '',
      createdBy: system,
    });
  }
  // Steps 6-9: the dev project (registered at the working directory before the
  // server boots) placed in the dev unit — a placed project is never placed twice.
  const placed = new Set(listProjectPlacements(config.dataDir).map((p) => p.projectId));
  for (const record of listProjectRecords(config.dataDir)) {
    // A member record is placed through its family root, never on its own.
    if (placed.has(record.id) || record.parentProjectId !== undefined) continue;
    placeProject(config.dataDir, {
      id: '',
      projectId: record.id,
      unitId: DEV_UNIT_ID,
      role: 'owner',
      createdAt: '',
      createdBy: system,
    });
  }
}
