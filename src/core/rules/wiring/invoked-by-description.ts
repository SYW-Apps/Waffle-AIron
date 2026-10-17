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
/** The intent floor said as a reader can check it: the length it asks for, and the length the prose has. */
function floorNote(caller: string | undefined): string {
  const length = (caller ?? '').trim().length;
  return ` (the floor: at least 40 characters once trimmed, and more than the method's own name — this caller has ${length})`;
}

export const invokedByDescriptionRule: SddRule = {
  name: 'invoked-by-description',
  judges: 'design',
  description:
    'An invokedBy declaration names a caller outside the modeled graph and silences unused-detection for its method, so the claim must stay reviewable: its "caller" prose is held to the intent floor (missing or placeholder-thin prose is reported), stating WHO invokes the method and when. A Portal-level invokedBy (the entry every verb of the Portal inherits) is held to the same floor, on the Portal.',
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
          `Method "${m.name}" on component "${intf.component}" declares invokedBy (${m.invokedBy.kind}) but its "caller" prose is missing or placeholder-thin${floorNote(m.invokedBy.caller)} — state WHO invokes it and when, so the entrypoint claim stays reviewable.`,
          intf.id,
          isDraftCtx,
        );
      }
    }
    // Then the Portal-level declarations: the entry every verb inherits.
    for (const comp of ctx.components) {
      if (comp.componentType !== 'Portal' || !comp.invokedBy || !ctx.isSpecInScope(comp.id)) continue;
      if (passesIntentFloor(comp.invokedBy.caller, comp.id)) continue;
      ctx.addIssue(
        'warning',
        'INVOKED_BY_UNDESCRIBED',
        `Portal "${comp.id}" declares invokedBy (${comp.invokedBy.kind}) for every verb, but its "caller" prose is missing or placeholder-thin${floorNote(comp.invokedBy.caller)} — state WHO reaches the Portal and how, so the entry claim stays reviewable.`,
        comp.id,
        ctx.isComponentDraft(comp.id),
      );
    }
  },
};
