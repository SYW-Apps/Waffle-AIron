// ---------------------------------------------------------------------------
// migration_validator_adapter — sdd_migrations' client hop into sdd_validator.
//
// An identity re-export of the validator portal's family run, at whatever
// root the caller has bound: the live family, or a rehearsal copy. The hop
// runs outward only: the validator never calls back into the migrations.
// ---------------------------------------------------------------------------
export { validateFamily, listRules } from '../../core/validation.js';
