import { SddRule } from '../types.js';
import { resolveInvariantRef } from './invariant-ref.js';

/**
 * The STEP side of the invariant registry: every `assertsInvariants` reference
 * a narrative step makes must name an invariant some entity declares. A
 * dangling one is an error, not a warning — the step claims to uphold a
 * property that exists nowhere, so the claim cannot be reviewed at all.
 *
 * Walks the steps, where invariant-backing walks the entities: the two never
 * meet in the middle, and this one needs no owner, no write path and no
 * implementation beyond the one it anchors the finding to.
 */
export const invariantReferencesRule: SddRule = {
  name: 'invariant-references',
  description:
    'Every invariant a narrative step asserts (step.assertsInvariants) must resolve to a declared entity invariant: the reference splits at its last dot into a type reference and an invariant id, and some entity matching that type reference must declare that id. A reference nothing declares is an error — the step claims a property that exists nowhere.',
  codes: [
    { code: 'UNKNOWN_INVARIANT_REF', defaultSeverity: 'error', summary: 'A narrative step asserts an invariant that no entity declares' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const isDraftCtx = ctx.isImplementationDraft(impl);
      for (const method of impl.methods) {
        for (const step of method.narrative) {
          for (const ref of step.assertsInvariants ?? []) {
            if (resolveInvariantRef(ref, ctx.types)) continue;
            ctx.addIssue(
              'error',
              'UNKNOWN_INVARIANT_REF',
              `Step ${step.stepNumber} of "${method.name}" in implementation "${impl.id}" asserts invariant "${ref}", but no entity declares it (expected "<type-id>.<invariant-id>" naming a declared entry in that entity's invariants).`,
              impl.id,
              isDraftCtx,
            );
          }
        }
      }
    }
  },
};
