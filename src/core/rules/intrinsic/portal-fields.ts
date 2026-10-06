import { SddRule } from '../types.js';

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
  judges: 'design',
  scope: 'spec',
  description:
    "A Portal declares its transport (the retired portalType is read as it for one release); only an InProcess Portal may declare an abi. Non-Portal components carry no transport, abi, basePath, auth or Portal-level invokedBy entry (auth is inbound transport auth: it belongs on the Portal that exposes the surface; an entry on a non-Portal is entry-declarations' ENTRY_ON_NON_PORTAL). Intrinsic to one component: no tree required.",
  codes: [
    { code: 'MISSING_PORTAL_TRANSPORT', defaultSeverity: 'error', summary: 'Portal without a transport' },
    { code: 'UNEXPECTED_PORTAL_FIELD', defaultSeverity: 'error', summary: 'Non-Portal component with transport, abi or basePath, or an abi on a Portal whose transport is not InProcess' },
    { code: 'AUTH_ON_NON_PORTAL', defaultSeverity: 'warning', summary: 'Non-Portal component declaring auth (auth is inbound transport auth, only meaningful on a Portal)' },
  ],
  check(ctx) {
    for (const comp of ctx.components) {
      const isDraftCtx = ctx.isComponentDraft(comp.id);

      if (comp.componentType === 'Portal') {
        // A completeness code (draft-downgraded to a warning), so authoring a
        // Portal and setting its transport on the next call stays legal.
        if (!comp.transport) {
          ctx.addIssue(
            'error',
            'MISSING_PORTAL_TRANSPORT',
            `Component "${comp.id}" has type "Portal" but declares no "transport" (HTTP, gRPC, GraphQL, MessageBus, CLI, IPC, NamedPipe, JSONRPC, InProcess or Custom).`,
            comp.id,
            isDraftCtx,
          );
        }
        if (comp.abi !== undefined && comp.transport !== 'InProcess') {
          // An abi says how a foreign language links a library: it belongs on
          // an InProcess Portal only.
          ctx.addIssue(
            'error',
            'UNEXPECTED_PORTAL_FIELD',
            `Portal "${comp.id}" has ${comp.transport ? `transport "${comp.transport}"` : 'no transport'} but declares an abi ("${comp.abi}"). An abi says how a foreign language links a library, so it belongs on an InProcess Portal only — drop it, or make the Portal InProcess.`,
            comp.id,
            isDraftCtx,
          );
        }
        continue;
      }

      if (comp.transport !== undefined || comp.abi !== undefined || comp.basePath !== undefined) {
        ctx.addIssue(
          'error',
          'UNEXPECTED_PORTAL_FIELD',
          `Component "${comp.id}" is a ${comp.componentType}, not a Portal, but has "transport", "abi" or "basePath" configured. They are Portal-only — drop them, or make this component a Portal.`,
          comp.id,
          isDraftCtx,
        );
      }

      // Auth is inbound transport auth — it only means something on a
      // component that exposes a surface (a Portal). On anything else it is
      // ignored by the OpenAPI projection, so its presence is a modeling
      // mistake: auth belongs on the Portal that exposes the surface, not on
      // whatever sits behind it.
      if (comp.auth !== undefined) {
        ctx.addIssue(
          'warning',
          'AUTH_ON_NON_PORTAL',
          `Component "${comp.id}" is a ${comp.componentType}, not a Portal, but declares "auth". Auth is inbound transport auth and is only meaningful on a Portal (auth belongs on the Portal that exposes the surface). Move it to the exposed Portal, or remove it.`,
          comp.id,
          isDraftCtx,
        );
      }
    }
  },
};
