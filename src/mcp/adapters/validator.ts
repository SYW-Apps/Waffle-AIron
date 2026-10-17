// ---------------------------------------------------------------------------
// mcp_validator_adapter — sdd_mcp's client hop into sdd_validator: identity
// re-exports of the validator portal.
// ---------------------------------------------------------------------------
// familyApprovals: the bound project's pin tree, each project's approval state
// computed at its own root — what sdd_get_status prints beside the report.
export { validateProject, validateRegistry, validateFamily, measurePackImpact, familyApprovals } from '../../core/validation.js';
// adviseExternals: the advisory live comparison of the bound project's
// externals the run did not compose — what sdd_validate_tree and
// sdd_get_status append beside the gate's own findings.
export { adviseExternals } from '../../core/validation.js';
