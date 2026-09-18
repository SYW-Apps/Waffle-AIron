import { NarrativeStep, StepGraph, stepGraph } from '../../../models/index.js';

// ---------------------------------------------------------------------------
// The structural readings the narrative-soundness rules share.
//
// Three rules judge what a narrative's shape PROVES — a branch that decides
// nothing, a step cycle that never terminates, a call cycle with no guard —
// and each reads the narrative through the same completed step graph. They are
// three separate analyses over three different graphs, so nothing here decides
// a finding; what is shared is only how "next", "a cycle" and "unavoidable"
// are read, so the three can never disagree about them.
// ---------------------------------------------------------------------------

/**
 * The step graph of a narrative closed by a COMPLETION step: a return numbered
 * one past every step number and every jump field value (so no jump, however
 * malformed, lands on it), appended so that each place flow falls off the end
 * of the narrative — a simple step, the last step of a parallel arm whose join
 * lies past the end, a branch's true arm, a switch's default, a loop or try
 * exit — continues at it under stepGraph's own successor semantics.
 */
export function completedStepGraph(steps: NarrativeStep[]): StepGraph {
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

/**
 * Strongly connected components (Tarjan, iterative) of ANY successor relation
 * over a node set. Deliberately graph-agnostic: the two cycle rules run it
 * over graphs that have nothing in common — one method's step graph, and the
 * call graph across every component — and sharing the traversal must never be
 * read as sharing the graph.
 */
export function stronglyConnected(nums: number[], successorsOf: (n: number) => number[]): number[][] {
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
