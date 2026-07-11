import * as crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { signSsoState, verifySsoState, authenticateSession } from './auth.js';
import { buildAuthorizationUrl, exchangeCode, resolveSubject } from './idp.js';
import {
  resolveEnabledProvider,
  tryAppendAudit,
  buildSsoAuditEvent,
  ANONYMOUS_SSO_ACTOR,
  UnauthenticatedError,
  ForbiddenError,
  type SsoStatePayload,
} from './identity.js';
import { findUserByExternalSubject, upsertUser } from './users.js';
import {
  createWebSession,
  removeWebSession,
  pruneExpiredWebSessions,
  touchWebSession,
  listWebSessionsBySubject,
} from './websessions.js';
import { resolveProjectRoot } from './projects.js';
import { runWithProjectRoot } from '../utils/fs.js';
import { hostCore, validateProjectAsComplete } from './adapters.js';
import { generateLandscape } from './landscape.js';
import { sendJson } from './request.js';
import type { ValidationIssue } from '../core/validation.js';
import type {
  HostConfig,
  HostedUserRecord,
  LandscapeGraphModel,
  WebContext,
  WebGraphModel,
  WebGraphNode,
  WebSession,
} from './types.js';

// ---------------------------------------------------------------------------
// Web Orchestrator + Web Graph Orchestrator + Web Portal (sdd_host)
//
// THREE components realize in this module (all sharing sourcePath src/server/web.ts):
//
// 1. web_orchestrator — the unified web UI's server-side shell: SSO sign-in
//    start/complete (unauthenticated, trust anchored by the signed SSO state and
//    the provider code exchange), browser-session lifecycle (create on sign-in,
//    remove on sign-out, opportunistic expired-session GC), the session-principal
//    context projection, and the graph entry point delegated to the graph
//    orchestrator. MULTI-DEVICE: prior sessions are left intact on sign-in, so one
//    principal may hold concurrent sessions; each is independently revocable, and
//    signOutEverywhere revokes them all. Audit appends are best-effort.
//
// 2. web_graph_orchestrator — the live level-of-detail graph: authenticate the
//    browser session to a Principal, then either reshape the already-scoped hosted
//    landscape (landscape tier) or project one authorized project's spec tree at
//    the requested detail level with validator issues overlaid (project tier).
//
// 3. web_portal — the browser-facing HTTP boundary: serves the client app shell at
//    the root and forwards the thin session/SSO/context/graph routes. The session
//    is the auth bridge — the served client reuses every scoped endpoint (e.g.
//    /mcp) with the session cookie in place of a bearer token.
//
// The SSO start/complete pair mirrors identity.ts's headless SSO login EXACTLY,
// with one difference: instead of minting an ApiKeyRecord token, sign-in creates a
// durable WebSession (whose id is itself a first-class credential). Every reusable
// helper is imported from identity.ts / auth.ts / idp.ts (never duplicated).
// ---------------------------------------------------------------------------

/** Browser session lifetime: long enough for a working session, short enough to
 *  bound a stolen cookie. The auth specialist rejects a session past its expiry. */
const WEB_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/** The write permissions that make a caller a project author in the web client. */
const WRITE_PERMISSIONS = ['mcp:write', 'project:create'];

// ── Web Orchestrator ─────────────────────────────────────────────────────────

/**
 * Begin a browser SSO sign-in: resolve the enabled provider, generate a nonce,
 * sign an SSO state binding providerId + nonce + redirectUri, build the provider
 * authorization URL, append a best-effort web.signin.start (info) audit event, and
 * return the authorization URL. Unauthenticated by nature — no caller credential.
 */
export function startSignIn(cfg: HostConfig, providerId: string, redirectUri: string): string {
  const provider = resolveEnabledProvider(cfg, providerId); // steps 1–4 (throws on unknown/disabled)

  const nonce = crypto.randomBytes(16).toString('hex'); // step 5
  const payload: SsoStatePayload = { providerId, nonce, redirectUri };
  const state = signSsoState(JSON.stringify(payload)); // step 6
  const url = buildAuthorizationUrl(provider, state, redirectUri); // step 7

  // steps 8–11: best-effort append (tryAppendAudit wraps the try/jump/catch).
  tryAppendAudit(cfg, buildSsoAuditEvent(ANONYMOUS_SSO_ACTOR, 'web.signin.start', 'info', { target: providerId }));

  return url; // step 12
}

/**
 * Complete a browser SSO sign-in: verify the signed state (tampered/expired is
 * rejected), resolve the bound enabled provider, exchange the code and resolve the
 * external subject, look up the hosted user by issuer + external subject, provision
 * a first-login active user with EMPTY grants when absent, reject re-login for an
 * existing deactivated user before creating a session, create a browser session
 * bound to the resolved subject and the user's CURRENT grants (prior sessions left
 * intact — multi-device), append a best-effort web.signin (security) audit event,
 * and return the new session id. Unauthenticated by nature — no caller credential.
 * Async: exchangeCode does provider network I/O.
 */
export async function completeSignIn(cfg: HostConfig, state: string, code: string): Promise<string> {
  // Verify + parse the signed state (throws on a tampered or expired state).
  const payload = JSON.parse(verifySsoState(state)) as SsoStatePayload; // steps 1–2
  const { providerId, redirectUri } = payload;

  const provider = resolveEnabledProvider(cfg, providerId); // steps 3–6

  // Exchange the code (network I/O) and resolve the external subject, never
  // leaking raw provider tokens across the boundary.
  const summary = await exchangeCode(provider, code, redirectUri); // step 7
  const subject = resolveSubject(provider, summary); // step 8

  // Look up the hosted user by issuer + external subject; provision on first login.
  let user = findUserByExternalSubject(cfg.dataDir, subject.issuer, subject.externalSubject ?? ''); // step 9
  if (!user) {
    // step 10 → 11
    const provisioned: HostedUserRecord = {
      id: subject.userId,
      subject,
      status: 'active',
      grants: [], // first-login: empty — an admin assigns grants afterwards
      createdAt: new Date().toISOString(),
    };
    user = upsertUser(cfg.dataDir, provisioned); // step 12
  }

  // Reject re-login for a deactivated user before creating a session. A freshly
  // provisioned first-login record is always active, so only an existing
  // deactivated user is rejected here.
  if (user.status !== 'active') {
    // steps 13–14
    throw new ForbiddenError('deactivated user may not sign in');
  }

  // Build the new WebSession (the repository mints the reserved-prefix id and
  // stamps createdAt/lastSeenAt). Grants = the user's CURRENT grants. Prior
  // sessions are LEFT INTACT so one principal may hold concurrent sessions.
  const session: WebSession = {
    id: '', // web_session_repository mints a ws_-prefixed id
    subject: user.subject,
    grants: user.grants,
    createdAt: '', // stamped by the registry
    expiresAt: new Date(Date.now() + WEB_SESSION_TTL_MS).toISOString(),
    providerId,
  }; // step 15
  const stored = createWebSession(cfg.dataDir, session); // step 16

  // steps 17–20: best-effort security-level append. The actor carries WHO signed
  // in; the target is the providerId (the session id is a secret credential and
  // must never be logged — the audit sink rejects credential-shaped targets).
  tryAppendAudit(cfg, buildSsoAuditEvent(user.subject, 'web.signin', 'security', { target: providerId }));

  return stored.id; // step 21 (the portal sets it as the session cookie)
}

/**
 * End a browser session: remove it by id, opportunistically prune all
 * already-expired sessions (housekeeping on the sign-out write path), and append a
 * best-effort web.signout (info) audit event. Never resolves the session (the id is
 * a secret credential), so the event carries no raw session id.
 */
export function signOut(cfg: HostConfig, sessionId: string): void {
  removeWebSession(cfg.dataDir, sessionId); // step 1
  pruneExpiredWebSessions(cfg.dataDir, new Date().toISOString()); // step 2

  // steps 3–6: best-effort append.
  tryAppendAudit(cfg, buildSsoAuditEvent(ANONYMOUS_SSO_ACTOR, 'web.signout', 'info'));
  // step 7: return once removed.
}

/**
 * Resolve the session to a Principal via the single auth authority's session
 * bridge (an expired/absent session is rejected), record activity by touching
 * lastSeenAt to now, then derive the capability flags and assemble the WebContext.
 * Reads only; not audited.
 */
export function getCurrentContext(cfg: HostConfig, sessionId: string): WebContext {
  const principal = authenticateSession(cfg.dataDir, sessionId); // step 1
  if (!principal.authenticated) throw new UnauthenticatedError();

  touchWebSession(cfg.dataDir, sessionId, new Date().toISOString()); // step 2

  // step 3: derive the capability flags from the principal's grants.
  const grants = principal.grants ?? [];
  const isAdmin = grants.some((g) => g.projectId === '*');
  // A write permission — or the '*' wildcard (which the permission model treats as
  // covering every permission) — makes the caller a project author.
  const canWriteProjects = grants.some(
    (g) => g.permissions.includes('*') || WRITE_PERMISSIONS.some((p) => g.permissions.includes(p)),
  );
  const visibleProjectIds = [...new Set(grants.filter((g) => g.projectId !== '*').map((g) => g.projectId))];
  const visibleUnitIds = [
    ...new Set(grants.filter((g) => g.orgUnitId !== undefined && g.orgUnitId !== '').map((g) => g.orgUnitId as string)),
  ];

  return {
    subject: principal.subject ?? { userId: principal.tokenId, kind: 'service', issuer: 'local' },
    grants,
    isAdmin,
    canWriteProjects,
    visibleProjectIds,
    visibleUnitIds,
  }; // step 4
}

/**
 * Return the live level-of-detail graph for the requested tier and detail level by
 * delegating to the web graph orchestrator, which authenticates the session and
 * scopes the result.
 */
export function getGraph(
  cfg: HostConfig,
  sessionId: string,
  tier: string,
  projectId: string,
  level: number,
): WebGraphModel {
  return getWebGraph(cfg, sessionId, tier, projectId, level); // step 1 (delegate)
}

/**
 * Revoke every browser session belonging to the caller's principal (sign out on
 * all devices/tabs): resolve the presented session to a Principal (an expired or
 * absent session yields an unauthenticated principal → idempotent no-op), remove
 * all of that subject's sessions, and append a best-effort web.signout.all
 * (security) audit event.
 */
export function signOutEverywhere(cfg: HostConfig, sessionId: string): void {
  const principal = authenticateSession(cfg.dataDir, sessionId); // step 1
  if (!principal.authenticated) {
    // steps 2–3: nothing to revoke.
    return;
  }

  const subject = principal.subject ?? { userId: principal.tokenId, kind: 'service', issuer: 'local' };
  const sessions = listWebSessionsBySubject(cfg.dataDir, subject.userId); // step 4
  for (const session of sessions) {
    // steps 5–6
    removeWebSession(cfg.dataDir, session.id);
  }

  // steps 7–10: best-effort security-level append. The actor carries the subject;
  // no session id is logged (the audit sink rejects credential-shaped targets).
  tryAppendAudit(cfg, buildSsoAuditEvent(subject, 'web.signout.all', 'security'));
  // step 11: return, all of the principal's sessions revoked.
}

// ── Web Graph Orchestrator ─────────────────────────────────────────────────────

/**
 * Resolve the session to a Principal (rejecting an expired/absent session as
 * unauthenticated). For tier 'landscape', delegate to the landscape orchestrator's
 * already-scoped generation (presenting the session id as the credential per the
 * auth bridge) and reshape the LandscapeGraphModel into a level-of-detail
 * WebGraphModel. For tier 'project', resolve+bind the requested project's isolated
 * root within the principal's authorized set (cross-project → Forbidden), project
 * its spec tree at the requested level, overlay validator issues as per-node issue
 * counts, and return it. An unknown tier is rejected.
 */
export function getWebGraph(
  cfg: HostConfig,
  sessionId: string,
  tier: string,
  projectId: string,
  level: number,
): WebGraphModel {
  const principal = authenticateSession(cfg.dataDir, sessionId); // step 1
  if (!principal.authenticated) throw new UnauthenticatedError();

  switch (tier) {
    // step 2
    case 'landscape': {
      // step 3: present the session id as the credential (the auth bridge — a
      // session resolves to a Principal exactly like a bearer). The landscape
      // orchestrator applies its own landscape:read scoping.
      const landscape = generateLandscape(cfg, sessionId, 'instance');
      return reshapeLandscapeGraph(landscape, level); // steps 4–5
    }
    case 'project': {
      // step 6: resolve+bind within the principal's authorized set (an out-of-scope
      // project resolves to null → Forbidden, no existence leak).
      const root = resolveProjectRoot(cfg.dataDir, principal, projectId);
      if (!root) {
        throw new ForbiddenError('project not authorized or unknown');
      }
      // steps 7–11: bind the root for the host-core reads that follow.
      return runWithProjectRoot(root, () => {
        const graph = hostCore.buildProjectGraph(level); // step 8
        const validation = validateProjectAsComplete(); // step 9
        return overlayProjectIssues(graph, validation.issues, projectId, level); // steps 10–11
      });
    }
    default:
      throw new Error('unsupported graph tier'); // step 12
  }
}

/**
 * Reshape an already-scoped LandscapeGraphModel into a level-of-detail
 * WebGraphModel: orgUnit → kind 'unit' at level 0 (carrying its parent unit as
 * parentId, derived from the hierarchy edges), project → kind 'project' at level 0,
 * publicInterface → kind 'interface' at level 2. Reuse the landscape edges as-is,
 * keep only nodes at or below the requested detail level, drop any edge whose
 * endpoint was filtered out, and stamp tier 'landscape', scope 'instance'.
 */
function reshapeLandscapeGraph(model: LandscapeGraphModel, level: number): WebGraphModel {
  const unitNodeIds = new Set(model.nodes.filter((n) => n.nodeKind === 'orgUnit').map((n) => n.id));
  // A unit's parent is the source of the hierarchy ('contains') edge whose target
  // is that unit and whose source is itself a unit node.
  const parentOf = new Map<string, string>();
  for (const e of model.edges) {
    if (unitNodeIds.has(e.to) && unitNodeIds.has(e.from)) parentOf.set(e.to, e.from);
  }

  const nodes: WebGraphNode[] = [];
  for (const n of model.nodes) {
    let kind: string;
    let nodeLevel: number;
    if (n.nodeKind === 'orgUnit') {
      kind = 'unit';
      nodeLevel = 0;
    } else if (n.nodeKind === 'project') {
      kind = 'project';
      nodeLevel = 0;
    } else if (n.nodeKind === 'publicInterface') {
      kind = 'interface';
      nodeLevel = 2;
    } else {
      continue; // an unrecognized landscape node kind is not projected
    }
    const node: WebGraphNode = { id: n.id, label: n.label, kind, level: nodeLevel };
    if (n.projectId !== undefined) node.projectId = n.projectId;
    if (n.status !== undefined) node.status = n.status;
    const parentId = parentOf.get(n.id);
    if (parentId !== undefined) node.parentId = parentId;
    nodes.push(node);
  }

  const kept = nodes.filter((n) => n.level <= level);
  const keptIds = new Set(kept.map((n) => n.id));
  const edges = model.edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to));

  return {
    tier: 'landscape',
    nodes: kept,
    edges,
    level,
    generatedAt: new Date().toISOString(),
    scope: 'instance',
  };
}

/**
 * Overlay validator issues onto a project graph's nodes as per-node issueCounts,
 * grouping each issue by the component/spec id it references, and stamp tier
 * 'project', scope = the project id, level = the requested level, generatedAt = now.
 */
function overlayProjectIssues(
  graph: WebGraphModel,
  issues: ValidationIssue[],
  projectId: string,
  level: number,
): WebGraphModel {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    const id = issue.specId;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const nodes = graph.nodes.map((n) => {
    const count = counts.get(n.id);
    return count !== undefined ? { ...n, issueCount: count } : n;
  });
  return {
    ...graph,
    nodes,
    tier: 'project',
    scope: projectId,
    level,
    generatedAt: new Date().toISOString(),
  };
}

// ── Web Portal (HTTP, DATA plane) ──────────────────────────────────────────────
//
// Browser-facing boundary. Serves the client app shell at the root and forwards the
// thin session/SSO/context/graph routes to the orchestrator. Rides the DATA-plane
// listener (gated by exposure.webUiEnabled in http.ts). The cookie/CSRF/exposure
// security decisions live in http.ts (routeData); this handler owns the route
// dispatch, cookie management on the response, and its own error → status mapping.

/** The browser cookie carrying the session id (a first-class credential). It is
 *  HttpOnly, so client JS cannot read it — the server reads it from the Cookie
 *  header as the auth bridge. */
export const WEB_SESSION_COOKIE = 'wairon_session';

/** Read the wairon_session cookie (a ws_-prefixed session id) from the request's
 *  Cookie header, or null when absent. */
export function sessionCookieValue(req: IncomingMessage): string | null {
  const header = req.headers['cookie'];
  if (!header) return null;
  const raw = Array.isArray(header) ? header.join(';') : header;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === WEB_SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The Set-Cookie value that installs the session cookie: HttpOnly + SameSite=Lax +
 *  Path=/, plus Secure when the effective exposure requires TLS. */
function setSessionCookie(sessionId: string, secure: boolean): string {
  return `${WEB_SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`;
}

/** The Set-Cookie value that clears the session cookie (Max-Age=0). */
function clearSessionCookie(secure: boolean): string {
  return `${WEB_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

/**
 * Serve the unified web UI client application shell for the requested path. No
 * orchestrator call; the app then drives every feature by calling existing scoped
 * endpoints with the session cookie as its credential.
 *
 * WAVE 3: a minimal, self-contained placeholder shell that proves the wiring —
 * it fetches /web/context and can request /web/graph with the X-Wairon-Web header.
 * Wave 4 replaces this with the real canvas-styled client.
 */
export function serveApp(_path: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Wairon</title>
</head>
<body>
<main>
<h1>Wairon</h1>
<p id="status">Loading context…</p>
<pre id="context"></pre>
<pre id="graph"></pre>
</main>
<script>
// The session cookie is HttpOnly (server-read), so the client attaches only the
// custom header the CSRF gate requires on same-origin fetches.
const WEB_HEADER = { 'X-Wairon-Web': '1' };
async function boot() {
  try {
    const ctxRes = await fetch('/web/context', { headers: WEB_HEADER, credentials: 'same-origin' });
    if (!ctxRes.ok) { document.getElementById('status').textContent = 'Not signed in.'; return; }
    const ctx = await ctxRes.json();
    document.getElementById('status').textContent = 'Signed in as ' + (ctx.subject && ctx.subject.userId);
    document.getElementById('context').textContent = JSON.stringify(ctx, null, 2);
    const first = (ctx.visibleProjectIds || [])[0];
    const q = first
      ? '/web/graph?tier=project&projectId=' + encodeURIComponent(first) + '&level=3'
      : '/web/graph?tier=landscape&level=2';
    const gRes = await fetch(q, { headers: WEB_HEADER, credentials: 'same-origin' });
    if (gRes.ok) document.getElementById('graph').textContent = JSON.stringify(await gRes.json(), null, 2);
  } catch (e) {
    document.getElementById('status').textContent = 'Error: ' + e;
  }
}
boot();
</script>
</body>
</html>`;
}

/**
 * Route one web UI request to the orchestrator and write the HTTP response,
 * managing the session cookie on the response. Owns its own error → status mapping
 * (401 unauthenticated, 403 forbidden, 404 unknown, 400 otherwise) so a fault never
 * escapes as an unhandled rejection. Called by http.ts (routeData) after gating on
 * exposure.webUiEnabled, extracting the credential, and enforcing CSRF. `body` is
 * the parsed request body; `ctx.sessionId` is the resolved credential (cookie or
 * bearer) presented for session-scoped routes; `ctx.secureCookie` decides Secure.
 */
export async function handleWebRequest(
  cfg: HostConfig,
  req: IncomingMessage,
  res: ServerResponse,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any,
  url: URL,
  ctx: { sessionId: string | null; secureCookie: boolean },
): Promise<void> {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['web', ...] or []
  const sessionId = ctx.sessionId ?? '';
  try {
    // GET / — the client app shell.
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(serveApp(url.pathname));
      return;
    }

    // POST /web/sso/start  { providerId, redirectUri } → { url }
    if (req.method === 'POST' && parts.length === 3 && parts[1] === 'sso' && parts[2] === 'start') {
      const authUrl = startSignIn(cfg, body?.providerId as string, body?.redirectUri as string);
      return sendJson(res, 200, { url: authUrl });
    }

    // GET /web/sso/callback?state=&code= → set the session cookie and land on /.
    if (req.method === 'GET' && parts.length === 3 && parts[1] === 'sso' && parts[2] === 'callback') {
      const newSessionId = await completeSignIn(
        cfg,
        url.searchParams.get('state') ?? '',
        url.searchParams.get('code') ?? '',
      );
      res.writeHead(302, {
        'set-cookie': setSessionCookie(newSessionId, ctx.secureCookie),
        location: '/',
      });
      res.end();
      return;
    }

    // POST /web/logout → end this session and clear the cookie.
    if (req.method === 'POST' && parts.length === 2 && parts[1] === 'logout') {
      signOut(cfg, sessionId);
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': clearSessionCookie(ctx.secureCookie) });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /web/logout-all → revoke all of the caller's sessions and clear the cookie.
    if (req.method === 'POST' && parts.length === 2 && parts[1] === 'logout-all') {
      signOutEverywhere(cfg, sessionId);
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': clearSessionCookie(ctx.secureCookie) });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /web/context → the session-principal context.
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'context') {
      return sendJson(res, 200, getCurrentContext(cfg, sessionId));
    }

    // GET /web/graph?tier=&projectId=&level= → the level-of-detail graph.
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'graph') {
      const tier = url.searchParams.get('tier') ?? 'landscape';
      const projectId = url.searchParams.get('projectId') ?? '';
      const level = Number(url.searchParams.get('level') ?? '0');
      return sendJson(res, 200, getGraph(cfg, sessionId, tier, projectId, level));
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof UnauthenticatedError) return sendJson(res, 401, { error: 'unauthorized' });
    if (err instanceof ForbiddenError) return sendJson(res, 403, { error: 'forbidden' });
    const msg = err instanceof Error ? err.message : String(err);
    if (/unsupported graph tier/i.test(msg)) return sendJson(res, 400, { error: msg });
    if (/not found|unknown/i.test(msg)) return sendJson(res, 404, { error: msg });
    return sendJson(res, 400, { error: msg });
  }
}
