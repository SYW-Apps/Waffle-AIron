import * as fs from 'fs';
import * as path from 'path';
import { listFilesRecursive } from '../utils/fs.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';

// ---------------------------------------------------------------------------
// The spec tree's file face (spec_file_store).
//
// This module exists because the spec tree's STORAGE FORMAT is a decision the
// design owns, and a decision needs one place to live. Underneath it today are
// the project's general-purpose YAML and directory helpers — but those are
// infrastructure the whole codebase shares (project.yaml, pack manifests,
// templates, variants, surface snapshots and the registry all read YAML), and
// nothing about them is spec-aware. Pointing the store at them claimed two
// utility modules whole and made nineteen unrelated importers read as
// consumers of a Repository-private Store.
//
// So the store is these four functions and nothing else: every read, write,
// walk and DELETE of a spec document goes through here, and the format — YAML,
// with `.yaml` on disk — is chosen here once. Callers above this line address
// spec documents by path; callers below it know nothing about specs.
//
// Path resolution is deliberately NOT here. A spec path is resolved by the
// caller (AI_PATHS / aiPathsAt), because the store reads spec documents out of
// other project roots too — a chaining parent's tree, a mounted child's — and
// a store bound to one specs directory could not do that.
// ---------------------------------------------------------------------------

/** The extension a spec document carries on disk — the format decision, once. */
const SPEC_FILE_EXTENSION = '.yaml';

/**
 * Read and parse the spec document at `specPath`.
 * Returns null when the file is absent; throws on malformed content.
 */
export function readSpecFile(specPath: string): unknown {
  return readYamlFile(specPath);
}

/**
 * Serialize `document` in the spec storage format and write it to `specPath`,
 * creating parent directories as needed.
 */
export function writeSpecFile(specPath: string, document: unknown): void {
  writeYamlFile(specPath, document);
}

/**
 * Every spec document under `specsDir`, recursively.
 * An absent directory yields an empty list rather than an error.
 */
export function listSpecFiles(specsDir: string): string[] {
  return listFilesRecursive(specsDir, SPEC_FILE_EXTENSION);
}

/**
 * Delete the spec document at `specPath` and prune the parent directories the
 * deletion emptied, stopping at `specsRoot` so the root itself survives an
 * emptied tree. Answers false when there was no document there, so a caller can
 * tell "deleted" from "was never there" without a second existence check.
 *
 * `specsRoot` is a parameter for the same reason a path is: the store is
 * PATH-ADDRESSED, not root-bound, and the specs directory is configurable
 * (`paths.specsDir`), so the boundary cannot be derived from the path and the
 * store is the one component that must never read project.yaml to find it.
 */
export function removeSpecFile(specPath: string, specsRoot: string): boolean {
  if (!fs.existsSync(specPath)) return false;
  fs.unlinkSync(specPath);
  pruneEmptyDirs(path.dirname(specPath), path.resolve(specsRoot));
  return true;
}

// ---------------------------------------------------------------------------
// The tree's write lock — one lock file per project tree, across processes.
//
// Two sessions (two MCP servers, a session and its delegated subagents)
// writing the same spec within milliseconds both read the file, both merged
// their delta and both wrote: the second write silently replaced the first,
// and both answered "Updated". A write is a read-modify-write of the tree, so
// it is serialized here: `wx` creates the lock file exclusively, which every
// platform — Windows included — makes atomic. The holder writes its pid and the
// time; a lock whose holder is gone, or older than any write could take, is
// broken. Holds are counted per process, so a write path that calls another
// never waits on itself.
// ---------------------------------------------------------------------------

/** The lock file of a project's tree. Not a spec document: the tree walk never lists it. */
const LOCK_FILE = '.spec-write.lock';
/** A held lock older than this is a crashed writer's, never a live write. */
const LOCK_STALE_MS = 60_000;
/** How long a writer waits for another before it gives up, naming the holder. */
const LOCK_WAIT_MS = 30_000;
/** The holds this process has on each lock file, by path. */
const lockHolds = new Map<string, number>();

/** Sleep the calling thread without spinning: the write tools are synchronous end to end. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Whether a process of that id is alive on this machine (a permission refusal means it is). */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The holder a lock file names, or null when it cannot be read (a holder mid-write reads as live). */
function lockHolder(file: string): { pid: number; at: number } | null {
  try {
    const [pid, at] = fs.readFileSync(file, 'utf8').split('\n');
    // A holder caught between creating the file and writing into it is live.
    if (!/^\d+$/.test(pid ?? '') || !/^\d+$/.test(at ?? '')) return null;
    return { pid: Number(pid), at: Number(at) };
  } catch {
    return null;
  }
}

/**
 * spec_file_store.lockTree — take the write lock of the spec tree under
 * `root`, waiting for another holder; reentrant within this process. A root
 * holding no .wai folder has no tree to guard.
 */
export function lockTree(root: string): void {
  const dir = path.join(root, '.wai');
  if (!fs.existsSync(dir)) return;
  const file = path.join(dir, LOCK_FILE);
  const held = lockHolds.get(file) ?? 0;
  if (held > 0) {
    lockHolds.set(file, held + 1);
    return;
  }
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!tryCreateLock(file)) {
    if (breakStaleLock(file)) continue;
    if (Date.now() > deadline) {
      throw new Error(
        `spec-tree-locked: another session (process ${lockHolder(file)?.pid ?? 'unknown'}) has been writing this project's specs for over ${LOCK_WAIT_MS / 1000}s `
        + `(${file}). Nothing was written. Try again once it finishes; a lock left by a process that is gone is broken automatically.`,
      );
    }
    sleepSync(15 + Math.floor(Math.random() * 20));
  }
  lockHolds.set(file, 1);
}

/** How long ago the lock file was last written; 0 when it is gone. */
function lockAge(file: string): number {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Create the lock file exclusively, holder and time inside; false when another holds it. */
function tryCreateLock(file: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    fs.writeSync(fd, `${process.pid}\n${Date.now()}\n`);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/**
 * Remove a stale lock and answer whether it did: its holder is gone, it is
 * older than any write, or it is this process's own while no hold of it is
 * counted (a leftover, never a write under way — this thread is the only one
 * that could be making it). A lock whose holder cannot be read yet is live.
 */
function breakStaleLock(file: string): boolean {
  const holder = lockHolder(file);
  const stale = holder === null
    ? lockAge(file) > LOCK_STALE_MS
    : holder.pid === process.pid || !processAlive(holder.pid) || Date.now() - holder.at > LOCK_STALE_MS;
  if (!stale) return false;
  try { fs.unlinkSync(file); } catch { /* another waiter broke it first */ }
  return true;
}

/** spec_file_store.unlockTree — release one hold; the last removes the lock file, when this process holds it. */
export function unlockTree(root: string): void {
  const file = path.join(root, '.wai', LOCK_FILE);
  const held = lockHolds.get(file) ?? 0;
  if (held <= 0) return;
  if (held > 1) {
    lockHolds.set(file, held - 1);
    return;
  }
  lockHolds.delete(file);
  if (lockHolder(file)?.pid !== process.pid) return;
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

/** Remove each empty directory from `dir` upward, stopping before `specsRoot`. */
function pruneEmptyDirs(dir: string, specsRoot: string): void {
  let at = dir;
  while (at !== specsRoot && at.startsWith(specsRoot)) {
    if (!fs.existsSync(at) || fs.readdirSync(at).length > 0) return;
    fs.rmdirSync(at);
    at = path.dirname(at);
  }
}
