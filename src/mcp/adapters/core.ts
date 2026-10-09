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
  createMember,
  moveMember,
  listDirectChainedSubprojects,
  renameComponent,
  renameSpecId,
  renameMethod,
  renameType,
  renameField,
  renameParam,
  loadProjectConfig,
  setNetwork,
  getStatusReport,
  approvalVerdict,
  composeAgentBrief,
  resolveAgentTopology,
  loadRegistry,
  resolveDomains,
  loadProjectVariants,
  resolveVariantGuidance,
  reinjectLocalGuides,
  registerProjectServer,
  // The tree's write lock around every spec-write tool, and an external's pinned spec read.
  lockTree,
  unlockTree,
  readPinnedSpec,
} from '../../core/index.js';
