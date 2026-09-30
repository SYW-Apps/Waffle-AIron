import * as fs from 'fs';
import * as path from 'path';
import { aiDir, aiDirAt } from '../utils/fs.js';
import type { StateId } from './statehash.js';
// The approver is shared vocabulary, not this store's private shape: a command
// that only wants to RENDER one must not have to reach a Store to do it.
import type { ApproverIdentity, CodeAnalysis, ProjectApprovalState } from '../models/lock.js';

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
 * member_pin — one direct member as a parent's lock recorded it: the member's
 * composition subject (the stateId its OWN lock record carries) and its
 * approval state when the parent locked. A record of the member owner's
 * decision, never of the member's specs; the parent never writes below itself.
 */
export interface MemberPin {
  /** The member's effective project id when the parent locked. */
  project?: string;
  /** The member's recorded gate identity, `<algorithm>:<digest>`; absent when it had no lock. */
  subject?: string;
  /** approved | drifted | never, as it stood when the parent locked. Recorded, never hashed. */
  state: ProjectApprovalState;
}

export interface LockRecord {
  /**
   * The gate identity this lock certifies, captured BEFORE the as-complete
   * validation ran and confirmed unchanged immediately before the record was
   * written. Also this project's composition subject as its parent sees it.
   */
  stateId: StateId;
  /** ISO-8601 lock timestamp. */
  lockedAt: string;
  /** The principal that authorized the lock (never a raw credential). */
  lockedBy: ApproverIdentity;
  /** wairon version that produced the validation. */
  validatorVersion: string;
  /**
   * The DESIGN half of the as-complete validation captured at lock time
   * (ValidationResult.designOnly); the code half is counted under `code`. A
   * format-1 record counted both together, and a record written before the
   * notice severity existed carries no notice count.
   */
  validationResult: { valid: boolean; errors: number; warnings: number; notices?: number };
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
   * LEGACY (format 1): chained child mount id → that child's approved StateId,
   * copied without checking the child's lock still matched its tree. Read for
   * one release as the member pins; never written from stage 5 on.
   */
  children?: Record<string, string>;
  /** The record format: 2 from stage 5 on; absent means format 1. */
  format?: number;
  /**
   * Each DIRECT member, keyed by alias → its composition subject and approval
   * state as they stood when this project locked. Present (possibly empty) on
   * every format-2 record.
   */
  members?: Record<string, MemberPin>;
  /**
   * The code-conformance results of the lock-time run with the analyzer that
   * produced them — BESIDE the approval, never part of what it certifies.
   * Absent on a format-1 record.
   */
  code?: CodeAnalysis;
  /**
   * The project's effective id when this lock was taken (a defaulted one
   * included). Validate reports PROJECT_ID_CHANGED when project.yaml later
   * resolves to a different id. Absent on a record written before project ids
   * existed, and when the project had no effective id to record.
   */
  projectId?: string;
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

/**
 * Persist the lock record atomically to .wai/lock.json (overwrites any prior).
 * A legacy `children` map is never written: stage 5 records `members` instead.
 */
export function writeLockRecord(record: LockRecord): void {
  const p = lockPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(withSortedMaps(record), null, 2) + '\n');
  fs.renameSync(tmp, p);
}

/**
 * Sort `specs` and `members` by key before serializing, and drop the legacy
 * `children`. JSON preserves object insertion order, so this is what makes a
 * re-lock's diff readable: the entries stay in the same place and only the
 * specs that actually changed move.
 */
function withSortedMaps(record: LockRecord): LockRecord {
  const sorted = <T>(m?: Record<string, T>): Record<string, T> | undefined => {
    if (!m) return undefined;
    const out: Record<string, T> = {};
    for (const k of Object.keys(m).sort()) out[k] = m[k];
    return out;
  };
  const { children: _legacy, ...rest } = record;
  const specs = sorted(rest.specs);
  const members = sorted(rest.members);
  return {
    ...rest,
    ...(specs ? { specs } : {}),
    ...(members ? { members } : {}),
  };
}
