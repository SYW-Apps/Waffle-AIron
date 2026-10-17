import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized } from '../config/paths.js';
import { AgentRecord } from '../models/agent.js';
import { resolveAgentTopology } from './adapters/core.js';

// ---------------------------------------------------------------------------
// list command
//
// Lists the agent topology resolved from the spec tree through the core adapter.
// ---------------------------------------------------------------------------

export async function runList(): Promise<void> {
  assertProjectInitialized();

  // Empty when the project has no system spec yet.
  const agents = resolveAgentTopology();

  if (agents.length === 0) {
    logger.info('No agents resolved from the spec tree.');
    logger.info('Define subsystems and components first — see `wairon status`.');
    return;
  }

  logger.header(`Agents (${agents.length})`);
  logger.blank();

  for (const agent of agents) {
    printAgent(agent);
  }
}

function printAgent(agent: AgentRecord): void {
  const status =
    agent.status === 'active'
      ? chalk.green(agent.status)
      : agent.status === 'draft'
        ? chalk.yellow(agent.status)
        : chalk.gray(agent.status);

  console.log(`${chalk.bold(agent.id)} ${chalk.gray(`[${agent.template}]`)} ${status}`);
  console.log(`  ${agent.description}`);

  if (agent.ownedPaths.length > 0) {
    console.log(chalk.gray(`  owns: ${agent.ownedPaths.join(', ')}`));
  }

  if (agent.tags.length > 0) {
    console.log(chalk.gray(`  tags: ${agent.tags.join(', ')}`));
  }

  const targetLabels = agent.targets.map((t) => {
    if (typeof t === 'string') return t;
    const obj = t as { type: string; label?: string };
    return obj.label ? `${obj.type}(${obj.label})` : obj.type;
  });
  console.log(chalk.gray(`  targets: ${targetLabels.join(', ')}`));
  console.log();
}
