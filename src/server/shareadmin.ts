import * as crypto from 'crypto';
import { authenticateSession } from './auth.js';
import { authorize } from './authorization.js';
import { hashToken } from './credentials.js';
import { appendAuditEvent, DEFAULT_AUDIT_POLICY } from './audit.js';
import { UnauthenticatedError, ForbiddenError } from './errors.js';
import { captureSnapshot, putSnapshot } from './sharesnapshots.js';
import { createLink, updateLink, removeLink, getLink, listProjectLinks } from './sharelinks.js';
import { listLinkAccess } from './shareaccesslog.js';
import type {
  AuditEvent,
  HostConfig,
  Principal,
  PrincipalSubject,
  ShareAccessEntry,
  ShareLink,
  ShareLinkCreated,
  ShareLinkInput,
  ShareLinkUpdate,
} from './types.js';

// ---------------------------------------------------------------------------
// Share Admin Orchestrator (sdd_host): the OWNER-side share-link workflows on
// the authenticated web surface, resolver-gated on the share:create capability
// over the target's project scope. Mint / disable / permission changes are
// audited at security level; the raw token is returned to the creator exactly
// once and never stored (only its salted hash lives on the record).
// ---------------------------------------------------------------------------

const SHARE_CREATE = 'share:create';

function requirePrincipal(cfg: HostConfig, sessionId: string | null): Principal {
  const principal = authenticateSession(cfg.dataDir, sessionId ?? '');
  if (!principal.authenticated) throw new UnauthenticatedError();
  return principal;
}

function requireShareCreate(cfg: HostConfig, principal: Principal, projectId: string): void {
  if (authorize(cfg.dataDir, principal, SHARE_CREATE, 'project', projectId).value !== 'yes') {
    throw new ForbiddenError('managing share links requires share:create over the project');
  }
}

function principalSubject(principal: Principal): PrincipalSubject {
  return principal.subject ?? { userId: 'token:' + principal.tokenId, kind: 'service', issuer: 'local' };
}

function tryAudit(cfg: HostConfig, principal: Principal, action: string, target: string): void {
  const event: AuditEvent = {
    id: '',
    timestamp: '',
    level: 'security',
    category: 'admin',
    action,
    outcome: 'success',
    actor: principalSubject(principal),
    target,
  };
  if (principal.tokenId) event.tokenId = principal.tokenId;
  try {
    appendAuditEvent(cfg.dataDir, event, DEFAULT_AUDIT_POLICY);
  } catch (err) {
    console.error(`[share] audit append failed for "${action}": ` + (err instanceof Error ? err.message : String(err)));
  }
}

/** The artifact kinds to capture for a link. The canvas model AND the standalone
 *  HTML are always captured (the HTML is the self-contained shared-view page);
 *  the OpenAPI document is captured only when the link exposes it. Download
 *  PERMISSIONS (allowDownloadHtml/Openapi) gate serving, not capture. */
function artifactsFor(link: Pick<ShareLink, 'allowDownloadOpenapi'>, wantsOpenapi = false): string[] {
  return ['canvas', 'html', ...(link.allowDownloadOpenapi || wantsOpenapi ? ['openapi'] : [])];
}

/** Require share:create over the project, capture the snapshot, mint a 256-bit
 *  token, persist the record with ONLY its salted hash, audit, and return the
 *  raw token exactly once. */
export function createShareLink(cfg: HostConfig, sessionId: string | null, input: ShareLinkInput): ShareLinkCreated {
  const principal = requirePrincipal(cfg, sessionId);
  requireShareCreate(cfg, principal, input.projectId);

  const wantsOpenapi = !!input.allowDownloadOpenapi || (input.artifacts ?? []).includes('openapi');
  const artifacts = artifactsFor({ allowDownloadOpenapi: !!input.allowDownloadOpenapi }, wantsOpenapi);
  const snapshot = putSnapshot(cfg.dataDir, captureSnapshot(cfg.dataDir, principal, input.projectId, input.view, artifacts));

  const token = crypto.randomBytes(32).toString('base64url'); // 256-bit, unguessable
  const link = createLink(cfg.dataDir, {
    id: '',
    tokenHash: hashToken(token),
    projectId: input.projectId,
    view: input.view,
    snapshotId: snapshot.id,
    mode: input.mode === 'live' ? 'live' : 'snapshot',
    enabled: true,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    allowDownloadHtml: !!input.allowDownloadHtml,
    allowDownloadOpenapi: !!input.allowDownloadOpenapi,
    frameAncestors: input.frameAncestors ?? [],
    createdBy: principalSubject(principal),
    createdAt: '',
  });
  tryAudit(cfg, principal, 'share.link.create', link.id);
  return { link, token };
}

/** Re-capture the link's view into a fresh immutable snapshot and repoint it. */
export function refreshSnapshot(cfg: HostConfig, sessionId: string | null, linkId: string): ShareLink {
  const principal = requirePrincipal(cfg, sessionId);
  const link = getLink(cfg.dataDir, linkId);
  if (!link) throw new Error(`Share link "${linkId}" not found.`);
  requireShareCreate(cfg, principal, link.projectId);

  const snapshot = putSnapshot(
    cfg.dataDir,
    captureSnapshot(cfg.dataDir, principal, link.projectId, link.view, artifactsFor(link)),
  );
  const updated = updateLink(cfg.dataDir, { ...link, snapshotId: snapshot.id });
  tryAudit(cfg, principal, 'share.link.refresh', link.id);
  return updated;
}

/** Apply the mutable settings (enabled / expiry / downloads / embedding). */
export function updateShareLink(
  cfg: HostConfig,
  sessionId: string | null,
  linkId: string,
  changes: ShareLinkUpdate,
): ShareLink {
  const principal = requirePrincipal(cfg, sessionId);
  const link = getLink(cfg.dataDir, linkId);
  if (!link) throw new Error(`Share link "${linkId}" not found.`);
  requireShareCreate(cfg, principal, link.projectId);

  const next: ShareLink = {
    ...link,
    enabled: changes.enabled ?? link.enabled,
    allowDownloadHtml: changes.allowDownloadHtml ?? link.allowDownloadHtml,
    allowDownloadOpenapi: changes.allowDownloadOpenapi ?? link.allowDownloadOpenapi,
    frameAncestors: changes.frameAncestors ?? link.frameAncestors,
  };
  // Expiry: an explicit empty string clears it; a value sets it; undefined keeps it.
  if (changes.expiresAt !== undefined) {
    if (changes.expiresAt) next.expiresAt = changes.expiresAt;
    else delete next.expiresAt;
  }
  const updated = updateLink(cfg.dataDir, next);
  tryAudit(cfg, principal, 'share.link.update', link.id);
  return updated;
}

/** Revoke (delete) a share link — its token no longer resolves. */
export function removeShareLink(cfg: HostConfig, sessionId: string | null, linkId: string): void {
  const principal = requirePrincipal(cfg, sessionId);
  const link = getLink(cfg.dataDir, linkId);
  if (!link) throw new Error(`Share link "${linkId}" not found.`);
  requireShareCreate(cfg, principal, link.projectId);
  removeLink(cfg.dataDir, linkId);
  tryAudit(cfg, principal, 'share.link.remove', link.id);
}

/** List a project's share links (records only — never a raw token). */
export function listShareLinks(cfg: HostConfig, sessionId: string | null, projectId: string): ShareLink[] {
  const principal = requirePrincipal(cfg, sessionId);
  requireShareCreate(cfg, principal, projectId);
  return listProjectLinks(cfg.dataDir, projectId);
}

/** Read a link's recent access entries for anomaly review. */
export function getShareAccessLog(
  cfg: HostConfig,
  sessionId: string | null,
  linkId: string,
  limit: number,
): ShareAccessEntry[] {
  const principal = requirePrincipal(cfg, sessionId);
  const link = getLink(cfg.dataDir, linkId);
  if (!link) throw new Error(`Share link "${linkId}" not found.`);
  requireShareCreate(cfg, principal, link.projectId);
  return listLinkAccess(cfg.dataDir, linkId, Math.min(Math.max(1, limit || 100), 1000));
}
