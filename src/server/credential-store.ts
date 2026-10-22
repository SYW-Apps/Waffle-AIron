import * as fs from 'fs';
import * as path from 'path';
import { readJsonForUpdate, replaceFile, withFileLock } from '../utils/fs.js';
import type { ApiKeyRecord } from './types.js';

// ---------------------------------------------------------------------------
// Credential Store (sdd_host)
//
// Read-through file I/O over <dataDir>/auth/credentials.json: every read parses
// the file fresh, every write replaces the whole set atomically (a temporary
// sibling of its own, then rename) with owner-only permissions, and an update
// holds the file's write lock across its read and its write, so a writer in
// another process is never lost. A module of its own so the credential
// repository, index and registry reach it through a real import edge. It holds
// only hashed records; the plaintext of a token is never written.
// ---------------------------------------------------------------------------

function storePath(dataDir: string): string {
  return path.join(dataDir, 'auth', 'credentials.json');
}

/** icredential_store.read — the persisted records, fresh from disk; an absent or malformed file is the empty set. */
export function load(dataDir: string): ApiKeyRecord[] {
  try {
    return JSON.parse(fs.readFileSync(storePath(dataDir), 'utf8')) as ApiKeyRecord[];
  } catch {
    return [];
  }
}

/** Persist the full set, replacing the file atomically, owner-only (0600) — only ever under update's lock. */
function save(dataDir: string, records: ApiKeyRecord[]): void {
  const p = storePath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  replaceFile(p, JSON.stringify(records, null, 2) + '\n', 0o600);
}

/**
 * icredential_store.update — read the set fresh and persist what `change`
 * makes of it, holding the file's write lock across both. A change that throws,
 * or a file that exists but cannot be read, writes nothing. Answers the set written.
 */
export function update(dataDir: string, change: (records: ApiKeyRecord[]) => ApiKeyRecord[]): ApiKeyRecord[] {
  const p = storePath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return withFileLock(p, () => {
    const next = change(readJsonForUpdate(p, []));
    save(dataDir, next);
    return next;
  });
}
