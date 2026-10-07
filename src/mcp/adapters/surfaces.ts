// ---------------------------------------------------------------------------
// mcp_surfaces_adapter — sdd_mcp's client hop into sdd_surfaces: identity
// re-export of the surface portal.
// ---------------------------------------------------------------------------
export { pinExternals, getExternalsStatus } from '../../core/surface-portal.js';
// sdd_add_external: declare one external of the bound project.
export { declareExternal } from '../../core/surface-portal.js';
// sdd_remove_external and sdd_update_external: remove one external and its pin; change its `use` imports.
export { removeExternal, updateExternalUse } from '../../core/surface-portal.js';
