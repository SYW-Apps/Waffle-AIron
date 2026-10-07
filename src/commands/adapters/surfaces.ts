// ---------------------------------------------------------------------------
// cli_surfaces_client_adapter — sdd_cli's client hop into sdd_surfaces:
// identity re-exports of the surface portal, backing `wairon surface`.
// ---------------------------------------------------------------------------
export {
  exportSurface,
  // `wairon export`: the whole design, resolved (the design export).
  exportDesign,
  importSurface,
  listSnapshots,
  // `wairon externals`: pin, status and list of the declared externals.
  pinExternals,
  getExternalsStatus,
  listExternals,
  // `wairon externals add`: declare one external.
  declareExternal,
  // `wairon externals remove | use | consumers`.
  removeExternal,
  updateExternalUse,
  listConsumers,
  // `wairon surface diff`: the public-surface changelog since the last approval.
  diffSurface,
} from '../../core/surface-portal.js';
