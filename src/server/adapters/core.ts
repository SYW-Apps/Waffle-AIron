// ---------------------------------------------------------------------------
// host_core_adapter — sdd_host's client hop into sdd_core.
//
// Identity re-exports of the core portals under the adapter's contract names,
// scoped to whatever project root the caller has bound (runWithProjectRoot).
// The hosting control and data planes reuse sdd_core through this module and
// nothing else: none of them imports a core module.
// ---------------------------------------------------------------------------
import { buildCanvasDataModel as buildCoreCanvasDataModel, loadSystemSpec } from '../../core/index.js';
import type { CanvasModel } from '../../core/canvas.js';
import type { ProjectRelations } from '../../models/index.js';

export {
  provisionProject,
  // The spec-tree CONTENT hash (surface/landscape snapshot stamps). The gate
  // identity a lock records is the validator's: see ./validator.js.
  computeStateId,
  // The shared lock verdict (unlocked | locked | stale), resolved against the
  // gate identity the caller computed now.
  readLockState,
  writeLockRecord,
  // The approval: the per-spec digests a lock RECORDS.
  captureApprovedSpecs,
  renderDiagram,
  // L0/L1 reads the landscape plane projects a redacted public surface from.
  loadSystemSpec,
  loadSubsystemSpecs,
  // The resolved export table and the contracts it names, for the landscape's
  // redacted public-surface snapshot.
  resolveProjectExports,
  loadInterfaceSpecs,
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
  describeProject,
  recordProfileSelection,
  // Extension packs, for the hosted pack store and the policy plane.
  globalPacksDir,
  discoverPacks,
  loadExtensionPacks,
  checkDeclarativePack,
  parseDeclarativePack,
  packEntryRef,
  packEntryLabel,
  // A member's path resolved within the root that declares it — the hosted
  // member-resolution seam. The adapter names it for what it answers.
  assertContainedProjectPath as resolveContainedProjectPath,
} from '../../core/index.js';

/**
 * ihost_core_adapter.buildCanvasDataModel — the bound project's canvas model, PARTIAL-TOLERANT: the core
 * build draws whatever loaded and carries each part that failed as a finding; a tree whose build fails
 * outright answers an EMPTY model holding that one error finding with the cause, never a thrown error —
 * a failed build is not an HTTP error in place of a graph. Used by the web app's canvas and share snapshots.
 */
export function buildCanvasDataModel(relations?: ProjectRelations[]): CanvasModel {
  let cause: string;
  try {
    const model = buildCoreCanvasDataModel(relations);
    // A tree that yields nothing at all (no system spec, nothing drawn, nothing found) says so rather than draw an empty page.
    if (model.subsystems.length > 0 || model.components.length > 0 || model.issues.length > 0 || loadSystemSpec() !== null) return model;
    cause = 'the project holds no system spec (.wai/specs/system.yaml)';
  } catch (e) {
    cause = e instanceof Error ? e.message : String(e);
  }
  return {
    system: { name: 'project' },
    generatedAt: new Date().toISOString(),
    subsystems: [],
    components: [],
    edges: [],
    types: [],
    typeEdges: [],
    dataEdges: [],
    issues: [{ severity: 'error', code: 'SPEC_TREE_UNREADABLE', message: `The spec tree could not be loaded: ${cause}` }],
  };
}
