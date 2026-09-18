import type { ComponentSpec } from '../../../models/index.js';
import type { RuleContext, Severity } from '../types.js';

// ---------------------------------------------------------------------------
// The shared reading of ONE pack-declared assertion (docs/design/
// declarative-rule-dsl.md): which components its selector picks, and how a
// violation of it is reported. Every assertion kind speaks this vocabulary;
// what each kind LOOKS AT is its own rule's question.
//
// The assertion shapes are read off the rule context: the assertion rules
// reach pack data only through ctx.ext, so they never import the extension
// loader.
// ---------------------------------------------------------------------------

export type LoadedAssertion = RuleContext['ext']['assertions'][number];
export type AssertionKind = LoadedAssertion['kind'];
export type AssertionSelector = Extract<LoadedAssertion, { kind: 'forbid-edge' }>['from'];

/** The loaded assertions of one closed kind, in pack-load order. */
export function assertionsOfKind<K extends AssertionKind>(
  ctx: RuleContext,
  kind: K,
): Extract<LoadedAssertion, { kind: K }>[] {
  return ctx.ext.assertions.filter(
    (a): a is Extract<LoadedAssertion, { kind: K }> => a.kind === kind,
  );
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, ch => (ch === '*' ? '.*' : `\\${ch}`));
  return new RegExp(`^${escaped}$`);
}

/** Does this component match a selector? Absent keys match all; present keys AND together. */
export function matchesSelector(sel: AssertionSelector, comp: ComponentSpec, ctx: RuleContext): boolean {
  if (sel.componentType?.length && !sel.componentType.includes(comp.componentType)) return false;
  if (sel.profile?.length && !sel.profile.includes(ctx.getComponentProfile(comp.id))) return false;
  if (sel.id && !globToRegExp(sel.id).test(comp.id)) return false;
  return true;
}

/**
 * Report a violation under the assertion's namespaced pack code, carrying the
 * pack's stated reason. Pack severity is the default; drafts soften errors
 * (doctrine is completeness-class, and pack codes cannot join the static
 * COMPLETENESS_RULES set, so the downgrade lives here).
 */
export function reportAssertion(
  ctx: RuleContext,
  a: LoadedAssertion,
  message: string,
  specId: string,
  isDraftCtx: boolean,
): void {
  const severity: Severity = isDraftCtx && a.severity === 'error' ? 'warning' : a.severity;
  ctx.addIssue(severity, a.fullCode, `${message} [pack "${a.pack}"]: ${a.reason}`, specId, isDraftCtx);
}
