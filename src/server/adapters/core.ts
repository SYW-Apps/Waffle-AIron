// ---------------------------------------------------------------------------
// host_core_adapter — sdd_host's client hop into sdd_core.
//
// Identity re-exports of the core portals under the adapter's contract names,
// scoped to whatever project root the caller has bound (runWithProjectRoot).
// The hosting control and data planes reuse sdd_core through this module and
// nothing else: none of them imports a core module.
// ---------------------------------------------------------------------------
export {
  provisionProject,
  // The spec-tree CONTENT hash (surface/landscape snapshot stamps). The gate
  // identity a lock records is the validator's: see ./validator.js.
  computeStateId,
  // The shared lock verdict (unlocked | locked | stale), resolved against the
  // gate identity the caller computed now.
  readLockState,
  readLockRecord,
  writeLockRecord,
  // The approval: the per-spec digests a lock RECORDS.
  captureApprovedSpecs,
  currentChildPins,
  renderDiagram,
  // The full CanvasModel as data — the web app's canvas and share snapshots.
  buildCanvasDataModel,
  // L0/L1 reads the landscape plane projects a redacted public surface from.
  loadSystemSpec,
  loadSubsystemSpecs,
  // Level-of-detail project-tier graph for the web UI.
  buildProjectGraph,
  // Whole-spec-tree transfer (.waitree).
  exportSpecTree,
  importSpecTree,
  // The bound project's configuration: loadProjectConfig is null when the
  // project has none; every write refuses a project without one.
  loadProjectConfig,
  registerPackRef,
  deregisterPackRef,
  removePackSelection,
  setProjectType,
  recordProfileSelection,
  // Extension packs, for the hosted pack store and the policy plane.
  globalPacksDir,
  discoverPacks,
  loadExtensionPacks,
  checkDeclarativePack,
  packEntryRef,
  packEntryLabel,
  // A mount's projectPath resolved within its root — the hosted
  // mount-resolution seam.
  assertContainedProjectPath,
} from '../../core/index.js';
