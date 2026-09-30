// ---------------------------------------------------------------------------
// mcp_validator_adapter — sdd_mcp's client hop into sdd_validator: identity
// re-exports of the validator portal.
// ---------------------------------------------------------------------------
// familyApprovals: the bound project's pin tree, each project's approval state
// computed at its own root — what sdd_get_status prints beside the report.
export { validateProject, validateRegistry, validateFamily, measurePackImpact, familyApprovals } from '../../core/validation.js';
