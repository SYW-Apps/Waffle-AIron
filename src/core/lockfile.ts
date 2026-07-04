import * as fs from 'fs';
import * as path from 'path';
import { aiDir } from '../utils/fs.js';
import type { StateId } from './statehash.js';

// ---------------------------------------------------------------------------
// Lock Registry (sdd_host / sdd_core)
//
// File-backed I/O for a project's commit-scoped lock record (.wai/lock.json).
// The record is proof that the spec tree validated as-complete at one exact
// StateId; promotion re-checks the current StateId against it and refuses on
// drift. This module never validates or promotes — it only reads/writes the
// record. Resolves the path through aiDir(), so it targets whichever project is
// bound in the current (request-scoped) context.
// ---------------------------------------------------------------------------

export interface LockRecord {
  /** The exact spec-tree state this lock validated. */
  stateId: StateId;
  /** ISO-8601 lock timestamp. */
  lockedAt: string;
  /** Audit id of the principal that locked (never a raw credential). */
  lockedBy: string;
  /** wairon version that produced the validation. */
  validatorVersion: string;
  /** The as-complete validation outcome captured at lock time. */
  validationResult: { valid: boolean; errors: number; warnings: number };
  /** "ready" (locked, awaiting promotion) or "promoted". */
  status: 'ready' | 'promoted';
  /** For git-backed projects: the pushed commit the PR is at. */
  commitSha?: string;
  /** For git-backed projects: the compare/PR URL a human opens to merge. */
  compareUrl?: string;
}

function lockPath(): string {
  return aiDir('lock.json');
}

/** Read the current project's lock record, or null when absent/unreadable. */
export function readLockRecord(): LockRecord | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath(), 'utf8')) as LockRecord;
  } catch {
    return null;
  }
}

/** Persist the lock record atomically to .wai/lock.json (overwrites any prior). */
export function writeLockRecord(record: LockRecord): void {
  const p = lockPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
  fs.renameSync(tmp, p);
}
