import * as fs from 'fs';
import * as path from 'path';
import { replaceFile, withFileLock } from '../utils/fs.js';
import type { HostedProjectRecord } from './types.js';

// ---------------------------------------------------------------------------
// Project Record Store (sdd_host)
//
// Read-through file I/O over <dataDir>/projects.json: every read parses the
// file fresh, every write replaces the whole set atomically (a temporary
// sibling of its own, then rename), and an update holds the file's write lock
// across its read and its write, so a writer in another process is never lost.
// A module of its own so the project repository, index and registry reach it
// through a real import edge. It decides nothing about the records it holds —
// a member record's derived root is dropped by the caller before it is written.
// ---------------------------------------------------------------------------

function registryPath(dataDir: string): string {
  return path.join(dataDir, 'projects.json');
}

/** iproject_store.read — the persisted records, fresh from disk; an absent or malformed file is the empty set. */
export function load(dataDir: string): HostedProjectRecord[] {
  try {
    return JSON.parse(fs.readFileSync(registryPath(dataDir), 'utf8')) as HostedProjectRecord[];
  } catch {
    return [];
  }
}

/** Persist the full set, replacing the file atomically — only ever under update's lock. */
function save(dataDir: string, records: HostedProjectRecord[]): void {
  const p = registryPath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  replaceFile(p, JSON.stringify(records, null, 2) + '\n');
}

/**
 * iproject_store.update — read the set fresh and persist what `change` makes
 * of it, holding the file's write lock across both. A change that throws writes
 * nothing. Answers the set written.
 */
export function update(dataDir: string, change: (records: HostedProjectRecord[]) => HostedProjectRecord[]): HostedProjectRecord[] {
  const p = registryPath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return withFileLock(p, () => {
    const next = change(load(dataDir));
    save(dataDir, next);
    return next;
  });
}
