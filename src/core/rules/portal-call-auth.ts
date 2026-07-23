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
/** The `auth.from` prefix that turns a credential source into a MODELED component
 *  reference (`component:<id>`); everything else (`env:VAR`, `config:key`,
 *  `vault:path`, a free note) is an opaque external source wairon never resolves. */
const COMPONENT_REF_PREFIX = 'component:';

export const portalCallAuthRule: SddRule = {
  name: 'portal-call-auth',
  description:
    "Hardens authenticated cross-service calls. An OUTBOUND narrative `call` into ANOTHER component's Portal whose auth is not `none` must (a) be made by an Adapter — the only block that does external I/O — and (b) declare the credential source it presents via the step's `auth.from`. Absence of a source warns PORTAL_AUTH_UNMET; a non-Adapter presenter warns AUTH_PRESENTER_NOT_ADAPTER. When `auth.from` is a modeled reference (`component:<id>`) it must resolve to an Adapter/Store the presenter is wired to (UNKNOWN_AUTH_SOURCE / AUTH_SOURCE_NOT_PROVIDER / AUTH_SOURCE_UNWIRED). The actual secret is never stored in the spec. Dispatch steps (a portal's OWN inbound routing) and self-calls are not cross-service calls and are excluded.",
  codes: [
    { code: 'PORTAL_AUTH_UNMET', defaultSeverity: 'warning', summary: 'A narrative call into another component\'s authed Portal does not declare where its credential loads from' },
    { code: 'AUTH_PRESENTER_NOT_ADAPTER', defaultSeverity: 'warning', summary: 'A non-Adapter component authenticates an outbound call to a portal (external I/O must go through an Adapter)' },
    { code: 'UNKNOWN_AUTH_SOURCE', defaultSeverity: 'warning', summary: 'auth.from references a component: source that does not exist' },
    { code: 'AUTH_SOURCE_NOT_PROVIDER', defaultSeverity: 'warning', summary: 'auth.from references a component that is not an Adapter or Store' },
    { code: 'AUTH_SOURCE_UNWIRED', defaultSeverity: 'warning', summary: 'The presenter declares a component: credential source it does not depend on or own' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const ownComponent = ctx.interfaceMap.get(impl.contract)?.component;
      const presenter = ownComponent ? ctx.componentMap.get(ownComponent) : undefined;
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

          // (1b) The credential PRESENTER — the component making the authenticated
          // outbound call — must be an Adapter. An authenticated cross-service call
          // is external I/O, and the vocabulary reserves external I/O to Adapters
          // (a Gateway forwards through a client Adapter it owns, not directly).
          if (presenter && presenter.componentType !== 'Adapter') {
            ctx.addIssue(
              'warning',
              'AUTH_PRESENTER_NOT_ADAPTER',
              `Narrative step ${step.stepNumber} of "${method.name}" in "${impl.id}": "${presenter.id}" (${presenter.componentType}) authenticates an outbound call to portal "${target.id}". An authenticated cross-service call is external I/O and must be made by an Adapter (the only block that does external I/O) — route it through a client Adapter.`,
              impl.id,
              draft,
            );
          }

          const from = step.auth?.from;
          if (!from) {
            ctx.addIssue(
              'warning',
              'PORTAL_AUTH_UNMET',
              `Narrative step ${step.stepNumber} of "${method.name}" in "${impl.id}" calls the authenticated portal "${target.id}" (auth scheme: ${target.auth.scheme}) but does not declare where its credential is loaded from. Add the credential source (the step's auth.from — a secret-store component, env var, config key, or vault ref), or drop the portal's auth if it needs none.`,
              impl.id,
              draft,
            );
            continue; // no source to resolve
          }

          // (2a) A modeled source (`component:<id>`) must resolve to a real
          // credential provider the presenter is actually wired to — turning
          // "where the secret loads from" into a checked graph edge. Opaque
          // sources (env:/config:/vault:/free note) stay design notes.
          if (from.startsWith(COMPONENT_REF_PREFIX)) {
            const srcId = from.slice(COMPONENT_REF_PREFIX.length);
            const src = ctx.componentMap.get(srcId);
            if (!src) {
              ctx.addIssue(
                'warning',
                'UNKNOWN_AUTH_SOURCE',
                `Narrative step ${step.stepNumber} of "${method.name}" in "${impl.id}": auth.from references component "${srcId}", which does not exist.`,
                impl.id,
                draft,
              );
            } else {
              if (src.componentType !== 'Adapter' && src.componentType !== 'Store') {
                ctx.addIssue(
                  'warning',
                  'AUTH_SOURCE_NOT_PROVIDER',
                  `Narrative step ${step.stepNumber} of "${method.name}" in "${impl.id}": auth.from references "${srcId}" (${src.componentType}); a credential source must be an Adapter (loads the secret via external I/O) or a Store (holds it).`,
                  impl.id,
                  draft,
                );
              }
              const wired = (presenter?.dependsOn ?? []).includes(srcId) || (presenter?.owns ?? []).includes(srcId);
              if (presenter && !wired) {
                ctx.addIssue(
                  'warning',
                  'AUTH_SOURCE_UNWIRED',
                  `Narrative step ${step.stepNumber} of "${method.name}" in "${impl.id}": "${presenter.id}" loads its credential from "${srcId}" but neither depends on nor owns it — declare the dependsOn edge so the credential wiring is real.`,
                  impl.id,
                  draft,
                );
              }
            }
          }
        }
      }
    }
  },
};
