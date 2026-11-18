// ---------------------------------------------------------------------------
// mcp_configuration_orchestrator — the project configuration tools'
// workflows: change the bound project's rules (with each code's default
// severity read from the active rule set, so a lowering is told apart and
// must carry its reason), its conformance debt register (with the codes the
// rule set declares carryable) and its own settings. The tool handlers in
// server.ts answer them as text and structured content. Every write goes
// through the core client adapter; the validator adapter supplies the rule set.
// ---------------------------------------------------------------------------

import { listRules } from './adapters/validator.js';
import { reviseRules as applyRulesChange, reviseDebt as applyDebtChange, reviseProject as applyProjectChange } from './adapters/core.js';
import type { DebtChange, DebtRevision, ProjectChange, ProjectRevision, RulesChange, RulesRevision } from '../models/index.js';

/** imcp_configuration_orchestrator.reviseRules — the sdd_update_rules workflow. */
export function reviseRules(change: RulesChange, dryRun: boolean = false): RulesRevision {
  // Step 1: the active rule set, built-ins and loaded pack rules.
  const rules = listRules();
  // Step 2: every code the rule set declares, with its default severity.
  const defaults: Record<string, string> = {};
  for (const rule of rules) for (const code of rule.codes) defaults[code.code] = code.defaultSeverity;
  // Step 3: applied with those defaults, so a lowering needs its reason.
  return applyRulesChange(change, defaults, dryRun);
}

/** imcp_configuration_orchestrator.reviseDebt — the sdd_carry_findings workflow. */
export function reviseDebt(change: DebtChange, dryRun: boolean = false): DebtRevision {
  // Steps 1-2: the codes the active rule set declares carryable.
  const carryable = listRules().flatMap((rule) => rule.codes.filter((code) => code.carryable === true).map((code) => code.code));
  // Step 3: applied to the register, refusing a finding whose code is not carryable.
  return applyDebtChange(change, carryable, dryRun);
}

/** imcp_configuration_orchestrator.reviseProject — the sdd_configure_project workflow. */
export function reviseProject(change: ProjectChange, dryRun: boolean = false): ProjectRevision {
  // Step 1: applied to the project's own settings.
  return applyProjectChange(change, dryRun);
}
