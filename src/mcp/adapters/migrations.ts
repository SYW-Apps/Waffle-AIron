// ---------------------------------------------------------------------------
// mcp_migration_adapter — sdd_mcp's client hop into sdd_migrations: identity
// re-exports of the migration portal. The member tools plan, apply and discard
// family migrations through it (stage 6 wave B), and the pending-transaction
// banner of sdd_get_status and sdd_validate_tree asks it for unfinished
// transactions — with fix false only: recovery itself is `wairon doctor --fix`'s.
// ---------------------------------------------------------------------------
export { plan, apply, discard, recover } from '../../migrations/index.js';
