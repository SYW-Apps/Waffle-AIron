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
// merge command
//
// Guided flow for merging two agents into one.
// Both originals are deprecated; the merged agent takes over their paths.
// ---------------------------------------------------------------------------

export async function runMerge(idA: string, idB: string): Promise<void> {
  assertProjectInitialized();

  const projectConfig = loadProjectConfig();
  const agentA = findAgent(idA);
  const agentB = findAgent(idB);

  if (!agentA) throw new WaironError(`Agent "${idA}" not found.`);
  if (!agentB) throw new WaironError(`Agent "${idB}" not found.`);

  logger.header(`Merge: ${agentA.name} + ${agentB.name}`);
  logger.blank();

  const printAgent = (a: typeof agentA) => {
    console.log(`  ${chalk.bold(a.id)}`);
    console.log(`    ${a.description}`);
    if (a.ownedPaths.length > 0) {
      console.log(`    ${chalk.gray('owns: ' + a.ownedPaths.join(', '))}`);
    }
  };

  printAgent(agentA);
  console.log();
  printAgent(agentB);
  logger.blank();

  // Compute merged defaults
  const mergedPaths = [
    ...agentA.ownedPaths,
    ...agentB.ownedPaths.filter((p) => !agentA.ownedPaths.includes(p)),
  ];
  const mergedTags = [
    ...agentA.tags,
    ...agentB.tags.filter((t) => !agentA.tags.includes(t)),
  ];
  const defaultId = `${idA}-merged`;

  const activeTargets = projectConfig.targets
    .filter((t) => !('enabled' in t) || t.enabled)
    .map((t) => (typeof t === 'string' ? t : t.type)) as Array<'claude' | 'gemini'>;

  const answers = await inquirer.prompt<{
    id: string;
    name: string;
    description: string;
    creationReason: string;
    ownedPaths: string;
  }>([
    {
      type: 'input',
      name: 'id',
      message: 'Merged agent ID:',
      default: defaultId,
      validate: (val: string) => {
        if (!/^[a-z0-9-]+$/.test(val)) return 'Must be lowercase alphanumeric with dashes';
        if (val === idA || val === idB) return 'Cannot reuse an original agent ID';
        if (findAgent(val)) return `Agent "${val}" already exists`;
        return true;
      },
    },
    {
      type: 'input',
      name: 'name',
      message: 'Display name:',
      default: `${agentA.name} / ${agentB.name}`,
    },
    {
      type: 'input',
      name: 'description',
      message: 'Description:',
      default: agentA.description,
      validate: (val: string) => val.trim().length > 0 || 'Required',
    },
    {
      type: 'input',
      name: 'creationReason',
      message: 'Reason for merging:',
      default: `Merged from "${idA}" and "${idB}".`,
    },
    {
      type: 'input',
      name: 'ownedPaths',
      message: 'Combined owned paths (comma-separated):',
      default: mergedPaths.join(', '),
    },
  ]);

  const ownedPaths = answers.ownedPaths
    .split(',').map((p) => p.trim()).filter(Boolean);

  const merged = createAgentRecord({
    id: answers.id,
    name: answers.name,
    description: answers.description,
    creationReason: answers.creationReason,
    template: agentA.template,
    ownedPaths,
    tags: mergedTags,
    targets: activeTargets,
  });

  // Summary
  logger.blank();
  logger.info('Summary:');
  logger.info(`  ${chalk.gray('→')} Deprecate: ${chalk.bold(idA)}`);
  logger.info(`  ${chalk.gray('→')} Deprecate: ${chalk.bold(idB)}`);
  logger.info(`  ${chalk.green('+')} Create:    ${chalk.bold(merged.id)}  (${ownedPaths.join(', ') || 'no paths'})`);
  logger.blank();

  const { confirm } = await inquirer.prompt<{ confirm: boolean }>([{
    type: 'confirm',
    name: 'confirm',
    message: 'Apply this merge?',
    default: true,
  }]);

  if (!confirm) { logger.info('Cancelled.'); return; }

  // Apply: create merged, deprecate originals
  addAgent(merged);
  agentA.status = 'deprecated';
  agentB.status = 'deprecated';
  updateAgent(agentA);
  updateAgent(agentB);

  // Log to history
  appendTopologyHistory({
    action: 'merge',
    description: `Merged "${idA}" and "${idB}" into "${merged.id}"`,
    agentIds: [idA, idB, merged.id],
  });

  logger.blank();
  logger.success(`Created: ${merged.id}`);
  logger.success(`Deprecated: ${idA}`);
  logger.success(`Deprecated: ${idB}`);

  const { generate } = await inquirer.prompt<{ generate: boolean }>([{
    type: 'confirm',
    name: 'generate',
    message: 'Generate agent files now?',
    default: true,
  }]);

  if (generate) { logger.blank(); await runGenerate(); }
}
