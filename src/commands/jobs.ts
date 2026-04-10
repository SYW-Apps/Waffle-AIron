import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized } from '../config/loader.js';
import { listJobs, loadJob, loadJobResult, cleanJobs } from '../core/jobs.js';
import { Job } from '../models/job.js';

// ---------------------------------------------------------------------------
// jobs commands — inspect and manage the job/result audit trail
// ---------------------------------------------------------------------------

export async function runJobsList(options: { domain?: string; status?: string } = {}): Promise<void> {
  assertProjectInitialized();

  let jobs = listJobs();

  if (options.domain) {
    jobs = jobs.filter((j) => j.domain === options.domain);
  }
  if (options.status) {
    jobs = jobs.filter((j) => j.status === options.status);
  }

  if (jobs.length === 0) {
    logger.info('No jobs found.');
    return;
  }

  logger.header(`Jobs (${jobs.length})`);
  logger.blank();

  for (const job of jobs) {
    printJobLine(job);
  }
}

export async function runJobsShow(jobId: string): Promise<void> {
  assertProjectInitialized();

  const job = loadJob(jobId);
  const result = loadJobResult(jobId);

  logger.header(`Job: ${job.id}`);
  logger.blank();

  console.log(`${chalk.bold('Status:')}   ${statusColor(job.status)}`);
  console.log(`${chalk.bold('Domain:')}   ${job.domain} (${job.domainPath})`);
  console.log(`${chalk.bold('Backend:')}  ${job.backend}${job.backendModel ? ' / ' + job.backendModel : ''}`);
  console.log(`${chalk.bold('Created:')}  ${job.createdAt}`);
  if (job.startedAt) console.log(`${chalk.bold('Started:')}  ${job.startedAt}`);
  if (job.completedAt) console.log(`${chalk.bold('Finished:')} ${job.completedAt}`);
  logger.blank();

  console.log(chalk.bold('Task:'));
  console.log(job.task);

  if (job.context.files.length > 0 || job.context.notes.length > 0) {
    logger.blank();
    console.log(chalk.bold('Context:'));
    for (const f of job.context.files) console.log(`  file: ${chalk.cyan(f)}`);
    for (const n of job.context.notes) console.log(`  note: ${n}`);
  }

  if (result) {
    logger.blank();
    console.log(chalk.bold('Result:'));
    console.log(chalk.gray('─'.repeat(40)));
    console.log(result.summary);

    if (result.filesChanged.length > 0) {
      logger.blank();
      console.log(chalk.bold('Files changed:'));
      for (const f of result.filesChanged) console.log(`  ${chalk.cyan(f)}`);
    }

    if (result.flagged) {
      logger.blank();
      console.log(chalk.bold('Flagged:'));
      console.log(chalk.yellow(result.flagged));
    }
  }

  logger.blank();
}

export async function runJobsClean(options: { all?: boolean } = {}): Promise<void> {
  assertProjectInitialized();

  const keepStatuses: Job['status'][] = options.all ? [] : ['pending', 'running'];
  const cleaned = cleanJobs(keepStatuses);

  if (cleaned === 0) {
    logger.info('Nothing to clean.');
  } else {
    logger.success(`Cleaned ${cleaned} job(s).`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printJobLine(job: Job): void {
  const age = timeAgo(job.createdAt);
  console.log(
    `${chalk.bold(job.id)}  ${statusColor(job.status)}  ${chalk.gray(job.domain)}  ${chalk.gray(age)}`,
  );
  const preview = job.task.length > 70 ? job.task.slice(0, 70) + '...' : job.task;
  console.log(`  ${chalk.gray(preview)}`);
  console.log();
}

function statusColor(status: Job['status']): string {
  switch (status) {
    case 'pending': return chalk.yellow(status);
    case 'running': return chalk.blue(status);
    case 'completed': return chalk.green(status);
    case 'failed': return chalk.red(status);
    case 'abandoned': return chalk.gray(status);
  }
}

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
