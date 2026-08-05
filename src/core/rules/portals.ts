import { SddRule } from './types.js';

// Maps a Portal's portalType to the wire `transport` its interface methods must
// declare on each `endpoint`. Custom is free-form (carries no endpoint obligation).
export const PORTAL_TRANSPORT: Record<string, string | undefined> = {
  HTTP_API: 'HTTP', gRPC: 'gRPC', GraphQL: 'GraphQL', MessageBus: 'MessageBus',
  NamedPipe: 'NamedPipe', IPC: 'IPC', CLI: 'CLI', Custom: undefined,
};

/**
 * The INTRINSIC half of the portal family: whether a component's wire fields
 * match its own stereotype. Every check here reads one component's own fields
 * and nothing else, which is what makes it `scope: 'spec'` — it also runs at the
 * write boundary, so a Portal-only field on a non-Portal is refused when it is
 * authored instead of becoming a permanent validate-time error on a spec the
 * author may have no way to repair.
 *
 * Split out of portalsRule (the endpoint-binding half) for exactly that reason:
 * these verdicts need no tree, and holding them back until validate time was
 * the difference between a typo and a wedged spec.
 */
export const portalFieldsRule: SddRule = {
  name: 'portal-fields',
  scope: 'spec',
  description:
    'A Portal declares its portalType. Non-Portal components carry no portalType, basePath, or auth (auth is inbound transport auth — a Gateway carries it on the Portal it owns). Intrinsic to one component: no tree required.',
  codes: [
    { code: 'MISSING_PORTAL_TYPE', defaultSeverity: 'error', summary: 'Portal without a portalType' },
    { code: 'UNEXPECTED_PORTAL_FIELD', defaultSeverity: 'error', summary: 'Non-Portal component with portalType/basePath' },
    { code: 'AUTH_ON_NON_PORTAL', defaultSeverity: 'warning', summary: 'Non-Portal component declaring auth (auth is inbound transport auth, only meaningful on a Portal)' },
  ],
  check(ctx) {
    for (const comp of ctx.components) {
      const isDraftCtx = ctx.isComponentDraft(comp.id);

      if (comp.componentType === 'Portal') {
        // A completeness code (draft-downgraded to a warning), so authoring a
        // Portal and setting its portalType on the next call stays legal.
        if (!comp.portalType) {
          ctx.addIssue(
            'error',
            'MISSING_PORTAL_TYPE',
            `Component "${comp.id}" has type "Portal" but is missing "portalType" field.`,
            comp.id,
            isDraftCtx,
          );
        }
        continue;
      }

      if (comp.portalType !== undefined || comp.basePath !== undefined) {
        ctx.addIssue(
          'error',
          'UNEXPECTED_PORTAL_FIELD',
          `Component "${comp.id}" is a ${comp.componentType}, not a Portal, but has "portalType" or "basePath" configured. Both are Portal-only — drop them, or make this component a Portal.`,
          comp.id,
          isDraftCtx,
        );
      }

      // Auth is inbound transport auth — it only means something on a
      // component that exposes a surface (a Portal). On anything else it is
      // ignored by the OpenAPI projection, so its presence is a modeling
      // mistake: a Gateway carries auth on the Portal it owns, not on itself.
      if (comp.auth !== undefined) {
        ctx.addIssue(
          'warning',
          'AUTH_ON_NON_PORTAL',
          `Component "${comp.id}" is a ${comp.componentType}, not a Portal, but declares "auth". Auth is inbound transport auth and is only meaningful on a Portal (a Gateway carries it on the Portal it owns). Move it to the exposed Portal, or remove it.`,
          comp.id,
          isDraftCtx,
        );
      }
    }
  },
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

      // Ensure non-portal components do not carry endpoints on their interface methods
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
  },
};
