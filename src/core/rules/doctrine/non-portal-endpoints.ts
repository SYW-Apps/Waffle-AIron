import { SddRule } from '../types.js';

/**
 * The NON-PORTAL side of endpoint bindings: only a Portal may carry an
 * endpoint at all. A wire address on anything else means a block that is not
 * the system's boundary is being published as one.
 *
 * Reported as the Portal-side codes are: on the interface that declares the
 * endpoint (where the fix is made), carrying its draft status. Reads the
 * component's INTERFACES, so it cannot move to the write boundary.
 */
export const nonPortalEndpointsRule: SddRule = {
  name: 'non-portal-endpoints',
  description:
    'Only a Portal may carry endpoints: a method on a non-Portal component\'s interface that declares one is publishing a block that is not the system\'s boundary as if it were.',
  codes: [
    { code: 'ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT', defaultSeverity: 'error', summary: 'Non-Portal component method declaring an endpoint' },
  ],
  check(ctx) {
    for (const comp of ctx.components) {
      if (comp.componentType === 'Portal') continue;
      const isDraftCtx = ctx.isComponentDraft(comp.id);
      for (const intf of ctx.interfaces.filter(i => i.component === comp.id)) {
        const isIntfDraft = intf.status === 'draft' || intf.status === 'design';
        for (const m of intf.methods) {
          if (m.endpoint) {
            ctx.addIssue(
              'error',
              'ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT',
              `Architectural violation: Component "${comp.id}" is a ${comp.componentType}, but method "${m.name}" on its interface "${intf.id}" declares an endpoint. Only Portal components may carry endpoints.`,
              intf.id,
              isDraftCtx || isIntfDraft,
            );
          }
        }
      }
    }
  },
};
