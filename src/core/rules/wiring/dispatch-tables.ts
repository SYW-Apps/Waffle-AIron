import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Dispatch tables — machine-readable capability → component.method maps on
// generic-dispatch Portals, and the dispatch narrative step routed through
// them. Both sides are contract-checked so a capability can no longer exist
// only in prose while its server silently doesn't.
// ---------------------------------------------------------------------------

export const dispatchRule: SddRule = {
  name: 'dispatch-tables',
  description:
    'Portal dispatch tables must bind every capability to an existing component.method inside the portal\'s own subsystem (the portal dispatches inward), with no duplicate capabilities; dispatch narrative steps must route a declared capability through a Portal that actually serves it.',
  codes: [
    { code: 'DISPATCH_ON_NON_PORTAL', defaultSeverity: 'error', summary: 'Dispatch table declared on a component that is not a Portal' },
    { code: 'DUPLICATE_CAPABILITY', defaultSeverity: 'error', summary: 'Capability bound more than once in one dispatch table' },
    { code: 'UNSERVED_CAPABILITY', defaultSeverity: 'error', summary: 'Capability has no existing server (bad table binding, or dispatch step routing a capability the target Portal does not serve)' },
    { code: 'DISPATCH_CROSS_SUBSYSTEM', defaultSeverity: 'error', summary: 'Dispatch binding targets a component outside the portal\'s subsystem' },
    { code: 'UNDECLARED_DISPATCH_TARGET', defaultSeverity: 'error', summary: 'Dispatch binding targets a component the portal does not depend on or own' },
    { code: 'MALFORMED_DISPATCH_STEP', defaultSeverity: 'error', summary: 'Dispatch step missing its capability (targetComponent presence is the contracts rule\'s finding)' },
    { code: 'NARRATIVE_SEMANTIC_UNBACKED', defaultSeverity: 'warning', summary: 'Dispatch step asserts a guarantee the bound capability method does not declare' },
  ],
  check(ctx) {
    // --- table side ---------------------------------------------------------
    for (const comp of ctx.components) {
      if (!comp.dispatch || comp.dispatch.length === 0) continue;
      const isDraftCtx = ctx.isComponentDraft(comp.id);

      if (comp.componentType !== 'Portal') {
        ctx.addIssue(
          'error',
          'DISPATCH_ON_NON_PORTAL',
          `Component "${comp.id}" (${comp.componentType}) declares a dispatch table — capability dispatch is a Portal responsibility (the subsystem's front door routing inward).`,
          comp.id,
          isDraftCtx,
        );
      }

      const seen = new Set<string>();
      for (const b of comp.dispatch) {
        if (seen.has(b.capability)) {
          ctx.addIssue(
            'error',
            'DUPLICATE_CAPABILITY',
            `Dispatch table of "${comp.id}" binds capability "${b.capability}" more than once — runtime routing would be ambiguous.`,
            comp.id,
            isDraftCtx,
          );
        }
        seen.add(b.capability);

        const target = ctx.componentMap.get(b.component);
        if (!target) {
          ctx.addIssue(
            'error',
            'UNSERVED_CAPABILITY',
            `Dispatch table of "${comp.id}" binds capability "${b.capability}" to component "${b.component}", which does not exist — the capability has no server.`,
            comp.id,
            isDraftCtx,
          );
          continue;
        }
        if (!ctx.interfaceMethodsOf(target.id).some(method => method.name === b.method)) {
          ctx.addIssue(
            'error',
            'UNSERVED_CAPABILITY',
            `Dispatch table of "${comp.id}" binds capability "${b.capability}" to "${b.component}.${b.method}", but "${target.id}" declares no such method on any of its interfaces.`,
            comp.id,
            isDraftCtx || ctx.isComponentDraft(target.id),
          );
        }
        if (target.subsystem !== comp.subsystem) {
          ctx.addIssue(
            'error',
            'DISPATCH_CROSS_SUBSYSTEM',
            `Dispatch table of "${comp.id}" (subsystem "${comp.subsystem}") binds capability "${b.capability}" to "${b.component}" in subsystem "${target.subsystem}" — a portal dispatches inward; cross-subsystem hops go local Adapter → remote Portal.`,
            comp.id,
            isDraftCtx || ctx.isComponentDraft(target.id),
          );
        }
        // The table IS a runtime invocation path: declare it, so stereotype
        // and coupling rules see the portal's true fan-out.
        if (target.id !== comp.id && !comp.dependsOn.includes(target.id) && !comp.owns.includes(target.id)) {
          ctx.addIssue(
            'error',
            'UNDECLARED_DISPATCH_TARGET',
            `Dispatch table of "${comp.id}" binds capability "${b.capability}" to "${b.component}", but "${comp.id}" does not list it under dependsOn/owns — the dispatch edge is a real runtime dependency.`,
            comp.id,
            isDraftCtx || ctx.isComponentDraft(target.id),
          );
        }
      }
    }

    // --- step side ----------------------------------------------------------
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
          // Missing/dangling targetComponent is the contracts rule's finding.
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
          if (step.assertsGuarantees?.length) {
            const boundMethod = ctx.interfaceMethodsOf(binding.component).find(m => m.name === binding.method);
            const declared = new Set(boundMethod?.guarantees ?? []);
            for (const g of step.assertsGuarantees) {
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
    }
  },
};
