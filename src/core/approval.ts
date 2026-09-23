import * as crypto from 'crypto';
import * as path from 'path';
import { getProjectRoot } from '../utils/fs.js';
import { snapshotSpecFiles, loadSubsystemSpecs } from './specs.js';
import { readLockRecord, readLockRecordAt, describeApprover } from './lockfile.js';
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
//     every chained subproject. A parent approval never freezes a child's
//     in-flight work; the parent PINS each child's approved StateId instead
//     (see `children`), the way a git submodule pins a commit.
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
  const mountDirs = loadSubsystemSpecs()
    .filter((s) => s.projectPath && !s.id.includes('::'))
    .map((s) => `${path.resolve(root, s.projectPath as string).split(path.sep).join('/')}/`);

  const out: Record<string, string> = {};
  for (const [abs, content] of snapshotSpecFiles()) {
    const normalized = path.resolve(abs).split(path.sep).join('/');
    if (mountDirs.some((dir) => normalized.startsWith(dir))) continue;
    out[path.relative(root, abs).split(path.sep).join('/')] = digest(content);
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

  const previous = readLockRecord()?.specs ?? {};
  const specs: Record<string, string> = { ...previous };
  for (const rel of Object.keys(previous)) {
    if (scope.paths.has(rel) && current[rel] === undefined) delete specs[rel];
  }
  for (const rel of scope.paths) {
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

/** Render a StateId the way a child pin stores it. */
export function pinOf(stateId: StateId): string {
  return `${stateId.algorithm}:${stateId.digest}`;
}

/**
 * One chained child sitting at a different pin than the approval recorded.
 *
 * Both pins are carried rather than a boolean, because a parent deciding
 * whether to re-lock needs to see what it approved and what it is looking at
 * now. And `now` is nullable on purpose: a child that no longer carries an
 * approval of its own is a DIFFERENT problem from a child that moved, and a
 * caller that cannot tell them apart reports the wrong one.
 */
export interface ChildPinDrift {
  /** The mount id — the parent subsystem the child is mounted as. */
  id: string;
  /** The pin the parent's approval recorded for this child. */
  pinned: string;
  /** The pin the child is at now, or null when it carries no approval. */
  now: string | null;
}

/**
 * The approved StateId of every chained child mounted under this root, keyed by
 * mount id — what a parent approval PINS.
 *
 * A child with no lock of its own contributes no pin: the parent can only
 * record a decision the child's owner actually made.
 */
export function currentChildPins(
  mounts: { id: string; projectPath?: string }[],
  root: string = getProjectRoot(),
): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const mount of mounts) {
    if (!mount.projectPath || mount.id.includes('::')) continue;
    const child = readLockRecordAt(path.resolve(root, mount.projectPath));
    if (child) pins[mount.id] = pinOf(child.stateId);
  }
  return pins;
}

/**
 * Chained children whose own approval has moved away from what the parent
 * pinned. This is the parent-side review signal that a child edit is supposed
 * to produce — and the reason a child edit does NOT dirty the parent's own spec
 * diff: the two are separate decisions, and only this one crosses.
 */
export function movedChildren(
  mounts: { id: string; projectPath?: string }[],
  root: string = getProjectRoot(),
): ChildPinDrift[] {
  const pinned = approvalRecord(root)?.children;
  if (!pinned) return [];
  const now = currentChildPins(mounts, root);
  const moved: ChildPinDrift[] = [];
  for (const [id, was] of Object.entries(pinned)) {
    const current = now[id] ?? null;
    if (current !== was) moved.push({ id, pinned: was, now: current });
  }
  return moved;
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
export function approvalVerdict(): ApprovalVerdict {
  const quiet = { text: '', drifted: false };
  try {
    const approval = approvalRecord();
    if (!approval) return quiet;
    const by = describeApprover(approval.lockedBy);

    // A moved chained child is a change the parent should review even when none
    // of the parent's OWN specs shifted — the trees are approved separately, and
    // this pin is the only thing that crosses between them.
    const moved = movedChildren(loadSubsystemSpecs());
    const childNote = moved.length
      ? `\n${moved.length} chained child project(s) moved since approval: ${moved.map((m) => m.id).join(', ')}.`
      : '';

    const diff = diffAgainstApproval();
    if (!diff) {
      // Locked, but by a record written before per-spec approval existed: it
      // proves the tree validated, not which specs still match it. Say exactly
      // that rather than implying either answer.
      return {
        text: `\nApproved: ${approval.lockedAt} by ${by} — this lock predates per-spec approval, so `
          + `drift is only visible at whole-tree level. Re-lock to record it.${childNote}\n`,
        drifted: moved.length > 0,
      };
    }
    if (diffSize(diff) === 0) {
      return {
        text: `\nApproved: ${approval.lockedAt} by ${by} — no spec has changed since.${childNote}\n`,
        drifted: moved.length > 0,
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
