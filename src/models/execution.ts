import { z } from 'zod';

// ---------------------------------------------------------------------------
// Execution profiles and budgets — the RESOURCE axis of the topology
//
// wairon already derives AUTHORITY from the spec tree: which agent owns which
// paths, who may write what. A budget is the same shape of fact about the same
// units — what this unit's work COSTS to do — and the tree already carries
// everything needed to infer it (stereotype, owned-path breadth, whether the
// component's methods write, dependency fan-out).
//
// Two deliberate boundaries hold this file tool-agnostic:
//
//  1. An ExecutionProfile describes the WORK, never the tooling. It says
//     "wide breadth, mechanical reasoning" — never "haiku". A profile is as
//     meaningful to a hosted MCP consumer with no subagents as it is to a
//     local Claude Code session.
//
//  2. An ExecutionBudget names capability TIERS, not vendor models. Mapping
//     `modelTier: 'small'` onto a concrete model id is an exporter's job,
//     because only the exporter knows what the host tool understands.
//
// wairon describes and emits. It never runs anything — see core/skills.ts:
// "Skills are how wairon equips a session — it does not orchestrate sessions
// itself." The same guard applies here.
// ---------------------------------------------------------------------------

/**
 * How much of the tree this agent must READ to do its job. Derived from
 * owned-path breadth and whether the agent's role is inherently surveying.
 */
export const WorkBreadthSchema = z.enum(['narrow', 'moderate', 'wide']);
export type WorkBreadth = z.infer<typeof WorkBreadthSchema>;

/**
 * How much judgment the work carries. Derived from the component stereotype:
 * the vocabulary already encodes this — a Store is plumbing fully described by
 * its L3/L5, an Orchestrator carries the decision logic.
 */
export const ReasoningDepthSchema = z.enum(['mechanical', 'standard', 'deep']);
export type ReasoningDepth = z.infer<typeof ReasoningDepthSchema>;

export const ExecutionProfileSchema = z.object({
  /** How much of the tree the agent must read. */
  breadth: WorkBreadthSchema,

  /** Whether the agent modifies files at all. Read-only agents are cheap and safe. */
  writes: z.boolean(),

  /** How much judgment the work carries. */
  reasoningDepth: ReasoningDepthSchema,

  /**
   * Whether this agent is a MANAGER — its job is to route work to others
   * rather than perform it. Managers must stay thin: a manager that reads
   * files accumulates context exactly like a main session and stops being
   * cheaper than doing the work inline.
   */
  delegates: z.boolean(),

  /** Why the profile came out this way — surfaced in briefs and `wairon analyze`. */
  rationale: z.string(),
});

export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;

// ---------------------------------------------------------------------------
// Budget — the derived allowance
// ---------------------------------------------------------------------------

/**
 * Capability tier, not a model id. Exporters map these onto whatever their
 * host tool understands; a target that cannot express model selection simply
 * drops the field.
 */
export const ModelTierSchema = z.enum(['small', 'standard', 'large', 'frontier']);
export type ModelTier = z.infer<typeof ModelTierSchema>;

/** Reasoning-effort tier, where the host tool supports one. */
export const EffortTierSchema = z.enum(['low', 'medium', 'high', 'xhigh']);
export type EffortTier = z.infer<typeof EffortTierSchema>;

/**
 * The shape of a tool grant, named by intent rather than by any one tool's
 * tool names. Exporters translate to concrete allowlists.
 */
export const ToolClassSchema = z.enum(['read-only', 'implement', 'orchestrate', 'full']);
export type ToolClass = z.infer<typeof ToolClassSchema>;

/** Whether the agent needs the project's MCP surface loaded at all. */
export const McpAccessSchema = z.enum(['none', 'project', 'all']);
export type McpAccess = z.infer<typeof McpAccessSchema>;

export const ExecutionBudgetSchema = z.object({
  /**
   * Absent means "express no model choice" — the `free` tier is defined as
   * having no quality tradeoff, and picking a model is a quality decision.
   * Exporters must omit the field entirely rather than substituting a default.
   */
  modelTier: ModelTierSchema.optional(),
  effort: EffortTierSchema.optional(),

  /**
   * Turn ceiling — a circuit breaker, not a target. Its purpose is to stop the
   * runaway case: a subagent that runs hundreds of turns while accumulating
   * context is no longer preserving the parent's context, it is a second
   * expensive session. Hitting the ceiling returns partial output, which is
   * the intended failure mode.
   */
  maxTurns: z.number().int().positive().optional(),

  toolClass: ToolClassSchema,

  /**
   * Whether this agent may spawn its own subagents. False withholds the
   * delegation tool entirely — structural enforcement, so no instruction text
   * has to be carried (and re-read) to achieve it.
   */
  allowNestedDelegation: z.boolean(),

  mcp: McpAccessSchema,
});

export type ExecutionBudget = z.infer<typeof ExecutionBudgetSchema>;

// ---------------------------------------------------------------------------
// Policy tiers — the configurable aggressiveness dial
//
// Each tier names what it costs in quality. Defaults ship at `default`;
// everything past it is opt-in and the docs say why.
// ---------------------------------------------------------------------------

export const BudgetTierSchema = z.enum(['off', 'free', 'default', 'trade', 'aggressive']);
export type BudgetTier = z.infer<typeof BudgetTierSchema>;

export const BUDGET_TIER_DESCRIPTIONS: Record<BudgetTier, string> = {
  off: 'No budget emitted. Generated agent files carry name and description only, as before this feature existed.',
  free: 'Structural constraints only — tool classes, MCP scoping, nested-delegation control. No model or effort selection, so no quality tradeoff of any kind.',
  default: 'Adds capability-tier selection per role and turn ceilings. Mechanical work runs on smaller models; deep reasoning keeps the large tier.',
  trade: 'Adds effort reduction on mechanical work and pushes standard work down a tier. Real but bounded quality cost; measure before adopting.',
  aggressive: 'Small tier for everything but deep reasoning, tight turn ceilings. Expect partial results and worse judgment. Opt in deliberately.',
};

export const ExecutionConfigSchema = z.object({
  /**
   * How hard to optimize. `off` preserves pre-feature output exactly, so
   * enabling this feature can never silently change an existing project's
   * generated files.
   */
  tier: BudgetTierSchema.default('off'),

  /**
   * Per-agent overrides, keyed by agent id. An explicit budget always wins
   * over derivation — the tree is a good default, not an authority on how
   * you want to spend.
   */
  overrides: z.record(ExecutionBudgetSchema.partial()).default({}),
});

export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;
