// ---------------------------------------------------------------------------
// cli_surfaces_client_adapter — sdd_cli's client hop into sdd_surfaces:
// identity re-exports of the surface portal, backing `wairon surface`.
// ---------------------------------------------------------------------------
export {
  exportSurface,
  importSurface,
  listSnapshots,
  // doctor --fix's chaining migration: the stage-1 family pins a root still
  // holds, and the removal of each once it is converted.
  listFamilyPins,
  removeSnapshot,
  // `wairon externals`: pin, status and list of the declared externals.
  pinExternals,
  getExternalsStatus,
  listExternals,
} from '../../core/surface-portal.js';
