import { SddRule } from '../types.js';
import { project } from '../reach-model-projector.js';
import { judge } from '../network-arbiter.js';

/**
 * The network rules over what the bound project's own gate can see: its own
 * network declaration and the components of its own tree. The verdicts are the
 * network arbiter's; this rule projects the project's own reach model, asks
 * the arbiter, and reports what it answers. The networks around a member, and
 * the proofs that need its siblings, are the family run's to judge
 * (family_validator.checkReach).
 */
export const networkBoundariesRule: SddRule = {
  name: 'network-boundaries',
  judges: 'design',
  description:
    "It judges what the bound project's own gate can see: its own network declaration and the components of its own tree. When the project declares a network, it projects the project's own reach model (reach_model_projector) and reports the network arbiter's findings on it: GATEWAY_BYPASSED, MULTIPLE_GATEWAYS and EXPORT_BEYOND_NETWORK, whose codes the arbiter declares. The rule registers them in the catalog under this rule's name. A project that declares no network has nothing to judge here. The networks around a member, and the proofs that need its siblings, are the family run's to judge (family_validator.checkReach).",
  codes: [
    { code: 'GATEWAY_BYPASSED', defaultSeverity: 'error', summary: 'Inside a declared network, a non-gateway Portal takes an entry from outside it, or a modelled call from outside the network lands on one' },
    { code: 'MULTIPLE_GATEWAYS', defaultSeverity: 'notice', summary: 'A declared network has more than one gateway Portal taking entries from outside it: allowed, not recommended' },
    { code: 'EXPORT_BEYOND_NETWORK', defaultSeverity: 'warning', summary: 'An export at an audience wider than project on a network-transport verb that callers beyond the network cannot reach' },
  ],
  check(ctx) {
    // Step 1: nothing to judge for a project that declares no network.
    if (!ctx.network) return;
    // Steps 2-3: the project's own reach model, judged.
    const findings = judge(project(ctx, ctx.network));
    // Step 4: each finding on the spec it names, in draft context when that
    // spec's component is draft.
    for (const f of findings) {
      ctx.addIssue(
        f.severity,
        f.code,
        f.message,
        f.specId,
        f.specId !== undefined && ctx.isComponentDraft(f.specId),
        undefined,
        f.at !== undefined ? { at: f.at } : undefined,
      );
    }
  },
};
