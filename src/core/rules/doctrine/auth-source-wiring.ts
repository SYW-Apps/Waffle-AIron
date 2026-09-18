import { SddRule } from '../types.js';

/**
 * The other half of cross-call auth: a credential source that is a MODELED
 * reference (`component:<id>`) must denote a real credential provider the
 * presenter is actually wired to — turning "where the secret loads from" into
 * a checked graph edge. Opaque sources (`env:VAR`, `config:key`, `vault:path`,
 * a free note) stay design notes wairon never resolves, and a step that names
 * no source at all is portal-call-auth's finding, not this rule's.
 */
/** The `auth.from` prefix that turns a credential source into a MODELED component
 *  reference (`component:<id>`); everything else (`env:VAR`, `config:key`,
 *  `vault:path`, a free note) is an opaque external source wairon never resolves. */
const COMPONENT_REF_PREFIX = 'component:';

export const authSourceWiringRule: SddRule = {
  name: 'auth-source-wiring',
  description:
    "Resolves the credential source a narrative call presents to an authenticated Portal. When the step's `auth.from` is a modeled reference (`component:<id>`) it must name a component that exists (UNKNOWN_AUTH_SOURCE), that can hold or load a secret — an Adapter or a Store (AUTH_SOURCE_NOT_PROVIDER) — and that the presenting component depends on or owns (AUTH_SOURCE_UNWIRED). Opaque sources (env:/config:/vault:/free note) are design notes and are never resolved; a missing source is portal-call-auth's finding.",
  codes: [
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
          // The subject: a MODELED credential source presented on an outbound
          // call into another component's authenticated Portal. A `dispatch` is
          // the portal's own inbound routing and a component never calls its own
          // portal, so neither is a cross-service call; a step with no source, or
          // an opaque one, has nothing to resolve.
          if (step.type !== 'call') continue;
          if (!step.targetComponent || step.targetComponent === ownComponent) continue;
          const target = ctx.componentMap.get(step.targetComponent);
          if (!target || target.componentType !== 'Portal') continue;
          if (!target.auth || target.auth.scheme === 'none') continue;
          const from = step.auth?.from;
          if (!from || !from.startsWith(COMPONENT_REF_PREFIX)) continue;

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
            continue;
          }

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
  },
};
