// ---------------------------------------------------------------------------
// host_migration_adapter — sdd_host's client hop into sdd_migrations: identity
// re-exports of the migration portal. recover rolls back a family migration a
// crash left unfinished under a hosted project's roots when the data plane
// next binds it; rehearse, diff, commit and drop are the family transaction
// the hosted member upgrade commits the host stores through; plan serves the
// hosted detach. The caller must gate on reach itself.
// ---------------------------------------------------------------------------
export { recover, rehearse, diff, commit, drop, plan } from '../../migrations/index.js';
