import * as crypto from 'crypto';
import * as path from 'path';
import { getProjectRoot } from '../utils/fs.js';
import { snapshotSpecFiles, loadSubsystemSpecs } from './specs.js';
import { readLockRecord, readLockRecordAt } from './lockfile.js';
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

/** Total number of specs that differ from the approved tree. */
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
): { id: string; pinned: string; now: string | null }[] {
  const pinned = approvalRecord(root)?.children;
  if (!pinned) return [];
  const now = currentChildPins(mounts, root);
  const moved: { id: string; pinned: string; now: string | null }[] = [];
  for (const [id, was] of Object.entries(pinned)) {
    const current = now[id] ?? null;
    if (current !== was) moved.push({ id, pinned: was, now: current });
  }
  return moved;
}
