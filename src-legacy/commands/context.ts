import * as fs from 'fs';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, loadProjectConfig } from '../config/loader.js';
import {
  CONTEXT_PATHS,
  hasContext,
  readProjectContext,
  readArchitectureContext,
  writeProjectContext,
  writeArchitectureContext,
  syncContextFiles,
} from '../core/context.js';

// ---------------------------------------------------------------------------
// context init
// ---------------------------------------------------------------------------

export async function runContextInit(): Promise<void> {
  assertProjectInitialized();

  const projectConfig = loadProjectConfig();

  if (hasContext()) {
    const { overwrite } = await inquirer.prompt<{ overwrite: boolean }>([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `Project context already exists at ${chalk.cyan('.wai/context/project.md')}. Overwrite?`,
        default: false,
      },
    ]);
    if (!overwrite) {
      logger.info(`Run ${chalk.bold('wairon context edit')} to modify it.`);
      return;
    }
  }

  logger.blank();
  logger.info(chalk.bold('Setting up shared project context'));
  logger.info(chalk.gray('This will be injected into every AI session — keep it accurate and concise.'));
  logger.blank();

  const { description } = await inquirer.prompt<{ description: string }>([
    {
      type: 'input',
      name: 'description',
      message: 'What does this project do? (1–3 sentences)',
      validate: (v: string) => v.trim() ? true : 'Required',
    },
  ]);

  const { stack } = await inquirer.prompt<{ stack: string }>([
    {
      type: 'input',
      name: 'stack',
      message: 'Tech stack (comma-separated, e.g. "TypeScript, Node.js, React, PostgreSQL"):',
    },
  ]);

  const { conventions } = await inquirer.prompt<{ conventions: string }>([
    {
      type: 'input',
      name: 'conventions',
      message: 'Key conventions or rules (optional — press Enter to skip):',
    },
  ]);

  const { addArch } = await inquirer.prompt<{ addArch: boolean }>([
    {
      type: 'confirm',
      name: 'addArch',
      message: 'Add architecture / system design notes?',
      default: false,
    },
  ]);

  // Build project.md
  const stackItems = stack
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const sections: string[] = [
    `# ${projectConfig.name}`,
    '',
    description.trim(),
  ];

  if (stackItems.length > 0) {
    sections.push('', '## Tech Stack', '');
    for (const item of stackItems) {
      sections.push(`- ${item}`);
    }
  }

  if (conventions.trim()) {
    sections.push('', '## Key Conventions', '');
    for (const line of conventions.split(/[,;]\s*/).filter(Boolean)) {
      sections.push(`- ${line.trim()}`);
    }
  }

  sections.push('');
  writeProjectContext(sections.join('\n'));
  logger.success(`Written: ${chalk.cyan('.wai/context/project.md')}`);

  // Architecture notes
  if (addArch) {
    const { archText } = await inquirer.prompt<{ archText: string }>([
      {
        type: 'input',
        name: 'archText',
        message: 'Briefly describe the system architecture (services, layers, key boundaries):',
      },
    ]);
    if (archText.trim()) {
      writeArchitectureContext(`# Architecture\n\n${archText.trim()}\n`);
      logger.success(`Written: ${chalk.cyan('.wai/context/architecture.md')}`);
    }
  }

  // Sync generated files
  logger.blank();
  const result = syncContextFiles();
  logger.success(`Synced: ${chalk.cyan('.wai/context/domains.md')}${result.domainsUpdated ? '' : chalk.gray(' (unchanged)')}`);
  logger.success(`Synced: ${chalk.cyan('.wai/context/wairon-guide.md')}${result.guideUpdated ? '' : chalk.gray(' (unchanged)')}`);

  logger.blank();
  _printImportTip();
}

// ---------------------------------------------------------------------------
// context edit
// ---------------------------------------------------------------------------

export interface ContextEditOptions {
  architecture?: boolean;
}

export async function runContextEdit(options: ContextEditOptions = {}): Promise<void> {
  assertProjectInitialized();

  const filePath = options.architecture
    ? CONTEXT_PATHS.architectureMd()
    : CONTEXT_PATHS.projectMd();

  const label = options.architecture ? 'architecture.md' : 'project.md';

  // Ensure the file exists before opening
  if (!fs.existsSync(filePath)) {
    if (options.architecture) {
      writeArchitectureContext('# Architecture\n\n_Describe the system architecture here._\n');
    } else {
      logger.warn(`No context found. Run ${chalk.bold('wairon context init')} first.`);
      return;
    }
  }

  const editor = process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === 'win32' ? 'notepad' : 'nano');

  logger.info(`Opening ${chalk.cyan(`.wai/context/${label}`)} with ${chalk.bold(editor)}...`);

  const result = spawnSync(editor, [filePath], { stdio: 'inherit', shell: process.platform === 'win32' });

  if (result.error) {
    logger.error(`Could not open editor "${editor}": ${result.error.message}`);
    logger.info(`Edit manually: ${filePath}`);
    return;
  }

  // Auto-sync after editing
  logger.blank();
  const syncResult = syncContextFiles();
  if (syncResult.domainsUpdated || syncResult.guideUpdated) {
    logger.success('Context synced — generated files updated.');
  } else {
    logger.info('No changes detected in generated files.');
  }
}

// ---------------------------------------------------------------------------
// context sync
// ---------------------------------------------------------------------------

export async function runContextSync(): Promise<void> {
  assertProjectInitialized();

  const result = syncContextFiles();

  if (result.domainsUpdated) {
    logger.success(`Updated: ${chalk.cyan('.wai/context/domains.md')}`);
  } else {
    logger.info(`Unchanged: ${chalk.gray('.wai/context/domains.md')}`);
  }

  if (result.guideUpdated) {
    logger.success(`Updated: ${chalk.cyan('.wai/context/wairon-guide.md')}`);
  } else {
    logger.info(`Unchanged: ${chalk.gray('.wai/context/wairon-guide.md')}`);
  }

  if (!result.domainsUpdated && !result.guideUpdated) {
    logger.blank();
    logger.info('Everything is up to date.');
  } else {
    logger.blank();
    _printImportTip();
  }
}

// ---------------------------------------------------------------------------
// context show
// ---------------------------------------------------------------------------

export async function runContextShow(): Promise<void> {
  assertProjectInitialized();

  const projectCtx = readProjectContext();
  const archCtx = readArchitectureContext();

  if (!projectCtx) {
    logger.warn('No project context found.');
    logger.info(`Run ${chalk.bold('wairon context init')} to create one.`);
    return;
  }

  logger.blank();
  console.log(chalk.bold.cyan('── project.md ───────────────────────────────────────────'));
  console.log(projectCtx.trim());

  if (archCtx) {
    logger.blank();
    console.log(chalk.bold.cyan('── architecture.md ──────────────────────────────────────'));
    console.log(archCtx.trim());
  }

  // Also show the domain count from domains.md
  const domainsPath = CONTEXT_PATHS.domainsMd();
  if (fs.existsSync(domainsPath)) {
    const domainsContent = fs.readFileSync(domainsPath, 'utf-8');
    const match = domainsContent.match(/\*\*(\d+) domain/);
    if (match) {
      logger.blank();
      logger.info(`${chalk.cyan('.wai/context/domains.md')} — ${match[1]} domain(s) tracked`);
    }
  }

  logger.blank();
  logger.info(`${chalk.cyan('.wai/context/wairon-guide.md')} — import into CLAUDE.md / GEMINI.md:`);
  console.log(chalk.gray('  @.wai/context/wairon-guide.md'));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _printImportTip(): void {
  logger.info('To give every AI session full project awareness, add this line to your CLAUDE.md or GEMINI.md:');
  logger.blank();
  console.log(chalk.gray('  @.wai/context/wairon-guide.md'));
  logger.blank();
  logger.info(chalk.gray('wairon keeps this file current — you only need to add the import once.'));
}
