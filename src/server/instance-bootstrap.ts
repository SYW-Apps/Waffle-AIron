import { ensureInstanceIdentity } from './instance.js';
import { createUnit, getOrganizationUnit } from './organization.js';
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
 */
export function bootstrapInstance(cfg: HostConfig): void {
  ensureInstanceIdentity(cfg.dataDir);
  if (cfg.devMode && !getOrganizationUnit(cfg.dataDir, DEV_UNIT_ID)) {
    const system: PrincipalSubject = { userId: 'system', kind: 'service', issuer: 'local' };
    createUnit(cfg.dataDir, {
      id: DEV_UNIT_ID,
      name: 'Local Development',
      kind: 'team',
      slug: DEV_UNIT_ID, // a root unit's qualified id IS its slug
      status: 'active',
      createdAt: '',
      createdBy: system,
    });
  }
}
