import type { MethodImplementation, NarrativeStep } from './specs.js';

/**
 * The step graph of one narrative (step_graph): the SINGLE source of truth for
 * successor semantics (fall-through + jumps; loop and try headers carry both
 * their body edge and their after-region exit edge; return/throw terminate).
 * The narrative-flow reachability check and the antipattern analysis both read
 * it, so the two never disagree about what "next" means.
 */
export interface StepGraph {
  /** The narrative's step numbers in ascending order. */
  stepNumbers: number[];
  /** The step with this number, if there is one. */
  stepAt(stepNumber: number): NarrativeStep | undefined;
  /** The next step number in ascending order, ignoring jumps and parallel joins. */
  nextOf(stepNumber: number): number | undefined;
  /** The distinct existing step numbers flow can continue at from this step. */
  successorsOf(stepNumber: number): number[];
}

/**
 * method_implementation.stepGraph — the step graph of the method's narrative.
 * Simple steps fall through; a branch continues at its true and false steps, a
 * switch at its cases and default; a loop at its body and the step after its
 * region; a try at its body, catch steps, finally step and the step after its
 * region; a parallel fans out to its arms, whose last steps continue at the
 * join; a jump at its target; return and throw end the path.
 */
export function stepGraph(method: Pick<MethodImplementation, 'narrative'>): StepGraph {
  const steps = method.narrative;
  const byNum = new Map<number, NarrativeStep>();
  for (const s of steps) byNum.set(s.stepNumber, s);
  const nums = [...byNum.keys()].sort((a, b) => a - b);
  const indexOf = new Map(nums.map((n, i) => [n, i]));
  const nextOf = (n: number): number | undefined => {
    const i = indexOf.get(n);
    return i !== undefined && i + 1 < nums.length ? nums[i + 1] : undefined;
  };
  const prevOf = (n: number): number | undefined => {
    const i = indexOf.get(n);
    return i !== undefined && i > 0 ? nums[i - 1] : undefined;
  };

  // Parallel arm boundaries: the last step of an arm continues at the JOIN
  // (after the parallel's endStep), never into its neighbor arm. Built
  // outermost-first (ascending header) so a nested parallel whose endStep is
  // an outer arm end resolves its join through the outer mapping.
  const armEndJoin = new Map<number, number | undefined>();
  const fallNext = (n: number): number | undefined =>
    (armEndJoin.has(n) ? armEndJoin.get(n) : nextOf(n));
  for (const n of nums) {
    const s = byNum.get(n)!;
    if (s.type !== 'parallel' || s.endStep === undefined || !s.branches?.length) continue;
    const entries = s.branches.map(b => b.step).sort((a, b) => a - b);
    const join = fallNext(s.endStep);
    for (let i = 0; i < entries.length; i++) {
      const armEnd = i + 1 < entries.length ? prevOf(entries[i + 1]) : s.endStep;
      if (armEnd !== undefined && armEnd >= entries[i]) armEndJoin.set(armEnd, join);
    }
  }

  const successorsOf = (n: number): number[] => {
    const s = byNum.get(n);
    if (!s) return [];
    const succ: (number | undefined)[] = [];
    switch (s.type) {
      case 'local':
      case 'call':
      case 'register':
      case 'dispatch':
        succ.push(fallNext(n));
        break;
      case 'branch':
        succ.push(s.onTrueStep ?? fallNext(n), s.onFalseStep);
        break;
      case 'switch':
        succ.push(...(s.cases ?? []).map(c => c.step), s.defaultStep ?? fallNext(n));
        break;
      case 'loop':
        succ.push(nextOf(n), s.endStep !== undefined ? fallNext(s.endStep) : undefined);
        break;
      case 'try':
        succ.push(
          nextOf(n),
          ...(s.catches ?? []).map(c => c.step),
          s.finallyStep,
          s.endStep !== undefined ? fallNext(s.endStep) : undefined,
        );
        break;
      case 'parallel':
        // Fan-out to every arm entry; the join continuation is the step after
        // the region (all arms complete before flow proceeds).
        succ.push(
          ...(s.branches ?? []).map(b => b.step),
          s.endStep !== undefined ? fallNext(s.endStep) : undefined,
        );
        break;
      case 'jump':
        succ.push(s.toStep);
        break;
      // return / throw terminate the path
    }
    return [...new Set(succ.filter((t): t is number => t !== undefined && byNum.has(t)))];
  };
  return { stepNumbers: nums, stepAt: (n: number) => byNum.get(n), nextOf, successorsOf };
}
