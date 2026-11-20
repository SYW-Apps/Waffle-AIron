// ---------------------------------------------------------------------------
// upgrade_migration_adapter — sdd_upgrade's client hop into sdd_migrations.
//
// Identity forwards of the migration portal: the family transaction an upgrade
// is planned and applied through (rehearse, diff, commit, drop).
// ---------------------------------------------------------------------------
export { rehearse, diff, commit, drop } from '../../migrations/index.js';
