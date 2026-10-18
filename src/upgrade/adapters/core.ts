// ---------------------------------------------------------------------------
// upgrade_core_adapter — sdd_upgrade's client hop into sdd_core (and the gate
// identity from sdd_validator).
//
// Identity forwards of the rewrites the v5 to v6 step reaches until their
// bodies move into it: the Specialist retirement, the reachability migration,
// the legacy spec file scan, the chained-subproject repair, and the lock
// record's re-expression and write — each at whatever root the caller bound,
// which during an upgrade is the rehearsal copy's.
// ---------------------------------------------------------------------------
export {
  retireSpecialists,
  migrateReachability,
  findLegacySpecFiles,
  findChainingSubprojectsMissingConfig,
  backfillChainedSubprojectConfigs,
  // approval_portal.reexpress under the adapter's contract name.
  reexpress as reexpressApproval,
  writeLockRecord,
} from '../../core/index.js';
export { computeGateStateId } from '../../core/validation.js';
