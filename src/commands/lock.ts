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
  findOrphanedSpecFiles,
  loadComponentSpecs,
  loadSubsystemSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  loadTypeSpecs,
  readLockState,
  readLockRecord,
  reexpress,
  loadProjectConfig,
  projectFamily,
  type LockRecord,
  type MemberPin,
  type StateId,
} from '../core/index.js';
import { effectiveProjectId, projectIdentity } from '../models/project.js';
import { getProjectRoot, pathExists } from '../utils/fs.js';
import { AI_PATHS } from '../config/paths.js';
import { WaironError } from '../utils/errors.js';
import { computeGateStateId, familyApprovals, unpinnedExternals, unrecordedExternalUses, type ValidationResult } from '../core/validation.js';
import { approvalStamp, describeGateParts, designOnly, movedGateParts, memberPinOf, type CodeAnalysis, type ProjectApproval, type ReleaseVerdict } from '../models/lock.js';
import { ownGet } from '../utils/own.js';
import { canonicalize } from '../utils/canonical-json.js';

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
  /** List every changed spec in the summary instead of summarizing a long list. */
  all?: boolean;
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
// It is decided from the GATE StateId, never from the per-spec digests the
// same lock record carries. The gate identity hashes the parsed own DESIGN
// (code linkage out since lock format 3) plus the governing doctrine and
// answers "has the DESIGN changed" — so neither a whitespace edit nor a
// sourcePath added after implementation ever fails it: conformance judges
// linkage, in `validate --ci`. A gate people learn to bypass is worse than no
// gate at all.
//
// A format-2 record (taken before code linkage left the approval) is judged
// under its own algorithm (StateId.asRecorded), so an upgrade never fails this
// gate on an unchanged design.
//
// Optional by construction. Only `stale` refuses at the default strictness, and
// `stale` is unreachable in a project that never locked — `readLockState`
// returns `unlocked` when there is no record, and `unlocked` passes. So a
// project that upgrades into a wairon carrying this command, or imports the
// reusable workflow without asking for `--strict`, cannot start failing on it.
// ---------------------------------------------------------------------------

/**
 * cli_lock_adapter.treeVerdict — the verdict on a project whose specs folder
 * holds no L0, or null when it holds one. A repository with no spec tree must
 * be TOLD so: judged as "never approved" it would fail every strict consumer
 * that simply has no design yet. But a specs folder whose L0 was deleted
 * while spec files remain is no "no tree": its design is still there,
 * unjudged, and passing it would turn a bad merge into a green gate — refused
 * at every strictness.
 */
export function treeVerdict(strict: boolean): ApprovalCheck | null {
  // Steps 1-2.
  if (loadSystemSpec()) return null;
  // Steps 3-5: a missing L0, or one that is there but cannot be read (empty,
  // null, not YAML, failing its schema) — a broken root is never "no tree".
  const orphaned = findOrphanedSpecFiles();
  const unreadable = pathExists(AI_PATHS.specsSystem());
  if (orphaned.length > 0 || unreadable) {
    const what = unreadable
      ? 'is there but cannot be read as an L0 (empty, null, not YAML, or failing its schema — `wairon validate` names why)'
      : 'is missing';
    const below = orphaned.length > 0
      ? `, but ${orphaned.length} spec file(s) remain below it (${orphaned.slice(0, 3).join(', ')}${orphaned.length > 3 ? ', …' : ''}): the design is still there and cannot be judged`
      : ': the design cannot be judged';
    return {
      state: 'unlocked',
      approved: false,
      message: `The L0 System spec (.wai/specs/.index.yaml) ${what}${below}, so it is not approved. `
        + 'Fix: restore it from version control (`git checkout -- .wai/specs/.index.yaml`).',
    };
  }
  // Step 6.
  return {
    state: 'no-tree',
    approved: !strict,
    message: strict
      ? 'No SDD spec tree here (.wai/specs) — and --strict asks for an approved design, so this is a failure. '
        + 'Run `wairon init` to start one, or drop --strict.'
      : 'No SDD spec tree here (.wai/specs) — there is no design to approve, so nothing is gated.',
  };
}

export function checkApproval(strict: boolean): ApprovalCheck {
  // Steps 1-3: no L0 — no tree, or a tree whose root is gone.
  const tree = treeVerdict(strict);
  if (tree) return tree;

  const lock = readLockState(computeGateStateId());
  const record = lock.record;

  // Step 6: every member PROJECT's own approval, at every depth (a part's
  // approval is its declaring project's, so parts are left out). The gate
  // identity reads each member's RECORDED approval, never its tree, so a
  // member's unapproved edits are invisible to it — this read is what keeps
  // the merge gate from going green over them.
  const approvals = familyApprovals();
  const ownEntry = approvals.find((a) => a.key === '');
  const members = approvals.filter((a) => a.key !== '' && a.as !== 'part');
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

  // Steps 10-12: what the approval owes beside its identity — a moved id, an
  // external to pin, or the findings a change of the release turned up.
  const owed = record ? coverageVerdict(record, ownEntry) : null;
  if (owed) return owed;
  const release = lock.state === 'stale' ? ownEntry?.release : undefined;
  const state = release?.carried ? 'locked' : lock.state;

  // A stale verdict under an earlier identity still refuses — nothing proves
  // the design unchanged — but it says so plainly, with whether any own spec
  // file moved. (LockStatus.upgraded: stale, and the record's algorithm is not
  // the current one.) A format-2 record reaches here only when it no longer
  // matches even under its own algorithm.
  if (state === 'stale' && record!.stateId.algorithm !== lock.current.algorithm) return upgradedCheck(record!);

  switch (state) {
    case 'locked': {
      // Steps 15-16: --strict asks for an approved family; a member never
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
      // Step 17: pass, and never call a never-approved member approved.
      const approvedMembers = members.length - never.length;
      const family = members.length === 0
        ? ''
        : ` ${approvedMembers} member project(s) approved at their own roots.`
          + (never.length > 0
            ? ` NOT gated: ${never.map((m) => m.alias ?? m.key).join(', ')} — never approved by anyone (\`--strict\` fails here).`
            : '');
      // A format-2 record that still holds passes, with the one-time carry.
      const carry = record!.specsReading !== 'design'
        ? ' This approval predates lock format 3 and still holds in its original reading; `wairon doctor --fix` '
          + 're-expresses it in the design reading without a review, after which adding or moving a sourcePath never drifts it.'
        : '';
      return {
        state: 'locked',
        approved: true,
        message: (never.length > 0 ? 'This project\'s own design is the approved design — ' : 'The design in this tree is the approved design — ')
          + `approved ${approvalStamp(record!)}.${release?.carried ? ` ${carriedLine(release)}` : ''}${family}${carry}`,
      };
    }
    case 'stale': {
      // Steps 18-22: only member approvals moved — expected; the pin is what is stale.
      const repinned = repinOnly(record!);
      if (repinned) {
        return {
          state: 'stale',
          approved: false,
          message: `Member project(s) were re-approved at their own roots since this project's approval was taken: ${repinned.join(', ')}. `
            + 'That is how a member\'s approval is meant to move — its own approver signed its new design off — so the member is not in question. '
            + 'What is stale is this project\'s pin of it: the approval on record '
            + `(${approvalStamp(record!)}) still names the member's earlier approval, `
            + 'so it does not cover the member design about to merge. No own spec file changed. '
            + 'Fix: run `wairon lock` here to pin the member(s)\' new approval (the same lock records anything else the gate identity covers that moved alongside), and commit the updated .wai/lock.json.',
        };
      }
      // Step 23.
      return {
        state: 'stale',
        approved: false,
        message: 'The design, or something it was approved under, changed after it was approved '
          + `(the approval on record is ${approvalStamp(record!)}). `
          + `${whatMoved(record!, lock.current)} `
          + 'Nothing says a human has seen what is about to merge. '
          + 'Fix: run `wairon lock` on this branch and commit the updated .wai/lock.json.',
      };
    }
    default:
      // Steps 24-25: a tree holding the L0 and nothing below it has no design
      // to approve — said as `wairon lock` says it, which writes no record here.
      if (members.length === 0 && loadSubsystemSpecs().length === 0) {
        return {
          state: 'unlocked',
          approved: !strict,
          message: `${NOTHING_TO_APPROVE} `
            + (strict
              ? '--strict asks for an approved design and there is none yet, so this is a failure.'
              : 'Nothing is gated until there is.'),
        };
      }
      // Step 25.
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

/** The line every surface prints for an approval a release change carried over. */
export function carriedLine(release: ReleaseVerdict): string {
  return `Approved under wairon ${release.from}, re-validated under ${release.to}: still approved (the design and every input the project decides are as approved, and the new release finds no issue in it). \`wairon lock\` refreshes the record's release stamp without a re-approval.`;
}

/**
 * What `lock`, `lock-check` and `status` say of a tree that holds the L0 and
 * nothing below it and was never approved: there is no design to approve yet.
 */
const NOTHING_TO_APPROVE =
  'Nothing designed to approve yet: the spec tree holds the L0 and nothing below it (no subsystem, no member project). '
  + 'Add a subsystem first (an assistant adds one with sdd_add_subsystem), then run `wairon lock`.';

/**
 * cli_lock_adapter.holdsNoDesign — whether there is nothing to approve: no
 * subsystem, no direct member project and no approval on record. A tree emptied
 * after an approval is not this state: that change is the approval's to take.
 */
export function holdsNoDesign(): boolean {
  // Steps 1-3.
  const subsystems = loadSubsystemSpecs();
  const members = familyApprovals(1).filter((a) => a.parent === '' && a.key !== '' && a.as !== 'part');
  const record = readLockRecord();
  // Step 4.
  return subsystems.length === 0 && members.length === 0 && record === null;
}

/**
 * cli_lock_adapter.coverageVerdict — what the approval on record owes beside
 * its gate identity, as a merge-gate refusal: the project id moved since it,
 * an external never pinned or used beyond its pin (the own entry's owed), or a
 * change of the release whose re-validation found issues in the approved
 * design (its release verdict, not carried). Null when nothing is owed.
 */
export function coverageVerdict(record: LockRecord, own: ProjectApproval | undefined): ApprovalCheck | null {
  // Steps 10-13: the project id against the one the approval recorded. The
  // gate identity does not cover the id, so it is judged by the very
  // resolution the project-identity rule reports PROJECT_ID_CHANGED and
  // PROJECT_ID_RENAMED by — `validate`, `lock` and this gate cannot disagree.
  const idMoved = projectIdVerdict(record);
  if (idMoved) return idMoved;

  // Steps 14-15: an external the approval owes — never pinned, or used beyond
  // what its pin records. `wairon lock` refuses both, so passing here would
  // approve what the lock will not; it is the same entry status prints.
  if (own?.owed !== undefined) {
    return {
      state: 'stale',
      approved: false,
      message: `The approval on record (${approvalStamp(record)}) does not cover what this design is judged against: ${own.owed}. `
        + 'Nothing records what a producer that broke these uses would be judged against, and `wairon lock` refuses until it does. '
        + 'Fix: pin first (`wairon externals pin`), then run `wairon lock`, and commit .wai/lock.json with the pin.',
    };
  }

  // Steps 14-16: only the wairon release moved — judged by re-validating the
  // approved design (family_validator.releaseVerdict), never by digest. A
  // carried approval passes as locked, saying so; a release that finds issues
  // is stale for exactly them.
  // Set only when the identity does not match: the stale case.
  const release = own?.release;
  if (release && !release.carried) {
    return {
      state: 'stale',
      approved: false,
      message: `The approval on record (${approvalStamp(record)}) was taken under wairon ${release.from}, and the new release (${release.to}) finds ${release.count ?? 0} issue(s) in the approved design: `
        + `${(release.findings ?? []).join('; ')}${(release.count ?? 0) > (release.findings ?? []).length ? '; …' : ''}. `
        + 'Nothing else moved: the design and every input the project decides are as approved. '
        + 'Fix: resolve those findings (`wairon validate` lists them) and run `wairon lock`, then commit .wai/lock.json.',
    };
  }
  return null;
}

/**
 * Steps 10-13: the verdict on the project id, when it moved since the
 * approval — project_config.identity(record.projectId), the resolution the
 * project-identity rule judges by. A hand-edited id (changed) is refused as
 * `wairon lock` refuses it; an id the rename migration moved (renamed) owes the
 * re-lock the rename named. Null when the id still matches, or the record or
 * the configuration has none to compare.
 */
function projectIdVerdict(record: LockRecord): ApprovalCheck | null {
  if (record.projectId === undefined) return null;
  let config;
  try {
    config = loadProjectConfig();
  } catch {
    return null;
  }
  if (!config) return null;
  const identity = projectIdentity(config, record.projectId);
  const now = identity.id === undefined ? 'no id at all' : `"${identity.id}"`;
  if (identity.problems.some((p) => p.kind === 'changed')) {
    return {
      state: 'stale',
      approved: false,
      message: `The project id changed after the approval: the approval on record (${approvalStamp(record)}) `
        + `approved "${record.projectId}", and .wai/project.yaml now resolves to ${now} (PROJECT_ID_CHANGED) — everything keyed on the approved id `
        + 'no longer finds this project, and `wairon lock` refuses it. '
        + `Fix: restore \`id: ${record.projectId}\` in .wai/project.yaml; to change the id, run \`wairon project rename <id>\` and re-lock.`,
    };
  }
  if (identity.problems.some((p) => p.kind === 'renamed')) {
    return {
      state: 'stale',
      approved: false,
      message: `The project was renamed from "${record.projectId}" to ${now} after the approval (PROJECT_ID_RENAMED): the approval on record `
        + `(${approvalStamp(record)}) still names the former id. `
        + 'Fix: run `wairon lock` to approve the design under the new id, and commit the updated .wai/lock.json.',
    };
  }
  return null;
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
    ? (member.owed !== undefined ? member.owed : member.upgraded ? 'approved under an earlier gate identity — re-lock it once' : 'changed since its own approval')
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
 * the specs, named in the very words `wairon lock` prints for it (inputsMoved).
 */
function whatMoved(record: LockRecord, gateNow: StateId): string {
  const diff = diffAgainstApproval();
  const own = diff ? diffSize(diff) : null;
  const direct = familyApprovals(1).filter((a) => a.parent === '');
  const members = direct.filter((a) => a.as !== 'part');
  const named: string[] = [];
  // A part is a member too (the lock records its pin): never call it removed.
  const current = new Set(direct.map((m) => m.alias ?? m.key));
  const gone = Object.keys(record.members ?? {}).filter((alias) => !current.has(alias));
  const added = members.filter((m) => m.pinned === 'unpinned');
  // A renamed alias is one gone alias and one new one naming the same project
  // (its id, or — the only pair left — an alias renamed with its project id):
  // named as renamed, never as one added and one removed.
  const renamedFrom = new Map<string, string>();
  for (const m of added) {
    const from = gone.find((alias) => !renamedFrom.has(alias) && m.projectId !== undefined && ownGet(record.members, alias)?.project === m.projectId);
    if (from !== undefined) renamedFrom.set(m.alias ?? m.key, from);
  }
  const leftAdded = added.filter((m) => !renamedFrom.has(m.alias ?? m.key));
  const leftGone = gone.filter((alias) => ![...renamedFrom.values()].includes(alias));
  if (leftAdded.length === 1 && leftGone.length === 1 && ownGet(record.members, leftGone[0])?.as !== 'part' && leftAdded[0].as !== 'part') {
    renamedFrom.set(leftAdded[0].alias ?? leftAdded[0].key, leftGone[0]);
  }
  for (const m of members) {
    const name = m.alias ?? m.key;
    const from = renamedFrom.get(name);
    if (from !== undefined) named.push(`${name} (renamed from ${from} since the approval)`);
    else if (m.pinned === 'unpinned') named.push(`${name} (added since the approval)`);
    else if (m.pinned === 'moved') named.push(`${name} (its approval moved since this one was taken${m.state === 'approved' ? '' : `; now ${m.state}`})`);
    else if (m.state !== 'approved') named.push(`${name} (${m.state} at its own root)`);
  }
  for (const alias of gone) {
    if (![...renamedFrom.values()].includes(alias)) named.push(`${alias} (removed since the approval)`);
  }
  const parts: string[] = [];
  if (own !== null && own > 0) parts.push(`${own} own spec file(s) changed since the approval`);
  if (named.length > 0) parts.push(`direct member(s): ${named.join(', ')}`);
  if (parts.length > 0) return `What moved: ${parts.join('; ')}.`;
  return own === null
    ? 'This approval predates per-spec digests, so which spec moved cannot be said.'
    : `No own spec file and no direct member's approval moved, so what changed is ${inputsMoved(record, gateNow, null).join('; ') || 'an input the gate identity covers'}.`;
}

/**
 * Why an approval no own spec file of which moved still no longer matches:
 * the gate the design was judged under moved, never the tree.
 */
const GATE_MOVED =
  'no own spec file changed since it was taken — not even its code linkage — so what moved is the gate it was '
  + 'judged under: the design rules this wairon release judges by, or the project\'s rule tuning, `composition`, '
  + 'network declaration, consumed contracts or a member\'s approval. Fix: one `wairon lock` re-approves the '
  + 'unchanged design under the current gate';

/** The gate-identity upgrade verdict: stale, said plainly, with the one remedy. */
function upgradedCheck(record: LockRecord): ApprovalCheck {
  const diff = diffAgainstApproval();
  const specs = !diff
    ? 'This approval predates per-spec digests, so whether a spec file moved since cannot be said.'
    : diffSize(diff) === 0
      ? 'No own spec file has changed since the approval.'
      : `${diffSize(diff)} own spec file(s) changed since the approval.`;
  if (diff && diffSize(diff) === 0) {
    // Nothing in the tree moved — in a format-2 record's raw-content reading
    // not even code linkage did — so the cause is the gate, and naming the
    // design would send the reader looking for an edit nobody made.
    return {
      state: 'stale',
      approved: false,
      message: `The approval on record (${approvalStamp(record)}, taken by wairon `
        + `${record.validatorVersion}) no longer matches, but ${GATE_MOVED}, and commit the updated .wai/lock.json.`
        + (record.format === 2 ? ' (`wairon doctor --fix` first carries this format-2 record into the design reading, so code linkage never drifts it again.)' : ''),
    };
  }
  if (record.format === 2) {
    // A format-2 record judged under its own algorithm and still not matching:
    // something it covered moved, and it cannot say whether only linkage did.
    return {
      state: 'stale',
      approved: false,
      message: `The approval on record (${approvalStamp(record)}) is a format-2 lock `
        + 'taken before code linkage (sourcePath, symbol, simPath and the like) left the approval, and something it '
        + 'covered moved since — the design, or only code linkage, which this record can no longer tell apart. '
        + `${specs} Fix: one \`wairon lock\` clears it for good — from then on linkage never drifts the approval — `
        + 'and commit the updated .wai/lock.json.',
    };
  }
  return {
    state: 'stale',
    approved: false,
    message: `The approval on record (${approvalStamp(record)}) was taken under an `
      + `earlier gate identity (written by wairon ${record.validatorVersion})${diff ? ', and the design moved since' : ''}: ${specs} `
      + (diff ? '`wairon status` names them. Fix: review them, ' : 'Fix: ')
      + 're-lock once (`wairon lock`) and commit the updated .wai/lock.json.',
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

/** Past this many paths of one kind, the summary lists the first few and counts the rest (`--all` lists them all). */
const LIST_LIMIT = 12;
/** How many paths of one kind a summarized list still shows. */
const LIST_HEAD = 8;

/** One kind of change, listed — whole under --all or when short, else its head and a count of the rest. */
function listPaths(mark: string, paths: string[], all: boolean): boolean {
  const shown = all || paths.length <= LIST_LIMIT ? paths : paths.slice(0, LIST_HEAD);
  for (const p of shown) logger.info(`  ${mark} ${p}`);
  if (shown.length < paths.length) {
    logger.info(`  ${mark} … and ${paths.length - shown.length} more`);
    return true;
  }
  return false;
}

/**
 * What the design is approved under that moved although no own spec did: the
 * gate identity against the record's (the doctrine, the network declaration,
 * a consumed contract's pin, `composition`, a member's approval), and the
 * project id against the one the record names. Empty when nothing did.
 */
function inputsMoved(previous: LockRecord | null, captured: StateId, projectId: string | null): string[] {
  if (!previous) return [];
  const moved: string[] = [];
  if (previous.projectId !== undefined && projectId !== null && previous.projectId !== projectId) {
    moved.push(`the project id (${previous.projectId} → ${projectId})`);
  }
  const sameIdentity = previous.stateId.algorithm === captured.algorithm && previous.stateId.digest === captured.digest;
  // A record with gate parts names exactly the inputs that moved.
  const parts = sameIdentity ? null : movedGateParts(previous, captured.parts);
  if (parts && parts.length > 0 && moved.length === 0) {
    moved.push(describeGateParts(parts));
    return moved;
  }
  if (!sameIdentity && moved.length === 0) {
    moved.push(previous.stateId.algorithm !== captured.algorithm
      ? `the gate identity this wairon release computes (approved by wairon ${previous.validatorVersion ?? 'an earlier release'})`
      : 'an input the gate identity covers — the doctrine, the network declaration, a consumed contract\'s pin, `composition` or a member\'s approval');
  }
  return moved;
}

/**
 * How many specs of every kind are still draft or design: subsystems,
 * components, contracts, implementations and types — the lock's draft warning
 * counts them all, never the components alone.
 */
function draftCounts(): { draft: number; total: number; byKind: string } {
  const kinds: [string, { status?: string }[]][] = [
    ['subsystem', loadSubsystemSpecs()],
    ['component', loadComponentSpecs()],
    ['contract', loadInterfaceSpecs()],
    ['implementation', loadImplementationSpecs()],
    ['type', loadTypeSpecs() as { status?: string }[]],
  ];
  let draft = 0;
  let total = 0;
  const parts: string[] = [];
  for (const [noun, specs] of kinds) {
    const open = specs.filter((s) => s.status === 'draft' || s.status === 'design').length;
    total += specs.length;
    draft += open;
    if (open > 0) parts.push(`${open} ${noun}${open === 1 ? '' : 's'}`);
  }
  return { draft, total, byKind: parts.join(', ') };
}

/** Print what is being approved: the own spec diff, the code half, and each direct member. */
function summarize(gate: ValidationResult, members: ProjectApproval[], captured: StateId, options: LockOptions): void {
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
      logger.info(`Replacing the approval on record (${approvalStamp(previous)}, `
        + `wairon ${previous.validatorVersion ?? 'unknown'}). It records no per-spec digests, so the whole spec tree `
        + 'becomes the approved baseline.');
    } else {
      logger.info('First approval of this tree — the whole spec tree becomes the approved baseline.');
    }
  } else if (diffSize(diff) === 0) {
    // No own spec moved — but the approval may still not cover what is about
    // to be recorded: an input the identity covers, or the project id. Say
    // which, instead of "nothing has changed" over a lock that clears it.
    const config = loadProjectConfig();
    const moved = inputsMoved(readLockRecord(), captured, config ? effectiveProjectId(config) : null);
    if (moved.length > 0) {
      logger.info(`No spec changed since the last approval, but what the design is approved under did: ${moved.join('; ')}. This re-approves the unchanged design under it, and refreshes the generated outputs of this project.`);
    } else {
      logger.info('Nothing has changed since the last approval — this re-records the approval only if something it records moved (an approval already on record as it would be written keeps its lockedAt, and .wai/lock.json is left untouched), and refreshes the generated outputs of this project (guides, skills, and agent files when materialized).');
    }
  } else {
    logger.info(`${diffSize(diff)} spec(s) changed since the last approval:`);
    const all = options.all === true;
    const cut = [
      listPaths('~', diff.changed, all),
      listPaths('+', diff.added, all),
      listPaths('-', diff.removed, all),
    ].some(Boolean);
    if (cut) logger.info('  (`wairon lock --all` lists every one; `wairon status --all` names them too)');
  }
  // A storage move is no design change: named apart, never as + and -.
  if (diff && diff.moved.length > 0) {
    logger.info(`${diff.moved.length} spec file(s) moved storage with their content unchanged (no design change):`);
    listPaths('→', diff.moved, options.all === true);
  }
  // Status is readiness, not approval — a draft design may be approved, and
  // the lock says plainly that is what it is doing.
  const drafts = draftCounts();
  if (drafts.draft > 0) {
    logger.warn(`${drafts.draft} of ${drafts.total} spec(s) are still draft or design (${drafts.byKind}): this approves the design as it stands, drafts included. Status is readiness, never approval — mark specs complete when they are ready to implement.`);
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
 * cli_lock_adapter.restampRelease — refresh the record's release stamp when
 * the own approval carried a change of the release over (the approved design
 * unchanged and re-validated clean under this release), without a review:
 * new stateId, gateParts and validatorVersion, `restamped` provenance,
 * lockedAt and lockedBy kept. Null when there is nothing to refresh.
 */
export function restampRelease(own: ProjectApproval | undefined, captured: StateId, options: LockOptions): LockRecord | null {
  // Steps 3-6: an approval a change of the release carried over — the design
  // and every input the project decides as approved, re-validated clean under
  // this release — has its release stamp refreshed without a re-approval.
  if (own?.release?.carried && !options.subsystem) {
    const onFile = readLockRecord();
    if (onFile) {
      const restampedRecord: LockRecord = {
        ...onFile,
        stateId: { algorithm: captured.algorithm, digest: captured.digest },
        ...(captured.parts ? { gateParts: captured.parts } : {}),
        validatorVersion: WAIRON_VERSION,
        restamped: { at: new Date().toISOString(), fromVersion: own.release.from, toVersion: own.release.to, by: 'wairon lock' },
      };
      writeLockRecord(restampedRecord);
      logger.info(`The approval of ${approvalStamp(onFile)} was taken under wairon ${own.release.from} and re-validated clean under ${own.release.to}: `
        + 'its design and every input the project decides are as approved, so the record\'s release stamp is refreshed — no review needed, the approval stays the approver\'s.');
      return restampedRecord;
    }
  }
  return null;
}

/**
 * cli_lock_adapter.assertApprovable — refuse, writing nothing, what no lock
 * may approve: a project requiring approved members with a member project not
 * approved, an external never pinned, or a use its pin does not record.
 */
export function assertApprovable(members: ProjectApproval[]): void {
  const config = loadProjectConfig();
  // A PROJECT member only: a part has no approval of its own — this lock is its approval.
  const unapproved = members.filter((m) => m.as !== 'part' && m.state !== 'approved');
  if (config?.composition?.requireApprovedMembers && unapproved.length > 0) {
    throw new LockRefusedError(
      `composition.requireApprovedMembers: direct member(s) not approved — ${unapproved.map(describeMemberState).join(', ')}. `
        + 'Lock each at its own root first (`wairon lock` there); a parent never approves below itself. Nothing was written.',
    );
  }
  // An external declared but never pinned is never a pass, so it is never
  // approved: nothing records what this design is judged against.
  const unpinned = unpinnedExternals();
  if (unpinned.length > 0) {
    throw new LockRefusedError(
      `declared external(s) never pinned — ${unpinned.map((a) => `"${a}"`).join(', ')}: nothing records what this design is judged against, `
        + `so a producer that broke it could not be told. Pin first (\`wairon externals pin ${unpinned.join(' ')}\`), then lock. Nothing was written.`,
    );
  }
  // A use its pin does not record is judged against nothing, exactly as a
  // never-pinned external is: refused the same way.
  const unrecorded = Object.entries(unrecordedExternalUses());
  if (unrecorded.length > 0) {
    throw new LockRefusedError(
      `external(s) used beyond their pin — ${unrecorded.map(([alias, uses]) => `"${alias}": ${uses.join(', ')}`).join('; ')} (used now, but not in the lock): `
        + 'nothing records what these uses are judged against, so a producer that broke one could not be told. '
        + `Re-pin first (\`wairon externals pin ${unrecorded.map(([alias]) => alias).join(' ')}\`), then lock. Nothing was written.`,
    );
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
  const approvals = familyApprovals(1);
  const members = approvals.filter((a) => a.parent === '');
  // Steps 3-5: an approval a change of the release carried over has its
  // release stamp refreshed without a re-approval.
  const restamped = restampRelease(approvals.find((a) => a.key === ''), captured, options);
  if (restamped) return restamped;
  summarize(gate, members, captured, options);
  // Step 9: what no lock may approve, refused before anything is written.
  assertApprovable(members);
  const config = loadProjectConfig();
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

  // Step 14: a format-3 record. No `children`, no `reexpressed` (a human approved this one).
  const design = designOnly(gate);
  const count = (severity: string): number => design.issues.filter((i) => i.severity === severity).length;
  const record: LockRecord = {
    // The record format: 3 since code linkage left the approval (design gate
    // algorithm, design-reading digests); 2 from wairon 6.0.0 (members, code, no children).
    format: 3,
    // The captured identity alone: asRecorded is a reading, never recorded.
    stateId: { algorithm: captured.algorithm, digest: captured.digest },
    lockedAt: new Date().toISOString(),
    lockedBy,
    validatorVersion: WAIRON_VERSION,
    validationResult: { valid: design.valid, errors: count('error'), warnings: count('warning'), notices: count('notice') },
    status: 'ready',
    ...(projectId !== null ? { projectId } : {}),
    specs,
    specsReading: 'design',
    // Each input of the certified identity on its own: what lets a later check
    // name the one that moved, and judge a change of the release by re-validation.
    ...(captured.parts ? { gateParts: captured.parts } : {}),
    members: memberPins(members),
    ...(gate.analysis ? { code: withoutCodes(gate.analysis) } : {}),
  };
  // Steps 24-25: the record on file in every field but lockedAt — nothing was
  // approved anew, so the timestamp is kept and nothing is written (a rewrite
  // would only leave .wai/lock.json modified with no change in it).
  let onFile: LockRecord | null = null;
  try { onFile = readLockRecord(); } catch { onFile = null; }
  if (onFile && sameApproval(onFile, record)) return onFile;
  // Step 26: the only file this lock writes.
  writeLockRecord(record);
  return record;
}

/** Whether two lock records are one approval: equal in every field but lockedAt. */
function sameApproval(a: LockRecord, b: LockRecord): boolean {
  const comparable = (r: LockRecord): string => canonicalize({ ...r, lockedAt: '' });
  return comparable(a) === comparable(b);
}

/**
 * cli_lock_adapter.reexpressApproval — carry a format-2 lock record into the
 * design reading without a review, when that is provable: compute the gate
 * identity (which carries the record's own identity recomputed as asRecorded),
 * ask for the carried record, and write it when there is one. The approval
 * stays the human's (lockedAt, lockedBy unchanged); the record gains
 * `reexpressed`. Writes this project's .wai/lock.json only. Null when there was
 * nothing to carry or nothing proves the design unchanged — the caller then
 * points at one `wairon lock`.
 */
export function reexpressLock(): LockRecord | null {
  // Step 1: the gate identity as it stands, with asRecorded for a format-2 record.
  const gate = computeGateStateId();
  // Step 2: the carried record, null unless the record's own identity still holds.
  const carried = reexpress(gate);
  // Step 3: nothing to write.
  if (!carried) return null;
  // Step 4: the only file this writes.
  writeLockRecord(carried);
  // Step 5: the written record.
  return carried;
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
