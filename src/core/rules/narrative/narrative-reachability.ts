import { stepConfigVerdict, stepGraph } from '../../../models/index.js';
import type { NarrativeStep } from '../../../models/index.js';
import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Can every step be reached, and do the regions nest?
//
// Both questions are about the SHAPE a narrative projects onto structured
// code: a step nothing can reach is dead code, and loop/try/parallel regions
// that interleave cannot be written as nested blocks at all.
//
// Both run behind method_implementation.stepConfigVerdict().sound. A narrative
// whose jumps target step numbers it does not have would have its sound steps
// reported as unreachable — wrong findings, not merely noisier ones — so an
// unsound narrative is left to narrative-step-config, which says why.
// ---------------------------------------------------------------------------

export const narrativeReachabilityRule: SddRule = {
  name: 'narrative-reachability',
  description:
    'Every step of an L5 narrative must be reachable from the first step following fall-through and jumps, and the loop/try/parallel regions it declares must nest or stay disjoint — interleaved regions map onto no structured code. Judged over the step graph, and only for a narrative whose step configuration is sound (narrative-step-config reports the rest).',
  codes: [
    { code: 'UNREACHABLE_STEP', defaultSeverity: 'warning', summary: 'Step not reachable from the first step following fall-through and jumps' },
    { code: 'REGION_OVERLAP', defaultSeverity: 'error', summary: 'loop/try regions interleave — regions must nest or be disjoint to map onto structured code' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const isDraftCtx = ctx.isImplementationDraft(impl);

      for (const implMethod of impl.methods) {
        const steps = implMethod.narrative;
        if (!steps.length) continue;
        // Reachability and region nesting only make sense over a structurally
        // sound narrative.
        if (!stepConfigVerdict(implMethod).sound) continue;
        const where = `Method "${implMethod.name}" in implementation "${impl.id}": `;

        const graph = stepGraph(implMethod);
        const nums = graph.stepNumbers;
        const visited = new Set<number>();
        const stack = [nums[0]];
        while (stack.length) {
          const n = stack.pop()!;
          if (visited.has(n)) continue;
          visited.add(n);
          for (const t of graph.successorsOf(n)) {
            if (!visited.has(t)) stack.push(t);
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

        // Regions (loop/try/parallel bodies) are numeric spans; structured
        // code can only express them nested or disjoint.
        const regions = regionsOf(steps);
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
