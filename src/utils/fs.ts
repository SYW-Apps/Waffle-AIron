import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as yaml from 'js-yaml';

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
 * Write a file, ensuring the parent directory exists first. The text keeps the
 * file's line endings (see withLineEndings): CRLF stays CRLF, and a new file
 * follows the convention around it.
 */
export function writeFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, withLineEndings(filePath, content), 'utf-8');
}

/**
 * Write a file only if the content differs from what is already on disk.
 * Returns true if the file was written (new or changed), false if unchanged.
 * Compared after the line endings are applied, so a file differing only in
 * them is not rewritten.
 */
export function writeFileIfChanged(filePath: string, content: string): boolean {
  const text = withLineEndings(filePath, content);
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing === text) return false;
  }
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, 'utf-8');
  return true;
}

// ---------------------------------------------------------------------------
// Line endings
//
// A file wairon rewrites keeps the line endings it has: a spec, project.yaml or
// lock record checked out with CRLF (git's autocrlf on Windows, or an `eol`
// attribute) must not come back as LF, or one re-save turns every line into a
// diff. A NEW file takes the convention around it: the `eol` the nearest
// .gitattributes sets for its name, else the endings most text files beside it
// (or in the folders above it, up to the project or repository root) already
// use, else LF.
// ---------------------------------------------------------------------------

type LineEnding = '\r\n' | '\n';

/** How many bytes of a file are read to decide its line endings. */
const EOL_SAMPLE_BYTES = 64 * 1024;

/** The line endings a text uses, by majority; null when it has no line break. */
function endingsOf(text: string): LineEnding | null {
  const crlf = text.split('\r\n').length - 1;
  const lf = text.split('\n').length - 1 - crlf;
  if (crlf === 0 && lf === 0) return null;
  return crlf > lf ? '\r\n' : '\n';
}

/** The first bytes of a file as text, or null when it cannot be read. */
function sampleOf(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(EOL_SAMPLE_BYTES);
    const read = fs.readSync(fd, buffer, 0, EOL_SAMPLE_BYTES, 0);
    return buffer.subarray(0, read).toString('utf-8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Whether a .gitattributes pattern names a file (by its path relative to the attributes file's folder). */
function attributeMatches(pattern: string, relative: string): boolean {
  const glob = pattern.replace(/^\//, '');
  const target = glob.includes('/') ? relative : path.posix.basename(relative);
  const source = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${source}$`).test(target);
}

/** The `eol` one .gitattributes file sets for a file: its last matching line's, or null. */
function attributeEol(attributesFile: string, file: string): LineEnding | null {
  const text = readFileOrNull(attributesFile);
  if (text === null) return null;
  const relative = path.relative(path.dirname(attributesFile), file).split(path.sep).join('/');
  let eol: LineEnding | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [pattern, ...attrs] = line.split(/\s+/);
    if (!attributeMatches(pattern, relative)) continue;
    for (const attr of attrs) {
      if (attr === 'eol=crlf') eol = '\r\n';
      else if (attr === 'eol=lf') eol = '\n';
      else if (attr === '-text' || attr === 'binary') eol = null;
    }
  }
  return eol;
}

/** The folders a new file's convention is read from: its own, then each above it up to the project or repository root (none past it). */
function conventionFolders(dir: string): string[] {
  const folders: string[] = [];
  let at = path.resolve(dir);
  for (let depth = 0; depth < 8; depth++) {
    folders.push(at);
    if (fs.existsSync(path.join(at, '.git')) || fs.existsSync(path.join(at, '.wai'))) return folders;
    const parent = path.dirname(at);
    if (parent === at) break;
    at = parent;
  }
  // No project or repository above it: its own folder is the only convention there is.
  return folders.slice(0, 1);
}

/** The line endings most text files in one folder use (same extension first); null when none says. */
function folderEndings(folder: string, ext: string, exclude: string): LineEnding | null {
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return null;
  }
  const candidates = names
    .filter((n) => path.join(folder, n) !== exclude && /\.(ya?ml|json|md|ts|js|txt)$/i.test(n))
    .sort((a, b) => Number(path.extname(b) === ext) - Number(path.extname(a) === ext))
    .slice(0, 24);
  let crlf = 0;
  let lf = 0;
  for (const name of candidates) {
    const full = path.join(folder, name);
    try {
      if (!fs.statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    const sample = sampleOf(full);
    const endings = sample === null ? null : endingsOf(sample);
    if (endings === '\r\n') crlf++;
    else if (endings === '\n') lf++;
  }
  if (crlf === lf) return null;
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * The line endings a file is written with: an existing file's own (by
 * majority); for a new one the `eol` the nearest .gitattributes sets for it,
 * else the majority of the text files beside it or in the folders above it up
 * to the project or repository root, else LF.
 */
export function lineEndingFor(filePath: string): LineEnding {
  const own = sampleOf(filePath);
  const existing = own === null ? null : endingsOf(own);
  if (existing) return existing;
  const folders = conventionFolders(path.dirname(filePath));
  for (const folder of folders) {
    const eol = attributeEol(path.join(folder, '.gitattributes'), filePath);
    if (eol) return eol;
  }
  const ext = path.extname(filePath);
  for (const folder of folders) {
    const endings = folderEndings(folder, ext, path.resolve(filePath));
    if (endings) return endings;
  }
  return '\n';
}

/** A text with the line endings its file is written with (lineEndingFor): every break normalised, then converted. */
export function withLineEndings(filePath: string, content: string): string {
  const normalised = content.replace(/\r\n/g, '\n');
  return lineEndingFor(filePath) === '\r\n' ? normalised.replace(/\n/g, '\r\n') : normalised;
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

// ---------------------------------------------------------------------------
// Project binding — WHICH project a command acts on (the binding rule written
// down on the WaiPaths type). Every surface resolves it here: the CLI through
// getProjectRoot, the MCP server and `wairon dev` through resolveProjectBinding.
//
// From the starting folder, walk up to the nearest folder whose specs hold an
// L0. The walk never climbs past the repository root (the nearest folder
// holding `.git`) on its own: an ancestor project above it binds only when it
// DECLARES the crossing — a `members` entry whose path resolves to a folder
// that contains the starting folder and lies inside that repository. A stray
// `.wai` in a parent folder therefore binds nothing in a child repository.
// ---------------------------------------------------------------------------

/** How a project came to be bound. */
export type ProjectBindingVia = 'here' | 'ancestor' | 'declared-member';

/** project_binding — the project a folder binds to, and how. */
export interface ProjectBinding {
  /** The bound project root (absolute). */
  root: string;
  /** here: the folder itself; ancestor: a folder above it, inside its repository; declared-member: a project above the repository root that declares it. */
  via: ProjectBindingVia;
  /** The repository root the walk was bounded by, when the folder is inside one. */
  repositoryRoot?: string;
}

/** Whether a folder holds a wairon project's L0 (`.wai/specs/.index.yaml`, or the legacy `system.yaml`; `.wairon` for old installs). */
function holdsSystemSpec(dir: string): boolean {
  for (const base of ['.wai', '.wairon']) {
    const specs = path.join(dir, base, 'specs');
    if (fs.existsSync(path.join(specs, '.index.yaml')) || fs.existsSync(path.join(specs, 'system.yaml'))) return true;
    if (base === '.wai' && fs.existsSync(path.join(dir, '.wai'))) break; // .wai present: never fall back to .wairon
  }
  return false;
}

/** The nearest folder at or above startDir holding `.git` (a directory, or the file a worktree or submodule carries); null outside any repository. */
function findRepositoryRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Whether `inner` is `outer` or lies below it. */
function isAtOrBelow(outer: string, inner: string): boolean {
  const rel = path.relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The member folders a project declares in its `.wai/project.yaml`, resolved
 * against its root: path sources only (a git or hosted member lives nowhere
 * under the declaring folder). Read leniently — an unreadable configuration
 * declares nothing — because binding must never fail on someone else's file.
 */
function declaredMemberDirs(projectRoot: string): string[] {
  let parsed: unknown;
  try {
    const text = fs.readFileSync(path.join(projectRoot, '.wai', 'project.yaml'), 'utf-8');
    parsed = yaml.load(text);
  } catch {
    return [];
  }
  const members = (parsed as { members?: unknown } | null)?.members;
  if (!members || typeof members !== 'object') return [];
  const dirs: string[] = [];
  for (const value of Object.values(members as Record<string, unknown>)) {
    const declaration = value as { source?: unknown; path?: unknown } | string | null;
    const source = typeof declaration === 'string'
      ? declaration
      : typeof declaration?.source === 'string' ? declaration.source : typeof declaration?.path === 'string' ? declaration.path : undefined;
    if (!source) continue;
    const text = source.trim();
    // A git URL (scheme or scp form) or a hosted record has no folder here.
    if (text.startsWith('hosted:') || /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[\w.-]+@[\w.-]+:/.test(text) || path.isAbsolute(text)) continue;
    dirs.push(path.resolve(projectRoot, text));
  }
  return dirs;
}

/**
 * Resolve the project a folder binds to by the binding rule; null when none
 * does. Never fails: an unreadable ancestor configuration declares nothing.
 */
export function resolveProjectBinding(startDir: string): ProjectBinding | null {
  const start = path.resolve(startDir);
  const repositoryRoot = findRepositoryRoot(start) ?? undefined;
  const withRepo = (b: ProjectBinding): ProjectBinding => (repositoryRoot ? { ...b, repositoryRoot } : b);
  let dir = start;
  // Inside the repository (or anywhere, outside one): the nearest L0.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (holdsSystemSpec(dir)) return withRepo({ root: dir, via: dir === start ? 'here' : 'ancestor' });
    if (repositoryRoot && dir === repositoryRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  // Above the repository root: only a project that declares the crossing.
  dir = path.dirname(repositoryRoot!);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (holdsSystemSpec(dir)) {
      const declares = declaredMemberDirs(dir).some((member) => isAtOrBelow(repositoryRoot!, member) && isAtOrBelow(member, start));
      if (declares) return withRepo({ root: dir, via: 'declared-member' });
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The root the binding rule binds from startDir (resolveProjectBinding), or
 * null when no project binds it.
 */
export function findSystemRoot(startDir: string): string | null {
  return resolveProjectBinding(startDir)?.root ?? null;
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
