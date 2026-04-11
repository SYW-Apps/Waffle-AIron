import { z } from 'zod';

// ---------------------------------------------------------------------------
// Job — a delegated task sent from one domain to another
//
// Jobs are the file-based handoff protocol between agent sessions.
// A parent agent (or user) creates a job; a child agent in the target domain
// executes it and writes the result. The protocol is async-capable and
// creates a full audit trail in .wai/jobs/.
//
// File locations:
//   Job:    .wai/jobs/<job-id>.yaml       (written by delegator)
//   Result: .wai/jobs/<job-id>.result.yaml (written by sub-agent)
// ---------------------------------------------------------------------------

export const JobStatusSchema = z.enum([
  'pending',    // created, waiting to be picked up
  'running',    // sub-agent session is active
  'completed',  // sub-agent finished and wrote result
  'failed',     // sub-agent encountered an unrecoverable error
  'abandoned',  // session exited without writing a result
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobSchema = z.object({
  id: z.string(),

  status: JobStatusSchema.default('pending'),

  /** Target domain id */
  domain: z.string(),

  /** Resolved path to the domain directory (relative to project root) */
  domainPath: z.string(),

  /**
   * Which agent or user created this job.
   * Format: agent id (e.g. "core-service-owner") or "user"
   */
  createdBy: z.string().default('user'),

  /** Which AI backend to use when spawning the sub-session */
  backend: z.enum(['claude', 'gemini', 'ollama', 'openai', 'custom']).default('claude'),

  /** For custom/ollama backend — the model name or URL */
  backendModel: z.string().optional(),

  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),

  /** The task description — what the sub-agent should do */
  task: z.string(),

  /** Additional context to include in the job brief */
  context: z.object({
    /** Relevant file paths the sub-agent should be aware of */
    files: z.array(z.string()).default([]),
    /** Free-form notes, constraints, or background */
    notes: z.array(z.string()).default([]),
  }).default({}),

  /** What the delegator expects back */
  expectedOutput: z.string().optional(),
});

export type Job = z.infer<typeof JobSchema>;

// ---------------------------------------------------------------------------
// Job result — written by the sub-agent when done
// ---------------------------------------------------------------------------

export const JobResultStatusSchema = z.enum(['completed', 'failed', 'partial']);
export type JobResultStatus = z.infer<typeof JobResultStatusSchema>;

export const JobResultSchema = z.object({
  jobId: z.string(),

  status: JobResultStatusSchema,

  completedAt: z.string().datetime(),

  /**
   * Human-readable summary of what was done.
   * This is what surfaces to the parent agent — keep it concise and informative.
   */
  summary: z.string(),

  /** Files that were created or modified */
  filesChanged: z.array(z.string()).default([]),

  /**
   * Observations that were out of scope but worth flagging to the parent.
   * The sub-agent noticed something but deliberately did not act on it.
   */
  flagged: z.string().optional(),

  /** Populated if status is 'failed' — what went wrong */
  errorDetail: z.string().optional(),
});

export type JobResult = z.infer<typeof JobResultSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function generateJobId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `job-${ts}-${rand}`;
}
