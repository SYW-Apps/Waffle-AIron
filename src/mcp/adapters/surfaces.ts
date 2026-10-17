// ---------------------------------------------------------------------------
// mcp_surfaces_adapter — sdd_mcp's client hop into sdd_surfaces: identity
// re-export of the surface portal.
// ---------------------------------------------------------------------------
export { pinExternals, getExternalsStatus } from '../../core/surface-portal.js';
// sdd_add_external: declare one external of the bound project.
export { declareExternal } from '../../core/surface-portal.js';
// sdd_remove_external and sdd_update_external: remove one external and its pin; change its `use` imports.
export { removeExternal, updateExternalUse } from '../../core/surface-portal.js';
// sdd_list_consumers and sdd_surface_diff: who consumes this project, and what its public surface changed since the last approval.
export { listConsumers, diffSurface } from '../../core/surface-portal.js';
