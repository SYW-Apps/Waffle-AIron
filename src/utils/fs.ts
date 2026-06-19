import * as fs from 'fs';
import * as path from 'path';

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

/** Override the project root. Pass an absolute path to the dir containing .wai/,
 *  or null to clear the override and fall back to process.cwd(). */
export function setProjectRoot(dir: string | null): void {
  projectRootOverride = dir === null ? null : path.resolve(dir);
}

/** The resolved project root: the explicit override if set, else process.cwd(). */
export function getProjectRoot(): string {
  return projectRootOverride ?? process.cwd();
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
  const waiPath = fromProjectRoot('.wai');
  const waiironPath = fromProjectRoot('.wairon');

  const base =
    !fs.existsSync(waiPath) && fs.existsSync(waiironPath) ? '.wairon' : '.wai';

  return fromProjectRoot(base, ...segments);
}
