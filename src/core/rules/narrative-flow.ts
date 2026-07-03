import { NarrativeStep } from '../../models/index.js';
import { SddRule } from './types.js';

// ---------------------------------------------------------------------------
// Structural soundness of narrative control flow. Narratives are flat ordered
// step lists; flow steps (branch/switch/loop/try/jump) jump by step number.
// The schema keeps all flow fields optional — THIS rule enforces that each
// step type carries its required config, that every jump lands on a real
// step, and that no step is dead code.
// ---------------------------------------------------------------------------

const FLOW_FIELDS = [
  'condition', 'onTrueStep', 'onFalseStep', 'on', 'cases', 'defaultStep',
  'loopKind', 'over', 'endStep', 'catches', 'finallyStep', 'toStep',
] as const;

function flowConfigOn(step: NarrativeStep): string[] {
  return FLOW_FIELDS.filter(f => {
    const v = step[f];
    if (v === undefined) return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  });
}

export const narrativeFlowRule: SddRule = {
  name: 'narrative-flow',
  description:
    'Control-flow soundness of L5 narratives: flow steps (branch, switch, loop, try, jump) must carry their required config, every jump field must target an existing step number in the same narrative, and every step must be reachable from the first step following fall-through and jumps.',
  codes: [
    { code: 'MALFORMED_FLOW_STEP', defaultSeverity: 'error', summary: 'Flow step missing required config (or flow config on a local/call step)' },
    { code: 'INVALID_STEP_JUMP', defaultSeverity: 'error', summary: 'Jump field targets a step number that does not exist in the narrative' },
    { code: 'UNREACHABLE_STEP', defaultSeverity: 'warning', summary: 'Step not reachable from the first step following fall-through and jumps' },
    { code: 'REGION_OVERLAP', defaultSeverity: 'error', summary: 'loop/try regions interleave — regions must nest or be disjoint to map onto structured code' },
    { code: 'JUMP_INTO_REGION', defaultSeverity: 'warning', summary: 'Jump lands in the middle of a loop/try body from outside — regions are entered through their header' },
    { code: 'FALLTHROUGH_INTO_HANDLER', defaultSeverity: 'warning', summary: 'try body falls through into its own catch/finally region on the success path' },
    { code: 'BACKWARD_JUMP', defaultSeverity: 'warning', summary: 'Backward jump that is not a continue to an enclosing loop header — model repetition with a loop step' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      const isDraftCtx =
        impl.status === 'draft' || impl.status === 'design'
        || (contract ? (contract.status === 'draft' || contract.status === 'design' || ctx.isComponentDraft(contract.component)) : false);

      for (const implMethod of impl.methods) {
        const steps = implMethod.narrative;
        if (!steps.length) continue;
        const where = `Method "${implMethod.name}" in implementation "${impl.id}": `;

        let sound = true;
        const malformed = (msg: string): void => {
          sound = false;
          ctx.addIssue('error', 'MALFORMED_FLOW_STEP', where + msg, impl.id, isDraftCtx);
        };

        const byNum = new Map<number, NarrativeStep>();
        for (const s of steps) {
          if (byNum.has(s.stepNumber)) malformed(`duplicate stepNumber ${s.stepNumber} — jump targets would be ambiguous.`);
          byNum.set(s.stepNumber, s);
        }
        const nums = [...byNum.keys()].sort((a, b) => a - b);
        const indexOf = new Map(nums.map((n, i) => [n, i]));
        const nextOf = (n: number): number | undefined => {
          const i = indexOf.get(n);
          return i !== undefined && i + 1 < nums.length ? nums[i + 1] : undefined;
        };

        for (const s of steps) {
          switch (s.type) {
            case 'local':
            case 'call': {
              const extra = flowConfigOn(s);
              if (extra.length) malformed(`step ${s.stepNumber} (${s.type}) carries flow config (${extra.join(', ')}) — use a flow step type instead.`);
              break;
            }
            case 'branch':
              if (!s.condition) malformed(`branch step ${s.stepNumber} requires "condition".`);
              if (s.onFalseStep === undefined) malformed(`branch step ${s.stepNumber} requires "onFalseStep" (true continues at onTrueStep or the next step).`);
              break;
            case 'switch':
              if (!s.cases || !s.cases.length) malformed(`switch step ${s.stepNumber} requires non-empty "cases".`);
              break;
            case 'loop': {
              if (s.endStep === undefined) malformed(`loop step ${s.stepNumber} requires "endStep" (last step of the body).`);
              else if (s.endStep <= s.stepNumber) malformed(`loop step ${s.stepNumber} "endStep" (${s.endStep}) must lie beyond the header.`);
              const kind = s.loopKind ?? (s.over ? 'forEach' : 'while');
              if ((kind === 'while' || kind === 'doWhile') && !s.condition) malformed(`${kind} loop step ${s.stepNumber} requires "condition".`);
              if ((kind === 'forEach' || kind === 'for') && !s.over) malformed(`${kind} loop step ${s.stepNumber} requires "over" (the iteration source).`);
              break;
            }
            case 'try':
              if (s.endStep === undefined) malformed(`try step ${s.stepNumber} requires "endStep" (last step of the guarded body).`);
              else if (s.endStep <= s.stepNumber) malformed(`try step ${s.stepNumber} "endStep" (${s.endStep}) must lie beyond the header.`);
              if ((!s.catches || !s.catches.length) && s.finallyStep === undefined) malformed(`try step ${s.stepNumber} requires "catches" and/or "finallyStep" — a guard that handles nothing guards nothing.`);
              break;
            case 'jump':
              if (s.toStep === undefined) malformed(`jump step ${s.stepNumber} requires "toStep".`);
              break;
            // return / throw need no config
          }

          const jumpFields: [string, number][] = [];
          if (s.onTrueStep !== undefined) jumpFields.push(['onTrueStep', s.onTrueStep]);
          if (s.onFalseStep !== undefined) jumpFields.push(['onFalseStep', s.onFalseStep]);
          if (s.defaultStep !== undefined) jumpFields.push(['defaultStep', s.defaultStep]);
          if (s.endStep !== undefined) jumpFields.push(['endStep', s.endStep]);
          if (s.finallyStep !== undefined) jumpFields.push(['finallyStep', s.finallyStep]);
          if (s.toStep !== undefined) jumpFields.push(['toStep', s.toStep]);
          (s.cases ?? []).forEach((c, i) => jumpFields.push([`cases[${i}].step`, c.step]));
          (s.catches ?? []).forEach((c, i) => jumpFields.push([`catches[${i}].step`, c.step]));
          for (const [field, target] of jumpFields) {
            if (!byNum.has(target)) {
              sound = false;
              ctx.addIssue(
                'error',
                'INVALID_STEP_JUMP',
                `${where}step ${s.stepNumber} "${field}" targets step ${target}, which does not exist in this narrative.`,
                impl.id,
                isDraftCtx,
              );
            }
          }
        }

        // Reachability only makes sense over a structurally sound narrative.
        if (!sound) continue;
        const visited = new Set<number>();
        const stack = [nums[0]];
        while (stack.length) {
          const n = stack.pop()!;
          if (visited.has(n)) continue;
          visited.add(n);
          const s = byNum.get(n)!;
          const succ: (number | undefined)[] = [];
          switch (s.type) {
            case 'local':
            case 'call':
              succ.push(nextOf(n));
              break;
            case 'branch':
              succ.push(s.onTrueStep ?? nextOf(n), s.onFalseStep);
              break;
            case 'switch':
              succ.push(...(s.cases ?? []).map(c => c.step), s.defaultStep ?? nextOf(n));
              break;
            case 'loop':
              succ.push(nextOf(n), s.endStep !== undefined ? nextOf(s.endStep) : undefined);
              break;
            case 'try':
              succ.push(
                nextOf(n),
                ...(s.catches ?? []).map(c => c.step),
                s.finallyStep,
                s.endStep !== undefined ? nextOf(s.endStep) : undefined,
              );
              break;
            case 'jump':
              succ.push(s.toStep);
              break;
            // return / throw terminate the path
          }
          for (const t of succ) {
            if (t !== undefined && byNum.has(t) && !visited.has(t)) stack.push(t);
          }
        }
        const dead = nums.filter(n => !visited.has(n));
        if (dead.length) {
          ctx.addIssue(
            'warning',
            'UNREACHABLE_STEP',
            `${where}step(s) ${dead.join(', ')} cannot be reached from step ${nums[0]} following fall-through and jumps.`,
            impl.id,
            isDraftCtx,
          );
        }

        // ---- structural soundness of regions and jumps ----------------------
        // Regions (loop/try bodies) are numeric spans; structured code can only
        // express them nested or disjoint, entered through their header.
        const regions: { h: number; end: number; kind: string }[] = [];
        for (const s of steps) {
          if ((s.type === 'loop' || s.type === 'try') && s.endStep !== undefined) {
            regions.push({ h: s.stepNumber, end: s.endStep, kind: s.type });
          }
        }
        const inBody = (n: number, r: { h: number; end: number }): boolean => n > r.h && n <= r.end;

        for (const a of regions) {
          for (const b of regions) {
            if (b.h > a.h && b.h <= a.end && b.end > a.end) {
              ctx.addIssue(
                'error',
                'REGION_OVERLAP',
                `${where}${b.kind} region ${b.h}..${b.end} interleaves with ${a.kind} region ${a.h}..${a.end} — regions must be nested or disjoint.`,
                impl.id,
                isDraftCtx,
              );
            }
          }
        }

        const jumpEdges: { from: number; to: number; field: string; kind: string }[] = [];
        for (const s of steps) {
          const push = (field: string, to: number | undefined): void => {
            if (to !== undefined) jumpEdges.push({ from: s.stepNumber, to, field, kind: s.type });
          };
          push('onTrueStep', s.onTrueStep);
          push('onFalseStep', s.onFalseStep);
          push('defaultStep', s.defaultStep);
          push('toStep', s.toStep);
          push('finallyStep', s.finallyStep);
          (s.cases ?? []).forEach((c, i) => push(`cases[${i}].step`, c.step));
          (s.catches ?? []).forEach((c, i) => push(`catches[${i}].step`, c.step));
        }

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
          // Backward jumps are only idiomatic as a continue to an enclosing
          // loop header; anything else is an unstructured loop in disguise.
          if ((e.kind === 'branch' || e.kind === 'switch' || e.kind === 'jump') && e.to < e.from) {
            const continueToLoop = regions.some(r => r.kind === 'loop' && r.h === e.to && inBody(e.from, r));
            if (!continueToLoop) {
              ctx.addIssue(
                'warning',
                'BACKWARD_JUMP',
                `${where}step ${e.from} "${e.field}" jumps backwards to step ${e.to} — model repetition with a loop step (backward jumps are only idiomatic as a continue to an enclosing loop header).`,
                impl.id,
                isDraftCtx,
              );
            }
          }
        }

        // A try body whose last step simply falls through runs its handlers on
        // the SUCCESS path — almost always a missing jump/return at the body end.
        for (const s of steps) {
          if (s.type !== 'try' || s.endStep === undefined) continue;
          const handlerStarts = new Set<number>((s.catches ?? []).map(c => c.step));
          if (s.finallyStep !== undefined) handlerStarts.add(s.finallyStep);
          const last = byNum.get(s.endStep);
          const nxt = nextOf(s.endStep);
          if (last && (last.type === 'local' || last.type === 'call') && nxt !== undefined && handlerStarts.has(nxt)) {
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
