import { SddRule } from '../types.js';

/**
 * Registered as a real rule (not an ad-hoc loader injection) so the code is
 * visible in `wairon rules list`, tunable via rules.sddRuleSeverity, scoped by
 * ctx.addIssue like every other finding, and recognized by the lint-allow
 * audit (errors are still never locally suppressible). The dry run itself is
 * gathered by the validator before the rules run (ctx.roundTripIssues), so this
 * rule does no I/O.
 */
export const roundtripRule: SddRule = {
  name: 'roundtrip-serialization',
  description:
    'Every loaded spec must re-serialize through the exact writer pipeline (same relativization, same schema, no I/O) — validate must predict every refusal that lock\'s status promotion or any later save would otherwise raise mid-write.',
  codes: [
    { code: 'ROUNDTRIP_SERIALIZATION', defaultSeverity: 'error', summary: 'Spec cannot be re-serialized through the writer schema (any save or lock would refuse it)' },
  ],
  check(ctx) {
    for (const issue of ctx.roundTripIssues) {
      ctx.addIssue('error', 'ROUNDTRIP_SERIALIZATION', issue.message, issue.specId);
    }
  },
};
