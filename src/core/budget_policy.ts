import {
  BudgetTier,
  EffortTier,
  ExecutionBudget,
  ExecutionConfig,
  ExecutionProfile,
  ModelTier,
} from '../models/execution.js';

// ---------------------------------------------------------------------------
// Budget policy — maps an execution profile onto an allowance
//
// Still tool-agnostic: this decides "large tier, 40 turns, read-only", never
// "opus". The tier dial lives here so the aggressiveness choice is one
// reviewable place rather than scattered through the exporters.
//
// Ordering rule for the tiers: each one is a strict superset of the
// constraints below it, so raising the tier can only ever tighten the budget.
// That makes the dial safe to turn without auditing every agent.
// ---------------------------------------------------------------------------

const TIER_ORDER: BudgetTier[] = ['off', 'free', 'default', 'trade', 'aggressive'];

function atLeast(tier: BudgetTier, floor: BudgetTier): boolean {
  return TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(floor);
}

/**
 * Capability tier by reasoning depth, before any tier-specific step-down.
 * Deep reasoning starts at `large` rather than `frontier`: the frontier tier
 * is worth reserving for work explicitly marked as such, not handed out to
 * every Orchestrator by default.
 */
function baseModelTier(profile: ExecutionProfile): ModelTier {
  switch (profile.reasoningDepth) {
    case 'mechanical':
      return 'small';
    case 'standard':
      return 'standard';
    case 'deep':
      return 'large';
  }
}

const TIER_STEPS: ModelTier[] = ['small', 'standard', 'large', 'frontier'];

function stepDown(tier: ModelTier, steps: number): ModelTier {
  const i = TIER_STEPS.indexOf(tier);
  return TIER_STEPS[Math.max(0, i - steps)];
}

/**
 * Turn ceiling by breadth. A wide survey legitimately needs more turns than a
 * focused implementation; the point is that neither is unbounded.
 *
 * These are circuit breakers sized well above normal completion, not targets.
 */
function maxTurnsFor(profile: ExecutionProfile, tier: BudgetTier): number | undefined {
  if (!atLeast(tier, 'default')) return undefined;

  const ceiling = profile.breadth === 'wide' ? 60 : profile.breadth === 'moderate' ? 40 : 25;

  return atLeast(tier, 'aggressive') ? Math.round(ceiling / 2) : ceiling;
}

function effortFor(profile: ExecutionProfile, tier: BudgetTier): EffortTier | undefined {
  if (!atLeast(tier, 'trade')) return undefined;
  // Only mechanical work gets its effort reduced. Lowering effort on work that
  // carries judgment is the change most likely to cost more than it saves, by
  // turning one good pass into two mediocre ones.
  if (profile.reasoningDepth === 'mechanical') {
    return atLeast(tier, 'aggressive') ? 'low' : 'medium';
  }
  return undefined;
}

/**
 * Derivation produces only `read-only` and `implement`.
 *
 * `orchestrate` — the thin grant that withholds bulk-content tools from a pure
 * router — is deliberately NOT derived. Every agent in a wairon topology owns
 * and authors something: domain owners write the specs and source they own,
 * and even a chained-subproject owner writes its mount spec. Stripping their
 * write tools would not make them cheaper, it would make them broken.
 *
 * The genuine pure router in this workflow is the human's own main session,
 * which is not a wairon agent at all. So `orchestrate` stays in the vocabulary
 * as an override-selectable class for a manager someone defines by hand, and
 * derivation never assigns it.
 */
function toolClassFor(profile: ExecutionProfile): ExecutionBudget['toolClass'] {
  return profile.writes ? 'implement' : 'read-only';
}

function mcpFor(profile: ExecutionProfile, tier: BudgetTier): ExecutionBudget['mcp'] {
  if (!atLeast(tier, 'free')) return 'all';
  // Spec-tree tools are what managers and architects reason WITH. Everyone
  // else is implementing against a brief that already quotes the contract, so
  // loading the full MCP schema set on them is pure startup weight.
  if (profile.delegates) return 'project';
  return profile.breadth === 'wide' ? 'project' : 'none';
}

/**
 * Resolve the budget for one agent.
 *
 * Returns undefined at tier `off`, which is the default — enabling this
 * feature must never silently change an existing project's generated output.
 */
export function resolveBudget(
  profile: ExecutionProfile,
  config: ExecutionConfig,
  agentId: string,
): ExecutionBudget | undefined {
  const tier = config.tier;
  if (tier === 'off') return undefined;

  let modelTier = baseModelTier(profile);

  if (atLeast(tier, 'trade') && profile.reasoningDepth === 'standard') {
    modelTier = stepDown(modelTier, 1);
  }
  if (atLeast(tier, 'aggressive') && profile.reasoningDepth !== 'deep') {
    modelTier = 'small';
  }
  const budget: ExecutionBudget = {
    // At `free` no model selection is expressed at all — that tier is defined
    // as having no quality tradeoff, and choosing a model is a quality
    // decision. Leaving it absent is not the same as choosing a default.
    modelTier: atLeast(tier, 'default') ? modelTier : undefined,
    effort: effortFor(profile, tier),
    maxTurns: maxTurnsFor(profile, tier),
    toolClass: toolClassFor(profile),
    // Only managers may spawn. Withholding the tool from workers is what stops
    // a worker quietly becoming a second orchestrator three levels down.
    allowNestedDelegation: profile.delegates,
    mcp: mcpFor(profile, tier),
  };

  const override = config.overrides[agentId];
  return override ? { ...budget, ...override } : budget;
}

/**
 * Human-readable lines describing an allowance, for briefs and CLI output.
 *
 * Speaks in capability TIERS, never model names — the consumer maps a tier
 * onto whatever its host tool understands, and only the consumer knows that.
 * Keeping the mapping out of here is what lets one brief serve a Claude Code
 * session, a hosted MCP client, and a tool that cannot pick models at all.
 */
export function describeBudget(profile: ExecutionProfile, budget: ExecutionBudget): string[] {
  const lines = [
    `- **Work shape**: ${profile.breadth} breadth, ${profile.reasoningDepth} reasoning${profile.writes ? '' : ', read-only'}${profile.delegates ? ', delegating' : ''}`,
    `- **Why**: ${profile.rationale}`,
  ];
  if (budget.modelTier) lines.push(`- **Capability tier**: ${budget.modelTier}`);
  if (budget.effort) lines.push(`- **Effort**: ${budget.effort}`);
  if (budget.maxTurns !== undefined) {
    lines.push(`- **Turn ceiling**: ${budget.maxTurns} (a circuit breaker — hitting it should read as a scoping error, not a limit to work up to)`);
  }
  lines.push(`- **Tool grant**: ${budget.toolClass}`);
  lines.push(`- **May delegate further**: ${budget.allowNestedDelegation ? 'yes' : 'no'}`);
  lines.push(`- **MCP access**: ${budget.mcp}`);
  return lines;
}
