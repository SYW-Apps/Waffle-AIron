// ---------------------------------------------------------------------------
// Local Admin Portal (sdd_host) — the in-process administration front door,
// published only to sdd_cli beside the HTTP admin portal (src/server/http.ts),
// which stays the remote surface.
//
// Every method is the owning workflow itself, republished by identity: the
// workflows authenticate and authorize the credential the caller presents, so
// this module adds no gate and holds no logic. The admin plane's failure
// classes are republished too — an in-process caller catches the class where an
// HTTP caller reads the status code it maps to.
// ---------------------------------------------------------------------------

import * as memberRegistration from './members.js';
import type { MemberUpgradeReport } from './members.js';

// Project, key, producer, secret, git-backing and lock workflows, and the dev
// server's project registration (admin_orchestrator).
export {
  createProject,
  destroyProject,
  listProjects,
  lockProject,
  mintKey,
  revokeKey,
  listKeys,
  configureProducer,
  produceProducer,
  removeProducer,
  listProducers,
  setSecret,
  listSecrets,
  enableGit,
  disableGit,
  syncGit,
  commitProject,
  getGitBinding,
  configureGitSync,
  registerLocalDevProject,
  LockValidationError,
} from './admin.js';

// Instance-wide and project extension packs (pack_orchestrator).
export {
  listGlobalPacks,
  installGlobalPack,
  removeGlobalPack,
  listProjectPacks,
  installProjectPack,
  removeProjectPack,
  previewProjectPack,
  previewProjectPackRemoval,
} from './packs.js';

// Permission assignments (permission_admin_orchestrator).
export { setAssignment, removeAssignment, listAssignments } from './permissionadmin.js';

// Owner-bound API tokens (identity_orchestrator).
export { mintToken } from './identity.js';

// Boot-time seeding of the default identity provider from the server's own
// environment (identity_provider_bootstrap).
export { seedDefaultProvider } from './identity-provider-bootstrap.js';

// Organization units (landscape_orchestrator).
export { upsertUnit } from './landscape.js';

// The permission-model rollout migration behind `wairon host doctor`
// (permission_model_migration).
export { migratePermissionModel } from './migration.js';

// Starting the hosting server's listeners (host_server).
export { startHostServer } from './http.js';

// Whether a project id is registered — a read through the project repository.
export { existingProjectRoot } from './projects.js';

// The admin plane's authorization refusal.
export { AdminAuthError } from './errors.js';

// The stage-7 member upgrade behind `wairon host doctor` (member_registration).
export type { MemberUpgradeReport, MemberUpgradePlan } from './members.js';

/**
 * Plan, and with apply commit, the stage-7 member upgrade of the data dir:
 * every hosted family's members registered as records (no grants: they inherit
 * through their parent chain), every member-qualified API key entry rewritten
 * to a record id, nobody's reach changed — all or nothing. A dry run or a
 * blocked plan writes nothing.
 */
export function upgradeMemberRecords(dataDir: string, apply: boolean): MemberUpgradeReport {
  // Step 1.
  const plan = memberRegistration.plan(dataDir);
  // Steps 2-4.
  if (apply && plan.refusals.length === 0 && plan.rehearsal) {
    return memberRegistration.apply(dataDir, plan);
  }
  // Steps 5-6.
  memberRegistration.discard(plan);
  return { plan: { ...plan, rehearsal: undefined }, applied: false };
}
