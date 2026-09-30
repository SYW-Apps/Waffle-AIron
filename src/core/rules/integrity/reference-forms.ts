import { SddRule, type RuleContext } from '../types.js';
import { isDraftSubsystem, type AuthoredReference } from '../../../models/index.js';

// ---------------------------------------------------------------------------
// Reference forms: a cross-project reference is `alias::name`. Three older
// forms still bind for one release — a leading `::`, `super::` and a member
// path — and each one an author wrote is reported with the text to write
// instead: a bare local id, or `alias::publicName`.
//
// The rule does no I/O. The scan records every reference with `::` before
// binding erases the form, with what it bound to and its rewrite, and the
// project graph gathers them (ctx.projectFamily.authoredReferences).
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

/** Whether a reference is a self-prefix: the referring project's own id used as its first segment. */
function isSelfPrefix(ref: AuthoredReference, ownerKey: string | undefined): boolean {
  return ref.binding === 'local' && ref.producer === ownerKey && ref.form === 'path'
    && ref.rewrite !== undefined && !ref.rewrite.includes('::') && ref.authored !== ref.rewrite;
}

/** What a deprecated form is, in words. */
function formOf(ref: AuthoredReference, selfPrefix: boolean): string {
  if (selfPrefix) return "the project's own id used as a prefix names nothing a bare local id does not";
  switch (ref.form) {
    case 'leading': return 'a leading `::` names a spec by its place in whichever checkout loads it';
    case 'super': return '`super::` climbs the containing projects — a place in one family, not a name';
    default: return 'a member path is read from the bound root, one alias per segment — a place in one family, not a name';
  }
}

/** Why a deprecated form has no text to write instead. */
function whyNoRewrite(ref: AuthoredReference): string {
  if (ref.binding === 'outside') return 'no rewrite can be written: its target lies outside the scan (a project the scan did not read)';
  if (ref.binding === 'unresolved') return 'no rewrite can be written: nothing names its first segment';
  return `no rewrite can be written: the project it lands in (${ref.producer === '' ? 'the bound root' : `"${ref.producer}"`}) has no id to name it by`;
}

export const referenceFormsRule: SddRule = {
  name: 'reference-forms',
  judges: 'design',
  description:
    "A cross-project reference is `alias::name` (or a bare name a `use` imports): the alias is one of the referring project's members or externals, the name a public name of that project's L0 table. The older forms still bind for one release and are reported (DEPRECATED_REFERENCE_FORM), each naming the spec, where in it, the form as written and the text to write instead (the scan's rewrite: a bare local id, or `alias::publicName`): a leading `::`, which escapes to the root of whatever checkout loads it; `super::`, which climbs the containing projects — a place in one family, not a name; a member path (`desktop::shell` written inside desktop, `waffler_core::transpiler::x` written inside transpiler), a first segment the referring project does not declare, read from the bound root; and a self-prefix — the referring project's own id as the first segment, with `::` or `.` (`registry.advisory-channel` inside registry), which stage 3's migration did not rewrite and stage 4's positional step does. Wairon's own writer emits none of them. A form with no rewrite (its target is out of reach) is reported with the reason. It reads the project graph's authored references, which the scan records before binding erases the form.",
  codes: [
    { code: 'DEPRECATED_REFERENCE_FORM', defaultSeverity: 'notice', summary: "A reference written with a leading ::, super:: or a member path where a local id or alias::name belongs" },
  ],
  check(ctx) {
    // Step 1: the graph.
    const family = ctx.projectFamily;
    // Steps 2-3: a candidate run carries none.
    if (!family) return;
    // Steps 4-5: every reference written in a deprecated form whose text changes.
    for (const ref of family.authoredReferences) {
      if (ref.form === 'alias' || ref.form === 'import') continue;
      // A path-form reference whose rewrite equals what was written becomes
      // canonical by declaring the external alone — EXTERNAL_UNDECLARED's to say.
      if (ref.rewrite !== undefined && ref.rewrite === ref.authored) continue;
      const bound = ref.binding === 'outside' || ref.binding === 'unresolved' ? '' : ` It binds to "${ref.resolved}".`;
      const instead = ref.rewrite !== undefined ? `Write "${ref.rewrite}" instead.` : `${whyNoRewrite(ref)[0].toUpperCase()}${whyNoRewrite(ref).slice(1)}.`;
      ctx.addIssue(
        'notice',
        'DEPRECATED_REFERENCE_FORM',
        `"${ref.specId}" writes "${ref.authored}" (${ref.position}): ${formOf(ref, isSelfPrefix(ref, family.owners.get(ref.specId)))}.${bound} ${instead}`,
        ref.specId,
        draftOf(ctx, ref.specId),
      );
    }
    // Step 6: judged.
  },
};
