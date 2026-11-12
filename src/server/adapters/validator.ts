import {
  validateAsComplete as validateTreeAsComplete,
  validateAsCompleteAsync as validateTreeAsCompleteAsync,
  warm as warmTree,
  stopBackground as stopTreeBackground,
  measurePackImpact as measureTreePackImpact,
  measurePackDoctrine as measureTreePackDoctrine,
  type ValidationResult,
} from '../../core/validation.js';
import type { ExtensionPack } from '../../core/extensions.js';
import type { PackCandidate, PackDoctrine, PackImpact } from '../../models/pack-impact.js';
import { ProjectNotInitializedError } from '../../utils/errors.js';
import { loadProjectConfig } from './core.js';
import { runWithProjectRoot } from '../../utils/fs.js';

// ---------------------------------------------------------------------------
// host_validator_adapter — sdd_host's client hop into sdd_validator.
//
// Identity re-exports of the validator portal, and the one forward that is
// more than a name: the as-complete gate runs under the bound project's own
// rule severities and projectType, read through the host core adapter.
// ---------------------------------------------------------------------------
export { computeGateStateId, builtinProfileIds, builtinProjectKinds } from '../../core/validation.js';
// host_validator_adapter.familyApprovals — the bound tree's pin tree (its own
// approval state and each member's, each at the member's own root). The hosted
// lock asks with depth 1 for the direct members it records; the caller has
// already bound a root it is entitled to reach.
export { familyApprovals } from '../../core/validation.js';
// host_validator_adapter.familyRelations — the bound family's relation health
// for the web canvas and share snapshots. The caller has already bound a root it
// is entitled to reach and granted the request's reach (the caller's listed
// projects), so a producer or member outside it is answered unavailable.
export { familyRelations } from '../../core/validation.js';

/**
 * host_validator_adapter.validateAsComplete — the as-complete gate for the
 * bound project, judged by its own configuration. A root with no
 * configuration is not an initialized project, and is refused.
 */
export function validateAsComplete(): ValidationResult {
  const config = loadProjectConfig();
  if (!config) throw new ProjectNotInitializedError();
  return validateTreeAsComplete({ rules: config.rules, projectType: config.projectType });
}

/**
 * host_validator_adapter.validateAsCompleteAsync — the as-complete gate for the
 * bound project, run off the serving thread so other requests keep being
 * answered while a cold run takes its time.
 */
export async function validateAsCompleteAsync(): Promise<ValidationResult> {
  const config = loadProjectConfig();
  if (!config) throw new ProjectNotInitializedError();
  return validateTreeAsCompleteAsync({ rules: config.rules, projectType: config.projectType });
}

/**
 * host_validator_adapter.warm — bind the root and start both gates in the
 * background, so the first page that needs them finds them remembered.
 */
export function warm(root: string): void {
  runWithProjectRoot(root, () => {
    // Step 2: the options the page reads the gates with, so its first read is remembered.
    let config: ReturnType<typeof loadProjectConfig> = null;
    try {
      config = loadProjectConfig();
    } catch {
      config = null;
    }
    // Step 3.
    warmTree(config ? { rules: config.rules, projectType: config.projectType } : undefined);
  });
}

/** host_validator_adapter.stopBackground — stop the background validation thread. */
export function stopBackground(): Promise<void> {
  return stopTreeBackground();
}

/**
 * host_validator_adapter.measurePackImpact — what one pack write would change
 * on the hosted project whose root the caller bound, writing nothing.
 * Forwarded to the validator portal.
 */
export function measurePackImpact(candidate: PackCandidate): PackImpact {
  return measureTreePackImpact(candidate);
}

/**
 * host_validator_adapter.measurePackDoctrine — one pack's changes against
 * wairon's defaults, with no project. Forwarded to the validator portal.
 */
export function measurePackDoctrine(manifest: ExtensionPack): PackDoctrine {
  return measureTreePackDoctrine(manifest);
}
