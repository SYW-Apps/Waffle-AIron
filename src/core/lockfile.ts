import * as fs from 'fs';
import * as path from 'path';
import { aiDir, aiDirAt } from '../utils/fs.js';
import type { StateId } from './statehash.js';

// ---------------------------------------------------------------------------
// Lock Registry (sdd_host / sdd_core)
//
// File-backed I/O for a project's commit-scoped lock record (.wai/lock.json).
// The record is proof that the spec tree validated as-complete at one exact
// StateId, AND the approval itself: `specs` carries a digest per spec file, so
// "which specs did the human sign off, and which have moved since?" is answered
// from a committed file rather than from anything machine-local. This module
// never validates — it only reads/writes the record. Resolves the path through
// aiDir(), so it targets whichever project is bound in the current
// (request-scoped) context.
// ---------------------------------------------------------------------------

/**
 * Who approved, and HOW that identity was established — because the two are
 * different claims. A `hosted` identity was authenticated by the instance that
 * issued the caller's credential; `git` and `os` are self-declared, read from
 * the machine's own config. Recording the source keeps the record honest about
 * how much it proves instead of leaving a bare name to imply more than it can.
 *
 * The actual proof is the commit that introduces this file — signed commits or
 * a protected branch establish it; no field inside the file ever can.
 */
export interface ApproverIdentity {
  /** Git author line, hosted subject id, or OS username — per `source`. */
  id: string;
  /** Display name when the source carries one separately from the id. */
  name?: string;
  /** 'legacy' is a record written before this field existed: an opaque string. */
  source: 'git' | 'hosted' | 'os' | 'legacy';
}

export interface LockRecord {
  /** The exact spec-tree state this lock validated. */
  stateId: StateId;
  /** ISO-8601 lock timestamp. */
  lockedAt: string;
  /** The principal that authorized the lock (never a raw credential). */
  lockedBy: ApproverIdentity;
  /** wairon version that produced the validation. */
  validatorVersion: string;
  /** The as-complete validation outcome captured at lock time. */
  validationResult: { valid: boolean; errors: number; warnings: number };
  /** Always 'ready'. The lock IS the human gate; there is no second state. */
  status: 'ready';
  /**
   * THE APPROVAL: spec path (relative to the project root, POSIX separators) →
   * sha256 of that file's content when it was approved. Sorted on write, so a
   * re-lock shows one changed line per spec actually re-approved rather than a
   * rewritten blob.
   *
   * Absent on a record written before approval moved in here — such a lock
   * still proves the tree validated, but cannot say WHICH specs moved since,
   * only that the whole-tree StateId did. Re-locking records it.
   */
  specs?: Record<string, string>;
  /**
   * Chained child mount id → that child's approved StateId, pinned the way a
   * git submodule pins a commit. A child edit does not dirty the parent's own
   * diff; it moves this pin, which is the parent's review signal.
   */
  children?: Record<string, string>;
  /** For git-backed projects: the pushed commit the PR is at. */
  commitSha?: string;
  /** For git-backed projects: the compare/PR URL a human opens to merge. */
  compareUrl?: string;
}

function lockPath(): string {
  return aiDir('lock.json');
}

/**
 * Read a possibly-legacy `lockedBy` as an ApproverIdentity. Older records wrote
 * a bare string (`local:someone`, `admin:master`); that says nothing about how
 * the name was established, so it reads back as `legacy` rather than being
 * guessed into a source it may not have had.
 */
export function normalizeApprover(value: unknown): ApproverIdentity {
  if (value && typeof value === 'object' && typeof (value as ApproverIdentity).id === 'string') {
    const v = value as ApproverIdentity;
    const source: ApproverIdentity['source'] =
      v.source === 'git' || v.source === 'hosted' || v.source === 'os' ? v.source : 'legacy';
    return { id: v.id, ...(v.name ? { name: v.name } : {}), source };
  }
  return { id: typeof value === 'string' && value ? value : 'unknown', source: 'legacy' };
}

/** One line for a human: the approver plus how much that name is worth. */
export function describeApprover(who: ApproverIdentity): string {
  const label = who.name ? `${who.name} (${who.id})` : who.id;
  return who.source === 'hosted' ? `${label} [authenticated]` : label;
}

/** Read the current project's lock record, or null when absent/unreadable. */
export function readLockRecord(): LockRecord | null {
  try {
    return normalizeRecord(JSON.parse(fs.readFileSync(lockPath(), 'utf8')));
  } catch {
    return null;
  }
}

/** Read another project root's lock record — how a parent resolves a child pin. */
export function readLockRecordAt(root: string): LockRecord | null {
  try {
    return normalizeRecord(JSON.parse(fs.readFileSync(aiDirAt(root, 'lock.json'), 'utf8')));
  } catch {
    return null;
  }
}

function normalizeRecord(raw: unknown): LockRecord {
  const record = raw as LockRecord;
  return { ...record, lockedBy: normalizeApprover((record as { lockedBy?: unknown }).lockedBy) };
}

/** Persist the lock record atomically to .wai/lock.json (overwrites any prior). */
export function writeLockRecord(record: LockRecord): void {
  const p = lockPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(withSortedMaps(record), null, 2) + '\n');
  fs.renameSync(tmp, p);
}

/**
 * Sort `specs` and `children` by key before serializing. JSON preserves object
 * insertion order, so this is what makes a re-lock's diff readable: the entries
 * stay in the same place and only the specs that actually changed move.
 */
function withSortedMaps(record: LockRecord): LockRecord {
  const sorted = (m?: Record<string, string>): Record<string, string> | undefined => {
    if (!m) return undefined;
    const out: Record<string, string> = {};
    for (const k of Object.keys(m).sort()) out[k] = m[k];
    return out;
  };
  const specs = sorted(record.specs);
  const children = sorted(record.children);
  return {
    ...record,
    ...(specs ? { specs } : {}),
    ...(children ? { children } : {}),
  };
}
