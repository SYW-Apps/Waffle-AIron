import { SddRule } from '../types.js';
import { walk, type WalkSeed } from '../narrative-graph-projector.js';

/**
 * Reachability analysis from entrypoints (Portals, Observers, published
 * components, declared lifecycle flows): unwired components and methods are
 * flagged. The walk itself is the narrative graph projector's.
 *
 * The three codes ride TWO walks of one graph and stay together for that
 * reason: the internal walk (base seeds alone) is what makes a declared
 * entrypoint's redundancy answerable, and the full walk (the invokedBy
 * entrypoints added) is what makes the UNUSED_ verdicts answerable. Split
 * apart, the same graph would be walked four times.
 */
export const reachabilityRule: SddRule = {
  name: 'unused-detection',
  description:
    'Walks the narrative execution graph (call steps, register handoffs, dispatch-table routing, lifecycle flows) from every entrypoint (Portal/Observer/published component/lifecycle entrypoint/invokedBy-declared method) and flags components and methods no execution chain reaches. An interface method declaring invokedBy (a real caller outside the modeled graph) seeds the walk, so its narrative propagates reachability; a declaration the INTERNAL walk (without those seeds) already reaches is stale and is reported.',
  codes: [
    { code: 'UNUSED_COMPONENT', defaultSeverity: 'warning', summary: 'Component never reached by any narrative call chain' },
    { code: 'UNUSED_METHOD', defaultSeverity: 'warning', summary: 'Method never called by any narrative step' },
    { code: 'INVOKED_BY_REDUNDANT', defaultSeverity: 'warning', summary: 'invokedBy declaration on a method the internal narrative walk already reaches — stale, remove it' },
  ],
  check(ctx) {
    // Collect root entry points: Portals, Observers, components backing public
    // subsystem interfaces (all their methods), and declared lifecycle
    // entrypoints (the specific init/shutdown method the runtime invokes).
    const seeds: WalkSeed[] = [];
    for (const comp of ctx.components) {
      if (comp.componentType === 'Portal' || comp.componentType === 'Observer') {
        seeds.push({ compId: comp.id });
      }
    }
    for (const sub of ctx.subsystems) {
      for (const pi of sub.publicInterfaces) {
        if (pi.component) {
          seeds.push({ compId: pi.component });
        }
      }
      for (const le of sub.lifecycle ?? []) {
        seeds.push({ compId: le.component, methodName: le.method });
      }
    }

    // Phase 1 — the INTERNAL walk (no invokedBy seeds): the baseline that
    // decides whether an invokedBy declaration is redundant.
    const baseWalk = walk(ctx, seeds);

    // Collect the invokedBy entrypoint seeds, and report the declarations the
    // internal walk already reaches.
    const invokedBySeeds: WalkSeed[] = [];
    for (const intf of ctx.interfaces) {
      // A declaration on an unresolvable component can't be judged (the
      // dangling reference is the hierarchy family's finding).
      if (!ctx.componentMap.has(intf.component)) continue;
      for (const m of intf.methods) {
        if (!m.invokedBy) continue;
        invokedBySeeds.push({ compId: intf.component, methodName: m.name });
        if (!ctx.isSpecInScope(intf.id)) continue;
        if (baseWalk.reachesMethod(intf.component, m.name)) {
          // A draft or design subsystem makes its components draft context too.
          const isDraftCtx = ctx.isComponentDraft(intf.component) || intf.status === 'draft' || intf.status === 'design';
          ctx.addIssue(
            'warning',
            'INVOKED_BY_REDUNDANT',
            `Method "${m.name}" on component "${intf.component}" declares invokedBy (${m.invokedBy.kind}), but the internal narrative walk already reaches it — the declaration is stale; remove it.`,
            intf.id,
            isDraftCtx,
          );
        }
      }
    }

    // Phase 2 — the FULL walk (base seeds + invokedBy entrypoints) feeds the
    // UNUSED_* verdicts, so a declared external caller's narrative propagates.
    const reach = invokedBySeeds.length
      ? walk(ctx, [...seeds, ...invokedBySeeds])
      : baseWalk;

    // Generate warnings for unused components
    for (const comp of ctx.components) {
      if (!ctx.isSpecInScope(comp.id)) continue;
      if (!reach.reachesComponent(comp.id)) {
        const isDraftCtx = ctx.isComponentDraft(comp.id);
        ctx.addIssue(
          'warning',
          'UNUSED_COMPONENT',
          `Component "${comp.id}" is defined but never reached by any execution call chain starting from portals or entry points.`,
          comp.id,
          isDraftCtx,
        );
        continue;
      }
      // Warn about unused methods on this reached component (across ALL its
      // interfaces), each on the interface that declares it — the method is
      // an L3 declaration, as it is for the invokedBy findings.
      for (const intf of ctx.interfacesByComponent.get(comp.id) ?? []) {
        for (const m of intf.methods) {
          if (!reach.reachesMethod(comp.id, m.name)) {
            const isDraftCtx = ctx.isComponentDraft(comp.id) || intf.status === 'draft' || intf.status === 'design';
            ctx.addIssue(
              'warning',
              'UNUSED_METHOD',
              `Method "${m.name}" on component "${comp.id}" is defined but never called by any narrative step.`,
              intf.id,
              isDraftCtx,
            );
          }
        }
      }
    }
  },
};
