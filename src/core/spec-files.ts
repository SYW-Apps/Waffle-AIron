import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installTreeFileGuard, listFilesRecursive, removeFile } from '../utils/fs.js';
import { SpecWriteConflictError } from '../utils/errors.js';
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
  removeFile(specPath);
  pruneEmptyDirs(path.dirname(specPath), path.resolve(specsRoot));
  return true;
}

// ---------------------------------------------------------------------------
// The tree's write lock — one lock file per project tree, across processes.
//
// Two sessions (two MCP servers, a session and its delegated subagents, an
// assistant and a human's CLI rename) writing the same spec within
// milliseconds both read the file, both merged their change and both wrote:
// the second write silently replaced the first, and both answered "Updated".
// So every write into a .wai tree is serialized here: `wx` creates the lock
// file exclusively, which every platform — Windows included — makes atomic.
// The holder writes its pid, the time and its host; a lock whose holder is
// gone, older than any write could take, or unreadable past a short grace, is
// broken. Only a holder on this host can be seen to be gone: one on another
// host sharing the volume holds until its lock is stale.
// Holds are counted per process, so a write path that calls another never
// waits on itself.
//
// A lock alone serializes the writes, not what each writer READ before it
// wrote: a CLI command reads the tree, computes, and only then writes. So the
// store remembers, per spec document, the bytes this process last read or
// wrote, and a write of a document that changed on disk since then — another
// session's write landed in between — is refused instead of replacing it. A
// session-wide tool (an MCP write) takes the lock BEFORE it reads, so it never
// meets that refusal; a one-shot writer that lost the race is told to run again.
//
// The lock is taken at the lowest seam every writer shares: the file helper
// (src/utils/fs.ts) calls the guard this module installs before any write,
// rename or delete inside a .wai tree — the store's own writes, the core's raw
// rewrites, migrations, doctor --fix and the hosted server alike.
// ---------------------------------------------------------------------------

/** The lock file of a project's tree. Not a spec document: the tree walk never lists it. */
const LOCK_FILE = '.spec-write.lock';
/** A held lock older than this is a crashed writer's, never a live write. */
const LOCK_STALE_MS = 60_000;
/** A lock file whose holder cannot be read is a writer caught between creating and filling it — for milliseconds, never this long. */
const LOCK_UNREADABLE_GRACE_MS = 10_000;
/** How long a writer waits for another before it gives up, naming the holder. */
const LOCK_WAIT_MS = 30_000;
/** The holds this process has on each lock file, by normalized path. */
const lockHolds = new Map<string, number>();
/** What this process last read or wrote of each spec document, by normalized path: a digest of the text. */
const seenDocuments = new Map<string, string>();
/** Past this many remembered documents the memory is cleared: forgetting only ever skips a check, never refuses a write. */
const SEEN_LIMIT = 50_000;

/** One path as the platform compares it: resolved, and case-folded where the filesystem folds case. */
function normalized(p: string): string {
  // The real path of the folder, so a short (8.3) name, a junction or another
  // spelling of one folder keys one lock.
  const resolved = path.resolve(p);
  const real = path.join(realFolder(path.dirname(resolved)), path.basename(resolved));
  return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
}

/** The real paths of folders already met: every write asks again, and a realpath is a syscall each. */
const realFolders = new Map<string, string>();

/** A folder's real path — its nearest existing ancestor's, the rest as spelled — remembered once it exists. */
function realFolder(dir: string): string {
  const known = realFolders.get(dir);
  if (known !== undefined) return known;
  let real: string;
  try {
    real = fs.realpathSync.native(dir);
  } catch {
    const parent = path.dirname(dir);
    return parent === dir ? dir : path.join(realFolder(parent), path.basename(dir));
  }
  if (realFolders.size >= 10_000) realFolders.clear();
  realFolders.set(dir, real);
  return real;
}

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

/**
 * The holder a lock file names, or null when it cannot be read (absent,
 * foreign, or a holder mid-write). `host` is the machine it was taken on; a
 * file an older wairon wrote names none and is read as this machine's.
 */
function lockHolder(file: string): { pid: number; at: number; host?: string } | null {
  try {
    const [pid, at, host] = fs.readFileSync(file, 'utf8').split('\n');
    if (!/^\d+$/.test(pid ?? '') || !/^\d+$/.test(at ?? '')) return null;
    return { pid: Number(pid), at: Number(at), ...(host ? { host } : {}) };
  } catch {
    return null;
  }
}

/**
 * Whether the holder runs on this machine. A process id means nothing on
 * another host (or in another container's process namespace on a shared
 * volume), so only a local holder's liveness can be checked; a remote one
 * holds until its lock is stale.
 */
function holderIsLocal(holder: { host?: string }): boolean {
  return holder.host === undefined || holder.host === os.hostname();
}

/** Whether the holder is a live process: a remote holder is taken as live. */
function holderAlive(holder: { pid: number; host?: string }): boolean {
  return holderIsLocal(holder) ? processAlive(holder.pid) : true;
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
  const key = normalized(file);
  const held = lockHolds.get(key) ?? 0;
  if (held > 0) {
    lockHolds.set(key, held + 1);
    return;
  }
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!tryCreateLock(file)) {
    if (breakStaleLock(file, key)) continue;
    if (Date.now() > deadline) {
      const holder = lockHolder(file);
      throw new Error(
        `spec-tree-locked: another session (process ${holder?.pid ?? 'unknown'}) has been writing this project's specs for over ${LOCK_WAIT_MS / 1000}s `
        + `(${file}). Nothing was written. Try again once it finishes; a lock left by a process that is gone, or one wairon cannot read that is older than `
        + `${LOCK_UNREADABLE_GRACE_MS / 1000}s, is broken automatically — \`wairon doctor\` names the lock and its holder.`,
      );
    }
    sleepSync(15 + Math.floor(Math.random() * 20));
  }
  lockHolds.set(key, 1);
}

/** Remove a lock file this process holds or failed to fill; already gone is no error, and a failure only leaves a lock the next writer breaks. */
function removeLockFile(file: string): void {
  try { fs.rmSync(file, { force: true }); } catch { /* the next writer breaks it: this process holds no count of it */ }
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
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    // Windows: the file another holder just released is still being deleted
    // (a delete pending), or a scanner holds it — taken as held, and waited for.
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) return false;
    throw e;
  }
  try {
    fs.writeSync(fd, `${process.pid}\n${Date.now()}\n${os.hostname()}\n`);
  } catch (e) {
    // A lock this process could not fill is no lock: never leave it behind.
    fs.closeSync(fd);
    removeLockFile(file);
    throw e;
  }
  fs.closeSync(fd);
  return true;
}

/**
 * Whether the next writer breaks a lock file instead of waiting: its holder
 * is gone, it is older than any write, it is this process's own while no hold
 * of it is counted (a leftover — this thread is the only one that could be
 * writing it), or it cannot be read and is older than the grace a holder
 * caught between creating and filling it needs.
 */
function lockBreakable(file: string, key: string): boolean {
  const holder = lockHolder(file);
  if (holder === null) return lockAge(file) > LOCK_UNREADABLE_GRACE_MS;
  if (holderIsLocal(holder) && holder.pid === process.pid) return (lockHolds.get(key) ?? 0) === 0;
  return !holderAlive(holder) || Date.now() - holder.at > LOCK_STALE_MS;
}

/** Remove a breakable lock and answer whether it did. */
function breakStaleLock(file: string, key: string): boolean {
  if (!lockBreakable(file, key)) return false;
  try { fs.unlinkSync(file); } catch { /* another waiter broke it first */ }
  return true;
}

/** spec_file_store.unlockTree — release one hold; the last removes the lock file, when this process holds it. */
export function unlockTree(root: string): void {
  const file = path.join(root, '.wai', LOCK_FILE);
  const key = normalized(file);
  const held = lockHolds.get(key) ?? 0;
  if (held <= 0) return;
  if (held > 1) {
    lockHolds.set(key, held - 1);
    return;
  }
  lockHolds.delete(key);
  const holder = lockHolder(file);
  if (holder === null || holder.pid !== process.pid || !holderIsLocal(holder)) return;
  removeLockFile(file);
}

/** What a tree's write lock file says, for `wairon doctor`. */
export interface TreeLockState {
  /** The lock file. */
  file: string;
  /** The process the file names as its holder, when it can be read. */
  pid?: number;
  /** How long ago the file was written, in milliseconds. */
  ageMs: number;
  /** live — a running process holds it; gone — its holder process has ended; unreadable — no holder can be read from it. */
  holder: 'live' | 'gone' | 'unreadable';
  /** Whether the next write breaks it instead of waiting. */
  breaks: boolean;
}

/**
 * spec_file_store.inspectLock — the write lock of the tree under `root` as
 * its file stands, or null when none is there. Reads only: a lock the next
 * write would break is named so, never removed here.
 */
export function inspectLock(root: string): TreeLockState | null {
  const file = path.join(root, '.wai', LOCK_FILE);
  if (!fs.existsSync(file)) return null;
  const holder = lockHolder(file);
  const state: TreeLockState['holder'] = holder === null ? 'unreadable' : holderAlive(holder) ? 'live' : 'gone';
  return {
    file,
    ...(holder !== null ? { pid: holder.pid } : {}),
    ageMs: lockAge(file),
    holder: state,
    breaks: lockBreakable(file, normalized(file)),
  };
}

// ---------------------------------------------------------------------------
// The guard over every .wai write, installed into the shared file helper.
// ---------------------------------------------------------------------------

/** The project root whose .wai tree holds `file` — the innermost one — or null for a file in none. */
function treeRootOf(file: string): string | null {
  const resolved = path.resolve(file);
  const at = resolved.lastIndexOf(`${path.sep}.wai${path.sep}`);
  return at < 0 ? null : resolved.slice(0, at);
}

/** Whether `file` is a spec document of a .wai tree — what the read-then-write check covers. */
function isSpecDocument(file: string): boolean {
  return file.endsWith(SPEC_FILE_EXTENSION) && path.resolve(file).includes(`${path.sep}.wai${path.sep}specs${path.sep}`);
}

/** A short digest of a document's text. */
function digestOf(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/** Remember what this process last saw of a spec document (null: it, or a folder holding documents, is gone or moved). */
function remember(file: string, text: string | null): void {
  const key = normalized(file);
  if (text === null) {
    // A file, or a whole folder renamed or removed: forget everything under it.
    seenDocuments.delete(key);
    const under = `${key}${path.sep}`;
    for (const seen of [...seenDocuments.keys()]) if (seen.startsWith(under)) seenDocuments.delete(seen);
    return;
  }
  if (!isSpecDocument(file)) return;
  if (seenDocuments.size >= SEEN_LIMIT) seenDocuments.clear();
  seenDocuments.set(key, digestOf(text));
}

/**
 * Refuse a write of a spec document whose bytes on disk are no longer the
 * ones this process last read or wrote — another session's write landed in
 * between, and this one, made from the older bytes, would silently replace
 * it. A document that is not on disk any more has no bytes to lose: writing
 * it again replaces nothing.
 */
function assertUnchangedSinceRead(file: string): void {
  if (!isSpecDocument(file)) return;
  const seen = seenDocuments.get(normalized(file));
  if (seen === undefined) return;
  let now: string;
  try {
    now = digestOf(fs.readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  if (now === seen) return;
  const shown = path.relative(process.cwd(), file) || file;
  throw new SpecWriteConflictError(
    `spec-write-conflict: ${shown} changed on disk since this session read it — another session wrote it a moment ago. `
    + 'This write was refused so that one is kept: nothing was written to the file. Run the command again; it reads the tree afresh.',
  );
}

/** Whether this process holds the lock of a tree whose root holds `root`. */
function heldAbove(root: string): boolean {
  if (lockHolds.size === 0) return false;
  for (let at = path.dirname(path.resolve(root)); at !== path.dirname(at); at = path.dirname(at)) {
    if ((lockHolds.get(normalized(path.join(at, '.wai', LOCK_FILE))) ?? 0) > 0) return true;
  }
  return false;
}

/** The guard: the tree's lock around one write (unless already held), and the read-then-write check. */
function enterWrite(file: string): () => void {
  const root = treeRootOf(file);
  if (root === null) return () => undefined;
  const key = normalized(path.join(root, '.wai', LOCK_FILE));
  // The lock file itself is never written through the helper.
  if (normalized(file) === key) return () => undefined;
  // A tree inside one this process holds (a part, a member folder a family
  // commit swaps) is covered by that hold: no lock file is made inside it,
  // so a commit that empties the folder never leaves its .wai behind.
  const took = (lockHolds.get(key) ?? 0) === 0 && !heldAbove(root);
  if (took) lockTree(root);
  try {
    assertUnchangedSinceRead(file);
  } catch (e) {
    if (took) unlockTree(root);
    throw e;
  }
  return () => {
    if (took) unlockTree(root);
  };
}

installTreeFileGuard({
  enter: enterWrite,
  noteRead: (file, text) => remember(file, text),
  noteWritten: (file, text) => remember(file, text),
});

/** Remove each empty directory from `dir` upward, stopping before `specsRoot`. */
function pruneEmptyDirs(dir: string, specsRoot: string): void {
  let at = dir;
  while (at !== specsRoot && at.startsWith(specsRoot)) {
    if (!fs.existsSync(at) || fs.readdirSync(at).length > 0) return;
    fs.rmdirSync(at);
    at = path.dirname(at);
  }
}
