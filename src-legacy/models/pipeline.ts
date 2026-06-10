import { z } from 'zod';

// ---------------------------------------------------------------------------
// Pipeline definition
//
// Pipelines are YAML files under .wai/pipelines/<id>.yaml.
// They define a DAG of steps — each step is either an AI session or a shell
// command. Steps declare their dependencies (for sequential ordering) and
// which parallel steps they are aware of (for cross-agent coordination).
//
// Template variables ({{goal}}, {{ticket}}, etc.) are interpolated at run
// time from values passed with `wairon pipeline run <id> --var key=value`.
// ---------------------------------------------------------------------------

export const PipelineStepSchema = z.object({
  /** Unique id within the pipeline — used for dependency references */
  id: z.string(),

  /** Human-readable label */
  label: z.string().optional(),

  /**
   * Step type:
   *   'ai'    — spawn an AI tool session (default)
   *   'shell' — run a shell command (validation gate, test runner, etc.)
   */
  type: z.enum(['ai', 'shell']).default('ai'),

  /**
   * AI backend (ai steps only).
   * Defaults to the project's defaultBackend.
   */
  backend: z.enum(['claude', 'gemini', 'ollama', 'openai', 'custom']).optional(),

  /** Model name (ollama/custom backends) */
  model: z.string().optional(),

  /** Domain to scope this step to (ai steps only) */
  domain: z.string().optional(),

  /**
   * Task prompt (ai steps) or shell command (shell steps).
   * May contain {{variable}} placeholders.
   */
  task: z.string(),

  /**
   * Step ids that must complete (status: completed) before this step starts.
   * Forms the sequential dependency graph.
   */
  dependsOn: z.array(z.string()).default([]),

  /**
   * Step ids that will run in parallel with this step.
   * Their job file paths are injected into this step's context file under
   * "Parallel Work Awareness". Implies no ordering constraint.
   */
  awareOf: z.array(z.string()).default([]),

  /**
   * Whether to continue the pipeline if this step fails.
   * Default: false (any failure stops the pipeline).
   */
  continueOnFailure: z.boolean().default(false),
});
export type PipelineStep = z.infer<typeof PipelineStepSchema>;

export const PipelineSchema = z.object({
  /** Unique pipeline identifier — matches the filename (without .yaml) */
  id: z.string(),

  /** Human-readable name shown in `wairon pipeline list` */
  name: z.string(),

  /** Optional description */
  description: z.string().optional(),

  /** Steps in definition order (execution order determined by dependsOn graph) */
  steps: z.array(PipelineStepSchema).min(1),

  /**
   * Variables declared by this pipeline.
   * Users pass values with `--var key=value` at run time.
   * Declare here to document them; values may include defaults.
   */
  variables: z.record(z.object({
    description: z.string().optional(),
    default:     z.string().optional(),
  })).optional(),
});
export type Pipeline = z.infer<typeof PipelineSchema>;
