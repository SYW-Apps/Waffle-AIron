import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Dispatch table bindings — the machine-readable capability → component.method
// map a generic-dispatch Portal declares. Every binding is contract-checked
// against the tree, so a capability can no longer exist only in prose while
// its server silently doesn't. The narrative steps that ROUTE through such a
// table are the dispatch-step-routing rule's subject.
// ---------------------------------------------------------------------------

export const dispatchTableBindingsRule: SddRule = {
  name: 'dispatch-table-bindings',
  description:
    'A dispatch table belongs to a Portal, binds each capability once, and binds it to an existing component.method inside the portal\'s own subsystem (the portal dispatches inward) that the portal declares under dependsOn or owns — the table is a real runtime invocation path.',
  codes: [
    { code: 'DISPATCH_ON_NON_PORTAL', defaultSeverity: 'error', summary: 'Dispatch table declared on a component that is not a Portal' },
    { code: 'DUPLICATE_CAPABILITY', defaultSeverity: 'error', summary: 'Capability bound more than once in one dispatch table' },
    { code: 'UNSERVED_CAPABILITY', defaultSeverity: 'error', summary: 'Capability has no existing server (bad table binding, or dispatch step routing a capability the target Portal does not serve)' },
    { code: 'DISPATCH_CROSS_SUBSYSTEM', defaultSeverity: 'error', summary: 'Dispatch binding targets a component outside the portal\'s subsystem' },
    { code: 'UNDECLARED_DISPATCH_TARGET', defaultSeverity: 'error', summary: 'Dispatch binding targets a component the portal does not depend on or own' },
  ],
  check(ctx) {
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
  },
};
