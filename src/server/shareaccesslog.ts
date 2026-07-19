import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ShareAccessEntry } from './types.js';

// ---------------------------------------------------------------------------
// Share Access Repository (sdd_host): the per-link access log — the raw material
// for spotting irregular access on the unauthenticated public surface. Store +
// Registry (append-only) + Index (per-link listing). Persisted at
// <dataDir>/share-access.json.
// ---------------------------------------------------------------------------

function storePath(dataDir: string): string {
  return path.join(dataDir, 'share-access.json');
}

class ShareAccessStore {
  constructor(private readonly dataDir: string) {}

  load(): ShareAccessEntry[] {
    const p = storePath(this.dataDir);
    let raw: string;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Cannot read share-access store at ${p}: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Malformed share-access store at ${p}: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Malformed share-access store at ${p}: expected a JSON array.`);
    }
    return parsed as ShareAccessEntry[];
  }

  append(entry: ShareAccessEntry): void {
    const p = storePath(this.dataDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const next = [...this.load(), entry];
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, p);
  }
}

class ShareAccessRegistry {
  constructor(private readonly store: ShareAccessStore) {}

  append(entry: ShareAccessEntry): ShareAccessEntry {
    const stored: ShareAccessEntry = {
      ...entry,
      id: entry.id || crypto.randomUUID(),
      at: entry.at || new Date().toISOString(),
    };
    this.store.append(stored);
    return stored;
  }
}

class ShareAccessIndex {
  constructor(private readonly store: ShareAccessStore) {}

  listByLink(linkId: string, limit: number): ShareAccessEntry[] {
    return this.store
      .load()
      .filter((e) => e.linkId === linkId)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, Math.max(0, limit));
  }
}

// ── repository facade ─────────────────────────────────────────────────────────

export function appendAccess(dataDir: string, entry: ShareAccessEntry): ShareAccessEntry {
  return new ShareAccessRegistry(new ShareAccessStore(dataDir)).append(entry);
}

export function listLinkAccess(dataDir: string, linkId: string, limit: number): ShareAccessEntry[] {
  return new ShareAccessIndex(new ShareAccessStore(dataDir)).listByLink(linkId, limit);
}
