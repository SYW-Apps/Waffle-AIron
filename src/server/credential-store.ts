import * as fs from 'fs';
import * as path from 'path';
import type { ApiKeyRecord } from './types.js';

// ---------------------------------------------------------------------------
// Credential Store (sdd_host)
//
// Read-through file I/O over <dataDir>/auth/credentials.json: every read parses
// the file fresh, every write replaces the whole set atomically (temporary
// sibling, then rename). A module of its own so the credential repository,
// index and registry reach it through a real import edge. It holds only hashed
// records; the plaintext of a token is never written.
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

/** icredential_store.write — persist the full set, replacing the file atomically. */
export function save(dataDir: string, records: ApiKeyRecord[]): void {
  const p = storePath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n');
  fs.renameSync(tmp, p);
}
