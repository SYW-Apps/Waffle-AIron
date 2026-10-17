import { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// signature-text — a stored signature text its params contradict. Every reader
// is shown the derived text (the loader re-derives it on every load), so the
// only place the stale one still lives is the file — which is exactly what a
// diff, a review and a lock approval read. The loader records each one as a
// fact; this rule reports them.
// ---------------------------------------------------------------------------

/** Whether the spec holding a stale text is judged in a draft context. */
function draftContext(ctx: RuleContext, specId: string, kind: 'interface' | 'type'): boolean {
  if (kind === 'interface') {
    const intf = ctx.interfaceMap.get(specId);
    return !!intf && (ctx.isComponentDraft(intf.component) || intf.status === 'draft' || intf.status === 'design');
  }
  const type = ctx.types.find((t) => t.id === specId);
  const sub = type?.subsystem ? ctx.subsystems.find((s) => s.id === type.subsystem) : undefined;
  return !!sub && (sub.status === 'draft' || sub.status === 'design');
}

export const signatureTextRule: SddRule = {
  name: 'signature-text',
  judges: 'design',
  description:
    'A stored signature text that differs from the text its method\'s params derive is stale: every reader is shown the derived text, but the file says something else, and a file read on its own (a diff, a review, a lock approval) is misled. Reported per method, from ctx.signatureFacts, for contract and type methods alike; `wairon doctor --fix` regenerates the stored text, and any save of the spec writes the derived text too.',
  codes: [
    { code: 'SIGNATURE_TEXT_STALE', defaultSeverity: 'warning', summary: 'A stored signature text differs from the text its params derive; doctor --fix regenerates it' },
  ],
  check(ctx) {
    // Step 1: every stale text the loader recorded, in scope.
    for (const stale of ctx.signatureFacts?.staleTexts ?? []) {
      if (!ctx.isSpecInScope(stale.specId)) continue;
      // Step 2.
      ctx.addIssue(
        'warning',
        'SIGNATURE_TEXT_STALE',
        `Method "${stale.method}" on ${stale.kind} "${stale.specId}" stores the signature "${stale.stored}", but its params derive "${stale.derived}" — which is what every reader is shown. Run \`wairon doctor --fix\` to regenerate the stored text (any save of the spec writes it too).`,
        stale.specId,
        draftContext(ctx, stale.specId, stale.kind),
        undefined,
        { at: stale.method },
      );
    }
  },
};
