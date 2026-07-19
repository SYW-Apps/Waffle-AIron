import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ShareLink } from './types.js';

// ---------------------------------------------------------------------------
// Share Link Repository (sdd_host): the public share-link records.
//
// Composition mirrors the spec tree (git_backing is the template):
//   - ShareLinkStore    : the records collection at <dataDir>/share-links.json.
//   - ShareLinkRegistry : create / update / remove (no authorization).
//   - ShareLinkIndex    : token-hash / id / scope reads (never mutates).
//   - repository facade  : the exported functions consumers use.
//
// The unguessable token is stored ONLY as a salted hash; the raw token never
// touches disk.
// ---------------------------------------------------------------------------

function storePath(dataDir: string): string {
  return path.join(dataDir, 'share-links.json');
}

// ── store ────────────────────────────────────────────────────────────────────

class ShareLinkStore {
  constructor(private readonly dataDir: string) {}

  load(): ShareLink[] {
    const p = storePath(this.dataDir);
    let raw: string;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Cannot read share-link store at ${p}: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Malformed share-link store at ${p}: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Malformed share-link store at ${p}: expected a JSON array of links.`);
    }
    return parsed as ShareLink[];
  }

  replaceAll(links: ShareLink[]): void {
    const p = storePath(this.dataDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(links, null, 2) + '\n');
    fs.renameSync(tmp, p);
  }
}

// ── registry (write path — no authorization here) ────────────────────────────

class ShareLinkRegistry {
  constructor(private readonly store: ShareLinkStore) {}

  create(link: ShareLink): ShareLink {
    const links = this.store.load();
    const stored: ShareLink = {
      ...link,
      id: link.id || crypto.randomUUID(),
      createdAt: link.createdAt || new Date().toISOString(),
    };
    this.store.replaceAll([...links, stored]);
    return stored;
  }

  update(link: ShareLink): ShareLink {
    const links = this.store.load();
    const idx = links.findIndex((l) => l.id === link.id);
    if (idx === -1) throw new Error(`Share link "${link.id}" not found.`);
    // Preserve identity-bearing fields; apply the rest.
    const merged: ShareLink = { ...links[idx], ...link, id: links[idx].id, createdAt: links[idx].createdAt, tokenHash: links[idx].tokenHash };
    const next = [...links];
    next[idx] = merged;
    this.store.replaceAll(next);
    return merged;
  }

  remove(id: string): void {
    const links = this.store.load();
    const next = links.filter((l) => l.id !== id);
    if (next.length === links.length) return;
    this.store.replaceAll(next);
  }
}

// ── index (read path) ─────────────────────────────────────────────────────────

class ShareLinkIndex {
  constructor(private readonly store: ShareLinkStore) {}

  byTokenHash(tokenHash: string): ShareLink | null {
    return this.store.load().find((l) => l.tokenHash === tokenHash) ?? null;
  }

  getById(id: string): ShareLink | null {
    return this.store.load().find((l) => l.id === id) ?? null;
  }

  listByProject(projectId: string): ShareLink[] {
    return this.store.load().filter((l) => l.projectId === projectId);
  }
}

// ── repository facade (1:1 forwarding) ────────────────────────────────────────

export function createLink(dataDir: string, link: ShareLink): ShareLink {
  return new ShareLinkRegistry(new ShareLinkStore(dataDir)).create(link);
}

export function updateLink(dataDir: string, link: ShareLink): ShareLink {
  return new ShareLinkRegistry(new ShareLinkStore(dataDir)).update(link);
}

export function removeLink(dataDir: string, id: string): void {
  new ShareLinkRegistry(new ShareLinkStore(dataDir)).remove(id);
}

export function linkByTokenHash(dataDir: string, tokenHash: string): ShareLink | null {
  return new ShareLinkIndex(new ShareLinkStore(dataDir)).byTokenHash(tokenHash);
}

export function getLink(dataDir: string, id: string): ShareLink | null {
  return new ShareLinkIndex(new ShareLinkStore(dataDir)).getById(id);
}

export function listProjectLinks(dataDir: string, projectId: string): ShareLink[] {
  return new ShareLinkIndex(new ShareLinkStore(dataDir)).listByProject(projectId);
}
