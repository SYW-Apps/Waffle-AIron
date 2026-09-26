import { SddRule, type RuleContext } from '../types.js';
import { isDraftSubsystem } from '../../../models/index.js';

// ---------------------------------------------------------------------------
// Reference forms: a reference written with a leading `::` escapes to the root
// of whatever checkout loads it, naming a spec by its place in one mount chain.
// It always has a fix — the absolute id it resolves to — so every one an author
// wrote is reported. `super::` is not reported in stage 2: wairon's own writer
// emits it for every cross-namespace reference, and no alternative exists until
// stage 3 brings `alias::name`.
//
// The rule does no I/O. The scan records each leading-`::` reference before
// qualification erases the form, and the project graph gathers them
// (ctx.projectFamily.authoredReferences).
// ---------------------------------------------------------------------------

/** The draft context a finding on this spec takes. */
function draftOf(ctx: RuleContext, specId: string): boolean {
  const sub = ctx.subsystems.find((s) => s.id === specId);
  if (sub) return isDraftSubsystem(sub);
  if (ctx.componentMap.has(specId)) return ctx.isComponentDraft(specId);
  const intf = ctx.interfaceMap.get(specId);
  if (intf) return ctx.isComponentDraft(intf.component);
  const impl = ctx.implementations.find((i) => i.id === specId);
  return impl ? ctx.isImplementationDraft(impl) : false;
}

export const referenceFormsRule: SddRule = {
  name: 'reference-forms',
  description:
    'A reference written with a leading `::` escapes to the root of whatever checkout loads it, naming a spec by its place in one mount chain; it always has a fix, the absolute id it resolves to. Every one an author wrote is reported (DEPRECATED_REFERENCE_FORM), naming the spec, where in it, the form as written and the absolute id to write instead. `super::` is not reported in stage 2: wairon\'s own writer emits it for every cross-namespace reference and no alternative exists until stage 3 brings `alias::name`. It reads the project graph\'s authored references, which the scan records before qualification erases the form.',
  codes: [
    { code: 'DEPRECATED_REFERENCE_FORM', defaultSeverity: 'notice', summary: 'A reference written with a leading :: where the absolute id it resolves to belongs' },
  ],
  check(ctx) {
    // Step 1: the graph.
    const family = ctx.projectFamily;
    // Steps 2-3: a candidate run carries none.
    if (!family) return;
    // Steps 4-5: every leading-`::` reference an author wrote.
    for (const ref of family.authoredReferences) {
      ctx.addIssue(
        'notice',
        'DEPRECATED_REFERENCE_FORM',
        `"${ref.specId}" writes "${ref.authored}" (${ref.position}): a leading \`::\` names a spec by its place in whichever checkout loads it. Write the absolute id "${ref.resolved}" instead.`,
        ref.specId,
        draftOf(ctx, ref.specId),
      );
    }
    // Step 6: judged.
  },
};
