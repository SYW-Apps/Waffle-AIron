import * as os from 'os';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { captureBaseline, writeBaseline } from '../core/baseline.js';
import { WAIRON_VERSION } from '../config/defaults.js';
import {
  collectPromotableSpecs,
  applySpecStatus,
  invalidateSpecCache,
  promoteAllComplete,
  computeGateStateId,
  writeLockRecord,
  type LockRecord,
} from '../core/index.js';
import type { ValidationResult } from '../core/validation.js';

// ---------------------------------------------------------------------------
// cli_lock_adapter — the core-side half of `wairon lock` (lockTree, realized
// by runLock): summarize what will freeze, confirm with the human (skipped
// under --yes), promote every in-scope spec to `complete` through the core
// barrel, and persist the commit-scoped lock record carrying the tree's
// current StateId.
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
  // --- Assemble the lock scope + summary of what will freeze ---
  const promotable = collectPromotableSpecs(options.subsystem);
  if (promotable.length === 0) {
    logger.info('All specs are already complete — this will re-validate and regenerate the agent topology.');
  } else {
    logger.info(`${promotable.length} spec(s) will be frozen as complete:`);
    for (const p of promotable) {
      logger.info(`  • ${p.kind.padEnd(14)} ${p.id}  (${p.status} → complete)`);
    }
  }
  logger.blank();
  logger.warn('This freezes the design as the source of truth and (re)generates the agent topology.');

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
        message: 'Lock these specs and generate the agent topology? This freezes the design.',
        default: false,
      },
    ]);
    if (!confirmed) return null;
  }

  // --- Freeze: promote every in-scope spec to complete ---
  if (options.subsystem) {
    // The core-wide freeze takes no scope parameter — a scoped lock promotes
    // exactly the collected in-scope specs instead.
    for (const p of promotable) applySpecStatus(p.kind, p.id, 'complete');
    invalidateSpecCache();
  } else {
    promoteAllComplete();
  }
  if (promotable.length > 0) {
    logger.success(`Locked ${promotable.length} spec(s) as complete.`);
  }

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
  writeBaseline(captureBaseline(lockedBy));
  return record;
}
