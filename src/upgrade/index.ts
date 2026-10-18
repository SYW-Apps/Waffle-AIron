import * as orchestrator from './orchestrator.js';
import type { ReleaseNote, TreeStanding, TreeUpgradeReport, UpgradePlan } from './types.js';

// ---------------------------------------------------------------------------
// upgrade_portal — the published surface of sdd_upgrade, shared by the CLI
// (`wairon upgrade`, `wairon whatsnew`, the status and validate banners), the
// MCP server and the hosted server: where a tree stands, the plan that brings
// its family to the running major, that plan applied all or nothing, a plan
// discarded, and the release notes between two versions. Each export is one
// forward to the upgrade orchestrator; the portal performs no work itself. The
// caller must gate on reach itself.
// ---------------------------------------------------------------------------

export type { ReleaseNote, StepPlan, TreeStanding, TreeStandingState, TreeUpgradeReport, UpgradeChange, UpgradePlan, UpgradeStep } from './types.js';

/** iupgrade_portal.standing — where the project at the root stands against the running major. */
export function standing(root: string): TreeStanding {
  return orchestrator.standing(root);
}

/** iupgrade_portal.plan — plan the upgrade of the family under the root. */
export function plan(root: string): UpgradePlan {
  return orchestrator.plan(root);
}

/** iupgrade_portal.apply — commit a plan all or nothing. */
export function apply(plan: UpgradePlan): TreeUpgradeReport {
  return orchestrator.apply(plan);
}

/** iupgrade_portal.discard — drop a plan that will not be applied. */
export function discard(plan: UpgradePlan): void {
  orchestrator.discard(plan);
}

/** iupgrade_portal.releaseNotes — the notes after one version up to and including another, newest first. */
export function releaseNotes(after: string | null | undefined, upTo: string): ReleaseNote[] {
  return orchestrator.releaseNotes(after, upTo);
}
