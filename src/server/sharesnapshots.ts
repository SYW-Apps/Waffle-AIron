import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { runWithProjectRoot } from '../utils/fs.js';
import { resolveProjectRoot } from './projects.js';
import { hostCore, hostSurfaces } from './adapters.js';
import { ForbiddenError } from './errors.js';
import type { Principal, ShareSnapshot } from './types.js';
import type { NamedOpenApiSpec } from '../models/index.js';

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

/**
 * The payload served for an openapi request that names no portal when SEVERAL
 * per-portal documents were captured: a machine-readable listing of the shared
 * APIs (portalId + name) so a consumer picks one. Distinct portals are never
 * merged into a combined document, and no empty document ever stands in for
 * them. The share portal renders this into a link list; a download receives it
 * verbatim. (Shape mirrored — as a parse — by the portal, which depends only on
 * the access orchestrator.)
 */
function openApiIndexDocument(specs: NamedOpenApiSpec[]): string {
  return JSON.stringify(
    { openapiIndex: true, specs: specs.map((s) => ({ portalId: s.portalId, name: s.name })) },
    null,
    2,
  );
}

/**
 * Which captured OpenAPI payload answers a request: portalId selects exactly ONE
 * per-portal document; several captured specs with no selection yield the INDEX
 * of them; exactly one yields that document. A portalId naming no captured spec
 * is REFUSED (null) — never silently substituted with another portal's API.
 *
 * Back-compat: a snapshot captured before per-portal capture holds only the
 * single `openapi` field and no portal ids, so it keeps answering an unqualified
 * request with exactly the document it always served.
 */
function selectCapturedOpenApi(snap: ShareSnapshot, portalId?: string): string | null {
  const specs = snap.openapiSet;
  if (!specs || specs.length === 0) {
    if (portalId) return null; // nothing captured under that name
    return snap.openapi ?? null;
  }
  if (portalId) {
    const hit = specs.find((s) => s.portalId === portalId);
    return hit ? hit.document : null;
  }
  if (specs.length === 1) return specs[0].document;
  return openApiIndexDocument(specs);
}

class ShareSnapshotIndex {
  constructor(private readonly store: ShareSnapshotStore) {}

  get(snapshotId: string): ShareSnapshot | null {
    return this.store.read(snapshotId);
  }

  getArtifact(snapshotId: string, kind: string, portalId?: string): string | null {
    const snap = this.store.read(snapshotId);
    if (!snap) return null;
    if (kind === 'canvas') return snap.canvasModel ?? null;
    if (kind === 'html') return snap.html ?? null;
    if (kind === 'openapi') return selectCapturedOpenApi(snap, portalId);
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

export function getSnapshotArtifact(
  dataDir: string,
  snapshotId: string,
  kind: string,
  portalId?: string,
): string | null {
  return new ShareSnapshotIndex(new ShareSnapshotStore(dataDir)).getArtifact(snapshotId, kind, portalId);
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
      //
      // A project publishes ONE OpenAPI document PER PORTAL — distinct portals
      // are separate APIs with their own servers and auth, never merged. Capture
      // the WHOLE set, so a multi-portal share can serve each API (and index
      // them); the single-document field is filled only when exactly one portal
      // exists, which is also what pre-existing links carry. Capturing nothing is
      // honest when the project publishes no portal; an empty `{}` placeholder
      // standing in for real APIs is not.
      const result = hostSurfaces.exportBoundSurface('project', 'openapi');
      const specs = result.renderedSet ?? [];
      if (specs.length) {
        snapshot.openapiSet = specs;
        if (specs.length === 1) snapshot.openapi = specs[0].document;
      }
    }
    return snapshot;
  });
}
