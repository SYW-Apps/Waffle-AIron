import inquirer from 'inquirer';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, loadProjectConfig } from '../config/loader.js';
import { findAgent, addAgent, updateAgent } from '../core/registry.js';
import { createAgentRecord } from '../models/agent.js';
import { WaironError } from '../utils/errors.js';
import { appendTopologyHistory } from './topology-history.js';
import { runGenerate } from './generate.js';

// ---------------------------------------------------------------------------
// split command
//
// Guided flow for splitting one agent into two or more focused agents.
// The original agent is deprecated; the new agents take over its paths.
// ---------------------------------------------------------------------------

export async function runSplit(agentId: string): Promise<void> {
  assertProjectInitialized();

  const projectConfig = loadProjectConfig();
  const agent = findAgent(agentId);
  if (!agent) throw new WaironError(`Agent "${agentId}" not found in registry.`);

  logger.header(`Split: ${agent.name}`);
  logger.blank();
  logger.info(`Current agent: ${chalk.bold(agent.id)}`);
  logger.info(`Description:   ${agent.description}`);

  if (agent.ownedPaths.length > 0) {
    logger.info(`Owned paths:`);
    for (const p of agent.ownedPaths) console.log(`  ${chalk.cyan(p)}`);
  }
  logger.blank();

  const { count } = await inquirer.prompt<{ count: number }>([{
    type: 'list',
    name: 'count',
    message: 'Split into how many agents?',
    choices: [
      { name: '2', value: 2 },
      { name: '3', value: 3 },
    ],
    default: 2,
  }]);

  const activeTargets = projectConfig.targets
    .filter((t) => !('enabled' in t) || t.enabled)
    .map((t) => (typeof t === 'string' ? t : t.type)) as Array<'claude' | 'gemini'>;

  const newAgents: ReturnType<typeof createAgentRecord>[] = [];

  for (let i = 1; i <= count; i++) {
    logger.blank();
    console.log(chalk.bold(`— New agent ${i} of ${count} —`));

    const defaults = {
      id: `${agentId}-${i === 1 ? 'primary' : 'secondary'}`,
      name: `${agent.name} ${i === 1 ? 'Primary' : 'Secondary'}`,
    };

    const answers = await inquirer.prompt<{
      id: string;
      name: string;
      description: string;
      ownedPaths: string;
    }>([
      {
        type: 'input',
        name: 'id',
        message: 'Agent ID:',
        default: defaults.id,
        validate: (val: string) => {
          if (!/^[a-z0-9-]+$/.test(val)) return 'Must be lowercase alphanumeric with dashes';
          if (val === agentId) return 'Cannot reuse the original agent ID';
          if (findAgent(val)) return `Agent "${val}" already exists`;
          if (newAgents.some((a) => a.id === val)) return 'Duplicate ID in this split';
          return true;
        },
      },
      {
        type: 'input',
        name: 'name',
        message: 'Display name:',
        default: defaults.name,
      },
      {
        type: 'input',
        name: 'description',
        message: 'Description:',
        validate: (val: string) => val.trim().length > 0 || 'Required',
      },
      {
        type: 'input',
        name: 'ownedPaths',
        message: `Owned paths from "${agentId}" assigned to this agent (comma-separated):`,
        default: agent.ownedPaths.join(', '),
      },
    ]);

    const ownedPaths = answers.ownedPaths
      .split(',').map((p) => p.trim()).filter(Boolean);

    newAgents.push(createAgentRecord({
      id: answers.id,
      name: answers.name,
      description: answers.description,
      creationReason: `Split from "${agentId}" by wairon split.`,
      template: agent.template,
      ownedPaths,
      tags: [...agent.tags],
      targets: activeTargets,
    }));
  }

  // Summary
  logger.blank();
  logger.info('Summary:');
  logger.info(`  ${chalk.gray('→')} Deprecate: ${chalk.bold(agentId)}`);
  for (const a of newAgents) {
    logger.info(`  ${chalk.green('+')} Create:    ${chalk.bold(a.id)}  (${a.ownedPaths.join(', ') || 'no paths'})`);
  }
  logger.blank();

  const { confirm } = await inquirer.prompt<{ confirm: boolean }>([{
    type: 'confirm',
    name: 'confirm',
    message: 'Apply this split?',
    default: true,
  }]);

  if (!confirm) { logger.info('Cancelled.'); return; }

  // Apply: add new agents, deprecate original
  for (const a of newAgents) addAgent(a);

  agent.status = 'deprecated';
  updateAgent(agent);

  // Log to history
  appendTopologyHistory({
    action: 'split',
    description: `Split "${agentId}" into: ${newAgents.map((a) => a.id).join(', ')}`,
    agentIds: [agentId, ...newAgents.map((a) => a.id)],
  });

  logger.blank();
  for (const a of newAgents) logger.success(`Created: ${a.id}`);
  logger.success(`Deprecated: ${agentId}`);

  const { generate } = await inquirer.prompt<{ generate: boolean }>([{
    type: 'confirm',
    name: 'generate',
    message: 'Generate agent files now?',
    default: true,
  }]);

  if (generate) { logger.blank(); await runGenerate(); }
}
