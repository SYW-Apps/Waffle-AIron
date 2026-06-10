import chalk from 'chalk';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, loadProjectConfig, saveProjectConfig } from '../config/loader.js';
import { findDomain } from '../core/domains.js';
import { currentBranch, listBranches, hasUncommittedChanges, GitError } from '../core/git.js';
import {
  createWorktree,
  mergeWorktree,
  removeWorktreeById,
  cleanWorktrees,
  listWorktrees,
  loadWorktree,
} from '../core/worktrees.js';
import { fromProjectRoot } from '../utils/fs.js';

// ---------------------------------------------------------------------------
// worktrees enable  — set git.waironManaged = true
// ---------------------------------------------------------------------------

export async function runWorktreesEnable(): Promise<void> {
  assertProjectInitialized();
  const config = loadProjectConfig();

  if (config.git?.waironManaged) {
    logger.info('Git management is already enabled for this project.');
    return;
  }

  logger.blank();
  logger.info(chalk.bold('Enable wairon git management'));
  logger.blank();
  logger.info('This allows wairon to:');
  logger.info('  • Create and delete git branches');
  logger.info('  • Add and remove git worktrees under .wai/worktrees/');
  logger.info('  • Apply sparse checkout to worktrees');
  logger.info('  • Merge worktree branches (with confirmation by default)');
  logger.blank();
  logger.warn('wairon will NEVER force-push or modify remote branches.');
  logger.warn('Protected branches: ' + (config.git?.protectedBranches ?? ['main', 'master', 'develop']).join(', '));
  logger.blank();

  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([{
    type:    'confirm',
    name:    'confirmed',
    message: 'Enable wairon git management for this project?',
    default: false,
  }]);

  if (!confirmed) { logger.info('Cancelled.'); return; }

  config.git = {
    waironManaged:     true,
    autoMerge:         false,
    worktreeBase:      '.wai/worktrees',
    protectedBranches: ['main', 'master', 'develop'],
    ...config.git,
  };
  saveProjectConfig(config);
  logger.success('Git management enabled. git.waironManaged = true in .wai/project.yaml');
  logger.blank();
  logger.info(`Create your first worktree: ${chalk.bold('wairon worktrees create')}`);
}

// ---------------------------------------------------------------------------
// worktrees create
// ---------------------------------------------------------------------------

export interface WorktreesCreateOptions {
  branch?: string;
  domain?: string;
  sparse?: string;   // comma-separated paths
  base?: string;
  target?: string;
  label?: string;
}

export async function runWorktreesCreate(options: WorktreesCreateOptions = {}): Promise<void> {
  assertProjectInitialized();
  const config = loadProjectConfig();

  if (!config.git?.waironManaged) {
    logger.error('Git management is not enabled. Run `wairon worktrees enable` first.');
    process.exit(1);
  }

  const projectRoot  = fromProjectRoot();
  const activeBranch = currentBranch(projectRoot);

  logger.blank();

  // ── Domain ────────────────────────────────────────────────────────────────
  let domainId: string | undefined = options.domain;
  if (!domainId) {
    const { dom } = await inquirer.prompt<{ dom: string }>([{
      type:    'input',
      name:    'dom',
      message: 'Domain to scope this worktree to (leave blank for full checkout):',
    }]);
    if (dom.trim()) domainId = dom.trim();
  }

  if (domainId) {
    const domain = findDomain(domainId);
    if (!domain) {
      logger.error(`Domain "${domainId}" not found. Run \`wairon domains list\` to see available domains.`);
      process.exit(1);
    }
  }

  // ── Label ─────────────────────────────────────────────────────────────────
  const defaultLabel = domainId ?? 'feature';
  const { label } = await inquirer.prompt<{ label: string }>([{
    type:    'input',
    name:    'label',
    message: 'Worktree label (used for id and default branch name):',
    default: options.label ?? defaultLabel,
    validate: (v: string) => v.trim() ? true : 'Required',
  }]);

  // ── Branch ────────────────────────────────────────────────────────────────
  const defaultBranch = `feature/${label.trim().replace(/\s+/g, '-')}`;
  const { branch } = await inquirer.prompt<{ branch: string }>([{
    type:    'input',
    name:    'branch',
    message: 'Branch name:',
    default: options.branch ?? defaultBranch,
    validate: (v: string) => v.trim() ? true : 'Required',
  }]);

  const existingBranches = listBranches(projectRoot);
  const branchAlreadyExists = existingBranches.includes(branch.trim());

  if (branchAlreadyExists) {
    const { useExisting } = await inquirer.prompt<{ useExisting: boolean }>([{
      type:    'confirm',
      name:    'useExisting',
      message: `Branch "${branch.trim()}" already exists. Check it out in the worktree?`,
      default: true,
    }]);
    if (!useExisting) { logger.info('Cancelled.'); return; }
  }

  // ── Base branch ───────────────────────────────────────────────────────────
  let baseBranch = options.base;
  if (!branchAlreadyExists && !baseBranch) {
    const { base } = await inquirer.prompt<{ base: string }>([{
      type:    'input',
      name:    'base',
      message: 'Base branch (new branch will start here):',
      default: activeBranch,
    }]);
    baseBranch = base.trim();
  }

  // ── Target branch (for merge) ─────────────────────────────────────────────
  let targetBranch = options.target;
  if (!targetBranch) {
    const { target } = await inquirer.prompt<{ target: string }>([{
      type:    'input',
      name:    'target',
      message: 'Target branch to merge into when done:',
      default: activeBranch,
    }]);
    targetBranch = target.trim();
  }

  // ── Sparse paths ──────────────────────────────────────────────────────────
  let sparsePaths: string[] | undefined;
  if (options.sparse) {
    sparsePaths = options.sparse.split(',').map((p) => p.trim()).filter(Boolean);
  } else if (domainId) {
    // Auto-derive — show user what will be used
    const { useSparse } = await inquirer.prompt<{ useSparse: boolean }>([{
      type:    'confirm',
      name:    'useSparse',
      message: 'Use sparse checkout? (only materialises domain paths, saves disk space)',
      default: true,
    }]);
    if (!useSparse) sparsePaths = []; // empty = full checkout
  }

  // ── Uncommitted changes warning ───────────────────────────────────────────
  if (hasUncommittedChanges(projectRoot)) {
    logger.warn('You have uncommitted changes in the main workspace.');
    logger.warn('The worktree will be created from the last committed state.');
    const { proceed } = await inquirer.prompt<{ proceed: boolean }>([{
      type:    'confirm',
      name:    'proceed',
      message: 'Proceed anyway?',
      default: true,
    }]);
    if (!proceed) { logger.info('Cancelled.'); return; }
  }

  // ── Create ────────────────────────────────────────────────────────────────
  logger.blank();
  logger.info('Creating worktree...');

  try {
    const { worktree, worktreePath } = createWorktree({
      label:      label.trim(),
      branch:     branch.trim(),
      newBranch:  !branchAlreadyExists,
      baseBranch,
      domainId,
      sparsePaths,
      targetBranch,
    });

    logger.blank();
    logger.success(`Worktree created: ${chalk.bold(worktree.id)}`);
    logger.blank();
    console.log(`  ${chalk.bold('Path:')}   ${worktreePath}`);
    console.log(`  ${chalk.bold('Branch:')} ${worktree.branch}`);
    console.log(`  ${chalk.bold('Target:')} ${worktree.targetBranch ?? activeBranch}`);
    if (worktree.sparsePaths.length > 0) {
      console.log(`  ${chalk.bold('Sparse:')} ${worktree.sparsePaths.join(', ')}`);
    }
    logger.blank();
    logger.info(`Start working in it:`);
    console.log(chalk.gray(`  cd ${worktreePath}`));
    logger.info(`Or delegate a task to it:`);
    console.log(chalk.gray(`  wairon run start --domain ${domainId ?? 'root'}`));
  } catch (err) {
    if (err instanceof GitError) {
      logger.error(`Git error: ${err.message}`);
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// worktrees list
// ---------------------------------------------------------------------------

export async function runWorktreesList(): Promise<void> {
  assertProjectInitialized();

  const worktrees = listWorktrees().filter((w) => w.status !== 'removed');

  if (worktrees.length === 0) {
    logger.info('No worktrees. Create one with `wairon worktrees create`.');
    return;
  }

  logger.blank();
  for (const wt of worktrees) {
    const sc     = _statusColor(wt.status);
    const domain = wt.domainId ? chalk.gray(` [@${wt.domainId}]`) : '';
    const sparse = wt.sparsePaths.length > 0 ? chalk.gray(' sparse') : '';
    const target = wt.targetBranch ? chalk.gray(` → ${wt.targetBranch}`) : '';
    console.log(`  ${sc(wt.status.padEnd(10))}  ${chalk.bold(wt.id)}  ${chalk.cyan(wt.branch)}${domain}${sparse}${target}`);
    console.log(`    ${chalk.gray(wt.path)}`);
    logger.blank();
  }
}

// ---------------------------------------------------------------------------
// worktrees show <id>
// ---------------------------------------------------------------------------

export async function runWorktreesShow(id: string): Promise<void> {
  assertProjectInitialized();

  let wt;
  try { wt = loadWorktree(id); }
  catch { logger.error(`Worktree "${id}" not found.`); process.exit(1); }

  logger.blank();
  const sc = _statusColor(wt.status);
  console.log(`${chalk.bold('Id:')}      ${wt.id}`);
  console.log(`${chalk.bold('Status:')} ${sc(wt.status)}`);
  console.log(`${chalk.bold('Branch:')} ${wt.branch}`);
  console.log(`${chalk.bold('Path:')}   ${wt.path}`);
  if (wt.domainId)          console.log(`${chalk.bold('Domain:')}  ${wt.domainId}`);
  if (wt.targetBranch)      console.log(`${chalk.bold('Target:')}  ${wt.targetBranch}`);
  if (wt.sparsePaths.length > 0) {
    console.log(`${chalk.bold('Sparse:')}  ${wt.sparsePaths.join(', ')}`);
  }
  if (wt.runId)  console.log(`${chalk.bold('Run:')}     ${wt.runId}`);
  if (wt.stepId) console.log(`${chalk.bold('Step:')}    ${wt.stepId}`);
  console.log(`${chalk.bold('Created:')} ${wt.createdAt}`);
  if (wt.mergedAt) console.log(`${chalk.bold('Merged:')}  ${wt.mergedAt}`);
  logger.blank();
}

// ---------------------------------------------------------------------------
// worktrees merge <id>
// ---------------------------------------------------------------------------

export interface WorktreesMergeOptions {
  targetBranch?: string;
  yes?: boolean;
}

export async function runWorktreesMerge(id: string, options: WorktreesMergeOptions = {}): Promise<void> {
  assertProjectInitialized();
  const config = loadProjectConfig();

  let wt;
  try { wt = loadWorktree(id); }
  catch { logger.error(`Worktree "${id}" not found.`); process.exit(1); }

  if (wt.status === 'merged') {
    logger.info(`Worktree "${id}" is already merged.`);
    return;
  }

  const target = options.targetBranch ?? wt.targetBranch ?? currentBranch(fromProjectRoot());

  // Protected branch check
  const protected_ = config.git?.protectedBranches ?? ['main', 'master', 'develop'];
  if (protected_.includes(target) && !options.yes) {
    logger.blank();
    logger.warn(`Target branch "${target}" is protected.`);
    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([{
      type:    'confirm',
      name:    'confirmed',
      message: `Merge ${chalk.cyan(wt.branch)} into protected branch ${chalk.red(target)}?`,
      default: false,
    }]);
    if (!confirmed) { logger.info('Cancelled.'); return; }
  } else if (!options.yes) {
    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([{
      type:    'confirm',
      name:    'confirmed',
      message: `Merge ${chalk.cyan(wt.branch)} → ${chalk.cyan(target)}?`,
      default: true,
    }]);
    if (!confirmed) { logger.info('Cancelled.'); return; }
  }

  logger.blank();
  logger.info(`Merging ${chalk.cyan(wt.branch)} → ${chalk.cyan(target)}...`);

  try {
    const result = mergeWorktree(id, { targetBranch: target });
    if (result.merged) {
      logger.success(`Merged: ${wt.branch} → ${target}`);
      logger.blank();
      logger.info(`Branch ${chalk.cyan(wt.branch)} is now merged.`);
      logger.info(`Run ${chalk.bold(`wairon worktrees clean ${id}`)} to remove the worktree.`);
    } else {
      logger.info(result.message);
    }
  } catch (err) {
    if (err instanceof GitError) {
      logger.error(`Merge failed: ${err.message}`);
      logger.blank();
      logger.info('Resolve conflicts manually, then run `git merge --continue`.');
      logger.info(`Working tree: ${wt.path}`);
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// worktrees clean [id]
// ---------------------------------------------------------------------------

export interface WorktreesCleanOptions {
  all?: boolean;
}

export async function runWorktreesClean(id?: string, options: WorktreesCleanOptions = {}): Promise<void> {
  assertProjectInitialized();

  if (id) {
    // Remove a specific worktree
    let wt;
    try { wt = loadWorktree(id); }
    catch { logger.error(`Worktree "${id}" not found.`); process.exit(1); }

    if (wt.status === 'active' && !options.all) {
      logger.warn(`Worktree "${id}" is still active (branch: ${wt.branch}).`);
      const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([{
        type:    'confirm',
        name:    'confirmed',
        message: 'Remove it anyway? (uncommitted work in the worktree will be lost)',
        default: false,
      }]);
      if (!confirmed) { logger.info('Cancelled.'); return; }
    }

    const { deleteBranch } = await inquirer.prompt<{ deleteBranch: boolean }>([{
      type:    'confirm',
      name:    'deleteBranch',
      message: `Also delete branch "${wt.branch}"?`,
      default: wt.status === 'merged',
    }]);

    removeWorktreeById(id, { force: true, deleteBranch });
    logger.success(`Removed worktree "${id}".`);
    return;
  }

  // Bulk clean merged/abandoned
  const toRemove = listWorktrees().filter((w) =>
    options.all
      ? w.status !== 'removed'
      : ['merged', 'abandoned', 'removed'].includes(w.status)
  );

  if (toRemove.length === 0) {
    logger.info('Nothing to clean.');
    if (!options.all) logger.info('Only active worktrees exist. Use --all to remove everything.');
    return;
  }

  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([{
    type:    'confirm',
    name:    'confirmed',
    message: `Remove ${toRemove.length} worktree(s)?`,
    default: true,
  }]);
  if (!confirmed) { logger.info('Cancelled.'); return; }

  const removed = cleanWorktrees({ all: options.all });
  logger.success(`Removed ${removed} worktree(s).`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _statusColor(status: string): (s: string) => string {
  switch (status) {
    case 'active':    return chalk.cyan;
    case 'merging':   return chalk.yellow;
    case 'merged':    return chalk.green;
    case 'abandoned': return chalk.gray;
    case 'removed':   return chalk.gray;
    default:          return chalk.white;
  }
}
