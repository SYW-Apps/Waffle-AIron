import { parseDeclaredCall, isRetired, type ComponentSpec, type NarrativeStep } from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';
import { directEdgeRefusals } from '../doctrine/direct-edge.js';
import { pureForwarderComponents } from './method-cohesion.js';

// ---------------------------------------------------------------------------
// A forwarding Orchestrator is allowed, and doctrine often requires one: a
// Portal never reaches an Adapter, so the Orchestrator between them is the
// seam where one side's shape is translated into the other's, and where later
// work goes without touching either side. That forwarder is REQUIRED.
//
// A forwarder whose every caller could legally call the target itself is a
// different thing: the hop adds nothing doctrine asks for. It may still be
// deliberate — a place kept for transformation that has not arrived yet — so
// this is a warning, and the reasoned lint.allow is how a design says so.
//
// "Could legally call it itself" is never decided here. It is the doctrine
// family's own verdict on the edge each caller would need (directEdgeRefusals),
// composed from the judgements the edge rules report with, so this rule and
// those rules cannot disagree about what is legal.
// ---------------------------------------------------------------------------

/** One modelled call into a forwarder: who calls, and which of its methods. */
interface Caller {
  component: ComponentSpec;
  method: string;
}

/** What one forwarding method hands its call to: the component, and the method when the hand-off names one. */
interface HandOff {
  target: string;
  method?: string;
}

/** The single call or dispatch step of a forwarding narrative, read as the component and method it reaches. */
function handOffOf(ctx: RuleContext, narrative: NarrativeStep[]): HandOff | undefined {
  const step = narrative.find(s => s.type === 'call' || s.type === 'dispatch');
  if (!step?.targetComponent) return undefined;
  if (step.type === 'call') return step.targetMethod ? { target: step.targetComponent, method: step.targetMethod } : undefined;
  // A dispatch hands the call to a Portal's routing table: the caller would
  // dispatch through the same Portal, so that Portal is the edge it needs.
  return ctx.componentMap.has(step.targetComponent) ? { target: step.targetComponent } : undefined;
}

export const removableForwarderRule: SddRule = {
  name: 'removable-forwarder',
  judges: 'design',
  description:
    'An Orchestrator whose every narrated method is a single hand-off (one call or dispatch step, and a return) is a forwarder. Doctrine often requires one — a Portal never depends on an Adapter, so the Orchestrator between them is where the two shapes are translated — and such a forwarder is never reported. When every modelled caller could legally call the forwarded target directly, though, the hop adds nothing doctrine asks for: reported as a warning, to remove the hop or keep it deliberately with a reasoned lint.allow. Legal means the doctrine family\'s own verdict on the edge the caller would need — the entry-point, data-layer, dependency-class, subsystem-boundary and member-visibility judgements, the Portal write shortcut and the Supervisor shared-data bound on the forwarded method (each with its own reading of an untagged method), a pack profile\'s allowedEdges, and pack forbid-edge assertions — so one caller that could not make that edge makes the forwarder required. Silent on a forwarder no modelled caller reaches (the unused rules own that), on one a register step, an invokedBy or a subsystem lifecycle entry reaches (callers outside the narratives cannot be judged), and on one a caller reaches through a method that carries no narrative.',
  codes: [
    { code: 'REMOVABLE_FORWARDER', defaultSeverity: 'warning', summary: 'Orchestrator only forwards, and every caller could legally call the target directly — remove the hop, or keep it deliberately with a lint.allow reason' },
  ],
  check(ctx) {
    // 1. The forwarders: Orchestrators whose realized methods are all single
    //    hand-offs, read across every implementation that realizes them.
    const forwarders = [...pureForwarderComponents(ctx)]
      .map(id => ctx.componentMap.get(id))
      .filter((c): c is ComponentSpec => !!c && c.componentType === 'Orchestrator' && !isRetired(c) && !ctx.isInChainedSubproject(c.subsystem));
    if (forwarders.length === 0) return;
    const forwarderIds = new Set(forwarders.map(f => f.id));

    // 2. Who reaches each forwarder. A call step, a declared `calls` entry and
    //    a Portal's dispatch binding are modelled callers; a register step, an
    //    invokedBy and a subsystem lifecycle entry are reached from outside
    //    the narratives, where no caller can be judged.
    const callers = new Map<string, Caller[]>();
    const reachedFromOutside = new Set<string>();
    const addCaller = (forwarder: string, component: ComponentSpec, method: string): void => {
      if (component.id === forwarder) return;
      callers.set(forwarder, [...(callers.get(forwarder) ?? []), { component, method }]);
    };
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      const component = contract ? ctx.componentMap.get(contract.component) : undefined;
      if (!component) continue;
      for (const method of impl.methods) {
        for (const step of method.narrative ?? []) {
          if (!step.targetComponent || !forwarderIds.has(step.targetComponent)) continue;
          if (step.type === 'register') reachedFromOutside.add(step.targetComponent);
          else if (step.type === 'call' && step.targetMethod) addCaller(step.targetComponent, component, step.targetMethod);
        }
        for (const entry of method.calls ?? []) {
          const call = parseDeclaredCall(entry);
          if (call && forwarderIds.has(call.compId)) addCaller(call.compId, component, call.methodName);
        }
      }
    }
    for (const comp of ctx.components) {
      for (const binding of comp.dispatch ?? []) {
        if (forwarderIds.has(binding.component)) addCaller(binding.component, comp, binding.method);
      }
    }
    for (const sub of ctx.subsystems) {
      for (const entry of sub.lifecycle ?? []) reachedFromOutside.add(entry.component);
    }
    for (const forwarder of forwarders) {
      if (ctx.interfaceMethodsOf(forwarder.id).some(m => m.invokedBy)) reachedFromOutside.add(forwarder.id);
    }

    // 3. Judge each forwarder that only modelled callers reach.
    for (const forwarder of forwarders) {
      const reached = callers.get(forwarder.id) ?? [];
      if (reached.length === 0 || reachedFromOutside.has(forwarder.id)) continue;

      // What each of its methods hands the call to.
      const handOffs = new Map<string, HandOff>();
      for (const intf of ctx.interfacesByComponent.get(forwarder.id) ?? []) {
        for (const impl of ctx.implementationsByContract.get(intf.id) ?? []) {
          for (const method of impl.methods) {
            const handOff = handOffOf(ctx, method.narrative ?? []);
            if (handOff) handOffs.set(method.name, handOff);
          }
        }
      }

      // Every caller must be able to make the call itself: one that cannot,
      // or one that reaches a method whose hand-off is not narrated, makes
      // the forwarder required (or unjudgeable), and nothing is reported.
      // Kept per caller: the targets it could call itself, and its first
      // route as the example the finding shows.
      const routes = new Map<string, { targets: Set<string>; example: string }>();
      const removable = reached.every(({ component, method }) => {
        const handOff = handOffs.get(method);
        const target = handOff ? ctx.componentMap.get(handOff.target) : undefined;
        if (!handOff || !target) return false;
        if (directEdgeRefusals(ctx, component, target, handOff.method).length > 0) return false;
        const route = routes.get(component.id)
          ?? { targets: new Set<string>(), example: `${forwarder.id}.${method} passes the call to ${handOff.method ? `${target.id}.${handOff.method}` : `"${target.id}"`}` };
        route.targets.add(`"${target.id}"`);
        routes.set(component.id, route);
        return true;
      });
      if (!removable) continue;

      const described = [...routes]
        .map(([caller, { targets, example }]) => `"${caller}" may call ${[...targets].join(', ')} directly (for example, ${example})`)
        .join('; ');

      ctx.addIssue(
        'warning',
        'REMOVABLE_FORWARDER',
        `Orchestrator "${forwarder.id}" only passes calls on, and every caller could make the call itself: ${described}. Nothing in the architecture needs this hop. Remove "${forwarder.id}" and let its callers call the target directly, or, if you are keeping it on purpose as the place where future transformation will go, say so with a lint.allow for REMOVABLE_FORWARDER and a reason.`,
        forwarder.id,
        ctx.isComponentDraft(forwarder.id),
      );
    }
  },
};
