import * as crypto from 'crypto';
import * as path from 'path';
import { getProjectRoot } from '../utils/fs.js';
import { snapshotSpecFiles, graph } from './specs.js';
import { readLockRecord, readLockRecordAt } from './lockfile.js';
import { describeApprover, type ProjectApproval } from '../models/lock.js';
import { approvalKeyIn } from '../models/project-family.js';
import type { LockRecord } from './lockfile.js';
import type { StateId } from './statehash.js';

// ---------------------------------------------------------------------------
// The approval — what the human last said yes to
//
// A review needs two things: the current tree, and the tree as it stood when
// someone approved it. wairon had the first and only a whole-tree HASH of the
// second, so the only question it could answer was "did anything move?" —
// surfaced as `Lock: STALE` on a tree that validates clean, which tells a human
// nothing about what to look at.
//
// The answer is one digest PER SPEC FILE, carried in the committed lock record
// (`LockRecord.specs`). That is enough for every question anything actually
// asks — which specs moved, which are still settled, which are new — because no
// consumer ever needed the approved CONTENT, only whether it still matches. For
// the content itself there is already git: the lock is committed, so
// `git diff <lock commit> -- .wai/specs` is the real diff, and better.
//
// Three properties fall out, and all three are the point:
//
//  1. It is COMMITTED, so a teammate, a fresh clone and CI all see the same
//     approval the approver saw. A machine-local record could not.
//  2. It is ~90 KB for a 786-spec tree instead of ~2 MB of content, and it is
//     written with sorted keys — so a re-lock's diff is one line per spec that
//     was actually re-approved, which is a good signal in a PR rather than
//     noise. That is categorically different from the ratchet this replaced,
//     which rewrote hundreds of SPEC files for a decision that changed no
//     design.
//  3. It is per PROJECT ROOT, because each `.wai` has its own lock — including
//     every member. A parent approval never freezes a member's in-flight work;
//     the parent records each direct member's composition subject instead
//     (`members`, stage 5), the way a git submodule pins a commit — and a
//     member's state and pin are the validator's to compute, since they need
//     gate identities (validator_portal.familyApprovals).
// ---------------------------------------------------------------------------

export interface ApprovalDiff {
  /** Specs that exist now and did not at approval. */
  added: string[];
  /** Specs whose content differs from the approved copy. */
  changed: string[];
  /** Specs that existed at approval and are gone now. */
  removed: string[];
  /** Specs that still match the approved copy exactly. */
  unchangedPaths: string[];
}

/**
 * Total number of specs that differ from the approved tree.
 *
 * Arithmetic over the diff's own fields, so it belongs to the VALUE rather than
 * to the component that builds one — a caller holding a diff should not have to
 * reach for a service to count it. It stays a free function taking the value
 * because `ApprovalDiff` is plain data: it is built as an object literal, read
 * back out of nothing, and compared field-by-field in tests. Making the count a
 * real method would mean a class, and a class would buy nothing but the dot.
 */
export function diffSize(d: ApprovalDiff): number {
  return d.added.length + d.changed.length + d.removed.length;
}

/**
 * The digest a spec's approved state is recorded as.
 *
 * Line endings are normalized first, and that is load-bearing rather than
 * tidiness: this record is COMMITTED, so the machine that approves and the
 * machine that reads it back are routinely different ones. Git rewrites line
 * endings on checkout (`core.autocrlf`), so an approval taken on Windows and
 * read on a Linux CI runner would otherwise differ in EVERY spec — the feature
 * would report a fully drifted tree on a tree nobody touched.
 *
 * Note what this digest is NOT: the gate StateId, which hashes the PARSED tree
 * and so ignores formatting entirely. They answer different questions — "has
 * this file changed since you approved it" versus "has the design changed" — so
 * a whitespace-only edit legitimately moves one and not the other.
 */
function digest(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * The current spec tree as relative-path → content digest: the shape an
 * approval records.
 *
 * `snapshotSpecFiles` federates recursively (`scanAll` defaults to
 * `recursive: true`), so it returns every chained child's specs too. A parent
 * approval must not contain them: the trees are approved separately, so
 * capturing a child's specs here would mean a parent approval silently freezes
 * work the parent does not own — and every child edit would dirty the parent's
 * diff, which is exactly what the child PIN exists to replace.
 */
export function currentSpecDigests(root: string = getProjectRoot()): Record<string, string> {
  // Every member the scan read, in either declaration form (stage 3: a member is
  // a project of its own, never a subsystem of this one).
  const nodes = graph().nodes;
  const mountDirs = nodes
    .filter((n) => n.namespace !== '')
    .map((n) => `${path.resolve(n.directory).split(path.sep).join('/')}/`);
  // A part's files ARE this project's own (stage 8), keyed `members/<alias>/…`.
  const parts = nodes.find((n) => n.namespace === '')?.parts ?? [];

  const out: Record<string, string> = {};
  for (const [abs, content] of snapshotSpecFiles()) {
    const normalized = path.resolve(abs).split(path.sep).join('/');
    if (mountDirs.some((dir) => normalized.startsWith(dir))) continue;
    out[approvalKeyIn(abs, root, parts)] = digest(content);
  }
  return out;
}

/**
 * The `specs` map to record as approved. The caller is responsible for having
 * gated the tree — this describes a decision, it does not make one.
 *
 * A SCOPED approval (`lock --subsystem x`) approves only what it covers.
 * Everything outside keeps whatever approval it already had, so approving one
 * subsystem can never silently mark the rest of the tree reviewed — and a spec
 * deleted inside the scope leaves the record with it.
 */
export function captureApprovedSpecs(
  root: string = getProjectRoot(),
  scope?: { paths: Set<string> },
): Record<string, string> {
  const current = currentSpecDigests(root);
  if (!scope) return current;

  // A scope names files by their path from the root; a part's file is approved
  // under its storage-independent key (stage 8).
  const parts = graph().nodes.find((n) => n.namespace === '')?.parts ?? [];
  const keys = new Set([...scope.paths].map((rel) => approvalKeyIn(path.resolve(root, rel), root, parts)));
  const previous = readLockRecord()?.specs ?? {};
  const specs: Record<string, string> = { ...previous };
  for (const rel of Object.keys(previous)) {
    if (keys.has(rel) && current[rel] === undefined) delete specs[rel];
  }
  for (const rel of keys) {
    if (current[rel] !== undefined) specs[rel] = current[rel];
  }
  return specs;
}

/**
 * What changed since approval. Returns null when nothing was ever approved —
 * a different state from "approved and unchanged", and one the caller must be
 * able to tell apart.
 *
 * Also null for a lock written before the per-spec record existed: such a lock
 * proves the tree validated, but cannot say WHICH specs moved. Reporting
 * surfaces say so and point at re-locking rather than inventing an answer.
 */
export function diffAgainstApproval(root: string = getProjectRoot()): ApprovalDiff | null {
  const approved = approvedSpecs(root);
  if (!approved) return null;

  const current = currentSpecDigests(root);
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const unchangedPaths: string[] = [];

  for (const [rel, d] of Object.entries(current)) {
    const before = approved[rel];
    if (before === undefined) added.push(rel);
    else if (before !== d) changed.push(rel);
    else unchangedPaths.push(rel);
  }
  for (const rel of Object.keys(approved)) {
    if (current[rel] === undefined) removed.push(rel);
  }

  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
    unchangedPaths: unchangedPaths.sort(),
  };
}

/** The approved per-spec digests, or null when there is no per-spec record. */
function approvedSpecs(root: string): Record<string, string> | null {
  return approvalRecord(root)?.specs ?? null;
}

/** The lock record governing a root. Always resolved from the root itself, so a
 *  parent reading a child's approval takes the same path as reading its own. */
export function approvalRecord(root: string = getProjectRoot()): LockRecord | null {
  return readLockRecordAt(root);
}

/**
 * The spec paths a human has approved AND that have not moved since.
 *
 * This is what replaces the on-disk `status: draft → complete` ratchet. The
 * ratchet existed so that, after approval, ordinary `validate` would stop
 * relaxing completeness findings for specs the human had signed off — but it
 * bought that by rewriting every spec file in the tree, and it was ONE-WAY:
 * editing an approved spec left it marked complete, so the rules kept judging
 * in-flux work at full strictness with no way back short of a manual demotion.
 *
 * Derived settledness is strictly better on both counts. Nothing is written
 * into the tree, and a spec that drifts after approval returns to draft context
 * by itself.
 *
 * null when the tree was never approved — then the authored status stands,
 * which is the behaviour a project has before anyone has gated it.
 */
export function settledSpecPaths(root: string = getProjectRoot()): Set<string> | null {
  const diff = diffAgainstApproval(root);
  return diff ? new Set(diff.unchangedPaths) : null;
}

/** Render a StateId the way a member pin (a composition subject) stores it. */
export function pinOf(stateId: StateId): string {
  return `${stateId.algorithm}:${stateId.digest}`;
}

/**
 * What the lock says about the tree as it stands: the sentence to show, and
 * whether it is drift.
 *
 * The two are separate on purpose. A caller picks its severity from the FACT
 * rather than by matching this module's wording — the terminal warns in yellow,
 * an MCP client may do nothing at all, and neither should have to parse prose to
 * decide.
 */
export interface ApprovalVerdict {
  /** The verdict as a line to show; empty for a project that was never approved. */
  text: string;
  /** Whether the tree has actually moved since it was approved. */
  drifted: boolean;
}

/**
 * What has changed since the human last approved this tree.
 *
 * This used to report the lock's StateId verdict, which could only ever say
 * `STALE` — a banner that fired on a tree validating 0 errors / 0 warnings,
 * named nothing to look at, and asked for work that produced no new
 * information. With a digest per spec in the lock record, the same line can
 * name the specs that actually moved, which is the only form a human can act
 * on.
 *
 * Silent for a project that was never approved: absence of an approval is the
 * normal state of a tree still being designed, not news.
 *
 * Answers whether it IS drift alongside the text — so the caller picks its
 * severity from the fact rather than by matching this function's own wording.
 */
export function approvalVerdict(approvals?: ProjectApproval[]): ApprovalVerdict {
  const quiet = { text: '', drifted: false };
  try {
    const approval = approvalRecord();
    if (!approval) return quiet;
    const by = describeApprover(approval.lockedBy);

    // What the pin tree says, when the caller passed one: an upgrade-only
    // staleness of this project's own lock, direct members whose pin MOVED
    // (this lock is stale until it re-locks) and direct members that are
    // drifted or never approved (the member's to lock, named so this project
    // knows before it locks).
    const notes = memberNotes(approvals ?? []);
    const pinDrift = notes.drift;
    const childNote = notes.text;

    const diff = diffAgainstApproval();
    if (!diff) {
      // Locked, but by a record written before per-spec approval existed: it
      // proves the tree validated, not which specs still match it. Say exactly
      // that rather than implying either answer.
      return {
        text: `\nApproved: ${approval.lockedAt} by ${by} — this lock predates per-spec approval, so `
          + `drift is only visible at whole-tree level. Re-lock to record it.${childNote}\n`,
        drifted: pinDrift,
      };
    }
    if (diffSize(diff) === 0) {
      return {
        text: `\nApproved: ${approval.lockedAt} by ${by} — no spec has changed since.${childNote}\n`,
        drifted: pinDrift,
      };
    }

    const parts: string[] = [];
    if (diff.changed.length) parts.push(`${diff.changed.length} changed`);
    if (diff.added.length) parts.push(`${diff.added.length} added`);
    if (diff.removed.length) parts.push(`${diff.removed.length} removed`);

    // Name a few, then say how many more — enough to orient without becoming
    // the wall of text the old banner was trying not to be.
    const named = [...diff.changed, ...diff.added, ...diff.removed].slice(0, 5);
    const rest = diffSize(diff) - named.length;

    // One category needs no breakdown: "1 spec changed since approval (1
    // changed)" says the same thing twice. The parenthetical earns its place
    // only when the diff actually mixes kinds.
    const n = diffSize(diff);
    const noun = `${n} spec${n === 1 ? '' : 's'}`;
    const headline = parts.length === 1
      ? `${noun} ${parts[0].slice(String(diffSize(diff)).length + 1)} since approval`
      : `${noun} changed since approval (${parts.join(', ')})`;

    return {
      text: `\n${headline} — approved ${approval.lockedAt} by ${by}:\n`
        + named.map((p) => `  ${p}`).join('\n')
        + (rest > 0 ? `\n  … and ${rest} more` : '')
        + childNote
        + '\n',
      drifted: true,
    };
  } catch {
    return quiet; // never let a report line break the report
  }
}

/** The gate-identity upgrade note: the identity gained inputs, which says nothing about the design. */
export const GATE_UPGRADE_NOTE =
  'the gate identity gained inputs in this release (members\' composition subjects, `composition`; '
  + 'code conformance moved beside the claim)';

/**
 * The member and upgrade lines of the verdict, from the pin tree: whether this
 * project's own lock was taken under an earlier gate identity, which direct
 * members' pins moved, and which are drifted or never approved. `drift` is
 * this project's drift only: an upgrade or a moved pin — a member that is
 * merely unapproved is the member's to lock.
 */
function memberNotes(approvals: ProjectApproval[]): { text: string; drift: boolean } {
  const own = approvals.find((a) => a.key === '');
  // A part has no approval of its own (stage 8): this project's is its approval.
  const direct = approvals.filter((a) => a.parent === '' && a.as !== 'part');
  const moved = direct.filter((a) => a.pinned === 'moved');
  const unapproved = direct.filter((a) => a.state !== 'approved');
  const lines: string[] = [];
  if (own?.upgraded) {
    lines.push(`This approval was taken under an earlier gate identity — ${GATE_UPGRADE_NOTE}. Re-lock once.`);
  }
  if (moved.length) {
    lines.push(`${moved.length} member pin(s) moved since approval: ${moved.map((a) => a.alias ?? a.key).join(', ')} — re-lock to approve them.`);
  }
  if (unapproved.length) {
    lines.push(`Member(s) not approved at their own root: ${unapproved.map((a) => `${a.alias ?? a.key} (${a.state}${a.upgraded ? ', re-lock once' : ''})`).join(', ')}.`);
  }
  return {
    text: lines.map((l) => `\n${l}`).join(''),
    drift: !!own?.upgraded || moved.length > 0,
  };
}
