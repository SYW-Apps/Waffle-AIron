import { SddRule } from '../types.js';

// Maps a Portal's portalType to the wire `transport` its interface methods must
// declare on each `endpoint`. Custom is free-form (carries no endpoint obligation).
export const PORTAL_TRANSPORT: Record<string, string | undefined> = {
  HTTP_API: 'HTTP', gRPC: 'gRPC', GraphQL: 'GraphQL', MessageBus: 'MessageBus',
  NamedPipe: 'NamedPipe', IPC: 'IPC', CLI: 'CLI', Custom: undefined,
};

/**
 * The PORTAL side of endpoint bindings: a Portal's every interface method needs
 * an endpoint of the transport its portalType expects. The verdict reads the
 * component's INTERFACES, so it cannot move to the write boundary — a component
 * is legitimately authored before its L3 contract exists.
 *
 * Field-shape verdicts live in portalFieldsRule; this rule stays silent about
 * them (a Portal with no portalType is simply skipped here — that rule reports
 * it, and there is no transport to check against). That anything OTHER than a
 * Portal may not carry an endpoint at all is nonPortalEndpointsRule's verdict.
 */
export const portalsRule: SddRule = {
  name: 'portal-endpoints',
  description:
    'A Portal binds every interface method to a concrete endpoint of the transport its portalType expects.',
  codes: [
    { code: 'MISSING_ENDPOINT', defaultSeverity: 'error', summary: 'Portal method without a wire endpoint binding' },
    { code: 'ENDPOINT_TRANSPORT_MISMATCH', defaultSeverity: 'error', summary: 'Endpoint transport does not match the Portal portalType' },
  ],
  check(ctx) {
    for (const comp of ctx.components) {
      // Generic endpoint check: every Portal whose portalType maps to a
      // transport requires each interface method to declare a concrete
      // `endpoint` of the MATCHING transport. One mechanism for HTTP / gRPC /
      // GraphQL / MessageBus / NamedPipe / IPC / CLI — bound via the generic
      // sdd_set_endpoints tool. No portalType ⇒ no expected transport
      // (portalFieldsRule reports it), and Custom carries no obligation.
      if (comp.componentType !== 'Portal') continue;
      const expected = comp.portalType ? PORTAL_TRANSPORT[comp.portalType] : undefined;
      if (!expected) continue;

      const isDraftCtx = ctx.isComponentDraft(comp.id);
      for (const intf of ctx.interfaces.filter(i => i.component === comp.id)) {
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
    }
  },
};
