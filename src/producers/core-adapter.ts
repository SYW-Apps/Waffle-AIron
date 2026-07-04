// ---------------------------------------------------------------------------
// Producer Core Client Adapter (sdd_producers → sdd_core) — reuse the spec
// loaders and the diagram engine, scoped to the bound project.
// ---------------------------------------------------------------------------

export {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
} from '../core/specs.js';
export { renderDiagram } from '../core/diagram.js';
