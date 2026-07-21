// ---------------------------------------------------------------------------
// Rule-authoring contract (the code-pack compile target).
//
// Code packs are written against `@wairon/sdk`, never against wairon core. This
// is a small, stable, hand-authored facade — deliberately NOT core's fat
// RuleContext. `defineRule` returns the rule unchanged (identity + type
// inference); the runtime shape `{ name, description?, codes: string[], check }`
// is exactly what the core extension loader duck-types.
// ---------------------------------------------------------------------------

/** Severity of a finding a pack rule emits. */
export type RuleSeverity = 'error' | 'warning';

/** A single issue a pack rule reports about the spec tree. */
export interface Finding {
  /** Pack-local issue code (surfaced namespaced by wairon, e.g. `<PACK>_<CODE>`). */
  code: string;
  /** 'error' | 'warning'. */
  severity: RuleSeverity;
  /** Human-readable explanation of the violation. */
  message: string;
  /** The spec id the finding is anchored to (optional). */
  specId?: string;
}

/**
 * A read-only spec node as seen by a pack rule: its id/name plus arbitrary
 * further fields (kept open so the facade stays stable as the spec model grows).
 */
export interface RuleSpecNode {
  id: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * The minimal, stable view of the spec tree a code-pack rule inspects. A rule
 * reads these collections and returns findings — it never mutates state and
 * never reaches into wairon core internals.
 */
export interface RuleContext {
  /** The L0 system spec. */
  system: RuleSpecNode;
  /** All L1 subsystem specs. */
  subsystems: RuleSpecNode[];
  /** All L2 component specs. */
  components: RuleSpecNode[];
  /** All L3 interface specs. */
  interfaces: RuleSpecNode[];
  /** All L4 implementation specs. */
  implementations: RuleSpecNode[];
  /** All shared type/value-object specs. */
  types: RuleSpecNode[];
}

/**
 * A programmatic conformance rule shipped by a code pack. Its runtime shape —
 * `{ name, description?, codes: string[], check }` — is what wairon's extension
 * loader duck-types when it loads a `pack.cjs`.
 */
export interface SddRule {
  /** Stable rule id (kebab-case), e.g. "my-portal-transport". */
  name: string;
  /** One-line description of what the rule enforces and why. */
  description?: string;
  /** The issue codes this rule can emit. */
  codes: string[];
  /** Inspect the spec tree and return findings (empty when clean). */
  check(ctx: RuleContext): Finding[];
}

/**
 * Author an SddRule with full type inference. Returns the rule unchanged — it
 * exists purely so code packs get typed authoring without importing anything
 * from wairon core.
 */
export function defineRule(rule: SddRule): SddRule {
  return rule;
}
