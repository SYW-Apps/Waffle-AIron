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
  localApprover,
  writeLockRecord,
  specPathsInScope,
  loadSystemSpec,
  readLockState,
  readLockRecord,
  loadProjectConfig,
  projectFamily,
  type LockRecord,
  type MemberPin,
  type StateId,
} from '../core/index.js';
import { effectiveProjectId } from '../models/project.js';
// The approver's own projection, taken from the models rather than from the
// core barrel: rendering a name is the value object's behaviour, not a Portal
// method, and it travels with the type.
import { describeApprover } from '../models/lock.js';
import { getProjectRoot } from '../utils/fs.js';
import { WaironError } from '../utils/errors.js';
import { computeGateStateId, familyApprovals, type ValidationResult } from '../core/validation.js';
import { designOnly, memberPinOf, type CodeAnalysis, type ProjectApproval } from '../models/lock.js';

// ---------------------------------------------------------------------------
// cli_lock_adapter — the core-side half of `wairon lock` (lockTree, realized
// by runLock): summarize what CHANGED since the last approval and each direct
// member's approval state, honour composition.requireApprovedMembers, confirm
// with the human (skipped under --yes), re-confirm the gate identity the
// caller captured before validating, and record the approval. It writes ONE
// file — this project's .wai/lock.json — and nothing into the spec tree or
// below this project: a member's approval is that member's own lock.
//
// Callers capture the gate identity and gate on the DESIGN half of an
// as-complete validation FIRST — the runner does both through the validator
// adapter before this adapter is ever reached. Code-conformance findings are
// recorded beside the claim (`code`) and never refuse the lock.
// ---------------------------------------------------------------------------

export interface LockOptions {
  /** Skip the interactive confirmation (for scripts / CI). */
  yes?: boolean;
  /** Limit lock scope to a specific subsystem. */
  subsystem?: string;
  /**
   * Accepted for one release and ignored for what is written: a lock approves
   * this project only and never writes below it. Each member locks at its own
   * root.
   */
  recursive?: boolean;
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

  // Step 6: every member PROJECT's own approval, at every depth (a part's
  // approval is its declaring project's, so parts are left out). The gate
  // identity reads each member's RECORDED approval, never its tree, so a
  // member's unapproved edits are invisible to it — this read is what keeps
  // the merge gate from going green over them.
  const members = familyApprovals().filter((a) => a.key !== '' && a.as !== 'part');
  const drifted = members.filter((a) => a.state === 'drifted');
  const never = members.filter((a) => a.state === 'never');

  // Steps 7-9: a member with unapproved changes refuses at every strictness.
  if (drifted.length > 0) {
    const where = memberFolders();
    const own = lock.state === 'locked'
      ? 'This project\'s own approval still covers its design.'
      : lock.state === 'stale'
        ? 'This project\'s own approval is stale too — run `wairon lock` here afterwards.'
        : 'This project itself has no approval on record.';
    return {
      state: lock.state === 'unlocked' ? 'unlocked' : 'stale',
      approved: false,
      message: `Member project(s) carry spec changes nobody approved: ${drifted.map((m) => describeMemberAt(m, where)).join('; ')}. `
        + 'Nothing says a human has seen what is about to merge in them. '
        + `Fix: run \`wairon lock\` in each member's own folder and commit its .wai/lock.json. ${own}`,
    };
  }

  // A stale verdict that is only the v6 gate-identity upgrade still refuses —
  // the old identity cannot be recomputed, so nothing proves the design
  // unchanged — but it says so plainly, with whether any own spec file moved.
  // (LockStatus.upgraded: stale, and the record's algorithm is not the current one.)
  if (lock.state === 'stale' && record!.stateId.algorithm !== lock.current.algorithm) return upgradedCheck(record!);

  switch (lock.state) {
    case 'locked': {
      // Steps 11-12: --strict asks for an approved family; a member never
      // approved by anyone fails it.
      if (strict && never.length > 0) {
        const where = memberFolders();
        return {
          state: 'locked',
          approved: false,
          message: `This project's own design is approved, but --strict asks for an approved family and member project(s) were never approved by anyone: ${never.map((m) => describeMemberAt(m, where)).join('; ')}. `
            + 'Fix: run `wairon lock` in each member\'s own folder and commit its .wai/lock.json.',
        };
      }
      // Step 13: pass, and never call a never-approved member approved.
      const approvedMembers = members.length - never.length;
      const family = members.length === 0
        ? ''
        : ` ${approvedMembers} member project(s) approved at their own roots.`
          + (never.length > 0
            ? ` NOT gated: ${never.map((m) => m.alias ?? m.key).join(', ')} — never approved by anyone (\`--strict\` fails here).`
            : '');
      return {
        state: 'locked',
        approved: true,
        message: (never.length > 0 ? 'This project\'s own design is the approved design — ' : 'The design in this tree is the approved design — ')
          + `approved ${record!.lockedAt} by ${describeApprover(record!.lockedBy)}.${family}`,
      };
    }
    case 'stale': {
      // Steps 17-19: only member approvals moved — expected; the pin is what is stale.
      const repinned = repinOnly(record!);
      if (repinned) {
        return {
          state: 'stale',
          approved: false,
          message: `Member project(s) were re-approved at their own roots since this project's approval was taken: ${repinned.join(', ')}. `
            + 'That is how a member\'s approval is meant to move — its own approver signed its new design off — so the member is not in question. '
            + 'What is stale is this project\'s pin of it: the approval on record '
            + `(${record!.lockedAt} by ${describeApprover(record!.lockedBy)}) still names the member's earlier approval, `
            + 'so it does not cover the member design about to merge. No own spec file changed. '
            + 'Fix: run `wairon lock` here to pin the member(s)\' new approval (the same lock records anything else the gate identity covers that moved alongside), and commit the updated .wai/lock.json.',
        };
      }
      return {
        state: 'stale',
        approved: false,
        message: 'The design, or something it was approved under, changed after it was approved '
          + `(the approval on record is ${record!.lockedAt} by ${describeApprover(record!.lockedBy)}). `
          + `${whatMoved(record!)} `
          + 'Nothing says a human has seen what is about to merge. '
          + 'Fix: run `wairon lock` on this branch and commit the updated .wai/lock.json.',
      };
    }
    default:
      return {
        state: 'unlocked',
        approved: !strict,
        message: strict
          ? 'No approval on record (.wai/lock.json is absent), and --strict asks for one. '
            + 'Run `wairon lock` and commit the record.'
          : 'No approval on record (.wai/lock.json is absent), so nothing is gated: plain `wairon lock-check` '
            + 'fails only a committed approval that no longer matches the design, and a project with no '
            + '.wai/lock.json — never locked, or the record deleted — reads the same. CI should run '
            + '`wairon lock-check --strict`, which fails here. Run `wairon lock` and commit the record to approve the design.',
      };
  }
}

/** Where each member project lives, keyed as familyApprovals keys it (namespace for a contained member, alias for a referenced one). */
function memberFolders(): Map<string, string> {
  const folders = new Map<string, string>();
  try {
    const family = projectFamily();
    for (const node of family.nodes) if (node.namespace !== '') folders.set(node.namespace, node.directory);
    for (const external of family.nodes.find((n) => n.namespace === '')?.externals ?? []) {
      if (external.role === 'member' && external.directory) folders.set(external.alias, external.directory);
    }
  } catch { /* a graph that cannot be read names no folders */ }
  return folders;
}

/** A member as a verdict names it: alias, state and the folder (relative to the cwd) to lock in. */
function describeMemberAt(member: ProjectApproval, folders: Map<string, string>): string {
  const dir = folders.get(member.key);
  const shown = dir ? (path.relative(process.cwd(), dir) || '.') : undefined;
  const state = member.state === 'drifted'
    ? (member.upgraded ? 'approved under an earlier gate identity — re-lock it once' : 'changed since its own approval')
    : 'never approved';
  return `${member.alias ?? member.key} (${state}${shown ? `, in ${shown}` : ''})`;
}

/**
 * Steps 16-18: the aliases of the direct members whose approval moved, when
 * that is ALL that moved — no own spec file changed, no direct member was
 * added or removed, and each moved member is approved at its own root. Null
 * otherwise (including a record that predates per-spec digests, where which
 * spec moved cannot be said).
 */
function repinOnly(record: LockRecord): string[] | null {
  const diff = diffAgainstApproval();
  if (!diff || diffSize(diff) > 0) return null;
  const direct = familyApprovals(1).filter((a) => a.parent === '');
  const members = direct.filter((a) => a.as !== 'part');
  // A part is a member too (the lock records its pin): never call it removed.
  const current = new Set(direct.map((m) => m.alias ?? m.key));
  if (Object.keys(record.members ?? {}).some((alias) => !current.has(alias))) return null;
  const moved: string[] = [];
  for (const m of members) {
    if (m.pinned === 'unpinned') return null;
    if (m.pinned !== 'moved') continue;
    if (m.state !== 'approved') return null;
    moved.push(m.alias ?? m.key);
  }
  return moved.length > 0 ? moved : null;
}

/**
 * What moved past a stale approval, named: how many own spec files changed, and
 * each direct project member whose approval moved since this one was taken (its
 * pin), that is no longer approved at its own root, or that was added or removed.
 * When none of those moved, what did is an input the gate identity covers beside
 * the specs — the doctrine, the declared inputs or `composition`.
 */
function whatMoved(record: LockRecord): string {
  const diff = diffAgainstApproval();
  const own = diff ? diffSize(diff) : null;
  const direct = familyApprovals(1).filter((a) => a.parent === '');
  const members = direct.filter((a) => a.as !== 'part');
  const named: string[] = [];
  for (const m of members) {
    const name = m.alias ?? m.key;
    if (m.pinned === 'unpinned') named.push(`${name} (added since the approval)`);
    else if (m.pinned === 'moved') named.push(`${name} (its approval moved since this one was taken${m.state === 'approved' ? '' : `; now ${m.state}`})`);
    else if (m.state !== 'approved') named.push(`${name} (${m.state} at its own root)`);
  }
  // A part is a member too (the lock records its pin): never call it removed.
  const current = new Set(direct.map((m) => m.alias ?? m.key));
  for (const alias of Object.keys(record.members ?? {})) {
    if (!current.has(alias)) named.push(`${alias} (removed since the approval)`);
  }
  const parts: string[] = [];
  if (own !== null && own > 0) parts.push(`${own} own spec file(s) changed since the approval`);
  if (named.length > 0) parts.push(`direct member(s): ${named.join(', ')}`);
  if (parts.length > 0) return `What moved: ${parts.join('; ')}.`;
  return own === null
    ? 'This approval predates per-spec digests, so which spec moved cannot be said.'
    : "No own spec file and no direct member's approval moved, so what changed is the doctrine, a declared input or `composition`.";
}

/** The gate-identity upgrade verdict: stale, said plainly, with the one remedy. */
function upgradedCheck(record: LockRecord): ApprovalCheck {
  const diff = diffAgainstApproval();
  const specs = !diff
    ? 'This approval predates per-spec digests, so whether a spec file moved since cannot be said.'
    : diffSize(diff) === 0
      ? 'No own spec file has changed since the approval.'
      : `${diffSize(diff)} own spec file(s) changed since the approval.`;
  return {
    state: 'stale',
    approved: false,
    message: `The approval on record (${record.lockedAt} by ${describeApprover(record.lockedBy)}) was taken under an `
      + `earlier gate identity (written by wairon ${record.validatorVersion}). Since wairon 6.0.0 the gate identity `
      + 'also covers members\' composition subjects and `composition`, and code conformance is recorded beside the claim. '
      + `${specs} Fix: re-lock once (\`wairon lock\`) and commit the updated .wai/lock.json.`,
  };
}

/**
 * Thrown when a lock refuses before writing anything. A WaironError, so the
 * CLI prints its message and exits non-zero like any other refusal.
 */
class LockRefusedError extends WaironError {
  constructor(message: string) {
    super(message);
    this.name = 'LockRefusedError';
  }
}

/** A direct member that is not approved at its own root, named with its state. */
function describeMemberState(entry: ProjectApproval): string {
  return `${entry.alias ?? entry.key} (${entry.state}${entry.upgraded ? ' — approved under an earlier gate identity, re-lock it once' : ''})`;
}

/** The code line a lock prints beside its claim. */
function codeLine(code: CodeAnalysis | undefined): string {
  if (!code) return 'code: no code analysis recorded';
  return `code: ${code.errors} error(s), ${code.warnings} warning(s) recorded beside the claim `
    + `(analyzer ${code.analyzer.validatorVersion}, grade ${code.analyzer.grade}) — CI enforces them, not the lock`;
}

/** Print what is being approved: the own spec diff, the code half, and each direct member. */
function summarize(gate: ValidationResult, members: ProjectApproval[]): void {
  // Against the previous approval, not against each spec's stored status: the
  // human is deciding about a CHANGE, and "3 specs moved since you last said
  // yes" is the question they can answer. A first approval has nothing to
  // compare with, and neither does a lock written before the per-spec record
  // existed — both say so rather than inventing a diff.
  const diff = diffAgainstApproval();
  if (!diff) {
    // No per-spec digests to compare with: either there is no record at all
    // (a true first approval), or the record predates per-spec digests (an
    // upgrade). Only the first is a "first approval" — saying so over an
    // existing record would tell the human nothing was approved before.
    const previous = readLockRecord();
    if (previous) {
      logger.info(`Replacing the approval on record (${previous.lockedAt} by ${describeApprover(previous.lockedBy)}, `
        + `wairon ${previous.validatorVersion ?? 'unknown'}). It records no per-spec digests, so the whole spec tree `
        + 'becomes the approved baseline.');
    } else {
      logger.info('First approval of this tree — the whole spec tree becomes the approved baseline.');
    }
  } else if (diffSize(diff) === 0) {
    logger.info('Nothing has changed since the last approval — this re-records the approval and refreshes the generated outputs of this project (guides, skills, and agent files when materialized).');
  } else {
    logger.info(`${diffSize(diff)} spec(s) changed since the last approval:`);
    for (const p of diff.changed) logger.info(`  ~ ${p}`);
    for (const p of diff.added) logger.info(`  + ${p}`);
    for (const p of diff.removed) logger.info(`  - ${p}`);
  }
  logger.info(codeLine(gate.analysis));
  // A member's own edits never show up in this project's spec diff: what this
  // project reviews is the member's APPROVAL — its state, and whether its pin moved.
  // A part's specs ARE in the diff above; a part stored elsewhere is
  // named with the commit being approved.
  for (const m of members) {
    if (m.as === 'part') {
      if (m.commit !== undefined) logger.info(`  part ${m.alias ?? m.key}: approved at commit ${m.commit}`);
      continue;
    }
    const pin = m.pinned === 'moved' ? ' — its pin moved since the last approval' : '';
    logger.info(`  member ${m.alias ?? m.key}: ${m.state}${m.upgraded ? ' (approved under an earlier gate identity, re-lock once)' : ''}${pin}`);
  }
}

/**
 * cli_lock_adapter.lockTree — record this project's approval: summarize,
 * honour composition.requireApprovedMembers, confirm with the human (skipped
 * under --yes), re-confirm the identity the caller captured BEFORE validating,
 * and write a format-2 record. Writes one file, this project's .wai/lock.json,
 * and never `children`, never anything in the spec tree or below the project.
 * Returns the written record, or null when the human declined.
 *
 * `gate` is the as-complete result the caller gated on (its design half is
 * counted as validationResult, its analysis recorded as `code`); `captured` is
 * the gate identity the caller took before validating — what the record
 * certifies.
 */
export async function runLock(options: LockOptions, gate: ValidationResult, captured: StateId): Promise<LockRecord | null> {
  // Steps 1-3: what is being approved, and each direct member at its own root.
  const members = familyApprovals(1).filter((a) => a.parent === '');
  summarize(gate, members);

  // Steps 4-6: the configuration, and a parent that requires approved members.
  const config = loadProjectConfig();
  // A PROJECT member only: a part has no approval of its own — this lock is its approval.
  const unapproved = members.filter((m) => m.as !== 'part' && m.state !== 'approved');
  if (config?.composition?.requireApprovedMembers && unapproved.length > 0) {
    throw new LockRefusedError(
      `composition.requireApprovedMembers: direct member(s) not approved — ${unapproved.map(describeMemberState).join(', ')}. `
        + 'Lock each at its own root first (`wairon lock` there); a parent never approves below itself. Nothing was written.',
    );
  }
  logger.blank();
  logger.warn('This records the current design as approved in .wai/lock.json (no spec file is rewritten) and refreshes the generated outputs of this project.');

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
        message: 'Approve this design?',
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
  // its own instead of staying marked complete.

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

  // --- Persist the commit-scoped lock record at the CAPTURED gate identity ---
  // The GATE identity from the validator portal, not the content one: the
  // record certifies "this design passed THIS gate under THESE inputs", so the
  // governing doctrine, the inputs, `composition` and the members' subjects
  // are part of what is recorded.
  //
  // `specs` is the approval itself: one digest per spec file, so `wairon status`
  // can name what moved instead of printing a banner, and validate can tell
  // settled specs from in-flux ones. It is recorded HERE rather than beside it
  // because the lock record is committed — which is what lets a teammate, a
  // fresh clone and CI all see the same approval the approver saw.
  // The project's effective id, recorded so a later id change is caught
  // (PROJECT_ID_CHANGED) rather than silently re-keying everything that keys on it.
  const projectId = config ? effectiveProjectId(config) : null;
  const specs = captureApprovedSpecs(root, scope);
  const lockedBy = localApprover();

  // Steps 11-13: did any input move while the lock ran — between the capture
  // before validation and now, the confirmation prompt included? Then the
  // validation the human saw does not describe what would be recorded.
  const now = computeGateStateId();
  if (now.algorithm !== captured.algorithm || now.digest !== captured.digest) {
    throw new LockRefusedError(
      'The lock\'s inputs changed while it ran — a spec, the doctrine, an input, the composition block or a '
        + 'member\'s approval moved between the validation and the write. Nothing was written; run `wairon lock` again.',
    );
  }

  // Step 14: a format-2 record. No `children`.
  const design = designOnly(gate);
  const count = (severity: string): number => design.issues.filter((i) => i.severity === severity).length;
  const record: LockRecord = {
    // The record format: 2 since wairon 6.0.0 (members, code, no children).
    format: 2,
    stateId: captured,
    lockedAt: new Date().toISOString(),
    lockedBy,
    validatorVersion: WAIRON_VERSION,
    validationResult: { valid: design.valid, errors: count('error'), warnings: count('warning'), notices: count('notice') },
    status: 'ready',
    ...(projectId !== null ? { projectId } : {}),
    specs,
    members: memberPins(members),
    ...(gate.analysis ? { code: withoutCodes(gate.analysis) } : {}),
  };
  // Step 15: the only file this lock writes.
  writeLockRecord(record);
  return record;
}

/** Each direct member's alias → a project member's {as: project, project, subject, state} or a part's {as: part, contentDigest, commit, state} as it stands now. */
function memberPins(members: ProjectApproval[]): Record<string, MemberPin> {
  const pins: Record<string, MemberPin> = {};
  for (const m of members) pins[m.alias ?? m.key] = memberPinOf(m);
  return pins;
}

/** The analysis as a lock records it: its codes list is noise the analyzer identity already pins. */
function withoutCodes(analysis: CodeAnalysis): CodeAnalysis {
  const { codes: _codes, ...rest } = analysis;
  return rest;
}
