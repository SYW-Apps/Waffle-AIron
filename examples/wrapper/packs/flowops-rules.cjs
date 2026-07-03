/*
 * Programmatic extension pack — the code half of a wrapper tool's doctrine.
 * Same shape as a declarative pack (name/profiles/languages all allowed),
 * plus `rules`: an array of SddRule objects written against wairon's
 * exported rule API (`import type { SddRule, RuleContext } from 'waffle-airon'`).
 *
 * Pack rule codes automatically work with per-spec `lint.allow` suppression
 * and project-level `rules.sddRuleSeverity` overrides, and appear in
 * `wairon rules list` tagged with this pack's name.
 */
module.exports = {
  name: 'flowops-rules',
  rules: [
    {
      name: 'flowops-portal-transport',
      description:
        'FlowOps scenarios are triggered, not called: a Portal in a flowops-automation subsystem must expose a MessageBus (webhook/event) transport, never a request/response API.',
      codes: [
        { code: 'FLOWOPS_PORTAL_TRANSPORT', defaultSeverity: 'error', summary: 'Portal in a flowops-automation subsystem must be MessageBus-triggered' },
      ],
      check(ctx) {
        for (const comp of ctx.components) {
          if (comp.componentType !== 'Portal') continue;
          if (ctx.getComponentProfile(comp.id) !== 'flowops-automation') continue;
          if (comp.portalType !== 'MessageBus') {
            ctx.addIssue(
              'error',
              'FLOWOPS_PORTAL_TRANSPORT',
              `Portal "${comp.id}" uses portalType ${comp.portalType ?? '(none)'} in a flowops-automation subsystem — FlowOps scenarios are triggered, not called: expose a MessageBus (webhook/event) trigger instead.`,
              comp.id,
              ctx.isComponentDraft(comp.id),
            );
          }
        }
      },
    },
  ],
};
