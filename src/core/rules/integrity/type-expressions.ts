import { typeProblemIntProposal, type TypeExpressionProblem } from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// type-expressions — what the scan's type canonicalisation recorded about the
// stored spellings. Every reader is handed canonical text (the loader
// canonicalises in memory), so the stored form lives only in the file — which
// is what a diff, a review and a lock approval read — and in the facts the
// loader keeps of it. This rule reports those facts, one finding per
// position: the ones the writer would refuse today, and the aliases any save
// rewrites. It never parses anything itself: the loader read every position
// once, and two readings could disagree.
// ---------------------------------------------------------------------------

/** Whether the spec holding a position is judged in a draft context. */
function draftContext(ctx: RuleContext, specId: string, kind: 'interface' | 'type' | undefined): boolean {
  if (kind === 'interface') {
    const intf = ctx.interfaceMap.get(specId);
    return !!intf && (ctx.isComponentDraft(intf.component) || intf.status === 'draft' || intf.status === 'design');
  }
  const type = ctx.types.find((t) => t.id === specId);
  const sub = type?.subsystem ? ctx.subsystems.find((s) => s.id === type.subsystem) : undefined;
  return !!sub && (sub.status === 'draft' || sub.status === 'design');
}

/**
 * The site a position's path names: the method for anything under
 * `methods.<name>`, the field for `fields.<name>`, and the path itself for a
 * signature type's own `params.<name>` and `returns`.
 */
function siteOf(path: string): string {
  const [head, name] = path.split('.');
  return (head === 'methods' || head === 'fields') && name ? name : path;
}

/** Where a position stands, in the words a message uses. */
function located(kind: string | undefined, specId: string, path: string | undefined): string {
  return `${path ? `"${path}" of ` : ''}${kind ?? 'spec'} "${specId}"`;
}

/** The message one problem is reported with: what is wrong and what to write instead. */
function problemMessage(problem: TypeExpressionProblem, specId: string): string {
  const where = located(problem.kind, specId, problem.path);
  const replacement = problem.replacement ? ` Write ${problem.replacement} instead.` : '';
  switch (problem.code) {
    case 'TYPE_EXPRESSION_INVALID':
      return `The type at ${where} does not parse under the type grammar: ${problem.detail}.${replacement} Every reader treats the position as opaque any until it does.`;
    case 'TYPE_POSITION_INVALID':
      return `The type at ${where} breaks a position rule: ${problem.detail}.${replacement}`;
    case 'TYPE_FORM_UNSUPPORTED':
      return `The type at ${where} uses a form the type grammar leaves out: ${problem.detail}.${replacement} Every reader treats the position as opaque any until it is remodelled; the writer refuses it in a new write.`;
    case 'TYPE_NOT_NEUTRAL': {
      if (problem.replacement === 'int or float') {
        const proposal = typeProblemIntProposal({ ...problem, specId })
          ? ` Its name says a whole number, so \`wairon doctor\` proposes int here — confirm it by writing int, or write float.`
          : ' Write int or float.';
        return `The type at ${where} is "${problem.written}": number does not say whether it holds an integer — int or float?${proposal} Until then it is read as float.`;
      }
      return `The type at ${where} is "${problem.written}": ${problem.detail}, so it is read as any.${replacement}`;
    }
  }
}

export const typeExpressionsRule: SddRule = {
  name: 'type-expressions',
  judges: 'design',
  description:
    "Reports what the scan's type canonicalisation recorded (ctx.typeSpellingFacts), one finding per position, located by spec and path: a stored text that does not parse (TYPE_EXPRESSION_INVALID); one that breaks a position rule — void, async or result out of place, a map key that is not string, int or an enum, a named scalar's holds that is not one primitive other than void and any, `T??` (TYPE_POSITION_INVALID); one using a form the grammar leaves out — an inline object shape, an inline function type, a string-literal union, a union mixing in a primitive or a collection, an intersection, a utility type or a tuple (TYPE_FORM_UNSUPPORTED); one naming `number` or a legacy builtin with no neutral meaning (TYPE_NOT_NEUTRAL); and one that is an alias of its canonical spelling (TYPE_SPELLING_STALE, which any save or doctor --fix repairs). Every message names the replacement: `number` asks \"int or float?\" (and says when the doctor repair proposes int), a function type names a signature type, a literal union an enum (which the doctor repair proposes), an inline object or a mixed union a named value-object. The writer refuses all but the stale spelling at write time; on load every one of them is a warning — these findings are how a tree that held them before the grammar existed is told, while it still loads, stays lockable with its debt in view, and its consumers read the position as opaque any, which never invents a shape. No finding when the run carries no facts (a candidate run).",
  codes: [
    { code: 'TYPE_EXPRESSION_INVALID', defaultSeverity: 'warning', summary: 'A structured type position does not parse under the type grammar' },
    { code: 'TYPE_POSITION_INVALID', defaultSeverity: 'warning', summary: 'A type position breaks a position rule: void, async or result out of place, a non-scalar map key, or T??' },
    { code: 'TYPE_FORM_UNSUPPORTED', defaultSeverity: 'warning', summary: 'A type position uses a form the grammar leaves out — inline object, inline function type, string-literal union, union mixing in a primitive or collection, intersection, utility type or tuple — and the message names its named replacement' },
    { code: 'TYPE_NOT_NEUTRAL', defaultSeverity: 'warning', summary: 'A type position names number (int or float?) or a legacy builtin with no neutral meaning, and the message names the replacement' },
    { code: 'TYPE_SPELLING_STALE', defaultSeverity: 'warning', summary: 'A stored type position is an alias of its canonical spelling; any save or doctor --fix rewrites it' },
  ],
  check(ctx) {
    // Step 1: a candidate run carries no facts, and says nothing.
    const facts = ctx.typeSpellingFacts;
    if (!facts) return;
    // Steps 2-3: every recorded problem, in scope, under its own code.
    for (const problem of facts.problems) {
      if (problem.specId === undefined || !ctx.isSpecInScope(problem.specId)) continue;
      // A warning on load, whatever the code: the writer already refuses each at write time.
      ctx.addIssue(
        'warning',
        problem.code,
        problemMessage(problem, problem.specId),
        problem.specId,
        draftContext(ctx, problem.specId, problem.kind),
        undefined,
        problem.path ? { at: siteOf(problem.path) } : undefined,
      );
    }
    // Steps 4-5: every recorded respelling, in scope.
    for (const respelling of facts.respellings) {
      if (!ctx.isSpecInScope(respelling.specId)) continue;
      ctx.addIssue(
        'warning',
        'TYPE_SPELLING_STALE',
        `The type at ${located(respelling.kind, respelling.specId, respelling.path)} is stored as "${respelling.written}", an alias of its canonical spelling "${respelling.stored}" — which is what every reader is shown. Any save of the spec writes the canonical text, and \`wairon doctor --fix\` rewrites every stale spelling at once.`,
        respelling.specId,
        draftContext(ctx, respelling.specId, respelling.kind),
        undefined,
        { at: siteOf(respelling.path) },
      );
    }
    // Step 6: nothing else to judge.
  },
};
