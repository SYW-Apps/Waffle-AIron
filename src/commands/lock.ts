import * as os from 'os';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import {
  captureBaseline, writeBaseline, diffAgainstBaseline, diffSize, currentChildPins, movedChildren,
} from '../core/baseline.js';
import { WAIRON_VERSION } from '../config/defaults.js';
import * as path from 'path';
import {
  computeGateStateId,
  writeLockRecord,
  specPathsInScope,
  loadSubsystemSpecs,
  type LockRecord,
} from '../core/index.js';
import { getProjectRoot } from '../utils/fs.js';
import type { ValidationResult } from '../core/validation.js';

// ---------------------------------------------------------------------------
// cli_lock_adapter — the core-side half of `wairon lock` (lockTree, realized
// by runLock): summarize what CHANGED since the last approval, confirm with
// the human (skipped under --yes), and record the current tree as approved.
// It writes nothing into the spec tree — the approval lives in the baseline,
// outside the working copy.
//
// Callers gate on an as-complete validation FIRST — the runner routes the
// dry-run through the validator adapter's validateAsComplete before this
// adapter is ever reached. This adapter never locks an invalid tree on its
// own authority, and child-surface regeneration happens AFTER it (through the
// surfaces client adapter): the runner owns that workflow.
// ---------------------------------------------------------------------------

export interface LockOptions {
  /** Skip the interactive confirmation (for scripts / CI). */
  yes?: boolean;
  /** Limit lock scope to a specific subsystem. */
  subsystem?: string;
  /** Whether to recursively lock subprojects. */
  recursive?: boolean | number;
}

/**
 * cli_lock_adapter.lockTree — freeze the (scope-filtered) tree: promote every
 * in-scope spec to status `complete` and persist the commit-scoped lock
 * record. Returns the written record, or null when the human declined the
 * confirmation (nothing was changed).
 *
 * `gate` is the as-complete validation result the caller already gated on;
 * its warning count is captured on the record (the hosted lock records the
 * same shape).
 */
export async function runLock(options: LockOptions = {}, gate?: ValidationResult): Promise<LockRecord | null> {
  // --- Summarize what is actually being approved ---
  // Against the previous approval, not against each spec's stored status: the
  // human is deciding about a CHANGE, and "3 specs moved since you last said
  // yes" is the question they can answer. A first approval has no baseline to
  // compare with, so it reports the size of the tree instead.
  const diff = diffAgainstBaseline();
  if (!diff) {
    logger.info('First approval of this tree — the whole spec tree becomes the approved baseline.');
  } else if (diffSize(diff) === 0) {
    logger.info('Nothing has changed since the last approval — this will re-validate and regenerate the agent topology.');
  } else {
    logger.info(`${diffSize(diff)} spec(s) changed since the last approval:`);
    for (const p of diff.changed) logger.info(`  ~ ${p}`);
    for (const p of diff.added) logger.info(`  + ${p}`);
    for (const p of diff.removed) logger.info(`  - ${p}`);
  }
  // A chained child's own edits never show up in the parent's spec diff — the
  // trees are approved separately. What the parent reviews is the child MOVING:
  // its approval shifting away from the one this parent pinned.
  const moved = movedChildren(loadSubsystemSpecs());
  if (moved.length > 0) {
    logger.info(`${moved.length} chained child project(s) moved since the last approval:`);
    for (const m of moved) {
      logger.info(`  ${m.id}: ${m.pinned.slice(0, 19)}… → ${m.now ? `${m.now.slice(0, 19)}…` : '(no approval)'}`);
    }
  }

  logger.blank();
  logger.warn('This records the current design as approved and (re)generates the agent topology.');

  // --- Confirm (the "are you sure?" gate) ---
  if (!options.yes) {
    if (!process.stdin.isTTY) {
      logger.error('Non-interactive shell — re-run with --yes to confirm the lock.');
      process.exit(1);
    }
    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      {
        type: 'confirm',
        name: 'confirmed',
        message: 'Approve this design and generate the agent topology?',
        default: false,
      },
    ]);
    if (!confirmed) return null;
  }

  // Nothing is written into the spec tree. Approval used to ratchet every
  // spec's `status` to `complete` on disk — up to hundreds of rewritten files
  // for a decision that changed no design — so that later validate runs would
  // stop relaxing completeness findings. The baseline carries that fact now,
  // and derives it per spec, so an edit after approval returns that spec to
  // draft context on its own instead of staying frozen complete.

  // --- Persist the commit-scoped lock record at the tree's CURRENT StateId ---
  // Computed AFTER the freeze (like the hosted lock): the promotion is part of
  // the state the record certifies, and promotion re-checks against it.
  // The GATE identity, not the content one: the record certifies "these specs
  // passed THIS gate", so the governing doctrine is part of what is frozen —
  // change a pack afterwards and the lock goes stale on its own.
  let lockedBy = 'local';
  try {
    lockedBy = `local:${os.userInfo().username}`;
  } catch { /* keep 'local' */ }
  const record: LockRecord = {
    stateId: computeGateStateId(),
    lockedAt: new Date().toISOString(),
    lockedBy,
    validatorVersion: WAIRON_VERSION,
    validationResult: {
      valid: true,
      errors: 0,
      warnings: gate ? gate.issues.filter((i) => i.severity === 'warning').length : 0,
    },
    status: 'ready',
  };
  writeLockRecord(record);

  // Record WHAT was approved, not just that something was. The lock record
  // carries an identity, which can only ever answer "did anything move?"; the
  // baseline carries the tree, so `wairon status` can name the specs that
  // moved and a human can review a change instead of a banner.
  //
  // Written outside the working tree, so approving adds nothing to `git status`.
  // A scoped approval covers only its subsystem; everything else keeps the
  // approval it already had.
  const root = getProjectRoot();
  const scope = options.subsystem
    ? {
      paths: new Set(
        specPathsInScope(options.subsystem).map((p) => path.relative(root, p).split(path.sep).join('/')),
      ),
    }
    : undefined;
  writeBaseline(captureBaseline(lockedBy, currentChildPins(loadSubsystemSpecs(), root), root, scope));
  return record;
}
