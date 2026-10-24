import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { installTreeFileGuard, listFilesRecursive, removeFile } from '../utils/fs.js';
import { acquireFileLock, inspectFileLock, releaseFileLock, type FileLockHandle, type FileLockLimits, type FileLockOptions } from '../utils/file-lock.js';
import { currentHolder, holderIsLocal, parseHolder, pidAlive, type LockHolder } from '../utils/lock-holder.js';
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
// file exclusively, which every platform — Windows included — makes atomic;
// the lock is generation-numbered (src/utils/file-lock.ts), so a reclaim of a stale
// lock can end only the generation it judged, never one a new holder took.
// The holder writes its pid, the time, its host and PID namespace; a lock whose holder is
// gone, older than any write could take, or unreadable past a short grace, is
// reclaimed. Only a holder on this host and in this PID namespace can be seen to be gone: one on
// another host or namespace sharing the volume holds until its lock is stale.
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

/**
 * The lock of a project's tree: generation files `.wai/.spec-write.lock/tree.lock.<g>`
 * and `.wai/.spec-write.lock/tree.lock.<g>.end` (src/utils/file-lock.ts), inside
 * the folder `.wai/.spec-write.lock/` (every ignore rule a tree has for the
 * old lock file covers a folder of that name). Not spec
 * documents: the tree walk never lists them. LOCK_FILE is the name that keys
 * this process's holds and the guard's skip of the lock itself.
 */
const LOCK_FILE = '.spec-write.lock';
/** The lock's name inside the folder: the generation files are tree.lock.<g>. */
const LOCK_BASE = 'tree';
/** The tree lock's wait (how long a writer waits before it gives up, naming the holder) and unreadable grace (a writer caught between creating and filling its lock file takes milliseconds, never this long). */
/** The spec-tree write lock's limits: a holder runs a whole authoring call, so they are longer than a hosted store's. */
const SPEC_TREE_LOCK_LIMITS: FileLockLimits = { staleMs: 60_000, waitMs: 30_000, graceMs: 10_000 };
const { waitMs: LOCK_WAIT_MS, graceMs: LOCK_UNREADABLE_GRACE_MS } = SPEC_TREE_LOCK_LIMITS;
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

/** The lock handles this process holds, by normalized lock key (one per held tree; a re-entrant hold only counts). */
const lockHandles = new Map<string, FileLockHandle>();

/** The lock options of the tree whose lock keys `key`: its limits, the re-entrancy count (an own file with no hold counted is a leftover), the message of a timeout. */
function treeLockOptions(key: string): FileLockOptions {
  return {
    ...SPEC_TREE_LOCK_LIMITS,
    ownLeftover: () => (lockHolds.get(key) ?? 0) === 0,
    timeoutError: (info) => {
      const where = info.holder === null
        ? 'unknown'
        : info.remote
          ? `${info.holder.pid}, on host ${info.holder.host ?? 'unknown'}${info.holder.pidNamespace ? ` in PID namespace ${info.holder.pidNamespace}` : ''}; it is broken only by age`
          : `${info.holder.pid}`;
      return new Error(
        `spec-tree-locked: another session (process ${where}) has been writing this project's specs for over ${LOCK_WAIT_MS / 1000}s `
        + `(${info.lockFile}). Nothing was written. Try again once it finishes; a lock left by a process that is gone, or one wairon cannot read that is older than `
        + `${LOCK_UNREADABLE_GRACE_MS / 1000}s, is broken automatically — \`wairon doctor\` names the lock and its holder.`,
      );
    },
  };
}

/**
 * spec_file_store.lockTree — take the write lock of the spec tree under
 * `root`, waiting for another holder; reentrant within this process. A root
 * holding no .wai folder has no tree to guard.
 */
export function lockTree(root: string): void {
  const dir = path.join(root, '.wai');
  if (!fs.existsSync(dir)) return;
  const file = path.join(dir, LOCK_FILE, LOCK_BASE);
  const key = normalized(path.join(dir, LOCK_FILE));
  const held = lockHolds.get(key) ?? 0;
  if (held > 0) {
    lockHolds.set(key, held + 1);
    return;
  }
  claimLockFolder(path.join(dir, LOCK_FILE), key);
  lockHandles.set(key, acquireFileLock(file, treeLockOptions(key)));
  lockHolds.set(key, 1);
}

/**
 * Make sure `.wai/.spec-write.lock` is a folder, created when absent and never
 * removed. A single lock FILE of that name is what a pre-6.2 wairon left: one
 * whose holder is gone, or that is older than the stale age (or unreadable past
 * the grace), is reclaimed (removed, then the folder made); a fresh one is
 * held, waited for, and after the wait the usual spec-tree-locked error names it.
 */
function claimLockFolder(folder: string, key: string): void {
  const limits = SPEC_TREE_LOCK_LIMITS;
  const deadline = Date.now() + limits.waitMs;
  for (;;) {
    let stat: fs.Stats | null = null;
    try { stat = fs.lstatSync(folder); } catch { /* absent */ }
    if (stat?.isDirectory()) return;
    if (stat === null) {
      try { fs.mkdirSync(folder, { recursive: true }); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      continue;
    }
    const age = Date.now() - stat.mtimeMs;
    let holder: LockHolder | null = null;
    try { holder = parseHolder(fs.readFileSync(folder, 'utf8')); } catch { /* unreadable */ }
    const here = currentHolder(Date.now());
    const reclaim = age > limits.staleMs
      || (holder === null ? age > limits.graceMs : holderIsLocal(holder, here) && holder.pid !== here.pid && !pidAlive(holder.pid))
      || (holder !== null && holder.pid === here.pid && (lockHolds.get(key) ?? 0) === 0);
    if (reclaim) {
      try { fs.unlinkSync(folder); } catch { /* raced or busy: look again */ }
    } else if (Date.now() > deadline) {
      throw (treeLockOptions(key).timeoutError as NonNullable<FileLockOptions['timeoutError']>)({
        file: path.join(folder, LOCK_BASE), lockFile: folder, waitMs: limits.waitMs, holder,
        remote: holder !== null && !holderIsLocal(holder, here),
      });
    } else {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.floor(Math.random() * 20));
    }
  }
}

/** spec_file_store.unlockTree — release one hold; the last ends the lock's generation, when this process holds it. */
export function unlockTree(root: string): void {
  const key = normalized(path.join(root, '.wai', LOCK_FILE));
  const held = lockHolds.get(key) ?? 0;
  if (held <= 0) return;
  if (held > 1) {
    lockHolds.set(key, held - 1);
    return;
  }
  lockHolds.delete(key);
  const handle = lockHandles.get(key);
  lockHandles.delete(key);
  if (handle !== undefined) releaseFileLock(handle);
}

/** What a tree's write lock says as it stands, for `wairon doctor` (tree_lock_state). */
export interface TreeLockState {
  /** The live generation's lock file. */
  file: string;
  /** The process the file names as its holder, when it can be read. */
  pid?: number;
  /** How long ago the file was written, in milliseconds. */
  ageMs: number;
  /** live — a running process holds it; gone — its holder process has ended; unreadable — no holder can be read from it; remote — its holder is on another host or in another PID namespace, so its liveness cannot be seen and it holds until the lock is older than any write. */
  holder: 'live' | 'gone' | 'unreadable' | 'remote';
  /** Whether the next write reclaims it (ends its generation) instead of waiting. */
  breaks: boolean;
  /** The holder identity the file names (pid, time, host and PID namespace), when it can be read. */
  identity?: LockHolder;
}

/**
 * spec_file_store.inspectLock — the write lock of the tree under `root` as
 * its live generation stands, or null when none is there. Reads only: a lock
 * the next write would reclaim is named so, never ended here.
 */
export function inspectLock(root: string): TreeLockState | null {
  const file = path.join(root, '.wai', LOCK_FILE, LOCK_BASE);
  const key = normalized(path.join(root, '.wai', LOCK_FILE));
  const found = inspectFileLock(file, treeLockOptions(key));
  if (found === null) return null;
  return {
    file: found.lockFile,
    ...(found.holder !== null ? { pid: found.holder.pid, identity: found.holder } : {}),
    ageMs: found.ageMs,
    holder: found.state,
    breaks: found.breaks,
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

/** Whether `file` is the lock or lies inside it (the lock's folder, or a pre-6.2 single file). */
function insideLock(root: string, file: string): boolean {
  const rel = path.relative(path.join(root, '.wai'), path.resolve(file)).split(path.sep);
  return rel[0] === LOCK_FILE;
}

/** The guard: the tree's lock around one write (unless already held), and the read-then-write check. */
function enterWrite(file: string): () => void {
  const root = treeRootOf(file);
  if (root === null) return () => undefined;
  const key = normalized(path.join(root, '.wai', LOCK_FILE));
  // The lock file itself is never written through the helper.
  if (normalized(file) === key || insideLock(root, file)) return () => undefined;
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
