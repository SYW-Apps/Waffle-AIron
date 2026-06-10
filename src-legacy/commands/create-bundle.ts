import inquirer from 'inquirer';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, loadProjectConfig, loadRegistry } from '../config/loader.js';
import { addAgent } from '../core/registry.js';
import { listBundleIds, loadBundle } from '../core/bundles.js';
import { createAgentRecord } from '../models/agent.js';
import { WaironError } from '../utils/errors.js';
import { runGenerate } from './generate.js';

// ---------------------------------------------------------------------------
// create-bundle command
//
// Scaffolds multiple agents from a bundle definition for a given scope.
// ---------------------------------------------------------------------------

export interface CreateBundleOptions {
  bundle?: string;
  scope?: string;
  dir?: string;
  dryRun?: boolean;
}

export async function runCreateBundle(options: CreateBundleOptions = {}): Promise<void> {
  assertProjectInitialized();

  const projectConfig = loadProjectConfig();
  const bundleIds = listBundleIds();

  if (bundleIds.length === 0) {
    throw new WaironError('No bundles found. Check your .wai/bundles/ directory or the built-in bundles.');
  }

  const activeTargets = projectConfig.targets
    .filter((t) => !('enabled' in t) || t.enabled)
    .map((t) => (typeof t === 'string' ? t : t.type));

  logger.header('Create Bundle');
  logger.blank();

  if (options.dryRun) {
    logger.info('Dry run — no agents will be written to the registry.');
    logger.blank();
  }

  // Prompt for any missing required values
  const answers = await inquirer.prompt<{
    bundleId: string;
    scope: string;
    dir: string;
    targets: string[];
    confirm: boolean;
  }>([
    {
      type: 'list',
      name: 'bundleId',
      message: 'Bundle:',
      choices: bundleIds.map((id) => {
        try {
          const b = loadBundle(id);
          return {
            name: `${chalk.bold(id)}  — ${b.description.split('\n')[0].trim()}`,
            value: id,
          };
        } catch {
          return { name: id, value: id };
        }
      }),
      when: !options.bundle,
      default: options.bundle,
    },
    {
      type: 'input',
      name: 'scope',
      message: 'Scope name (becomes agent id prefix, e.g. "core-service"):',
      default: options.scope,
      when: !options.scope,
      validate: (val: string) => {
        if (!/^[a-z0-9-]+$/.test(val)) return 'Scope must be lowercase alphanumeric with dashes';
        return true;
      },
    },
    {
      type: 'input',
      name: 'dir',
      message: 'Scope directory (relative to project root, e.g. "services/core"):',
      default: (ans: { scope: string }) => options.dir ?? ans.scope,
      when: !options.dir,
    },
    {
      type: 'checkbox',
      name: 'targets',
      message: 'Output targets:',
      choices: activeTargets.map((t) => ({ name: t, value: t, checked: true })),
      validate: (val: string[]) => val.length > 0 || 'Select at least one target',
    },
  ]);

  const bundleId = options.bundle ?? answers.bundleId;
  const scope = options.scope ?? answers.scope;
  const scopeDir = options.dir ?? answers.dir;
  const targets = answers.targets as Array<'claude' | 'gemini'>;

  const bundle = loadBundle(bundleId);

  // Expand bundle spec into agent records
  const agents = bundle.agents.map((spec) => {
    const agentId = `${scope}-${spec.idSuffix}`;
    const name = spec.namePattern.replace(/\{\{scope\}\}/g, scope);
    const description = spec.descriptionPattern.replace(/\{\{scope\}\}/g, scope);
    const ownedPaths = spec.ownedPathPatterns.map((p) =>
      p.replace(/\{\{scopeDir\}\}/g, scopeDir),
    );
    const tags = [...spec.tags];

    return createAgentRecord({
      id: agentId,
      name,
      description,
      creationReason: `Scaffolded by wairon create-bundle (bundle: ${bundleId}, scope: ${scope}).`,
      template: spec.template,
      ownedPaths,
      tags,
      targets,
      bundleOrigin: bundleId,
    });
  });

  // Check for conflicts
  const registry = loadRegistry();
  const conflicts = agents.filter((a) => registry.agents.some((r) => r.id === a.id));
  if (conflicts.length > 0) {
    throw new WaironError(
      `The following agent IDs already exist: ${conflicts.map((a) => a.id).join(', ')}\n` +
      `Choose a different scope name or remove the existing agents first.`,
    );
  }

  // Preview
  logger.blank();
  logger.info(`Bundle: ${chalk.bold(bundle.name)}`);
  logger.info(`Scope:  ${chalk.bold(scope)}  (dir: ${scopeDir})`);
  logger.blank();
  logger.info(`Agents to create (${agents.length}):`);
  logger.blank();

  for (const agent of agents) {
    console.log(`  ${chalk.bold(agent.id)}`);
    console.log(`    ${agent.description}`);
    if (agent.ownedPaths.length > 0) {
      console.log(chalk.gray(`    owns: ${agent.ownedPaths.slice(0, 2).join(', ')}${agent.ownedPaths.length > 2 ? ` +${agent.ownedPaths.length - 2} more` : ''}`));
    }
    console.log();
  }

  if (options.dryRun) {
    logger.info('Dry run complete — no changes made.');
    return;
  }

  const { confirm } = await inquirer.prompt<{ confirm: boolean }>([{
    type: 'confirm',
    name: 'confirm',
    message: `Create ${agents.length} agents in the registry?`,
    default: true,
  }]);

  if (!confirm) {
    logger.info('Cancelled.');
    return;
  }

  for (const agent of agents) {
    addAgent(agent);
    logger.success(`Added: ${agent.id}`);
  }

  const { generate } = await inquirer.prompt<{ generate: boolean }>([{
    type: 'confirm',
    name: 'generate',
    message: 'Generate agent files now?',
    default: true,
  }]);

  if (generate) {
    logger.blank();
    await runGenerate();
  }
}
