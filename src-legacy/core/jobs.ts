import * as path from 'path';
import { Job, JobResult, JobSchema, JobResultSchema, generateJobId } from '../models/job.js';
import { AI_PATHS } from '../config/loader.js';
import { ensureDir, listFiles, pathExists } from '../utils/fs.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';
import { WaironError } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Job file management
//
// Jobs live at:  .wai/jobs/<job-id>.yaml
// Results live at: .wai/jobs/<job-id>.result.yaml
// ---------------------------------------------------------------------------

function jobFilePath(jobId: string): string {
  return path.join(AI_PATHS.jobsDir(), `${jobId}.yaml`);
}

function resultFilePath(jobId: string): string {
  return path.join(AI_PATHS.jobsDir(), `${jobId}.result.yaml`);
}

export function createJob(partial: Omit<Job, 'id' | 'status' | 'createdAt'>): Job {
  ensureDir(AI_PATHS.jobsDir());
  const job = JobSchema.parse({
    id: generateJobId(),
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...partial,
  });
  writeYamlFile(jobFilePath(job.id), job);
  return job;
}

export function loadJob(jobId: string): Job {
  const raw = readYamlFile(jobFilePath(jobId));
  if (!raw) throw new WaironError(`Job "${jobId}" not found.`);
  return JobSchema.parse(raw);
}

export function updateJobStatus(jobId: string, status: Job['status']): void {
  const job = loadJob(jobId);
  const updated = { ...job, status };
  if (status === 'running') updated.startedAt = new Date().toISOString();
  if (status === 'completed' || status === 'failed' || status === 'abandoned') {
    updated.completedAt = new Date().toISOString();
  }
  writeYamlFile(jobFilePath(jobId), updated);
}

export function writeJobResult(result: JobResult): void {
  ensureDir(AI_PATHS.jobsDir());
  writeYamlFile(resultFilePath(result.jobId), result);
  // Also update the job status
  try {
    updateJobStatus(result.jobId, result.status === 'failed' ? 'failed' : 'completed');
  } catch {
    // Job file may not exist if result was written externally
  }
}

export function loadJobResult(jobId: string): JobResult | null {
  const raw = readYamlFile(resultFilePath(jobId));
  if (!raw) return null;
  return JobResultSchema.parse(raw);
}

export function listJobs(): Job[] {
  const files = listFiles(AI_PATHS.jobsDir(), '.yaml').filter(
    (f) => !f.endsWith('.result.yaml'),
  );
  return files
    .map((f) => {
      try {
        return JobSchema.parse(readYamlFile(f));
      } catch {
        return null;
      }
    })
    .filter((j): j is Job => j !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function cleanJobs(keepStatuses: Job['status'][] = ['pending', 'running']): number {
  const jobs = listJobs();
  let cleaned = 0;

  for (const job of jobs) {
    if (!keepStatuses.includes(job.status)) {
      try {
        const { unlinkSync } = require('fs') as typeof import('fs');
        const jf = jobFilePath(job.id);
        const rf = resultFilePath(job.id);
        if (pathExists(jf)) { unlinkSync(jf); cleaned++; }
        if (pathExists(rf)) unlinkSync(rf);
      } catch {
        // best effort
      }
    }
  }

  return cleaned;
}

export function jobEnvVars(job: Job): Record<string, string> {
  return {
    WAIRON_JOB_ID: job.id,
    WAIRON_JOB_FILE: path.resolve(jobFilePath(job.id)),
    WAIRON_RESULT_FILE: path.resolve(resultFilePath(job.id)),
    WAIRON_DOMAIN: job.domain,
  };
}
