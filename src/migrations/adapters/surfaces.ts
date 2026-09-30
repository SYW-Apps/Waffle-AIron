// ---------------------------------------------------------------------------
// migration_surfaces_adapter — sdd_migrations' client hop into sdd_surfaces:
// identity re-exports of the surface portal, at the project root the caller
// has bound. The chaining migration pins, lists a root's externals and stage-1
// family pins, and removes each family pin once it is converted. The caller
// must gate on reach itself. Carrying a pin to a new alias (renamePin) and
// removing one (unpin) join with the verbs in stage 6 wave B.
// ---------------------------------------------------------------------------
export {
  pinExternals,
  listExternals,
  listFamilyPins,
  removeSnapshot,
} from '../../core/surface-portal.js';
