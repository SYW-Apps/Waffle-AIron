// ---------------------------------------------------------------------------
// cli_core_adapter — sdd_cli's client hop into sdd_core.
//
// Identity re-exports of the core portals under the adapter's contract names.
// The commands import THIS module, so every call they make into core lands
// here and resolves to the portal's function — not to a forwarding wrapper in
// a command file, which is what this used to be (src/commands/subsystem.ts).
// ---------------------------------------------------------------------------
export {
  loadSystemSpec,
  loadSubsystemSpec,
  moveSubsystemProject,
  externalizeSubsystem,
  internalizeSubsystem,
  composeAgentBrief,
  exportSpecTree,
  importSpecTree,
  loadProjectConfig,
  createProjectConfig,
  setExecutionTier,
  projectConfigExists,
  resolveAgentTopology,
  ensureProjectInitialized,
  listDirectChainedSubprojects,
  defaultPackSelections,
  readLockState,
  retireSpecialists,
  repairForeignStepFields,
  renderDiagram,
  generateAll,
  resolveExpectedOutputPaths,
  resolveDomains,
  addDomain,
  removeDomain,
  detectDomainCandidates,
  deriveExecutionProfile,
  resolveBudget,
  globalGuideFilePath,
  localGuideFilePath,
  injectGuide,
  writeRootGuideDelegator,
  reinjectLocalGuides,
  readStampVersion,
  syncContextFiles,
  hasContext,
  derivedDocPaths,
  getStatusReport,
  approvalVerdict,
  findLegacySpecFiles,
  findChainingSubprojectsMissingConfig,
  backfillChainedSubprojectConfigs,
  diagnoseProjectPacks,
  pinInstalledPacksAsSelections,
} from '../../core/index.js';
