import { SddRule } from '../types.js';
import { extractTypeIdentifiers, methodTypeRefs, parseTypePosition, type TypeExpression, type TypePosition } from '../../../models/index.js';

// ---------------------------------------------------------------------------
// Untyped seams — `any` crossing a subsystem's public surface. The seam is
// exactly where role-envelope mismatches hide; inside a component a loose bag
// is a style choice, across a boundary it is an unchecked contract.
//
// `any` is the one untyped type of the grammar: object, unknown, json and Json
// are canonicalised to it, so a structured position is judged on its parsed
// expression. A position that does not read cleanly, and a prose signature,
// are read leniently by their tokens, where any of those spellings still
// counts.
// ---------------------------------------------------------------------------

/** The spellings a lenient reading counts as untyped, ignoring case: `any` and the aliases canonicalised to it. */
const UNTYPED_SPELLINGS = new Set(['any', 'json', 'unknown', 'object']);

/** Whether an expression holds `any` anywhere. */
function holdsAny(expr: TypeExpression): boolean {
  return (expr.form === 'primitive' && expr.name === 'any') || expr.args.some(holdsAny);
}

/** Whether lenient tokens name an untyped spelling. */
function tokensUntyped(text: string): boolean {
  return extractTypeIdentifiers(text).some(ref => UNTYPED_SPELLINGS.has(ref.toLowerCase()));
}

/**
 * Whether one structured position is untyped: its parsed expression holds
 * `any`; a position that does not read cleanly (a form the grammar leaves
 * out, a legacy name read as any) is read leniently by its tokens instead, so
 * only an untyped spelling actually written counts.
 */
function positionUntyped(text: string, position: TypePosition): boolean {
  const parse = parseTypePosition(text, position);
  if (parse.expression && !parse.problem) return holdsAny(parse.expression);
  return tokensUntyped(text);
}

export const untypedSeamRule: SddRule = {
  name: 'untyped-seams',
  judges: 'design',
  description:
    'Methods on a subsystem\'s published components (its public surface) should not take or return `any` — the one untyped type of the grammar, which object, unknown, json and Json are canonicalised to — judged through each method\'s named types and parsed expressions so a prose signature is judged like structured params (its tokens still read leniently): cross-subsystem contracts are the swap seam and must be typed. Generic-dispatch portals carry per-capability types via their dispatch table instead.',
  codes: [
    { code: 'UNTYPED_SEAM', defaultSeverity: 'warning', summary: 'Bare Json/any/unknown/object parameter or return crossing a subsystem public surface' },
  ],
  check(ctx) {
    for (const sub of ctx.subsystems) {
      const published = ctx.publicSet.get(sub.id);
      if (!published || published.size === 0) continue;

      for (const compId of published) {
        const comp = ctx.componentMap.get(compId);
        if (!comp) continue;
        // A generic-dispatch portal's untyped envelope is the sanctioned
        // pattern ONCE it carries a dispatch table — the table is where the
        // per-capability typing lives.
        if (comp.componentType === 'Portal' && comp.dispatch && comp.dispatch.length > 0) continue;

        for (const intf of ctx.interfacesByComponent.get(compId) ?? []) {
          const isDraftCtx = ctx.isComponentDraft(compId) || intf.status === 'draft' || intf.status === 'design';
          for (const m of intf.methods) {
            // Structured params, authoritative when authored, are read under
            // the grammar and name their offenders one by one; a prose
            // signature is read leniently by its type tokens and is the offender
            // whole — the verdict the same structured params would get.
            const offenders: string[] = [];
            if (m.params && m.params.length > 0) {
              for (const p of m.params) {
                if (positionUntyped(p.type, 'param')) {
                  offenders.push(`param "${p.name}: ${p.type}"`);
                }
              }
              if (m.returns && positionUntyped(m.returns, 'returns')) {
                offenders.push(`return "${m.returns}"`);
              }
            } else if (methodTypeRefs(m).some(ref => UNTYPED_SPELLINGS.has(ref.toLowerCase()))) {
              offenders.push(`signature "${m.signature}"`);
            }
            if (offenders.length) {
              ctx.addIssue(
                'warning',
                'UNTYPED_SEAM',
                `Method "${m.name}" on published component "${compId}" (public surface of subsystem "${sub.id}") crosses the boundary untyped: ${offenders.join(', ')}. Type the seam — or, for a generic-dispatch portal, carry per-capability types in the dispatch table.`,
                intf.id,
                isDraftCtx,
              );
            }
          }
        }
      }
    }
  },
};
