import * as files from './files.js';
import * as core from '../../adapters/core.js';
import * as migrations from '../../adapters/migrations.js';
import { getProjectRoot, runWithProjectRoot } from '../../../utils/fs.js';
import { StepRefused } from '../../types.js';
import type { StepPlan, UpgradeChange, UpgradeStep } from '../../types.js';

// ---------------------------------------------------------------------------
// v5_to_v6_tree_step — one step of the upgrade chain: v5 forms to v6 forms,
// for one project at a time, planned and written onto the root the orchestrator
// bound (a rehearsal copy, never a live tree).
//
// The lock is re-expressed before any spec moves, so the tree it is compared
// with is the tree it approved — the order `wairon doctor --fix` used. The
// chaining migration plans from the bound root over everything below it, so the
// family top's write moves the whole family and a member's plan finds it done.
// Its own transaction copies and commits within the upgrade's rehearsal: the
// bound root is the rehearsal's, so nothing live is ever written.
//
// All v5-only knowledge lives in this folder, so deleting the step is deleting
// the folder.
// ---------------------------------------------------------------------------

const STEP: UpgradeStep = { from: 5, to: 6 };

/** The description the plan gives the folder move; write recognizes it by this text. */
const FOLDER_MOVE = 'move the .wairon folder to .wai';

/** iv5_to_v6_tree_step.familyRoots — the project roots of the family under a root as v5 declared it, the top first. */
export function familyRoots(root: string): string[] {
  // Steps 1-2.
  return files.familyRoots(root);
}

/** The lock record carried into the current format, or null when there is none or the tree cannot be judged yet. */
function carriedRecord(): ReturnType<typeof core.reexpressApproval> {
  try {
    return core.reexpressApproval(core.computeGateStateId());
  } catch {
    return null;
  }
}

/** iv5_to_v6_tree_step.plan — what moving the project at the bound root from v5 to v6 rewrites, without writing anything. */
export function plan(root: string): StepPlan {
  return runWithProjectRoot(root, () => {
    // Step 1: an empty plan of step 5 to 6 for the root.
    const changes: UpgradeChange[] = [];
    const reported: string[] = [];
    // Steps 2-3: the legacy folder is a file move, not a design change.
    if (files.holdsLegacyFolder(root)) changes.push({ description: FOLDER_MOVE, design: false });
    // Steps 4-6: the lock record re-expressed in the current format.
    if (carriedRecord()) changes.push({ description: 'lock.json: re-express the approval in the current reading (who approved it, and when, are kept)', design: false });
    // Steps 7-8: the legacy spec file names.
    for (const legacy of core.findLegacySpecFiles()) {
      changes.push({ description: `rename ${legacy.path} to ${legacy.expected}`, design: false });
    }
    // Steps 9-10: the project.yaml a chained subproject with specs lacks.
    for (const missing of core.findChainingSubprojectsMissingConfig(getProjectRoot())) {
      changes.push({ description: `write the project.yaml of ${missing}`, design: false });
    }
    // Steps 11-14: the chaining migration, planned and not rehearsed.
    const chaining = migrations.plan({ verb: 'chaining', rehearse: false });
    if (chaining.refusals.length > 0) {
      throw new StepRefused(`the chaining migration is blocked: ${chaining.refusals.map((r) => r.detail).join('; ')}`);
    }
    for (const edit of chaining.edits) {
      changes.push({ ...(edit.reference ? { spec: edit.reference.specId } : {}), description: `${edit.kind}: ${edit.detail}`, design: true });
    }
    for (const finding of chaining.chaining?.findings ?? []) {
      reported.push(`${finding.kind} [${finding.project === '' ? 'top root' : finding.project}]: ${finding.detail}`);
    }
    // Steps 15-16: the Specialists, retired as Orchestrators.
    const retirement = core.retireSpecialists(false);
    for (const retype of retirement.retyped) {
      changes.push({ spec: retype.component, description: `${retype.component}: Specialist becomes Orchestrator${retype.dependencyClass ? ` (${retype.dependencyClass})` : ''}`, design: true });
    }
    for (const variant of retirement.rebasedVariants) {
      changes.push({ spec: variant, description: `${variant}: variant rebased from Specialist to Orchestrator`, design: true });
    }
    // Steps 17-18: the reachability model.
    const reach = core.migrateReachability(false);
    for (const rewrite of reach.rewrites) {
      changes.push({ spec: rewrite.specId, description: `${rewrite.specId}: ${rewrite.to}`, design: true });
    }
    for (const left of reach.reported) {
      reported.push(`${left.specId}: ${left.to} — ${left.reason}`);
    }
    // Step 19.
    return { step: { ...STEP }, project: root, changes, reported };
  });
}

/** iv5_to_v6_tree_step.write — write a step plan onto the bound root (a rehearsal copy, never a live tree). */
export function write(plan: StepPlan): void {
  const root = getProjectRoot();
  // Steps 1-2.
  if (plan.changes.some((c) => c.description === FOLDER_MOVE)) files.moveLegacyFolder(root);
  // Steps 3-6: the approval carried before any spec moves.
  const record = carriedRecord();
  if (record) core.writeLockRecord(record);
  // Steps 7-9.
  for (const legacy of core.findLegacySpecFiles()) files.renameSpecFile(legacy.path, legacy.expected);
  // Step 10.
  core.backfillChainedSubprojectConfigs(root);
  // Steps 11-15: the chaining migration, rehearsed within the upgrade's own rehearsal.
  const chaining = migrations.plan({ verb: 'chaining' });
  if (chaining.refusals.length > 0) {
    throw new StepRefused(`the chaining migration is refused: ${chaining.refusals.map((r) => r.detail).join('; ')}`);
  }
  if (chaining.changes.length > 0) {
    const report = migrations.apply(chaining);
    if (!report.applied) {
      throw new StepRefused(`the chaining migration did not commit: ${report.outcome?.failure ?? 'unknown failure'}`);
    }
  }
  // Steps 16-17.
  core.retireSpecialists(true);
  core.migrateReachability(true);
}

/** iv5_to_v6_tree_step.whatChanged — the short, user-facing account of what moving to v6 changes for a project. */
export function whatChanged(): string[] {
  // Step 1.
  return [
    'Specialist and Gateway are gone: an Orchestrator with a dependencyClass, a Portal with the gateway variant.',
    'Reachability is entries and calls: portalType, listener mounts and the old invokedBy kinds are gone.',
    'Members replace L1 mounts, and alias::name replaces the leading ::, super:: and member paths.',
    'The deprecated flags and commands of v5 are removed; docs/cli.md lists the current ones.',
  ];
}

// Test seam: the text of the folder-move change.
export { FOLDER_MOVE };
