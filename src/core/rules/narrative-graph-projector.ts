import { parseDeclaredCall } from '../../models/index.js';
import type { NarrativeStep } from '../../models/index.js';
import type { RuleContext } from './types.js';

// ---------------------------------------------------------------------------
// The narrative graph projector: derives what the L5 narrative graph reaches
// from a set of seeds, for the wiring rules that need reachability —
// unused-detection (roots: Portals/Observers/published components/lifecycle
// entrypoints/invokedBy declarations) and the durability round-trip rule
// (roots: lifecycle init flows only). Pure: it reads the rule context and
// returns the reach, persisting and mutating nothing.
// ---------------------------------------------------------------------------

/** A starting point for the walk (walk_seed): one method, or (methodName omitted) every contract method of the component. */
export interface WalkSeed {
  compId: string;
  methodName?: string;
}

/**
 * Which optional edges the walk follows (walk_options). Call steps and
 * dispatch steps are always followed.
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

/** What a narrative graph walk reached from its seeds (narrative_reach). */
export interface NarrativeReach {
  /** Ids of the components reached. */
  reachedComponents: Set<string>;
  /** The methods reached, keyed `component#method` (component ids may themselves contain `::`). */
  reachedMethods: Set<string>;
  /** Whether the walk reached this component. */
  reachesComponent(compId: string): boolean;
  /** Whether the walk reached this method of this component. */
  reachesMethod(compId: string, methodName: string): boolean;
}

/** One reachability edge a narrative step contributes (narrative_edge): the component
 *  to reach and, when the step names one, the method to enqueue on it. */
export interface NarrativeEdge {
  compId: string;
  methodName?: string;
}

// Key with '#': component ids may themselves contain '::' (namespaced subprojects),
// so '::' cannot separate component from method.
const methodKey = (compId: string, methodName: string): string => `${compId}#${methodName}`;

/**
 * Which reachability edges ONE narrative step contributes. `call` steps and
 * `register` handoffs name their target directly; a `dispatch` step reaches the
 * routed Portal and then, through that Portal's dispatch table, the component
 * bound to the step's capability. Every other step type carries no edge.
 *
 * A register step is a handoff, not an invocation — but the callback IS reached
 * wherever its registering narrative is (the runtime will call it), so the edge
 * is taken only when the walk asked for it.
 *
 * Pure: it reads the step, the tree's components and the one option, and
 * returns edges. Applying them — reaching and enqueueing — is the walk's job.
 */
export function stepEdges(
  step: NarrativeStep,
  ctx: RuleContext,
  followRegisterEdges: boolean,
): NarrativeEdge[] {
  if (step.type === 'call' && step.targetComponent && step.targetMethod) {
    return [{ compId: step.targetComponent, methodName: step.targetMethod }];
  }
  if (followRegisterEdges && step.type === 'register' && step.targetComponent && step.targetMethod) {
    return [{ compId: step.targetComponent, methodName: step.targetMethod }];
  }
  if (step.type === 'dispatch' && step.targetComponent) {
    const edges: NarrativeEdge[] = [{ compId: step.targetComponent }];
    const portal = ctx.componentMap.get(step.targetComponent);
    const binding = portal?.dispatch?.find(b => b.capability === step.capability);
    if (binding && ctx.componentMap.has(binding.component)) {
      edges.push({ compId: binding.component, methodName: binding.method });
    }
    return edges;
  }
  return [];
}

/**
 * Breadth-first walk over the L5 execution edges from the seeds. Edges are
 * `call` steps, `dispatch` steps (routed through the target Portal's dispatch
 * table to the bound capability server), `register` handoffs, and every
 * dispatch binding of a reached Portal (its declared served surface — the
 * runtime dispatches into those bindings even though no static call names
 * them); the options switch the last two off. A reached method with no
 * implementation contributes nothing; one whose narrative does not show its
 * calls contributes the ones it DECLARES (`calls`), and nothing else.
 */
export function walk(ctx: RuleContext, seeds: WalkSeed[], options: WalkOptions = {}): NarrativeReach {
  const followDispatchTables = options.followDispatchTables ?? true;
  const followRegisterEdges = options.followRegisterEdges ?? true;
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
      for (const edge of stepEdges(step, ctx, followRegisterEdges)) {
        reachComponent(edge.compId);
        if (edge.methodName) enqueueMethod(edge.compId, edge.methodName);
      }
    }

    // Declared calls: a method whose narrative does not show its calls says
    // which ones it makes, and the walk takes exactly those edges. They stand
    // in for the steps, so they count wherever a call step would — including
    // the boot-graph walk, where an explicit call is an invocation whatever
    // its detail dial. There is no fallback behind them: a collaborator the
    // method does not name is NOT reached, so a lower detail dial no longer
    // vouches for everything its component declares.
    for (const ref of methodImpl.calls ?? []) {
      const parsed = parseDeclaredCall(ref);
      if (!parsed || !ctx.componentMap.has(parsed.compId)) continue;
      reachComponent(parsed.compId);
      enqueueMethod(parsed.compId, parsed.methodName);
    }
  }

  return {
    reachedComponents,
    reachedMethods,
    reachesComponent: (compId: string): boolean => reachedComponents.has(compId),
    reachesMethod: (compId: string, methodName: string): boolean => reachedMethods.has(methodKey(compId, methodName)),
  };
}
