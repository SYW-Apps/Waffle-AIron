import { SddRule } from '../types.js';

// Maps a Portal's portalType to the wire `transport` its interface methods must
// declare on each `endpoint`. Custom is free-form (carries no endpoint obligation).
export const PORTAL_TRANSPORT: Record<string, string | undefined> = {
  HTTP_API: 'HTTP', gRPC: 'gRPC', GraphQL: 'GraphQL', MessageBus: 'MessageBus',
  NamedPipe: 'NamedPipe', IPC: 'IPC', CLI: 'CLI', Custom: undefined,
};

/**
 * The TREE half: endpoint bindings. A Portal's every interface method needs an
 * endpoint of the matching transport, and a non-Portal's methods may declare
 * none at all. Both verdicts read the component's INTERFACES, so neither can
 * move to the write boundary — a component is legitimately authored before its
 * L3 contract exists.
 *
 * Field-shape verdicts live in portalFieldsRule; this rule stays silent about
 * them (a Portal with no portalType is simply skipped here — that rule reports
 * it, and there is no transport to check against).
 */
export const portalsRule: SddRule = {
  name: 'portal-endpoints',
  description:
    'A Portal binds every interface method to a concrete endpoint of the matching transport, and only a Portal may carry endpoints at all.',
  codes: [
    { code: 'MISSING_ENDPOINT', defaultSeverity: 'error', summary: 'Portal method without a wire endpoint binding' },
    { code: 'ENDPOINT_TRANSPORT_MISMATCH', defaultSeverity: 'error', summary: 'Endpoint transport does not match the Portal portalType' },
    { code: 'ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT', defaultSeverity: 'error', summary: 'Non-Portal component method declaring an endpoint' },
  ],
  check(ctx) {
    for (const comp of ctx.components) {
      const isDraftCtx = ctx.isComponentDraft(comp.id);
      const compInterfaces = ctx.interfaces.filter(i => i.component === comp.id);

      if (comp.componentType === 'Portal') {
        // No portalType ⇒ no expected transport. portalFieldsRule reports it.
        if (!comp.portalType) continue;
        // Generic endpoint check: every Portal whose portalType maps to a
        // transport requires each interface method to declare a concrete
        // `endpoint` of the MATCHING transport. One mechanism for HTTP /
        // gRPC / GraphQL / MessageBus / NamedPipe / IPC / CLI — bound via
        // the generic sdd_set_endpoints tool. Custom carries no obligation.
        const expected = PORTAL_TRANSPORT[comp.portalType];
        if (!expected) continue;
        for (const intf of compInterfaces) {
          const isIntfDraft = intf.status === 'draft' || intf.status === 'design';
          for (const m of intf.methods) {
            if (!m.endpoint) {
              ctx.addIssue(
                'error',
                'MISSING_ENDPOINT',
                `Method "${m.name}" on interface "${intf.id}" (Portal ${comp.portalType}) is missing an "endpoint" mapping. Bind it with sdd_set_endpoints (transport "${expected}").`,
                intf.id,
                isDraftCtx || isIntfDraft,
              );
            } else if (m.endpoint.transport !== expected) {
              ctx.addIssue(
                'error',
                'ENDPOINT_TRANSPORT_MISMATCH',
                `Method "${m.name}" on interface "${intf.id}" declares a "${m.endpoint.transport}" endpoint, but its Portal "${comp.id}" is portalType "${comp.portalType}" (expects transport "${expected}").`,
                intf.id,
                isDraftCtx || isIntfDraft,
              );
            }
          }
        }
        continue;
      }

      // Ensure non-portal components do not carry endpoints on their interface
      // methods. Reported as the Portal-side codes are: on the interface that
      // declares the endpoint (where the fix is made), carrying its draft status.
      for (const intf of compInterfaces) {
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
