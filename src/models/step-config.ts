import type { MethodImplementation, NarrativeStep } from './specs.js';

/**
 * One thing wrong with a narrative's step configuration (step_config_problem):
 * the step it sits on, the finding code it maps to, and the detail a rule
 * appends to its own "Method X in implementation Y" prefix. Duplicate labels,
 * missing or misplaced flow config, and jumps that land nowhere are all
 * reported through this one shape.
 */
export interface StepConfigProblem {
  /** The step the problem sits on; a duplicate label names the earlier step in its detail. */
  stepNumber: number;
  /** The finding code this problem maps to. */
  code: 'DUPLICATE_STEP_LABEL' | 'MALFORMED_FLOW_STEP' | 'INVALID_STEP_JUMP';
  /** The problem stated in full, ready to follow a rule's own location prefix. */
  detail: string;
}

/**
 * What a narrative's step configuration says about itself (step_config_verdict):
 * the problems it carries, in step order, and whether its control flow is
 * SOUND — no duplicate step number, no missing or misplaced flow config, and
 * no jump that lands outside the narrative. A duplicate label is a problem but
 * not an unsoundness: labels name steps, they do not route flow.
 *
 * Soundness is the gate every later phase runs behind. Reachability, region
 * nesting and jump-edge judgement all read the step graph, and a graph built
 * over jumps that target nothing reports steps as dead that are merely
 * mis-numbered — wrong findings, not just noisier ones.
 */
export interface StepConfigVerdict {
  /** The step-config problems, in step order: labels first, then numbering, then per-step config and jump targets. */
  problems: StepConfigProblem[];
  /** True when nothing found makes the control flow unreadable — the precondition for judging structure. */
  sound: boolean;
}

/** The flow fields a step may carry; a simple step carrying any of them is malformed. */
const FLOW_FIELDS = [
  'condition', 'onTrueStep', 'onFalseStep', 'on', 'cases', 'defaultStep',
  'loopKind', 'over', 'endStep', 'catches', 'finallyStep', 'branches', 'toStep',
] as const;

/** The flow fields actually set on a step (an empty list counts as unset). */
function flowConfigOn(step: NarrativeStep): string[] {
  return FLOW_FIELDS.filter(f => {
    const v = step[f];
    if (v === undefined) return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  });
}

/**
 * method_implementation.stepConfigVerdict — the step-config problems of this
 * method's narrative and whether its control flow is sound. The schema keeps
 * every flow field optional, so this derivation is what holds each step type
 * to the config it needs, each label to one step, each step number to one
 * step, and every jump field to a step number the narrative actually has.
 */
export function stepConfigVerdict(method: Pick<MethodImplementation, 'narrative'>): StepConfigVerdict {
  const steps = method.narrative ?? [];
  const problems: StepConfigProblem[] = [];
  let sound = true;

  const malformed = (stepNumber: number, detail: string): void => {
    sound = false;
    problems.push({ stepNumber, code: 'MALFORMED_FLOW_STEP', detail });
  };

  // A label is the symbolic anchor later deltas address a step by, and the
  // WRITE path already refuses duplicates — but nothing checked a tree that
  // acquired one another way (a hand edit, or a git merge of two branches that
  // each added the same label). Such a tree validated 0/0 and then refused
  // EVERY sdd_update_spec on that implementation, including deltas to
  // unrelated fields, with no finding pointing at the cause.
  const labelled = new Map<string, number>();
  for (const step of steps) {
    const label = (step as { label?: string }).label;
    if (!label) continue;
    const first = labelled.get(label);
    if (first !== undefined) {
      problems.push({
        stepNumber: step.stepNumber,
        code: 'DUPLICATE_STEP_LABEL',
        detail: `steps ${first} and ${step.stepNumber} share the label "${label}". `
          + 'A label anchors one step for later deltas to address; two steps holding it makes '
          + 'every symbolic reference ambiguous and blocks all further edits to this implementation. '
          + 'Rename one.',
      });
    } else {
      labelled.set(label, step.stepNumber);
    }
  }

  const byNum = new Map<number, NarrativeStep>();
  for (const s of steps) {
    if (byNum.has(s.stepNumber)) malformed(s.stepNumber, `duplicate stepNumber ${s.stepNumber} — jump targets would be ambiguous.`);
    byNum.set(s.stepNumber, s);
  }
  const nums = [...byNum.keys()].sort((a, b) => a - b);
  const indexOf = new Map(nums.map((n, i) => [n, i]));
  const nextOf = (n: number): number | undefined => {
    const i = indexOf.get(n);
    return i !== undefined && i + 1 < nums.length ? nums[i + 1] : undefined;
  };

  for (const s of steps) {
    if (s.detach && s.type !== 'call' && s.type !== 'dispatch') {
      malformed(s.stepNumber, `step ${s.stepNumber} (${s.type}) carries "detach" — fire-and-forget applies to call/dispatch steps only.`);
    }
    switch (s.type) {
      case 'local':
      case 'call':
      case 'register':
      case 'dispatch': {
        const extra = flowConfigOn(s);
        if (extra.length) malformed(s.stepNumber, `step ${s.stepNumber} (${s.type}) carries flow config (${extra.join(', ')}) — use a flow step type instead.`);
        break;
      }
      case 'branch':
        if (!s.condition) malformed(s.stepNumber, `branch step ${s.stepNumber} requires "condition".`);
        if (s.onFalseStep === undefined) malformed(s.stepNumber, `branch step ${s.stepNumber} requires "onFalseStep" (true continues at onTrueStep or the next step).`);
        break;
      case 'switch':
        if (!s.cases || !s.cases.length) malformed(s.stepNumber, `switch step ${s.stepNumber} requires non-empty "cases".`);
        break;
      case 'loop': {
        if (s.endStep === undefined) malformed(s.stepNumber, `loop step ${s.stepNumber} requires "endStep" (last step of the body).`);
        else if (s.endStep <= s.stepNumber) malformed(s.stepNumber, `loop step ${s.stepNumber} "endStep" (${s.endStep}) must lie beyond the header.`);
        const kind = s.loopKind ?? (s.over ? 'forEach' : 'while');
        if ((kind === 'while' || kind === 'doWhile') && !s.condition) malformed(s.stepNumber, `${kind} loop step ${s.stepNumber} requires "condition".`);
        if ((kind === 'forEach' || kind === 'for') && !s.over) malformed(s.stepNumber, `${kind} loop step ${s.stepNumber} requires "over" (the iteration source).`);
        break;
      }
      case 'try':
        if (s.endStep === undefined) malformed(s.stepNumber, `try step ${s.stepNumber} requires "endStep" (last step of the guarded body).`);
        else if (s.endStep <= s.stepNumber) malformed(s.stepNumber, `try step ${s.stepNumber} "endStep" (${s.endStep}) must lie beyond the header.`);
        if ((!s.catches || !s.catches.length) && s.finallyStep === undefined) malformed(s.stepNumber, `try step ${s.stepNumber} requires "catches" and/or "finallyStep" — a guard that handles nothing guards nothing.`);
        break;
      case 'parallel': {
        if (s.endStep === undefined) malformed(s.stepNumber, `parallel step ${s.stepNumber} requires "endStep" (last step of the fan-out body).`);
        else if (s.endStep <= s.stepNumber) malformed(s.stepNumber, `parallel step ${s.stepNumber} "endStep" (${s.endStep}) must lie beyond the header.`);
        const entries = (s.branches ?? []).map(b => b.step);
        if (entries.length < 2) {
          malformed(s.stepNumber, `parallel step ${s.stepNumber} requires "branches" with at least two arms — a single arm is sequential flow.`);
        } else {
          const sorted = [...entries].sort((a, b) => a - b);
          if (entries.some((e, i) => e !== sorted[i])) malformed(s.stepNumber, `parallel step ${s.stepNumber} "branches" must list arm entries in ascending order — arms are contiguous sub-regions of the body.`);
          if (new Set(entries).size !== entries.length) malformed(s.stepNumber, `parallel step ${s.stepNumber} "branches" lists the same entry step twice.`);
          const bodyStart = nextOf(s.stepNumber);
          if (bodyStart !== undefined && sorted[0] !== bodyStart) malformed(s.stepNumber, `parallel step ${s.stepNumber}: the first arm must start at the body's first step (${bodyStart}), got ${sorted[0]} — steps before the first arm would belong to no arm.`);
          if (s.endStep !== undefined && sorted.some(e => e > s.endStep!)) malformed(s.stepNumber, `parallel step ${s.stepNumber}: every arm entry must lie within the body (..${s.endStep}).`);
        }
        break;
      }
      case 'jump':
        if (s.toStep === undefined) malformed(s.stepNumber, `jump step ${s.stepNumber} requires "toStep".`);
        break;
      // return / throw need no config
    }

    for (const [field, target] of jumpFieldsOf(s)) {
      if (byNum.has(target)) continue;
      sound = false;
      problems.push({
        stepNumber: s.stepNumber,
        code: 'INVALID_STEP_JUMP',
        detail: `step ${s.stepNumber} "${field}" targets step ${target}, which does not exist in this narrative.`,
      });
    }
  }

  return { problems, sound };
}

/** Every jump field a step sets, as (field name, target step number) — the set whose targets must exist. */
function jumpFieldsOf(s: NarrativeStep): [string, number][] {
  const fields: [string, number][] = [];
  if (s.onTrueStep !== undefined) fields.push(['onTrueStep', s.onTrueStep]);
  if (s.onFalseStep !== undefined) fields.push(['onFalseStep', s.onFalseStep]);
  if (s.defaultStep !== undefined) fields.push(['defaultStep', s.defaultStep]);
  if (s.endStep !== undefined) fields.push(['endStep', s.endStep]);
  if (s.finallyStep !== undefined) fields.push(['finallyStep', s.finallyStep]);
  if (s.toStep !== undefined) fields.push(['toStep', s.toStep]);
  (s.cases ?? []).forEach((c, i) => fields.push([`cases[${i}].step`, c.step]));
  (s.catches ?? []).forEach((c, i) => fields.push([`catches[${i}].step`, c.step]));
  (s.branches ?? []).forEach((b, i) => fields.push([`branches[${i}].step`, b.step]));
  return fields;
}
