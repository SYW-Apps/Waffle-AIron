import { ImplementationSpec } from '../../../models/index.js';
import { SddRule } from '../types.js';
import { isUnavoidable, stronglyConnected } from './completed-step-graph.js';

// ---------------------------------------------------------------------------
// Unbounded recursion, proved at spec level: a cycle in the method-level call
// graph across components in which EVERY edge is unavoidable on all
// entry-to-exit paths of its own narrative. One guarded edge anywhere in the
// cycle and nothing is claimed — a prose condition is never judged, so a
// guard is always taken to be a possible base case. A warning,
// lint.allow-suppressible (new-check policy).
// ---------------------------------------------------------------------------

/** Orders strings by UTF-16 code unit, independent of the runtime locale. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One method-to-method call the narrative makes, and whether the narrative can avoid making it. */
interface CallEdge {
  fromKey: string;
  toKey: string;
  unconditional: boolean;
  impl: ImplementationSpec;
  methodName: string;
  stepNumber: number;
  toLabel: string;
}

export const unconditionalCallCyclesRule: SddRule = {
  name: 'unconditional-call-cycles',
  description:
    'A method-level call cycle across components in which every call edge is unavoidable on every entry-to-exit path of its narrative is unbounded recursion, by construction. Dispatch steps are resolved through their portal\'s table; register steps are never edges (a handoff defers the invocation to the runtime, so it cannot recurse). A cycle with even one guarded edge is NOT flagged, since prose conditions are never judged. Structure-only — a warning, lint.allow-suppressible, anchored on the member edge that sorts first so one allow covers the cycle.',
  codes: [
    { code: 'UNCONDITIONAL_CALL_CYCLE', defaultSeverity: 'warning', summary: 'Cross-component call cycle in which every call edge is unavoidable — unbounded recursion by construction' },
  ],
  check(ctx) {
    // 1. Every call edge the narratives make, with the verdict that decides
    //    whether it can be part of a proof: is the step on every path from the
    //    narrative's entry to its completion?
    const callEdges: CallEdge[] = [];
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      const component = contract ? ctx.componentMap.get(contract.component) : undefined;
      if (!component) continue;

      for (const implMethod of impl.methods) {
        const steps = implMethod.narrative;
        if (!steps.length) continue;
        const fromKey = `${component.id}::${implMethod.name}`;
        for (const s of steps) {
          let toComponent: string | undefined;
          let toMethod: string | undefined;
          if (s.type === 'call' && s.targetComponent && s.targetMethod) {
            toComponent = s.targetComponent;
            toMethod = s.targetMethod;
          } else if (s.type === 'dispatch' && s.targetComponent && s.capability) {
            const portal = ctx.componentMap.get(s.targetComponent);
            const binding = portal?.dispatch?.find(b => b.capability === s.capability);
            if (binding) { toComponent = binding.component; toMethod = binding.method; }
          }
          if (!toComponent || !toMethod || !ctx.componentMap.has(toComponent)) continue;
          callEdges.push({
            fromKey,
            toKey: `${toComponent}::${toMethod}`,
            unconditional: isUnavoidable(steps, s.stepNumber),
            impl,
            methodName: implMethod.name,
            stepNumber: s.stepNumber,
            toLabel: `${toComponent}.${toMethod}`,
          });
        }
      }
    }

    // 2. The cycles of the UNCONDITIONAL-edge subgraph. A guarded edge is left
    //    out of the graph entirely, so a cycle that needs one to close is
    //    never found.
    const adjacency = new Map<string, CallEdge[]>();
    for (const e of callEdges) {
      if (!e.unconditional) continue;
      const list = adjacency.get(e.fromKey);
      if (list) list.push(e);
      else adjacency.set(e.fromKey, [e]);
    }
    const nodes = [...new Set([...adjacency.keys(), ...[...adjacency.values()].flat().map(e => e.toKey)])];
    const nodeIndex = new Map(nodes.map((k, i) => [k, i]));
    const succOf = (i: number): number[] =>
      (adjacency.get(nodes[i]) ?? []).map(e => nodeIndex.get(e.toKey)!).filter(t => t !== undefined);

    for (const scc of stronglyConnected([...nodes.keys()], succOf)) {
      const keys = scc.map(i => nodes[i]);
      const inScc = new Set(keys);
      const isCycle = keys.length > 1
        || (adjacency.get(keys[0]) ?? []).some(e => e.toKey === keys[0]);
      if (!isCycle) continue;
      const memberEdges = keys.flatMap(k => (adjacency.get(k) ?? []).filter(e => inScc.has(e.toKey)));
      if (memberEdges.length === 0) continue;
      // Anchor the finding on the member edge that sorts first — from key, then
      // implementation id, by code unit, then step number — so a single
      // lint.allow covers the cycle finding on every runtime, whatever its
      // locale. Every member has an edge inside the cycle, so the anchor is the
      // first node of the path below.
      const anchor = [...memberEdges].sort((a, b) =>
        byCodeUnit(a.fromKey, b.fromKey) || byCodeUnit(a.impl.id, b.impl.id) || a.stepNumber - b.stepNumber)[0];
      const path = [...keys].sort(byCodeUnit).join(' → ');
      ctx.addIssue(
        'warning',
        'UNCONDITIONAL_CALL_CYCLE',
        `Call cycle with no guard: ${path} — every call edge in this cycle is unavoidable on all paths of its narrative (e.g. step ${anchor.stepNumber} of "${anchor.methodName}" in "${anchor.impl.id}" always calls ${anchor.toLabel}). This recurses without a base case, by construction. Guard at least one edge with a branch/return before the call, or lint.allow with the termination argument.`,
        anchor.impl.id,
        memberEdges.some(e => ctx.isImplementationDraft(e.impl)),
      );
    }
  },
};
