import { z } from 'zod';

// ---------------------------------------------------------------------------
// Run — a single isolated execution unit with its own workspace.
//
// A run is the container for one or more steps. For simple use cases a run
// has exactly one step (wairon run start). For pipelines (Phase 4) a run
// has multiple steps that pass outputs forward.
//
// File locations (all inside .wai/):
//   .wai/runs/<run-id>/status.yaml          ← overall run status + step states
//   .wai/runs/<run-id>/steps/<step-id>/     ← step workspace directory
//     job.yaml                              ← the delegated task
//     result.yaml                           ← written by the sub-agent
//     .claude/                              ← isolated Claude config dir
//       CLAUDE.md                           ← generated context for this step
//       agents/                             ← only domain-relevant agents
//     .gemini/
//       GEMINI.md
// ---------------------------------------------------------------------------

export const RunStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const StepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'abandoned',
  'skipped',
]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const StepSchema = z.object({
  id: z.string(),

  /** Human-readable label for this step */
  label: z.string().optional(),

  status: StepStatusSchema.default('pending'),

  /** Which domain this step operates on (optional — null means project root) */
  domain: z.string().nullable().default(null),

  /** Which AI backend to use */
  backend: z.enum(['claude', 'gemini', 'ollama', 'openai', 'custom']).default('claude'),

  /** Model name for ollama/custom */
  backendModel: z.string().optional(),

  /** The task prompt */
  task: z.string(),

  /** Step ids whose results this step receives as context */
  dependsOn: z.array(z.string()).default([]),

  /** Step ids running in parallel that this step is aware of */
  awareOf: z.array(z.string()).default([]),

  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
});
export type Step = z.infer<typeof StepSchema>;

export const RunSchema = z.object({
  id: z.string(),

  /** Short human-readable label: goal or pipeline name */
  label: z.string().optional(),

  status: RunStatusSchema.default('pending'),

  steps: z.array(StepSchema).default([]),

  /** Pipeline id, if this run was triggered by a pipeline (Phase 4) */
  pipelineId: z.string().optional(),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Run = z.infer<typeof RunSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function generateRunId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `run-${ts}-${rand}`;
}

export function generateStepId(label?: string): string {
  const base = label
    ? label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24)
    : 'step';
  const rand = Math.random().toString(36).slice(2, 5);
  return `${base}-${rand}`;
}
