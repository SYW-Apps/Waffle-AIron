import { hashToken } from './credentials.js';
import { linkByTokenHash } from './sharelinks.js';
import { getSnapshot, getSnapshotArtifact } from './sharesnapshots.js';
import { appendAccess } from './shareaccesslog.js';
import type {
  HostConfig,
  ShareArtifactResult,
  ShareLink,
  ShareRequestMeta,
  SharedViewResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Share Access Orchestrator (sdd_host): the PUBLIC, unauthenticated, token-gated
// access path. Resolves a token by salted-hash lookup, refuses a disabled /
// expired / unknown token, records EVERY access (IP / UA / referer / outcome),
// and serves only the link's immutable snapshot or a permitted artifact. It
// establishes NO session and grants nothing beyond the single shared view.
// ---------------------------------------------------------------------------

/** Record one access attempt (best-effort — logging never blocks serving). */
function record(dataDir: string, linkId: string, meta: ShareRequestMeta, outcome: string): void {
  try {
    appendAccess(dataDir, {
      id: '',
      linkId,
      at: '',
      ip: meta.ip,
      userAgent: meta.userAgent,
      ...(meta.referer ? { referer: meta.referer } : {}),
      outcome,
    });
  } catch {
    /* the log is advisory; a write failure must not deny a legitimate view */
  }
}

/** null when the link is unusable (with the refusal outcome), else the link. */
function usable(link: ShareLink | null): { link: ShareLink } | { outcome: string } {
  if (!link) return { outcome: 'not-found' };
  if (!link.enabled) return { outcome: 'denied-disabled' };
  if (link.expiresAt && Date.parse(link.expiresAt) <= Date.now()) return { outcome: 'denied-expired' };
  return { link };
}

/**
 * Resolve a presented token to its shared view. Salted-hash the token, refuse a
 * disabled / expired / unknown link (recording the refusal), else record a served
 * access and return the snapshot's canvas model plus the link's download
 * permissions. Never establishes a session.
 */
export function resolveSharedView(cfg: HostConfig, token: string, meta: ShareRequestMeta): SharedViewResult {
  const link = linkByTokenHash(cfg.dataDir, hashToken(token));
  const check = usable(link);
  if ('outcome' in check) {
    record(cfg.dataDir, link?.id ?? '', meta, check.outcome);
    return { found: false, outcome: check.outcome };
  }
  const snapshot = getSnapshot(cfg.dataDir, check.link.snapshotId);
  record(cfg.dataDir, check.link.id, meta, 'served');
  return {
    found: true,
    outcome: 'served',
    link: check.link,
    ...(snapshot?.canvasModel ? { model: snapshot.canvasModel } : {}),
    ...(snapshot?.html ? { html: snapshot.html } : {}),
    allowDownloadHtml: check.link.allowDownloadHtml,
    allowDownloadOpenapi: check.link.allowDownloadOpenapi,
  };
}

const CONTENT_TYPE: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  openapi: 'application/json',
  canvas: 'application/json',
};

/**
 * Serve a permitted downloadable artifact (html | openapi) for a token. Resolves
 * the token as above, refuses when the requested download is not enabled on the
 * link, and otherwise returns the captured artifact payload — recording the
 * access with its outcome throughout.
 *
 * For openapi, `portalId` selects ONE captured per-portal document; omitted with
 * several captured specs serves an index listing them (portalId + name) rather
 * than merging them or silently picking one; omitted with exactly one serves that
 * document. A portalId naming no captured spec is refused (not-found), never
 * substituted with another portal's API.
 */
export function downloadArtifact(
  cfg: HostConfig,
  token: string,
  kind: string,
  meta: ShareRequestMeta,
  portalId?: string,
): ShareArtifactResult {
  const link = linkByTokenHash(cfg.dataDir, hashToken(token));
  const check = usable(link);
  if ('outcome' in check) {
    record(cfg.dataDir, link?.id ?? '', meta, check.outcome);
    return { found: false, outcome: check.outcome };
  }
  const permitted =
    (kind === 'html' && check.link.allowDownloadHtml) ||
    (kind === 'openapi' && check.link.allowDownloadOpenapi);
  if (!permitted) {
    record(cfg.dataDir, check.link.id, meta, 'denied-download');
    return { found: false, outcome: 'denied-download' };
  }
  const content = getSnapshotArtifact(cfg.dataDir, check.link.snapshotId, kind, portalId);
  if (content === null) {
    record(cfg.dataDir, check.link.id, meta, 'not-found');
    return { found: false, outcome: 'not-found' };
  }
  record(cfg.dataDir, check.link.id, meta, 'served');
  return { found: true, outcome: 'served', kind, content, contentType: CONTENT_TYPE[kind] ?? 'application/octet-stream' };
}
