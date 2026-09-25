// ---------------------------------------------------------------------------
// mcp_authoring_adapter — sdd_mcp's client hop into sdd_authoring: identity
// re-exports of the authoring portal. Every authored write the server makes
// lands here, and through here on the gated seam.
// ---------------------------------------------------------------------------
export { writeSpec, deleteSpec, updateSpecGated, moveMethods } from '../../core/authoring.js';
