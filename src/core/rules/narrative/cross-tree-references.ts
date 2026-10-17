import { SddRule } from '../types.js';
import { ambiguityMessage } from '../../../models/index.js';

// ---------------------------------------------------------------------------
// A narrative target this tree does not contain: either it leaves the project,
// and the owner's resolution decides — resolved is surface-reference-backing's,
// foreign snapshots that disagree are SURFACE_REF_AMBIGUOUS here, and any other
// outcome is project-boundaries' single finding — or it is a local id that
// names nothing, the typo it always was.
//
// One resolution path serves every entry kind. Call, dispatch and register
// steps differ only in the verb their finding reads with and in the clause an
// ambiguous reference is named in, so those are the only per-kind values.
// ---------------------------------------------------------------------------

export const crossTreeReferencesRule: SddRule = {
  name: 'cross-tree-references',
  judges: 'design',
  description:
    "A narrative call, dispatch or register target that is not a component of this tree either leaves the project — and then its resolution (resolveCrossProject) decides: resolved is surface-reference-backing's, foreign snapshots that disagree are SURFACE_REF_AMBIGUOUS here, and every other outcome is project-boundaries' single finding — or it is a local id that names nothing, the INVALID_TARGET_COMPONENT_REFERENCE typo it always was. The CROSS_TREE_REF_UNRESOLVED warning (\"only the parent project can verify it\") is retired: no reference is left for a parent to judge.",
  codes: [
    { code: 'INVALID_TARGET_COMPONENT_REFERENCE', defaultSeverity: 'error', summary: "Call/register step targets a non-existent component" },
    { code: 'SURFACE_REF_AMBIGUOUS', defaultSeverity: 'error', summary: "Cross-tree call/dispatch/register target matched by surface snapshots of several providers with different contracts" },
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

          // A reference that leaves the project carries the owner's
          // resolution; a local id that names nothing has none.
          const resolution = ctx.resolveCrossProject(impl.id, 'narrative', target);
          if (resolution) {
            const resolved = ctx.resolveSurfaceRef(target, fromSubsystem);
            if (resolution.outcome === 'ambiguous' && resolved.kind === 'ambiguous') {
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
                resolution,
              );
            }
            // Resolved is surface-reference-backing's; forbidden, missing and
            // unavailable are project-boundaries' single finding.
            continue;
          }

          const hint = ctx.importHint(target);
          ctx.addIssue(
            'error',
            'INVALID_TARGET_COMPONENT_REFERENCE',
            `Method "${implMethod.name}" in implementation "${impl.id}" ${verb} component "${target}" which does not exist (step ${step.stepNumber}).${hint ? ` A declared dependency exports it without this project importing it — add \`${hint}\`.` : ''}`,
            impl.id,
            isDraftCtx,
          );
        }
      }
    }
  },
};
