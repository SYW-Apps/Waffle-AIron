import { SddRule } from '../types.js';
import { ambiguityMessage } from '../../../models/index.js';

// ---------------------------------------------------------------------------
// A narrative target this tree does not contain: can the reference be pinned
// to exactly one declared contract? Three outcomes, one per code — the stored
// surface snapshots single one out (nothing to report here; what that surface
// exposes is surface-reference-backing's), they expose the name with several
// disagreeing contracts (SURFACE_REF_AMBIGUOUS), or none covers it, which is a
// warning for a reference that points outside this loading root and the error a
// local typo has always got.
//
// One resolution path serves every entry kind. Call, dispatch and register
// steps differ only in the verb their finding reads with and in the clause an
// ambiguous reference is named in, so those are the only per-kind values.
// ---------------------------------------------------------------------------

export const crossTreeReferencesRule: SddRule = {
  name: 'cross-tree-references',
  description:
    'A narrative call, dispatch or register target that is not a component of this tree must resolve against the stored surface snapshots to exactly one declared contract. Snapshots that expose the name with disagreeing contracts leave the reference ambiguous; no snapshot at all is a warning for a reference that points outside this loading root (only the parent project can verify it) and the error a genuine local typo has always got.',
  codes: [
    { code: 'INVALID_TARGET_COMPONENT_REFERENCE', defaultSeverity: 'error', summary: 'Call/register step targets a non-existent component' },
    { code: 'CROSS_TREE_REF_UNRESOLVED', defaultSeverity: 'warning', summary: 'Cross-tree reference (super::/:: form) with no surface snapshot covering it — only the parent project can verify it' },
    { code: 'SURFACE_REF_AMBIGUOUS', defaultSeverity: 'error', summary: 'Cross-tree call/dispatch/register target matched by surface snapshots of several providers with different contracts' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      if (!contract) continue;

      const isDraftCtx = ctx.isImplementationDraft(impl);
      const caller = ctx.componentMap.get(contract.component);
      const fromSubsystem = caller?.subsystem;

      for (const implMethod of impl.methods) {
        for (const step of implMethod.narrative) {
          if (step.type !== 'call' && step.type !== 'dispatch' && step.type !== 'register') continue;
          // A step that names no target, or no target method where its kind
          // needs one, is narrative-target-references' finding and is never
          // resolved here.
          if (!step.targetComponent) continue;
          if (step.type !== 'dispatch' && !step.targetMethod) continue;
          const target = step.targetComponent;
          // A target this tree contains is narrative-target-references'.
          if (ctx.componentMap.get(target)) continue;

          const verb = step.type === 'dispatch' ? 'dispatches through'
            : step.type === 'register' ? 'registers callback'
              : 'calls';

          // An unresolved reference that points OUTSIDE this loading root — a
          // chained subproject opened standalone physically does not contain its
          // parent's specs, so the edge is only verifiable from the parent. That
          // is a known-honest state, not a spec defect: warn with its own code
          // instead of raising the same error a genuine typo gets. This covers
          // the explicit relative forms (super::/::) AND a qualified reference
          // whose leading namespace segment is not a subsystem in THIS tree —
          // e.g. `waffler_core::x` authored from a parent root, where
          // `waffler_core` is not present when validating from the child dir.
          const isCrossTreeForm = ctx.isExternalNamespaceRef(target);
          // A reference made from inside a chained mount that the loader collapsed
          // at this root may resolve against the snapshots that mount holds; one
          // they do not cover keeps the error it always had.
          const isCollapsedForm = !isCrossTreeForm && fromSubsystem !== undefined
            && ctx.isCollapsedCrossTreeRef(target, fromSubsystem);

          if (isCrossTreeForm || isCollapsedForm) {
            const resolved = ctx.resolveSurfaceRef(target, fromSubsystem);
            if (resolved.kind === 'ambiguous') {
              ctx.addIssue(
                'error',
                'SURFACE_REF_AMBIGUOUS',
                ambiguityMessage(
                  resolved,
                  step.type === 'dispatch'
                    ? `Method "${implMethod.name}" in implementation "${impl.id}" dispatches (step ${step.stepNumber}) through`
                    : `Method "${implMethod.name}" in implementation "${impl.id}" ${verb} "${step.targetMethod}" (step ${step.stepNumber}) on`,
                  target,
                ),
                impl.id,
                isDraftCtx,
              );
              continue;
            }
            // Resolved: the reference names one declared contract. Whether that
            // contract backs what the step asks of it is
            // surface-reference-backing's.
            if (resolved.kind === 'resolved') continue;
          }

          if (isCrossTreeForm) {
            ctx.addIssue(
              'warning',
              'CROSS_TREE_REF_UNRESOLVED',
              `Method "${implMethod.name}" in implementation "${impl.id}" ${verb} cross-tree component "${target}" (step ${step.stepNumber}), and no surface snapshot covers it — validate from the parent project, pin the family surfaces ("wairon surface pin"), or import the producing project's surface.`,
              impl.id,
              isDraftCtx,
            );
          } else {
            ctx.addIssue(
              'error',
              'INVALID_TARGET_COMPONENT_REFERENCE',
              `Method "${implMethod.name}" in implementation "${impl.id}" ${verb} component "${target}" which does not exist (step ${step.stepNumber}).`,
              impl.id,
              isDraftCtx,
            );
          }
        }
      }
    }
  },
};
