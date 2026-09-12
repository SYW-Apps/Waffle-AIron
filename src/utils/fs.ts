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
}
const requestRootStore = new AsyncLocalStorage<RequestScope>();

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
  reach: { topRoot: string; parentReach: boolean },
  fn: () => T,
): T {
  return requestRootStore.run(
    { root: path.resolve(dir), topRoot: path.resolve(reach.topRoot), parentReach: reach.parentReach },
    fn,
  );
}

/** The request-scoped root if one is bound, else null. */
export function getRequestProjectRoot(): string | null {
  return requestRootStore.getStore()?.root ?? null;
}

/** The current hosted request's reach, or null outside a hosted request binding. */
export function getRequestParentReach(): { topRoot?: string; parentReach: boolean } | null {
  const scope = requestRootStore.getStore();
  if (!scope || scope.parentReach === undefined) return null;
  return { topRoot: scope.topRoot, parentReach: scope.parentReach };
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
