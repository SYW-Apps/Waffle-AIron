// ---------------------------------------------------------------------------
// identity_portal — the hosted identity control plane's HTTP boundary: parses
// each /identity/* route and forwards it to the identity orchestrator's
// workflows in ./identity.ts.
//
// A module of its own so the portal -> orchestrator hop is a real import edge.
// When the portal's methods were the orchestrator's own functions, every
// collaborator those functions reached (the best-effort audit append, the
// enabled-provider resolution) counted as an undeclared hop of the portal.
// ---------------------------------------------------------------------------
import type { IncomingMessage, ServerResponse } from 'http';
import * as identityOrchestrator from './identity.js';
import type { TokenMintRequest } from './identity.js';
import { sendJson } from './httpio.js';
import { UnauthenticatedError, ForbiddenError } from './errors.js';
import type { AuditQuery, HostConfig, HostedUserRecord, IdentityProviderConfig } from './types.js';

/** Refuse a mint request whose narrowing is missing or empty before it reaches
 *  the orchestrator (400): the list is required, and '*' is the full reach. The
 *  orchestrator re-checks for its in-process callers. */
function assertNarrowingGiven(request: { projects?: unknown }): void {
  if (!Array.isArray(request.projects) || request.projects.length === 0) {
    throw new Error("projects is required: pass the project ids the token may name, or '*' for the owner's full reach");
  }
}

// Forwarding to the orchestrator functions in ./identity.ts. The router is async because the
// SSO callback awaits completeSsoLogin (the provider code exchange is network I/O);
// every route is wrapped in the same error → status mapping, so an awaited
// rejection is caught here too and never escapes as an unhandled promise. Phase 1
// decision: these routes ride the ADMIN-plane listener (127.0.0.1 bind) until
// HostExposurePolicy / `identityApiEnabled` lands in a later phase to give the
// identity plane its own exposure switch. The credential is extracted the same way
// admin routes do (the caller passes the bearer token); the unauthenticated SSO
// start/complete pair ignores it. Endpoints match iidentity_portal exactly.

function auditQueryFromParams(sp: URLSearchParams): AuditQuery {
  const q: AuditQuery = {};
  const projectId = sp.get('projectId');
  if (projectId) q.projectId = projectId;
  const actorUserId = sp.get('actorUserId');
  if (actorUserId) q.actorUserId = actorUserId;
  const tokenId = sp.get('tokenId');
  if (tokenId) q.tokenId = tokenId;
  const category = sp.get('category');
  if (category) q.category = category;
  const action = sp.get('action');
  if (action) q.action = action;
  const outcome = sp.get('outcome');
  if (outcome) q.outcome = outcome;
  const minimumLevel = sp.get('minimumLevel');
  if (minimumLevel) q.minimumLevel = minimumLevel;
  const from = sp.get('from');
  if (from) q.from = from;
  const to = sp.get('to');
  if (to) q.to = to;
  const limit = sp.get('limit');
  if (limit !== null && limit !== '') q.limit = Number(limit);
  return q;
}

/**
 * Route one identity control-plane request to the orchestrator and write the HTTP
 * response. Owns its own error → status mapping (401 unauthenticated, 403 forbidden,
 * 400 otherwise) so it never depends on the admin-plane catch. Called by http.ts
 * when the admin listener sees an `/identity/*` path; body is the parsed request body.
 */
export async function handleIdentityRequest(
  cfg: HostConfig,
  credential: string | null,
  req: IncomingMessage,
  res: ServerResponse,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any,
  url: URL,
): Promise<void> {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['identity', ...]
  try {
    // ── headless SSO login (unauthenticated: no credential) ──────────────────
    // POST /identity/sso/start  { providerId, redirectUri }
    if (req.method === 'POST' && parts.length === 3 && parts[1] === 'sso' && parts[2] === 'start') {
      const url_ = await identityOrchestrator.startSsoLogin(cfg, body.providerId as string, body.redirectUri as string);
      return sendJson(res, 200, { url: url_ });
    }
    // GET /identity/sso/callback?state=&code=
    // Headless flow: returns the minted token as JSON. A browser-facing UI would
    // render/exchange this into a session instead of showing it raw — UX watch-item.
    if (req.method === 'GET' && parts.length === 3 && parts[1] === 'sso' && parts[2] === 'callback') {
      const token = await identityOrchestrator.completeSsoLogin(
        cfg,
        url.searchParams.get('state') ?? '',
        url.searchParams.get('code') ?? '',
      );
      return sendJson(res, 200, { token });
    }

    // ── identity-provider (SSO) administration (instance-admin only) ─────────
    // GET /identity/providers
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'providers') {
      return sendJson(res, 200, identityOrchestrator.listProviders(cfg, credential));
    }
    // PUT /identity/providers/{id}
    if (req.method === 'PUT' && parts.length === 3 && parts[1] === 'providers') {
      const config = { ...(body as IdentityProviderConfig), id: parts[2] };
      return sendJson(res, 200, identityOrchestrator.upsertProvider(cfg, credential, config));
    }
    // DELETE /identity/providers/{id}
    if (req.method === 'DELETE' && parts.length === 3 && parts[1] === 'providers') {
      identityOrchestrator.removeProvider(cfg, credential, parts[2]);
      return sendJson(res, 200, { ok: true });
    }
    // GET /identity/audit/count
    if (req.method === 'GET' && parts.length === 3 && parts[1] === 'audit' && parts[2] === 'count') {
      return sendJson(res, 200, { count: identityOrchestrator.countAuditEvents(cfg, credential, auditQueryFromParams(url.searchParams)) });
    }

    // POST /identity/tokens
    if (req.method === 'POST' && parts.length === 2 && parts[1] === 'tokens') {
      {
        assertNarrowingGiven(body ?? {});
        const minted = identityOrchestrator.mintToken(cfg, credential, body as TokenMintRequest);
        return sendJson(res, 201, { key: minted.token, mapped: minted.mapped });
      }
    }
    // DELETE /identity/tokens/{id}
    if (req.method === 'DELETE' && parts.length === 3 && parts[1] === 'tokens') {
      identityOrchestrator.revokeToken(cfg, credential, parts[2]);
      return sendJson(res, 200, { ok: true });
    }
    // GET /identity/users?project=
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'users') {
      return sendJson(res, 200, identityOrchestrator.listUsers(cfg, credential, url.searchParams.get('project') ?? undefined));
    }
    // PUT /identity/users/{id}/status
    if (req.method === 'PUT' && parts.length === 4 && parts[1] === 'users' && parts[3] === 'status') {
      return sendJson(res, 200, identityOrchestrator.setUserStatus(cfg, credential, parts[2], body.status as string));
    }
    // PUT /identity/users/{id}
    if (req.method === 'PUT' && parts.length === 3 && parts[1] === 'users') {
      const record = { ...(body as HostedUserRecord), id: parts[2] };
      return sendJson(res, 200, identityOrchestrator.upsertUser(cfg, credential, record));
    }
    // GET /identity/audit/events
    if (req.method === 'GET' && parts.length === 3 && parts[1] === 'audit' && parts[2] === 'events') {
      return sendJson(res, 200, identityOrchestrator.queryAuditEvents(cfg, credential, auditQueryFromParams(url.searchParams)));
    }
    // POST /identity/audit/prune
    if (req.method === 'POST' && parts.length === 3 && parts[1] === 'audit' && parts[2] === 'prune') {
      return sendJson(res, 200, { pruned: identityOrchestrator.pruneAuditEvents(cfg, credential) });
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof UnauthenticatedError) return sendJson(res, 401, { error: 'unauthorized' });
    if (err instanceof ForbiddenError) return sendJson(res, 403, { error: 'forbidden' });
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}
