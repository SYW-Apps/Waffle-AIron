// ---------------------------------------------------------------------------
// mcp_upgrade_adapter — sdd_mcp's client hop into sdd_upgrade: an identity
// re-export of the upgrade portal's standing, which the server's standing guard
// reads on every tool call to learn whether the bound tree was written by the
// running wairon major.
// ---------------------------------------------------------------------------
export { standing } from '../../upgrade/index.js';
