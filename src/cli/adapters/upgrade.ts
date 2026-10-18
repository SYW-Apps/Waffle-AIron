// ---------------------------------------------------------------------------
// cli_upgrade_adapter — sdd_cli's client hop into sdd_upgrade: identity
// re-exports of the upgrade portal. `wairon upgrade` plans and applies a
// family upgrade through it, `wairon whatsnew` and the release banner read the
// notes through it, and the guard in front of every project command asks it
// where the bound tree stands.
// ---------------------------------------------------------------------------
export { standing, plan, apply, discard, releaseNotes } from '../../upgrade/index.js';
