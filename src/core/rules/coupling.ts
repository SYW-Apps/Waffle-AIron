import { SddRule } from './types.js';
import { splitNamespace } from '../specs.js';

/** Default dependsOn count above which a component is flagged as doing too much.
 *  Overridable per project via rules.complexity.maxComponentDependencies — the
 *  same knob the EXCESSIVE_DEPENDENCIES rule reads, so both agree on the cap. */
const DEFAULT_GOD_COMPONENT_THRESHOLD = 8;

/**
 * Coupling health: mutual subsystem dependencies must be explicitly sanctioned
 * via trustedLinks (turning "fast lanes" into reviewable spec), trustedLinks
 * must reference real peers, and components with an excessive dependency
 * fan-out are flagged as god components.
 */
export const couplingRule: SddRule = {
  name: 'coupling-health',
  description:
    'Two subsystems depending on each other is a real architectural commitment (deployment affinity, backpressure, scaling coupling). It is allowed — both directions must still use the Adapter → published Portal shape — but must be acknowledged with a trustedLinks declaration on either side, stating the reason (e.g. a latency fast lane that bypasses the bus). Also flags components whose dependsOn fan-out suggests a god component.',
  codes: [
    { code: 'MUTUAL_SUBSYSTEM_DEPENDENCY', defaultSeverity: 'warning', summary: 'Subsystems depend on each other without a declared trusted link' },
    { code: 'INVALID_TRUSTED_LINK', defaultSeverity: 'error', summary: 'trustedLinks references a non-existent subsystem' },
    { code: 'UNUSED_TRUSTED_LINK', defaultSeverity: 'warning', summary: 'trustedLinks declares a peer no dependency actually reaches' },
    { code: 'GOD_COMPONENT', defaultSeverity: 'warning', summary: 'Component with excessive dependency fan-out' },
  ],
  check(ctx) {
    // --- Build the subsystem-level dependency graph from cross-subsystem component deps
    const subsystemDeps = new Map<string, Set<string>>(); // from -> to
    const exampleEdge = new Map<string, string>();        // "from->to" -> example component edge
    for (const comp of ctx.components) {
      for (const depId of comp.dependsOn) {
        const dep = ctx.componentMap.get(depId);
        if (!dep || dep.subsystem === comp.subsystem) continue;
        const set = subsystemDeps.get(comp.subsystem) ?? new Set<string>();
        set.add(dep.subsystem);
        subsystemDeps.set(comp.subsystem, set);
        const key = `${comp.subsystem}->${dep.subsystem}`;
        if (!exampleEdge.has(key)) exampleEdge.set(key, `${comp.id} → ${dep.id}`);
      }
    }

    // trustedLinks index: subsystem -> set of peers it sanctions.
    // A declared link on EITHER side acknowledges the pair.
    const sanctionedPairs = new Set<string>();
    const pairKey = (a: string, b: string) => [a, b].sort().join('<->');
    const declaredPeers = new Map<string, Set<string>>();
    for (const sub of ctx.subsystems) {
      const isDraftCtx = sub.status === 'draft' || sub.status === 'design';
      for (const link of sub.trustedLinks ?? []) {
        // Resolve the peer: exact id, or a local id within the same namespace.
        const { prefix } = splitNamespace(sub.id);
        const candidates = [link.subsystem, prefix ? `${prefix}::${link.subsystem}` : link.subsystem];
        const peer = ctx.subsystems.find(s => candidates.includes(s.id));
        if (!peer) {
          ctx.addIssue(
            'error',
            'INVALID_TRUSTED_LINK',
            `Subsystem "${sub.id}" declares a trusted link to "${link.subsystem}", which does not exist.`,
            sub.id,
            isDraftCtx,
          );
          continue;
        }
        sanctionedPairs.add(pairKey(sub.id, peer.id));
        const peers = declaredPeers.get(sub.id) ?? new Set<string>();
        peers.add(peer.id);
        declaredPeers.set(sub.id, peers);

        // A trusted link that no actual dependency uses is stale spec — flag it.
        const outbound = subsystemDeps.get(sub.id)?.has(peer.id) ?? false;
        const inbound = subsystemDeps.get(peer.id)?.has(sub.id) ?? false;
        if (!outbound && !inbound) {
          ctx.addIssue(
            'warning',
            'UNUSED_TRUSTED_LINK',
            `Subsystem "${sub.id}" declares a trusted link to "${peer.id}" (reason: "${link.reason}"), but no component dependency crosses between them. Remove the stale link or wire the dependency.`,
            sub.id,
            isDraftCtx,
          );
        }
      }
    }

    // --- Mutual dependency detection
    const reported = new Set<string>();
    for (const [from, tos] of subsystemDeps) {
      for (const to of tos) {
        if (!(subsystemDeps.get(to)?.has(from))) continue; // not mutual
        const key = pairKey(from, to);
        if (reported.has(key)) continue;
        reported.add(key);
        if (sanctionedPairs.has(key)) continue; // acknowledged via trustedLinks

        const subA = ctx.subsystems.find(s => s.id === from);
        const subB = ctx.subsystems.find(s => s.id === to);
        const isDraftCtx = (subA?.status === 'draft' || subA?.status === 'design')
          && (subB?.status === 'draft' || subB?.status === 'design');
        ctx.addIssue(
          'warning',
          'MUTUAL_SUBSYSTEM_DEPENDENCY',
          `Subsystems "${from}" and "${to}" depend on each other (${exampleEdge.get(`${from}->${to}`)}; ${exampleEdge.get(`${to}->${from}`)}). Mutual coupling is a real commitment — if intentional (e.g. a latency fast lane bypassing the bus between trusted services), declare it with trustedLinks on either subsystem, stating the reason; otherwise break one direction (usually via events over the bus).`,
          from,
          isDraftCtx,
        );
      }
    }

    // --- God component detection
    const threshold = ctx.rules?.complexity?.maxComponentDependencies ?? DEFAULT_GOD_COMPONENT_THRESHOLD;
    for (const comp of ctx.components) {
      if (comp.dependsOn.length > threshold) {
        ctx.addIssue(
          'warning',
          'GOD_COMPONENT',
          `Component "${comp.id}" depends on ${comp.dependsOn.length} components (> ${threshold}). That fan-out suggests it owns more than one responsibility — split the workflow, or group cohesive collaborators behind a pattern facade (Repository/Gateway).`,
          comp.id,
          ctx.isComponentDraft(comp.id),
        );
      }
    }
  },
};
