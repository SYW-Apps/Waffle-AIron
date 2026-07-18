import { SEMANTIC_GUARANTEES } from '../../models/index.js';
import type { SddRule } from './types.js';

// ---------------------------------------------------------------------------
// Guarantee-token vocabulary. The guarantee field is an OPEN string so packs
// can extend the vocabulary beyond the builtin set — which makes typo
// detection the validator's job instead of the schema's: a token that is
// neither builtin nor declared by any loaded pack cannot be matched by the
// consistency machinery (NARRATIVE_SEMANTIC_UNBACKED compares tokens
// literally), so it silently opts the contract out of every guarantee check.
// ---------------------------------------------------------------------------

export const guaranteeTokensRule: SddRule = {
  name: 'guarantee-tokens',
  description:
    'Every semantic-guarantee token an L3 method declares or a narrative step asserts must be a builtin guarantee or one a loaded extension pack declares in its `guarantees` list. The vocabulary is open for packs, not for typos — an undeclared token is matched by nothing and silently escapes the narrative↔contract consistency checks.',
  codes: [
    { code: 'UNKNOWN_GUARANTEE', defaultSeverity: 'warning', summary: 'Guarantee token is neither builtin nor pack-declared' },
  ],
  check(ctx) {
    const known = new Set<string>([...SEMANTIC_GUARANTEES, ...ctx.ext.guarantees]);
    const fixHint = `Known tokens: builtin ${SEMANTIC_GUARANTEES.join(', ')}${ctx.ext.guarantees.length ? `; pack-declared ${ctx.ext.guarantees.join(', ')}` : ''}. Fix the spelling or declare the token in an extension pack's \`guarantees\` list.`;

    for (const intf of ctx.interfaces) {
      const isDraftCtx = intf.status === 'draft' || intf.status === 'design' || ctx.isComponentDraft(intf.component);
      for (const method of intf.methods) {
        for (const g of method.guarantees ?? []) {
          if (!known.has(g)) {
            ctx.addIssue(
              'warning',
              'UNKNOWN_GUARANTEE',
              `Method "${method.name}" on interface "${intf.id}" declares guarantee "${g}", which is neither a builtin guarantee nor declared by any loaded extension pack — no narrative assertion can ever match it. ${fixHint}`,
              intf.id,
              isDraftCtx,
            );
          }
        }
      }
    }

    for (const impl of ctx.implementations) {
      const isDraftCtx = ctx.isImplementationDraft(impl);
      for (const method of impl.methods) {
        for (const step of method.narrative ?? []) {
          for (const g of step.assertsGuarantees ?? []) {
            if (!known.has(g)) {
              ctx.addIssue(
                'warning',
                'UNKNOWN_GUARANTEE',
                `Step ${step.stepNumber} of "${method.name}" in implementation "${impl.id}" asserts guarantee "${g}", which is neither a builtin guarantee nor declared by any loaded extension pack — no L3 contract can ever back it. ${fixHint}`,
                impl.id,
                isDraftCtx,
              );
            }
          }
        }
      }
    }
  },
};
