// ---------------------------------------------------------------------------
// migration_surfaces_adapter — sdd_migrations' client hop into sdd_surfaces:
// identity re-exports of the surface portal, at the project root the caller
// has bound. The chaining migration pins, lists a root's externals and stage-1
// family pins, and removes each family pin once it is converted. The caller
// must gate on reach itself. The verbs carry a pin to a new alias or producer
// id (renamePin) and remove one whose alias stops being an external (unpin).
// ---------------------------------------------------------------------------
export {
  pinExternals,
  listExternals,
  removeSnapshot,
} from '../../core/surface-portal.js';
// The migrations' pin maintenance comes through sdd_surfaces' internal portal.
export { listFamilyPins, renamePin, unpin } from '../../core/pin-maintenance-portal.js';
