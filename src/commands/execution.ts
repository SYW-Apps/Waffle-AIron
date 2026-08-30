import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import { isProjectInitialized, loadProjectConfig, saveProjectConfig } from '../config/loader.js';
import { resolveAgentTopology } from '../core/agent_resolver.js';
import { deriveExecutionProfile } from '../core/execution_profile.js';
import { resolveBudget } from '../core/budget_policy.js';
import {
  BUDGET_TIER_DESCRIPTIONS,
  BudgetTier,
  BudgetTierSchema,
  ModelTier,
} from '../models/execution.js';

// ---------------------------------------------------------------------------
// execution command — the resource axis of the topology
//
// Shows what each agent's work is like and what that earns it, and moves the
// aggressiveness dial. The dial is the only quality-affecting knob here, so
// `set-tier` states what the new tier costs rather than silently applying it.
// ---------------------------------------------------------------------------

function assertInitialized(): void {
  if (!isProjectInitialized()) {
    throw new WaironError('Not a wairon project — run `wairon init` first.');
  }
}

const TIER_COLOR: Record<ModelTier, (s: string) => string> = {
  small: chalk.green,
  standard: chalk.cyan,
  large: chalk.yellow,
  frontier: chalk.red,
};

export async function showExecution(): Promise<void> {
  assertInitialized();
  const config = loadProjectConfig();
  const tier = config.execution.tier;

  logger.header('Execution budgets');
  logger.info(`Tier: ${tier === 'off' ? chalk.gray(tier) : chalk.bold(tier)}`);
  logger.info(chalk.gray(BUDGET_TIER_DESCRIPTIONS[tier]));

  if (tier === 'off') {
    logger.blank();
    logger.info('No budgets are derived. Generated agent files and briefs carry');
    logger.info('what they carried before this feature existed.');
    logger.info(`Enable with ${chalk.bold('wairon execution set-tier default')}.`);
    return;
  }

  const agents = resolveAgentTopology();
  if (agents.length === 0) {
    logger.blank();
    logger.warn('No agents in the topology yet — nothing to budget.');
    return;
  }

  logger.blank();
  const rows = agents.map((agent) => {
    const profile = deriveExecutionProfile(agent);
    const budget = resolveBudget(profile, config.execution, agent.id);
    return { agent, profile, budget };
  });

  const idWidth = Math.max(...rows.map((r) => r.agent.id.length));
  for (const { agent, profile, budget } of rows) {
    if (!budget) continue;
    const model = budget.modelTier
      ? TIER_COLOR[budget.modelTier](budget.modelTier.padEnd(9))
      : chalk.gray('(inherit)');
    const overridden = config.execution.overrides[agent.id] ? chalk.magenta(' *override') : '';
    logger.info(
      `  ${agent.id.padEnd(idWidth)}  ${model} ${chalk.gray(
        `${budget.toolClass}, ${budget.maxTurns ?? '-'} turns, mcp:${budget.mcp}` +
          `${budget.effort ? `, effort:${budget.effort}` : ''}`,
      )}${overridden}`,
    );
    logger.info(`  ${' '.repeat(idWidth)}  ${chalk.gray(profile.rationale)}`);
  }

  const overrideCount = Object.keys(config.execution.overrides).length;
  if (overrideCount > 0) {
    logger.blank();
    logger.info(chalk.magenta(`${overrideCount} per-agent override(s) in .wai/project.yaml.`));
  }

  // A derived budget never selects the frontier tier. One that appears here
  // came from an override, and that is worth surfacing for the same reason a
  // god-component warning is: it usually means the component is doing too much.
  const frontier = rows.filter((r) => r.budget?.modelTier === 'frontier');
  if (frontier.length > 0) {
    logger.blank();
    logger.warn(
      `${frontier.length} agent(s) are pinned to the frontier tier by override: ` +
        `${frontier.map((r) => r.agent.id).join(', ')}.`,
    );
    logger.warn(
      'Frontier is a sparring partner for questions the specs do not settle, not an owner tier. ' +
        'An owner that genuinely needs it usually points at a component doing too much — consider splitting it.',
    );
  }
}

export async function setExecutionTier(raw: string): Promise<void> {
  assertInitialized();

  const parsed = BudgetTierSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WaironError(
      `Unknown tier "${raw}" — expected one of: ${BudgetTierSchema.options.join(', ')}.`,
    );
  }
  const tier: BudgetTier = parsed.data;

  const config = loadProjectConfig();
  const previous = config.execution.tier;
  if (previous === tier) {
    logger.info(`Execution tier is already ${chalk.bold(tier)}.`);
    return;
  }

  config.execution = { ...config.execution, tier };
  saveProjectConfig(config);

  logger.success(`Execution tier: ${chalk.gray(previous)} → ${chalk.bold(tier)}`);
  logger.info(BUDGET_TIER_DESCRIPTIONS[tier]);
  logger.blank();
  logger.info(`Run ${chalk.bold('wairon execution show')} to see what each agent now gets,`);
  logger.info(`then ${chalk.bold('wairon generate')} to write it into agent files (if materialized).`);

  if (tier === 'trade' || tier === 'aggressive') {
    logger.blank();
    logger.warn(
      'This tier trades quality for cost. Measure on real work before keeping it — ' +
        'a cheaper delegation that needs a second round trip is not cheaper.',
    );
  }
}
