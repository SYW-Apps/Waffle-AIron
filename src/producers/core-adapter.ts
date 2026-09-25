// ---------------------------------------------------------------------------
// Producer Core Client Adapter (sdd_producers → sdd_core) — reuse the spec
// loaders and the diagram engine, scoped to the bound project. Identity
// re-exports of the core portals: the hop lands on what sdd_core publishes,
// never on the module behind it.
// ---------------------------------------------------------------------------

export {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  renderDiagram,
} from '../core/index.js';
