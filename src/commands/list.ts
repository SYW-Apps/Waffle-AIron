import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, loadRegistry } from '../config/loader.js';
import { AgentRecord } from '../models/agent.js';

// ---------------------------------------------------------------------------
// list command
//
// Lists all agents currently in the registry.
// ---------------------------------------------------------------------------

export async function runList(): Promise<void> {
  assertProjectInitialized();

  const registry = loadRegistry();

  if (registry.agents.length === 0) {
    logger.info('No agents in registry.');
    logger.info('Run `waffagent create-agent` to add one.');
    return;
  }

  logger.header(`Agents (${registry.agents.length})`);
  logger.blank();

  for (const agent of registry.agents) {
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
