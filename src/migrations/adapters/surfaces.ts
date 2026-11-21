// ---------------------------------------------------------------------------
// migration_surfaces_adapter — sdd_migrations' client hop into sdd_surfaces:
// identity re-exports of the surface portal, at the project root the caller
// has bound. The migrations pin and list a root's externals. The caller
// must gate on reach itself. The verbs carry a pin to a new alias or producer
// id (renamePin) and remove one whose alias stops being an external (unpin).
// ---------------------------------------------------------------------------
export {
  pinExternals,
  getExternalsStatus,
  listExternals,
  listConsumers,
} from '../../core/surface-portal.js';
// The migrations' pin maintenance comes through sdd_surfaces' internal portal.
export { renamePin, unpin } from '../../core/pin-maintenance-portal.js';
