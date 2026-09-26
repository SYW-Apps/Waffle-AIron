import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { WAIRON_VERSION } from '../config/defaults.js';
import * as path from 'path';
import {
  // The approval surface, reached through core_portal rather than through
  // ../core/approval.js — sdd_cli does not import another subsystem's modules.
  captureApprovedSpecs,
  diffAgainstApproval,
  diffSize,
  currentChildPins,
  movedChildren,
  localApprover,
  writeLockRecord,
  specPathsInScope,
  loadSubsystemSpecs,
  loadSystemSpec,
  readLockState,
  loadProjectConfig,
  type LockRecord,
} from '../core/index.js';
import { effectiveProjectId } from '../models/project.js';
// The approver's own projection, taken from the models rather than from the
// core barrel: rendering a name is the value object's behaviour, not a Portal
// method, and it travels with the type.
import { describeApprover } from '../models/lock.js';
import { getProjectRoot } from '../utils/fs.js';
import { computeGateStateId, type ValidationResult } from '../core/validation.js';

// ---------------------------------------------------------------------------
// cli_lock_adapter — the core-side half of `wairon lock` (lockTree, realized
// by runLock): summarize what CHANGED since the last approval, confirm with
// the human (skipped under --yes), and record the current tree as approved.
// It writes nothing into the spec tree: the approval is one digest per spec
// inside the committed lock record, so the whole decision is a single file.
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

/** Flags of the `wairon lock-check` merge gate (cli_lock_adapter LockCheckOptions). */
export interface LockCheckOptions {
  /**
   * Treat a repository that was never approved — or that carries no spec tree
   * at all — as a failure rather than a notice. Off by default: that default
   * is the whole reason importing the gate cannot make an existing project's
   * CI start failing.
   */
  strict?: boolean;
}

/** The four things `wairon lock-check` can find. */
export type ApprovalState = 'no-tree' | 'unlocked' | 'locked' | 'stale';

/** The verdict `wairon lock-check` prints and exits on (cli_lock_adapter ApprovalCheck). */
export interface ApprovalCheck {
  state: ApprovalState;
  /** Whether the check passes. False exits non-zero. */
  approved: boolean;
  /** The verdict phrased for a CI log — and, when it refuses, the remedy. */
  message: string;
}

// ---------------------------------------------------------------------------
// cli_lock_adapter.checkApproval — the merge gate's verdict
//
// The question is narrow and worth stating: "is the design in this working
// tree the design a human approved?". It is NOT "is this design legal" —
// `wairon validate` answers that, and the two are independent: a tree can be
// approved and illegal (approved before a doctrine change), or legal and
// unapproved.
//
// It is decided from the GATE StateId, never from the per-spec content digests
// the same lock record carries. The two are kept deliberately (see
// approval.ts): the content digest answers "has this FILE changed since you
// approved it", the gate identity hashes the PARSED tree plus the governing
// doctrine and answers "has the DESIGN changed". A merge gate on the content
// digest would demand a re-lock after a whitespace-only edit, and a gate people
// learn to bypass is worse than no gate at all.
//
// Optional by construction. Only `stale` refuses at the default strictness, and
// `stale` is unreachable in a project that never locked — `readLockState`
// returns `unlocked` when there is no record, and `unlocked` passes. So a
// project that upgrades into a wairon carrying this command, or imports the
// reusable workflow without asking for `--strict`, cannot start failing on it.
// ---------------------------------------------------------------------------

export function checkApproval(strict: boolean): ApprovalCheck {
  // A repository with no spec tree must be TOLD so. Judged as "never approved"
  // it would fail every strict consumer that simply has no design yet, and the
  // message would send them looking for a lock record instead of a tree.
  if (!loadSystemSpec()) {
    return {
      state: 'no-tree',
      approved: !strict,
      message: strict
        ? 'No SDD spec tree here (.wai/specs) — and --strict asks for an approved design, so this is a failure. '
          + 'Run `wairon init` to start one, or drop --strict.'
        : 'No SDD spec tree here (.wai/specs) — there is no design to approve, so nothing is gated.',
    };
  }

  const lock = readLockState(computeGateStateId());
  const record = lock.record;

  switch (lock.state) {
    case 'locked':
      return {
        state: 'locked',
        approved: true,
        message: 'The design in this tree is the approved design — '
          + `approved ${record!.lockedAt} by ${describeApprover(record!.lockedBy)}.`,
      };
    case 'stale':
      return {
        state: 'stale',
        approved: false,
        message: 'The design changed after it was approved '
          + `(the approval on record is ${record!.lockedAt} by ${describeApprover(record!.lockedBy)}). `
          + 'Nothing says a human has seen what is about to merge. '
          + 'Fix: run `wairon lock` on this branch and commit the updated .wai/lock.json.',
      };
    default:
      return {
        state: 'unlocked',
        approved: !strict,
        message: strict
          ? 'No approval on record (.wai/lock.json is absent), and --strict asks for one. '
            + 'Run `wairon lock` and commit the record.'
          : 'No approval on record (.wai/lock.json is absent) — this project has not opted into the '
            + 'approval gate, so nothing is gated. Run `wairon lock` and commit the record to turn it '
            + 'on, or pass --strict to fail here instead.',
      };
  }
}

/**
 * cli_lock_adapter.lockTree — freeze the (scope-filtered) tree: record the
 * approval baseline (what was approved, held OUTSIDE the working copy) and
 * persist the commit-scoped lock record. Writes NOTHING into the spec tree.
 * Returns the written record, or null when the human declined the
 * confirmation (nothing was changed).
 *
 * `gate` is the as-complete validation result the caller already gated on;
 * its warning and notice counts are captured on the record (the hosted lock records the
 * same shape).
 */
export async function runLock(options: LockOptions = {}, gate?: ValidationResult): Promise<LockRecord | null> {
  // --- Summarize what is actually being approved ---
  // Against the previous approval, not against each spec's stored status: the
  // human is deciding about a CHANGE, and "3 specs moved since you last said
  // yes" is the question they can answer. A first approval has nothing to
  // compare with, and neither does a lock written before the per-spec record
  // existed — both say so rather than inventing a diff.
  const diff = diffAgainstApproval();
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
  // stop relaxing completeness findings. The lock record carries that fact now,
  // per spec, so an edit after approval returns that spec to draft context on
  // its own instead of staying frozen complete.

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

  // --- Persist the commit-scoped lock record at the tree's CURRENT StateId ---
  // The GATE identity from the validator portal, not the content one: the
  // record certifies "these specs passed THIS gate", so the governing doctrine
  // is part of what is frozen — change a pack afterwards and the lock goes
  // stale on its own.
  //
  // `specs` is the approval itself: one digest per spec file, so `wairon status`
  // can name what moved instead of printing a banner, and validate can tell
  // settled specs from in-flux ones. It is recorded HERE rather than beside it
  // because the lock record is committed — which is what lets a teammate, a
  // fresh clone and CI all see the same approval the approver saw.
  // The project's effective id, recorded so a later id change is caught
  // (PROJECT_ID_CHANGED) rather than silently re-keying everything that keys on it.
  const config = loadProjectConfig();
  const projectId = config ? effectiveProjectId(config) : null;
  const record: LockRecord = {
    stateId: computeGateStateId(),
    lockedAt: new Date().toISOString(),
    lockedBy: localApprover(),
    validatorVersion: WAIRON_VERSION,
    validationResult: {
      valid: true,
      errors: 0,
      warnings: gate ? gate.issues.filter((i) => i.severity === 'warning').length : 0,
      notices: gate ? gate.issues.filter((i) => i.severity === 'notice').length : 0,
    },
    status: 'ready',
    ...(projectId !== null ? { projectId } : {}),
    specs: captureApprovedSpecs(root, scope),
    children: currentChildPins(loadSubsystemSpecs(), root),
  };
  writeLockRecord(record);
  return record;
}
