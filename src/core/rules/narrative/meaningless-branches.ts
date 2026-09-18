import { SddRule } from '../types.js';
import { completedStepGraph } from './completed-step-graph.js';

// ---------------------------------------------------------------------------
// A decision that decides nothing: a branch whose two arms, or a switch whose
// every case and default, land on the SAME step. Provable from structure
// alone — the condition is never read, so no claim is made about whether it
// is right, only that its answer changes nothing. A warning, lint.allow-
// suppressible (new-check policy).
// ---------------------------------------------------------------------------

export const meaninglessBranchesRule: SddRule = {
  name: 'meaningless-branches',
  description:
    'A branch or switch whose arms all target the same step decides nothing: the condition is evaluated and flow continues at one place whatever it answers. A decision\'s targets are its explicit ones plus, where it leaves its fall-through field unset, the steps the step graph continues it at — so the classic authoring slip of pointing both arms at the next step is caught. Structure-only — a warning, lint.allow-suppressible.',
  codes: [
    { code: 'MEANINGLESS_BRANCH', defaultSeverity: 'warning', summary: 'Branch/switch whose arms all target the same step — the decision changes nothing' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const isDraftCtx = ctx.isImplementationDraft(impl);

      for (const implMethod of impl.methods) {
        const steps = implMethod.narrative;
        if (!steps.length) continue;
        const where = `Method "${implMethod.name}" in implementation "${impl.id}": `;
        const graph = completedStepGraph(steps);

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
      }
    }
  },
};
