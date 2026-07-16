import * as crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { signSsoState, verifySsoState, authenticateSession, verifyBuiltinAdmin } from './auth.js';
import { resolveEndpoints, buildAuthorizationUrl, exchangeCode, resolveSubject, resolveGroups } from './idp.js';
import {
  resolveEnabledProvider,
  tryAppendAudit,
  buildSsoAuditEvent,
  isInAdminGroup,
  ANONYMOUS_SSO_ACTOR,
  type SsoStatePayload,
} from './identity.js';
import { SSO_ADMIN_ROLE_ID } from './roles.js';
import * as webadmin from './webadmin.js';
import * as webproject from './webproject.js';
import { listIdentityProviderRecords } from './policy.js';
import { getInstanceIdentity } from './instance.js';
import { assertAllowedRedirectUri } from './idp.js';
import { getHealthReport, getUsage } from './operations.js';
import { listPendingRequests, decideRequest } from './projectlifecycle.js';
import { UnauthenticatedError, ForbiddenError, AdminAuthError } from './errors.js';
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
  ApprovalDecision,
  HostConfig,
  HostedUserRecord,
  IdentityProviderConfig,
  LandscapeGraphModel,
  OrganizationUnitRecord,
  PrincipalSubject,
  WebContext,
  WebGraphModel,
  WebGraphNode,
  WebLoginOptions,
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

// ── Local developer server (`wairon dev`) conventions ────────────────────────
//
// The single-project dev server auto-signs a synthetic local-developer identity
// into a session scoped to exactly ONE local project (never instance-wide), so a
// leaked dev session can only touch that one local tree. These constants are the
// sole source of those conventions (subject id, project id, session lifetime).

/** The synthetic identity behind the local dev session: the PERSISTED
 *  boot-reserved local-developer UUID (issuer 'local', seeded by the lifecycle
 *  init entrypoint), which the auth specialist recognizes as instance-admin by
 *  its full tuple. Throws when the instance identity has never been seeded —
 *  the dev server always runs init before serving. */
function devSubject(cfg: HostConfig): PrincipalSubject {
  const identity = getInstanceIdentity(cfg.dataDir);
  if (!identity) {
    throw new Error('instance identity is not seeded — the lifecycle init entrypoint must run before dev sessions mint');
  }
  return { userId: identity.localDevUserId, kind: 'human', issuer: 'local' };
}

/** The fixed hosted-project id the dev server registers the cwd under. */
const DEV_PROJECT_ID = 'local';

/** Dev session lifetime — long enough to span a working session and repeated
 *  `wairon dev` restarts (the dev data dir is stable per cwd, so the session is
 *  reused rather than churned), yet still bounded. */
const DEV_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Web Orchestrator ─────────────────────────────────────────────────────────

/**
 * Return the pre-auth login options the login screen renders from: passwordLogin
 * = whether the built-in admin password login is configured (BOTH env-anchored
 * builtinAdminUser and builtinAdminPassword set on the host config — either
 * unset means password login is disabled), and providers = one { id, displayName }
 * entry per ENABLED identity provider read through the policy repository,
 * displayName defaulting to the provider id when the admin set none.
 * Unauthenticated by nature — a pre-auth read for the login page. The projection
 * carries ONLY provider ids and display labels (standard, safe pre-auth SSO
 * discovery); never secrets, clientIds, endpoints, or any other config. Reads
 * only; not audited.
 */
export function getLoginOptions(cfg: HostConfig): WebLoginOptions {
  // step 1: password login is configured only when BOTH env values are set.
  const passwordLogin = !!(cfg.builtinAdminUser && cfg.builtinAdminPassword);

  // steps 2–3: read the providers through the policy repository, keep only the
  // ENABLED ones, and project each to exactly { id, displayName } — no secret,
  // clientId, endpoint, or any other config field ever crosses into the
  // pre-auth payload.
  const providers = listIdentityProviderRecords(cfg.dataDir)
    .filter((p) => p.enabled)
    .map((p) => ({ id: p.id, displayName: p.displayName || p.id }));

  return { passwordLogin, providers }; // step 4
}

/**
 * Begin a browser SSO sign-in: resolve the enabled provider, generate a nonce,
 * sign an SSO state binding providerId + nonce + redirectUri, build the provider
 * authorization URL, append a best-effort web.signin.start (info) audit event, and
 * return the authorization URL together with the nonce. The caller (the HTTP
 * portal) installs the nonce as a short-lived HttpOnly cookie so the callback can
 * prove the completing browser is the one that started — defeating login CSRF.
 * Unauthenticated by nature — no caller credential.
 */
export async function startSignIn(
  cfg: HostConfig,
  providerId: string,
  redirectUri: string,
): Promise<{ url: string; nonce: string }> {
  const provider = resolveEnabledProvider(cfg, providerId); // steps 1–4 (throws on unknown/disabled)

  // Pin the redirect URI to the provider's server-side allowlist (when configured)
  // — the callback destination must never be attacker-chosen (open-redirect /
  // code-delivery hardening on top of the nonce-cookie login-CSRF defense).
  assertAllowedRedirectUri(provider, redirectUri);

  const nonce = crypto.randomBytes(16).toString('hex'); // step 5
  const payload: SsoStatePayload = { providerId, nonce, redirectUri };
  const state = signSsoState(JSON.stringify(payload)); // step 6
  // step 7: resolve the provider's concrete endpoints (overrides -> discovery ->
  // template); step 8: build the authorization URL against the front-channel endpoint.
  const endpoints = await resolveEndpoints(provider);
  const url = buildAuthorizationUrl(provider, endpoints, state, redirectUri);

  // steps 9–12: best-effort append (tryAppendAudit wraps the try/jump/catch).
  tryAppendAudit(cfg, buildSsoAuditEvent(ANONYMOUS_SSO_ACTOR, 'web.signin.start', 'info', { target: providerId }));

  return { url, nonce }; // step 13
}

/**
 * Complete a browser SSO sign-in: verify the signed state (tampered/expired is
 * rejected), resolve the bound enabled provider, exchange the code and resolve the
 * external subject, look up the hosted user by issuer + external subject, provision
 * a first-login active user (binding the built-in sso-admin role when the verified
 * groups match adminGroupClaims) when absent, reject re-login for an existing
 * deactivated user before creating a session, refresh the sso-admin role binding
 * against the verified membership, and create a permission-free browser session
 * bound to the resolved subject (prior sessions left intact — multi-device);
 * append a best-effort web.signin (security) audit event and return the new
 * session id. Unauthenticated by nature — no caller credential.
 * `expectedNonce` is the value of the browser's SSO-nonce cookie: it MUST equal
 * the nonce inside the signed state, proving the completing browser is the one
 * that started the flow (login-CSRF defense). Async: exchangeCode does provider
 * network I/O.
 */
export async function completeSignIn(cfg: HostConfig, state: string, code: string, expectedNonce: string | null): Promise<string> {
  // Verify + parse the signed state (throws on a tampered or expired state).
  const payload = JSON.parse(verifySsoState(state)) as SsoStatePayload; // steps 1–2
  const { providerId, redirectUri } = payload;

  // Bind the completing browser to the initiating one: the state's nonce must
  // match the HttpOnly nonce cookie. A forged/replayed callback delivered to a
  // victim carries no matching cookie (an attacker cannot set it), so it fails
  // closed — the login-CSRF vector.
  if (!nonceMatches(payload.nonce, expectedNonce)) {
    throw new ForbiddenError('SSO state does not match this browser — restart sign-in');
  }

  const provider = resolveEnabledProvider(cfg, providerId); // steps 3–6

  // step 7: resolve the provider endpoints (front-channel authorize + back-channel
  // token/jwks, honoring split-horizon overrides). step 8: exchange the code
  // (network I/O). step 9: verify the id_token against the JWKS and resolve the
  // external subject — never leaking raw provider tokens across the boundary.
  const endpoints = await resolveEndpoints(provider);
  const summary = await exchangeCode(provider, endpoints, code, redirectUri);
  const subject = await resolveSubject(provider, endpoints, summary);

  // steps 10–11: read the groups claim from the SAME summary resolveSubject just
  // verified, then decide the SSO-admin membership against adminGroupClaims.
  const groups = resolveGroups(summary);
  const inAdminGroup = isInAdminGroup(provider, groups);

  // Look up the hosted user by issuer + external subject; provision on first login.
  let user = findUserByExternalSubject(cfg.dataDir, subject.issuer, subject.externalSubject ?? ''); // step 12
  if (!user) {
    // steps 13 → 14
    const provisioned: HostedUserRecord = {
      id: subject.userId,
      subject,
      status: 'active',
      // first-login: bind the built-in sso-admin ROLE when the verified groups
      // match adminGroupClaims, otherwise no bindings — an admin assigns roles
      // and grid assignments later. Permissions never live on the user record;
      // the role resolves through the permission resolver (project:admin +
      // project:create @instance, OVERRIDABLE — never the instance-admin bypass).
      roleBindings: inAdminGroup ? [{ roleId: SSO_ADMIN_ROLE_ID }] : [],
      createdAt: new Date().toISOString(),
    };
    user = upsertUser(cfg.dataDir, provisioned); // step 15
  }

  // Reject re-login for a deactivated user before creating a session. A freshly
  // provisioned first-login record is always active, so only an existing
  // deactivated user is rejected here.
  if (user.status !== 'active') {
    // steps 16–17
    throw new ForbiddenError('deactivated user may not sign in');
  }

  // steps 18–19: refresh the sso-admin ROLE BINDING when it disagrees with the
  // verified admin-group membership — entering the group binds the role, leaving
  // it unbinds it on this login (server-driven, straight through the repository).
  const bindings = user.roleBindings ?? [];
  const hasSsoAdmin = bindings.some((b) => b.roleId === SSO_ADMIN_ROLE_ID);
  if (hasSsoAdmin !== inAdminGroup) {
    user = upsertUser(cfg.dataDir, {
      ...user,
      roleBindings: inAdminGroup
        ? [...bindings, { roleId: SSO_ADMIN_ROLE_ID }]
        : bindings.filter((b) => b.roleId !== SSO_ADMIN_ROLE_ID),
    });
  }

  // Build the new WebSession (the repository mints the reserved-prefix id and
  // stamps createdAt/lastSeenAt). The session stores NO permissions and no
  // narrowing ('*'): the auth specialist resolves the subject's permissionSubject
  // (roleBindings + instanceAdmin) LIVE on every request, so revocations take
  // effect immediately. Prior sessions are LEFT INTACT so one principal may hold
  // concurrent sessions.
  const session: WebSession = {
    id: '', // web_session_repository mints a ws_-prefixed id
    subject: user.subject,
    projects: ['*'],
    createdAt: '', // stamped by the registry
    expiresAt: new Date(Date.now() + WEB_SESSION_TTL_MS).toISOString(),
    providerId,
  }; // step 20
  const stored = createWebSession(cfg.dataDir, session); // step 21

  // steps 22–25: best-effort security-level append. The actor carries WHO signed
  // in; the target is the providerId (the session id is a secret credential and
  // must never be logged — the audit sink rejects credential-shaped targets).
  tryAppendAudit(cfg, buildSsoAuditEvent(user.subject, 'web.signin', 'security', { target: providerId }));

  return stored.id; // step 26 (the portal sets it as the session cookie)
}

// ── Built-in super-admin password sign-in ─────────────────────────────────────
//
// The env-anchored (WAIRON_ADMIN_USER/_PASSWORD) web login. This is the ONLY path
// to an instance-wide *:* session: the identity orchestrator hard-reserves that
// grant away from user records and minted tokens, so the double-wildcard exists
// exclusively on sessions minted here (and on the master-token principal).

/** Consecutive failures per username before a short lockout begins. */
const LOGIN_THROTTLE_MAX_FAILS = 5;
/** Lockout duration once the failure threshold is reached. */
const LOGIN_THROTTLE_LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Transient, in-memory failed-attempt state per presented username. A module-level
 *  Map — deliberately NOT a store: it holds no authoritative state, is lost on
 *  restart, and exists only as a minimal anti-bruteforce speed bump. */
const loginThrottle = new Map<string, { fails: number; lockedUntil: number }>();

/** Clear the transient login throttle. Test hook only (mirrors __clearIdpCaches). */
export function __resetLoginThrottle(): void {
  loginThrottle.clear();
}

/**
 * Sign the built-in super-admin in with the env-configured username + password.
 * Consult the minimal in-memory failed-attempt throttle first (~5 consecutive
 * failures lock the username out for a short window; attempts during the lockout
 * are rejected outright). Verify BOTH values via the auth specialist's
 * constant-time verifyBuiltinAdmin (unset env = password login disabled, always
 * fails). On failure, record the attempt and reject as unauthenticated. On
 * success, clear the throttle entry and create a browser session bound to the
 * stable built-in super-admin subject carrying the single instance-wide
 * super-admin grant ({projectId '*', permissions ['*']}) — the ONLY *:* in the
 * system. Appends a best-effort web.signin.password (security) audit event and
 * returns the new session id (the portal sets it as the session cookie).
 */
export function signInWithPassword(cfg: HostConfig, user: string, password: string): string {
  const key = String(user ?? '');
  const now = Date.now();

  // steps 1–2: an active lockout rejects outright, without consulting credentials.
  const entry = loginThrottle.get(key);
  if (entry && entry.lockedUntil > now) {
    throw new UnauthenticatedError();
  }
  // A lockout that has lapsed resets the counter (fresh window).
  if (entry && entry.lockedUntil !== 0 && entry.lockedUntil <= now) {
    loginThrottle.delete(key);
  }

  // step 3: constant-time verification of BOTH values (null on mismatch/disabled).
  const subject = verifyBuiltinAdmin(cfg, user, password);
  if (!subject) {
    // steps 4–6: record the failure (starting a short lockout at the threshold)
    // and reject — the same rejection for a wrong credential and disabled login.
    const fails = (loginThrottle.get(key)?.fails ?? 0) + 1;
    loginThrottle.set(key, {
      fails,
      lockedUntil: fails >= LOGIN_THROTTLE_MAX_FAILS ? now + LOGIN_THROTTLE_LOCKOUT_MS : 0,
    });
    throw new UnauthenticatedError();
  }

  // step 7: success clears the throttle. The session stores NO permissions —
  // the subject IS the persisted built-in super-admin, so the auth specialist
  // resolves instanceAdmin (the resolver bypass) live at authentication.
  loginThrottle.delete(key);
  const session: WebSession = {
    id: '', // web_session_repository mints a ws_-prefixed id
    subject,
    projects: ['*'],
    createdAt: '', // stamped by the registry
    expiresAt: new Date(now + WEB_SESSION_TTL_MS).toISOString(),
  };
  const stored = createWebSession(cfg.dataDir, session); // step 8

  // steps 9–12: best-effort security-level append (no credential-shaped target).
  tryAppendAudit(cfg, buildSsoAuditEvent(subject, 'web.signin.password', 'security'));

  return stored.id; // step 13 (the portal sets it as the session cookie)
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
 * lastSeenAt to now, and assemble the slim WebContext. Reads only; not audited.
 */
export function getCurrentContext(cfg: HostConfig, sessionId: string): WebContext {
  const principal = authenticateSession(cfg.dataDir, sessionId); // step 1
  if (!principal.authenticated) throw new UnauthenticatedError();

  touchWebSession(cfg.dataDir, sessionId, new Date().toISOString()); // step 2

  // step 3: the coarse instance-admin flag comes from the resolved permission
  // subject (the env-anchored super-admin / master / devMode subject — the
  // resolver bypass). The context carries NO permission projections: the client
  // lists projects via /web/projects (resolver-filtered server-side) and drives
  // delegated/SSO admin chrome from its project:admin visible scopes.
  return {
    subject: principal.subject ?? { userId: principal.tokenId, kind: 'service', issuer: 'local' },
    isAdmin: principal.permissionSubject?.instanceAdmin === true,
    // local signals the reused client to hide the tenancy/login chrome. It is the
    // server posture (cfg.devMode), never a session property — only the local
    // developer server sets it, so the hosted UI always sees local=false.
    local: !!cfg.devMode,
  }; // step 4
}

/**
 * Mint (or reuse) the local-developer session for the single-project dev server and
 * return its id. REFUSED unless the server is in local developer mode (cfg.devMode)
 * — this is the ONLY unauthenticated session-minting path and it exists solely for
 * `wairon dev` (loopback, auth off). The session is bound to the persisted
 * boot-reserved local-developer subject, narrowed to the ONE local project; it
 * carries NO permissions of its own — the auth specialist resolves THIS subject's
 * permissionSubject (instanceAdmin = full local access) live at authentication.
 * Reuses an existing dev session rather than churning the store on every
 * cookieless hit.
 */
export function startDevSession(cfg: HostConfig): string {
  // steps 1–2: never mint a dev session in a hosted deployment.
  if (!cfg.devMode) {
    throw new Error('dev session is only available under wairon dev (devMode)');
  }

  // step 3: list existing sessions for the synthetic local-developer subject.
  const dev = devSubject(cfg);
  const existing = listWebSessionsBySubject(cfg.dataDir, dev.userId);

  // steps 4–5: reuse an existing dev session (no churn).
  if (existing.length > 0) {
    return existing[0].id;
  }

  // step 6: build a new session bound to the local-developer subject, narrowed to
  // the one local project (never instance-wide '*'); the session stores NO
  // permissions — authentication resolves them live from the subject identity.
  const session: WebSession = {
    id: '', // web_session_repository mints a ws_-prefixed id
    subject: dev,
    projects: [DEV_PROJECT_ID],
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
      // step 6: authorize on the RESOLVED, org-unit-aware mcp:read scope — the
      // same scoped set the web project orchestrator lists. The flat
      // principal.projects projection carries a literal '*' for a unit-scoped
      // '*'+orgUnitId grant, so the authorized-set bind alone would read
      // ANOTHER tenant's spec tree; the scoped project list bounds a unit
      // grant to its subtree. Then resolve+bind the project's isolated root
      // (out-of-scope, unknown, and inactive all yield the same Forbidden — no
      // existence leak).
      if (!webproject.listProjects(cfg, sessionId).some((r) => r.id === projectId)) {
        throw new ForbiddenError('project not authorized or unknown');
      }
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

  // step 2: authorize on the RESOLVED, org-unit-aware mcp:read scope (the same
  // scoped set the web project orchestrator lists — a unit-scoped '*'+orgUnitId
  // grant projects a flat '*' into principal.projects and must NOT render
  // another tenant's canvas), then resolve+bind within the principal's
  // authorized set.
  if (!webproject.listProjects(cfg, sessionId).some((r) => r.id === projectId)) {
    throw new ForbiddenError('project not authorized or unknown');
  }
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

/** Short-lived cookie binding the browser that STARTED an SSO flow to the one that
 *  COMPLETES it — the callback requires the cookie's nonce to equal the nonce inside
 *  the signed state, which defeats login CSRF (an attacker cannot set this HttpOnly
 *  cookie in the victim's browser). Lives only for the ~10-min SSO round-trip. */
export const WEB_SSO_NONCE_COOKIE = 'wairon_sso_nonce';
const SSO_NONCE_MAX_AGE_S = 600;

function ssoNonceCookieValue(req: IncomingMessage): string | null {
  const header = req.headers['cookie'];
  if (!header) return null;
  const raw = Array.isArray(header) ? header.join(';') : header;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === WEB_SSO_NONCE_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

function setNonceCookie(nonce: string, secure: boolean): string {
  return `${WEB_SSO_NONCE_COOKIE}=${nonce}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SSO_NONCE_MAX_AGE_S}${secure ? '; Secure' : ''}`;
}

function clearNonceCookie(secure: boolean): string {
  return `${WEB_SSO_NONCE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** Constant-time equality for the two hex nonces (absent cookie fails closed). */
function nonceMatches(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
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
 * The login screen is DYNAMIC: it fetches the public pre-auth GET
 * /web/login-options and renders the username/password form only when the
 * built-in admin login is configured, plus one "Sign in with <displayName>"
 * button per ENABLED identity provider (no free-text provider input). No
 * providers → no SSO section; neither method → a clear "No sign-in method is
 * configured" message.
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
.login-sep { display:flex; align-items:center; gap:10px; color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.08em; margin:16px 0; }
.login-sep::before, .login-sep::after { content:""; flex:1; border-top:1px solid var(--line); }
.btn-sso { display:block; width:100%; border:1px solid var(--chrome-border); border-radius:10px; padding:11px 14px; font-weight:700; color:var(--ink); background:var(--input-bg); cursor:pointer; margin:0 0 10px; }
.btn-sso:hover { border-color:var(--accent); box-shadow:var(--syw-glow); }
#login .none { color:var(--dim); font-size:12.5px; border:1px solid var(--line); border-radius:10px; padding:12px 14px; }

/* ---- app chrome (top bar) ---- */
#app { display:flex; flex-direction:column; height:100vh; }
header { display:flex; align-items:center; gap:10px; padding:0 14px; height:52px; background:var(--chrome); border-bottom:1px solid var(--chrome-border); position:relative; z-index:20; flex:0 0 auto; }
header .brand { font-weight:800; font-size:17px; letter-spacing:.02em; }
.spacer { flex:1; }
.tbtn { border:1px solid var(--chrome-border); background:var(--input-bg); color:var(--ink); padding:6px 11px; border-radius:8px; cursor:pointer; font-size:12px; white-space:nowrap; }
.tbtn:hover { background:var(--hover-bg); border-color:var(--accent); }
.ctl { display:flex; align-items:center; gap:7px; color:var(--dim); font-size:12px; white-space:nowrap; }
.ctl select { appearance:none; -webkit-appearance:none; background:var(--input-bg); color:var(--ink); border:1px solid var(--chrome-border); border-radius:8px; padding:6px 12px; font:inherit; font-size:12px; color-scheme:dark; max-width:220px; }
/* Theme the native dropdown popup so option items are never white-on-white. */
select { color-scheme:dark; }
select option, select optgroup { background:var(--chrome); color:var(--ink); }
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

/* ---- primary nav (Canvas / Specs / Admin) ---- */
nav.tabs { display:flex; gap:2px; }
nav.tabs button { border:none; background:transparent; color:var(--dim); padding:7px 13px; border-radius:8px; cursor:pointer; font-size:12.5px; font-weight:600; }
nav.tabs button:hover { background:var(--hover-bg); color:var(--ink); }
nav.tabs button.active { background:var(--hover-bg); color:var(--accent); }
.view { position:absolute; inset:0; display:none; }
.view.active { display:block; }

/* ---- specs (authoring) view: list | inspector split ---- */
.split { display:flex; height:100%; }
.pane-l { width:300px; flex:0 0 auto; border-right:1px solid var(--chrome-border); overflow:auto; background:rgba(0,0,0,.15); }
.pane-r { flex:1; min-width:0; overflow:auto; padding:16px 20px; }
.pane-hd { padding:10px 14px; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); position:sticky; top:0; background:var(--chrome); border-bottom:1px solid var(--line); display:flex; align-items:center; gap:8px; }
.speclist { list-style:none; margin:0; padding:6px; }
.speclist li { padding:7px 10px; border-radius:7px; cursor:pointer; font-size:12.5px; color:var(--ink); display:flex; align-items:center; gap:8px; }
.speclist li:hover { background:var(--hover-bg); }
.speclist li.sel { background:var(--hover-bg); color:var(--accent); }
.speclist .kind { font-size:10px; color:var(--dim); border:1px solid var(--line); border-radius:12px; padding:0 6px; flex:0 0 auto; }
.insp h2 { margin:0 0 2px; font-size:18px; }
.insp .meta { color:var(--dim); font-size:12px; margin:0 0 16px; }
.insp label { display:block; color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.05em; margin:14px 0 5px; }
.insp textarea, .insp input[type=text] { width:100%; background:var(--input-bg); color:var(--ink); border:1px solid var(--chrome-border); border-radius:9px; padding:9px 11px; font:inherit; }
.insp textarea { min-height:96px; resize:vertical; }
.insp textarea:focus, .insp input:focus { outline:none; border-color:var(--accent); box-shadow:var(--syw-glow); }
.insp textarea:disabled, .insp input:disabled { opacity:.6; cursor:not-allowed; }
.rowbtns { display:flex; gap:8px; margin-top:14px; align-items:center; }
.json { background:rgba(0,0,0,.28); border:1px solid var(--line); border-radius:9px; padding:12px; font:11.5px/1.5 "SFMono-Regular",Consolas,monospace; color:var(--dim); white-space:pre; overflow:auto; max-height:360px; }
.msg { font-size:12px; min-height:16px; }
.msg.ok { color:var(--syw-cyan); } .msg.bad { color:var(--danger); }

/* ---- admin view ---- */
.admin-wrap { height:100%; display:flex; flex-direction:column; }
.subtabs { display:flex; gap:2px; padding:8px 14px; border-bottom:1px solid var(--chrome-border); background:var(--chrome); flex:0 0 auto; }
.subtabs button { border:1px solid transparent; background:transparent; color:var(--dim); padding:6px 12px; border-radius:8px; cursor:pointer; font-size:12px; font-weight:600; }
.subtabs button.active { background:var(--hover-bg); color:var(--accent); border-color:var(--chrome-border); }
.admin-body { flex:1; min-height:0; overflow:auto; padding:16px 20px; }
.apanel { display:none; } .apanel.active { display:block; }
table.grid { width:100%; border-collapse:collapse; font-size:12.5px; }
table.grid th { text-align:left; color:var(--dim); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.05em; padding:8px 10px; border-bottom:1px solid var(--chrome-border); position:sticky; top:0; background:var(--chrome); }
table.grid td { padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
table.grid tr:hover td { background:rgba(255,255,255,.03); }
.pill { display:inline-block; font-size:10.5px; padding:1px 8px; border-radius:12px; border:1px solid var(--line); }
.pill.ok { color:#7ee787; border-color:rgba(126,231,135,.4); } .pill.warn { color:var(--warn); border-color:rgba(245,158,11,.4); } .pill.bad { color:var(--danger); border-color:rgba(255,107,129,.4); }
.mini { border:1px solid var(--chrome-border); background:var(--input-bg); color:var(--ink); padding:4px 9px; border-radius:7px; cursor:pointer; font-size:11.5px; }
.mini:hover { background:var(--hover-bg); border-color:var(--accent); }
.mini.danger:hover { border-color:var(--danger); color:var(--danger); }
.hint { color:var(--dim); font-size:12px; padding:14px 4px; }
.cards { display:flex; gap:14px; flex-wrap:wrap; margin-bottom:16px; }
.stat { background:var(--syw-surface-gradient); border:1px solid var(--chrome-border); border-radius:12px; padding:14px 18px; min-width:150px; }
.stat .k { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
.stat .v { font-size:22px; font-weight:800; margin-top:3px; }

/* ---- admin & self-service forms ---- */
.toolbar { display:flex; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap; }
.formcard { background:var(--card); border:1px solid var(--chrome-border); border-radius:12px; padding:16px 18px; margin:0 0 18px; max-width:780px; }
.formcard h3 { margin:0 0 12px; font-size:14px; color:var(--ink); }
.frow { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:10px; }
.fcol { display:flex; flex-direction:column; gap:5px; flex:1 1 210px; min-width:160px; }
.fcol.wide { flex-basis:100%; }
.fcol label { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
.fcol input, .fcol select, .fcol textarea { background:var(--input-bg); color:var(--ink); border:1px solid var(--chrome-border); border-radius:8px; padding:8px 10px; font:inherit; width:100%; }
.fcol input:focus, .fcol select:focus, .fcol textarea:focus { outline:none; border-color:var(--accent); box-shadow:var(--syw-glow); }
.fcol input[readonly] { opacity:.7; }
.fcol select { color-scheme:dark; appearance:none; -webkit-appearance:none; }
.fcol .cbrow { display:flex; align-items:center; gap:8px; color:var(--ink); font-size:12.5px; padding:8px 0; }
.fcol .cbrow input { width:auto; }
details.adv { margin:6px 0 12px; }
details.adv summary { cursor:pointer; color:var(--dim); font-size:12px; margin-bottom:8px; }
.note { border:1px solid rgba(34,221,255,.35); background:rgba(34,221,255,.07); border-radius:10px; padding:10px 12px; font-size:12px; color:var(--ink); margin:10px 0; line-height:1.5; }
.tokenout { display:flex; gap:8px; align-items:center; margin-top:8px; }
.tokenout input { flex:1; background:rgba(0,0,0,.32); border:1px solid var(--chrome-border); color:var(--syw-cyan); border-radius:8px; padding:9px 10px; font:12px/1.4 "SFMono-Regular",Consolas,monospace; }
.grant-row { display:flex; gap:8px; margin-bottom:8px; align-items:center; }
.grant-row input { flex:1; background:var(--input-bg); color:var(--ink); border:1px solid var(--chrome-border); border-radius:8px; padding:7px 9px; font:inherit; }
.grant-row input:focus { outline:none; border-color:var(--accent); box-shadow:var(--syw-glow); }
</style>
</head>
<body data-theme="syw">
<div id="boot">Loading…</div>

<!-- ============================ LOGIN SCREEN ============================ -->
<!-- Dynamic: renders exactly the sign-in methods GET /web/login-options reports
     — the password form only when the built-in admin login is configured, one
     SSO button per ENABLED identity provider, and a clear message when neither
     method exists. No free-text provider input. -->
<div id="login" hidden>
  <div class="card">
    <h1 class="syw-gradient-text">wairon</h1>
    <p class="sub">Spec-driven architecture canvas</p>
    <div id="pwForm" hidden>
      <label for="lu">Username</label>
      <input id="lu" spellcheck="false" autocomplete="username" />
      <label for="lp">Password</label>
      <input id="lp" type="password" autocomplete="current-password" />
      <button class="btn-primary" id="pwBtn">Sign in with password</button>
    </div>
    <div class="login-sep" id="ssoSep" hidden><span>or</span></div>
    <div id="ssoList" hidden></div>
    <div class="none" id="noMethod" hidden>No sign-in method is configured. Ask an administrator to set the built-in admin credentials or enable an identity provider.</div>
    <div class="err" id="loginErr"></div>
  </div>
</div>

<!-- ============================ APPLICATION ============================ -->
<div id="app" hidden>
  <header id="topbar">
    <span class="brand syw-gradient-text">wairon</span>
    <nav class="tabs" id="navTabs">
      <button data-view="canvas" class="active">Canvas</button>
      <button data-view="specs">Specs</button>
      <button data-view="projects">Projects</button>
      <button data-view="admin" id="navAdmin" hidden>Admin</button>
    </nav>
    <div class="ctl" id="projCtl"><span>Project</span><select id="projSel"></select></div>
    <span class="spacer"></span>
    <span class="ro" id="roBadge" hidden title="Your grants are read-only">read-only</span>
    <div class="dropdown acct" id="acctDd">
      <span class="badge-admin" id="adminBadge" hidden>admin</span>
      <button class="tbtn" id="acctBtn"><span class="who" id="whoLbl">&hellip;</span> &#9662;</button>
      <div class="menu">
        <button id="connectAgent">Connect an agent</button>
        <button id="signout">Sign out</button>
        <button id="signoutAll">Sign out everywhere</button>
      </div>
    </div>
  </header>
  <div id="wrap">
    <!-- Canvas view (existing embedded architecture canvas) -->
    <div class="view active" id="view-canvas">
      <iframe id="cv" title="Architecture canvas" referrerpolicy="same-origin"></iframe>
      <div class="empty" id="empty" hidden><div class="box"><h3>No project in scope</h3><p>There are no projects you can view yet.</p></div></div>
    </div>

    <!-- Specs view (authoring over /mcp) -->
    <div class="view" id="view-specs">
      <div class="split">
        <div class="pane-l">
          <div class="pane-hd"><span id="specsProj">specs</span><span class="spacer" style="flex:1"></span><button class="mini" id="btnValidate">Validate</button></div>
          <ul class="speclist" id="specList"></ul>
        </div>
        <div class="pane-r">
          <div class="insp" id="insp"><div class="hint">Select a component on the left to inspect and edit its specification.</div></div>
        </div>
      </div>
    </div>

    <!-- Admin view (control-plane pages) -->
    <div class="view" id="view-admin">
      <div class="admin-wrap">
        <div class="subtabs" id="adminSubtabs">
          <button data-panel="approvals" class="active">Approvals</button>
          <button data-panel="users">Users</button>
          <button data-panel="providers">Identity Providers</button>
          <button data-panel="org">Organization</button>
          <button data-panel="landscape">Landscape</button>
          <button data-panel="health">Health</button>
        </div>
        <div class="admin-body">
          <div class="apanel active" id="ap-approvals"><div class="hint">Loading…</div></div>
          <div class="apanel" id="ap-users"><div class="hint">Loading…</div></div>
          <div class="apanel" id="ap-providers"><div class="hint">Loading…</div></div>
          <div class="apanel" id="ap-org"><div class="hint">Loading…</div></div>
          <div class="apanel" id="ap-landscape"><div class="hint">Loading…</div></div>
          <div class="apanel" id="ap-health"><div class="hint">Loading…</div></div>
        </div>
      </div>
    </div>

    <!-- Projects view (project lifecycle: list / create / lock / promote / destroy) -->
    <div class="view" id="view-projects">
      <div class="pane-r"><div id="projectsBody" style="max-width:900px;margin:0 auto;"><div class="hint">Loading…</div></div></div>
    </div>

    <!-- Connect an agent view (self-service; any signed-in user) -->
    <div class="view" id="view-connect">
      <div class="pane-r"><div id="connectBody" style="max-width:780px;margin:0 auto;"><div class="hint">Loading…</div></div></div>
    </div>
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
  function showLogin(msg) { $('boot').hidden = true; $('app').hidden = true; $('login').hidden = false; $('loginErr').textContent = msg || ''; loadLoginOptions(); }
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
  // The login screen is DYNAMIC: it renders exactly the sign-in methods the
  // server reports on the public pre-auth GET /web/login-options read — the
  // username/password form only when the built-in admin login is configured,
  // and one "Sign in with <name>" button per ENABLED identity provider (label =
  // the admin-set displayName, defaulting to the provider id). No free-text
  // provider input; when neither method exists a clear "No sign-in method is
  // configured" message shows instead.
  var loginOptionsLoaded = false;
  function loadLoginOptions() {
    if (loginOptionsLoaded) return;
    loginOptionsLoaded = true;
    api('/web/login-options').then(function (r) {
      if (!r.ok) throw new Error('login-options ' + r.status);
      return r.json();
    }).then(function (o) {
      var pw = !!(o && o.passwordLogin);
      var provs = (o && o.providers) || [];
      $('pwForm').hidden = !pw;
      $('ssoSep').hidden = !(pw && provs.length > 0);
      $('ssoList').hidden = provs.length === 0;
      $('noMethod').hidden = pw || provs.length > 0;
      var list = $('ssoList'); list.innerHTML = '';
      provs.forEach(function (p) {
        var b = document.createElement('button');
        b.className = 'btn-sso';
        b.textContent = 'Sign in with ' + (p.displayName || p.id);
        b.addEventListener('click', function () { startSso(p.id); });
        list.appendChild(b);
      });
    }).catch(function () {
      loginOptionsLoaded = false; // allow a retry the next time the screen shows
      $('loginErr').textContent = 'Could not load the sign-in options.';
    });
  }
  // Begin the EXISTING SSO start flow for one provider button, then follow the
  // provider authorization URL.
  function startSso(pid) {
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
  }

  // Built-in admin password login. Establishes the session cookie server-side
  // (POST /web/login is not CSRF-gated: it creates a session, it rides none), so
  // a plain reload afterwards boots straight into the app.
  $('pwBtn').addEventListener('click', function () {
    $('loginErr').textContent = '';
    api('/web/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: $('lu').value, password: $('lp').value }),
    }).then(function (r) {
      if (r.status === 401) throw new Error('Invalid credentials.');
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || ('sign-in failed (' + r.status + ')')); });
      location.reload();
    }).catch(function (e) { $('loginErr').textContent = (e && e.message) || 'Sign-in failed.'; });
  });
  $('lp').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('pwBtn').click(); });

  // ---- app start ----------------------------------------------------------
  function startApp() {
    showApp();
    // LOCAL DEV MODE (ctx.local, from wairon dev): hide the ENTIRE top bar — no
    // project picker, no account menu — and let the single local project's canvas
    // fill the viewport with no chrome.
    var isLocal = !!(ctx && ctx.local);
    $('topbar').hidden = isLocal;
    $('whoLbl').textContent = (ctx.subject && (ctx.subject.displayName || ctx.subject.email || ctx.subject.userId)) || 'signed in';
    $('adminBadge').hidden = !ctx.isAdmin;
    $('navAdmin').hidden = !ctx.isAdmin;      // the Admin tab appears only for admins
    // The context carries no permission projections anymore: write authority is
    // enforced per request server-side (the resolver). Scope-aware read-only
    // chrome returns with the roles/assignments UI.
    $('roBadge').hidden = true;

    // The project selector comes from /web/projects — the resolver-filtered
    // listing of projects this principal can act on (dev mode lists the single
    // registered "local" project the same way).
    api('/web/projects').then(function (r) { return r.ok ? r.json() : []; }).then(function (list) {
      var pids = (list || []).map(function (rec) { return rec.id; });
      var sel = $('projSel'); sel.innerHTML = '';
      pids.forEach(function (pid) {
        var o = document.createElement('option'); o.value = pid; o.textContent = pid; sel.appendChild(o);
      });
      // Default the selection to the first visible project.
      selectedProjectId = pids.length ? pids[0] : '';
      sel.value = selectedProjectId;
      // Hide the picker when there is nothing to choose (or in local single-project mode).
      $('projCtl').style.display = (!isLocal && pids.length > 0) ? 'flex' : 'none';
      setView('canvas');
      loadCanvas();
    });
  }

  // ---- small helpers ------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // One JSON-RPC tool call over the existing /mcp data plane, bound to the selected
  // project. The session cookie authenticates; Phase-6b grants authorize (a
  // read-only session is refused write tools server-side). Returns the tool's parsed
  // JSON result, or throws with the tool's error text.
  function mcp(name, args) {
    return api('/mcp?project=' + encodeURIComponent(selectedProjectId), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: name, arguments: args || {} } }),
    }).then(function (r) {
      if (r.status === 401) throw new Error('Session expired — sign in again.');
      if (r.status === 403) throw new Error('Not permitted for this project.');
      return r.json();
    }).then(function (env) {
      var result = env && env.result;
      var text = result && result.content && result.content[0] && result.content[0].text;
      if (result && result.isError) throw new Error(text || 'tool error');
      if (env && env.error) throw new Error(env.error.message || 'rpc error');
      try { return text ? JSON.parse(text) : null; } catch (e) { return text; }
    });
  }

  // ---- primary tabs -------------------------------------------------------
  var currentView = 'canvas';
  function setView(name) {
    currentView = name;
    ['canvas', 'specs', 'projects', 'admin', 'connect'].forEach(function (v) {
      var el = $('view-' + v); if (el) el.classList.toggle('active', v === name);
    });
    Array.prototype.forEach.call($('navTabs').children, function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === name);
    });
    if (name === 'specs') loadSpecList();
    if (name === 'projects') renderProjects();
    if (name === 'admin') loadAdminPanel(currentPanel);
    if (name === 'connect') renderConnect();
  }
  Array.prototype.forEach.call($('navTabs').children, function (b) {
    b.addEventListener('click', function () {
      var v = b.getAttribute('data-view');
      if (v === 'admin' && !(ctx && ctx.isAdmin)) return;
      setView(v);
    });
  });

  // ---- embedded canvas ----------------------------------------------------
  function loadCanvas() {
    if (!selectedProjectId) { $('cv').hidden = true; $('empty').hidden = false; return; }
    $('empty').hidden = true; $('cv').hidden = false;
    $('cv').src = '/web/canvas?projectId=' + encodeURIComponent(selectedProjectId);
  }

  // ---- specs view (authoring over /mcp) -----------------------------------
  var selectedSpec = null; // { kind, id }
  function loadSpecList() {
    $('specsProj').textContent = selectedProjectId || 'no project';
    var list = $('specList'); list.innerHTML = '<li class="hint">Loading…</li>';
    if (!selectedProjectId) { list.innerHTML = '<li class="hint">No project selected.</li>'; return; }
    // The live project graph is the component index — list subsystems + components.
    api('/web/graph?tier=project&projectId=' + encodeURIComponent(selectedProjectId) + '&level=3')
      .then(function (r) { if (!r.ok) throw new Error('graph ' + r.status); return r.json(); })
      .then(function (g) {
        var nodes = (g.nodes || []).filter(function (n) { return n.kind === 'component' || n.kind === 'subsystem'; });
        nodes.sort(function (a, b) { return (a.kind + a.label).localeCompare(b.kind + b.label); });
        if (!nodes.length) { list.innerHTML = '<li class="hint">No components yet.</li>'; return; }
        list.innerHTML = '';
        nodes.forEach(function (n) {
          var li = document.createElement('li');
          li.innerHTML = '<span class="kind">' + esc(n.kind) + '</span><span>' + esc(n.label || n.id) + '</span>'
            + (n.issueCount ? ' <span class="pill bad" title="validation issues">' + n.issueCount + '</span>' : '');
          li.addEventListener('click', function () {
            Array.prototype.forEach.call(list.children, function (x) { x.classList.remove('sel'); });
            li.classList.add('sel');
            selectSpec(n.kind === 'subsystem' ? 'subsystem' : 'component', n.id);
          });
          list.appendChild(li);
        });
      })
      .catch(function (e) { list.innerHTML = '<li class="hint bad">' + esc(e.message) + '</li>'; });
  }
  function selectSpec(kind, id) {
    selectedSpec = { kind: kind, id: id };
    var insp = $('insp'); insp.innerHTML = '<div class="hint">Loading ' + esc(id) + '…</div>';
    mcp('sdd_get_spec', { kind: kind, id: id }).then(function (spec) {
      // Write authority is enforced per request by the resolver server-side; a
      // save from a read-only principal is refused with a clear error. Scope-
      // aware read-only chrome returns with the roles/assignments UI.
      var canWrite = true;
      var desc = (spec && spec.description) || '';
      insp.innerHTML =
        '<h2>' + esc((spec && spec.name) || id) + '</h2>'
        + '<p class="meta">' + esc(kind) + ' · ' + esc(id) + (spec && spec.componentType ? ' · ' + esc(spec.componentType) : '') + '</p>'
        + '<label>Description</label>'
        + '<textarea id="fDesc"' + (canWrite ? '' : ' disabled') + '>' + esc(desc) + '</textarea>'
        + '<div class="rowbtns">'
        + (canWrite ? '<button class="btn-primary" style="width:auto" id="fSave">Save</button>' : '<span class="ro">read-only — your grants cannot author</span>')
        + '<span class="msg" id="fMsg"></span></div>'
        + '<label>Full specification</label>'
        + '<div class="json">' + esc(JSON.stringify(spec, null, 2)) + '</div>';
      if (canWrite) $('fSave').addEventListener('click', saveSpec);
    }).catch(function (e) { insp.innerHTML = '<div class="hint bad">' + esc(e.message) + '</div>'; });
  }
  function saveSpec() {
    if (!selectedSpec) return;
    var msg = $('fMsg'); msg.className = 'msg'; msg.textContent = 'Saving…';
    mcp('sdd_update_spec', { kind: selectedSpec.kind, id: selectedSpec.id, delta: { description: $('fDesc').value } })
      .then(function () { msg.className = 'msg ok'; msg.textContent = 'Saved.'; loadSpecList(); })
      .catch(function (e) { msg.className = 'msg bad'; msg.textContent = e.message; });
  }
  $('btnValidate').addEventListener('click', function () {
    var insp = $('insp'); insp.innerHTML = '<div class="hint">Validating…</div>';
    mcp('sdd_validate_tree', {}).then(function (res) {
      var issues = (res && res.issues) || [];
      var errs = issues.filter(function (i) { return i.severity === 'error'; }).length;
      var warns = issues.length - errs;
      var html = '<h2>Validation</h2><p class="meta">' + (issues.length ? (errs + ' error(s), ' + warns + ' warning(s)') : 'clean — no findings') + '</p>';
      if (issues.length) {
        html += '<table class="grid"><thead><tr><th>Severity</th><th>Code</th><th>Spec</th><th>Message</th></tr></thead><tbody>';
        issues.slice(0, 200).forEach(function (i) {
          var cls = i.severity === 'error' ? 'bad' : 'warn';
          html += '<tr><td><span class="pill ' + cls + '">' + esc(i.severity) + '</span></td><td>' + esc(i.code) + '</td><td>' + esc(i.specId || '') + '</td><td>' + esc(i.message) + '</td></tr>';
        });
        html += '</tbody></table>';
      }
      insp.innerHTML = html;
    }).catch(function (e) { insp.innerHTML = '<div class="hint bad">' + esc(e.message) + '</div>'; });
  });

  // ---- admin view (control-plane pages) -----------------------------------
  var currentPanel = 'approvals';
  Array.prototype.forEach.call($('adminSubtabs').children, function (b) {
    b.addEventListener('click', function () {
      currentPanel = b.getAttribute('data-panel');
      Array.prototype.forEach.call($('adminSubtabs').children, function (x) { x.classList.toggle('active', x === b); });
      ['approvals', 'users', 'providers', 'org', 'landscape', 'health'].forEach(function (p) { $('ap-' + p).classList.toggle('active', p === currentPanel); });
      loadAdminPanel(currentPanel);
    });
  });
  function adminGet(path) {
    return api('/web/admin/' + path).then(function (r) {
      if (r.status === 403) throw new Error('Your grants do not cover this control-plane view.');
      if (!r.ok) throw new Error(path + ' ' + r.status);
      return r.json();
    });
  }
  function loadAdminPanel(panel) {
    var el = $('ap-' + panel); if (!el) return;
    el.innerHTML = '<div class="hint">Loading…</div>';
    if (panel === 'approvals') {
      adminGet('approvals').then(function (d) {
        var rows = d.requests || [];
        if (!rows.length) { el.innerHTML = '<div class="hint">No pending approval requests in your scope.</div>'; return; }
        var html = '<table class="grid"><thead><tr><th>Kind</th><th>Project</th><th>Requested by</th><th>Summary</th><th></th></tr></thead><tbody>';
        rows.forEach(function (r) {
          html += '<tr><td>' + esc(r.kind) + '</td><td>' + esc(r.projectId || '—') + '</td><td>' + esc(r.requestedBy && r.requestedBy.userId) + '</td><td>' + esc(r.summary || '') + '</td>'
            + '<td style="white-space:nowrap"><button class="mini" data-approve="' + esc(r.id) + '">Approve</button> <button class="mini danger" data-reject="' + esc(r.id) + '">Reject</button></td></tr>';
        });
        html += '</tbody></table>';
        el.innerHTML = html;
        Array.prototype.forEach.call(el.querySelectorAll('[data-approve]'), function (b) { b.addEventListener('click', function () { decide(b.getAttribute('data-approve'), true); }); });
        Array.prototype.forEach.call(el.querySelectorAll('[data-reject]'), function (b) { b.addEventListener('click', function () { decide(b.getAttribute('data-reject'), false); }); });
      }).catch(function (e) { el.innerHTML = '<div class="hint bad">' + esc(e.message) + '</div>'; });
    } else if (panel === 'users') {
      renderUsersPanel(el);
    } else if (panel === 'providers') {
      renderProvidersPanel(el);
    } else if (panel === 'org') {
      renderOrgPanel(el);
    } else if (panel === 'landscape') {
      adminGet('landscape').then(function (g) {
        var units = (g.nodes || []).filter(function (n) { return n.nodeKind === 'unit'; });
        var projs = (g.nodes || []).filter(function (n) { return n.nodeKind === 'project'; });
        var html = '<div class="cards"><div class="stat"><div class="k">Org units</div><div class="v">' + units.length + '</div></div>'
          + '<div class="stat"><div class="k">Projects</div><div class="v">' + projs.length + '</div></div>'
          + '<div class="stat"><div class="k">Relations</div><div class="v">' + ((g.edges || []).length) + '</div></div></div>';
        html += '<table class="grid"><thead><tr><th>Node</th><th>Kind</th><th>Status</th></tr></thead><tbody>';
        (g.nodes || []).forEach(function (n) { html += '<tr><td>' + esc(n.label || n.id) + '</td><td>' + esc(n.nodeKind) + '</td><td>' + esc(n.status || '—') + '</td></tr>'; });
        el.innerHTML = html + '</tbody></table>';
      }).catch(function (e) { el.innerHTML = '<div class="hint bad">' + esc(e.message) + '</div>'; });
    } else if (panel === 'health') {
      adminGet('health').then(function (h) {
        var st = h.status === 'ok' ? 'ok' : (h.status === 'degraded' ? 'warn' : 'bad');
        var html = '<div class="cards"><div class="stat"><div class="k">Instance status</div><div class="v"><span class="pill ' + st + '">' + esc(h.status) + '</span></div></div></div>';
        html += '<table class="grid"><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody>';
        (h.checks || []).forEach(function (c) {
          var cs = c.status === 'pass' ? 'ok' : (c.status === 'warn' ? 'warn' : 'bad');
          html += '<tr><td>' + esc(c.id) + '</td><td><span class="pill ' + cs + '">' + esc(c.status) + '</span></td><td>' + esc(c.message) + '</td></tr>';
        });
        el.innerHTML = html + '</tbody></table>';
      }).catch(function (e) { el.innerHTML = '<div class="hint bad">' + esc(e.message) + '</div>'; });
    }
  }
  function decide(requestId, approved) {
    api('/web/admin/approvals/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: requestId, approved: approved }),
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error((j && j.error) || ('decide ' + r.status)); });
      loadAdminPanel('approvals');
    }).catch(function (e) { alert(e.message); });
  }

  // ---- controls -----------------------------------------------------------
  $('projSel').addEventListener('change', function () {
    selectedProjectId = $('projSel').value;
    loadCanvas();
    if (currentView === 'specs') loadSpecList();
  });

  // account menu (sign out this device / everywhere)
  $('acctBtn').addEventListener('click', function (e) { e.stopPropagation(); $('acctDd').classList.toggle('open'); });
  document.addEventListener('click', function () { $('acctDd').classList.remove('open'); });
  $('signout').addEventListener('click', function () { doLogout('/web/logout'); });
  $('signoutAll').addEventListener('click', function () { doLogout('/web/logout-all'); });
  // "Connect an agent" is self-service for ANY signed-in user (not gated on admin).
  $('connectAgent').addEventListener('click', function () { $('acctDd').classList.remove('open'); setView('connect'); });
  function doLogout(path) { api(path, { method: 'POST' }).then(function () { location.reload(); }).catch(function () { location.reload(); }); }

  // ========================================================================
  // Admin management panels (Users / Identity Providers / Organization) and the
  // agent-token self-service page. Everything renders with string concatenation
  // (this script is embedded in an outer template literal — no backticks / no
  // dollar-brace / no backslash escapes) and POSTs through postJson so the
  // X-Wairon-Web CSRF header rides every mutation. Admin panels render only for
  // ctx.isAdmin; "Connect an agent" renders for any signed-in user.
  // ========================================================================

  function postJson(path, obj) {
    return api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj || {}) });
  }
  // POST + resolve to parsed JSON, throwing the server's error text on a non-2xx.
  function postAndParse(path, obj) {
    return postJson(path, obj).then(function (r) {
      if (r.ok) return r.json().catch(function () { return {}; });
      return r.text().then(function (t) {
        var m = t;
        try { var j = JSON.parse(t); if (j && j.error) m = j.error; } catch (e) {}
        throw new Error(m || (path + ' ' + r.status));
      });
    });
  }
  function commaList(s) {
    return String(s == null ? '' : s).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function opt(value, label, selected) {
    return '<option value="' + esc(value) + '"' + (selected ? ' selected' : '') + '>' + esc(label) + '</option>';
  }
  function fcol(label, control, wide) {
    return '<div class="fcol' + (wide ? ' wide' : '') + '"><label>' + esc(label) + '</label>' + control + '</div>';
  }

  // ---- Users (admin) ------------------------------------------------------
  function renderUsersPanel(el) {
    el.innerHTML = '<div class="hint">Loading…</div>';
    adminGet('users').then(function (d) {
      var users = d.users || [];
      var html = '<div class="toolbar"><button class="mini" id="uNew">New user</button></div><div id="uForm"></div>';
      if (!users.length) html += '<div class="hint">No users in your scope yet.</div>';
      else {
        html += '<table class="grid"><thead><tr><th>User</th><th>Status</th><th>Unit</th><th>Roles</th><th></th></tr></thead><tbody>';
        users.forEach(function (u, i) {
          var st = u.status === 'active' ? 'ok' : 'warn';
          // Permissions live in role bindings + the assignment grid — the record
          // carries no grants. (A dedicated roles/assignments editor is the next
          // UI phase; bindings are shown read-only here.)
          var roles = (u.roleBindings || []).map(function (b) {
            return esc(b.roleId) + (b.scopeId ? '@' + esc(b.scopeId) : '');
          }).join(', ');
          var who = esc((u.displayName || (u.subject && u.subject.userId)) || '')
            + (u.email ? ' <span class="hint">' + esc(u.email) + '</span>' : '');
          html += '<tr><td>' + who + '</td>'
            + '<td><span class="pill ' + st + '">' + esc(u.status) + '</span></td>'
            + '<td>' + esc(u.unitId || '—') + '</td>'
            + '<td>' + (roles || '<span class="hint">none</span>') + '</td>'
            + '<td style="white-space:nowrap"><button class="mini" data-edit="' + i + '">Edit</button> '
            + '<button class="mini" data-setstatus="' + i + '">Status</button></td></tr>';
        });
        html += '</tbody></table>';
      }
      el.innerHTML = html;
      $('uNew').addEventListener('click', function () { userForm(el, null); });
      Array.prototype.forEach.call(el.querySelectorAll('[data-edit]'), function (b) {
        b.addEventListener('click', function () { userForm(el, users[+b.getAttribute('data-edit')]); });
      });
      Array.prototype.forEach.call(el.querySelectorAll('[data-setstatus]'), function (b) {
        b.addEventListener('click', function () { statusForm(el, users[+b.getAttribute('data-setstatus')]); });
      });
    }).catch(function (e) { el.innerHTML = '<div class="hint bad">' + esc(e.message) + '</div>'; });
  }
  function userForm(el, user) {
    var box = $('uForm'); var creating = !user; var subj = (user && user.subject) || {};
    var statusSel = opt('active', 'active', (user ? user.status : 'active') === 'active')
      + opt('suspended', 'suspended', !!user && user.status === 'suspended')
      + opt('deactivated', 'deactivated', !!user && user.status === 'deactivated');
    var kindSel = opt('human', 'human', (subj.kind || 'human') === 'human') + opt('service', 'service', subj.kind === 'service');
    var html = '<div class="formcard"><h3>' + (creating ? 'New user' : 'Edit user') + '</h3>';
    html += '<div class="frow">'
      + fcol('User record ID', '<input id="uId" value="' + esc(user ? user.id : '') + '"' + (creating ? '' : ' readonly') + ' placeholder="e.g. sso:provider:subject" />')
      + fcol('Status', '<select id="uStatus">' + statusSel + '</select>')
      + '</div>';
    html += '<div class="frow">'
      + fcol('Subject user id', '<input id="uSubId" value="' + esc(subj.userId || (user ? user.id : '')) + '" placeholder="identity subject id" />')
      + fcol('Issuer', '<input id="uSubIss" value="' + esc(subj.issuer || 'local') + '" />')
      + '</div>';
    html += '<div class="frow">'
      + fcol('Kind', '<select id="uSubKind">' + kindSel + '</select>')
      + fcol('External subject', '<input id="uSubExt" value="' + esc(subj.externalSubject || '') + '" placeholder="optional" />')
      + fcol('Home unit id', '<input id="uUnit" value="' + esc(user && user.unitId ? user.unitId : '') + '" placeholder="optional org unit id" />')
      + '</div>';
    html += '<div class="rowbtns"><button class="btn-primary" style="width:auto" id="uSave">' + (creating ? 'Create user' : 'Save') + '</button> <button class="mini" id="uCancel">Cancel</button> <span class="msg" id="uMsg"></span></div></div>';
    box.innerHTML = html;
    $('uCancel').addEventListener('click', function () { box.innerHTML = ''; });
    $('uSave').addEventListener('click', function () {
      var msg = $('uMsg'); msg.className = 'msg'; msg.textContent = 'Saving…';
      var subject = { userId: $('uSubId').value.trim(), kind: $('uSubKind').value, issuer: $('uSubIss').value.trim() || 'local' };
      var ext = $('uSubExt').value.trim(); if (ext) subject.externalSubject = ext;
      var rec = {
        id: $('uId').value.trim() || subject.userId,
        subject: subject,
        status: $('uStatus').value,
        roleBindings: (user && user.roleBindings) || [],
        createdAt: (user && user.createdAt) || new Date().toISOString(),
      };
      var unit = $('uUnit').value.trim(); if (unit) rec.unitId = unit;
      postAndParse('/web/admin/users', rec).then(function () { renderUsersPanel(el); })
        .catch(function (e) { msg.className = 'msg bad'; msg.textContent = e.message; });
    });
  }
  function statusForm(el, user) {
    var box = $('uForm');
    var sel = opt('active', 'active', user.status === 'active') + opt('suspended', 'suspended', user.status === 'suspended') + opt('deactivated', 'deactivated', user.status === 'deactivated');
    var html = '<div class="formcard"><h3>Set status — ' + esc(user.subject && user.subject.userId) + '</h3>';
    html += '<div class="frow">' + fcol('Status', '<select id="sStatus">' + sel + '</select>') + '</div>';
    html += '<div class="note">Suspending or deactivating a user revokes all of their MCP tokens and web sessions.</div>';
    html += '<div class="rowbtns"><button class="btn-primary" style="width:auto" id="sSave">Apply</button> <button class="mini" id="sCancel">Cancel</button> <span class="msg" id="sMsg"></span></div></div>';
    box.innerHTML = html;
    $('sCancel').addEventListener('click', function () { box.innerHTML = ''; });
    $('sSave').addEventListener('click', function () {
      var msg = $('sMsg'); msg.className = 'msg'; msg.textContent = 'Saving…';
      postAndParse('/web/admin/users/status', { userId: user.id, status: $('sStatus').value })
        .then(function () { renderUsersPanel(el); })
        .catch(function (e) { msg.className = 'msg bad'; msg.textContent = e.message; });
    });
  }
  // ---- Identity Providers / SSO (admin) -----------------------------------
  function renderProvidersPanel(el) {
    el.innerHTML = '<div class="hint">Loading…</div>';
    adminGet('providers').then(function (d) {
      var provs = d.providers || [];
      var html = '<div class="toolbar"><button class="mini" id="pNew">Add identity provider</button></div><div id="pForm"></div>';
      if (!provs.length) html += '<div class="hint">No identity providers configured.</div>';
      else {
        html += '<table class="grid"><thead><tr><th>ID</th><th>Type</th><th>Issuer</th><th>Enabled</th><th></th></tr></thead><tbody>';
        provs.forEach(function (p, i) {
          html += '<tr><td>' + esc(p.id) + '</td><td>' + esc(p.providerType) + '</td><td>' + esc(p.issuerUrl || '—') + '</td>'
            + '<td><span class="pill ' + (p.enabled ? 'ok' : 'warn') + '">' + (p.enabled ? 'enabled' : 'disabled') + '</span></td>'
            + '<td style="white-space:nowrap"><button class="mini" data-edit="' + i + '">Edit</button> <button class="mini danger" data-del="' + esc(p.id) + '">Remove</button></td></tr>';
        });
        html += '</tbody></table>';
      }
      el.innerHTML = html;
      $('pNew').addEventListener('click', function () { providerForm(el, null); });
      Array.prototype.forEach.call(el.querySelectorAll('[data-edit]'), function (b) {
        b.addEventListener('click', function () { providerForm(el, provs[+b.getAttribute('data-edit')]); });
      });
      Array.prototype.forEach.call(el.querySelectorAll('[data-del]'), function (b) {
        b.addEventListener('click', function () {
          if (!confirm('Remove identity provider "' + b.getAttribute('data-del') + '"?')) return;
          postAndParse('/web/admin/providers/remove', { id: b.getAttribute('data-del') })
            .then(function () { renderProvidersPanel(el); }).catch(function (e) { alert(e.message); });
        });
      });
    }).catch(function (e) { el.innerHTML = '<div class="hint bad">' + esc(e.message) + '</div>'; });
  }
  function providerForm(el, p) {
    var box = $('pForm'); p = p || {}; var creating = !p.id;
    var types = ['oidc', 'keycloak', 'authentik', 'google_workspace', 'entra_id'];
    var typeOpts = types.map(function (t) { return opt(t, t, (p.providerType || 'oidc') === t); }).join('');
    var html = '<div class="formcard"><h3>' + (creating ? 'Add identity provider' : 'Edit ' + esc(p.id)) + '</h3>';
    html += '<div class="frow">'
      + fcol('Provider ID', '<input id="pId" value="' + esc(p.id || '') + '"' + (creating ? '' : ' readonly') + ' placeholder="e.g. corp-keycloak" />')
      + fcol('Display name', '<input id="pDisplay" value="' + esc(p.displayName || '') + '" placeholder="login-button label — defaults to the ID" />')
      + fcol('Type', '<select id="pType">' + typeOpts + '</select>')
      + fcol('Enabled', '<div class="cbrow"><input type="checkbox" id="pEnabled"' + (p.enabled === false ? '' : ' checked') + ' /> <span>sign-in allowed</span></div>')
      + '</div>';
    html += '<div class="frow">' + fcol('Issuer URL', '<input id="pIssuer" value="' + esc(p.issuerUrl || '') + '" placeholder="your provider issuer / realm base URL" />', true) + '</div>';
    html += '<div class="frow">'
      + fcol('Client ID', '<input id="pClient" value="' + esc(p.clientId || '') + '" />')
      + fcol('Client secret ref', '<input id="pSecretRef" list="secretRefsList" value="' + esc(p.clientSecretRef || '') + '" placeholder="pick an existing ref or type a new name" /><datalist id="secretRefsList"></datalist>')
      + '</div>';
    html += '<div class="frow">'
      + fcol('Allowed email domains', '<input id="pDomains" value="' + esc((p.allowedDomains || []).join(', ')) + '" placeholder="comma-separated, e.g. corp.example" />')
      + fcol('Admin group claims', '<input id="pAdminGroups" value="' + esc((p.adminGroupClaims || []).join(', ')) + '" placeholder="comma-separated group claims" />')
      + '</div>';
    html += '<div class="frow">' + fcol('Allowed redirect URIs', '<input id="pRedirects" value="' + esc((p.allowedRedirectUris || []).join(', ')) + '" placeholder="comma-separated exact-match URIs" />', true) + '</div>';
    html += '<details class="adv"><summary>Advanced — split-horizon endpoints (leave blank to auto-discover)</summary>';
    html += '<div class="note">Leave every field blank to resolve endpoints via OIDC discovery from the issuer. Override individually for split-horizon: the token / JWKS / userinfo endpoints may be VPC-internal while the authorize endpoint stays publicly reachable by the browser.</div>';
    html += '<div class="frow">' + fcol('Authorization endpoint (public)', '<input id="pAuthz" value="' + esc(p.authorizationEndpoint || '') + '" placeholder="browser-facing; blank to auto-discover" />', true) + '</div>';
    html += '<div class="frow">'
      + fcol('Token endpoint (may be internal)', '<input id="pToken" value="' + esc(p.tokenEndpoint || '') + '" placeholder="server-facing; blank to auto-discover" />')
      + fcol('JWKS URI (may be internal)', '<input id="pJwks" value="' + esc(p.jwksUri || '') + '" placeholder="server-facing; blank to auto-discover" />')
      + '</div>';
    html += '<div class="frow">' + fcol('Userinfo endpoint (may be internal)', '<input id="pUserinfo" value="' + esc(p.userinfoEndpoint || '') + '" placeholder="server-facing; blank to auto-discover" />', true) + '</div>';
    html += '</details>';
    html += '<div class="rowbtns"><button class="btn-primary" style="width:auto" id="pSave">' + (creating ? 'Add provider' : 'Save') + '</button> <button class="mini" id="pCancel">Cancel</button> <span class="msg" id="pMsg"></span></div></div>';
    box.innerHTML = html;
    // Offer the existing secret ref NAMES (never values) as datalist suggestions.
    api('/web/admin/secrets').then(function (r) { return r.ok ? r.json() : { refs: [] }; }).then(function (d) {
      var dl = $('secretRefsList'); if (!dl) return;
      dl.innerHTML = ((d && d.refs) || []).map(function (k) { return '<option value="' + esc(k) + '">'; }).join('');
    }).catch(function () {});
    $('pCancel').addEventListener('click', function () { box.innerHTML = ''; });
    $('pSave').addEventListener('click', function () {
      var msg = $('pMsg'); msg.className = 'msg'; msg.textContent = 'Saving…';
      var cf = { id: $('pId').value.trim(), providerType: $('pType').value, enabled: $('pEnabled').checked, updatedAt: new Date().toISOString() };
      if (!cf.id) { msg.className = 'msg bad'; msg.textContent = 'Provider ID is required.'; return; }
      var disp = $('pDisplay').value.trim(); if (disp) cf.displayName = disp;
      var issuer = $('pIssuer').value.trim(); if (issuer) cf.issuerUrl = issuer;
      var client = $('pClient').value.trim(); if (client) cf.clientId = client;
      var sref = $('pSecretRef').value.trim(); if (sref) cf.clientSecretRef = sref;
      var doms = commaList($('pDomains').value); if (doms.length) cf.allowedDomains = doms;
      var ag = commaList($('pAdminGroups').value); if (ag.length) cf.adminGroupClaims = ag;
      var red = commaList($('pRedirects').value); if (red.length) cf.allowedRedirectUris = red;
      var az = $('pAuthz').value.trim(); if (az) cf.authorizationEndpoint = az;
      var tok = $('pToken').value.trim(); if (tok) cf.tokenEndpoint = tok;
      var jw = $('pJwks').value.trim(); if (jw) cf.jwksUri = jw;
      var ui = $('pUserinfo').value.trim(); if (ui) cf.userinfoEndpoint = ui;
      postAndParse('/web/admin/providers', cf).then(function () { renderProvidersPanel(el); })
        .catch(function (e) { msg.className = 'msg bad'; msg.textContent = e.message; });
    });
  }

  // ---- Organization units (admin) -----------------------------------------
  function renderOrgPanel(el) {
    el.innerHTML = '<div class="hint">Loading…</div>';
    adminGet('org/units').then(function (d) {
      var units = d.units || [];
      var html = '<div class="toolbar"><button class="mini" id="oNew">New unit</button><button class="mini" id="oPlace">Place a project</button></div><div id="oForm"></div>';
      if (!units.length) html += '<div class="hint">No organization units yet.</div>';
      else {
        html += '<table class="grid"><thead><tr><th>Name</th><th>ID</th><th>Kind</th><th>Parent</th><th>Visibility</th><th></th></tr></thead><tbody>';
        units.forEach(function (u, i) {
          html += '<tr><td>' + esc(u.name) + '</td><td>' + esc(u.id) + '</td><td>' + esc(u.kind) + '</td><td>' + esc(u.parentId || '—') + '</td><td>' + esc(u.visibility || 'inherit') + '</td>'
            + '<td><button class="mini" data-edit="' + i + '">Edit</button></td></tr>';
        });
        html += '</tbody></table>';
      }
      el.innerHTML = html;
      $('oNew').addEventListener('click', function () { orgUnitForm(el, units, null); });
      $('oPlace').addEventListener('click', function () { placementForm(el, units); });
      Array.prototype.forEach.call(el.querySelectorAll('[data-edit]'), function (b) {
        b.addEventListener('click', function () { orgUnitForm(el, units, units[+b.getAttribute('data-edit')]); });
      });
    }).catch(function (e) { el.innerHTML = '<div class="hint bad">' + esc(e.message) + '</div>'; });
  }
  function orgUnitForm(el, units, u) {
    var box = $('oForm'); var creating = !u; u = u || {};
    var parentOpts = opt('', '(none — root unit)', !u.parentId);
    units.forEach(function (x) { if (x.id !== u.id) parentOpts += opt(x.id, x.name + ' (' + x.id + ')', u.parentId === x.id); });
    var vis = u.visibility || 'inherit';
    var visOpts = opt('inherit', 'inherit', vis === 'inherit') + opt('open', 'open', vis === 'open') + opt('closed', 'closed', vis === 'closed');
    var html = '<div class="formcard"><h3>' + (creating ? 'New organization unit' : 'Edit ' + esc(u.name)) + '</h3>';
    html += '<div class="frow">'
      + fcol('Name', '<input id="oName" value="' + esc(u.name || '') + '" />')
      + fcol('Unit ID', '<input id="oId" value="' + esc(u.id || '') + '"' + (creating ? '' : ' readonly') + ' placeholder="optional — auto if blank" />')
      + '</div>';
    html += '<div class="frow">'
      + fcol('Kind', '<select id="oKind">' + ['organization', 'department', 'team', 'domain'].map(function (k) { return opt(k, k, (u.kind || 'team') === k); }).join('') + '</select>')
      + fcol('Parent unit', '<select id="oParent">' + parentOpts + '</select>')
      + fcol('Visibility', '<select id="oVis">' + visOpts + '</select>')
      + '</div>';
    html += '<div class="rowbtns"><button class="btn-primary" style="width:auto" id="oSave">' + (creating ? 'Create unit' : 'Save') + '</button> <button class="mini" id="oCancel">Cancel</button> <span class="msg" id="oMsg"></span></div></div>';
    box.innerHTML = html;
    $('oCancel').addEventListener('click', function () { box.innerHTML = ''; });
    $('oSave').addEventListener('click', function () {
      var msg = $('oMsg'); msg.className = 'msg'; msg.textContent = 'Saving…';
      var rec = {
        id: $('oId').value.trim(),
        name: $('oName').value.trim(),
        kind: $('oKind').value.trim() || 'team',
        status: u.status || 'active',
        createdAt: u.createdAt || '',
        createdBy: u.createdBy || (ctx && ctx.subject) || { userId: '', kind: 'human', issuer: 'local' },
      };
      var par = $('oParent').value; if (par) rec.parentId = par;
      var v = $('oVis').value; if (v) rec.visibility = v;
      postAndParse('/web/admin/org/units', rec).then(function () { renderOrgPanel(el); })
        .catch(function (e) { msg.className = 'msg bad'; msg.textContent = e.message; });
    });
  }
  function placementForm(el, units) {
    var box = $('oForm');
    // The project ids come from the already-populated selector (fed by
    // /web/projects, the resolver-filtered listing).
    var pids = Array.prototype.map.call($('projSel').options, function (o) { return o.value; });
    var projCtl = pids.length ? '<select id="plProj">' + pids.map(function (pid) { return opt(pid, pid, false); }).join('') + '</select>' : '<input id="plProj" placeholder="projectId" />';
    var unitOpts = units.map(function (u) { return opt(u.id, u.name + ' (' + u.id + ')', false); }).join('');
    var html = '<div class="formcard"><h3>Place a project into a unit</h3>';
    html += '<div class="frow">' + fcol('Project', projCtl) + fcol('Unit', '<select id="plUnit">' + unitOpts + '</select>') + '</div>';
    html += '<div class="rowbtns"><button class="btn-primary" style="width:auto" id="plSave">Place</button> <button class="mini" id="plCancel">Cancel</button> <span class="msg" id="plMsg"></span></div></div>';
    box.innerHTML = html;
    $('plCancel').addEventListener('click', function () { box.innerHTML = ''; });
    $('plSave').addEventListener('click', function () {
      var msg = $('plMsg'); msg.className = 'msg'; msg.textContent = 'Placing…';
      postAndParse('/web/admin/org/placements', { projectId: $('plProj').value.trim(), unitId: $('plUnit').value })
        .then(function () { msg.className = 'msg ok'; msg.textContent = 'Placed.'; renderOrgPanel(el); })
        .catch(function (e) { msg.className = 'msg bad'; msg.textContent = e.message; });
    });
  }

  // ---- Connect an agent (self-service; any signed-in user) ----------------
  function renderConnect() {
    var box = $('connectBody');
    // The project ids come from the already-populated selector (fed by
    // /web/projects, the resolver-filtered listing).
    var pids = Array.prototype.map.call($('projSel').options, function (o) { return o.value; });
    var html = '<h2 style="margin:0 0 4px">Connect an agent</h2>';
    html += '<p style="color:var(--dim);margin:0 0 12px;font-size:12.5px">Mint a single-project MCP token to hand to an AI agent.</p>';
    html += '<div class="note">This token is <strong>separate from your login</strong>. It is an agent credential scoped to exactly one project — signing out never affects it, and it can never sign in to this web UI. It is <strong>owned by you</strong>, so deactivating your account revokes it. Copy it now; the full token is shown only once.</div>';
    html += '<div class="formcard"><h3>Generate a token</h3>';
    if (!pids.length) html += '<div class="hint">You have no projects in scope to connect an agent to.</div>';
    else {
      var projOpts = pids.map(function (pid) { return opt(pid, pid, false); }).join('');
      html += '<div class="frow">'
        + fcol('Project', '<select id="tProj">' + projOpts + '</select>')
        + fcol('Access', '<select id="tWrite">' + opt('read', 'read only (mcp:read)', true) + opt('write', 'read + write (mcp:write)', false) + '</select>')
        + '</div>';
      html += '<div class="rowbtns"><button class="btn-primary" style="width:auto" id="tMint">Generate token</button> <span class="msg" id="tMsg"></span></div><div id="tResult"></div>';
    }
    html += '</div>';
    html += '<div class="formcard"><h3>Your agent tokens <span class="msg" id="tokMsg" style="font-weight:400"></span></h3>';
    html += '<div id="tokList"><div class="hint">Loading…</div></div></div>';
    box.innerHTML = html;
    if (pids.length) {
      $('tMint').addEventListener('click', function () {
        var msg = $('tMsg'); msg.className = 'msg'; msg.textContent = 'Generating…';
        postAndParse('/web/tokens', { projectId: $('tProj').value, write: $('tWrite').value === 'write' })
          .then(function (d) {
            msg.textContent = '';
            var tok = (d && d.token) || '';
            $('tResult').innerHTML = '<div class="note">Copy this token now — it will not be shown again.</div>'
              + '<div class="tokenout"><input id="tVal" readonly value="' + esc(tok) + '" /><button class="mini" id="tCopy">Copy</button></div>';
            $('tCopy').addEventListener('click', function () {
              var f = $('tVal'); f.focus(); f.select();
              try { document.execCommand('copy'); $('tCopy').textContent = 'Copied'; } catch (e) {}
            });
            loadTokens();
          })
          .catch(function (e) { msg.className = 'msg bad'; msg.textContent = e.message; });
      });
    }
    loadTokens();
  }

  // List the caller's OWN agent tokens (GET /web/tokens) with a per-row Revoke.
  function loadTokens() {
    var host = $('tokList');
    if (!host) return;
    var note = $('tokMsg'); if (note) { note.className = 'msg'; note.textContent = ''; }
    api('/web/tokens').then(function (r) {
      if (!r.ok) throw new Error('tokens ' + r.status);
      return r.json();
    }).then(function (d) {
      var toks = (d && d.tokens) || [];
      if (!toks.length) { host.innerHTML = '<div class="hint">You have not minted any agent tokens yet.</div>'; return; }
      var rows = toks.map(function (t) {
        var proj = (t.projects || []).join(', ');
        var created = t.createdAt ? String(t.createdAt).slice(0, 10) : '';
        var status = t.revokedAt ? '<span class="pill bad">revoked</span>' : '<span class="pill ok">active</span>';
        var action = t.revokedAt ? '' : '<button class="mini danger" data-tok="' + esc(t.id) + '">Revoke</button>';
        return '<tr><td>' + esc(t.id) + '</td><td>' + esc(proj) + '</td><td>' + esc(created) + '</td><td>' + status + '</td><td>' + action + '</td></tr>';
      }).join('');
      host.innerHTML = '<table class="grid"><thead><tr><th>Token ID</th><th>Project</th><th>Created</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
      Array.prototype.forEach.call(host.querySelectorAll('button[data-tok]'), function (btn) {
        btn.addEventListener('click', function () {
          btn.disabled = true; btn.textContent = 'Revoking…';
          postAndParse('/web/tokens/revoke', { id: btn.getAttribute('data-tok') })
            .then(function () { loadTokens(); })
            .catch(function (e) {
              btn.disabled = false; btn.textContent = 'Revoke';
              if (note) { note.className = 'msg bad'; note.textContent = e.message; }
            });
        });
      });
    }).catch(function (e) { host.innerHTML = '<div class="hint">' + esc(e.message) + '</div>'; });
  }

  // ---- Projects (lifecycle management; any signed-in user) ----------------
  // Lists the caller's in-scope projects (GET /web/projects — resolver-filtered).
  // The management affordances are always offered; the SERVER resolves the real
  // per-action permission, so a 403 is surfaced gracefully rather than trusted
  // to client-side flags. Scope-aware chrome returns with the roles UI.
  function projectsCanManage() { return true; }

  function renderProjects() {
    var box = $('projectsBody');
    var canManage = projectsCanManage();
    var html = '<h2 style="margin:0 0 4px">Projects</h2>';
    html += '<p style="color:var(--dim);margin:0 0 12px;font-size:12.5px">Manage the hosted projects in your scope. Each action is authorized by your grants — you can only act where your grants permit.</p>';
    if (canManage) {
      html += '<div class="formcard"><h3>Create a project</h3>';
      html += '<div class="frow">'
        + fcol('Project ID', '<input id="npId" placeholder="lowercase letters, digits, hyphen" />')
        + fcol('Organization unit', '<input id="npUnit" placeholder="optional — required if you are unit-scoped" />')
        + '</div>';
      html += '<div class="rowbtns"><button class="btn-primary" style="width:auto" id="npCreate">Create project</button> <span class="msg" id="npMsg"></span></div></div>';
    }
    html += '<div class="formcard"><h3>Your projects <span class="msg" id="plNote" style="font-weight:400"></span></h3><div id="plList"><div class="hint">Loading…</div></div></div>';
    box.innerHTML = html;
    if (canManage) {
      $('npCreate').addEventListener('click', function () {
        var msg = $('npMsg'); msg.className = 'msg'; msg.textContent = 'Creating…';
        var id = $('npId').value.trim();
        if (!id) { msg.className = 'msg bad'; msg.textContent = 'Project ID is required.'; return; }
        var payload = { id: id };
        var unit = $('npUnit').value.trim(); if (unit) payload.unitId = unit;
        postAndParse('/web/projects', payload)
          .then(function () { msg.className = 'msg ok'; msg.textContent = 'Created.'; $('npId').value = ''; $('npUnit').value = ''; loadProjects(); })
          .catch(function (e) { msg.className = 'msg bad'; msg.textContent = projectErr(e); });
      });
    }
    loadProjects();
  }

  function loadProjects() {
    var host = $('plList');
    if (!host) return;
    var canManage = projectsCanManage();
    var note = $('plNote'); if (note) { note.className = 'msg'; note.textContent = ''; }
    api('/web/projects').then(function (r) {
      if (r.status === 403) throw new Error('Your grants do not cover project management.');
      if (!r.ok) throw new Error('projects ' + r.status);
      return r.json();
    }).then(function (d) {
      var projs = (d && d.projects) || [];
      if (!projs.length) { host.innerHTML = '<div class="hint">No projects in your scope yet.</div>'; return; }
      var rows = projs.map(function (p) {
        var st = p.status === 'active' ? 'ok' : 'warn';
        var actions = canManage
          ? '<button class="mini" data-lock="' + esc(p.id) + '">Lock</button> '
            + '<button class="mini" data-promote="' + esc(p.id) + '">Promote</button> '
            + '<button class="mini danger" data-destroy="' + esc(p.id) + '">Destroy</button>'
          : '<span class="hint">read-only</span>';
        return '<tr><td>' + esc(p.id) + '</td><td><span class="pill ' + st + '">' + esc(p.status || '—') + '</span></td>'
          + '<td style="white-space:nowrap">' + actions + '</td></tr>';
      }).join('');
      host.innerHTML = '<table class="grid"><thead><tr><th>Project</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
      Array.prototype.forEach.call(host.querySelectorAll('[data-lock]'), function (b) {
        b.addEventListener('click', function () { projectAction('/web/projects/lock', { projectId: b.getAttribute('data-lock') }, b, 'Locking…', 'Lock'); });
      });
      Array.prototype.forEach.call(host.querySelectorAll('[data-promote]'), function (b) {
        b.addEventListener('click', function () { projectAction('/web/projects/promote', { projectId: b.getAttribute('data-promote') }, b, 'Promoting…', 'Promote'); });
      });
      Array.prototype.forEach.call(host.querySelectorAll('[data-destroy]'), function (b) {
        b.addEventListener('click', function () {
          if (!confirm('Destroy project "' + b.getAttribute('data-destroy') + '"? This removes its entire spec tree.')) return;
          projectAction('/web/projects/destroy', { id: b.getAttribute('data-destroy') }, b, 'Destroying…', 'Destroy');
        });
      });
    }).catch(function (e) { host.innerHTML = '<div class="hint bad">' + esc(e.message) + '</div>'; });
  }

  // A friendlier message for the server's grant-scope denial (the client's flags are
  // an affordance hint; the server is the authority, so a 403 is expected and shown).
  function projectErr(e) {
    return /^forbidden$/i.test(e.message) ? 'Not permitted — your grants do not cover this action.' : e.message;
  }
  // POST one lifecycle action and refresh, surfacing a graceful error (e.g. a 403 from
  // the server's per-action grant-scope check) instead of throwing.
  function projectAction(path, payload, btn, busyLabel, label) {
    var note = $('plNote'); if (note) { note.className = 'msg'; note.textContent = ''; }
    btn.disabled = true; btn.textContent = busyLabel;
    postAndParse(path, payload).then(function () {
      loadProjects();
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = label;
      if (note) { note.className = 'msg bad'; note.textContent = projectErr(e); }
    });
  }

  boot();
})();
</script>
</body>
</html>`;
}

// ── Web admin plane (session-scoped /web/admin/*) ────────────────────────────
//
// The unified web UI's admin-settings surface on the PUBLIC data plane. Each of
// these thin portal handlers resolves the browser session id and forwards to the
// web admin orchestrator (webadmin.ts), which re-applies the exact control-plane
// authorization (user/IdP/key methods pass the session as the credential to the
// identity/admin orchestrators; org-unit methods require an instance-wide admin
// grant and mutate through the organization repository). Cookie-authenticated
// POSTs are CSRF-gated in http.ts (routeData) exactly like /web/logout.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

/** Sign the built-in super-admin in with a username + password posted as JSON
 *  ({user, password}); forwards to web_orchestrator.signInWithPassword and sets the
 *  session cookie exactly like the SSO callback (Secure follows requireTls). It
 *  ESTABLISHES a session (no prior cookie exists to ride), so it is intentionally
 *  NOT in the cookie-mutation CSRF set. An invalid credential (or disabled password
 *  login, or an active throttle lockout) maps to 401 with no distinguishing detail. */
function loginWithPassword(cfg: HostConfig, body: Body, res: ServerResponse, secureCookie: boolean): void {
  const sessionId = signInWithPassword(cfg, String(body?.user ?? ''), String(body?.password ?? ''));
  res.writeHead(200, {
    'content-type': 'application/json',
    'set-cookie': setSessionCookie(sessionId, secureCookie),
  });
  res.end(JSON.stringify({ ok: true }));
}

/** List hosted users in the caller's scope; forwards to web_admin_orchestrator.listUsers. */
function adminListUsers(cfg: HostConfig, sessionId: string, url: URL, res: ServerResponse): void {
  const project = url.searchParams.get('project') ?? undefined;
  sendJson(res, 200, { users: webadmin.listUsers(cfg, sessionId, project) });
}

/** Create or update a hosted user; forwards to web_admin_orchestrator.upsertUser. */
function adminUpsertUser(cfg: HostConfig, sessionId: string, body: Body, res: ServerResponse): void {
  sendJson(res, 200, webadmin.upsertUser(cfg, sessionId, body as HostedUserRecord));
}

/** Set a hosted user's lifecycle status; forwards to web_admin_orchestrator.setUserStatus. */
function adminSetUserStatus(cfg: HostConfig, sessionId: string, body: Body, res: ServerResponse): void {
  sendJson(res, 200, webadmin.setUserStatus(cfg, sessionId, String(body?.userId ?? ''), String(body?.status ?? '')));
}

/** List identity-provider (SSO) configurations; forwards to web_admin_orchestrator.listIdentityProviders. */
function adminListProviders(cfg: HostConfig, sessionId: string, res: ServerResponse): void {
  sendJson(res, 200, { providers: webadmin.listIdentityProviders(cfg, sessionId) });
}

/** Create or update an identity-provider configuration; forwards to web_admin_orchestrator.upsertIdentityProvider. */
function adminUpsertProvider(cfg: HostConfig, sessionId: string, body: Body, res: ServerResponse): void {
  sendJson(res, 200, webadmin.upsertIdentityProvider(cfg, sessionId, body as IdentityProviderConfig));
}

/** Remove an identity-provider configuration by id; forwards to web_admin_orchestrator.removeIdentityProvider. */
function adminRemoveProvider(cfg: HostConfig, sessionId: string, body: Body, res: ServerResponse): void {
  webadmin.removeIdentityProvider(cfg, sessionId, String(body?.id ?? ''));
  sendJson(res, 200, { ok: true });
}

/** Mint a single-project MCP token for an AI agent (self-service, session-authorized);
 *  forwards to web_admin_orchestrator.mintProjectToken. The plaintext token is
 *  returned exactly once. */
function mintAgentToken(cfg: HostConfig, sessionId: string, body: Body, res: ServerResponse): void {
  const token = webadmin.mintProjectToken(cfg, sessionId, String(body?.projectId ?? ''), body?.write === true);
  sendJson(res, 201, { token });
}

/** Revoke an MCP token by id; forwards to web_admin_orchestrator.revokeProjectToken. */
function revokeAgentToken(cfg: HostConfig, sessionId: string, body: Body, res: ServerResponse): void {
  webadmin.revokeProjectToken(cfg, sessionId, String(body?.id ?? ''));
  sendJson(res, 200, { ok: true });
}

/** List the caller's own MCP tokens (redacted); forwards to
 *  web_admin_orchestrator.listMyTokens. */
function listAgentTokens(cfg: HostConfig, sessionId: string, res: ServerResponse): void {
  sendJson(res, 200, { tokens: webadmin.listMyTokens(cfg, sessionId) });
}

/** List organization units; forwards to web_admin_orchestrator.listOrganizationUnits. */
function adminListOrgUnits(cfg: HostConfig, sessionId: string, res: ServerResponse): void {
  sendJson(res, 200, { units: webadmin.listOrganizationUnits(cfg, sessionId) });
}

/** List configured secret KEY NAMES (never values); forwards to
 *  web_admin_orchestrator.listSecretRefs — for the IdP form's clientSecretRef picker. */
function adminListSecretRefs(cfg: HostConfig, sessionId: string, res: ServerResponse): void {
  sendJson(res, 200, { refs: webadmin.listSecretRefs(cfg, sessionId) });
}

/** Create or update an organization unit; forwards to web_admin_orchestrator.upsertOrganizationUnit. */
function adminUpsertOrgUnit(cfg: HostConfig, sessionId: string, body: Body, res: ServerResponse): void {
  sendJson(res, 200, webadmin.upsertOrganizationUnit(cfg, sessionId, body as OrganizationUnitRecord));
}

/** Place a project into an organization unit; forwards to web_admin_orchestrator.placeProject. */
function adminPlaceProject(cfg: HostConfig, sessionId: string, body: Body, res: ServerResponse): void {
  webadmin.placeProject(cfg, sessionId, String(body?.projectId ?? ''), String(body?.unitId ?? ''));
  sendJson(res, 200, { ok: true });
}

// ── Web project-lifecycle plane (session-scoped /web/projects*) ──────────────
//
// The human project-lifecycle surface of the unified web UI on the PUBLIC data
// plane. Each thin portal handler resolves the browser session id and forwards to
// the web project orchestrator (webproject.ts): projectList is a scoped read owned
// there; create/lock/promote/destroy forward to the admin orchestrator with the
// session as the credential, so its per-action grant-scope authorization applies
// UNCHANGED (a caller lacking the grant is refused with AdminAuthError → 403).
// Cookie-authenticated POSTs are CSRF-gated in http.ts (routeData) like /web/logout.

/** List the projects the caller can manage; forwards to web_project_orchestrator.listProjects. */
function projectList(cfg: HostConfig, sessionId: string, res: ServerResponse): void {
  sendJson(res, 200, { projects: webproject.listProjects(cfg, sessionId) });
}

/** Create a project placed in the REQUIRED owner unit; forwards to
 *  web_project_orchestrator.createProject (missing/unknown unit rejects upstream). */
function projectCreate(cfg: HostConfig, sessionId: string, body: Body, res: ServerResponse): void {
  sendJson(res, 201, webproject.createProject(cfg, sessionId, String(body?.id ?? ''), String(body?.unitId ?? '')));
}

/** Lock a project; forwards to web_project_orchestrator.lockProject. */
function projectLock(cfg: HostConfig, sessionId: string, body: Body, res: ServerResponse): void {
  sendJson(res, 200, webproject.lockProject(cfg, sessionId, String(body?.projectId ?? '')));
}

/** Promote a project; forwards to web_project_orchestrator.promoteProject. */
function projectPromote(cfg: HostConfig, sessionId: string, body: Body, res: ServerResponse): void {
  sendJson(res, 200, webproject.promoteProject(cfg, sessionId, String(body?.projectId ?? '')));
}

/** Destroy a project; forwards to web_project_orchestrator.destroyProject. */
function projectDestroy(cfg: HostConfig, sessionId: string, body: Body, res: ServerResponse): void {
  webproject.destroyProject(cfg, sessionId, String(body?.id ?? ''));
  sendJson(res, 200, { ok: true });
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

    // POST /web/sso/start  { providerId, redirectUri } → { url }; also installs the
    // short-lived HttpOnly nonce cookie that binds this browser to the flow.
    if (req.method === 'POST' && parts.length === 3 && parts[1] === 'sso' && parts[2] === 'start') {
      const started = await startSignIn(cfg, body?.providerId as string, body?.redirectUri as string);
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': setNonceCookie(started.nonce, ctx.secureCookie),
      });
      res.end(JSON.stringify({ url: started.url }));
      return;
    }

    // GET /web/sso/callback?state=&code= → require the nonce cookie to match the
    // signed state, then set the session cookie, clear the nonce cookie, land on /.
    if (req.method === 'GET' && parts.length === 3 && parts[1] === 'sso' && parts[2] === 'callback') {
      const newSessionId = await completeSignIn(
        cfg,
        url.searchParams.get('state') ?? '',
        url.searchParams.get('code') ?? '',
        ssoNonceCookieValue(req),
      );
      res.writeHead(302, {
        'set-cookie': [setSessionCookie(newSessionId, ctx.secureCookie), clearNonceCookie(ctx.secureCookie)],
        location: '/',
      });
      res.end();
      return;
    }

    // GET /web/login-options → the pre-auth sign-in methods the login screen
    // renders from. UNAUTHENTICATED (no session, no CSRF — it is a GET) and
    // 404-gated with every /web route on exposure.webUiEnabled in http.ts. The
    // payload carries only the password-login flag and enabled-provider
    // { id, displayName } pairs — never secrets, clientIds, or endpoint config.
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'login-options') {
      return sendJson(res, 200, getLoginOptions(cfg));
    }

    // POST /web/login { user, password } → built-in super-admin password sign-in.
    // ESTABLISHES a session (no prior cookie exists to ride), so it is NOT in the
    // cookie-mutation CSRF set — like the SSO callback, trust anchors on the
    // credential itself. Gated (with every /web route) on exposure.webUiEnabled.
    if (req.method === 'POST' && parts.length === 2 && parts[1] === 'login') {
      return loginWithPassword(cfg, body, res, ctx.secureCookie);
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

    // ── Agent-token self-service (any signed-in user) ────────────────────────
    // GET /web/tokens → list the caller's OWN minted MCP tokens (redacted). A read,
    // so it carries no CSRF requirement (only cookie-auth POSTs are gated above).
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'tokens') {
      return listAgentTokens(cfg, sessionId, res);
    }
    // POST /web/tokens { projectId, write } → mint a single-project MCP token for an
    // AI agent. mintProjectToken forwards to the identity orchestrator's self-service
    // mint, which authorizes strictly against the caller's own access to that project
    // and OWNS the token to the caller. The plaintext token is returned once. Web-UI
    // login and MCP tokens are separate credentials (the token is owned by the human).
    if (req.method === 'POST' && parts.length === 2 && parts[1] === 'tokens') {
      return mintAgentToken(cfg, sessionId, body, res);
    }
    // POST /web/tokens/revoke { id } → revoke a minted MCP token the caller OWNS.
    if (req.method === 'POST' && parts.length === 3 && parts[1] === 'tokens' && parts[2] === 'revoke') {
      return revokeAgentToken(cfg, sessionId, body, res);
    }

    // ── Project-lifecycle self-management (session-scoped) ───────────────────
    // The human project-lifecycle surface: list the projects the caller may manage
    // and create / lock / promote / destroy within their grant scope. projectList is
    // a scoped read owned by the web project orchestrator; the mutations forward to
    // the admin orchestrator with the session as the credential (per-action grant
    // scope enforced there — a caller lacking the grant is refused 403). Cookie POSTs
    // are CSRF-gated in http.ts (routeData) exactly like /web/logout.
    if (parts.length >= 2 && parts[1] === 'projects') {
      // GET /web/projects — the projects the caller may manage (scoped).
      if (req.method === 'GET' && parts.length === 2) {
        return projectList(cfg, sessionId, res);
      }
      // POST /web/projects { id, unitId? } — create a project (project:create scope).
      if (req.method === 'POST' && parts.length === 2) {
        return projectCreate(cfg, sessionId, body, res);
      }
      // POST /web/projects/lock { projectId } — lock (lock:create scope).
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'lock') {
        return projectLock(cfg, sessionId, body, res);
      }
      // POST /web/projects/promote { projectId } — mark ready (promote:mark-ready scope).
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'promote') {
        return projectPromote(cfg, sessionId, body, res);
      }
      // POST /web/projects/destroy { id } — deregister (project:destroy scope).
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'destroy') {
        return projectDestroy(cfg, sessionId, body, res);
      }
    }

    // ── Admin control-plane, session-scoped (slice 3) ────────────────────────
    // These reuse the EXISTING Phase-6 scoped control-plane functions, passing the
    // browser session id as the credential (a ws_ session resolves to a Principal
    // exactly like a bearer token). Each function authenticates and FILTERS to the
    // caller's grants — a viewer session gets an empty/forbidden result, never
    // another tenant's data. No new authorization surface, just a browser-reachable
    // route onto the same scoped reads the admin API already exposes.
    if (parts.length >= 2 && parts[1] === 'admin') {
      // ── Web admin orchestrator surface (user / IdP / key / org-unit) ───────
      // Each route forwards to webadmin.ts (web_admin_orchestrator), which
      // re-applies the exact control-plane authorization with the session as the
      // credential. Cookie POSTs here are CSRF-gated in http.ts like /web/logout.
      //
      // GET /web/admin/users?project= — scoped user directory (user:admin scope).
      if (req.method === 'GET' && parts.length === 3 && parts[2] === 'users') {
        return adminListUsers(cfg, sessionId, url, res);
      }
      // POST /web/admin/users/status { userId, status }
      if (req.method === 'POST' && parts.length === 4 && parts[2] === 'users' && parts[3] === 'status') {
        return adminSetUserStatus(cfg, sessionId, body, res);
      }
      // POST /web/admin/users { ...HostedUserRecord }
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'users') {
        return adminUpsertUser(cfg, sessionId, body, res);
      }
      // GET /web/admin/providers — identity-provider (SSO) configs (instance-admin).
      if (req.method === 'GET' && parts.length === 3 && parts[2] === 'providers') {
        return adminListProviders(cfg, sessionId, res);
      }
      // POST /web/admin/providers/remove { id }
      if (req.method === 'POST' && parts.length === 4 && parts[2] === 'providers' && parts[3] === 'remove') {
        return adminRemoveProvider(cfg, sessionId, body, res);
      }
      // POST /web/admin/providers { ...IdentityProviderConfig }
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'providers') {
        return adminUpsertProvider(cfg, sessionId, body, res);
      }
      // GET /web/admin/org/units — organization units (instance-admin).
      if (req.method === 'GET' && parts.length === 4 && parts[2] === 'org' && parts[3] === 'units') {
        return adminListOrgUnits(cfg, sessionId, res);
      }
      // GET /web/admin/secrets — configured secret ref NAMES (instance-admin; never values).
      if (req.method === 'GET' && parts.length === 3 && parts[2] === 'secrets') {
        return adminListSecretRefs(cfg, sessionId, res);
      }
      // POST /web/admin/org/units { ...OrganizationUnitRecord }
      if (req.method === 'POST' && parts.length === 4 && parts[2] === 'org' && parts[3] === 'units') {
        return adminUpsertOrgUnit(cfg, sessionId, body, res);
      }
      // POST /web/admin/org/placements { projectId, unitId }
      if (req.method === 'POST' && parts.length === 4 && parts[2] === 'org' && parts[3] === 'placements') {
        return adminPlaceProject(cfg, sessionId, body, res);
      }

      // ── Existing scoped control-plane reads (unchanged) ───────────────────
      // GET /web/admin/landscape — the org-unit + project + relation graph (landscape:read).
      if (req.method === 'GET' && parts.length === 3 && parts[2] === 'landscape') {
        return sendJson(res, 200, generateLandscape(cfg, sessionId));
      }
      // GET /web/admin/health — instance health report (operations:read).
      if (req.method === 'GET' && parts.length === 3 && parts[2] === 'health') {
        return sendJson(res, 200, getHealthReport(cfg, sessionId));
      }
      // GET /web/admin/usage — resource usage snapshots (operations:read).
      if (req.method === 'GET' && parts.length === 3 && parts[2] === 'usage') {
        return sendJson(res, 200, { usage: getUsage(cfg, sessionId) });
      }
      // GET /web/admin/approvals — pending approval requests in the caller's scope
      // (approval:decide).
      if (req.method === 'GET' && parts.length === 3 && parts[2] === 'approvals') {
        return sendJson(res, 200, { requests: listPendingRequests(cfg, sessionId) });
      }
      // POST /web/admin/approvals/decide { requestId, approved, reason } — decide a
      // pending request. decidedBy is server-authoritative (the session principal);
      // self-approval is refused inside decideRequest.
      if (req.method === 'POST' && parts.length === 4 && parts[2] === 'approvals' && parts[3] === 'decide') {
        const decision: ApprovalDecision = {
          requestId: String(body?.requestId ?? ''),
          approved: body?.approved === true,
          reason: typeof body?.reason === 'string' ? body.reason : undefined,
          decidedBy: { userId: '', kind: 'human', issuer: 'local' }, // overridden server-side
          decidedAt: '', // set server-side
        };
        return sendJson(res, 200, decideRequest(cfg, sessionId, decision));
      }
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof UnauthenticatedError) return sendJson(res, 401, { error: 'unauthorized' });
    if (err instanceof ForbiddenError) return sendJson(res, 403, { error: 'forbidden' });
    // The project-lifecycle forwards authorize by grant scope in the admin
    // orchestrator, which throws AdminAuthError (missing credential OR insufficient
    // scope); both map to 403 here, so the client surfaces a graceful "not permitted".
    if (err instanceof AdminAuthError) return sendJson(res, 403, { error: 'forbidden' });
    // A lock that fails validate-as-complete is a conflict, not a client error —
    // return the validation errors like the admin plane does (409). Matched by name
    // (not an admin.ts class import) so the web portal takes no undeclared edge onto
    // the admin orchestrator; the forward itself rides web_project_orchestrator.
    if (err instanceof Error && err.name === 'LockValidationError') {
      const errors = (err as { errors?: { code: string; message: string; specId?: string }[] }).errors;
      return sendJson(res, 409, { error: err.message, errors });
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/unsupported graph tier/i.test(msg)) return sendJson(res, 400, { error: msg });
    if (/not found|unknown/i.test(msg)) return sendJson(res, 404, { error: msg });
    return sendJson(res, 400, { error: msg });
  }
}
