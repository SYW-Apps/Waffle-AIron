import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Namespace integrity, question one: no id may spend a segment on the ONE
// keyword the :: grammar reserves. `super` is a namespace hop, so a stored
// reference to an id containing it is consumed as navigation and lands on a
// different spec — the reference cannot be written down at all.
//
// The check is over ctx.specIds(), the tree's ids with their kind labels: the
// question is about the id, and every kind of spec has one. Shadowing is
// namespace-shadowing's question, and the writer dry-run half of the family is
// roundtrip-serialization.
// ---------------------------------------------------------------------------

export const reservedIdSegmentsRule: SddRule = {
  name: 'reserved-id-segments',
  description:
    'No segment of a spec id may be the reserved namespace keyword "super" — the :: grammar consumes it as a namespace hop, so a stored reference to such an id resolves to a different spec.',
  codes: [
    { code: 'RESERVED_ID_SEGMENT', defaultSeverity: 'error', summary: 'Id uses the reserved namespace keyword "super"' },
  ],
  check(ctx) {
    for (const spec of ctx.specIds()) {
      if (!ctx.isSpecInScope(spec.id)) continue;
      if (!spec.id.split('::').includes('super')) continue;
      ctx.addIssue(
        'error',
        'RESERVED_ID_SEGMENT',
        `${spec.kind} id "${spec.id}" uses the reserved namespace keyword "super" — stored references to it would be consumed as a namespace hop and resolve to a different spec.`,
        spec.id,
      );
    }
  },
};
