// ---------------------------------------------------------------------------
// host_migration_adapter — sdd_host's client hop into sdd_migrations: identity
// re-export of the migration portal's recover. The data plane rolls back a
// family migration a crash left unfinished under a hosted project's roots when
// it next binds that project, before any tool touches the tree. The caller
// must gate on reach itself.
// ---------------------------------------------------------------------------
export { recover } from '../../migrations/index.js';
