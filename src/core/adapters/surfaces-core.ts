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
  // The design export's reads (stage 4-5): every subsystem and implementation,
  // and each subsystem's resolved L1 export table.
  loadSubsystemSpecs,
  loadImplementationSpecs,
  resolveSubsystemExports,
  // The project graph, whose direct project members the design export lists
  // as dependencies (their L0 tables read through resolveProjectExports).
  projectFamily,
  // `wairon externals add` / sdd_add_external: one external declaration
  // written into the bound project's configuration, and taken back out when
  // the producer contradicts it.
  declareExternal,
  removeExternal,
  // `wairon externals add` checks a declaration against its producer before it
  // writes it; `wairon externals use` appends `use` imports; `wairon externals
  // consumers` lists the family projects in reach that consume this one.
  resolveExternalCandidate,
  importNames,
  listExternalConsumers,
} from '../index.js';
