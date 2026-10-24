import * as fs from 'fs';
import * as path from 'path';
import { setPreRenameCheck } from './fs.js';
import { currentHolder, holderIsLocal, parseHolder, pidAlive, serializeHolder, type LockHolder } from './lock-holder.js';

// ---------------------------------------------------------------------------
// The write lock of one data file (file_write_lock_impl)
//
// A store that reads its whole file, changes it and writes it back loses an
// update when another process does the same in between. Every such
// read-change-write holds a generation-numbered lock beside the file:
//
//   F.lock.<g>       the lock of generation g, created exclusively; it holds
//                    the lock_holder record and a random nonce
//   F.lock.<g>.end   generation g is over, created exclusively by the holder
//                    at release or by a reclaimer that judged the holder gone
//
// No path is ever deleted by a decision someone else may have judged: a late
// action of a stalled process names a generation (creates its marker, or the
// next name), never a file at a path, and the highest lock file always stays,
// so no name at or below it can be recreated and pass the re-list.
// Synchronous end to end, and so is the wait.
// ---------------------------------------------------------------------------

/** Stale age, wait and unreadable grace of one lock, in milliseconds. */
export interface FileLockLimits {
  /** A lock file older than this is a crashed writer's, reclaimed whoever holds it. */
  staleMs: number;
  /** How long an acquirer waits before it gives up: past the stale age, so a lock a crashed writer left is reclaimed, never reported. */
  waitMs: number;
  /** An empty or unparseable lock file older than this is reclaimed (a holder between creating and filling it takes milliseconds). */
  graceMs: number;
}

/** The hosted stores' limits. */
export const HOSTED_LOCK_LIMITS: FileLockLimits = { staleMs: 15_000, waitMs: 20_000, graceMs: 5_000 };
/** The spec-tree write lock's limits. */
export const SPEC_TREE_LOCK_LIMITS: FileLockLimits = { staleMs: 60_000, waitMs: 30_000, graceMs: 10_000 };

/** The points of an acquire at which a test can stall a process (see FileLockOptions.at). */
export type LockPoint = 'listed' | 'judged' | 'created' | 'relisted';

export interface FileLockOptions extends Partial<FileLockLimits> {
  /** Whether a lock file naming THIS process, with no hold counted by the caller, is a leftover to reclaim (the spec-tree lock's re-entrancy count). */
  ownLeftover?: () => boolean;
  /** Builds the error thrown when the wait ends; the default names the file. */
  timeoutError?: (info: LockTimeout) => Error;
  /** Test seam: called at named points of an acquire, with the generation concerned. */
  at?: (point: LockPoint, generation: number) => void;
  /** Test seam: the clock (milliseconds since the epoch). */
  now?: () => number;
  /** Test seam: the wait between two looks. */
  sleep?: (ms: number) => void;
  /** Test seam: the identity of the judging process. */
  here?: LockHolder;
}

/** What a timed-out acquire knew about the lock it waited for. */
export interface LockTimeout {
  file: string;
  lockFile: string;
  waitMs: number;
  holder: LockHolder | null;
  /** The holder is on another host or in another PID namespace. */
  remote: boolean;
}

/** A lock held: the generation and the files it owns. */
export interface FileLockHandle {
  file: string;
  generation: number;
  lockFile: string;
  endFile: string;
  nonce: string;
  options: FileLockOptions;
}

/** What `inspectFileLock` says of the live generation of a lock. */
export interface FileLockInspection {
  lockFile: string;
  generation: number;
  /** The holder the file names, when it can be read. */
  holder: LockHolder | null;
  ageMs: number;
  /** live, gone (local holder's pid is gone), unreadable (names no holder) or remote (cannot be probed). */
  state: 'live' | 'gone' | 'unreadable' | 'remote';
  /** Whether the next acquire reclaims it instead of waiting. */
  breaks: boolean;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function limitsOf(o: FileLockOptions): FileLockLimits {
  return {
    staleMs: o.staleMs ?? HOSTED_LOCK_LIMITS.staleMs,
    waitMs: o.waitMs ?? HOSTED_LOCK_LIMITS.waitMs,
    graceMs: o.graceMs ?? HOSTED_LOCK_LIMITS.graceMs,
  };
}

const busyCode = (code: string | undefined): boolean => code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';

interface Listing {
  /** Generations that have a lock file. */
  locks: Set<number>;
  /** Generations that have an end marker. */
  ends: Set<number>;
  /** The highest generation with a lock file; 0 when none. */
  highest: number;
}

function lockPathOf(file: string, g: number): string {
  return `${file}.lock.${g}`;
}

/** The generation a directory entry names, and whether it is the end marker; null for every other name. */
function parseName(file: string, name: string): { g: number; end: boolean } | null {
  const prefix = `${path.basename(file)}.lock.`;
  if (!name.startsWith(prefix)) return null;
  const m = /^(\d+)(\.end)?$/.exec(name.slice(prefix.length));
  return m === null ? null : { g: Number(m[1]), end: m[2] !== undefined };
}

/** List only the names F.lock.<digits> and F.lock.<digits>.end beside the file; every other name is ignored. */
function list(file: string): Listing {
  const locks = new Set<number>();
  const ends = new Set<number>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.dirname(file));
  } catch { /* no folder, no lock */ }
  for (const name of names) {
    const parsed = parseName(file, name);
    if (parsed !== null) (parsed.end ? ends : locks).add(parsed.g);
  }
  let highest = 0;
  for (const g of locks) if (g > highest) highest = g;
  return { locks, ends, highest };
}

/** Create a file exclusively, text inside; false when the name is taken (or, on Windows, is being deleted or scanned: taken as held). */
function createExclusive(target: string, text: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(target, 'wx');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (process.platform === 'win32' && busyCode(code)) return false;
    throw e;
  }
  try {
    if (text !== '') fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** End generation g: create its marker; an existing marker is the same outcome. A failure is left to the age rule. */
function endGeneration(file: string, g: number): void {
  try {
    createExclusive(`${lockPathOf(file, g)}.end`, '');
  } catch { /* the lock goes stale and is reclaimed by age */ }
}

interface Judgement {
  holder: LockHolder | null;
  ageMs: number;
  state: FileLockInspection['state'];
  breaks: boolean;
}

/** Judge the live generation g from its file; null when the file cannot be found. */
function judge(file: string, g: number, o: FileLockOptions): Judgement | null {
  const limits = limitsOf(o);
  const now = (o.now ?? Date.now)();
  const lockFile = lockPathOf(file, g);
  let text: string;
  let age: number;
  try {
    text = fs.readFileSync(lockFile, 'utf8');
    age = now - fs.statSync(lockFile).mtimeMs;
  } catch (e) {
    // Gone, or refused for a moment: not judged, the caller looks again.
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : { holder: null, ageMs: 0, state: 'unreadable', breaks: false };
  }
  const holder = parseHolder(text);
  if (holder === null) return { holder, ageMs: age, state: 'unreadable', breaks: age > limits.graceMs };
  const here = o.here ?? currentHolder(now);
  if (!holderIsLocal(holder, here)) return { holder, ageMs: age, state: 'remote', breaks: age > limits.staleMs };
  if (holder.pid === here.pid) {
    // This process cannot be writing elsewhere (synchronous): its own file is live unless the caller counts no hold of it.
    const leftover = o.ownLeftover?.() ?? false;
    return { holder, ageMs: age, state: leftover ? 'gone' : 'live', breaks: leftover || age > limits.staleMs };
  }
  const alive = pidAlive(holder.pid);
  return { holder, ageMs: age, state: alive ? 'live' : 'gone', breaks: !alive || age > limits.staleMs };
}

/**
 * The live generation of the lock of `file` (the highest, with no end marker)
 * as it stands, or null when there is none. Reads only: nothing is reclaimed.
 */
export function inspectFileLock(file: string, options: FileLockOptions = {}): FileLockInspection | null {
  const listing = list(file);
  const g = listing.highest;
  if (g === 0 || listing.ends.has(g)) return null;
  const j = judge(file, g, options);
  if (j === null) return null;
  return { lockFile: lockPathOf(file, g), generation: g, holder: j.holder, ageMs: j.ageMs, state: j.state, breaks: j.breaks };
}

/** Best effort after a held lock: the files of generations below g, and a legacy single-file F.lock older than the stale age. */
function cleanup(file: string, g: number, o: FileLockOptions): void {
  const dir = path.dirname(file);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch { return; }
  for (const name of names) {
    const parsed = parseName(file, name);
    if (parsed === null || parsed.g >= g) continue;
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* EPERM, EACCES, EBUSY on Windows, or anything else: cleanup never fails an acquire */ }
  }
  const legacy = `${file}.lock`;
  try {
    const now = (o.now ?? Date.now)();
    if (now - fs.statSync(legacy).mtimeMs > limitsOf(o).staleMs) fs.unlinkSync(legacy);
  } catch { /* none, or not removable now */ }
}

/**
 * Take the write lock of `file`, waiting up to the wait limit; throws (and
 * the caller's change never runs) when it is not obtained.
 */
export function acquireFileLock(file: string, options: FileLockOptions = {}): FileLockHandle {
  const o = options;
  const limits = limitsOf(o);
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? sleepSync;
  const deadline = now() + limits.waitMs;
  const nonce = Math.random().toString(36).slice(2);
  const timeout = (g: number): Error => {
    const lockFile = lockPathOf(file, g);
    let holder: LockHolder | null = null;
    try { holder = parseHolder(fs.readFileSync(lockFile, 'utf8')); } catch { /* none */ }
    const info: LockTimeout = {
      file,
      lockFile,
      waitMs: limits.waitMs,
      holder,
      remote: holder !== null && !holderIsLocal(holder, o.here ?? currentHolder(now())),
    };
    return o.timeoutError?.(info)
      ?? new Error(`${file} is being written by another process for over ${limits.waitMs / 1000}s (${lockFile}). Nothing was written; try again.`);
  };
  for (;;) {
    const listing = list(file);
    const m = listing.highest;
    o.at?.('listed', m);
    if (m > 0 && !listing.ends.has(m)) {
      const j = judge(file, m, o);
      o.at?.('judged', m);
      if (j !== null && j.breaks) {
        endGeneration(file, m);
        continue;
      }
      if (now() > deadline) throw timeout(m);
      sleep(10 + Math.floor(Math.random() * 20));
      continue;
    }
    const g = m + 1;
    const lockFile = lockPathOf(file, g);
    const here = o.here ?? currentHolder(now());
    let made: boolean;
    try {
      made = createExclusive(lockFile, serializeHolder({ ...here, takenAt: now() }, nonce));
    } catch (e) {
      // A record that could not be written leaves no live lock: end the generation.
      endGeneration(file, g);
      throw e;
    }
    if (!made) {
      if (now() > deadline) throw timeout(m);
      continue;
    }
    o.at?.('created', g);
    const again = list(file);
    o.at?.('relisted', g);
    if (again.highest > g) {
      // Free only because a later generation's cleanup removed it while this process was stalled: never hold it.
      endGeneration(file, g);
      continue;
    }
    cleanup(file, g, o);
    return { file, generation: g, lockFile, endFile: `${lockFile}.end`, nonce, options: o };
  }
}

/**
 * Throw the error that abandons a write when the holder's generation was ended by somebody else (a reclaimer took the lock as stale).
 * A generation whose lock file is gone was ended too: only a later holder's cleanup removes a lower generation, and one exists only once it is over.
 */
export function assertLockHeld(handle: FileLockHandle): void {
  if (fs.existsSync(handle.endFile) || !fs.existsSync(handle.lockFile)) {
    throw new Error(
      `${handle.file}: the write lock (${handle.lockFile}) was reclaimed as stale while this write was held up, `
      + 'so the write is abandoned and nothing was written. Try again.',
    );
  }
}

/** Release: create the generation's end marker (an existing one means a reclaimer ended it already). Nothing is deleted. */
export function releaseFileLock(handle: FileLockHandle): void {
  // A generation a later holder's cleanup already removed is over: no marker is left behind for it.
  if (!fs.existsSync(handle.lockFile)) return;
  endGeneration(handle.file, handle.generation);
}

/**
 * file_write_lock.run — run `change` holding the write lock of `file`: no
 * other process reads and writes the file in between. The lock is released
 * also when `change` throws. Just before replaceFile renames the data file
 * into place the holder checks its generation was not reclaimed and abandons
 * the write with an error naming the reclaim if it was. Throws after a
 * bounded wait, the change never run. Answers what the change answers.
 */
export function withFileLock<T>(file: string, change: () => T, options: FileLockOptions = {}): T {
  const handle = acquireFileLock(file, options);
  const displaced = setPreRenameCheck(file, () => assertLockHeld(handle));
  try {
    return change();
  } finally {
    setPreRenameCheck(file, displaced);
    releaseFileLock(handle);
  }
}
