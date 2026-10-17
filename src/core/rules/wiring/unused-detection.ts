import { SddRule } from '../types.js';
import { walk, type WalkSeed } from '../narrative-graph-projector.js';
import { componentEntryFor, transportKind, type ComponentSpec } from '../../../models/index.js';

/**
 * Reachability analysis from the declared roots: unwired components and
 * methods are flagged. The walk itself is the narrative graph projector's.
 *
 * Every Portal verb must be REACHED: by a modelled caller, or by an entry
 * declared for it (callers outside the design). A Portal is no longer a root of
 * its own, and neither is a published component — that blanket seed is what
 * made an unreached verb invisible.
 *
 * The three codes ride TWO walks of one graph and stay together for that
 * reason: the internal walk (base roots alone) is what makes a runtime
 * declaration's redundancy answerable, and the full walk (the declared roots
 * added) is what makes the UNUSED_ verdicts answerable. Split apart, the same
 * graph would be walked four times.
 */
export const reachabilityRule: SddRule = {
  name: 'unused-detection',
  // Stage 8: its verdict needs the whole system's specs, so a part judged alone skips it.
  needsWholeTree: true,
  judges: 'design',
  description:
    "Walks the narrative execution graph (call steps, register handoffs, dispatch-table routing, lifecycle flows) from every declared root and flags the components and methods no execution chain reaches. The roots are: each lifecycle entrypoint; each Observer; each method of an interface that implements an imported extension point (the producer calls it); each MessageBus subscribe verb of a Portal whose topic the tree emits (the emitted topic reaches it); each Portal verb with an entry (its own invokedBy of kind entry, or its Portal's); and each method declaring a runtime invokedBy. A Portal is no longer a root of its own and a published component is not either, so a Portal verb that no modelled caller reaches and nobody declared an entry for is reported: the message names the two remedies, modelling the caller or declaring the entry with its scope. A network-scoped entry counts as declared here; the family run proves it. A runtime declaration the INTERNAL walk (without the declared roots) already reaches is stale and is reported. An entry never is, because it also states the verb's scope for the network rules and the flow matrix.",
  codes: [
    { code: 'UNUSED_COMPONENT', defaultSeverity: 'warning', summary: 'Component never reached by any narrative call chain from a declared root; for a Portal, none of its verbs is called by a modelled caller or declared an entry' },
    { code: 'UNUSED_METHOD', defaultSeverity: 'warning', summary: 'Method never called by any narrative step; for a Portal verb, no modelled caller reaches it and no entry is declared for it' },
    { code: 'INVOKED_BY_REDUNDANT', defaultSeverity: 'warning', summary: 'A runtime invokedBy declaration on a method the internal narrative walk already reaches: stale, remove it' },
  ],
  check(ctx) {
    // Step 1: the base roots — every Observer (all its methods), each
    // lifecycle entrypoint (its one method), and every method of an interface
    // that implements an imported extension point (the producer calls it).
    const baseRoots: WalkSeed[] = [];
    for (const comp of ctx.components) {
      if (comp.componentType === 'Observer') baseRoots.push({ compId: comp.id });
    }
    for (const sub of ctx.subsystems) {
      for (const le of sub.lifecycle ?? []) baseRoots.push({ compId: le.component, methodName: le.method });
    }
    for (const intf of ctx.interfaces) {
      if (intf.implements === undefined || !ctx.componentMap.has(intf.component)) continue;
      for (const m of intf.methods) baseRoots.push({ compId: intf.component, methodName: m.name });
    }
    // A MessageBus subscribe verb of a Portal is reached by its topic when the
    // tree emits it (an emits declaration or a publish endpoint), as an
    // Observer's subscription is. One whose topic nothing here emits is not a
    // root: UNSOURCED_SUBSCRIPTION reports the missing source, and an entry
    // declared for its outside publisher reaches it.
    const emitted = new Set<string>();
    for (const comp of ctx.components) for (const e of comp.emits ?? []) emitted.add(e.topic);
    for (const intf of ctx.interfaces) {
      for (const m of intf.methods) {
        if (m.endpoint?.transport === 'MessageBus' && m.endpoint.direction === 'publish') emitted.add(m.endpoint.topic);
      }
    }
    for (const intf of ctx.interfaces) {
      if (ctx.componentMap.get(intf.component)?.componentType !== 'Portal') continue;
      for (const m of intf.methods) {
        const ep = m.endpoint;
        if (ep?.transport === 'MessageBus' && ep.direction !== 'publish' && emitted.has(ep.topic)) {
          baseRoots.push({ compId: intf.component, methodName: m.name });
        }
      }
    }

    // Step 2: phase 1, the INTERNAL walk — the baseline a runtime declaration
    // is judged redundant against.
    const baseWalk = walk(ctx, baseRoots);

    // Steps 3-9: the declared roots — each Portal verb with an entry (whatever
    // its scope: a network-scoped entry counts as declared here, the family
    // run proves it), and each runtime declaration, judged for staleness.
    const declaredRoots: WalkSeed[] = [];
    for (const intf of ctx.interfaces) {
      // A declaration on a dangling component is the hierarchy family's finding.
      const comp = ctx.componentMap.get(intf.component);
      if (!comp) continue;
      for (const m of intf.methods) {
        if (comp.componentType === 'Portal' && componentEntryFor(comp, m.invokedBy)?.kind === 'entry') {
          declaredRoots.push({ compId: comp.id, methodName: m.name });
          continue;
        }
        if (m.invokedBy?.kind !== 'runtime') continue;
        declaredRoots.push({ compId: comp.id, methodName: m.name });
        if (!ctx.isSpecInScope(intf.id) || !baseWalk.reachesMethod(comp.id, m.name)) continue;
        const isDraftCtx = ctx.isComponentDraft(comp.id) || intf.status === 'draft' || intf.status === 'design';
        ctx.addIssue(
          'warning',
          'INVOKED_BY_REDUNDANT',
          `Method "${m.name}" on component "${comp.id}" declares a runtime invokedBy, but the internal narrative walk already reaches it — the declaration is stale; remove it.`,
          intf.id,
          isDraftCtx,
          undefined,
          { at: m.name },
        );
      }
    }

    // Step 10: phase 2, the FULL walk — an entered verb's narrative propagates.
    const reach = declaredRoots.length ? walk(ctx, [...baseRoots, ...declaredRoots]) : baseWalk;

    // Steps 11-17: the verdicts.
    for (const comp of ctx.components) {
      if (!ctx.isSpecInScope(comp.id)) continue;
      if (!reach.reachesComponent(comp.id)) {
        ctx.addIssue(
          'warning',
          'UNUSED_COMPONENT',
          comp.componentType === 'Portal'
            ? `Portal "${comp.id}" is defined but none of its verbs is reached: no modelled caller calls it and no entry is declared for it. Model the caller (a client Adapter's call step), or declare the entry its callers outside the design take: invokedBy {kind: entry, caller} on the Portal or on a verb${portalScopeHint(comp)}.`
            : `Component "${comp.id}" is defined but never reached by any execution call chain from a declared root (an entered Portal verb, an Observer, a lifecycle entrypoint or a runtime hook).`,
          comp.id,
          ctx.isComponentDraft(comp.id),
        );
        continue;
      }
      // Each unreached method on a reached component (across ALL its
      // interfaces), on the interface that declares it, sited at the method so
      // an allow covers exactly the one it names.
      for (const intf of ctx.interfacesByComponent.get(comp.id) ?? []) {
        for (const m of intf.methods) {
          if (reach.reachesMethod(comp.id, m.name)) continue;
          const isDraftCtx = ctx.isComponentDraft(comp.id) || intf.status === 'draft' || intf.status === 'design';
          ctx.addIssue(
            'warning',
            'UNUSED_METHOD',
            comp.componentType === 'Portal'
              ? `Portal verb "${m.name}" on "${comp.id}" is defined but never reached: no modelled caller calls it and no entry is declared for it. Model the caller, or declare the entry: invokedBy {kind: entry, caller} on the verb or on the Portal${portalScopeHint(comp)}.`
              : `Method "${m.name}" on component "${comp.id}" is defined but never called by any narrative step.`,
            intf.id,
            isDraftCtx,
            undefined,
            { at: m.name },
          );
        }
      }
    }
  },
};

/** The scope clause of the entry remedy: only a network transport takes one. */
function portalScopeHint(comp: ComponentSpec): string {
  return comp.transport && transportKind(comp.transport) === 'network'
    ? ', with scope network when only sibling services inside its network call it (outside, the default, otherwise)'
    : '';
}
