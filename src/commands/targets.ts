import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { fromProjectRoot } from '../utils/fs.js';
import {
  assertProjectInitialized,
  loadProjectConfig,
  saveProjectConfig,
} from '../config/loader.js';
import { defaultTargetConfig, DEFAULT_TARGET_DIRS } from '../config/defaults.js';
import { TargetConfig } from '../models/project.js';
import { runGenerate } from './generate.js';

// ---------------------------------------------------------------------------
// targets subcommands
//
//   wairon targets list
//   wairon targets add
//   wairon targets remove <type|label>
//   wairon targets enable <type|label>
//   wairon targets disable <type|label>
// ---------------------------------------------------------------------------

// ---- helpers ----------------------------------------------------------------

function targetKey(t: TargetConfig): string {
  return t.type === 'custom' ? t.label : t.type;
}

function targetLabel(t: TargetConfig): string {
  if (t.type === 'custom') return `custom (${t.label})`;
  return t.type;
}

function targetOutputDir(t: TargetConfig): string {
  return t.outputDir;
}

// ---- list -------------------------------------------------------------------

export async function runTargetsList(): Promise<void> {
  assertProjectInitialized();
  const config = loadProjectConfig();

  if (config.targets.length === 0) {
    logger.info('No targets configured. Run `wairon targets add` to add one.');
    return;
  }

  logger.header(`Targets (${config.targets.length})`);
  logger.blank();

  for (const t of config.targets) {
    const status = t.enabled ? chalk.green('enabled') : chalk.gray('disabled');
    const label = chalk.bold(targetLabel(t));
    const dir = chalk.cyan(targetOutputDir(t));
    console.log(`  ${label}  ${status}`);
    console.log(`    output dir: ${dir}`);
    console.log();
  }
}

// ---- add --------------------------------------------------------------------

export async function runTargetsAdd(): Promise<void> {
  assertProjectInitialized();
  const config = loadProjectConfig();

  const existingTypes = new Set(config.targets.map((t) => t.type));
  const existingCustomLabels = new Set(
    config.targets.filter((t) => t.type === 'custom').map((t) => (t as { label: string }).label),
  );

  // Build the list of built-in options that haven't been added yet
  const builtinChoices = (['claude', 'gemini'] as const)
    .filter((type) => !existingTypes.has(type))
    .map((type) => ({
      name: `${type === 'claude' ? 'Claude Code' : 'Gemini CLI'}  (${DEFAULT_TARGET_DIRS[type]})`,
      value: type,
    }));

  const choices = [
    ...builtinChoices,
    { name: 'Custom path  (any other tool)', value: 'custom' },
  ];

  if (builtinChoices.length === 0 && existingTypes.has('claude') && existingTypes.has('gemini')) {
    logger.info('Both Claude Code and Gemini CLI are already configured.');
    logger.info('You can still add a custom target for another tool.');
    logger.blank();
  }

  const { targetType } = await inquirer.prompt<{ targetType: string }>([
    {
      type: 'list',
      name: 'targetType',
      message: 'Which target do you want to add?',
      choices,
    },
  ]);

  let newTarget: TargetConfig;

  if (targetType === 'claude' || targetType === 'gemini') {
    newTarget = defaultTargetConfig(targetType);
  } else {
    // Custom target
    const { customLabel, customOutputDir } = await inquirer.prompt<{
      customLabel: string;
      customOutputDir: string;
    }>([
      {
        type: 'input',
        name: 'customLabel',
        message: 'Label for this target (e.g. "Cursor", "Continue"):',
        validate: (v: string) => {
          if (!v.trim()) return 'Label is required';
          if (existingCustomLabels.has(v.trim())) return `A custom target named "${v.trim()}" already exists`;
          return true;
        },
      },
      {
        type: 'input',
        name: 'customOutputDir',
        message: 'Output directory for agent files (relative to project root):',
        default: '.ai-agents',
        validate: (v: string) => v.trim().length > 0 || 'Output directory is required',
      },
    ]);

    newTarget = {
      type: 'custom',
      label: customLabel.trim(),
      outputDir: customOutputDir.trim(),
      enabled: true,
    };
  }

  // Check for duplicate outputDir
  const dirConflict = config.targets.find((t) => t.outputDir === newTarget.outputDir);
  if (dirConflict) {
    logger.warn(
      `Output directory "${newTarget.outputDir}" is already used by target "${targetLabel(dirConflict)}".`,
    );
    const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
      { type: 'confirm', name: 'proceed', message: 'Add anyway?', default: false },
    ]);
    if (!proceed) { logger.info('Cancelled.'); return; }
  }

  config.targets.push(newTarget);
  config.updatedAt = new Date().toISOString();
  saveProjectConfig(config);

  logger.success(`Target "${targetLabel(newTarget)}" added.`);
  logger.blank();

  // Scaffold agent output dirs for all existing domains
  scaffoldTargetDirs(newTarget);

  // Generate agent files for the new target
  const { generate } = await inquirer.prompt<{ generate: boolean }>([
    {
      type: 'confirm',
      name: 'generate',
      message: 'Generate agent files for this target now?',
      default: true,
    },
  ]);

  if (generate) {
    const filterTarget = newTarget.type === 'custom' ? 'custom' : newTarget.type;
    await runGenerate({ target: filterTarget });
  } else {
    logger.info('Run `wairon generate` whenever you\'re ready.');
  }
}

// ---- remove -----------------------------------------------------------------

export async function runTargetsRemove(key: string): Promise<void> {
  assertProjectInitialized();
  const config = loadProjectConfig();

  const idx = config.targets.findIndex((t) => targetKey(t) === key || targetLabel(t) === key);
  if (idx === -1) {
    logger.error(`Target "${key}" not found. Run \`wairon targets list\` to see configured targets.`);
    process.exit(1);
  }

  const target = config.targets[idx];

  if (config.targets.filter((t) => t.enabled).length === 1 && target.enabled) {
    logger.error('Cannot remove the only enabled target. Add or enable another target first.');
    process.exit(1);
  }

  const outputDir = path.resolve(fromProjectRoot(), target.outputDir);
  const dirExists = fs.existsSync(outputDir);

  const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Remove target "${targetLabel(target)}" (output: ${target.outputDir})?`,
      default: false,
    },
  ]);
  if (!confirm) { logger.info('Cancelled.'); return; }

  let deleteFiles = false;
  if (dirExists) {
    const { del } = await inquirer.prompt<{ del: boolean }>([
      {
        type: 'confirm',
        name: 'del',
        message: `Delete generated agent files at "${target.outputDir}"?`,
        default: false,
      },
    ]);
    deleteFiles = del;
  }

  config.targets.splice(idx, 1);
  config.updatedAt = new Date().toISOString();
  saveProjectConfig(config);

  if (deleteFiles) {
    fs.rmSync(outputDir, { recursive: true, force: true });
    logger.success(`Removed target and deleted "${target.outputDir}".`);
  } else {
    logger.success(`Removed target "${targetLabel(target)}" from config.`);
    if (dirExists) {
      logger.info(`Generated files at "${target.outputDir}" were kept. Delete manually if no longer needed.`);
    }
  }
}

// ---- enable / disable -------------------------------------------------------

export async function runTargetsEnable(key: string): Promise<void> {
  await setTargetEnabled(key, true);
}

export async function runTargetsDisable(key: string): Promise<void> {
  await setTargetEnabled(key, false);
}

async function setTargetEnabled(key: string, enabled: boolean): Promise<void> {
  assertProjectInitialized();
  const config = loadProjectConfig();

  const target = config.targets.find((t) => targetKey(t) === key || targetLabel(t) === key);
  if (!target) {
    logger.error(`Target "${key}" not found. Run \`wairon targets list\` to see configured targets.`);
    process.exit(1);
  }

  if (target.enabled === enabled) {
    logger.info(`Target "${targetLabel(target)}" is already ${enabled ? 'enabled' : 'disabled'}.`);
    return;
  }

  if (!enabled) {
    const remaining = config.targets.filter((t) => t !== target && t.enabled);
    if (remaining.length === 0) {
      logger.error('Cannot disable the only enabled target. Add or enable another target first.');
      process.exit(1);
    }
  }

  target.enabled = enabled;
  config.updatedAt = new Date().toISOString();
  saveProjectConfig(config);

  logger.success(`Target "${targetLabel(target)}" ${enabled ? 'enabled' : 'disabled'}.`);

  if (enabled) {
    const { generate } = await inquirer.prompt<{ generate: boolean }>([
      {
        type: 'confirm',
        name: 'generate',
        message: 'Generate agent files for this target now?',
        default: true,
      },
    ]);
    if (generate) {
      const filterTarget = target.type === 'custom' ? 'custom' : target.type;
      await runGenerate({ target: filterTarget });
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: scaffold output dirs for an existing project domain tree
// ---------------------------------------------------------------------------

function scaffoldTargetDirs(target: TargetConfig): void {
  const projectRoot = fromProjectRoot();

  // Always create the root-level output dir
  const rootOutputDir = path.resolve(projectRoot, target.outputDir);
  fs.mkdirSync(rootOutputDir, { recursive: true });
  logger.verbose(`Created ${target.outputDir}`);
}
