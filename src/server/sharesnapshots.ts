import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { runWithProjectRoot } from '../utils/fs.js';
import { resolveProjectRoot } from './projects.js';
import { hostCore, hostSurfaces } from './adapters.js';
import { ForbiddenError } from './errors.js';
import type { Principal, ShareSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// Share Snapshot Repository + Specialist (sdd_host).
//
// A snapshot is the immutable, point-in-time capture a share link serves. The
// store keeps one write-once JSON blob per snapshot id under
// <dataDir>/share-snapshots/; a captured share never changes even as the spec
// tree evolves. The specialist FREEZES a project view into a snapshot via the
// core + surfaces adapters, scoped to the caller's own read authority.
// ---------------------------------------------------------------------------

function snapshotDir(dataDir: string): string {
  return path.join(dataDir, 'share-snapshots');
}
function snapshotPath(dataDir: string, id: string): string {
  return path.join(snapshotDir(dataDir), `${id}.json`);
}

// ── store (write-once) ────────────────────────────────────────────────────────

class ShareSnapshotStore {
  constructor(private readonly dataDir: string) {}

  write(snapshot: ShareSnapshot): void {
    const p = snapshotPath(this.dataDir, snapshot.id);
    if (fs.existsSync(p)) return; // write-once: a captured share is immutable
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + '\n');
    fs.renameSync(tmp, p);
  }

  read(snapshotId: string): ShareSnapshot | null {
    const p = snapshotPath(this.dataDir, snapshotId);
    let raw: string;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`Cannot read share snapshot at ${p}: ${(err as Error).message}`);
    }
    try {
      return JSON.parse(raw) as ShareSnapshot;
    } catch (err) {
      throw new Error(`Malformed share snapshot at ${p}: ${(err as Error).message}`);
    }
  }
}

class ShareSnapshotRegistry {
  constructor(private readonly store: ShareSnapshotStore) {}

  put(snapshot: ShareSnapshot): ShareSnapshot {
    const stored: ShareSnapshot = {
      ...snapshot,
      id: snapshot.id || crypto.randomUUID(),
      capturedAt: snapshot.capturedAt || new Date().toISOString(),
    };
    this.store.write(stored);
    return stored;
  }
}

class ShareSnapshotIndex {
  constructor(private readonly store: ShareSnapshotStore) {}

  get(snapshotId: string): ShareSnapshot | null {
    return this.store.read(snapshotId);
  }

  getArtifact(snapshotId: string, kind: string): string | null {
    const snap = this.store.read(snapshotId);
    if (!snap) return null;
    if (kind === 'canvas') return snap.canvasModel ?? null;
    if (kind === 'html') return snap.html ?? null;
    if (kind === 'openapi') return snap.openapi ?? null;
    return null;
  }
}

// ── repository facade ─────────────────────────────────────────────────────────

export function putSnapshot(dataDir: string, snapshot: ShareSnapshot): ShareSnapshot {
  return new ShareSnapshotRegistry(new ShareSnapshotStore(dataDir)).put(snapshot);
}

export function getSnapshot(dataDir: string, snapshotId: string): ShareSnapshot | null {
  return new ShareSnapshotIndex(new ShareSnapshotStore(dataDir)).get(snapshotId);
}

export function getSnapshotArtifact(dataDir: string, snapshotId: string, kind: string): string | null {
  return new ShareSnapshotIndex(new ShareSnapshotStore(dataDir)).getArtifact(snapshotId, kind);
}

// ── share_snapshot_specialist ─────────────────────────────────────────────────

/**
 * Capture a project view into an immutable snapshot payload set. Binds the
 * project root under the caller's OWN read authority (resolveProjectRoot fails
 * closed when the principal may not see the project), then renders exactly the
 * requested artifacts over the bound tree: the canvas-model JSON is always
 * captured (the shared engine renders it); the standalone HTML and OpenAPI
 * document are captured only when requested. Returns the snapshot ready to
 * persist (write-once) — it is never larger than what its creator can see.
 */
export function captureSnapshot(
  dataDir: string,
  principal: Principal,
  projectId: string,
  view: string,
  artifacts: string[],
): ShareSnapshot {
  const root = resolveProjectRoot(dataDir, principal, projectId);
  if (!root) throw new ForbiddenError('project not authorized or unknown');

  return runWithProjectRoot(root, () => {
    const snapshot: ShareSnapshot = {
      id: '',
      projectId,
      view,
      capturedAt: new Date().toISOString(),
      // The canvas model is the primary payload the shared view renders.
      canvasModel: JSON.stringify(hostCore.buildCanvasDataModel()),
    };
    if (artifacts.includes('html')) {
      snapshot.html = hostCore.renderDiagram('canvas');
    }
    if (artifacts.includes('openapi')) {
      // The OpenAPI must MATCH THE DIAGRAM it is linked from. This share captures
      // the full architecture canvas above (buildCanvasDataModel — every
      // component), so the paired OpenAPI is the full surface too ('project'
      // ceiling = all published portals, incl. instance-internal ones). Anything
      // less produces the confusing mismatch where a portal is visible on the
      // shared canvas yet absent from its OpenAPI. This is safe because the link
      // is token-secured and already reveals the whole internal architecture — the
      // API reveals nothing the diagram doesn't. (A future "API-only" link for
      // external 3rd parties, who never see the diagram, is the place to filter to
      // the external-only surface instead.)
      const result = hostSurfaces.exportBoundSurface('project', 'openapi') as { rendered?: string };
      snapshot.openapi = result.rendered ?? '{}';
    }
    return snapshot;
  });
}
