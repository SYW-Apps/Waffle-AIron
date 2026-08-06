import { SddRule, RuleCode } from './types.js';
import { SDD_RULES } from './index.js';
import { lintAllowsRule } from './lint-allows.js';

// ---------------------------------------------------------------------------
// Rule repository (rule_store + rule_registry + rule_index + rule_repository).
// The in-memory rule set for one validation run: the built-in rules plus any
// programmatic pack rules, in registration order. A ram-projection — reseeded
// each run, never persisted. `wairon rules list` and the validator read the
// composed run sequence and the aggregate known-code set from here.
// ---------------------------------------------------------------------------

let ruleSet: SddRule[] = [];

/** rule_store: append a rule to the held set (registration order preserved). Repository-internal. */
function addRule(rule: SddRule): void {
  ruleSet.push(rule);
}

/** rule_store: return the held rules in registration order. Repository-internal. */
function listRules(): SddRule[] {
  return ruleSet;
}

/** rule_registry: seed the built-in SDD rule set, resetting the set for a fresh run. */
export function registerBuiltinRules(): void {
  ruleSet = [];
  for (const rule of SDD_RULES) addRule(rule);
}

/** rule_registry: register programmatic pack rules after the built-ins (project pack order is precedence). */
export function registerPackRules(packRules: SddRule[]): void {
  for (const rule of packRules) addRule(rule);
}

/** rule_index: the ordered run sequence — registration order with the lint-allows audit forced last. */
export function ruleSequence(): SddRule[] {
  const base = ruleSet.filter(r => r !== lintAllowsRule);
  return ruleSet.includes(lintAllowsRule) ? [...base, lintAllowsRule] : base;
}

/**
 * rule_index: the registered rules that are INTRINSIC to a single spec
 * (`scope: 'spec'`) — those whose verdict reads a spec's own fields and no
 * cross-spec relationship. This is the subset the candidate validator runs
 * against a not-yet-written spec, so the default ('tree') is the safe answer: a
 * rule that has not declared itself intrinsic is never handed a one-spec
 * context. Pack rules participate on the same terms.
 */
export function specScopedRules(): SddRule[] {
  return ruleSequence().filter(r => r.scope === 'spec');
}

/** rule_index: every issue code any registered rule can emit — the lint.allow validation set. */
export function knownIssueCodes(): RuleCode[] {
  return listRules().flatMap(r => r.codes);
}
