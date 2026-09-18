import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Namespace integrity, question two: a subproject-local name must not shadow a
// root-level subsystem id. Inside its subproject a bare reference to the
// shadowed name silently anchors to the ROOT subsystem, so the local spec
// becomes unaddressable — nothing refuses the reference, it just resolves
// somewhere else.
//
// Like its sibling reserved-id-segments this reads ctx.specIds(), the tree's
// ids with their kind labels, because the question is about the id whatever
// kind of spec carries it.
// ---------------------------------------------------------------------------

export const namespaceShadowingRule: SddRule = {
  name: 'namespace-shadowing',
  description:
    'A subproject-local name must not shadow a root-level subsystem id — inside its subproject a bare reference to the shadowed name anchors to the ROOT subsystem, so the local spec cannot be addressed reliably.',
  codes: [
    { code: 'NAMESPACE_SHADOWING', defaultSeverity: 'error', summary: 'Subproject-local id shadows a root subsystem id (bare references anchor to the root)' },
  ],
  check(ctx) {
    const rootSubs = new Set(ctx.subsystems.filter(s => !s.id.includes('::')).map(s => s.id));

    for (const spec of ctx.specIds()) {
      if (!ctx.isSpecInScope(spec.id)) continue;
      const segments = spec.id.split('::');
      const local = segments[segments.length - 1];
      if (segments.length <= 1 || !rootSubs.has(local)) continue;
      ctx.addIssue(
        'error',
        'NAMESPACE_SHADOWING',
        `${spec.kind} "${spec.id}" shadows root subsystem "${local}" — inside its subproject a bare reference to "${local}" anchors to the ROOT subsystem, so this spec cannot be addressed reliably. Rename one of them.`,
        spec.id,
      );
    }
  },
};
