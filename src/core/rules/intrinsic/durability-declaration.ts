import { SddRule } from '../types.js';

/**
 * The INTRINSIC half of the durability family: whether the declaration itself
 * belongs on this component. Both verdicts read one component's own
 * componentType + durability and nothing else, so this is `scope: 'spec'` and
 * also runs at the write boundary — durability on a non-Store is refused when
 * authored rather than persisting as an unclearable validate-time error.
 */
export const durabilityDeclarationRule: SddRule = {
  name: 'durability-declaration',
  scope: 'spec',
  description:
    'Every Store declares its durability (MISSING_DURABILITY) and nothing but a Store may declare one (DURABILITY_ON_NON_STORE). Intrinsic to one component: no tree required. The round-trip consequences of the declaration are enforced by durability-round-trip.',
  codes: [
    { code: 'DURABILITY_ON_NON_STORE', defaultSeverity: 'error', summary: 'durability declared on a component that is not a Store' },
    { code: 'MISSING_DURABILITY', defaultSeverity: 'warning', summary: 'Store with no durability declaration — the round-trip machinery cannot know whether restart-survival is promised' },
  ],
  check(ctx) {
    for (const comp of ctx.components) {
      const isDraftCtx = ctx.isComponentDraft(comp.id);

      if (!comp.durability) {
        // Undeclared durability hollows out the round-trip machinery: on a
        // 12-store tree with 2 declarations the flagship check protects
        // almost nothing. Exemption is by declaration, never by omission.
        if (comp.componentType === 'Store') {
          ctx.addIssue(
            'warning',
            'MISSING_DURABILITY',
            `Store "${comp.id}" declares no durability. Declare one: durable (persisted RAM projection — hydration round-trip enforced), read-through (persisted, no RAM copy — every read is the read-back), ram-projection (rebuilt, not restored), or cache (evictable, loss-safe).`,
            comp.id,
            isDraftCtx,
          );
        }
        continue;
      }

      if (comp.componentType !== 'Store') {
        ctx.addIssue(
          'error',
          'DURABILITY_ON_NON_STORE',
          `Component "${comp.id}" (${comp.componentType}) declares durability "${comp.durability}" — durability is a Store property (state lives in Stores; see the no-persistence-shortcuts rule).`,
          comp.id,
          isDraftCtx,
        );
      }
    }
  },
};
