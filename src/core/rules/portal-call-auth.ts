import { SddRule } from './types.js';

/**
 * Cross-call auth conformance (Phase 3 of the portal-auth epic).
 *
 * A narrative call/dispatch into a Portal whose `auth` is not `none` must declare
 * WHERE the credential it presents is loaded from — the step's `auth.from` (a
 * secret-store component id, `env:API_KEY`, a config key, a vault ref, …). wairon
 * treats that source as a DESIGN NOTE and never fetches it, but its ABSENCE means
 * authenticating to the callee was silently overlooked, which fails at runtime
 * (401). So the gap is flagged — a warning by default (the real secret is not in
 * the spec), escalatable to error per project via the rule registry.
 */
export const portalCallAuthRule: SddRule = {
  name: 'portal-call-auth',
  description:
    "An OUTBOUND narrative `call` into ANOTHER component's Portal whose auth is not `none` must declare the credential source it presents — the step's `auth.from`, a design note naming where the secret loads from (a secret-store component, env var, config key, vault ref). Its absence warns (PORTAL_AUTH_UNMET) so credential loading is never overlooked; the actual secret is never stored in the spec. Dispatch steps (a portal's OWN inbound routing) and self-calls are not cross-service calls and are excluded.",
  codes: [
    { code: 'PORTAL_AUTH_UNMET', defaultSeverity: 'warning', summary: 'A narrative call into another component\'s authed Portal does not declare where its credential loads from' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const ownComponent = ctx.interfaceMap.get(impl.contract)?.component;
      const draft = ctx.isImplementationDraft(impl);
      for (const method of impl.methods ?? []) {
        for (const step of method.narrative ?? []) {
          // Only OUTBOUND calls into ANOTHER component's portal. A `dispatch` is a
          // portal's own INBOUND routing (not a cross-service call), and a component
          // never calls its own portal — both are excluded.
          if (step.type !== 'call') continue;
          if (!step.targetComponent || step.targetComponent === ownComponent) continue;
          const target = ctx.componentMap.get(step.targetComponent);
          if (!target || target.componentType !== 'Portal') continue;
          if (!target.auth || target.auth.scheme === 'none') continue;
          if (step.auth?.from) continue; // the credential source is declared
          ctx.addIssue(
            'warning',
            'PORTAL_AUTH_UNMET',
            `Narrative step ${step.stepNumber} of "${method.name}" in "${impl.id}" calls the authenticated portal "${target.id}" (auth scheme: ${target.auth.scheme}) but does not declare where its credential is loaded from. Add the credential source (the step's auth.from — a secret-store component, env var, config key, or vault ref), or drop the portal's auth if it needs none.`,
            impl.id,
            draft,
          );
        }
      }
    }
  },
};
