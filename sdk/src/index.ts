import * as orchestrator from './orchestrator.js';
import type {
  PackArchiveInfo,
  PackBuildResult,
  PackExtractionLimits,
  PackExtractionResult,
  PackScaffoldRequest,
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

// Re-export the pure pack-archive value objects...
export * from './types.js';
// ...and the rule-authoring contract (SddRule + stable RuleContext/Finding facade + defineRule).
export * from './authoring.js';
