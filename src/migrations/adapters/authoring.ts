// ---------------------------------------------------------------------------
// migration_authoring_adapter — sdd_migrations' client hop into sdd_authoring:
// identity re-export of the authoring portal. The chaining migration writes NEW
// spec content (a minimal L0, the L0 export entries a person would otherwise
// have written) through the gated seam, never through core's raw write.
// ---------------------------------------------------------------------------
export { writeSpec, updateSpecGated } from '../../core/authoring.js';
