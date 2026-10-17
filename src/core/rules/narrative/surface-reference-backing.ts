import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// A narrative target that left this tree and DID resolve against a stored
// surface snapshot: the snapshot is the provider's declared contract, so it is
// judged like a local one. The caller must declare the collaborator it reaches,
// the snapshot's entry must expose the method the step calls (or serve the
// capability it dispatches), and that entry must declare every semantic
// guarantee the step asserts.
//
// These are contract verdicts on a resolved reference, and each carries that
// resolution. Whether the reference resolves at all is the owner's
// resolution's: cross-tree-references' or project-boundaries' finding.
// ---------------------------------------------------------------------------

export const surfaceReferenceBackingRule: SddRule = {
  name: 'surface-reference-backing',
  judges: 'design',
  description:
    "The contract entry a narrative target in another project resolves to — a contained member's live export table, a declared external's pinned snapshot, or a foreign surface snapshot — must back what the step asks of it: the calling component declares the collaborator, the entry exposes the called method (or serves the dispatched capability), and it declares every semantic guarantee the step asserts. These are contract verdicts on a resolved reference, and each carries that resolution.",
  codes: [
    { code: 'SURFACE_REF_NOT_EXPOSED', defaultSeverity: 'error', summary: "Cross-tree reference resolves to a surface snapshot that does not expose the called method/capability" },
    { code: 'UNDECLARED_DEPENDENCY_CALL', defaultSeverity: 'error', summary: "Call step targets a component the caller does not depend on or own" },
    { code: 'NARRATIVE_SEMANTIC_UNBACKED', defaultSeverity: 'warning', summary: "Narrative asserts a guarantee the called contract does not declare" },
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

          // Only a reference that left the project AND resolved to a single
          // declared contract entry reaches this rule — every other verdict is
          // cross-tree-references' or project-boundaries'.
          const resolution = ctx.resolveCrossProject(impl.id, 'narrative', target);
          if (!resolution || resolution.outcome !== 'resolved') continue;
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
              resolution,
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
                resolution,
              );
            }
            continue;
          }

          // A call or register step names a method: the DECLARED surface must
          // expose it, with the guarantees the step asserts.
          const surfaceMethod = resolved.entry.methods.find(m => m.name === step.targetMethod);
          if (!surfaceMethod) {
            // The rename trace answers "renamed to"; a name it does not know
            // may be newer than the pin, which only a re-pin can learn.
            const renamedTo = resolved.entry.methods.find((m) => (m.formerly ?? []).some((f) => f === step.targetMethod || f.endsWith(`.${step.targetMethod}`)))?.name;
            const alias = target.includes('::') ? target.split('::')[0] : undefined;
            const hint = renamedTo !== undefined
              ? ` It was renamed to "${renamedTo}" (the producer's rename trace records "${step.targetMethod}") — follow the rename.`
              : alias !== undefined
                ? ` If the producer added it after this pin was taken, the pin cannot know it: re-pin (\`wairon externals pin ${alias}\`) once the producer exports it.`
                : '';
            ctx.addIssue(
              'error',
              'SURFACE_REF_NOT_EXPOSED',
              `Method "${implMethod.name}" in implementation "${impl.id}" ${verb} "${step.targetMethod}" on cross-tree component "${target}" (step ${step.stepNumber}), but the surface snapshot of "${resolved.snapshot.projectName}" does not expose that method on "${resolved.entry.id}".${hint}`,
              impl.id,
              isDraftCtx,
              resolution,
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
                resolution,
              );
            }
          }
        }
      }
    }
  },
};
