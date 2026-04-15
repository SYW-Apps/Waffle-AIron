import { spawn } from 'child_process';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { fromProjectRoot } from '../utils/fs.js';
import { assertProjectInitialized, loadProjectConfig } from '../config/loader.js';
import { resolveToolCommand } from '../config/profiles.js';
import { findDomain } from '../core/domains.js';
import { createJob, updateJobStatus, loadJobResult, jobEnvVars } from '../core/jobs.js';

// ---------------------------------------------------------------------------
// delegate command
//
// Spawns an AI coding tool (claude, gemini, etc.) in a domain's directory,
// passing a task via the job handoff protocol.
//
// The subprocess runs with stdio:inherit — the user sees everything and can
// interact directly. The job file is created before spawn and the result file
// is read after the session exits.
//
// Usage:
//   wairon delegate <domain-id> --prompt "fix the JWT bug"
//   wairon delegate core-utils --backend ollama --model codellama:13b --async
// ---------------------------------------------------------------------------

export interface DelegateOptions {
  prompt?: string;
  backend?: string;
  model?: string;
  async?: boolean;
  contextFiles?: string[];
  notes?: string[];
  createdBy?: string;
}

export async function runDelegate(domainId: string, options: DelegateOptions = {}): Promise<void> {
  assertProjectInitialized();
  const projectConfig = loadProjectConfig();

  const domain = findDomain(domainId);
  if (!domain) {
    logger.error(`Domain "${domainId}" not found. Run \`wairon domains list\` to see available domains.`);
    process.exit(1);
  }

  if (domain.status !== 'active') {
    logger.warn(`Domain "${domainId}" is ${domain.status}. Proceeding anyway.`);
  }

  // -----------------------------------------------------------------------
  // Build and write the job file
  // -----------------------------------------------------------------------

  const backend = options.backend ?? 'claude';
  const task = options.prompt ?? '(no task specified — check job file)';

  const job = createJob({
    domain: domain.id,
    domainPath: domain.path,
    createdBy: options.createdBy ?? 'user',
    backend: backend as Job['backend'],
    backendModel: options.model,
    task,
    context: {
      files: options.contextFiles ?? [],
      notes: options.notes ?? [],
    },
  });

  logger.blank();
  logger.success(`Job created: ${chalk.bold(job.id)}`);
  logger.info(`Domain:  ${domain.name} (${domain.path})`);
  logger.info(`Backend: ${backend}${options.model ? ` / ${options.model}` : ''}`);
  logger.info(`Task:    ${task.length > 80 ? task.slice(0, 80) + '...' : task}`);
  logger.blank();

  // -----------------------------------------------------------------------
  // Async mode: just create the job and return
  // -----------------------------------------------------------------------

  if (options.async) {
    logger.info(`Async mode — session not started automatically.`);
    logger.info(`To start manually:`);
    logger.info(`  cd ${domain.path}`);
    logger.info(`  ${resolveToolCommand(backend, projectConfig.profile)}`);
    logger.info(`Job file: .wai/jobs/${job.id}.yaml`);
    return;
  }

  // -----------------------------------------------------------------------
  // Sync mode: spawn the AI tool in the domain directory
  // -----------------------------------------------------------------------

  const domainAbsPath = fromProjectRoot(domain.path);
  const cmd = resolveToolCommand(backend, projectConfig.profile);
  const env = { ...process.env, ...jobEnvVars(job) };

  logger.info(`Starting ${chalk.bold(cmd)} in ${chalk.cyan(domain.path)}`);
  logger.info(chalk.gray('─── subprocess start ────────────────────────────────────────────'));
  logger.blank();

  updateJobStatus(job.id, 'running');

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(cmd, [], {
      cwd: domainAbsPath,
      stdio: 'inherit',
      shell: true,
      env,
    });

    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      logger.error(`Failed to start ${cmd}: ${err.message}`);
      logger.info(`Is ${cmd} installed and on your PATH?`);
      resolve(1);
    });
  });

  logger.blank();
  logger.info(chalk.gray('─── subprocess end ──────────────────────────────────────────────'));
  logger.blank();

  // -----------------------------------------------------------------------
  // Read and display the result
  // -----------------------------------------------------------------------

  const result = loadJobResult(job.id);

  if (result) {
    updateJobStatus(job.id, 'completed');
    logger.success(`Job completed: ${job.id}`);
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
    // Session exited without writing a result
    if (exitCode === 0) {
      updateJobStatus(job.id, 'abandoned');
      logger.warn(`Session ended without writing a result file.`);
      logger.info(`Job status set to: abandoned`);
    } else {
      updateJobStatus(job.id, 'failed');
      logger.warn(`Session exited with code ${exitCode}.`);
    }
    logger.info(`Job file: .wai/jobs/${job.id}.yaml`);
  }

  logger.blank();
}

import type { Job } from '../models/job.js';
