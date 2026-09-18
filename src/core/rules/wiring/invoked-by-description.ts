import { SddRule } from '../types.js';
import { passesIntentFloor } from '../../../models/index.js';

/**
 * An `invokedBy` declaration is a claim about the world OUTSIDE the modeled
 * graph — a runtime, a scheduler, a human — and it silences unused-detection
 * for the method it sits on. The claim is only reviewable if it says who does
 * the invoking and when, so its `caller` prose is held to the intent floor.
 *
 * A prose check over the declaration itself: it neither walks the narrative
 * graph nor reads what the declaration makes reachable.
 */
export const invokedByDescriptionRule: SddRule = {
  name: 'invoked-by-description',
  description:
    'An invokedBy declaration names a caller outside the modeled graph and silences unused-detection for its method, so the claim must stay reviewable: its "caller" prose is held to the intent floor (missing or placeholder-thin prose is reported), stating WHO invokes the method and when.',
  codes: [
    { code: 'INVOKED_BY_UNDESCRIBED', defaultSeverity: 'warning', summary: 'invokedBy declaration whose caller prose is missing or placeholder-thin' },
  ],
  check(ctx) {
    for (const intf of ctx.interfaces) {
      // A declaration on an unresolvable component can't be judged (the
      // dangling reference is the hierarchy family's finding).
      if (!ctx.componentMap.has(intf.component)) continue;
      if (!ctx.isSpecInScope(intf.id)) continue;
      for (const m of intf.methods) {
        if (!m.invokedBy) continue;
        if (passesIntentFloor(m.invokedBy.caller, m.name)) continue;
        // A draft or design subsystem makes its components draft context too.
        const isDraftCtx = ctx.isComponentDraft(intf.component) || intf.status === 'draft' || intf.status === 'design';
        ctx.addIssue(
          'warning',
          'INVOKED_BY_UNDESCRIBED',
          `Method "${m.name}" on component "${intf.component}" declares invokedBy (${m.invokedBy.kind}) but its "caller" prose is missing or placeholder-thin — state WHO invokes it and when, so the entrypoint claim stays reviewable.`,
          intf.id,
          isDraftCtx,
        );
      }
    }
  },
};
