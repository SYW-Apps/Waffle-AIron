import { spawn } from 'child_process';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { fromProjectRoot } from '../utils/fs.js';
import { assertProjectInitialized, loadProjectConfig } from '../config/loader.js';
import { findDomain } from '../core/domains.js';
import { resolveToolCommand } from '../config/profiles.js';
import {
  createRun,
  loadRun,
  listRuns,
  updateRunStatus,
  updateStepStatus,
  loadStepResult,
  scaffoldStep,
  stepEnvVars,
  stepJobPath,
  cleanRuns,
  generateStepId,
} from '../core/workspace.js';
import { Step } from '../models/run.js';
import { writeYamlFile } from '../utils/yaml.js';

// ---------------------------------------------------------------------------
// run start
// ---------------------------------------------------------------------------

export interface RunStartOptions {
  /** Task description */
  prompt?: string;
  /** Domain to scope this run to */
  domain?: string;
  /** AI backend */
  backend?: string;
  /** Model for ollama/custom */
  model?: string;
  /** Run label */
  label?: string;
}

export async function runRunStart(options: RunStartOptions = {}): Promise<void> {
  assertProjectInitialized();
  const projectConfig = loadProjectConfig();

  // ── Resolve domain ────────────────────────────────────────────────────────
  let domainId: string | null = options.domain ?? null;
  let domainPath: string = '.';

  if (domainId) {
    const domain = findDomain(domainId);
    if (!domain) {
      logger.error(`Domain "${domainId}" not found. Run \`wairon domains list\` to see available domains.`);
      process.exit(1);
    }
    domainPath = domain.path;
  }

  // ── Resolve task ──────────────────────────────────────────────────────────
  let task = options.prompt;
  if (!task) {
    const { inputTask } = await inquirer.prompt<{ inputTask: string }>([
      {
        type: 'input',
        name: 'inputTask',
        message: 'Task description:',
        validate: (v: string) => v.trim() ? true : 'Required',
      },
    ]);
    task = inputTask.trim();
  }

  const backend  = options.backend ?? projectConfig.defaultBackend ?? 'claude';
  const label    = options.label ?? task.slice(0, 60);

  // ── Create run + step ─────────────────────────────────────────────────────
  const run    = createRun(label);
  const stepId = generateStepId('task');

  const step: Step = {
    id:        stepId,
    label:     label,
    status:    'pending',
    domain:    domainId,
    backend:   backend as Step['backend'],
    backendModel: options.model,
    task,
    dependsOn: [],
    awareOf:   [],
    createdAt: new Date().toISOString(),
  };

  run.steps.push(step);
  updateRunStatus(run.id, 'running');

  // ── Scaffold workspace ────────────────────────────────────────────────────
  logger.blank();
  logger.info(`Run:  ${chalk.bold(run.id)}`);
  logger.info(`Step: ${chalk.bold(stepId)}`);
  if (domainId) logger.info(`Domain: ${domainId} (${domainPath})`);
  logger.info(`Backend: ${backend}${options.model ? ` / ${options.model}` : ''}`);
  logger.blank();

  logger.info('Scaffolding workspace...');
  const toolConfigDir = scaffoldStep({
    runId:    run.id,
    stepId,
    task,
    domainId,
    backend,
  });
  logger.verbose(`Tool config dir: ${toolConfigDir}`);

  // ── Write job file ─────────────────────────────────────────────────────────
  const jobId = `${run.id}-${stepId}`;
  const jobData = {
    id:         jobId,
    status:     'pending',
    domain:     domainId ?? 'root',
    domainPath,
    createdBy:  'user',
    backend,
    backendModel: options.model,
    task,
    createdAt:  new Date().toISOString(),
    context:    { files: [], notes: [] },
  };
  writeYamlFile(stepJobPath(run.id, stepId), jobData);

  // ── Spawn ──────────────────────────────────────────────────────────────────
  const cmd = resolveToolCommand(backend, projectConfig.profile);
  const cwd = domainId ? fromProjectRoot(domainPath) : fromProjectRoot();
  const env = {
    ...process.env,
    ...stepEnvVars(run.id, stepId, jobId, backend),
  };

  updateStepStatus(run.id, stepId, 'running');

  logger.info(`Starting ${chalk.bold(cmd)} in ${chalk.cyan(domainId ? domainPath : '.')}`);
  logger.info(chalk.gray('─── workspace session start ─────────────────────────────────────'));
  logger.blank();

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(cmd, [], {
      cwd,
      stdio: 'inherit',
      shell: true,
      env,
    });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      logger.error(`Failed to start ${cmd}: ${err.message}`);
      resolve(1);
    });
  });

  logger.blank();
  logger.info(chalk.gray('─── workspace session end ───────────────────────────────────────'));
  logger.blank();

  // ── Read result ────────────────────────────────────────────────────────────
  const result = loadStepResult(run.id, stepId);

  if (result) {
    updateStepStatus(run.id, stepId, 'completed');
    updateRunStatus(run.id, 'completed');
    logger.success(`Run completed: ${chalk.bold(run.id)}`);
    logger.blank();
    console.log(chalk.bold('Result Summary'));
    console.log(chalk.gray('─'.repeat(40)));
    console.log(result.summary);

    if (result.filesChanged.length > 0) {
      logger.blank();
      console.log(chalk.bold('Files changed:'));
      for (const f of result.filesChanged) {
        console.log(`  ${chalk.cyan(f)}`);
      }
    }
    if (result.flagged) {
      logger.blank();
      logger.warn('Flagged (out of scope, not acted on):');
      console.log(chalk.yellow(result.flagged));
    }
  } else {
    if (exitCode === 0) {
      updateStepStatus(run.id, stepId, 'abandoned');
      updateRunStatus(run.id, 'completed');
      logger.warn('Session ended without writing a result.');
    } else {
      updateStepStatus(run.id, stepId, 'failed');
      updateRunStatus(run.id, 'failed');
      logger.warn(`Session exited with code ${exitCode}.`);
    }
    logger.info(`Workspace: .wai/runs/${run.id}/steps/${stepId}/`);
  }

  logger.blank();
  logger.info(`Run workspace kept at: ${chalk.gray(`.wai/runs/${run.id}/`)}`);
  logger.info(`Run \`wairon run clean\` to remove completed workspaces.`);
}

// ---------------------------------------------------------------------------
// run status [run-id]
// ---------------------------------------------------------------------------

export async function runRunStatus(runId?: string): Promise<void> {
  assertProjectInitialized();

  if (runId) {
    _printRunDetail(runId);
    return;
  }

  const runs = listRuns();
  if (runs.length === 0) {
    logger.info('No runs found. Start one with `wairon run start`.');
    return;
  }

  logger.blank();
  for (const run of runs.slice(0, 20)) {
    _printRunSummaryLine(run);
  }
  if (runs.length > 20) {
    logger.blank();
    logger.info(chalk.gray(`... and ${runs.length - 20} more. Use \`wairon run status <run-id>\` for details.`));
  }
  logger.blank();
}

function _printRunSummaryLine(run: ReturnType<typeof loadRun>): void {
  const statusColor = _statusColor(run.status);
  const label = run.label ? chalk.gray(` — ${run.label.slice(0, 50)}`) : '';
  const steps = run.steps.length > 0
    ? chalk.gray(` (${run.steps.length} step${run.steps.length !== 1 ? 's' : ''})`)
    : '';
  console.log(`  ${statusColor(run.status.padEnd(10))}  ${chalk.bold(run.id)}${label}${steps}`);
}

function _printRunDetail(runId: string): void {
  let run: ReturnType<typeof loadRun>;
  try {
    run = loadRun(runId);
  } catch {
    logger.error(`Run "${runId}" not found.`);
    process.exit(1);
  }

  logger.blank();
  const statusColor = _statusColor(run.status);
  console.log(`${chalk.bold('Run:')}    ${run.id}`);
  if (run.label) console.log(`${chalk.bold('Label:')}  ${run.label}`);
  console.log(`${chalk.bold('Status:')} ${statusColor(run.status)}`);
  console.log(`${chalk.bold('Created:')} ${run.createdAt}`);

  if (run.steps.length > 0) {
    logger.blank();
    console.log(chalk.bold('Steps:'));
    for (const step of run.steps) {
      const sc = _statusColor(step.status);
      const domain = step.domain ? chalk.gray(` [${step.domain}]`) : '';
      const backend = chalk.gray(` via ${step.backend}`);
      console.log(`  ${sc(step.status.padEnd(10))} ${chalk.cyan(step.id)}${domain}${backend}`);
      console.log(`    ${chalk.gray(step.task.slice(0, 80))}${step.task.length > 80 ? chalk.gray('...') : ''}`);

      const result = loadStepResult(run.id, step.id);
      if (result) {
        console.log(`    ${chalk.green('↳')} ${result.summary.split('\n')[0].slice(0, 80)}`);
      }
    }
  }
  logger.blank();
  console.log(`Workspace: ${chalk.gray(`.wai/runs/${run.id}/`)}`);
  logger.blank();
}

function _statusColor(status: string): (s: string) => string {
  switch (status) {
    case 'completed': return chalk.green;
    case 'running':   return chalk.cyan;
    case 'failed':    return chalk.red;
    case 'abandoned': return chalk.yellow;
    case 'cancelled': return chalk.gray;
    default:          return chalk.gray;
  }
}

// ---------------------------------------------------------------------------
// run list
// ---------------------------------------------------------------------------

export async function runRunList(): Promise<void> {
  assertProjectInitialized();
  await runRunStatus(); // same output
}

// ---------------------------------------------------------------------------
// run clean
// ---------------------------------------------------------------------------

export interface RunCleanOptions {
  all?: boolean;
  olderThanDays?: number;
}

export async function runRunClean(options: RunCleanOptions = {}): Promise<void> {
  assertProjectInitialized();

  const runs = listRuns();
  const toRemove = runs.filter((r) => {
    if (options.all) return true;
    if (!['completed', 'failed', 'cancelled'].includes(r.status)) return false;
    if (options.olderThanDays) {
      const age = (Date.now() - new Date(r.createdAt).getTime()) / 86_400_000;
      return age >= options.olderThanDays;
    }
    return true; // remove all completed/failed/cancelled by default
  });

  if (toRemove.length === 0) {
    logger.info('Nothing to clean.');
    if (!options.all) logger.info('Pending and running runs are kept. Use --all to remove everything.');
    return;
  }

  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    {
      type: 'confirm',
      name: 'confirmed',
      message: `Remove ${toRemove.length} run workspace${toRemove.length !== 1 ? 's' : ''}?`,
      default: true,
    },
  ]);

  if (!confirmed) {
    logger.info('Cancelled.');
    return;
  }

  const removed = cleanRuns({
    all: options.all,
    olderThanDays: options.olderThanDays,
  });

  logger.success(`Removed ${removed} run workspace${removed !== 1 ? 's' : ''}.`);
}
