// ---------------------------------------------------------------------------
// surfaces_core_adapter — sdd_surfaces' client hop into sdd_core.
//
// Identity re-exports of the core portals: the spec reads a surface is
// projected from, the chaining reads a family pin follows, and the tree's
// content identity a snapshot is stamped with.
// ---------------------------------------------------------------------------
export {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadTypeSpecs,
  resolveChainingParent,
  resolveSubprojectForNamespace,
  computeStateId,
} from '../index.js';
