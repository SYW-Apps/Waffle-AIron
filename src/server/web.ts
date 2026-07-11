import * as crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { signSsoState, verifySsoState, authenticateSession } from './auth.js';
import { buildAuthorizationUrl, exchangeCode, resolveSubject } from './idp.js';
import {
  resolveEnabledProvider,
  tryAppendAudit,
  buildSsoAuditEvent,
  ANONYMOUS_SSO_ACTOR,
  type SsoStatePayload,
} from './identity.js';
import { UnauthenticatedError, ForbiddenError } from './errors.js';
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
import { sendJson } from './httpio.js';
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
 * Return the interactive architecture canvas HTML for the requested project by
 * delegating to the web graph orchestrator, which authenticates the session and
 * scopes the result to the principal's authorized projects.
 */
export function getProjectCanvas(cfg: HostConfig, sessionId: string, projectId: string): string {
  return getWebProjectCanvas(cfg, sessionId, projectId); // step 1 (delegate)
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
 * Render ONE authorized project's interactive architecture canvas as a
 * self-contained HTML string, reusing the SAME engine as the static
 * `wairon diagram --format canvas` export (renderCanvasHtml: Cytoscape layout,
 * edge routing, type-ERD/database views, search, resizable details sidebar) —
 * NOT a second renderer. Resolve the session to a Principal (an expired/absent
 * session is unauthenticated), resolve+bind the requested project's isolated root
 * within the principal's authorized set (an out-of-scope or unknown project
 * resolves to null → Forbidden, no existence leak), then render the 'canvas'
 * diagram over the bound spec tree via the host core adapter.
 */
export function getWebProjectCanvas(cfg: HostConfig, sessionId: string, projectId: string): string {
  const principal = authenticateSession(cfg.dataDir, sessionId); // step 1
  if (!principal.authenticated) throw new UnauthenticatedError();

  // step 2: resolve+bind within the principal's authorized set.
  const root = resolveProjectRoot(cfg.dataDir, principal, projectId);
  if (!root) {
    throw new ForbiddenError('project not authorized or unknown');
  }

  // steps 3–5: bind the root and render the interactive canvas over the bound tree.
  return runWithProjectRoot(root, () => hostCore.renderDiagram('canvas'));
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
 * orchestrator call; the shell is a THIN host that boots the session context and
 * then embeds the REAL architecture canvas per project via a same-origin iframe.
 *
 * The canvas is NOT reimplemented here: the shell points an <iframe> at
 * GET /web/canvas?projectId=…, which renders the exported renderCanvasHtml canvas
 * (Cytoscape layout, edge routing, type-ERD/database views, search, resizable
 * details sidebar) over the selected project's spec tree — the SAME engine as the
 * static `wairon diagram --format canvas` export, not a second renderer. The shell
 * owns only the boot/login flow, the project picker, and the account menu, and it
 * reuses the exported canvas deep-space --syw-* theme so it reads as a sibling of
 * the embedded canvas.
 *
 * One self-contained HTML document — all CSS + JS inline, zero external assets
 * (the iframe loads a same-origin route). The inline script avoids template
 * literals / `$`+`{` so it embeds cleanly in this outer template string. Every
 * fetch keeps credentials:'same-origin' plus the X-Wairon-Web CSRF header.
 *
 * LOCAL DEV (ctx.local, from `wairon dev`): the ENTIRE top bar is hidden (no
 * picker, no account menu) and the single local project's canvas fills the
 * viewport with no chrome.
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
   Wairon unified web UI shell — a thin host around the real architecture canvas.
   Self-contained (all CSS + JS inline, no external assets). The --syw-* theme
   block is copied verbatim from src/core/canvas.ts so the shell reads as a
   sibling of the embedded canvas (which the iframe loads from /web/canvas).
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

/* ---- app chrome (top bar) ---- */
#app { display:flex; flex-direction:column; height:100vh; }
header { display:flex; align-items:center; gap:10px; padding:0 14px; height:52px; background:var(--chrome); border-bottom:1px solid var(--chrome-border); position:relative; z-index:20; flex:0 0 auto; }
header .brand { font-weight:800; font-size:17px; letter-spacing:.02em; }
.spacer { flex:1; }
.tbtn { border:1px solid var(--chrome-border); background:var(--input-bg); color:var(--ink); padding:6px 11px; border-radius:8px; cursor:pointer; font-size:12px; white-space:nowrap; }
.tbtn:hover { background:var(--hover-bg); border-color:var(--accent); }
.ctl { display:flex; align-items:center; gap:7px; color:var(--dim); font-size:12px; white-space:nowrap; }
.ctl select { appearance:none; -webkit-appearance:none; background:var(--input-bg); color:var(--ink); border:1px solid var(--chrome-border); border-radius:8px; padding:6px 12px; font:inherit; font-size:12px; color-scheme:dark; max-width:220px; }
.badge-admin { background:var(--syw-secondary-gradient); color:#2a1a02; font-weight:800; font-size:10px; text-transform:uppercase; letter-spacing:.06em; padding:2px 8px; border-radius:20px; }
.ro { color:var(--dim); font-size:11px; border:1px solid var(--line); border-radius:20px; padding:2px 8px; }
.dropdown { position:relative; }
.dropdown .menu { display:none; position:absolute; right:0; top:calc(100% + 6px); background:var(--chrome); border:1px solid var(--chrome-border); border-radius:10px; box-shadow:var(--syw-deep-shadow); min-width:210px; padding:6px; z-index:120; }
.dropdown.open .menu { display:block; }
.dropdown .menu button { display:block; width:100%; text-align:left; border:none; background:transparent; color:var(--ink); padding:9px 10px; border-radius:7px; cursor:pointer; font-size:12.5px; }
.dropdown .menu button:hover { background:var(--hover-bg); }
.acct { display:flex; align-items:center; gap:8px; }
.acct .who { font-size:12.5px; color:var(--ink); max-width:170px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

/* ---- stage / embedded canvas (the iframe IS the canvas) ---- */
#wrap { flex:1; min-height:0; position:relative; }
#cv { position:absolute; inset:0; width:100%; height:100%; border:0; display:block; background:var(--bg); }
.empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center; padding:24px; color:var(--dim); }
.empty .box { max-width:420px; background:var(--syw-surface-gradient); border:1px solid var(--chrome-border); border-radius:14px; padding:22px 24px; box-shadow:var(--syw-deep-shadow); }
.empty h3 { margin:0 0 6px; font-size:15px; color:var(--ink); }
.empty p { margin:0; font-size:12.5px; color:var(--dim); }
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
  <header id="topbar">
    <span class="brand syw-gradient-text">wairon</span>
    <div class="ctl" id="projCtl"><span>Project</span><select id="projSel"></select></div>
    <span class="spacer"></span>
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
    <iframe id="cv" title="Architecture canvas" referrerpolicy="same-origin"></iframe>
    <div class="empty" id="empty" hidden><div class="box"><h3>No project in scope</h3><p>There are no projects you can view yet.</p></div></div>
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
  var selectedProjectId = '';

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
  // There is no public "list providers" endpoint (provider config is admin-only),
  // so the login screen takes a provider-id text input defaulted to 'default'.
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
    // LOCAL DEV MODE (ctx.local, from wairon dev): hide the ENTIRE top bar — no
    // project picker, no account menu — and let the single local project's canvas
    // fill the viewport with no chrome.
    var isLocal = !!(ctx && ctx.local);
    $('topbar').hidden = isLocal;
    $('whoLbl').textContent = (ctx.subject && ctx.subject.userId) || 'signed in';
    $('adminBadge').hidden = !ctx.isAdmin;
    // Role-aware: when the caller cannot author, show a read-only marker (there
    // are no write affordances in the shell yet — this only avoids implying write).
    $('roBadge').hidden = !!ctx.canWriteProjects;

    var pids = ctx.visibleProjectIds || [];
    var sel = $('projSel'); sel.innerHTML = '';
    pids.forEach(function (pid) {
      var o = document.createElement('option'); o.value = pid; o.textContent = pid; sel.appendChild(o);
    });
    // Default the selection to the first visible project.
    selectedProjectId = pids.length ? pids[0] : '';
    sel.value = selectedProjectId;
    // Hide the picker when there is nothing to choose (or in local single-project mode).
    $('projCtl').style.display = (!isLocal && pids.length > 0) ? 'flex' : 'none';
    loadCanvas();
  }

  // ---- embedded canvas ----------------------------------------------------
  // The iframe IS the canvas: it loads the SAME renderCanvasHtml engine as the
  // static export, scoped to the selected project on a same-origin route. No
  // diagram rendering happens in this shell.
  function loadCanvas() {
    if (!selectedProjectId) { $('cv').hidden = true; $('empty').hidden = false; return; }
    $('empty').hidden = true; $('cv').hidden = false;
    $('cv').src = '/web/canvas?projectId=' + encodeURIComponent(selectedProjectId);
  }

  // ---- controls -----------------------------------------------------------
  $('projSel').addEventListener('change', function () { selectedProjectId = $('projSel').value; loadCanvas(); });

  // account menu (sign out this device / everywhere)
  $('acctBtn').addEventListener('click', function (e) { e.stopPropagation(); $('acctDd').classList.toggle('open'); });
  document.addEventListener('click', function () { $('acctDd').classList.remove('open'); });
  $('signout').addEventListener('click', function () { doLogout('/web/logout'); });
  $('signoutAll').addEventListener('click', function () { doLogout('/web/logout-all'); });
  function doLogout(path) { api(path, { method: 'POST' }).then(function () { location.reload(); }).catch(function () { location.reload(); }); }

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

    // GET /web/canvas?projectId= → one authorized project's interactive canvas HTML.
    // The web UI shell embeds this per selected project via a same-origin iframe,
    // reusing the SAME canvas engine as the static export. Cross-project → 403.
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'canvas') {
      const projectId = url.searchParams.get('projectId') ?? '';
      const canvasHtml = getProjectCanvas(cfg, sessionId, projectId);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(canvasHtml);
      return;
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
