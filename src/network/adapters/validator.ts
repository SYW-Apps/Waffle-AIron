// ---------------------------------------------------------------------------
// network_validator_adapter — sdd_network's client hop into sdd_validator:
// the reach model of the bound project (its family at a project that declares
// members). The validator is the one authority on what reaches what, so the
// derived outputs can never disagree with the network verdicts.
// ---------------------------------------------------------------------------
export { reachModel } from '../../core/validation.js';
