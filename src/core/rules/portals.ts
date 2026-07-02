import { SddRule } from './types.js';

// Maps a Portal's portalType to the wire `transport` its interface methods must
// declare on each `endpoint`. Custom is free-form (carries no endpoint obligation).
export const PORTAL_TRANSPORT: Record<string, string | undefined> = {
  HTTP_API: 'HTTP', gRPC: 'gRPC', GraphQL: 'GraphQL', MessageBus: 'MessageBus',
  NamedPipe: 'NamedPipe', IPC: 'IPC', CLI: 'CLI', Custom: undefined,
};

/**
 * Portals are the only components carrying wire concerns: portalType is
 * required, every method needs a matching-transport endpoint, and non-Portal
 * components may not declare endpoints or portal fields at all.
 */
export const portalsRule: SddRule = {
  name: 'portal-endpoints',
  description:
    'A Portal declares its portalType and binds every interface method to a concrete endpoint of the matching transport. Non-Portal components carry no portalType, basePath, or endpoints.',
  codes: [
    { code: 'MISSING_PORTAL_TYPE', defaultSeverity: 'error', summary: 'Portal without a portalType' },
    { code: 'MISSING_ENDPOINT', defaultSeverity: 'error', summary: 'Portal method without a wire endpoint binding' },
    { code: 'ENDPOINT_TRANSPORT_MISMATCH', defaultSeverity: 'error', summary: 'Endpoint transport does not match the Portal portalType' },
    { code: 'UNEXPECTED_PORTAL_FIELD', defaultSeverity: 'error', summary: 'Non-Portal component with portalType/basePath' },
    { code: 'ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT', defaultSeverity: 'error', summary: 'Non-Portal component method declaring an endpoint' },
  ],
  check(ctx) {
    for (const comp of ctx.components) {
      const isDraftCtx = ctx.isComponentDraft(comp.id);

      if (comp.componentType === 'Portal') {
        if (!comp.portalType) {
          ctx.addIssue(
            'error',
            'MISSING_PORTAL_TYPE',
            `Component "${comp.id}" has type "Portal" but is missing "portalType" field.`,
            comp.id,
            isDraftCtx,
          );
        } else {
          // Generic endpoint check: every Portal whose portalType maps to a
          // transport requires each interface method to declare a concrete
          // `endpoint` of the MATCHING transport. One mechanism for HTTP /
          // gRPC / GraphQL / MessageBus / NamedPipe / IPC / CLI — bound via
          // the generic sdd_set_endpoints tool. Custom carries no obligation.
          const expected = PORTAL_TRANSPORT[comp.portalType];
          if (expected) {
            const compInterfaces = ctx.interfaces.filter(i => i.component === comp.id);
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
          }
        }
      } else {
        if (comp.portalType !== undefined || comp.basePath !== undefined) {
          ctx.addIssue(
            'error',
            'UNEXPECTED_PORTAL_FIELD',
            `Component "${comp.id}" does not have type "Portal" but has "portalType" or "basePath" configured.`,
            comp.id,
            isDraftCtx,
          );
        }

        // Ensure non-portal components do not carry endpoints on their interface methods
        const compInterfaces = ctx.interfaces.filter(i => i.component === comp.id);
        for (const intf of compInterfaces) {
          for (const m of intf.methods) {
            if (m.endpoint) {
              ctx.addIssue(
                'error',
                'ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT',
                `Architectural violation: Component "${comp.id}" is a ${comp.componentType}, but method "${m.name}" on its interface "${intf.id}" declares an endpoint. Only Portal components may carry endpoints.`,
                comp.id,
                isDraftCtx,
              );
            }
          }
        }
      }
    }
  },
};
