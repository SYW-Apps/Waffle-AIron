import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Dispatch step routing — the narrative side of generic dispatch. A dispatch
// step names the capability it routes and the Portal it routes through; both
// are checked against that portal's dispatch table, so a step can no longer
// route a capability nobody serves. The table itself is the
// dispatch-table-bindings rule's subject.
// ---------------------------------------------------------------------------

export const dispatchStepRoutingRule: SddRule = {
  name: 'dispatch-step-routing',
  description:
    'A dispatch narrative step must name the capability it routes and route it through a Portal whose dispatch table actually serves that capability; a guarantee the step asserts must be declared by the contract method the capability resolves to.',
  codes: [
    { code: 'MALFORMED_DISPATCH_STEP', defaultSeverity: 'error', summary: 'Dispatch step missing its capability (targetComponent presence is narrative-target-references\' finding)' },
    { code: 'UNSERVED_CAPABILITY', defaultSeverity: 'error', summary: 'Capability has no existing server (bad table binding, or dispatch step routing a capability the target Portal does not serve)' },
    { code: 'NARRATIVE_SEMANTIC_UNBACKED', defaultSeverity: 'warning', summary: 'Dispatch step asserts a guarantee the bound capability method does not declare' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const isDraftCtx = ctx.isImplementationDraft(impl);

      for (const implMethod of impl.methods) {
        for (const step of implMethod.narrative) {
          if (step.type !== 'dispatch') continue;
          const where = `Method "${implMethod.name}" in implementation "${impl.id}": dispatch step ${step.stepNumber}`;

          if (!step.capability) {
            ctx.addIssue(
              'error',
              'MALFORMED_DISPATCH_STEP',
              `${where} requires "capability" (the routed capability name).`,
              impl.id,
              isDraftCtx,
            );
            continue;
          }
          // A missing targetComponent is narrative-target-references' finding,
          // and a dangling one cross-tree-references'.
          if (!step.targetComponent) continue;
          const portal = ctx.componentMap.get(step.targetComponent);
          if (!portal) continue;

          if (portal.componentType !== 'Portal' || !portal.dispatch || portal.dispatch.length === 0) {
            ctx.addIssue(
              'error',
              'UNSERVED_CAPABILITY',
              `${where} routes capability "${step.capability}" through "${portal.id}", which ${portal.componentType !== 'Portal' ? `is a ${portal.componentType}, not a Portal` : 'declares no dispatch table'} — the capability cannot be resolved to a server.`,
              impl.id,
              isDraftCtx || ctx.isComponentDraft(portal.id),
            );
            continue;
          }

          const binding = portal.dispatch.find(b => b.capability === step.capability);
          if (!binding) {
            ctx.addIssue(
              'error',
              'UNSERVED_CAPABILITY',
              `${where} routes capability "${step.capability}" through "${portal.id}", but that portal's dispatch table does not serve it (declared: ${portal.dispatch.map(b => `"${b.capability}"`).join(', ')}).`,
              impl.id,
              isDraftCtx || ctx.isComponentDraft(portal.id),
            );
            continue;
          }

          // Same consistency check call steps get: a guarantee this step
          // asserts must be declared by the method the capability resolves to.
          // A binding naming a missing component or method is the table side's
          // UNSERVED_CAPABILITY, and a guarantee cannot be judged against a
          // method that does not exist.
          const boundMethod = ctx.interfaceMethodsOf(binding.component).find(m => m.name === binding.method);
          if (!boundMethod) continue;
          const declared = new Set(boundMethod.guarantees ?? []);
          for (const g of step.assertsGuarantees ?? []) {
            if (!declared.has(g)) {
              ctx.addIssue(
                'warning',
                'NARRATIVE_SEMANTIC_UNBACKED',
                `${where} asserts guarantee "${g}", but capability "${step.capability}" resolves to "${binding.component}.${binding.method}", which does not list "${g}" among its L3 contract guarantees. Declare it there (and ensure its shape can deliver it), or revise the narrative.`,
                impl.id,
                isDraftCtx || ctx.isComponentDraft(binding.component),
              );
            }
          }
        }
      }
    }
  },
};
