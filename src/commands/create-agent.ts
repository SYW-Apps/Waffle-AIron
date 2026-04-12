import inquirer from 'inquirer';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, loadProjectConfig, loadRegistry } from '../config/loader.js';
import { addAgent } from '../core/registry.js';
import { listTemplateIds, loadTemplate } from '../core/templates.js';
import { createAgentRecord } from '../models/agent.js';
import { WaironError } from '../utils/errors.js';
import { runGenerate } from './generate.js';

// ---------------------------------------------------------------------------
// create-agent command
//
// Interactive guided flow for adding a new agent to the registry.
// ---------------------------------------------------------------------------

export async function runCreateAgent(): Promise<void> {
  assertProjectInitialized();

  const projectConfig = loadProjectConfig();
  const templateIds = listTemplateIds(projectConfig.globalTemplatesDir);

  if (templateIds.length === 0) {
    throw new WaironError('No templates found. Check your .wai/templates/ directory or the built-in templates.');
  }

  const activeTargets = projectConfig.targets
    .filter((t) => !('enabled' in t) || t.enabled)
    .map((t) => (typeof t === 'string' ? t : t.type));

  logger.header('Create Agent');
  logger.blank();

  const answers = await inquirer.prompt<{
    id: string;
    name: string;
    description: string;
    creationReason: string;
    template: string;
    ownedPaths: string;
    tags: string;
    targets: string[];
    confirm: boolean;
  }>([
    {
      type: 'input',
      name: 'id',
      message: 'Agent ID (lowercase, dashes only):',
      validate: (val: string) => {
        if (!/^[a-z0-9-]+$/.test(val)) {
          return 'ID must be lowercase alphanumeric characters and dashes only';
        }
        const registry = loadRegistry();
        if (registry.agents.some((a) => a.id === val)) {
          return `Agent "${val}" already exists in the registry`;
        }
        return true;
      },
    },
    {
      type: 'input',
      name: 'name',
      message: 'Display name:',
      default: (ans: { id: string }) =>
        ans.id
          .split('-')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' '),
    },
    {
      type: 'input',
      name: 'description',
      message: 'Short description (shown in agent list):',
      validate: (val: string) => val.trim().length > 0 || 'Description is required',
    },
    {
      type: 'input',
      name: 'creationReason',
      message: 'Why does this agent need to exist? (architectural reason):',
      validate: (val: string) => val.trim().length > 0 || 'Creation reason is required',
    },
    {
      type: 'list',
      name: 'template',
      message: 'Template:',
      choices: templateIds.map((id) => {
        try {
          const tpl = loadTemplate(id, projectConfig.globalTemplatesDir);
          return { name: `${chalk.bold(id)}  — ${tpl.description}`, value: id };
        } catch {
          return { name: id, value: id };
        }
      }),
    },
    {
      type: 'input',
      name: 'ownedPaths',
      message: 'Owned paths (comma-separated globs, e.g. src/core/**):',
      default: '',
    },
    {
      type: 'input',
      name: 'tags',
      message: 'Tags (comma-separated, optional):',
      default: '',
    },
    {
      type: 'checkbox',
      name: 'targets',
      message: 'Output targets:',
      choices: activeTargets.map((t) => ({ name: t, value: t, checked: true })),
      validate: (val: string[]) => val.length > 0 || 'Select at least one target',
    },
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Add this agent to the registry?',
      default: true,
    },
  ]);

  if (!answers.confirm) {
    logger.info('Cancelled.');
    return;
  }

  const ownedPaths = answers.ownedPaths
    ? answers.ownedPaths.split(',').map((p) => p.trim()).filter(Boolean)
    : [];

  const tags = answers.tags
    ? answers.tags.split(',').map((t) => t.trim()).filter(Boolean)
    : [];

  const agent = createAgentRecord({
    id: answers.id,
    name: answers.name,
    description: answers.description,
    creationReason: answers.creationReason,
    template: answers.template,
    ownedPaths,
    tags,
    targets: answers.targets as Array<'claude' | 'gemini'>,
  });

  addAgent(agent);
  logger.blank();
  logger.success(`Agent "${agent.id}" added to registry.`);

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
