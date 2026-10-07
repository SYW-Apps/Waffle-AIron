import { parseDeclaredCall } from '../../../models/index.js';
import type { ComponentSpec } from '../../../models/index.js';
import { SddRule } from '../types.js';

/**
 * Adapter transport. An Adapter calls a verb on its target Portal's
 * interface, so its transport is the target's: inferred from the target when
 * the Adapter states none (HTTP for an HTTP API, a database connection for a
 * database Portal, ...). An Adapter MAY state its own; when it does and a
 * Portal it calls has another transport, that is ADAPTER_TRANSPORT_MISMATCH,
 * one finding per target — so a Portal's transport change shows its impact on
 * every Adapter that calls it. A Portal the tree cannot resolve (an external
 * one) is not judged here.
 */
export const adapterTransportRule: SddRule = {
  name: 'adapter-transport',
  judges: 'design',
  description:
    "An Adapter calls a verb on its target Portal's interface, so its transport is the target's: inferred from the target Portal when the Adapter states none (HTTP for an HTTP API, a database connection for a database Portal, ...). An Adapter MAY state its own transport; when it does and a Portal it calls (one it names in dependsOn, or the target of one of its call, register or dispatch steps or declared calls) has another transport, that is ADAPTER_TRANSPORT_MISMATCH, one finding per target — so changing a Portal's transport shows its impact on every Adapter that calls it. A Portal the tree cannot resolve (an external one) is not judged here. Reads the components and narratives of the tree.",
  codes: [
    { code: 'ADAPTER_TRANSPORT_MISMATCH', defaultSeverity: 'error', summary: 'An Adapter states a transport other than the transport of a Portal it calls' },
  ],
  check(ctx) {
    // Step 1: each Adapter that states a transport.
    for (const adapter of ctx.components.filter((c) => c.componentType === 'Adapter' && c.transport !== undefined)) {
      // Step 2: its target Portals, resolved in the tree.
      const targets = new Map<string, ComponentSpec>();
      const consider = (id: string | undefined): void => {
        if (!id) return;
        const target = ctx.componentMap.get(id);
        if (target?.componentType === 'Portal' && target.transport !== undefined) targets.set(target.id, target);
      };
      for (const dep of adapter.dependsOn ?? []) consider(dep);
      for (const impl of ctx.implementations) {
        if (ctx.interfaceMap.get(impl.contract)?.component !== adapter.id) continue;
        for (const method of impl.methods) {
          for (const step of method.narrative) {
            if (step.type === 'call' || step.type === 'register' || step.type === 'dispatch') consider(step.targetComponent);
          }
          for (const entry of method.calls ?? []) consider(parseDeclaredCall(entry)?.compId);
        }
      }
      // Step 3: each target whose transport differs.
      for (const target of [...targets.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        if (target.transport === adapter.transport) continue;
        ctx.addIssue(
          'error',
          'ADAPTER_TRANSPORT_MISMATCH',
          `Adapter "${adapter.id}" states transport "${adapter.transport}", but it calls Portal "${target.id}", whose transport is "${target.transport}": an Adapter calls its target's verbs over the target's transport. Follow the Portal's transport (set "${target.transport}"), or drop the Adapter's transport to take its target's.`,
          adapter.id,
          ctx.isComponentDraft(adapter.id),
          undefined,
          { at: target.id },
        );
      }
    }
    // Step 4.
  },
};
