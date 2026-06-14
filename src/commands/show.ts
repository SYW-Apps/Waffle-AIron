import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, loadRegistry } from '../config/loader.js';
import { WaironError } from '../utils/errors.js';
import { AgentRecord } from '../models/agent.js';

// ---------------------------------------------------------------------------
// show command
//
// Displays full details of a single agent from the registry.
// ---------------------------------------------------------------------------

export async function runShow(agentId: string): Promise<void> {
  assertProjectInitialized();

  const registry = loadRegistry();
  const agent = registry.agents.find((a) => a.id === agentId);

  if (!agent) {
    throw new WaironError(`Agent "${agentId}" not found in the resolved spec topology.`);
  }

  printAgentDetails(agent);
}

function printAgentDetails(agent: AgentRecord): void {
  const statusColor =
    agent.status === 'active'
      ? chalk.green
      : agent.status === 'draft'
        ? chalk.yellow
        : chalk.gray;

  logger.header(agent.name);
  console.log();

  console.log(`${chalk.bold('ID')}          ${agent.id}`);
  console.log(`${chalk.bold('Status')}      ${statusColor(agent.status)}`);
  console.log(`${chalk.bold('Template')}    ${agent.template}`);
  if (agent.bundleOrigin) {
    console.log(`${chalk.bold('Bundle')}      ${agent.bundleOrigin}`);
  }
  if (agent.domainRoot) {
    console.log(`${chalk.bold('Domain')}      ${agent.domainRoot}`);
  }
  console.log();

  console.log(`${chalk.bold('Description')}`);
  console.log(`  ${agent.description}`);
  console.log();

  console.log(`${chalk.bold('Reason')}`);
  console.log(`  ${agent.creationReason}`);
  console.log();

  if (agent.ownedPaths.length > 0) {
    console.log(`${chalk.bold('Owned paths')}`);
    for (const p of agent.ownedPaths) {
      console.log(`  ${chalk.cyan(p)}`);
    }
    console.log();
  }

  if (agent.readPaths.length > 0) {
    console.log(`${chalk.bold('Read paths')}`);
    for (const p of agent.readPaths) {
      console.log(`  ${chalk.gray(p)}`);
    }
    console.log();
  }

  if (agent.writePaths.length > 0) {
    console.log(`${chalk.bold('Write paths')}`);
    for (const p of agent.writePaths) {
      console.log(`  ${chalk.gray(p)}`);
    }
    console.log();
  }

  if (agent.tags.length > 0) {
    console.log(`${chalk.bold('Tags')}        ${agent.tags.map((t) => chalk.magenta(t)).join(', ')}`);
  }

  if (agent.dependencies.length > 0) {
    console.log(`${chalk.bold('Depends on')}  ${agent.dependencies.join(', ')}`);
  }

  const targetLabels = agent.targets.map((t) => {
    if (typeof t === 'string') return t;
    const obj = t as { type: string; label?: string };
    return obj.label ? `${obj.type}(${obj.label})` : obj.type;
  });
  console.log(`${chalk.bold('Targets')}     ${targetLabels.join(', ')}`);
  console.log();

  console.log(chalk.gray(`Created: ${agent.createdAt}  Updated: ${agent.updatedAt}`));
}
