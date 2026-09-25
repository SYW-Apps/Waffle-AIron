// ---------------------------------------------------------------------------
// authoring_validator_adapter — sdd_authoring's client hop into sdd_validator.
//
// Identity re-exports of the validator portal. The hop runs outward only: the
// validator reads the spec tree through sdd_core and never calls back here.
// ---------------------------------------------------------------------------
export { validateComponentCandidate, findTestsReferencing } from '../validation.js';
