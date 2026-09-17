import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// A narrative target that left this tree and DID resolve against a stored
// surface snapshot: the snapshot is the provider's declared contract, so it is
// judged like a local one. The caller must declare the collaborator it reaches,
// the snapshot's entry must expose the method the step calls (or serve the
// capability it dispatches), and that entry must declare every semantic
// guarantee the step asserts.
//
// These are contract verdicts, not resolution failures: each carries
// `surfaceResolved`, which is what keeps them at full strength in a chained
// subproject. Whether the reference resolves at all — ambiguously, or not at
// all — is cross-tree-references'.
// ---------------------------------------------------------------------------

export const surfaceReferenceBackingRule: SddRule = {
  name: 'surface-reference-backing',
  description:
    'The surface snapshot a cross-tree narrative target resolves to must back what the step asks of it: the calling component declares the collaborator, the snapshot exposes the called method (or serves the dispatched capability), and it declares every semantic guarantee the step asserts. A snapshot is the provider\'s declared contract, so these are contract verdicts rather than resolution failures.',
  codes: [
    { code: 'SURFACE_REF_NOT_EXPOSED', defaultSeverity: 'error', summary: 'Cross-tree reference resolves to a surface snapshot that does not expose the called method/capability' },
    { code: 'UNDECLARED_DEPENDENCY_CALL', defaultSeverity: 'error', summary: 'Call step targets a component the caller does not depend on or own' },
    { code: 'NARRATIVE_SEMANTIC_UNBACKED', defaultSeverity: 'warning', summary: 'Narrative asserts a guarantee the called contract does not declare' },
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
          // A malformed step is narrative-target-references', and a target this
          // tree contains is judged against its own L3 contract there.
          if (!step.targetComponent) continue;
          if (step.type !== 'dispatch' && !step.targetMethod) continue;
          const target = step.targetComponent;
          if (ctx.componentMap.get(target)) continue;

          // Only a reference that left this tree is judged against the
          // snapshots, and only one they resolve to a single declared contract
          // reaches this rule at all — every other verdict is
          // cross-tree-references'.
          const isCrossTreeForm = ctx.isExternalNamespaceRef(target);
          const isCollapsedForm = !isCrossTreeForm && fromSubsystem !== undefined
            && ctx.isCollapsedCrossTreeRef(target, fromSubsystem);
          if (!isCrossTreeForm && !isCollapsedForm) continue;
          const resolved = ctx.resolveSurfaceRef(target, fromSubsystem);
          if (resolved.kind !== 'resolved') continue;

          const verb = step.type === 'dispatch' ? 'dispatches through'
            : step.type === 'register' ? 'registers callback'
              : 'calls';

          // A target resolved through a surface is a collaborator like a local
          // one. The loader qualifies a cross-tree dependsOn entry exactly as it
          // qualifies the step's target, so a declared edge names the same
          // reference.
          if (caller && target !== caller.id && !caller.dependsOn.includes(target) && !caller.owns.includes(target)) {
            ctx.addIssue(
              'error',
              'UNDECLARED_DEPENDENCY_CALL',
              `Method "${implMethod.name}" in implementation "${impl.id}" (component "${caller.id}") ${verb} component "${target}" (step ${step.stepNumber}) but component "${caller.id}" does not list "${target}" as a dependency.`,
              impl.id,
              isDraftCtx || ctx.isComponentDraft(caller.id),
              true,
            );
          }

          // A dispatch step routes a capability: the DECLARED surface must serve it.
          if (step.type === 'dispatch') {
            if (step.capability && !(resolved.entry.dispatch ?? []).some(b => b.capability === step.capability)) {
              ctx.addIssue(
                'error',
                'SURFACE_REF_NOT_EXPOSED',
                `Method "${implMethod.name}" in implementation "${impl.id}" dispatches capability "${step.capability}" through cross-tree portal "${target}" (step ${step.stepNumber}), but the surface snapshot of "${resolved.snapshot.projectName}" does not serve that capability on "${resolved.entry.id}".`,
                impl.id,
                isDraftCtx,
                true,
              );
            }
            continue;
          }

          // A call or register step names a method: the DECLARED surface must
          // expose it, with the guarantees the step asserts.
          const surfaceMethod = resolved.entry.methods.find(m => m.name === step.targetMethod);
          if (!surfaceMethod) {
            ctx.addIssue(
              'error',
              'SURFACE_REF_NOT_EXPOSED',
              `Method "${implMethod.name}" in implementation "${impl.id}" ${verb} "${step.targetMethod}" on cross-tree component "${target}" (step ${step.stepNumber}), but the surface snapshot of "${resolved.snapshot.projectName}" does not expose that method on "${resolved.entry.id}".`,
              impl.id,
              isDraftCtx,
              true,
            );
            continue;
          }

          const declared = new Set(surfaceMethod.guarantees ?? []);
          for (const g of step.assertsGuarantees ?? []) {
            if (!declared.has(g)) {
              ctx.addIssue(
                'warning',
                'NARRATIVE_SEMANTIC_UNBACKED',
                `Step ${step.stepNumber} of "${implMethod.name}" in implementation "${impl.id}" asserts guarantee "${g}", but the surface snapshot of "${resolved.snapshot.projectName}" does not declare it on "${resolved.entry.id}.${step.targetMethod}".`,
                impl.id,
                isDraftCtx,
                true,
              );
            }
          }
        }
      }
    }
  },
};
