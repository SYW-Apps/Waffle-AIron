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
  PrincipalSubject,
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

// ── Local developer server (`wairon dev`) conventions ────────────────────────
//
// The single-project dev server auto-signs a synthetic local-developer identity
// into a session scoped to exactly ONE local project (never instance-wide), so a
// leaked dev session can only touch that one local tree. These constants are the
// sole source of those conventions (subject id, project id, session lifetime).

/** The synthetic identity behind the local dev session: a service principal issued
 *  locally. Its userId is the subject key startDevSession lists/reuses by. */
const DEV_SUBJECT: PrincipalSubject = { userId: 'local-dev', kind: 'service', issuer: 'local' };

/** The fixed hosted-project id the dev server registers the cwd under. */
const DEV_PROJECT_ID = 'local';

/** Dev session lifetime — long enough to span a working session and repeated
 *  `wairon dev` restarts (the dev data dir is stable per cwd, so the session is
 *  reused rather than churned), yet still bounded. */
const DEV_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
    // local signals the reused client to hide the tenancy/login chrome. It is the
    // server posture (cfg.devMode), never a session/grant property — only the local
    // developer server sets it, so the hosted UI always sees local=false.
    local: !!cfg.devMode,
  }; // step 4
}

/**
 * Mint (or reuse) the local-developer session for the single-project dev server and
 * return its id. REFUSED unless the server is in local developer mode (cfg.devMode)
 * — this is the ONLY unauthenticated session-minting path and it exists solely for
 * `wairon dev` (loopback, auth off). The session is bound to a synthetic
 * local-developer subject with a grant on the ONE local project (never an
 * instance-wide '*' grant), so a leaked dev session is scoped to that one local
 * project. Reuses an existing dev session rather than churning the store on every
 * cookieless hit.
 */
export function startDevSession(cfg: HostConfig): string {
  // steps 1–2: never mint a dev session in a hosted deployment.
  if (!cfg.devMode) {
    throw new Error('dev session is only available under wairon dev (devMode)');
  }

  // step 3: list existing sessions for the synthetic local-developer subject.
  const existing = listWebSessionsBySubject(cfg.dataDir, DEV_SUBJECT.userId);

  // steps 4–5: reuse an existing dev session (no churn).
  if (existing.length > 0) {
    return existing[0].id;
  }

  // step 6: build a new session bound to the local-developer subject with a single
  // PROJECT-SCOPED grant on the one local project (never instance-wide '*').
  const session: WebSession = {
    id: '', // web_session_repository mints a ws_-prefixed id
    subject: DEV_SUBJECT,
    grants: [{ projectId: DEV_PROJECT_ID, permissions: ['mcp:read', 'mcp:write'] }],
    createdAt: '', // stamped by the registry
    expiresAt: new Date(Date.now() + DEV_SESSION_TTL_MS).toISOString(),
  };
  const stored = createWebSession(cfg.dataDir, session); // step 7

  return stored.id; // step 8
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
 *  Path=/, plus Secure when the effective exposure requires TLS. Exported so the
 *  HTTP layer can install the cookie inline on the dev auto-login path. */
export function setSessionCookie(sessionId: string, secure: boolean): string {
  return `${WEB_SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`;
}

/** The Set-Cookie value that clears the session cookie (Max-Age=0). */
function clearSessionCookie(secure: boolean): string {
  return `${WEB_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

/**
 * Serve the unified web UI client application shell for the requested path. No
 * orchestrator call; the app then drives every feature by calling existing scoped
 * endpoints (`/web/context`, `/web/graph`, `/web/sso/start`, `/web/logout[-all]`)
 * with the HttpOnly session cookie as its credential plus the X-Wairon-Web CSRF
 * header.
 *
 * WAVE 4: the real interactive, role-aware, level-of-detail spec canvas. One
 * self-contained HTML document — all CSS + JS inline, zero external assets. It
 * reuses the exported architecture-canvas deep-space --syw-* theme (see
 * src/core/canvas.ts) so the live client reads as a sibling of the exported
 * canvas: hierarchical layered layout by parentId, pan/zoom, expand/collapse,
 * edges styled by edgeKind, node colour by kind, status + issue-count overlays,
 * and a resizable side panel derived entirely from the loaded WebGraphModel.
 *
 * The whole page is a single template string on purpose (it is large). The inline
 * script avoids template literals / `$`+`{` so it embeds cleanly here.
 */
export function serveApp(_path: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>wairon — spec canvas</title>
<style>
/* ==========================================================================
   Wairon unified web UI — interactive level-of-detail spec canvas.
   Self-contained (all CSS + JS inline, no external assets). The --syw-* theme
   block is copied verbatim from src/core/canvas.ts so this live client looks
   like a sibling of the exported architecture canvas.
   ========================================================================== */
:root {
  --syw-cyan: #22ddff;
  --syw-purple: #8b5cf6;
  --syw-yellow: #ddff22;
  --syw-amber: #f59e0b;
  --syw-bg: #0a0a0f;
  --syw-deep-space: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #312e81 100%);
  --syw-surface: rgba(13, 27, 42, 0.95);
  --syw-primary-gradient: linear-gradient(135deg, #22ddff 0%, #8b5cf6 100%);
  --syw-secondary-gradient: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
  --syw-surface-gradient: linear-gradient(135deg, rgba(13, 27, 42, 0.95) 0%, rgba(27, 38, 59, 0.98) 100%);
  --syw-glow: 0 0 20px rgba(34, 221, 255, 0.3);
  --syw-deep-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}
body[data-theme="syw"] {
  --bg: var(--syw-bg);
  --chrome: #0e1a2b;
  --chrome-border: rgba(34, 221, 255, 0.22);
  --ink: #e8ecf3;
  --dim: #9db0c7;
  --line: rgba(255,255,255,0.12);
  --input-bg: rgba(255,255,255,0.07);
  --hover-bg: rgba(34, 221, 255, 0.12);
  --accent: var(--syw-cyan);
  --card: rgba(255,255,255,0.05);
  --danger: #ff6b81; --warn: #f59e0b;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin:0; background:var(--bg); background-image:var(--syw-deep-space); background-attachment:fixed; color:var(--ink); font:13px/1.45 "Inter", system-ui, "Segoe UI", sans-serif; overflow:hidden; }
.syw-gradient-text { background:var(--syw-primary-gradient); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }
button { font:inherit; }
[hidden] { display:none !important; }

/* ---- boot + login ---- */
#boot { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; color:var(--dim); }
#login { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; padding:20px; }
#login .card { width:min(400px, 92vw); background:var(--syw-surface-gradient); border:1px solid var(--chrome-border); border-radius:16px; box-shadow:var(--syw-deep-shadow); padding:30px 28px; }
#login h1 { margin:0 0 4px; font-size:30px; font-weight:800; letter-spacing:.02em; }
#login .sub { color:var(--dim); margin:0 0 22px; font-size:13px; }
#login label { display:block; color:var(--dim); font-size:11.5px; text-transform:uppercase; letter-spacing:.06em; margin:0 0 6px; }
#login input { width:100%; padding:10px 12px; border:1px solid var(--chrome-border); border-radius:9px; background:var(--input-bg); color:var(--ink); font:inherit; margin-bottom:16px; }
#login input:focus { outline:none; border-color:var(--accent); box-shadow:var(--syw-glow); }
.btn-primary { width:100%; border:none; border-radius:10px; padding:11px 14px; font-weight:700; color:#04121b; background:var(--syw-primary-gradient); cursor:pointer; }
.btn-primary:hover { box-shadow:var(--syw-glow); }
#login .err { color:var(--danger); font-size:12px; min-height:16px; margin-top:10px; }

/* ---- app chrome ---- */
#app { display:flex; flex-direction:column; height:100vh; }
header { display:flex; align-items:center; gap:10px; padding:0 14px; height:52px; background:var(--chrome); border-bottom:1px solid var(--chrome-border); position:relative; z-index:20; flex:0 0 auto; }
header .brand { font-weight:800; font-size:17px; letter-spacing:.02em; }
.spacer { flex:1; }
.seg { display:flex; border:1px solid var(--chrome-border); border-radius:8px; overflow:hidden; }
.seg button { border:none; background:transparent; color:var(--dim); padding:5px 11px; cursor:pointer; font-size:12px; }
.seg button.active { background:var(--accent); color:#04121b; font-weight:700; }
.tbtn { border:1px solid var(--chrome-border); background:var(--input-bg); color:var(--ink); padding:6px 11px; border-radius:8px; cursor:pointer; font-size:12px; white-space:nowrap; }
.tbtn:hover { background:var(--hover-bg); border-color:var(--accent); }
.ctl { display:flex; align-items:center; gap:7px; color:var(--dim); font-size:12px; white-space:nowrap; }
.ctl select { appearance:none; -webkit-appearance:none; background:var(--input-bg); color:var(--ink); border:1px solid var(--chrome-border); border-radius:8px; padding:6px 12px; font:inherit; font-size:12px; color-scheme:dark; max-width:180px; }
.ctl input[type=range] { accent-color:var(--accent); width:110px; }
.badge-admin { background:var(--syw-secondary-gradient); color:#2a1a02; font-weight:800; font-size:10px; text-transform:uppercase; letter-spacing:.06em; padding:2px 8px; border-radius:20px; }
.ro { color:var(--dim); font-size:11px; border:1px solid var(--line); border-radius:20px; padding:2px 8px; }
.dropdown { position:relative; }
.dropdown .menu { display:none; position:absolute; right:0; top:calc(100% + 6px); background:var(--chrome); border:1px solid var(--chrome-border); border-radius:10px; box-shadow:var(--syw-deep-shadow); min-width:210px; padding:6px; z-index:120; }
.dropdown.open .menu { display:block; }
.dropdown .menu button { display:block; width:100%; text-align:left; border:none; background:transparent; color:var(--ink); padding:9px 10px; border-radius:7px; cursor:pointer; font-size:12.5px; }
.dropdown .menu button:hover { background:var(--hover-bg); }
.acct { display:flex; align-items:center; gap:8px; }
.acct .who { font-size:12.5px; color:var(--ink); max-width:170px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

/* ---- stage / canvas / panel ---- */
#wrap { display:flex; flex:1; min-height:0; }
#stage { flex:1; min-width:0; position:relative; overflow:hidden; }
#cv { position:absolute; inset:0; width:100%; height:100%; touch-action:none; cursor:grab; display:block; }
body.panning #cv { cursor:grabbing; }
.legend { position:absolute; left:12px; bottom:12px; background:var(--chrome); border:1px solid var(--chrome-border); border-radius:10px; padding:8px 11px; font-size:11px; color:var(--dim); z-index:5; pointer-events:none; max-width:66vw; }
.legend .sw { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:4px; vertical-align:-1px; border:1.5px solid; }
.overlay { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center; padding:24px; z-index:6; pointer-events:none; }
.overlay .box { max-width:440px; background:var(--syw-surface-gradient); border:1px solid var(--chrome-border); border-radius:14px; padding:22px 24px; box-shadow:var(--syw-deep-shadow); pointer-events:auto; }
.overlay.err .box { border-color:var(--danger); }
.overlay h3 { margin:0 0 6px; font-size:15px; }
.overlay p { margin:0; color:var(--dim); font-size:12.5px; word-break:break-word; }
.overlay .tbtn { margin-top:14px; }

#panelResizer { flex:0 0 7px; cursor:col-resize; background:var(--chrome); border-left:1px solid var(--chrome-border); border-right:1px solid var(--line); position:relative; }
#panelResizer::after { content:''; position:absolute; top:50%; left:50%; width:2px; height:48px; transform:translate(-50%, -50%); border-radius:2px; background:var(--dim); opacity:.45; }
#panelResizer:hover::after, body.resizing-panel #panelResizer::after { background:var(--accent); opacity:1; }
#panel { width:var(--panel-width, 360px); flex:0 0 var(--panel-width, 360px); border-left:1px solid var(--chrome-border); background:var(--chrome); overflow-y:auto; }
body.panel-closed #panel, body.panel-closed #panelResizer { display:none; }
body.resizing-panel { cursor:col-resize; user-select:none; }
#panel .head { padding:16px 18px 12px; border-bottom:1px solid var(--line); }
#panel .head h2 { font-size:16px; margin:0 0 8px; word-break:break-word; }
#panel .body { padding:12px 18px 40px; }
.kv { display:flex; gap:8px; font-size:12px; margin:3px 0; color:var(--dim); }
.kv span { min-width:56px; }
.kv b { color:var(--ink); font-weight:600; word-break:break-all; }
.pill { display:inline-block; padding:2px 9px; border-radius:11px; font-size:11px; border:1px solid var(--chrome-border); margin:0 4px 6px 0; background:var(--input-bg); color:var(--ink); }
.sec { margin-top:16px; }
.sec h4 { margin:0 0 7px; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); }
.chip { display:inline-block; padding:3px 10px; border-radius:8px; font-size:11.5px; border:1px solid var(--chrome-border); margin:0 5px 6px 0; background:var(--card); color:var(--ink); cursor:pointer; }
.chip:hover { border-color:var(--accent); background:var(--hover-bg); }
.chip .k { color:var(--dim); font-size:10px; margin-right:5px; }
.muted { color:var(--dim); font-size:12px; }

/* ---- graph (inline SVG) ---- */
.edge { fill:none; stroke:rgba(255,255,255,0.26); stroke-width:1.5; }
.e-owns { stroke:#a78bfa; stroke-dasharray:6 5; stroke-width:1.4; }
.e-depends { stroke:#22ddff; stroke-width:1.6; }
.gnode { cursor:pointer; }
.gnode .box { stroke-width:1.6; }
.gnode .lbl { font-size:11px; font-family:"Inter", system-ui, sans-serif; dominant-baseline:middle; text-anchor:middle; pointer-events:none; }
.k-unit .box { fill:#0d2b4d; stroke:#22ddff; } .k-unit .lbl { fill:#d8f6ff; }
.k-project .box { fill:#26300a; stroke:#ddff22; } .k-project .lbl { fill:#f2ffcc; }
.k-subsystem .box { fill:#2a2052; stroke:#a78bfa; } .k-subsystem .lbl { fill:#eae2ff; }
.k-component .box { fill:#0f3323; stroke:#34d399; } .k-component .lbl { fill:#d3f8e6; }
.k-interface .box { fill:#3a2c10; stroke:#f59e0b; } .k-interface .lbl { fill:#ffe9c2; }
.k-type .box { fill:#321a3d; stroke:#c084fc; } .k-type .lbl { fill:#f0dcff; }
.s-draft .box { stroke-dasharray:5 4; opacity:.92; }
.s-complete .box { stroke-width:2.6; }
.gnode.sel .box { stroke:var(--syw-yellow); stroke-width:2.8; filter:drop-shadow(0 0 6px rgba(221,255,34,.55)); }
.toggle { cursor:pointer; }
.toggle circle { fill:var(--chrome); stroke:var(--accent); stroke-width:1.4; }
.toggle text { fill:var(--accent); font-size:13px; text-anchor:middle; dominant-baseline:central; pointer-events:none; font-weight:700; }
.badge circle { fill:var(--warn); stroke:#1a1204; stroke-width:1; }
.badge text { fill:#1a1204; font-size:9px; font-weight:800; text-anchor:middle; dominant-baseline:central; pointer-events:none; }

@media (max-width: 820px) {
  header { overflow-x:auto; }
  #panel { position:absolute; top:0; right:0; bottom:0; width:min(var(--panel-width,320px), calc(100vw - 44px)); flex-basis:auto; box-shadow:var(--syw-deep-shadow); z-index:10; }
  #panelResizer { position:absolute; top:0; bottom:0; right:min(var(--panel-width,320px), calc(100vw - 44px)); z-index:11; }
}
</style>
</head>
<body data-theme="syw">
<div id="boot">Loading…</div>

<!-- ============================ LOGIN SCREEN ============================ -->
<div id="login" hidden>
  <div class="card">
    <h1 class="syw-gradient-text">wairon</h1>
    <p class="sub">Spec-driven architecture canvas</p>
    <label for="pid">Identity provider</label>
    <input id="pid" value="default" spellcheck="false" autocomplete="off" />
    <button class="btn-primary" id="signinBtn">Sign in with SSO</button>
    <div class="err" id="loginErr"></div>
  </div>
</div>

<!-- ============================ APPLICATION ============================ -->
<div id="app" hidden>
  <header>
    <span class="brand syw-gradient-text">wairon</span>
    <div class="seg" id="tierSeg" title="Landscape overview or a single project">
      <button data-tier="landscape">Landscape</button>
      <button data-tier="project">Project</button>
    </div>
    <div class="ctl" id="projCtl"><span>Project</span><select id="projSel"></select></div>
    <div class="ctl" title="Level of detail (0 = coarse, 3 = interfaces/types)"><span>Detail</span><input id="levelRange" type="range" min="0" max="3" step="1" /><b id="levelVal" style="color:var(--ink)">3</b></div>
    <span class="spacer"></span>
    <button class="tbtn" id="fitBtn" title="Fit the graph to view">Fit</button>
    <button class="tbtn" id="panelToggle" title="Show or hide the details panel">Details</button>
    <span class="ro" id="roBadge" hidden title="Your grants are read-only">read-only</span>
    <div class="dropdown acct" id="acctDd">
      <span class="badge-admin" id="adminBadge" hidden>admin</span>
      <button class="tbtn" id="acctBtn"><span class="who" id="whoLbl">&hellip;</span> &#9662;</button>
      <div class="menu">
        <button id="signout">Sign out</button>
        <button id="signoutAll">Sign out everywhere</button>
      </div>
    </div>
  </header>
  <div id="wrap">
    <div id="stage">
      <svg id="cv"><defs><marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#22ddff"/></marker></defs><g id="scene"></g></svg>
      <div class="legend" id="legend"></div>
      <div class="overlay" id="overlay" hidden><div class="box"><h3 id="ovTitle"></h3><p id="ovMsg"></p><button class="tbtn" id="ovBtn" hidden></button></div></div>
    </div>
    <div id="panelResizer" title="Drag to resize the details panel"></div>
    <div id="panel"><div class="body muted" style="padding:22px 18px">Select a node to inspect it.</div></div>
  </div>
</div>

<script>
(function () {
  'use strict';

  // Every request rides the HttpOnly session cookie (attached automatically) plus
  // the X-Wairon-Web header the CSRF gate requires on cookie-auth mutations.
  var WEB = { 'X-Wairon-Web': '1' };
  function api(path, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    opts.headers = Object.assign({}, opts.headers || {}, WEB);
    return fetch(path, opts);
  }
  function $(id) { return document.getElementById(id); }

  // ---- screens ------------------------------------------------------------
  function showBoot() { $('boot').hidden = false; $('login').hidden = true; $('app').hidden = true; }
  function showLogin(msg) { $('boot').hidden = true; $('app').hidden = true; $('login').hidden = false; $('loginErr').textContent = msg || ''; }
  function showApp() { $('boot').hidden = true; $('login').hidden = true; $('app').hidden = false; }

  // ---- state --------------------------------------------------------------
  var ctx = null;
  var state = { tier: 'landscape', projectId: '', level: 2 };
  var graph = null;
  var collapsed = {};
  var selectedId = null;
  var view = { x: 0, y: 0, k: 1 };
  var pos = {};
  var nodesById = {}, childrenByParent = {}, parentOf = {}, roots = [];
  var NW = 182, NH = 42, HW = NW / 2, HH = NH / 2, COL = 232, ROW = 64, PADX = 48, PADY = 44;
  var STRUCT = { contains: 1, owns: 1, publishes: 1, shared_with: 1 };

  // ---- boot ---------------------------------------------------------------
  function boot() {
    showBoot();
    api('/web/context').then(function (r) {
      if (r.status === 401) { showLogin(''); return null; }
      if (!r.ok) throw new Error('context ' + r.status);
      return r.json();
    }).then(function (c) { if (c) { ctx = c; startApp(); } })
      .catch(function () { showLogin('Could not reach the server. Try signing in.'); });
  }

  // ---- login --------------------------------------------------------------
  // WAVE-4 LIMITATION: there is no public "list providers" endpoint (provider
  // config is admin-only), so the login screen takes a provider-id text input
  // defaulted to 'default'. A public enabled-provider-id list is a future add.
  $('signinBtn').addEventListener('click', function () {
    var pid = ($('pid').value || '').trim() || 'default';
    $('loginErr').textContent = '';
    api('/web/sso/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: pid, redirectUri: location.origin + '/web/sso/callback' }),
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || ('sign-in failed (' + r.status + ')')); });
      return r.json();
    }).then(function (d) { location.href = d.url; })
      .catch(function (e) { $('loginErr').textContent = (e && e.message) || 'Sign-in failed.'; });
  });
  $('pid').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('signinBtn').click(); });

  // ---- app start ----------------------------------------------------------
  function startApp() {
    showApp();
    // LOCAL DEV MODE (ctx.local, from wairon dev): the SAME reused client hides every
    // tenancy/login/account affordance and pins to the single local project. The
    // canvas, LOD slider, side panel, and pan/zoom stay byte-for-byte identical.
    var isLocal = !!(ctx && ctx.local);
    if (isLocal) {
      $('tierSeg').hidden = true;    // no Landscape/Project tier toggle — project tier only
      $('acctDd').hidden = true;     // no account menu / sign-out / sign-out-everywhere
      $('adminBadge').hidden = true; // no admin badge
      $('roBadge').hidden = true;    // no tenancy read-only marker
    }
    $('whoLbl').textContent = (ctx.subject && ctx.subject.userId) || 'signed in';
    if (!isLocal) $('adminBadge').hidden = !ctx.isAdmin;
    // Role-aware: when the caller cannot author, show a read-only marker (there
    // are no write affordances server-side yet — this only avoids implying write).
    if (!isLocal) $('roBadge').hidden = !!ctx.canWriteProjects;
    var sel = $('projSel'); sel.innerHTML = '';
    (ctx.visibleProjectIds || []).forEach(function (pid) {
      var o = document.createElement('option'); o.value = pid; o.textContent = pid; sel.appendChild(o);
    });
    // Default: project tier on the first visible project at level 3 if any, else
    // landscape at level 2 (mirrors the wave-3 placeholder's default choice).
    if ((ctx.visibleProjectIds || []).length) { state.tier = 'project'; state.projectId = ctx.visibleProjectIds[0]; state.level = 3; }
    else { state.tier = 'landscape'; state.projectId = ''; state.level = 2; }
    sel.value = state.projectId;
    $('levelRange').value = String(state.level); $('levelVal').textContent = String(state.level);
    syncControls();
    loadGraph();
  }

  function syncControls() {
    Array.prototype.forEach.call(document.querySelectorAll('#tierSeg button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-tier') === state.tier);
    });
    var hasProjects = (ctx.visibleProjectIds || []).length > 0;
    // In local dev mode the project picker is hidden (there is only the one local project).
    var local = !!(ctx && ctx.local);
    $('projCtl').style.display = (!local && state.tier === 'project' && hasProjects) ? 'flex' : 'none';
  }

  // ---- controls -----------------------------------------------------------
  Array.prototype.forEach.call(document.querySelectorAll('#tierSeg button'), function (b) {
    b.addEventListener('click', function () {
      state.tier = b.getAttribute('data-tier');
      if (state.tier === 'project' && !state.projectId && (ctx.visibleProjectIds || []).length) {
        state.projectId = ctx.visibleProjectIds[0]; $('projSel').value = state.projectId;
      }
      syncControls(); loadGraph();
    });
  });
  $('projSel').addEventListener('change', function () { state.projectId = $('projSel').value; loadGraph(); });
  $('levelRange').addEventListener('input', function () { state.level = Number($('levelRange').value); $('levelVal').textContent = String(state.level); });
  $('levelRange').addEventListener('change', function () { state.level = Number($('levelRange').value); loadGraph(); });
  $('fitBtn').addEventListener('click', fitView);

  // account menu
  $('acctBtn').addEventListener('click', function (e) { e.stopPropagation(); $('acctDd').classList.toggle('open'); });
  document.addEventListener('click', function () { $('acctDd').classList.remove('open'); });
  $('signout').addEventListener('click', function () { doLogout('/web/logout'); });
  $('signoutAll').addEventListener('click', function () { doLogout('/web/logout-all'); });
  function doLogout(path) { api(path, { method: 'POST' }).then(function () { location.reload(); }).catch(function () { location.reload(); }); }

  // panel toggle + resize (mirrors the canvas.ts resizable side panel)
  $('panelToggle').addEventListener('click', function () { document.body.classList.toggle('panel-closed'); setTimeout(applyTransform, 40); });
  (function () {
    var r = $('panelResizer'); var PMIN = 260, PMAX = 560;
    r.addEventListener('mousedown', function (ev) {
      ev.preventDefault(); document.body.classList.add('resizing-panel'); document.body.classList.remove('panel-closed');
      function mv(m) { var w = Math.max(PMIN, Math.min(PMAX, window.innerWidth - m.clientX)); document.documentElement.style.setProperty('--panel-width', w + 'px'); applyTransform(); }
      function up() { document.body.classList.remove('resizing-panel'); document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
  })();

  // ---- graph fetch --------------------------------------------------------
  function loadGraph() {
    var q = '/web/graph?tier=' + encodeURIComponent(state.tier) + '&level=' + encodeURIComponent(state.level);
    if (state.tier === 'project') q += '&projectId=' + encodeURIComponent(state.projectId || '');
    overlay('Loading graph\\u2026', '', null, false);
    api(q).then(function (r) {
      if (r.status === 401) { showLogin(''); return null; }
      if (r.status === 403) throw new Error('You are not authorized to view this scope.');
      if (!r.ok) throw new Error('Graph request failed (' + r.status + ').');
      return r.json();
    }).then(function (g) {
      if (!g) return;
      graph = g; collapsed = {}; selectedId = null; buildIndex();
      if (!graph.nodes.length) { renderEmpty(); return; }
      hideOverlay(); layout(); renderGraph(); fitView(); renderPanel();
    }).catch(function (e) { renderError((e && e.message) || 'Something went wrong loading the graph.'); });
  }

  // ---- indexing / hierarchy ----------------------------------------------
  function buildIndex() {
    nodesById = {}; childrenByParent = {}; parentOf = {}; roots = [];
    graph.nodes.forEach(function (n) { nodesById[n.id] = n; });
    // A node's structural parent is its explicit parentId when present, else the
    // source of the first structural edge (contains/owns/publishes/shared_with)
    // pointing at it — so both tiers get a hierarchy even when parentId is unset.
    var edgeParent = {};
    graph.edges.forEach(function (e) {
      if (STRUCT[e.edgeKind] && nodesById[e.from] && nodesById[e.to] && edgeParent[e.to] === undefined) edgeParent[e.to] = e.from;
    });
    graph.nodes.forEach(function (n) {
      var p = (n.parentId && nodesById[n.parentId]) ? n.parentId : (edgeParent[n.id] !== undefined ? edgeParent[n.id] : null);
      if (p === n.id) p = null;
      parentOf[n.id] = p;
      if (p === null) roots.push(n); else (childrenByParent[p] = childrenByParent[p] || []).push(n.id);
    });
  }
  function ancestors(id) { var out = [], p = parentOf[id], guard = 0; while (p && guard++ < 999) { out.push(p); p = parentOf[p]; } return out; }
  function hasChildren(id) { return (childrenByParent[id] || []).length > 0; }
  function isVisible(id) { var a = ancestors(id); for (var i = 0; i < a.length; i++) if (collapsed[a[i]]) return false; return true; }

  // ---- layout (tidy left-to-right layered tree by containment) -----------
  function layout() {
    pos = {}; var yCur = { v: PADY }; var seen = {};
    function place(id, depth) {
      if (seen[id]) return; seen[id] = true;
      var kids = collapsed[id] ? [] : (childrenByParent[id] || []);
      var x = PADX + depth * COL;
      if (!kids.length) { pos[id] = { x: x, y: yCur.v }; yCur.v += ROW; return; }
      var ys = [];
      kids.forEach(function (k) { place(k, depth + 1); if (pos[k]) ys.push(pos[k].y); });
      if (ys.length) pos[id] = { x: x, y: (ys[0] + ys[ys.length - 1]) / 2 };
      else { pos[id] = { x: x, y: yCur.v }; yCur.v += ROW; }
    }
    roots.forEach(function (r) { place(r.id, 0); });
    graph.nodes.forEach(function (n) { if (!pos[n.id] && isVisible(n.id)) { pos[n.id] = { x: PADX, y: yCur.v }; yCur.v += ROW; } });
  }

  // ---- render helpers -----------------------------------------------------
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '\\u2026' : s; }
  function borderPt(cx, cy, tx, ty) {
    var dx = tx - cx, dy = ty - cy; if (!dx && !dy) return { x: cx, y: cy };
    var sx = dx ? HW / Math.abs(dx) : Infinity, sy = dy ? HH / Math.abs(dy) : Infinity, s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }

  function renderGraph() {
    var vis = {}; graph.nodes.forEach(function (n) { if (isVisible(n.id) && pos[n.id]) vis[n.id] = true; });
    // A huge transparent backdrop guarantees a pan hit-target anywhere.
    var svg = '<rect x="-50000" y="-50000" width="100000" height="100000" fill="transparent"/>';
    // Edges: contains = solid structural, owns/publishes/shared_with = dashed,
    // depends_on (and other collaborator kinds) = arrowed.
    graph.edges.forEach(function (e) {
      if (!vis[e.from] || !vis[e.to]) return;
      var a = pos[e.from], b = pos[e.to]; if (!a || !b) return;
      var p1 = borderPt(a.x, a.y, b.x, b.y), p2 = borderPt(b.x, b.y, a.x, a.y);
      var cls = 'edge', mk = '';
      if (e.edgeKind === 'owns' || e.edgeKind === 'publishes' || e.edgeKind === 'shared_with') cls = 'edge e-owns';
      else if (e.edgeKind !== 'contains') { cls = 'edge e-depends'; mk = ' marker-end="url(#arw)"'; }
      svg += '<line class="' + cls + '" x1="' + p1.x.toFixed(1) + '" y1="' + p1.y.toFixed(1) + '" x2="' + p2.x.toFixed(1) + '" y2="' + p2.y.toFixed(1) + '"' + mk + '/>';
    });
    // Nodes.
    graph.nodes.forEach(function (n) {
      if (!vis[n.id]) return; var p = pos[n.id];
      var cls = 'gnode k-' + esc(n.kind) + (n.status ? ' s-' + esc(n.status) : '') + (n.id === selectedId ? ' sel' : '');
      var x = p.x - HW, y = p.y - HH;
      svg += '<g class="' + cls + '" data-node="' + esc(n.id) + '">';
      svg += '<rect class="box" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + NW + '" height="' + NH + '" rx="9"/>';
      svg += '<text class="lbl" x="' + p.x.toFixed(1) + '" y="' + p.y.toFixed(1) + '">' + esc(trunc(n.label || n.id, 24)) + '</text>';
      if (n.issueCount) {
        var bx = x + NW - 7, by = y + 7;
        svg += '<g class="badge"><circle cx="' + bx.toFixed(1) + '" cy="' + by.toFixed(1) + '" r="9"/><text x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '">' + esc(n.issueCount > 99 ? '99+' : String(n.issueCount)) + '</text></g>';
      }
      if (hasChildren(n.id)) {
        var tx = x + NW, ty = p.y;
        svg += '<g class="toggle" data-toggle="' + esc(n.id) + '"><circle cx="' + tx.toFixed(1) + '" cy="' + ty.toFixed(1) + '" r="9"/><text x="' + tx.toFixed(1) + '" y="' + ty.toFixed(1) + '">' + (collapsed[n.id] ? '+' : '\\u2212') + '</text></g>';
      }
      svg += '</g>';
    });
    $('scene').innerHTML = svg;
    applyTransform();
    renderLegend();
  }

  function renderLegend() {
    var kinds = [['unit', '#22ddff', '#0d2b4d'], ['project', '#ddff22', '#26300a'], ['subsystem', '#a78bfa', '#2a2052'], ['component', '#34d399', '#0f3323'], ['interface', '#f59e0b', '#3a2c10'], ['type', '#c084fc', '#321a3d']];
    var present = {}; graph.nodes.forEach(function (n) { present[n.kind] = true; });
    var html = kinds.filter(function (k) { return present[k[0]]; }).map(function (k) {
      return '<span class="sw" style="background:' + k[2] + ';border-color:' + k[1] + '"></span>' + k[0];
    }).join('&nbsp; ');
    html += '<br><span style="opacity:.85">\\u2014 contains&nbsp; &nbsp;\\u00b7\\u00b7 owns&nbsp; &nbsp;\\u2192 depends</span>';
    $('legend').innerHTML = html;
  }

  // ---- selection + side panel --------------------------------------------
  function selectNode(id) { selectedId = id; renderGraph(); renderPanel(); }
  function revealAndSelect(id) {
    if (!nodesById[id]) return;
    ancestors(id).forEach(function (a) { collapsed[a] = false; });
    layout(); selectedId = id; renderGraph(); renderPanel();
  }
  function chip(id, khint) { var n = nodesById[id]; var k = khint || (n ? n.kind : '?'); return '<span class="chip" data-goto="' + esc(id) + '"><span class="k">' + esc(k) + '</span>' + esc(n ? (n.label || id) : id) + '</span>'; }
  function section(title, ids) {
    if (!ids.length) return '<div class="sec"><h4>' + esc(title) + '</h4><span class="muted">none</span></div>';
    return '<div class="sec"><h4>' + esc(title) + '</h4>' + ids.map(function (id) { return chip(id); }).join('') + '</div>';
  }
  function relSection(title, pairs) {
    return '<div class="sec"><h4>' + esc(title) + '</h4>' + pairs.map(function (pk) { var a = pk.split('|'); return chip(a[0], a[1]); }).join('') + '</div>';
  }
  function renderPanel() {
    var panel = $('panel');
    if (!selectedId || !nodesById[selectedId]) { panel.innerHTML = '<div class="body muted" style="padding:22px 18px">Select a node to inspect it.</div>'; return; }
    var n = nodesById[selectedId];
    var owns = [], deps = [], rel = [], parent = parentOf[n.id];
    graph.edges.forEach(function (e) {
      if (e.from !== n.id) return;
      if (e.edgeKind === 'owns') owns.push(e.to);
      else if (e.edgeKind === 'depends_on') deps.push(e.to);
      else if (e.edgeKind === 'consumes' || e.edgeKind === 'mirrors' || e.edgeKind === 'publishes' || e.edgeKind === 'shared_with') rel.push(e.to + '|' + e.edgeKind);
    });
    var h = '<div class="head"><h2>' + esc(n.label || n.id) + '</h2>';
    h += '<span class="pill">' + esc(n.kind) + '</span>';
    if (n.status) h += '<span class="pill">' + esc(n.status) + '</span>';
    if (n.issueCount) h += '<span class="pill" style="border-color:var(--warn);color:var(--warn)">\\u26a0 ' + esc(String(n.issueCount)) + '</span>';
    h += '</div><div class="body">';
    h += '<div class="kv"><span>id</span><b>' + esc(n.id) + '</b></div>';
    h += '<div class="kv"><span>level</span><b>' + esc(String(n.level)) + '</b></div>';
    if (n.projectId) h += '<div class="kv"><span>project</span><b>' + esc(n.projectId) + '</b></div>';
    h += section('Contained by', parent ? [parent] : []);
    h += section('Owns', owns);
    h += section('Depends on', deps);
    if (rel.length) h += relSection('Related', rel);
    h += '</div>';
    panel.innerHTML = h;
    Array.prototype.forEach.call(panel.querySelectorAll('[data-goto]'), function (c) {
      c.addEventListener('click', function () { revealAndSelect(c.getAttribute('data-goto')); });
    });
  }

  // ---- overlays (loading / empty / error) --------------------------------
  function overlay(title, msg, btn, isErr) {
    var o = $('overlay'); o.hidden = false; o.className = 'overlay' + (isErr ? ' err' : '');
    $('ovTitle').textContent = title; $('ovMsg').textContent = msg || '';
    var b = $('ovBtn');
    if (btn) { b.hidden = false; b.textContent = btn.label; b.onclick = btn.fn; } else { b.hidden = true; b.onclick = null; }
  }
  function hideOverlay() { $('overlay').hidden = true; }
  function renderEmpty() { $('scene').innerHTML = ''; $('legend').innerHTML = ''; renderPanel(); overlay('Nothing in scope', 'There are no nodes to show for this tier and level yet.', { label: 'Reload', fn: loadGraph }, false); }
  function renderError(msg) { $('scene').innerHTML = ''; $('legend').innerHTML = ''; overlay('Could not load the graph', msg, { label: 'Retry', fn: loadGraph }, true); }

  // ---- pan / zoom ---------------------------------------------------------
  function applyTransform() { $('scene').setAttribute('transform', 'translate(' + view.x.toFixed(2) + ',' + view.y.toFixed(2) + ') scale(' + view.k.toFixed(4) + ')'); }
  function bounds() {
    var xs = [], ys = [];
    graph.nodes.forEach(function (n) { if (pos[n.id] && isVisible(n.id)) { xs.push(pos[n.id].x); ys.push(pos[n.id].y); } });
    if (!xs.length) return null;
    return { minx: Math.min.apply(null, xs) - HW, maxx: Math.max.apply(null, xs) + HW, miny: Math.min.apply(null, ys) - HH, maxy: Math.max.apply(null, ys) + HH };
  }
  function fitView() {
    if (!graph) return; var b = bounds(); if (!b) return;
    var rect = $('cv').getBoundingClientRect();
    var w = (b.maxx - b.minx) + 80, h = (b.maxy - b.miny) + 80;
    var k = Math.min(rect.width / w, rect.height / h); k = Math.max(0.15, Math.min(1.4, k || 1));
    view.k = k; view.x = rect.width / 2 - ((b.minx + b.maxx) / 2) * k; view.y = rect.height / 2 - ((b.miny + b.maxy) / 2) * k;
    applyTransform();
  }
  var cv = $('cv');
  cv.addEventListener('wheel', function (e) {
    e.preventDefault();
    var rect = cv.getBoundingClientRect(); var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var f = Math.exp(-e.deltaY * 0.0015); var nk = Math.max(0.15, Math.min(3, view.k * f));
    var wx = (mx - view.x) / view.k, wy = (my - view.y) / view.k;
    view.k = nk; view.x = mx - wx * nk; view.y = my - wy * nk; applyTransform();
  }, { passive: false });
  cv.addEventListener('mousedown', function (e) {
    if (e.target.closest && (e.target.closest('[data-node]') || e.target.closest('[data-toggle]'))) return;
    var sx = e.clientX, sy = e.clientY, ox = view.x, oy = view.y; document.body.classList.add('panning');
    function mv(ev) { view.x = ox + (ev.clientX - sx); view.y = oy + (ev.clientY - sy); applyTransform(); }
    function up() { document.body.classList.remove('panning'); document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });
  // Click: expand/collapse a node's subtree, or select a node.
  cv.addEventListener('click', function (e) {
    var tg = e.target.closest ? e.target.closest('[data-toggle]') : null;
    if (tg) { var tid = tg.getAttribute('data-toggle'); collapsed[tid] = !collapsed[tid]; layout(); renderGraph(); return; }
    var nd = e.target.closest ? e.target.closest('[data-node]') : null;
    if (nd) selectNode(nd.getAttribute('data-node'));
  });
  window.addEventListener('resize', function () { applyTransform(); });

  boot();
})();
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

    // GET /web/dev-login — DEV MODE ONLY. Mint/reuse the local-developer session,
    // set the cookie, and land on '/'. http.ts mounts this route only under devMode
    // (it 404s otherwise), and startDevSession itself refuses outside devMode, so it
    // can never establish a session in a hosted deployment.
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'dev-login') {
      const devSessionId = startDevSession(cfg);
      res.writeHead(302, {
        'set-cookie': setSessionCookie(devSessionId, ctx.secureCookie),
        location: '/',
      });
      res.end();
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
