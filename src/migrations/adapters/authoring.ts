// ---------------------------------------------------------------------------
// migration_authoring_adapter — sdd_migrations' client hop into sdd_authoring:
// identity re-export of the authoring portal: the migrations write spec content
// through the gated seam, never through core's raw write.
// ---------------------------------------------------------------------------
export { updateSpecGated } from '../../core/authoring.js';
