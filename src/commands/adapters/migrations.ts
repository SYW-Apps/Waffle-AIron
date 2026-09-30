// ---------------------------------------------------------------------------
// cli_migration_adapter — sdd_cli's client hop into sdd_migrations: identity
// re-exports of the migration portal. `wairon doctor` plans, applies and
// recovers family migrations through it, the status and validate banners ask
// it for unfinished transactions, and the upgrade report reaches the
// positional match through it.
// ---------------------------------------------------------------------------
export { plan, apply, discard, recover, matchPositions } from '../../migrations/index.js';
