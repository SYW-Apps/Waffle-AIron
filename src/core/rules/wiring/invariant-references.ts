import { SddRule } from '../types.js';
import { familyAliases, resolveInvariantRef, splitInvariantRef } from './invariant-ref.js';

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
/**
 * Why a reference resolves to nothing, in words: a qualifier whose bare
 * reference DOES resolve is the cause (a project's own alias written from
 * inside it, which this project does not read as its own) and is named with
 * the bare reference to write; anything else names no declared invariant.
 */
function unknownInvariantMessage(where: string, ref: string, types: Parameters<typeof resolveInvariantRef>[1], aliases: Map<string, string[]>): string {
  const parts = splitInvariantRef(ref);
  const qualifier = parts ? parts.typeRef.lastIndexOf('::') : -1;
  if (parts && qualifier > 0) {
    const bare = `${parts.typeRef.slice(qualifier + 2)}.${parts.invariantId}`;
    if (resolveInvariantRef(bare, types, aliases)) {
      const prefix = parts.typeRef.slice(0, qualifier);
      return `${where} asserts invariant "${ref}", whose qualifier "${prefix}::" names no project this one reaches the type through — the invariant is declared here, so write "${bare}" (a project's own alias, written from inside it, is not a qualifier it reads as its own; \`wairon doctor --fix\` rewrites it in a migrated family).`;
    }
  }
  return `${where} asserts invariant "${ref}", but no entity declares it (expected "<type-id>.<invariant-id>" naming a declared entry in that entity's invariants).`;
}

export const invariantReferencesRule: SddRule = {
  name: 'invariant-references',
  judges: 'design',
  description:
    'Every invariant a narrative step asserts (step.assertsInvariants) must resolve to a declared entity invariant: the reference splits at its last dot into a type reference and an invariant id, and some entity matching that type reference must declare that id. A reference nothing declares is an error — the step claims a property that exists nowhere. The message says which: when the type reference carries a qualifier (`alias::type`) and the bare reference does resolve, the cause is the qualifier — typically the project\'s own alias written from inside it — and the message names it and the bare reference to write instead, never claiming that no entity declares the invariant.',
  codes: [
    { code: 'UNKNOWN_INVARIANT_REF', defaultSeverity: 'error', summary: 'A narrative step asserts an invariant that no entity declares' },
  ],
  check(ctx) {
    // A type named through an alias is read through the family's alias tables.
    const aliases = familyAliases(ctx.projectFamily);
    for (const impl of ctx.implementations) {
      const isDraftCtx = ctx.isImplementationDraft(impl);
      for (const method of impl.methods) {
        for (const step of method.narrative) {
          for (const ref of step.assertsInvariants ?? []) {
            if (resolveInvariantRef(ref, ctx.types, aliases)) continue;
            ctx.addIssue(
              'error',
              'UNKNOWN_INVARIANT_REF',
              unknownInvariantMessage(`Step ${step.stepNumber} of "${method.name}" in implementation "${impl.id}"`, ref, ctx.types, aliases),
              impl.id,
              isDraftCtx,
            );
          }
        }
      }
    }
  },
};
