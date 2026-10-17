// ---------------------------------------------------------------------------
// mcp_build_adapter — the wairon build a running MCP server was started from,
// as it now stands on disk.
//
// A long-running MCP server keeps the Zod schemas it was started with. After a
// rebuild, a write through the OLD process silently strips every field a newer
// schema added — that destroyed spec data three times. This module is the only
// I/O the guard needs: a stamp of the entry file, whether it changed, and the
// schema fingerprint the build on disk computes for ITSELF, read in a child
// process so this process never loads a second copy of wairon and never
// mistakes its own in-memory schemas for the new ones.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { isNewerVersion } from '../utils/version.js';

export interface BuildStamp {
  path: string;
  mtimeMs: number;
  size: number;
}

/** Stamp a build entry file; null when it cannot be stat'd (e.g. pkg snapshot fs). */
export function captureBuildStamp(entryPath: string): BuildStamp | null {
  try {
    const s = fs.statSync(entryPath);
    return { path: entryPath, mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/** True once the stamped entry file changed on disk (rebuild/update since start). */
export function isBuildStale(stamp: BuildStamp | null): boolean {
  if (!stamp) return false;
  try {
    const s = fs.statSync(stamp.path);
    return s.mtimeMs !== stamp.mtimeMs || s.size !== stamp.size;
  } catch {
    return false;
  }
}

/**
 * One answer per on-disk version of an entry file. A rebuild changes the key,
 * so it costs exactly one child process; a failure is never cached, so the
 * call after a half-written build finishes tries again.
 */
const fingerprintCache = new Map<string, string>();

/**
 * The schema fingerprint the build now on disk computes for itself.
 *
 * Throws, naming the module and the cause, when that build cannot be loaded or
 * answers no fingerprint — a half-written build, or one older than the
 * fingerprint itself. The caller decides what an unreadable build means.
 */
export function readBuildFingerprint(stamp: BuildStamp): string {
  const current = fs.statSync(stamp.path);
  const key = `${stamp.path}|${current.mtimeMs}|${current.size}`;
  const cached = fingerprintCache.get(key);
  if (cached !== undefined) return cached;

  const modulePath = fingerprintModuleFor(stamp.path);
  // A TypeScript module (a dev server run through tsx) needs this process's
  // loader flags to be required at all; a built bundle needs none, and a
  // bundle is what a server normally runs.
  const loaderFlags = modulePath.endsWith('.ts') ? process.execArgv : [];
  let printed: string;
  try {
    printed = execFileSync(
      process.execPath,
      [...loaderFlags, '-e', 'const m = require(process.argv[1]); process.stdout.write(String(m.schemaFingerprint()));', modulePath],
      { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    ).trim();
  } catch (e) {
    // Node prints the failing source line first; the error itself is the line
    // that names one, which is the part worth repeating.
    const stderr = String((e as { stderr?: unknown }).stderr ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const cause = stderr.find((l) => /^[A-Za-z]*Error\b/.test(l)) ?? stderr[0] ?? (e as Error).message;
    throw new Error(`the build at ${modulePath} could not be asked for its schema fingerprint (${cause})`);
  }
  if (!printed) throw new Error(`the build at ${modulePath} answered no schema fingerprint`);
  fingerprintCache.set(key, printed);
  return printed;
}

/**
 * The module that can answer for the build a stamped entry file belongs to:
 * the package's library entry when the file sits inside a built @wairon/cli
 * package (the CLI entry runs the CLI when required, the library entry only
 * exports), else the stamped module itself.
 */
function fingerprintModuleFor(entryPath: string): string {
  let dir = path.dirname(entryPath);
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: string; main?: string };
        const inDist = path.relative(path.join(dir, 'dist'), entryPath);
        if (pkg.name === '@wairon/cli' && pkg.main && !inDist.startsWith('..') && !path.isAbsolute(inDist)) {
          return path.resolve(dir, pkg.main);
        }
      } catch { /* an unreadable manifest answers for nothing */ }
      return entryPath;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return entryPath;
    dir = parent;
  }
}

/** The release that last wrote a project, and the file that carries its mark. */
export interface NewerWriter {
  file: string;
  version: string;
}

/** The wairon-version stamp a generated file carries (`<!-- wairon-version: X -->`). */
const STAMP_IN_FILE = /<!--\s*wairon-version:\s*([^\s]+)\s*-->/;

/**
 * The newest release that left its mark on this project, when it is NEWER than
 * `running`: the release stamped on the approval (.wai/lock.json) or on a
 * generated guide (.claude/CLAUDE.md, .wai/context/wairon-guide.md). A server
 * older than the wairon that last wrote the project is the usual sign of two
 * installs on one machine, where the `wairon` an assistant launches is not the
 * one the developer runs. Null when nothing newer is found or no file can be
 * read: only the stamps already on disk are read, nothing is executed.
 */
export function findNewerWriter(root: string, running: string): NewerWriter | null {
  let newest: NewerWriter | null = null;
  for (const file of MARKED_FILES) {
    const version = markedVersion(root, file);
    if (version === null || !isNewerVersion(running, version)) continue;
    if (newest === null || isNewerVersion(newest.version, version)) newest = { file, version };
  }
  return newest;
}

/** The files that carry the mark of the release that wrote them, relative to the project root. */
const MARKED_FILES = ['.wai/lock.json', '.claude/CLAUDE.md', '.wai/context/wairon-guide.md'];

/** The release a marked file names (the approval's validatorVersion, a guide's stamp), or null when the file is missing, unreadable or names no wairon version. */
function markedVersion(root: string, file: string): string | null {
  try {
    const text = fs.readFileSync(path.join(root, ...file.split('/')), 'utf8');
    const version = file.endsWith('.json') ? (JSON.parse(text) as { validatorVersion?: unknown }).validatorVersion : STAMP_IN_FILE.exec(text)?.[1];
    return typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
  } catch {
    return null;
  }
}
