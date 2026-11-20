import { runWithProjectRoot } from '../utils/fs.js';
import { WAIRON_VERSION } from '../config/defaults.js';

import type { LockRecord } from '../core/lockfile.js';
import type { StateId } from '../core/statehash.js';
import type { ValidationResult } from '../core/validation.js';
import type { ProjectConfig } from '../models/project.js';
import type { ExternalPin } from '../models/specs.js';
import { designOnly, type ApproverIdentity, type CodeAnalysis, type InputDebt, type ProjectApproval } from '../models/lock.js';
import { effectiveProjectId } from '../models/project.js';
import { existingProjectRoot, projectRepositoryScope } from './projects.js';
import * as hostCore from './adapters/core.js';
import * as hostGit from './adapters/git.js';
import { validateAsComplete, computeApprovalId, familyApprovals, resolvedPacks } from './adapters/validator.js';
import { pinExternals, recordPacks } from './adapters/surfaces.js';
import type { HostConfig, RepositoryScope } from './types.js';
import { LockValidationError } from './errors.js';

// ---------------------------------------------------------------------------
// Hosted Lock (sdd_host)
//
// The hosted lock workflow behind every authorized caller: refresh a project's
// owed build inputs, capture and confirm its approval identity, validate its
// design half, write the format-4 lock record and publish the project's own
// .wai/ pathspec through its family repository. Also the read-only pre-checks a
// lock request is made with. Pre-authorized throughout: the admin
// orchestrator's direct lock and the project lifecycle's approved requests
// authorize the caller first; nothing here authenticates. Never exposed on any
// portal. Writes the bound project's .wai/lock.json and .wai/inputs.lock.yaml,
// never anything below it.
// ---------------------------------------------------------------------------

/**
 * Thrown when a hosted lock refuses before writing anything for a reason other
 * than design errors: the design moved after the lock was requested, an input
 * moved while the lock ran, or composition.requireApprovedMembers found a
 * direct member not approved. Nothing is written in any of these cases.
 */
export class LockRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockRefusedError';
  }
}

/**
 * The refusal of a lock requested about a design that has since moved. It
 * carries both identities, so the approval workflow can cancel the request
 * with the reason; its name stays LockRefusedError, which the portals map.
 */
export class RequestedDesignMovedError extends LockRefusedError {
  constructor(readonly requested: string, readonly now: string) {
    super(`The design changed since the lock was requested (requested ${requested}, now ${now}); `
      + 'request the lock again. Nothing was written.');
  }
}

/**
 * hosted_lock_outcome — what a hosted lock answers: the persisted record, the outcome of each pin the
 * lock took of an owed external (a refused one included) and the input debts that remain after it.
 * Inputs never block the approval; the debts are reported beside it.
 */
export interface HostedLockOutcome {
  /** The persisted format-4 record, with commitSha and compareUrl when the lock was published. */
  record: LockRecord;
  /** One outcome per owed git or hosted external the lock tried to pin; empty when none was owed. */
  pins: ExternalPin[];
  /** The build input debts that remain after the lock; empty when none. */
  debts: InputDebt[];
}

/** An approval identity rendered the way requests store it. */
function renderIdentity(stateId: StateId): string {
  return `${stateId.algorithm}:${stateId.digest}`;
}

/**
 * The root a lifecycle action concerns: the record's own root — a member
 * record's derived from its parent's root and memberPath (a member is a record
 * of its own, so no qualifier exists).
 */
function boundLifecycleRoot(cfg: HostConfig, projectId: string): string {
  const root = existingProjectRoot(cfg.dataDir, projectId);
  if (!root) throw new Error(`Unknown project "${projectId}".`);
  return root;
}

/** The record's repository scope: its family root's repository root and its own .wai/ pathspec. */
function repositoryScopeOf(cfg: HostConfig, projectId: string): RepositoryScope {
  const scope = projectRepositoryScope(cfg.dataDir, projectId);
  if (!scope) throw new Error(`Unknown project "${projectId}".`);
  return scope;
}

/**
 * hosted_lock.execute — lock the project's OWN record. The same flow as the
 * local `wairon lock`: the owed build inputs are refreshed first; the approval
 * identity is CAPTURED before validation; an `expected` identity (an approval
 * request's approvalId) must equal it; only the DESIGN half of the as-complete
 * run may refuse (code findings are recorded beside the claim as `code`);
 * composition.requireApprovedMembers refuses while a direct member is drifted
 * or never approved; the identity is re-confirmed before the record is
 * written; and the record is format 4 (no members). Git goes through the
 * project's family repository: sync at the family root's repository root, and
 * publish ONLY the project's own .wai/ pathspec there. Nothing is written below
 * the bound project.
 */
export function execute(
  cfg: HostConfig,
  projectId: string,
  approver: ApproverIdentity,
  expected?: string,
): HostedLockOutcome {
  // Step 1: the family repository scope, and the project's own root to bind.
  const scope = repositoryScopeOf(cfg, projectId);
  const root = boundLifecycleRoot(cfg, projectId);
  return runWithProjectRoot(root, () => {
    // Step 2: git-backed — pull the default branch into the working branch at
    // the family repository root first, so the lock (and PR) is based on the
    // latest. No-op for a native family.
    runWithProjectRoot(scope.repositoryRoot, () => hostGit.sync());
    // Step 3: the own entry's input debts and the direct members' own states.
    const approvals = familyApprovals(1);
    const own = approvals.find((a) => a.key === '');
    const members = approvals.filter((a) => a.parent === '');
    // Step 4: refresh what the build owes BEFORE anything is judged.
    const owed = (own?.inputs ?? []).filter((d) => d.kind === 'unpinned' || d.kind === 'unrecorded').map((d) => d.subject);
    const pins = refreshInputs([...new Set(owed)]);
    // Step 5: capture what the record will certify before anything is judged.
    const captured = computeApprovalId();
    // Steps 6-7.
    refuseUnrequestedDesign(captured, expected);
    // Step 8.
    const gate = validateAsComplete();
    // Steps 9-10: the design half, or a refusal naming its errors.
    const design = refuseDesignErrors(gate);
    // Step 11.
    const config = hostCore.loadProjectConfig();
    // Steps 12-13.
    refuseUnapprovedMembers(config?.composition?.requireApprovedMembers === true, members);
    // Step 14.
    const specs = hostCore.captureApprovedSpecs();
    // Steps 15-17: did the design or its policy move while the lock ran?
    refuseMovedInputs(captured, computeApprovalId());
    // Step 18.
    const record = lockRecordOf(captured, approver, design, gate, config, specs);
    // Step 19: write the record BEFORE publishing, so the commit that ships the
    // specs also contains the approval that certifies them.
    hostCore.writeLockRecord(record);
    // Steps 20-25: the published record, the pin outcomes and the input debts that remain.
    return { record: publishLock(record, scope), pins, debts: remainingDebts() };
  });
}

/** The input debts of the bound project's own entry after the lock. */
function remainingDebts(): InputDebt[] {
  return familyApprovals(0).find((a) => a.key === '')?.inputs ?? [];
}

/**
 * hosted_lock.identity — the approval identity (own design plus own policy) a
 * lock of this project's own record would certify NOW, rendered
 * `<algorithm>:<digest>`. Read-only: no sync, no validation, no write.
 */
export function identity(cfg: HostConfig, projectId: string): string {
  // Step 1: the project's own root.
  const root = boundLifecycleRoot(cfg, projectId);
  // Steps 2-3.
  return runWithProjectRoot(root, () => renderIdentity(computeApprovalId()));
}

/**
 * hosted_lock.assertApprovable — validate the tree of this project's own record
 * the way an approved lock would (as-complete, the design half) and refuse with
 * a LockValidationError naming the error count and each error's code. Warnings
 * and notices never refuse. Read-only: no sync, no lock record, no write.
 */
export function assertApprovable(cfg: HostConfig, projectId: string): void {
  // Step 1.
  const root = boundLifecycleRoot(cfg, projectId);
  runWithProjectRoot(root, () => {
    // Steps 2-6.
    refuseDesignErrors(validateAsComplete());
  });
}

/**
 * hosted_lock.refreshInputs — refresh the bound project's owed build inputs
 * before a hosted lock judges it: pin the owed aliases from their producers'
 * approved states (every other pin stays as it is) and record the selected packs
 * as they resolve. A refused pin keeps its previous pin and comes back as an
 * outcome: inputs never block the approval. The caller has bound the root.
 */
export function refreshInputs(owed: string[]): ExternalPin[] {
  // Steps 1-2: pin exactly the owed aliases.
  const pins = owed.length > 0 ? pinExternals(owed) : [];
  // Step 3: the selected packs as they load now.
  const packs = resolvedPacks();
  // Step 4: recorded (a no-op when the section already says exactly this).
  recordPacks(packs);
  // Step 5.
  return pins;
}

/** Refuse, writing nothing, when the lock was requested about a different design. */
function refuseUnrequestedDesign(captured: StateId, expected: string | undefined): void {
  if (expected === undefined || renderIdentity(captured) === expected) return;
  // Approving now would certify a design nobody asked to have approved.
  throw new RequestedDesignMovedError(expected, renderIdentity(captured));
}

/** The design half of the as-complete run, or a refusal naming its errors. */
function refuseDesignErrors(gate: ValidationResult): ValidationResult {
  const design = designOnly(gate);
  const errors = design.issues.filter((i) => i.severity === 'error');
  if (errors.length) {
    throw new LockValidationError(errors.map((e) => ({ code: e.code, message: e.message, specId: e.specId })));
  }
  return design;
}

/** composition.requireApprovedMembers: refuse, naming each direct member not approved. */
function refuseUnapprovedMembers(required: boolean, members: ProjectApproval[]): void {
  // A PROJECT member only: a part's approval is this lock.
  const unapproved = members.filter((m) => m.as !== 'part' && m.state !== 'approved');
  if (!required || unapproved.length === 0) return;
  const named = unapproved.map((m) => `${m.alias ?? m.key} (${m.state})`);
  throw new LockRefusedError(
    `composition.requireApprovedMembers: direct member(s) not approved — ${named.join(', ')}. `
      + 'Lock each at its own root first; a parent never approves below itself. Nothing was written.',
  );
}

/** Refuse, writing nothing, when the approval identity moved between capture and write. */
function refuseMovedInputs(captured: StateId, now: StateId): void {
  if (now.algorithm === captured.algorithm && now.digest === captured.digest) return;
  throw new LockRefusedError(
    'The design changed while the lock ran — a spec or the project\'s policy (rule tuning, the composition block, '
      + 'the network declaration, pack selections) moved between the validation and the write. Nothing was written; run the lock again.',
  );
}

/** A format-4 record at the captured identity: the five parts and the code results beside the claim, no members. */
function lockRecordOf(
  captured: StateId,
  approver: ApproverIdentity,
  design: ValidationResult,
  gate: ValidationResult,
  config: ProjectConfig | null,
  specs: LockRecord['specs'],
): LockRecord {
  const count = (severity: string): number => design.issues.filter((i) => i.severity === severity).length;
  // The bound tree's effective id, so a later id change is caught (PROJECT_ID_CHANGED).
  const projectId = config ? effectiveProjectId(config) : null;
  return {
    format: 4,
    stateId: { algorithm: captured.algorithm, digest: captured.digest },
    lockedAt: new Date().toISOString(),
    lockedBy: approver,
    validatorVersion: WAIRON_VERSION,
    validationResult: { valid: design.valid, errors: count('error'), warnings: count('warning'), notices: count('notice') },
    status: 'ready',
    ...(projectId !== null ? { projectId } : {}),
    specs,
    // Each half of the certified identity on its own, exactly as the local
    // lock records them: what lets a later check name the one that moved.
    parts: captured.parts ?? {},
    ...(gate.analysis ? { code: withoutCodes(gate.analysis) } : {}),
  };
}

/** The analysis as a lock records it: its codes list is noise the analyzer identity already pins. */
function withoutCodes(analysis: CodeAnalysis): CodeAnalysis {
  const { codes: _codes, ...rest } = analysis;
  return rest;
}

/**
 * Git-backed: the lock is the semantic checkpoint — commit ONLY the project's
 * own .wai/ pathspec at the family repository root with a message referencing
 * the certified identity, and push. No-op for a native family or a clean
 * pathspec. Only a real publish has a commit to record: the two published
 * fields are known only AFTER the commit, so they are re-written into a record
 * the commit already carries.
 */
function publishLock(record: LockRecord, scope: RepositoryScope): LockRecord {
  const message = `wairon lock: ${record.projectId ?? 'project'} @ ${renderIdentity(record.stateId)}`;
  const publish = runWithProjectRoot(scope.repositoryRoot, () => hostGit.publish(message, scope.pathspecs));
  if (!publish.published) return record;
  const published: LockRecord = { ...record, commitSha: publish.commitSha, compareUrl: publish.compareUrl };
  hostCore.writeLockRecord(published);
  return published;
}
