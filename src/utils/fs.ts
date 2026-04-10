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
 * Resolve a path relative to the project root.
 * The project root is always the cwd at the time the CLI runs.
 */
export function fromProjectRoot(...segments: string[]): string {
  return path.resolve(process.cwd(), ...segments);
}

/**
 * Return the path to the .ai/ directory in the current project.
 */
export function aiDir(...segments: string[]): string {
  return fromProjectRoot('.ai', ...segments);
}
