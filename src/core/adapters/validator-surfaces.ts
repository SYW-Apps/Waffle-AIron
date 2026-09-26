// ---------------------------------------------------------------------------
// validator_surfaces_adapter — sdd_validator's client hop into sdd_surfaces.
//
// Identity re-exports of the surface portal: the stored snapshots of the bound
// root, and those each chained mount holds in its own tree.
// ---------------------------------------------------------------------------
export { listSnapshots, listMountSnapshots } from '../surface-portal.js';
