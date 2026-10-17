import { SddRule } from '../types.js';

/**
 * Reports each deprecated field a loaded pack still declares, as the
 * extension loader recorded it (ctx.ext.deprecations). Today that is a
 * language's `foreignBuiltins`: its foreign-builtin check is retired, because
 * contracts are written in the neutral type grammar and a language is chosen
 * at L4. The field is accepted and ignored for one release and removed in the
 * release after, so the pack author is told now — as a notice, which never
 * fails the gate: a pack that loaded yesterday still loads.
 */
export const packDeprecationsRule: SddRule = {
  name: 'pack-deprecations',
  judges: 'design',
  description:
    'A loaded pack still declaring a field wairon has deprecated (ctx.ext.deprecations — today a language\'s foreignBuiltins, whose foreign-builtin check is retired because contracts are written in the neutral type grammar) is told so: the field is accepted and ignored for one release and removed in the release after. A notice: it never fails the gate.',
  codes: [
    { code: 'PACK_FIELD_DEPRECATED', defaultSeverity: 'notice', summary: 'A loaded pack declares a deprecated field, accepted and ignored for one release' },
  ],
  check(ctx) {
    // Step 1: every deprecation the loaded packs recorded.
    for (const deprecation of ctx.ext.deprecations) {
      // Step 2: the pack, the field and what replaces it — ignored now, gone next release.
      ctx.addIssue(
        'notice',
        'PACK_FIELD_DEPRECATED',
        `Deprecated pack field — ${deprecation}. It is accepted and ignored in this release and removed in the next; take it out of the pack.`,
      );
    }
  },
};
