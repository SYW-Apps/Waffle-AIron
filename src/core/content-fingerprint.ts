// ---------------------------------------------------------------------------
// content_fingerprint + file_digest_cache (sdd_validator).
//
// A stable fingerprint of a list of files' content: a stat per file, a read
// and a sha256 only for a file whose size or modification time moved since its
// digest was taken. Equal paths and bytes fingerprint equally, whatever the
// modification times, so a branch switched away and back is recognised.
// ---------------------------------------------------------------------------
import * as path from 'path';
import { createHash } from 'crypto';
import * as ioFiles from '../io/files.js';
import { pathKey } from '../models/code-model.js';

/** One file's content digest with the size and modification time it was taken at. */
export interface FileDigest {
  size: number;
  modifiedAt: number;
  digest: string;
}

// ---------------------------------------------------------------------------
// file_digest_cache — a process-local map from absolute path to digest.
// ---------------------------------------------------------------------------

const HELD_BOUND = 50_000;
const held = new Map<string, FileDigest>();

/** The digest held for this file (absolute path), or none. */
export function get(file: string): FileDigest | undefined {
  return held.get(file);
}

/** Clear the map when it holds its bound of entries, then hold the digest under the path. */
export function put(file: string, digest: FileDigest): void {
  if (held.size >= HELD_BOUND && !held.has(file)) held.clear();
  held.set(file, digest);
}

// ---------------------------------------------------------------------------
// content_fingerprint
// ---------------------------------------------------------------------------

/**
 * The fingerprint of these files' content: equal for equal paths and bytes. A
 * path outside the root is folded as escaped, an absent or unreadable file as
 * missing; never throws.
 */
export function digest(root: string, files: readonly string[]): string {
  const lines = new Map<string, string>();
  for (const declared of files) {
    const key = pathKey(path.isAbsolute(declared) ? relativeInside(root, declared) ?? declared : declared);
    if (lines.has(key)) continue;
    // Step 2-3: a path that leaves the root is folded as escaped and never touched.
    if (path.isAbsolute(key) || path.normalize(key).split(path.sep)[0] === '..') {
      lines.set(key, `${key} escaped`);
      continue;
    }
    const absolute = path.resolve(root, key);
    if (path.relative(root, absolute).startsWith('..')) {
      lines.set(key, `${key} escaped`);
      continue;
    }
    // Step 4: size and modification time.
    const stat = ioFiles.statOrNull(absolute);
    if (!stat || !stat.isFile()) {
      lines.set(key, `${key} missing`);
      continue;
    }
    // Steps 5-8: the held digest, or read and hold a new one.
    let entry = get(absolute);
    if (!entry || entry.size !== stat.size || entry.modifiedAt !== stat.mtimeMs) {
      let bytes: Uint8Array;
      try {
        bytes = ioFiles.readBytes(absolute);
      } catch {
        lines.set(key, `${key} missing`);
        continue;
      }
      entry = { size: stat.size, modifiedAt: stat.mtimeMs, digest: createHash('sha256').update(bytes).digest('hex') };
      put(absolute, entry);
    }
    // Step 9: fold the path with its digest.
    lines.set(key, `${key} ${entry.digest}`);
  }
  const hash = createHash('sha256');
  for (const key of [...lines.keys()].sort()) hash.update(`${lines.get(key)}\n`);
  return hash.digest('hex');
}

/** The root-relative form of an absolute path inside the root, or none when it is not inside. */
function relativeInside(root: string, absolute: string): string | undefined {
  const relative = path.relative(root, absolute);
  return relative.startsWith('..') || path.isAbsolute(relative) ? undefined : relative;
}
