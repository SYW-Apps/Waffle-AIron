// ---------------------------------------------------------------------------
// authoring_validator_adapter — sdd_authoring's client hop into sdd_validator.
//
// Identity re-exports of the validator portal. The hop runs outward only: the
// validator reads the spec tree through sdd_core and never calls back here.
// ---------------------------------------------------------------------------
export { validateComponentCandidate, introducedFindings, findTestsReferencing, implementsProblem, validateProject, listRules } from '../validation.js';

import { findReferences as validatorFindReferences } from '../validation.js';
import type { LookupReferencesResult } from '../../models/lookup.js';

/**
 * authoring_validator_adapter.findReferences — forwards the lookup to the
 * validator portal. A lookup that throws answers no references: naming the
 * callers of a changed method must never be the thing that fails a write.
 */
export function findReferences(target: string, includeText?: boolean): LookupReferencesResult {
  // Step 1: forward to the validator portal; a lookup that throws answers nothing.
  try {
    return validatorFindReferences(target, includeText);
  } catch {
    return {
      target: null,
      candidates: [],
      references: [],
      waivers: [],
      impact: 'none',
      snapshot: { codeFingerprint: '', codeGrade: 'none', builtAt: new Date().toISOString(), searched: [], notSearched: [] },
    };
  }
}
