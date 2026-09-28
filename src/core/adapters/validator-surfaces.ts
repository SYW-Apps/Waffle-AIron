// ---------------------------------------------------------------------------
// validator_surfaces_adapter — sdd_validator's client hop into sdd_surfaces.
//
// Identity re-exports of the surface portal: the bound root's own foreign
// surface snapshots and its pinned externals for the owner's gate, and the
// externals status a family run composes from.
// ---------------------------------------------------------------------------
export { listSnapshots, listPinnedExternals, getExternalsStatus } from '../surface-portal.js';
