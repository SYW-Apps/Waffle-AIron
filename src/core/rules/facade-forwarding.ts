import type { SddRule } from './types.js';

// ---------------------------------------------------------------------------
// The facade rule (docs/standards/architecture.md §7): a pattern's facade does
// PURE 1:1 forwarding — every facade method's authored narrative is exactly
// one `call` step targeting an owned member block. More than one step, a
// non-call step, or a call that leaves the pattern means the facade contains
// logic, and logic belongs inside a member (Registry/Index/Store for a
// Repository; ingress Orchestrator/Specialists for a Gateway). Scoped to the
// backend patterns (Repository/Gateway) whose facade semantics §7 defines;
// methods without an authored narrative are the detail dial's business, not
// this rule's.
// ---------------------------------------------------------------------------

const FACADE_TYPES = new Set(['Repository', 'Gateway']);

export const facadeForwardingRule: SddRule = {
  name: 'facade-forwarding',
  description:
    'A Repository/Gateway facade method with an authored narrative must be pure 1:1 forwarding: exactly one call step, targeting one of the pattern\'s owned members. Anything else is logic living on the facade — move it into a member block, or acknowledge a deliberate exception via lint.allow.',
  codes: [
    { code: 'FACADE_FORWARDING', defaultSeverity: 'warning', summary: 'Pattern facade narrative is not a single call to an owned member' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      if (!contract) continue;
      const comp = ctx.componentMap.get(contract.component);
      if (!comp || !FACADE_TYPES.has(comp.componentType)) continue;
      const owned = new Set(comp.owns);
      const isDraftCtx = ctx.isImplementationDraft(impl);

      for (const method of impl.methods) {
        const steps = method.narrative ?? [];
        if (steps.length === 0) continue;

        let problem: string | undefined;
        if (steps.length !== 1) {
          problem = `has ${steps.length} steps (${steps.map(s => s.type).join(', ')})`;
        } else if (steps[0].type !== 'call') {
          problem = `is a single "${steps[0].type}" step, not a call`;
        } else if (steps[0].targetComponent && !owned.has(steps[0].targetComponent)) {
          problem = `forwards outside the pattern — its call targets "${steps[0].targetComponent}", which "${comp.id}" does not own`;
        }
        if (problem) {
          ctx.addIssue(
            'warning',
            'FACADE_FORWARDING',
            `Facade method "${method.name}" of ${comp.componentType} "${comp.id}" (implementation "${impl.id}") must be pure 1:1 forwarding — exactly one call step to an owned member (${comp.owns.join(', ') || 'none declared'}) — but its narrative ${problem}. Move the logic into a member block, or lint.allow a deliberate exception.`,
            impl.id,
            isDraftCtx,
          );
        }
      }
    }
  },
};
