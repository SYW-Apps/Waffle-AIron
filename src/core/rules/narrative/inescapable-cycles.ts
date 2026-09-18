import { SddRule } from '../types.js';
import { completedStepGraph, stronglyConnected } from './completed-step-graph.js';

// ---------------------------------------------------------------------------
// A step cycle nothing can leave: a strongly connected component of the step
// graph with no edge out of it and no return or throw inside it. Once entered,
// that flow never terminates — by construction, not by guessing at a
// condition. A `while` loop's termination stays the implementer's problem
// (halting problem); only structural inescapability is claimed. A warning,
// lint.allow-suppressible (new-check policy).
// ---------------------------------------------------------------------------

export const inescapableCyclesRule: SddRule = {
  name: 'inescapable-cycles',
  description:
    'A cycle in a narrative\'s step graph with no exit edge and no return or throw member never terminates, by construction: every path that enters it stays inside it forever. Read over the step graph closed by a completion step, so falling off the end of the narrative counts as leaving. Structure-only — prose conditions are never judged — and reported as a warning, lint.allow-suppressible.',
  codes: [
    { code: 'INESCAPABLE_CYCLE', defaultSeverity: 'warning', summary: 'Step cycle with no exit edge and no return/throw member — never terminates by construction' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const isDraftCtx = ctx.isImplementationDraft(impl);

      for (const implMethod of impl.methods) {
        const steps = implMethod.narrative;
        if (!steps.length) continue;
        const where = `Method "${implMethod.name}" in implementation "${impl.id}": `;
        const graph = completedStepGraph(steps);

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
      }
    }
  },
};
