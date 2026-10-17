import * as fs from 'fs';
import * as path from 'path';
import type { HostedProjectRecord } from './types.js';

// ---------------------------------------------------------------------------
// Project Record Store (sdd_host)
//
// Read-through file I/O over <dataDir>/projects.json: every read parses the
// file fresh, every write replaces the whole set atomically (temporary sibling,
// then rename). A module of its own so the project repository, index and
// registry reach it through a real import edge. It decides nothing about the
// records it holds — a member record's derived root is dropped by the caller
// before it is written.
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

/** iproject_store.write — persist the full set, replacing the file atomically. */
export function save(dataDir: string, records: HostedProjectRecord[]): void {
  const p = registryPath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n');
  fs.renameSync(tmp, p);
}
