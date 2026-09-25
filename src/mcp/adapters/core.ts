// ---------------------------------------------------------------------------
// mcp_core_adapter — sdd_mcp's client hop into sdd_core.
//
// Identity re-exports of the core portals under their contract names. The MCP
// server imports this module, so every call it makes into core lands here and
// resolves to the portal's function. Each reads the request-scoped project
// root at CALL time, so a static binding stays correct per bound project.
// ---------------------------------------------------------------------------
export {
  loadSystemSpec,
  loadSubsystemSpec,
  loadSubsystemSpecs,
  loadComponentSpec,
  loadComponentSpecs,
  loadInterfaceSpec,
  loadImplementationSpec,
  loadTypeSpec,
  resolveChainingParent,
  moveSubsystemProject,
  externalizeSubsystem,
  internalizeSubsystem,
  renameComponent,
  renameMethod,
  loadProjectConfig,
  getStatusReport,
  approvalVerdict,
  composeAgentBrief,
  resolveAgentTopology,
  loadRegistry,
  resolveDomains,
  loadProjectVariants,
  resolveVariantGuidance,
} from '../../core/index.js';
