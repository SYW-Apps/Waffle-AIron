import { logger } from '../utils/logger.js';
import { assertProjectInitialized } from '../config/loader.js';
import { findAgent, updateAgent } from '../core/registry.js';
import { WaironError } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// deprecate command
//
// Marks an agent as deprecated without removing it from the registry.
// Deprecated agents remain visible in `wairon list` and `wairon show` but
// are flagged clearly and will be surfaced by `wairon analyze`.
// ---------------------------------------------------------------------------

export async function runDeprecate(agentId: string): Promise<void> {
  assertProjectInitialized();

  const agent = findAgent(agentId);
  if (!agent) {
    throw new WaironError(`Agent "${agentId}" not found in registry.`);
  }

  if (agent.status === 'deprecated') {
    logger.info(`Agent "${agentId}" is already deprecated.`);
    return;
  }

  agent.status = 'deprecated';
  updateAgent(agent);

  logger.success(`Agent "${agentId}" marked as deprecated.`);
  logger.info('It remains in the registry but is flagged. Run `wairon analyze` to review deprecated agents.');
  logger.info('To remove it entirely: edit .wai/registry/agents.json directly.');
}
