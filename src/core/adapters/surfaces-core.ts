// ---------------------------------------------------------------------------
// surfaces_core_adapter — sdd_surfaces' client hop into sdd_core.
//
// Identity re-exports of the core portals: the spec reads a surface is
// projected from, the member reads a mount's snapshots follow, and the tree's
// content identity a snapshot is stamped with.
// ---------------------------------------------------------------------------
export {
  loadSystemSpec,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadTypeSpecs,
  resolveSubprojectForNamespace,
  computeStateId,
  // The resolved export table the projector flattens, and the configuration
  // whose effective id a snapshot records beside its name.
  resolveProjectExports,
  loadProjectConfig,
  // The bound project's declared externals, each bound to its producer: the
  // surfaces plane never walks the family itself.
  resolveExternals,
} from '../index.js';
