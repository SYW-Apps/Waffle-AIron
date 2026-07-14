import { SddRule } from './types.js';

/**
 * Resolves component references to pack-declared reusable patterns. A
 * component's `patterns` entry must name a pattern id that a loaded extension
 * pack declares (UNKNOWN_PATTERN_REF), and a pinned version must match one the
 * pack provides (PATTERN_VERSION_MISMATCH). Core only checks identity and
 * version visibility — the pattern's actual architectural constraints are
 * enforced by the pack's own programmatic rules against this same reference.
 */
export const patternReferencesRule: SddRule = {
  name: 'pattern-references',
  description:
    "Every component pattern reference resolves to a reusable pattern declared by a loaded extension pack (UNKNOWN_PATTERN_REF); a pinned version with no matching pack pattern is warned (PATTERN_VERSION_MISMATCH). Pattern constraint enforcement itself is delegated to the declaring pack's rules.",
  codes: [
    { code: 'UNKNOWN_PATTERN_REF', defaultSeverity: 'warning', summary: 'Component references a pattern no loaded pack declares' },
    { code: 'PATTERN_VERSION_MISMATCH', defaultSeverity: 'warning', summary: 'Referenced pattern version matches no loaded pack pattern' },
  ],
  check(ctx) {
    // Nothing references a pattern — skip building the index entirely.
    if (!ctx.components.some(c => c.patterns && c.patterns.length > 0)) return;

    const versionsById = new Map<string, Set<string>>();
    for (const p of ctx.ext.patterns) {
      const set = versionsById.get(p.id) ?? new Set<string>();
      set.add(p.version);
      versionsById.set(p.id, set);
    }

    for (const comp of ctx.components) {
      const isDraftCtx = ctx.isComponentDraft(comp.id);
      for (const ref of comp.patterns ?? []) {
        const versions = versionsById.get(ref.id);
        if (!versions) {
          ctx.addIssue(
            'warning',
            'UNKNOWN_PATTERN_REF',
            `Component "${comp.id}" references pattern "${ref.id}", which no loaded extension pack declares. Install the pack that provides it (or remove the reference).`,
            comp.id,
            isDraftCtx,
          );
          continue;
        }
        if (ref.version && !versions.has(ref.version)) {
          ctx.addIssue(
            'warning',
            'PATTERN_VERSION_MISMATCH',
            `Component "${comp.id}" pins pattern "${ref.id}" version "${ref.version}", but the loaded pack provides version(s) ${[...versions].join(', ')}.`,
            comp.id,
            isDraftCtx,
          );
        }
      }
    }
  },
};
