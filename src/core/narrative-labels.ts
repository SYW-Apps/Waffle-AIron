// ---------------------------------------------------------------------------
// Symbolic step labels. LLM authors miscount steps; a `label` is an anchor
// fixed to a step, and every jump-by-number flow field has a *Label twin
// resolved against the anchors AT WRITE TIME. The stored spec keeps plain
// step numbers (renderers and the flow validator handle one shape); only the
// authoring surface gets the renumber-proof references. Resolution runs in
// updateSpec (post-merge, so a delta can reference labels on existing steps)
// and in sdd_write_narrative; an unresolvable reference ABORTS the write —
// silently dropping it would turn a typo into a dangling numeric jump.
// ---------------------------------------------------------------------------

/** Transient *Label reference field → the persisted numeric field it resolves into. */
const SCALAR_REFS: [string, string][] = [
  ['onTrueLabel', 'onTrueStep'],
  ['onFalseLabel', 'onFalseStep'],
  ['defaultLabel', 'defaultStep'],
  ['endLabel', 'endStep'],
  ['finallyLabel', 'finallyStep'],
  ['toLabel', 'toStep'],
];

/**
 * Resolve every symbolic label reference in a method's narrative to its step
 * number, deleting the reference fields. Mutates the steps in place. Returns
 * the list of resolution errors (empty = fully resolved); the caller must
 * abort the write when any are returned.
 */
export function resolveNarrativeLabels(methodName: string, steps: Record<string, any>[]): string[] {
  const errors: string[] = [];
  const labels = new Map<string, number>();
  for (const s of steps) {
    if (typeof s.label === 'string' && s.label.length) {
      const prior = labels.get(s.label);
      if (prior !== undefined) errors.push(`duplicate label "${s.label}" (steps ${prior} and ${s.stepNumber})`);
      else labels.set(s.label, s.stepNumber);
    }
  }

  const lookup = (ref: unknown, where: string): number | undefined => {
    if (typeof ref !== 'string' || !ref.length) {
      errors.push(`${where} is not a label string`);
      return undefined;
    }
    const n = labels.get(ref);
    if (n === undefined) {
      errors.push(`${where} references unknown label "${ref}"${labels.size ? ` (declared: ${[...labels.keys()].join(', ')})` : ' (no step declares a label)'}`);
    }
    return n;
  };

  for (const s of steps) {
    for (const [labelField, stepField] of SCALAR_REFS) {
      if (s[labelField] === undefined) continue;
      const n = lookup(s[labelField], `step ${s.stepNumber} ${labelField}`);
      if (n !== undefined) {
        if (typeof s[stepField] === 'number' && s[stepField] !== n) {
          errors.push(`step ${s.stepNumber} sets both ${stepField}=${s[stepField]} and ${labelField}="${s[labelField]}" (= step ${n}) — they disagree`);
        } else {
          s[stepField] = n;
        }
      }
      delete s[labelField];
    }
    for (const key of ['cases', 'catches', 'branches']) {
      const arr = s[key];
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        if (!entry || typeof entry !== 'object' || (entry as Record<string, unknown>).label === undefined) continue;
        const e = entry as Record<string, any>;
        const n = lookup(e.label, `step ${s.stepNumber} ${key} entry`);
        if (n !== undefined) {
          if (typeof e.step === 'number' && e.step !== n) {
            errors.push(`step ${s.stepNumber} ${key} entry sets both step=${e.step} and label="${e.label}" (= step ${n}) — they disagree`);
          } else {
            e.step = n;
          }
        }
        delete e.label;
      }
    }
  }
  return errors.map(e => `narrative of "${methodName}": ${e}`);
}
