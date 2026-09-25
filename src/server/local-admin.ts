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

// Project, key, producer, secret, git-backing and lock workflows, and the two
// boot-time writes of `wairon dev` / `wairon serve` (admin_orchestrator).
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
  seedIdentityProviderSecret,
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
} from './packs.js';

// Permission assignments (permission_admin_orchestrator).
export { setAssignment, removeAssignment, listAssignments } from './permissionadmin.js';

// Whether a project id is registered — a read through the project repository.
export { existingProjectRoot } from './projects.js';

// The admin plane's authorization refusal.
export { AdminAuthError } from './errors.js';
