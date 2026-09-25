import { validateAsComplete as validateTreeAsComplete, type ValidationResult } from '../../core/validation.js';
import { ProjectNotInitializedError } from '../../utils/errors.js';
import { loadProjectConfig } from './core.js';

// ---------------------------------------------------------------------------
// host_validator_adapter — sdd_host's client hop into sdd_validator.
//
// Identity re-exports of the validator portal, and the one forward that is
// more than a name: the as-complete gate runs under the bound project's own
// rule severities and projectType, read through the host core adapter.
// ---------------------------------------------------------------------------
export { computeGateStateId, builtinProfileIds, builtinProjectKinds } from '../../core/validation.js';

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
