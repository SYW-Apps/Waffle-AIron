// ---------------------------------------------------------------------------
// host_upgrade_adapter — sdd_host's client hop into sdd_upgrade: identity
// re-exports of the upgrade portal. standing reads where a hosted project's
// tree stands against the running major; plan and apply bring its family to it
// all or nothing. The caller must gate on reach itself.
// ---------------------------------------------------------------------------
export { standing, plan, apply } from '../../upgrade/index.js';
export type { TreeStanding, TreeUpgradeReport, UpgradePlan } from '../../upgrade/index.js';
