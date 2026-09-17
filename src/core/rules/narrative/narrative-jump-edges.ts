import { stepConfigVerdict } from '../../../models/index.js';
import type { NarrativeStep } from '../../../models/index.js';
import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Where a narrative's jumps land. A jump that lands inside a loop/try/parallel
// body from outside enters the region past its header; a jump backwards is an
// unstructured loop unless it is a continue to an enclosing loop header; and a
// try body that simply falls off its end runs its own handlers on the SUCCESS
// path. None of the three is a broken reference — they are edges that exist
// and go somewhere structured code cannot follow.
//
// Runs behind method_implementation.stepConfigVerdict().sound: an edge whose
// target the narrative does not have is narrative-step-config's finding, and
// judging it here would blame the region instead.
// ---------------------------------------------------------------------------

interface JumpEdge {
  from: number;
  to: number;
  field: string;
  kind: string;
}

export const narrativeJumpEdgesRule: SddRule = {
  name: 'narrative-jump-edges',
  description:
    'Where an L5 narrative\'s jump edges land: a loop/try/parallel region is entered through its header, never into the middle of its body; a backward jump is only idiomatic as a continue to an enclosing loop header, and otherwise models repetition that belongs in a loop step; and a try body must not fall through into its own catch/finally region on the success path. Judged only for a narrative whose step configuration is sound (narrative-step-config reports the rest).',
  codes: [
    { code: 'JUMP_INTO_REGION', defaultSeverity: 'warning', summary: 'Jump lands in the middle of a loop/try body from outside — regions are entered through their header' },
    { code: 'BACKWARD_JUMP', defaultSeverity: 'warning', summary: 'Backward jump that is not a continue to an enclosing loop header — model repetition with a loop step' },
    { code: 'FALLTHROUGH_INTO_HANDLER', defaultSeverity: 'warning', summary: 'try body falls through into its own catch/finally region on the success path' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const isDraftCtx = ctx.isImplementationDraft(impl);

      for (const implMethod of impl.methods) {
        const steps = implMethod.narrative;
        if (!steps.length) continue;
        if (!stepConfigVerdict(implMethod).sound) continue;
        const where = `Method "${implMethod.name}" in implementation "${impl.id}": `;

        const regions = regionsOf(steps);
        const jumpEdges = jumpEdgesOf(steps);
        const inBody = (n: number, r: { h: number; end: number }): boolean => n > r.h && n <= r.end;

        for (const e of jumpEdges) {
          for (const r of regions) {
            if (inBody(e.to, r) && e.from !== r.h && !inBody(e.from, r)) {
              ctx.addIssue(
                'warning',
                'JUMP_INTO_REGION',
                `${where}step ${e.from} "${e.field}" jumps into the middle of the ${r.kind} region ${r.h}..${r.end} (step ${e.to}) — regions are entered through their header.`,
                impl.id,
                isDraftCtx,
              );
            }
          }
        }

        // Backward jumps are only idiomatic as a continue to an enclosing
        // loop header; anything else is an unstructured loop in disguise.
        for (const e of jumpEdges) {
          if ((e.kind !== 'branch' && e.kind !== 'switch' && e.kind !== 'jump') || e.to >= e.from) continue;
          const continueToLoop = regions.some(r => r.kind === 'loop' && r.h === e.to && inBody(e.from, r));
          if (continueToLoop) continue;
          ctx.addIssue(
            'warning',
            'BACKWARD_JUMP',
            `${where}step ${e.from} "${e.field}" jumps backwards to step ${e.to} — model repetition with a loop step (backward jumps are only idiomatic as a continue to an enclosing loop header).`,
            impl.id,
            isDraftCtx,
          );
        }

        // A try body whose last step simply falls through runs its handlers on
        // the SUCCESS path — almost always a missing jump/return at the body end.
        const byNum = new Map<number, NarrativeStep>();
        for (const s of steps) byNum.set(s.stepNumber, s);
        const nums = [...byNum.keys()].sort((a, b) => a - b);
        const nextOf = (n: number): number | undefined => {
          const i = nums.indexOf(n);
          return i !== -1 && i + 1 < nums.length ? nums[i + 1] : undefined;
        };
        for (const s of steps) {
          if (s.type !== 'try' || s.endStep === undefined) continue;
          const handlerStarts = new Set<number>((s.catches ?? []).map(c => c.step));
          if (s.finallyStep !== undefined) handlerStarts.add(s.finallyStep);
          const last = byNum.get(s.endStep);
          const nxt = nextOf(s.endStep);
          if (last && (last.type === 'local' || last.type === 'call' || last.type === 'register' || last.type === 'dispatch') && nxt !== undefined && handlerStarts.has(nxt)) {
            ctx.addIssue(
              'warning',
              'FALLTHROUGH_INTO_HANDLER',
              `${where}the try body ending at step ${s.endStep} falls through into its handler region (step ${nxt}) — end the body with a jump, return, or throw so handlers only run on error.`,
              impl.id,
              isDraftCtx,
            );
          }
        }
      }
    }
  },
};

/** The narrative's regions: every loop, try and parallel step carrying an endStep, spanning its header to that end. */
function regionsOf(steps: NarrativeStep[]): { h: number; end: number; kind: string }[] {
  const regions: { h: number; end: number; kind: string }[] = [];
  for (const s of steps) {
    if ((s.type === 'loop' || s.type === 'try' || s.type === 'parallel') && s.endStep !== undefined) {
      regions.push({ h: s.stepNumber, end: s.endStep, kind: s.type });
    }
  }
  return regions;
}

/** The narrative's jump edges: every routing field a step sets, as (from, to, field, the step's type). endStep is a region bound, not a jump, and is left out. */
function jumpEdgesOf(steps: NarrativeStep[]): JumpEdge[] {
  const edges: JumpEdge[] = [];
  for (const s of steps) {
    const push = (field: string, to: number | undefined): void => {
      if (to !== undefined) edges.push({ from: s.stepNumber, to, field, kind: s.type });
    };
    push('onTrueStep', s.onTrueStep);
    push('onFalseStep', s.onFalseStep);
    push('defaultStep', s.defaultStep);
    push('toStep', s.toStep);
    push('finallyStep', s.finallyStep);
    (s.cases ?? []).forEach((c, i) => push(`cases[${i}].step`, c.step));
    (s.catches ?? []).forEach((c, i) => push(`catches[${i}].step`, c.step));
  }
  return edges;
}
