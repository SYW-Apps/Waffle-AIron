// ---------------------------------------------------------------------------
// upgrade_core_adapter — sdd_upgrade's client hop into sdd_core (and the gate
// identity from sdd_validator).
//
// Identity forwards of the rewrites the v5 to v6 step reaches until their
// bodies move into it: the Specialist retirement, the Gateway merge, the reachability migration,
// the legacy spec file scan, the chained-subproject repair, and the lock
// record's re-expression and write — each at whatever root the caller bound,
// which during an upgrade is the rehearsal copy's.
// ---------------------------------------------------------------------------
export { findLegacySpecFiles, writeLockRecord } from '../../core/index.js';
// v7 wave 5: the retired-stereotype, reachability and chained-config rewrites left the core portals
// with their specs; the v5-to-v6 step still reaches them until it is deleted with the wairon 5 reading.
export { retireSpecialists, retireGateways } from '../../core/stereotype-migration.js';
export { migrate as migrateReachability } from '../../core/reachability-migration.js';
export { findChainingSubprojectsMissingConfig, backfillChainedSubprojectConfigs } from '../../core/provision.js';
import type { LockRecord } from '../../core/index.js';

/**
 * v7 wave 5: the wairon 5 reading is gone from the core, and with it the
 * re-expression of a format-2 record (approval_comparison.reexpress). The
 * v5-to-v6 step this serves is deleted by the upgrade wave; until then no
 * record is ever re-expressed here, so a v5 record is kept stale.
 */
export function reexpressApproval(_gate: unknown): LockRecord | null {
  return null;
}
export { computeApprovalId } from '../../core/validation.js';
