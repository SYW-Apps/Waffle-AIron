// ---------------------------------------------------------------------------
// cli_surfaces_client_adapter — sdd_cli's client hop into sdd_surfaces:
// identity re-exports of the surface portal, backing `wairon surface`.
// ---------------------------------------------------------------------------
export {
  exportSurface,
  importSurface,
  listSnapshots,
  listExternalInterfaces,
  pinFamilySurfaces,
} from '../../core/surfaces.js';
