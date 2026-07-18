import { ImplementationSpec, NarrativeStep } from '../../models/index.js';
import { RuleContext, SddRule } from './types.js';
import { stepGraph } from './narrative-flow.js';

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
 * Terminators: return/throw steps, plus every place execution can complete by
 * falling off the end of the narrative — mirroring each `?? nextOf` fallback
 * in stepGraph's successor semantics (a branch whose true arm falls off the
 * end completes there just as surely as a return).
 */
function isTerminal(step: NarrativeStep, nextOf: (n: number) => number | undefined): boolean {
  if (step.type === 'return' || step.type === 'throw') return true;
  const n = step.stepNumber;
  switch (step.type) {
    case 'local': case 'call': case 'dispatch':
      return nextOf(n) === undefined;
    case 'branch':
      return step.onTrueStep === undefined && nextOf(n) === undefined;
    case 'switch':
      return step.defaultStep === undefined && nextOf(n) === undefined;
    case 'loop': case 'try':
      return step.endStep !== undefined && nextOf(step.endStep) === undefined;
    default:
      return false;
  }
}

/**
 * True when step `target` lies on EVERY path from the entry to any terminator
 * — i.e. execution cannot complete without passing it. Computed as: with
 * `target` removed from the graph, no terminator is reachable from the entry.
 */
export function isUnavoidable(steps: NarrativeStep[], target: number): boolean {
  const { nums, byNum, nextOf, successorsOf } = stepGraph(steps);
  if (nums.length === 0) return false;
  if (nums[0] === target) return true;

  const visited = new Set<number>();
  const stack = [nums[0]];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === target || visited.has(n)) continue;
    visited.add(n);
    const s = byNum.get(n)!;
    if (isTerminal(s, nextOf)) return false; // a completion path avoids the target
    for (const t of successorsOf(n)) {
      if (t !== target && !visited.has(t)) stack.push(t);
    }
  }
  return true;
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
        const graph = stepGraph(steps);

        // -- MEANINGLESS_BRANCH ---------------------------------------------
        for (const s of steps) {
          if (s.type === 'branch' && s.onFalseStep !== undefined) {
            const onTrue = s.onTrueStep ?? graph.nextOf(s.stepNumber);
            if (onTrue !== undefined && onTrue === s.onFalseStep) {
              ctx.addIssue(
                'warning',
                'MEANINGLESS_BRANCH',
                `${where}branch step ${s.stepNumber} sends both arms to step ${onTrue} — the condition decides nothing. Point the arms at different steps, or replace the branch with a local step.`,
                impl.id,
                isDraftCtx,
              );
            }
          }
          if (s.type === 'switch' && s.cases?.length) {
            const targets = new Set<number>(s.cases.map(c => c.step));
            const def = s.defaultStep ?? graph.nextOf(s.stepNumber);
            if (def !== undefined) targets.add(def);
            if (targets.size === 1) {
              ctx.addIssue(
                'warning',
                'MEANINGLESS_BRANCH',
                `${where}switch step ${s.stepNumber} sends every case (and the default) to step ${[...targets][0]} — the dispatch decides nothing.`,
                impl.id,
                isDraftCtx,
              );
            }
          }
        }

        // -- INESCAPABLE_CYCLE ----------------------------------------------
        for (const scc of stronglyConnected(graph.nums, graph.successorsOf)) {
          const inScc = new Set(scc);
          const isCycle = scc.length > 1
            || graph.successorsOf(scc[0]).includes(scc[0]);
          if (!isCycle) continue;
          const hasExit = scc.some(n => graph.successorsOf(n).some(t => !inScc.has(t)));
          const hasTerminator = scc.some(n => {
            const s = graph.byNum.get(n)!;
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
      // Anchor the finding on the lexicographically first member's impl, so a
      // single lint.allow covers the cycle finding deterministically.
      const anchor = [...memberEdges].sort((a, b) => a.fromKey.localeCompare(b.fromKey))[0];
      const path = [...keys].sort().join(' → ');
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
