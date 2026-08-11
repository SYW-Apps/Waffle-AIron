import { RuleContext, SddRule } from './types.js';
import { BUILTIN_TYPES, extractTypeIdentifiers, extractTypeGenerics, methodTypeRefs, matchTypeRef } from './type-analysis.js';
import { effectiveNarrativeDetail, passesIntentFloor } from './narrative-detail.js';

/** Dependency-cycle detection over the component dependsOn graph. */
export const cyclesRule: SddRule = {
  name: 'dependency-cycles',
  description: 'The component dependsOn graph must be a DAG; the first detected cycle is reported with its full path.',
  codes: [
    { code: 'CIRCULAR_DEPENDENCY', defaultSeverity: 'error', summary: 'Circular dependency between components' },
  ],
  check(ctx) {
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const dfs = (compId: string, pathTrace: string[]): boolean => {
      visited.add(compId);
      recStack.add(compId);
      pathTrace.push(compId);

      const comp = ctx.componentMap.get(compId);
      if (comp) {
        for (const depId of comp.dependsOn) {
          if (!visited.has(depId)) {
            if (dfs(depId, pathTrace)) {
              recStack.delete(compId);
              pathTrace.pop();
              return true;
            }
          } else if (recStack.has(depId)) {
            pathTrace.push(depId);
            const cyclePath = pathTrace.slice(pathTrace.indexOf(depId)).join(' -> ');
            const isDraftCtx = ctx.isComponentDraft(compId) || ctx.isComponentDraft(depId);
            ctx.addIssue(
              'error',
              'CIRCULAR_DEPENDENCY',
              `Circular dependency detected: ${cyclePath}`,
              compId,
              isDraftCtx,
            );
            pathTrace.pop();
            recStack.delete(compId);
            pathTrace.pop();
            return true;
          }
        }
      }

      recStack.delete(compId);
      pathTrace.pop();
      return false;
    };

    for (const comp of ctx.components) {
      if (!visited.has(comp.id)) {
        if (dfs(comp.id, [])) {
          break;
        }
      }
    }
  },
};

// Key with '#': component ids may themselves contain '::' (namespaced subprojects),
// so '::' cannot separate component from method.
export const methodKey = (compId: string, methodName: string): string => `${compId}#${methodName}`;

/** A reachability seed: a specific method, or (methodName omitted) every contract method of the component. */
export interface WalkSeed {
  compId: string;
  methodName?: string;
}

/**
 * The shared narrative-graph walker: BFS over L5 execution edges from a seed
 * set. Edges are `call` steps, `dispatch` steps (routed through the target
 * Portal's dispatch table to the bound capability server), and every dispatch
 * binding of a reached Portal (its declared served surface — the runtime
 * dispatches into those bindings even though no static call names them).
 * Used by unused-detection (roots: Portals/Observers/published components/
 * lifecycle entrypoints) and by the durability round-trip rule (roots:
 * lifecycle init flows only).
 */
export interface WalkOptions {
  /**
   * Whether reaching a Portal floods every binding of its dispatch table into
   * the reachable set. TRUE for unused-detection (the table IS the portal's
   * served surface). FALSE for the durability boot-graph: at boot only edges
   * the init narratives actually take count — a capability merely *offered*
   * by a reached portal is not a boot-time read. Explicit `dispatch` steps
   * are followed either way.
   */
  followDispatchTables?: boolean;
  /**
   * Whether `register` steps (runtime-callback handoffs) contribute edges.
   * TRUE for unused-detection: a callback handed to the runtime IS reached
   * wherever its registering narrative is reached. FALSE for the durability
   * boot-graph: registration is a deferred invocation — registering a hydration
   * read at init does not execute it at boot, so the boot walk must not take
   * the edge (same doctrine as the non-flooded dispatch tables).
   */
  followRegisterEdges?: boolean;
}

export function walkNarrativeGraph(
  ctx: RuleContext,
  seeds: WalkSeed[],
  opts: WalkOptions = {},
): { reachedComponents: Set<string>; reachedMethods: Set<string> } {
  const followDispatchTables = opts.followDispatchTables ?? true;
  const followRegisterEdges = opts.followRegisterEdges ?? true;
  const reachedComponents = new Set<string>();
  const reachedMethods = new Set<string>();
  const queue: { compId: string; methodName: string }[] = [];

  const enqueueMethod = (compId: string, methodName: string): void => {
    const key = methodKey(compId, methodName);
    if (!reachedMethods.has(key)) {
      reachedMethods.add(key);
      queue.push({ compId, methodName });
    }
  };

  const reachComponent = (compId: string): void => {
    if (reachedComponents.has(compId)) return;
    reachedComponents.add(compId);
    if (!followDispatchTables) return;
    // A Portal's dispatch table IS its served surface: reaching the portal
    // reaches every capability binding.
    const comp = ctx.componentMap.get(compId);
    for (const b of comp?.dispatch ?? []) {
      if (ctx.componentMap.has(b.component)) {
        reachComponent(b.component);
        enqueueMethod(b.component, b.method);
      }
    }
  };

  const enqueueAllMethods = (compId: string): void => {
    for (const intf of ctx.interfacesByComponent.get(compId) ?? []) {
      for (const m of intf.methods) {
        enqueueMethod(compId, m.name);
      }
    }
  };

  for (const seed of seeds) {
    reachComponent(seed.compId);
    if (seed.methodName) {
      enqueueMethod(seed.compId, seed.methodName);
    } else {
      enqueueAllMethods(seed.compId);
    }
  }

  while (queue.length > 0) {
    const { compId, methodName } = queue.shift()!;

    // The method may be implemented against any of the component's interfaces.
    let methodImpl: (typeof ctx.implementations)[number]['methods'][number] | undefined;
    let impl: (typeof ctx.implementations)[number] | undefined;
    for (const intf of ctx.interfacesByComponent.get(compId) ?? []) {
      for (const candidate of ctx.implementationsByContract.get(intf.id) ?? []) {
        const m = candidate.methods.find(mm => mm.name === methodName);
        if (m) { impl = candidate; methodImpl = m; break; }
      }
      if (impl) break;
    }
    if (!impl || !methodImpl) continue;

    for (const step of methodImpl.narrative) {
      if (step.type === 'call' && step.targetComponent && step.targetMethod) {
        reachComponent(step.targetComponent);
        enqueueMethod(step.targetComponent, step.targetMethod);
      }
      // A register step is a handoff, not an invocation — but the callback IS
      // reached wherever its registering narrative is (the runtime will call it).
      if (followRegisterEdges && step.type === 'register' && step.targetComponent && step.targetMethod) {
        reachComponent(step.targetComponent);
        enqueueMethod(step.targetComponent, step.targetMethod);
      }
      if (step.type === 'dispatch' && step.targetComponent) {
        reachComponent(step.targetComponent);
        const portal = ctx.componentMap.get(step.targetComponent);
        const binding = portal?.dispatch?.find(b => b.capability === step.capability);
        if (binding && ctx.componentMap.has(binding.component)) {
          reachComponent(binding.component);
          enqueueMethod(binding.component, binding.method);
        }
      }
    }

    // Detail-dial fallback: an intent/calls-only method with no narrative
    // contributes no call edges, so walk its component's L2 dependsOn/owns
    // at component granularity (all contract methods) instead — the lower
    // declared fidelity must not false-positive its collaborators as
    // unused. Full-detail methods get NO fallback: their missing narrative
    // is a reported gap (MISSING_NARRATIVE) and unused-detection stays strong.
    if (methodImpl.narrative.length === 0) {
      const comp = ctx.componentMap.get(compId);
      if (comp && effectiveNarrativeDetail(methodImpl, impl, comp).level !== 'full') {
        for (const depId of [...comp.dependsOn, ...comp.owns]) {
          if (!ctx.componentMap.has(depId)) continue;
          reachComponent(depId);
          enqueueAllMethods(depId);
        }
      }
    }
  }

  return { reachedComponents, reachedMethods };
}

/**
 * Reachability analysis from entrypoints (Portals, Observers, published
 * components, declared lifecycle flows): unwired components/methods and
 * unreferenced types are flagged.
 */
export const reachabilityRule: SddRule = {
  name: 'unused-detection',
  description:
    'Walks the narrative execution graph (call steps, register handoffs, dispatch-table routing, lifecycle flows) from every entrypoint (Portal/Observer/published component/lifecycle entrypoint/invokedBy-declared method) and flags components and methods no execution chain reaches, plus types no field or signature references. An interface method declaring invokedBy (a real caller outside the modeled graph) seeds the walk, so its narrative propagates reachability; the declaration itself is audited (thin caller prose, or a method the internal walk already reaches).',
  codes: [
    { code: 'UNUSED_COMPONENT', defaultSeverity: 'warning', summary: 'Component never reached by any narrative call chain' },
    { code: 'UNUSED_METHOD', defaultSeverity: 'warning', summary: 'Method never called by any narrative step' },
    { code: 'UNUSED_TYPE', defaultSeverity: 'warning', summary: 'Type never referenced by fields or signatures' },
    { code: 'INVOKED_BY_UNDESCRIBED', defaultSeverity: 'warning', summary: 'invokedBy declaration whose caller prose is missing or placeholder-thin' },
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
    const baseWalk = walkNarrativeGraph(ctx, seeds);

    // Audit invokedBy declarations and collect their entrypoint seeds.
    const invokedBySeeds: WalkSeed[] = [];
    for (const intf of ctx.interfaces) {
      // A declaration on an unresolvable component can't be judged (the
      // dangling reference is the hierarchy family's finding).
      if (!ctx.componentMap.has(intf.component)) continue;
      const comp = ctx.componentMap.get(intf.component)!;
      for (const m of intf.methods) {
        if (!m.invokedBy) continue;
        invokedBySeeds.push({ compId: intf.component, methodName: m.name });
        if (!ctx.isSpecInScope(intf.id)) continue;
        const isDraftCtx = comp.status === 'draft' || comp.status === 'design' || intf.status === 'draft' || intf.status === 'design';
        if (!passesIntentFloor(m.invokedBy.caller, m.name)) {
          ctx.addIssue(
            'warning',
            'INVOKED_BY_UNDESCRIBED',
            `Method "${m.name}" on component "${intf.component}" declares invokedBy (${m.invokedBy.kind}) but its "caller" prose is missing or placeholder-thin — state WHO invokes it and when, so the entrypoint claim stays reviewable.`,
            intf.id,
            isDraftCtx,
          );
        }
        if (baseWalk.reachedMethods.has(methodKey(intf.component, m.name))) {
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
    const { reachedComponents, reachedMethods } = invokedBySeeds.length
      ? walkNarrativeGraph(ctx, [...seeds, ...invokedBySeeds])
      : baseWalk;

    // Generate warnings for unused components
    for (const comp of ctx.components) {
      if (!ctx.isSpecInScope(comp.id)) continue;
      if (!reachedComponents.has(comp.id)) {
        const isDraftCtx = comp.status === 'draft' || comp.status === 'design';
        ctx.addIssue(
          'warning',
          'UNUSED_COMPONENT',
          `Component "${comp.id}" is defined but never reached by any execution call chain starting from portals or entry points.`,
          comp.id,
          isDraftCtx,
        );
      } else {
        // Warn about unused methods on this reached component (across ALL its interfaces)
        for (const intf of ctx.interfacesByComponent.get(comp.id) ?? []) {
          for (const m of intf.methods) {
            if (!reachedMethods.has(methodKey(comp.id, m.name))) {
              const isDraftCtx = comp.status === 'draft' || comp.status === 'design' || intf.status === 'draft' || intf.status === 'design';
              ctx.addIssue(
                'warning',
                'UNUSED_METHOD',
                `Method "${m.name}" on component "${comp.id}" is defined but never called by any narrative step.`,
                comp.id,
                isDraftCtx,
              );
            }
          }
        }
      }
    }

    // Generate warnings for unused types
    const referencedTypes = new Set<string>();
    const markTypeReferenced = (ref: string) => {
      const refLower = ref.toLowerCase();
      if (BUILTIN_TYPES.has(refLower)) return;
      for (const spec of ctx.types) {
        const typeQualifiedId = spec.subsystem && !spec.id.startsWith(`${spec.subsystem}::`)
          ? `${spec.subsystem}::${spec.id}`
          : spec.id;
        if (matchTypeRef(ref, typeQualifiedId)) {
          referencedTypes.add(spec.id);
        }
      }
    };

    // 1. Scan type fields
    for (const t of ctx.types) {
      for (const field of t.fields) {
        const refs = extractTypeIdentifiers(field.type);
        for (const ref of refs) {
          const typeGenerics = new Set(
            Array.from(extractTypeGenerics(t.name)).map(g => g.toLowerCase()),
          );
          if (typeGenerics.has(ref.toLowerCase())) {
            continue;
          }
          markTypeReferenced(ref);
        }
      }
    }

    // 2. Scan interface method signatures & returns (structured params preferred)
    for (const intf of ctx.interfaces) {
      for (const m of intf.methods) {
        const refs = methodTypeRefs(m);
        for (const ref of refs) {
          markTypeReferenced(ref);
        }
      }
    }

    for (const t of ctx.types) {
      if (!ctx.isSpecInScope(t.id)) continue;
      if (!referencedTypes.has(t.id)) {
        const sub = ctx.subsystems.find(s => s.id === t.subsystem);
        const isDraftCtx = sub ? (sub.status === 'draft' || sub.status === 'design') : false;
        ctx.addIssue(
          'warning',
          'UNUSED_TYPE',
          `Type "${t.id}" is defined but never referenced by any type fields or interface methods.`,
          t.id,
          isDraftCtx,
        );
      }
    }
  },
};
