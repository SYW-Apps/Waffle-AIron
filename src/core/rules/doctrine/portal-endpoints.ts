import { SddRule } from '../types.js';
import { transportRequiresEndpoint } from '../../../models/index.js';

/**
 * The PORTAL side of endpoint bindings: a Portal's every interface method needs
 * an endpoint of the Portal's own transport, when that transport requires one
 * (every transport but InProcess and Custom: transport.requiresEndpoint). The verdict reads the
 * component's INTERFACES, so it cannot move to the write boundary — a component
 * is legitimately authored before its L3 contract exists.
 *
 * Field-shape verdicts live in portalFieldsRule; this rule stays silent about
 * them (a Portal with no transport is simply skipped here — that rule reports
 * it, and there is no transport to check against). That anything OTHER than a
 * Portal may not carry an endpoint at all is nonPortalEndpointsRule's verdict.
 */
export const portalsRule: SddRule = {
  name: 'portal-endpoints',
  judges: 'design',
  description:
    "A Portal binds every interface method to a concrete endpoint of its own transport, when that transport requires one (transport.requiresEndpoint): every transport but InProcess, whose verbs are the contract methods themselves, and Custom, whose address is free-form.",
  codes: [
    { code: 'MISSING_ENDPOINT', defaultSeverity: 'error', summary: 'Portal method without a wire endpoint binding, on a transport that requires one' },
    { code: 'ENDPOINT_TRANSPORT_MISMATCH', defaultSeverity: 'error', summary: "Endpoint transport does not match the Portal's transport" },
  ],
  check(ctx) {
    for (const comp of ctx.components) {
      // Generic endpoint check: every Portal whose transport requires an
      // endpoint requires each interface method to declare a concrete
      // `endpoint` of the SAME transport. One mechanism for HTTP / gRPC /
      // GraphQL / MessageBus / NamedPipe / IPC / CLI / JSONRPC — bound via the
      // generic sdd_set_endpoints tool. No transport ⇒ nothing expected
      // (portalFieldsRule reports it); InProcess and Custom carry no obligation.
      if (comp.componentType !== 'Portal') continue;
      const expected = comp.transport && transportRequiresEndpoint(comp.transport) ? comp.transport : undefined;
      if (!expected) continue;

      const isDraftCtx = ctx.isComponentDraft(comp.id);
      for (const intf of ctx.interfaces.filter(i => i.component === comp.id)) {
        const isIntfDraft = intf.status === 'draft' || intf.status === 'design';
        for (const m of intf.methods) {
          if (!m.endpoint) {
            ctx.addIssue(
              'error',
              'MISSING_ENDPOINT',
              `Method "${m.name}" on interface "${intf.id}" (Portal ${comp.transport}) is missing an "endpoint" mapping. Bind it with sdd_set_endpoints (transport "${expected}").`,
              intf.id,
              isDraftCtx || isIntfDraft,
            );
          } else if (m.endpoint.transport !== expected) {
            ctx.addIssue(
              'error',
              'ENDPOINT_TRANSPORT_MISMATCH',
              `Method "${m.name}" on interface "${intf.id}" declares a "${m.endpoint.transport}" endpoint, but its Portal "${comp.id}" has transport "${comp.transport}" (expects transport "${expected}").`,
              intf.id,
              isDraftCtx || isIntfDraft,
            );
          }
        }
      }
    }
  },
};
