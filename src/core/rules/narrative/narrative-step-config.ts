import { stepConfigVerdict } from '../../../models/index.js';
import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// The configuration each narrative step carries. Narratives are flat ordered
// step lists; flow steps (branch/switch/loop/try/parallel/jump) jump by step
// number, and the schema keeps every flow field optional — so THIS rule
// enforces that each step type carries the config it needs, that no step
// carries a field its type cannot, that no two steps share a number or a
// label, and that every jump field names a step the narrative actually has.
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
    'The step configuration of L5 narratives: every flow step (branch, switch, loop, try, parallel, jump) carries the config its type requires and no simple step carries flow config, "detach" (fire-and-forget) is legal on call/dispatch steps only, no step carries a field foreign to its type, a parallel body is covered by contiguous, ordered arms (>= 2), no two steps share a step number or a label, and every jump field targets an existing step number in the same narrative.',
  codes: [
    { code: 'MALFORMED_FLOW_STEP', defaultSeverity: 'error', summary: 'Flow step missing required config (or flow config on a local/call step)' },
    { code: 'INVALID_STEP_JUMP', defaultSeverity: 'error', summary: 'Jump field targets a step number that does not exist in the narrative' },
    { code: 'DUPLICATE_STEP_LABEL', defaultSeverity: 'error', summary: 'Two steps in one narrative share a label — the symbolic anchor later deltas address by' },
    { code: 'FOREIGN_STEP_FIELD', defaultSeverity: 'warning', summary: 'Step carries a field its own type cannot have — a leftover of an edit, meaning nothing' },
  ],
  check(ctx) {
    // The verdict names a code per problem; the severity each code carries is
    // this rule's own declaration, read back from `codes` rather than assumed
    // — unreadable flow is an error, dead configuration a warning.
    const severityOf = new Map(narrativeStepConfigRule.codes.map(c => [c.code, c.defaultSeverity]));

    for (const impl of ctx.implementations) {
      const isDraftCtx = ctx.isImplementationDraft(impl);

      for (const implMethod of impl.methods) {
        if (!implMethod.narrative.length) continue;
        const where = `Method "${implMethod.name}" in implementation "${impl.id}": `;

        for (const problem of stepConfigVerdict(implMethod).problems) {
          ctx.addIssue(severityOf.get(problem.code) ?? 'error', problem.code, where + problem.detail, impl.id, isDraftCtx);
        }
      }
    }
  },
};
