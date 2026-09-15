import { ImplementationSpec, NarrativeStep, StepGraph, stepGraph } from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Narrative antipatterns — spec-level bug detection over the L5 step graphs
// and the method-level call graph they wire up. Deliberately restricted to
// what is PROVABLE from structure alone:
//   INESCAPABLE_CYCLE       — a step cycle with no exit edge and no return/
//                             throw member never terminates, by construction.
//   MEANINGLESS_BRANCH      — a branch/switch whose arms all land on the same
//                             step decides nothing (a classic authoring slip).
//   UNCONDITIONAL_CALL_CYCLE— a cross-component call cycle in which every
//                             call edge is unavoidable on all entry-to-exit
//                             paths of its narrative: unbounded recursion.
// Prose conditions are never judged — a `while` loop's termination is the
// implementer's problem (halting problem); only structural inescapability is
// claimed. All findings are warnings + lint.allow (new-check policy).
// ---------------------------------------------------------------------------

/**
 * The step graph of a narrative closed by a COMPLETION step: a return numbered
 * one past every step number and every jump field value (so no jump, however
 * malformed, lands on it), appended so that each place flow falls off the end
 * of the narrative — a simple step, the last step of a parallel arm whose join
 * lies past the end, a branch's true arm, a switch's default, a loop or try
 * exit — continues at it under stepGraph's own successor semantics. Every
 * analysis below reads this one graph, so none re-derives what "next" means.
 */
function completedStepGraph(steps: NarrativeStep[]): StepGraph {
  const numbers = steps.flatMap(s => [
    s.stepNumber, s.onTrueStep, s.onFalseStep, s.defaultStep, s.endStep, s.finallyStep, s.toStep,
    ...(s.cases ?? []).map(c => c.step),
    ...(s.catches ?? []).map(c => c.step),
    ...(s.branches ?? []).map(b => b.step),
  ]).filter((n): n is number => n !== undefined);
  const completion: NarrativeStep = {
    stepNumber: Math.max(0, ...numbers) + 1,
    description: 'The method completes by falling off the end of its narrative',
    type: 'return',
  };
  return stepGraph({ narrative: [...steps, completion] });
}

/**
 * True when step `target` lies on EVERY path from the entry to completion —
 * execution cannot complete without passing it. Over the completed step graph
 * with `target` removed, the steps that can still complete are the least set
 * in which a return or throw completes (the completion step is one), a
 * parallel header completes only when EVERY arm entry does — all arms always
 * run — and any other step completes when SOME successor does. The target is
 * unavoidable when the entry is not in that set.
 */
export function isUnavoidable(steps: NarrativeStep[], target: number): boolean {
  if (steps.length === 0) return false;
  const graph = completedStepGraph(steps);
  const completes = new Set<number>();
  const canComplete = (n: number): boolean => {
    const s = graph.stepAt(n)!;
    if (s.type === 'return' || s.type === 'throw') return true;
    const arms = s.type === 'parallel'
      ? (s.branches ?? []).map(b => b.step).filter(e => graph.stepAt(e) !== undefined)
      : [];
    if (arms.length) return arms.every(e => completes.has(e));
    return graph.successorsOf(n).some(t => completes.has(t));
  };
  // Iterated to a fixed point, last step first: flow mostly runs forward, so
  // a pass or two settles it.
  const order = [...graph.stepNumbers].reverse();
  for (let grew = true; grew;) {
    grew = false;
    for (const n of order) {
      if (n === target || completes.has(n) || !canComplete(n)) continue;
      completes.add(n);
      grew = true;
    }
  }
  return !completes.has(graph.stepNumbers[0]);
}

/** Strongly connected components (Tarjan, iterative) over the step graph. */
function stronglyConnected(nums: number[], successorsOf: (n: number) => number[]): number[][] {
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const sccs: number[][] = [];
  let counter = 0;

  for (const root of nums) {
    if (index.has(root)) continue;
    const work: { n: number; succ: number[]; i: number }[] = [{ n: root, succ: successorsOf(root), i: 0 }];
    index.set(root, counter); low.set(root, counter); counter++;
    stack.push(root); onStack.add(root);

    while (work.length) {
      const frame = work[work.length - 1];
      if (frame.i < frame.succ.length) {
        const t = frame.succ[frame.i++];
        if (!index.has(t)) {
          index.set(t, counter); low.set(t, counter); counter++;
          stack.push(t); onStack.add(t);
          work.push({ n: t, succ: successorsOf(t), i: 0 });
        } else if (onStack.has(t)) {
          low.set(frame.n, Math.min(low.get(frame.n)!, index.get(t)!));
        }
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1];
          low.set(parent.n, Math.min(low.get(parent.n)!, low.get(frame.n)!));
        }
        if (low.get(frame.n) === index.get(frame.n)) {
          const scc: number[] = [];
          let m: number;
          do { m = stack.pop()!; onStack.delete(m); scc.push(m); } while (m !== frame.n);
          sccs.push(scc);
        }
      }
    }
  }
  return sccs;
}

/** Orders strings by UTF-16 code unit, independent of the runtime locale. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface CallEdge {
  fromKey: string;
  toKey: string;
  unconditional: boolean;
  impl: ImplementationSpec;
  methodName: string;
  stepNumber: number;
  toLabel: string;
}

export const narrativeAntipatternsRule: SddRule = {
  name: 'narrative-antipatterns',
  description:
    'Provable narrative bugs, caught at spec level before implementation: a step-graph cycle with no exit edge and no return/throw member never terminates by construction (INESCAPABLE_CYCLE); a branch or switch whose arms all target the same step decides nothing (MEANINGLESS_BRANCH); a method-level call cycle across components in which every call edge is unavoidable on every entry-to-exit path is unbounded recursion (UNCONDITIONAL_CALL_CYCLE — dispatch steps resolved through their portal tables; a cycle with even one guarded edge is NOT flagged, since prose conditions are never judged). Structure-only claims — warnings, lint.allow-suppressible.',
  codes: [
    { code: 'INESCAPABLE_CYCLE', defaultSeverity: 'warning', summary: 'Step cycle with no exit edge and no return/throw member — never terminates by construction' },
    { code: 'MEANINGLESS_BRANCH', defaultSeverity: 'warning', summary: 'Branch/switch whose arms all target the same step — the decision changes nothing' },
    { code: 'UNCONDITIONAL_CALL_CYCLE', defaultSeverity: 'warning', summary: 'Cross-component call cycle in which every call edge is unavoidable — unbounded recursion by construction' },
  ],
  check(ctx: RuleContext) {
    const callEdges: CallEdge[] = [];

    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      const component = contract ? ctx.componentMap.get(contract.component) : undefined;
      const isDraftCtx = ctx.isImplementationDraft(impl);

      for (const implMethod of impl.methods) {
        const steps = implMethod.narrative;
        if (!steps.length) continue;
        const where = `Method "${implMethod.name}" in implementation "${impl.id}": `;
        const graph = completedStepGraph(steps);

        // -- MEANINGLESS_BRANCH ---------------------------------------------
        // A decision's targets are its explicit ones plus, when it leaves its
        // fall-through field unset, every step the graph continues it at — so
        // the fall-through is the graph's: the last step of a parallel arm
        // falls through to the join, the narrative's end to completion.
        const decisionTargets = (stepNumber: number, explicit: number[], fallThroughField: number | undefined): number[] => {
          const targets = new Set(explicit);
          if (fallThroughField !== undefined) targets.add(fallThroughField);
          else for (const t of graph.successorsOf(stepNumber)) targets.add(t);
          return [...targets];
        };
        for (const s of steps) {
          if (s.type === 'branch' && s.onFalseStep !== undefined) {
            const targets = decisionTargets(s.stepNumber, [s.onFalseStep], s.onTrueStep);
            if (targets.length === 1) {
              ctx.addIssue(
                'warning',
                'MEANINGLESS_BRANCH',
                `${where}branch step ${s.stepNumber} sends both arms to step ${targets[0]} — the condition decides nothing. Point the arms at different steps, or replace the branch with a local step.`,
                impl.id,
                isDraftCtx,
              );
            }
          }
          if (s.type === 'switch' && s.cases?.length) {
            const targets = decisionTargets(s.stepNumber, s.cases.map(c => c.step), s.defaultStep);
            if (targets.length === 1) {
              ctx.addIssue(
                'warning',
                'MEANINGLESS_BRANCH',
                `${where}switch step ${s.stepNumber} sends every case (and the default) to step ${targets[0]} — the dispatch decides nothing.`,
                impl.id,
                isDraftCtx,
              );
            }
          }
        }

        // -- INESCAPABLE_CYCLE ----------------------------------------------
        for (const scc of stronglyConnected(graph.stepNumbers, graph.successorsOf)) {
          const inScc = new Set(scc);
          const isCycle = scc.length > 1
            || graph.successorsOf(scc[0]).includes(scc[0]);
          if (!isCycle) continue;
          const hasExit = scc.some(n => graph.successorsOf(n).some(t => !inScc.has(t)));
          const hasTerminator = scc.some(n => {
            const s = graph.stepAt(n)!;
            return s.type === 'return' || s.type === 'throw';
          });
          if (!hasExit && !hasTerminator) {
            const sorted = [...scc].sort((a, b) => a - b);
            ctx.addIssue(
              'warning',
              'INESCAPABLE_CYCLE',
              `${where}steps ${sorted.join(' → ')} form a cycle with no exit edge and no return/throw — once entered, this flow never terminates, by construction. Add an exit branch or a terminator inside the cycle.`,
              impl.id,
              isDraftCtx,
            );
          }
        }

        // -- collect method-level call edges for the cycle pass -------------
        // `register` steps are deliberately NOT collected: a handoff defers
        // the invocation to the runtime, so it cannot recurse by construction.
        if (!component) continue;
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

    // -- UNCONDITIONAL_CALL_CYCLE over the unconditional-edge subgraph -------
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
