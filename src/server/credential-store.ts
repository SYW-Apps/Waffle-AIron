import { files } from '../io/index.js';
import * as path from 'path';
import { readJsonForUpdate, replaceFile } from '../utils/fs.js';
import { withFileLock } from '../utils/file-lock.js';
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

/**
 * A record as an older release stored it: a revoked credential used to stay in
 * the file with a revokedAt stamp. The model no longer has the field; this local
 * type is the one place that still sees it.
 */
type StoredRecord = ApiKeyRecord & { revokedAt?: string };

/** A legacy record carrying revokedAt is a revoked credential: it no longer exists. */
function withoutRevoked(records: StoredRecord[]): ApiKeyRecord[] {
  return records.filter((r) => !r.revokedAt);
}

/**
 * icredential_store.read — the persisted records, fresh from disk, leaving out
 * any legacy record carrying revokedAt; an absent or malformed file is the empty set.
 */
export function load(dataDir: string): ApiKeyRecord[] {
  try {
    return withoutRevoked(JSON.parse(files.readText(storePath(dataDir))) as StoredRecord[]);
  } catch {
    return [];
  }
}

/** Persist the full set, replacing the file atomically, owner-only (0600) — only ever under update's lock. */
function save(dataDir: string, records: ApiKeyRecord[]): void {
  const p = storePath(dataDir);
  files.ensureDir(path.dirname(p));
  replaceFile(p, JSON.stringify(records, null, 2) + '\n', 0o600);
}

/**
 * icredential_store.update — read the set fresh and persist what `change`
 * makes of it, holding the file's write lock across both. A change that throws,
 * or a file that exists but cannot be read, writes nothing. Answers the set written.
 */
export function update(dataDir: string, change: (records: ApiKeyRecord[]) => ApiKeyRecord[]): ApiKeyRecord[] {
  const p = storePath(dataDir);
  files.ensureDir(path.dirname(p));
  return withFileLock(p, () => {
    const next = change(withoutRevoked(readJsonForUpdate<StoredRecord[]>(p, [])));
    save(dataDir, next);
    return next;
  });
}
