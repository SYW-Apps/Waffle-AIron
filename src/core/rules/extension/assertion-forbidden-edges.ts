import type { SddRule } from '../types.js';
import { assertionsOfKind, matchesSelector, reportAssertion } from './declared-assertion.js';

// ---------------------------------------------------------------------------
// The `forbid-edge` assertion kind: a pack names a source selector, a target
// selector and the relations that close the edge (dependsOn and/or owns), and
// every matching edge in the tree is a violation. Purely spec-graph — no code
// model needed. The finding is the pack's namespaced code.
// ---------------------------------------------------------------------------

export const assertionForbiddenEdgesRule: SddRule = {
  name: 'assertion-forbidden-edges',
  description:
    'Evaluates the `forbid-edge` assertions loaded packs declare: for every component matching the assertion\'s from-selector, every dependsOn/owns id whose target matches the to-selector is reported. Findings carry the pack\'s namespaced code (<PACK>_<CODE>) and its stated reason; severity is the pack\'s declaration (project sddRuleSeverity still wins, and error downgrades to warning in draft context). The codes are the packs\' own, so no fixed code list applies.',
  // Static codes are unknown here — packs bring their own. The validator
  // gathers every loaded assertion's fullCode into knownIssueCodes.
  codes: [],
  check(ctx) {
    for (const a of assertionsOfKind(ctx, 'forbid-edge')) {
      for (const comp of ctx.components) {
        if (!matchesSelector(a.from, comp, ctx)) continue;
        const isDraftCtx = ctx.isComponentDraft(comp.id);
        const edges = a.relation.flatMap(relation =>
          comp[relation].map(targetId => ({ relation, targetId })),
        );
        for (const { relation, targetId } of edges) {
          const target = ctx.componentMap.get(targetId);
          if (!target || !matchesSelector(a.to, target, ctx)) continue;
          reportAssertion(
            ctx,
            a,
            `Component "${comp.id}" (${comp.componentType}) ${relation === 'owns' ? 'owns' : 'depends on'} "${target.id}" (${target.componentType}), forbidden by assertion ${a.code}`,
            comp.id,
            isDraftCtx,
          );
        }
      }
    }
  },
};
