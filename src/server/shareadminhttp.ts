import {
  createShareLink,
  refreshSnapshot,
  updateShareLink,
  removeShareLink,
  listShareLinks,
  getShareAccessLog,
} from './shareadmin.js';
import type {
  HostConfig,
  ShareAccessEntry,
  ShareLink,
  ShareLinkCreated,
  ShareLinkInput,
  ShareLinkUpdate,
} from './types.js';

// ---------------------------------------------------------------------------
// Share Admin Portal (sdd_host): the authenticated /web/admin/share transport
// layer. Thin handlers that parse the HTTP body/query and forward to the share
// admin orchestrator (which enforces share:create); the caller (web.ts dispatch)
// supplies the ws_ session id from the cookie and serializes the result.
// ---------------------------------------------------------------------------

type Body = Record<string, unknown> | undefined;

export function postCreate(cfg: HostConfig, sessionId: string, body: Body): ShareLinkCreated {
  return createShareLink(cfg, sessionId, (body ?? {}) as unknown as ShareLinkInput);
}

export function postRefresh(cfg: HostConfig, sessionId: string, body: Body): ShareLink {
  return refreshSnapshot(cfg, sessionId, String(body?.linkId ?? ''));
}

export function postUpdate(cfg: HostConfig, sessionId: string, body: Body): ShareLink {
  return updateShareLink(cfg, sessionId, String(body?.linkId ?? ''), (body?.changes ?? {}) as ShareLinkUpdate);
}

export function postRemove(cfg: HostConfig, sessionId: string, body: Body): void {
  removeShareLink(cfg, sessionId, String(body?.linkId ?? ''));
}

export function getList(cfg: HostConfig, sessionId: string, projectId: string): ShareLink[] {
  return listShareLinks(cfg, sessionId, projectId);
}

export function getAccessLog(cfg: HostConfig, sessionId: string, linkId: string, limit: number): ShareAccessEntry[] {
  return getShareAccessLog(cfg, sessionId, linkId, limit);
}
