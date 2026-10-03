import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';

// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------

/**
 * Ensure a directory exists, creating it (and parents) if needed.
 */
export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Write a file, ensuring the parent directory exists first.
 */
export function writeFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Write a file only if the content differs from what is already on disk.
 * Returns true if the file was written (new or changed), false if unchanged.
 */
export function writeFileIfChanged(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing === content) return false;
  }
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
  return true;
}

/**
 * Read a file as a string, or return null if it doesn't exist.
 */
export function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Check whether a path exists.
 */
export function pathExists(targetPath: string): boolean {
  return fs.existsSync(targetPath);
}

/**
 * Whether `target` lies outside the directory `root` — lexically, after both
 * are resolved. A write there touches state no single project owns (a user's
 * home configuration, a sibling checkout), which is why a project-scoped
 * command lists such writes and asks before making them.
 */
export function isOutsideRoot(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/**
 * Copy `file` beside itself as `<file>.wairon-backup-<timestamp>` and answer
 * the copy's path — the previous value of a file wairon is about to replace
 * outside the project, kept so the replacement can always be undone. The
 * timestamp is the ISO instant with `:` and `.` made filename-safe.
 */
export function backupBeside(file: string, at: Date = new Date()): string {
  const backup = `${file}.wairon-backup-${at.toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, backup);
  return backup;
}

/**
 * List all files (non-recursively) in a directory with a given extension.
 * Returns an empty array if the directory does not exist.
 */
export function listFiles(dirPath: string, ext: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath)
    .filter((f) => f.endsWith(ext))
    .map((f) => path.join(dirPath, f));
}

/**
 * List all files recursively in a directory with a given extension.
 * Returns an empty array if the directory does not exist.
 */
export function listFilesRecursive(dirPath: string, ext: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      files.push(fullPath);
    }
  }
  return files;
}

// The project root defaults to the cwd, but can be overridden — notably by the
// MCP server, which a host (e.g. Antigravity) may launch with an unrelated cwd.
let projectRootOverride: string | null = null;

// Request-scoped project root for the hosting server (sdd_host). A single
// process serves many fully-isolated projects concurrently, so the active root
// must live per async context, not in the process-global override above (which
// concurrent requests would race). getProjectRoot() consults this FIRST, so the
// entire existing flat spec/config API becomes request-scoped with no changes to
// its call sites. Stdio/CLI paths set no scope and fall through to the override.
//
// A hosted request also carries its REACH: the top project's root, and whether
// the credential is authorized for that top project. A chained child's verdict
// can be resolved through its parent tree, and a token narrowed to the child
// must not learn what the parent contains that way.
interface RequestScope {
  root: string;
  topRoot?: string;
  parentReach?: boolean;
  /**
   * True when the caller narrowed the ceiling itself (a family run that did not
   * ask for --family): the family may continue above topRoot, so a climb that
   * stops there has not read the family whole.
   */
  narrowed?: boolean;
  /**
   * Hosted: the roots of family records the request may NOT write (each judged
   * through its own permission chain). A family migration whose plan writes one
   * of them refuses family-partial.
   */
  unwritableRoots?: string[];
  /**
   * Hosted: the record lookup an external's `source.hosted` resolves through —
   * the root of a hosted record the request may read, or null for one it may
   * not (unknown and unreadable alike). Absent outside a hosted request, where a
   * hosted source is unavailable.
   */
  hostedLookup?: HostedRecordLookup;
  /**
   * Hosted: what the request may change — the family roots it may not write at
   * the project rung, and the subsystems decided at their own rung. The spec
   * writers judge every spec against it; absent outside a hosted request.
   */
  writeReach?: WriteReach;
}

/**
 * One subsystem of a bound project root whose write permission was decided at
 * its own rung (write_reach / subsystem_write_rule): every subsystem not listed
 * is writable exactly when its root is.
 */
export interface SubsystemWriteRule {
  /** The project root (a hosted record's root) the subsystem belongs to. */
  root: string;
  /** The subsystem's local id in that root's tree, a part's subsystems included. */
  subsystemId: string;
  writable: boolean;
  /** The rung that decided it, in words a refusal can quote. */
  decidedBy: string;
}

/** What a hosted request may change, as its binding carries it to every writer of the bound tree and its family. */
export interface WriteReach {
  /** Roots of family records whose project rung does not give the request project:write. */
  unwritableRoots: string[];
  /** The subsystems decided at their own rung, writable or not. */
  subsystems: SubsystemWriteRule[];
}

const sameRoot = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);

/**
 * write_reach.permits — whether a spec owned by this subsystem of this root
 * (null for a spec of no subsystem: the L0, a system-level type, project
 * configuration) may be changed: a subsystem decided at its own rung answers
 * with its own writable; anything else is writable exactly when its root is.
 */
export function writeReachPermits(reach: WriteReach, root: string, subsystemId: string | null): boolean {
  const own = subsystemId === null ? undefined : reach.subsystems.find((s) => s.subsystemId === subsystemId && sameRoot(s.root, root));
  if (own) return own.writable;
  return !reach.unwritableRoots.some((r) => sameRoot(r, root));
}

/** write_reach.denials — the subsystems of this root the request may not change. */
export function writeReachDenials(reach: WriteReach, root: string): SubsystemWriteRule[] {
  return reach.subsystems.filter((s) => !s.writable && sameRoot(s.root, root));
}

/** The write reach of the current hosted request, or null outside one. */
export function getWriteReach(): WriteReach | null {
  return requestRootStore.getStore()?.writeReach ?? null;
}

/** A hosted record id to the root of a record the request may read; null for any other id. */
export type HostedRecordLookup = (recordId: string) => string | null;

const requestRootStore = new AsyncLocalStorage<RequestScope>();

/**
 * The active root BINDING itself — a fresh object for every runWithProjectRoot /
 * runWithProjectBinding call, undefined outside one. Its identity is what says
 * "a caller just bound this root", which the spec index uses to re-read a tree
 * as it is now on the first read of each binding.
 */
export function currentRootBinding(): object | undefined {
  return requestRootStore.getStore();
}

/** Run `fn` with `dir` as the active project root for the current async context
 *  (and everything it awaits). The hosting server wraps each request in this so
 *  its sdd_* handlers resolve to the authenticated project's .wai/ tree without a
 *  mutable global. A nested rebinding keeps the reach of the request it runs
 *  inside, so rebinding can never lend a narrowed credential more than it had. */
export function runWithProjectRoot<T>(dir: string, fn: () => T): T {
  return requestRootStore.run({ ...requestRootStore.getStore(), root: path.resolve(dir) }, fn);
}

/** Bind a hosted request's root together with its reach (see RequestScope). */
export function runWithProjectBinding<T>(
  dir: string,
  reach: { topRoot: string; parentReach: boolean; narrowed?: boolean; unwritableRoots?: string[]; hostedLookup?: HostedRecordLookup; writeReach?: WriteReach },
  fn: () => T,
): T {
  return requestRootStore.run(
    {
      root: path.resolve(dir), topRoot: path.resolve(reach.topRoot), parentReach: reach.parentReach,
      ...(reach.narrowed ? { narrowed: true } : {}),
      ...(reach.unwritableRoots ? { unwritableRoots: reach.unwritableRoots.map((r) => path.resolve(r)) } : {}),
      ...(reach.hostedLookup ? { hostedLookup: reach.hostedLookup } : {}),
      ...(reach.writeReach ? { writeReach: reach.writeReach } : {}),
    },
    fn,
  );
}

/** The hosted record lookup of the current request, or null outside a hosted request. */
export function getHostedLookup(): HostedRecordLookup | null {
  return requestRootStore.getStore()?.hostedLookup ?? null;
}

/**
 * Run `fn` with the current binding's hosted record lookup replaced — a
 * rehearsal answers a record at its image in the copy. Outside a hosted
 * request (no lookup to replace) `fn` runs unchanged: replacing nothing can
 * never lend a request a lookup it did not have.
 */
export function runWithHostedLookup<T>(lookup: HostedRecordLookup, fn: () => T): T {
  const scope = requestRootStore.getStore();
  if (!scope?.hostedLookup) return fn();
  return requestRootStore.run({ ...scope, hostedLookup: lookup }, fn);
}

/** The request-scoped root if one is bound, else null. */
export function getRequestProjectRoot(): string | null {
  return requestRootStore.getStore()?.root ?? null;
}

/** The current hosted request's reach, or null outside a hosted request binding. */
export function getRequestParentReach(): { topRoot?: string; parentReach: boolean; narrowed?: boolean; unwritableRoots?: string[] } | null {
  const scope = requestRootStore.getStore();
  if (!scope || scope.parentReach === undefined) return null;
  return {
    topRoot: scope.topRoot, parentReach: scope.parentReach,
    ...(scope.narrowed ? { narrowed: true } : {}),
    ...(scope.unwritableRoots ? { unwritableRoots: scope.unwritableRoots } : {}),
  };
}

/** Override the project root. Pass an absolute path to the dir containing .wai/,
 *  or null to clear the override and fall back to process.cwd(). */
export function setProjectRoot(dir: string | null): void {
  projectRootOverride = dir === null ? null : path.resolve(dir);
}

/** Get the raw project root override value (or null if none set) */
export function getProjectRootOverride(): string | null {
  return projectRootOverride;
}

/**
 * Walk up from startDir to the nearest ancestor containing a wairon project
 * with system.yaml in its specs folder. Returns null if none is found.
 */
export function findSystemRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const isWai = fs.existsSync(path.join(dir, '.wai'));
    const isWairon = !isWai && fs.existsSync(path.join(dir, '.wairon'));
    const base = isWai ? '.wai' : (isWairon ? '.wairon' : null);
    if (base) {
      if (fs.existsSync(path.join(dir, base, 'specs', '.index.yaml')) || fs.existsSync(path.join(dir, base, 'specs', 'system.yaml'))) {
        return dir;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The resolved project root: the request-scoped root if bound (hosting server),
 *  else the explicit override if set, else the resolved system root, else cwd. */
export function getProjectRoot(): string {
  const scoped = requestRootStore.getStore()?.root;
  if (scoped) return scoped;
  if (projectRootOverride) return projectRootOverride;
  const systemRoot = findSystemRoot(process.cwd());
  return systemRoot ?? process.cwd();
}

/**
 * Resolve a path relative to the project root (override if set, else cwd).
 */
export function fromProjectRoot(...segments: string[]): string {
  return path.resolve(getProjectRoot(), ...segments);
}

/**
 * Walk up from startDir to the nearest ancestor containing a wairon project
 * marker (.wai/ or legacy .wairon/). Returns null if none is found.
 */
export function findProjectRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fs.existsSync(path.join(dir, '.wai')) || fs.existsSync(path.join(dir, '.wairon'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Return the path to the wairon project directory (.wai/).
 *
 * Resolution order:
 *   1. .wai/    — primary (new projects)
 *   2. .wairon/ — legacy fallback (older installs)
 *
 * If neither exists (e.g. during `wairon init`), defaults to .wai/.
 */
export function aiDir(...segments: string[]): string {
  return aiDirAt(getProjectRoot(), ...segments);
}

/**
 * The same resolution against an EXPLICIT root — how one project reads another's
 * `.wai` (a parent resolving a chained child's lock, say). Kept here with
 * `aiDir` so the `.wai` / legacy `.wairon` choice is made in exactly one place.
 */
export function aiDirAt(root: string, ...segments: string[]): string {
  const waiPath = path.join(root, '.wai');
  const waironPath = path.join(root, '.wairon');
  const base = !fs.existsSync(waiPath) && fs.existsSync(waironPath) ? waironPath : waiPath;
  return path.join(base, ...segments);
}
