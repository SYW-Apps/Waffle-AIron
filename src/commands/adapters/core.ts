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
  createMember,
  moveMember,
  // `wairon member update` (stage 8): a git member's pinned commit moved.
  advanceMember,
  composeAgentBrief,
  exportSpecTree,
  importSpecTree,
  // `wairon host demo` (spec_maintenance_portal seedDemoTree).
  seedDemoTree,
  loadProjectConfig,
  createProjectConfig,
  setExecutionTier,
  setNetwork,
  projectConfigExists,
  resolveAgentTopology,
  ensureProjectInitialized,
  listDirectChainedSubprojects,
  defaultPackSelections,
  readLockState,
  retireSpecialists,
  // `wairon type rename-field` (spec_maintenance_portal renameField).
  renameField,
  // `wairon method rename-param` (spec_maintenance_portal renameParam).
  renameParam,
  // `wairon method rename` (spec_maintenance_portal renameMethod).
  renameMethod,
  repairForeignStepFields,
  repairSignatures,
  repairTypeSpellings,
  migrateReachability,
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
  // The upgrade report's reads (the chaining migration and its writes moved to
  // sdd_migrations in stage 6, behind migration_core_adapter).
  resolveChainingParent,
  projectFamily,
  resolveProjectExports,
  loadTypeSpecs,
} from '../../core/index.js';
