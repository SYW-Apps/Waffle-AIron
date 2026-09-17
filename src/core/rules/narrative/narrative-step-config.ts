import { stepConfigVerdict } from '../../../models/index.js';
import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// The configuration each narrative step carries. Narratives are flat ordered
// step lists; flow steps (branch/switch/loop/try/parallel/jump) jump by step
// number, and the schema keeps every flow field optional — so THIS rule
// enforces that each step type carries the config it needs, that no two steps
// share a number or a label, and that every jump field names a step the
// narrative actually has.
//
// The judgement itself is method_implementation.stepConfigVerdict, a pure
// derivation over the narrative: this rule reports what it returns, code for
// code. The same verdict's `sound` flag is the gate narrative-reachability and
// narrative-jump-edges run behind — a narrative whose jumps land nowhere has
// no graph worth walking.
// ---------------------------------------------------------------------------

export const narrativeStepConfigRule: SddRule = {
  name: 'narrative-step-config',
  description:
    'The step configuration of L5 narratives: every flow step (branch, switch, loop, try, parallel, jump) carries the config its type requires and no simple step carries flow config, "detach" (fire-and-forget) is legal on call/dispatch steps only, a parallel body is covered by contiguous, ordered arms (>= 2), no two steps share a step number or a label, and every jump field targets an existing step number in the same narrative.',
  codes: [
    { code: 'MALFORMED_FLOW_STEP', defaultSeverity: 'error', summary: 'Flow step missing required config (or flow config on a local/call step)' },
    { code: 'INVALID_STEP_JUMP', defaultSeverity: 'error', summary: 'Jump field targets a step number that does not exist in the narrative' },
    { code: 'DUPLICATE_STEP_LABEL', defaultSeverity: 'error', summary: 'Two steps in one narrative share a label — the symbolic anchor later deltas address by' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const isDraftCtx = ctx.isImplementationDraft(impl);

      for (const implMethod of impl.methods) {
        if (!implMethod.narrative.length) continue;
        const where = `Method "${implMethod.name}" in implementation "${impl.id}": `;

        for (const problem of stepConfigVerdict(implMethod).problems) {
          ctx.addIssue('error', problem.code, where + problem.detail, impl.id, isDraftCtx);
        }
      }
    }
  },
};
