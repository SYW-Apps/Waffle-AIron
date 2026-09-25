// ---------------------------------------------------------------------------
// cli_authoring_adapter — sdd_cli's client hop into sdd_authoring: identity
// re-export of the authoring portal. Every spec a terminal command AUTHORS goes
// through the gated seam, never through core's raw chained-subsystem write.
// ---------------------------------------------------------------------------
export { writeSpec } from '../../core/authoring.js';
