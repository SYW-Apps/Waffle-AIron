import { loadImplementationSpecs, saveImplementationSpec, invalidateSpecCache } from './specs.js';
import { narrativeStepForeignFields } from '../models/index.js';
import type { ImplementationSpec, NarrativeStep } from '../models/index.js';

// ---------------------------------------------------------------------------
// Foreign step-field repair (sdd_core, behind `wairon doctor`)
//
// A narrative step's `type` decides which fields it may carry. Changing that
// type used to MERGE the new type's fields over the old step and leave the
// rest standing, so a branch rewritten as a call kept its `condition`, and a
// call rewritten as a throw kept its `targetComponent`. The writer now
// rebuilds a retyped step, so no new leftovers appear; FOREIGN_STEP_FIELD
// reports the ones already written, and this is the mechanical repair that
// clears them.
//
// What it does NOT do is guess. A `local` step carrying a target may be a call
// that lost its type, or a step whose prose merely mentions the callee — only
// its author knows which, so the repair removes the field that configures
// nothing and never rewrites `type`. The doctor reports each removal by name
// for exactly that reason.
// ---------------------------------------------------------------------------

/** One narrative step whose foreign fields were, or would be, dropped (foreign_field_repair). */
export interface ForeignFieldRepair {
  /** The implementation spec whose narrative holds the step. */
  implementation: string;
  /** The method whose narrative holds the step. */
  method: string;
  /** The step the fields sat on. */
  stepNumber: number;
  /** The step's own type, which is what makes the fields foreign. */
  stepType: string;
  /** The foreign fields, in the order the step declared them. */
  fields: string[];
}

/**
 * Plan, and with apply write, the removal of every narrative-step field its
 * own step type cannot have. Each foreign field is dropped from its step;
 * the step's type, description, label and every field its type does carry are
 * left exactly as they are. Only an implementation that actually changed is
 * saved. Without apply nothing is written.
 */
export function repairForeignStepFields(apply: boolean): ForeignFieldRepair[] {
  // Step 1: every implementation spec in the bound tree.
  const implementations = loadImplementationSpecs();
  const repairs: ForeignFieldRepair[] = [];
  const changed: ImplementationSpec[] = [];

  // Steps 2–9: walk every step of every method, collecting and clearing.
  for (const impl of implementations) {
    let touched = false;
    for (const method of impl.methods) {
      for (const step of method.narrative) {
        // Step 4: the one per-type table, read through the step's own behaviour.
        const fields = narrativeStepForeignFields(step);
        // Step 5: a step whose every field belongs to its type is left alone.
        if (!fields.length) continue;
        // Step 6: record what was found, before it is gone.
        repairs.push({
          implementation: impl.id,
          method: method.name,
          stepNumber: step.stepNumber,
          stepType: step.type,
          fields,
        });
        // Step 7: drop them, and nothing else.
        for (const field of fields) delete (step as unknown as Record<string, unknown>)[field as keyof NarrativeStep];
        touched = true;
      }
    }
    if (touched) changed.push(impl);
  }

  // Steps 9–10: only with apply, and only what changed.
  if (apply && changed.length) {
    for (const impl of changed) saveImplementationSpec(impl);
    invalidateSpecCache();
  }

  // Step 11: the repairs, planned or written, in tree order.
  return repairs;
}
