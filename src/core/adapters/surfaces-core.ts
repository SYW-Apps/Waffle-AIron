// ---------------------------------------------------------------------------
// surfaces_core_adapter — sdd_surfaces' client hop into sdd_core.
//
// Identity re-exports of the core portals: the spec reads a surface is
// projected from, the configuration whose externals the pins are read for,
// and the tree's content identity a snapshot is stamped with.
// ---------------------------------------------------------------------------
export {
  loadSystemSpec,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadTypeSpecs,
  computeStateId,
  // The resolved export table the projector flattens, and the configuration
  // whose effective id a snapshot records beside its name.
  resolveProjectExports,
  loadProjectConfig,
  // The bound project's declared externals, each bound to its producer: the
  // surfaces plane never walks the family itself.
  resolveExternals,
  // A part's excerpt of its parent, for `wairon externals pin` at a part (stage 8).
  excerptParent,
} from '../index.js';
