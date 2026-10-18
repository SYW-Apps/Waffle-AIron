// ---------------------------------------------------------------------------
// upgrade_migration_adapter — sdd_upgrade's client hop into sdd_migrations.
//
// Identity forwards of the migration portal: the family transaction an upgrade
// is planned and applied through (rehearse, diff, commit, drop) and the
// chaining migration while it still lives in sdd_migrations (plan, apply).
// ---------------------------------------------------------------------------
export { rehearse, diff, commit, drop, plan, apply } from '../../migrations/index.js';
