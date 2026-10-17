import * as orchestrator from './orchestrator.js';
import type {
  PackArchiveInfo,
  PackBuildResult,
  PackExtractionLimits,
  PackExtractionResult,
  PackScaffoldRequest,
  TreeArchiveInfo,
  TreeBuildResult,
  TreeExtractionResult,
  TreeRootSource,
} from './types.js';

// ---------------------------------------------------------------------------
// SDK Portal (sdk_portal_impl) — the @wairon/sdk package entry. Each capability
// is a 1:1 forward to the SDK orchestrator with no logic of its own; the module
// also re-exports the pure pack-authoring value objects and the rule-authoring
// contract (compile-time types + the defineRule helper).
// ---------------------------------------------------------------------------

/** Scaffold a new pack project (declarative or code) into a directory; returns the created file paths. */
export function scaffoldPack(request: PackScaffoldRequest): string[] {
  // Step 1: forward to the SDK orchestrator.
  return orchestrator.scaffoldPack(request);
}

/** Build an installable .wpack archive from a pack directory. */
export function buildPack(sourceDir: string): PackBuildResult {
  // Step 1: forward to the SDK orchestrator.
  return orchestrator.buildPack(sourceDir);
}

/** Inspect + verify a .wpack archive without extracting it. */
export function inspectArchive(archive: Uint8Array): PackArchiveInfo {
  // Step 1: forward to the SDK orchestrator.
  return orchestrator.inspectArchive(archive);
}

/** Safely extract a .wpack archive into a destination directory under enforced limits. */
export function extractPack(
  archive: Uint8Array,
  destDir: string,
  limits?: PackExtractionLimits,
): PackExtractionResult {
  // Step 1: forward to the SDK orchestrator.
  return orchestrator.extractPack(archive, destDir, limits);
}

/** Pack a project's spec tree — the supplied roots' .wai directories — into a .waitree archive. */
export function buildTreeArchive(
  roots: TreeRootSource[],
  projectName: string,
  stateId?: string,
  includeDerived?: boolean,
): TreeBuildResult {
  // Step 1: forward to the SDK orchestrator.
  return orchestrator.buildTreeArchive(roots, projectName, stateId, includeDerived);
}

/** Inspect a .waitree archive without extracting it. */
export function inspectTreeArchive(archive: Uint8Array): TreeArchiveInfo {
  // Step 1: forward to the SDK orchestrator.
  return orchestrator.inspectTreeArchive(archive);
}

/** Safely extract a .waitree archive into a destination project root under enforced limits. */
export function extractTreeArchive(
  archive: Uint8Array,
  destDir: string,
  limits?: PackExtractionLimits,
  refuseExecutableEntries?: boolean,
): TreeExtractionResult {
  // Step 1: forward to the SDK orchestrator.
  return orchestrator.extractTreeArchive(archive, destDir, limits, refuseExecutableEntries);
}

// Re-export the pure pack-archive value objects...
export * from './types.js';
// ...and the rule-authoring contract (SddRule + stable RuleContext/Finding facade + defineRule).
export * from './authoring.js';
