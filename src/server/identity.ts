import * as crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { authenticateCredential, signSsoState, verifySsoState } from './auth.js';
import { buildAuthorizationUrl, exchangeCode, resolveSubject } from './idp.js';
import {
  listIdentityProviderRecords,
  upsertIdentityProviderRecord,
  removeIdentityProviderRecord,
} from './policy.js';
import {
  hashToken,
  createCredential,
  revokeCredential,
  listCredentials,
} from './credentials.js';
import {
  getUserById,
  listUsers as repoListUsers,
  upsertUser as repoUpsertUser,
  setUserStatus as repoSetUserStatus,
  replaceUserGrants as repoReplaceUserGrants,
  findUserByExternalSubject as repoFindUserByExternalSubject,
} from './users.js';
import {
  appendAuditEvent,
  queryAuditEvents as repoQueryAuditEvents,
  pruneAuditEvents as repoPruneAuditEvents,
  countAuditEvents as repoCountAuditEvents,
  DEFAULT_AUDIT_POLICY,
} from './audit.js';
import { listProjectRecords } from './projects.js';
import { sendJson } from './request.js';
import type {
  ApiKeyRecord,
  AuditEvent,
  AuditQuery,
  AuditRetentionPolicy,
  HostConfig,
  HostedUserRecord,
  IdentityProviderConfig,
  Principal,
  PrincipalSubject,
  ProjectGrant,
  Role,
} from './types.js';

// ---------------------------------------------------------------------------
// Identity Orchestrator + Portal (sdd_host)
//
// The identity control-plane workflows: authenticate the caller credential
// (bootstrap master or user-bound token) via the auth specialist, authorize by
// grants, then manage user-bound MCP/API tokens, user grants, and admin-only
// audit access. Exported as plain functions so both the HTTP identity portal
// (handleIdentityRequest, below) and any in-process caller reach the same logic
// — mirroring admin.ts. Every audit append is best-effort: an append failure is
// recorded as a server diagnostic and never fails the primary action.
//
// Phase 1 exposure decision: the identity control plane rides the ADMIN-plane
// listener (127.0.0.1 by default) until HostExposurePolicy lands in a later
// phase and gives it its own `identityApiEnabled` switch. See handleIdentityRequest.
// ---------------------------------------------------------------------------

/** Authorized request to mint a user-bound MCP/API token. Mirrors
 *  .wai/specs/types/token_mint_request.yaml (TS type kept local per file scope). */
export interface TokenMintRequest {
  /** Hosted user or service-principal id that will own the token. */
  ownerUserId: string;
  /** Human-readable token label for administration and audit views. */
  label: string;
  /** Project and instance permissions to grant to the token; the caller must be
   *  able to delegate each. */
  grants: ProjectGrant[];
  /** Optional ISO-8601 token expiry. */
  expiresAt?: string;
}

// Error classes moved to errors.ts (breaking the identity↔policy import cycle);
// imported for local use and re-exported so existing importers keep working.
import { UnauthenticatedError, ForbiddenError } from './errors.js';
export { UnauthenticatedError, ForbiddenError };

// ── authorization helpers ──────────────────────────────────────────────────
//
// '*' is the wildcard in BOTH projectId and permissions (per the grant model).

/** Instance-admin = a grant scoped to every project ('*') carrying every
 *  permission ('*'). The bootstrap principal and the legacy admin-role
 *  projection both yield exactly this grant. */
function isInstanceAdmin(principal: Principal): boolean {
  return (principal.grants ?? []).some(
    (g) => g.projectId === '*' && g.permissions.includes('*'),
  );
}

/** True when the caller's grants cover `permission` for `projectId` — a grant
 *  scoped to that project (or instance-wide '*') carrying that permission (or '*'). */
function coversPermission(principal: Principal, projectId: string, permission: string): boolean {
  return (principal.grants ?? []).some(
    (g) =>
      (g.projectId === '*' || g.projectId === projectId) &&
      (g.permissions.includes('*') || g.permissions.includes(permission)),
  );
}

/** True when the caller carries `permission` in any grant, regardless of project
 *  scope (or a wildcard '*' permission). Used for instance-wide capabilities like
 *  audit:read and user administration. */
function carriesPermission(principal: Principal, permission: string): boolean {
  return (principal.grants ?? []).some(
    (g) => g.permissions.includes('*') || g.permissions.includes(permission),
  );
}

/** Permission that authorizes user administration. The published grant
 *  vocabulary (docs/design/hosted-professional-use.md §1.2) does not yet name a
 *  user-admin permission; this is the chosen identifier for it. */
const USER_ADMIN_PERMISSION = 'user:admin';
const AUDIT_READ_PERMISSION = 'audit:read';
const KEY_MANAGE_PERMISSION = 'key:manage';

// ── audit helpers ──────────────────────────────────────────────────────────

/** Resolve the active audit retention policy. Host-config plumbing
 *  (HostConfig.auditPolicy) is a later phase; until then the secure default. */
function resolveAuditPolicy(_cfg: HostConfig): AuditRetentionPolicy {
  return DEFAULT_AUDIT_POLICY;
}

/** The audit actor for an action: the caller's resolved subject, or — when a
 *  legacy master/token credential carries no subject — a synthesized service
 *  identity keyed by the credential's token id. */
function auditActor(principal: Principal): PrincipalSubject {
  return (
    principal.subject ?? {
      userId: 'token:' + principal.tokenId,
      kind: 'service',
      issuer: 'local',
    }
  );
}

function buildAuditEvent(
  principal: Principal,
  action: string,
  level: string,
  category: string,
  over: Partial<AuditEvent> = {},
): AuditEvent {
  const event: AuditEvent = {
    id: '',
    timestamp: '',
    level,
    category,
    action,
    outcome: 'success',
    actor: auditActor(principal),
    ...over,
  };
  if (principal.tokenId) event.tokenId = principal.tokenId;
  return event;
}

/** The audit actor for the unauthenticated login-start step: no user is resolved
 *  yet (the provider hasn't spoken), so the action is attributed to an anonymous
 *  local service identity — the provider it targets is carried on the event target. */
const ANONYMOUS_SSO_ACTOR: PrincipalSubject = { userId: 'anonymous', kind: 'service', issuer: 'local' };

/** Build a redacted audit event for an actor SUBJECT directly (category 'auth'),
 *  for the unauthenticated SSO login pair (start/complete) which carries no
 *  Principal. Mirrors buildAuditEvent but takes the resolved subject as the actor. */
function buildSsoAuditEvent(
  actor: PrincipalSubject,
  action: string,
  level: string,
  over: Partial<AuditEvent> = {},
): AuditEvent {
  return {
    id: '',
    timestamp: '',
    level,
    category: 'auth',
    action,
    outcome: 'success',
    actor,
    ...over,
  };
}

/** Append a redacted audit event, best-effort: a failure is recorded as a server
 *  diagnostic and swallowed so an append can never fail the primary action. */
function tryAppendAudit(cfg: HostConfig, event: AuditEvent): void {
  try {
    appendAuditEvent(cfg.dataDir, event, resolveAuditPolicy(cfg));
  } catch (err) {
    // Server diagnostic (audit appends are best-effort by invariant).
    console.error(
      `[identity] audit append failed for "${event.action}": ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/** Authenticate the caller credential or throw (401-mapping). */
function requirePrincipal(cfg: HostConfig, credential: string | null): Principal {
  const principal = authenticateCredential(cfg.dataDir, credential);
  if (!principal.authenticated) throw new UnauthenticatedError();
  return principal;
}

/** Derive the coarse role/projects compatibility projection from precise grants:
 *  any instance-wide ('*') grant → admin over ['*']; otherwise editor over the
 *  distinct granted project ids. Mirrors auth.ts's forward projection in reverse. */
function compatibilityProjection(grants: ProjectGrant[]): { role: Role; projects: string[] } {
  if (grants.some((g) => g.projectId === '*')) {
    return { role: 'admin', projects: ['*'] };
  }
  const projects = [...new Set(grants.map((g) => g.projectId))];
  return { role: 'editor', projects };
}

// ── orchestrator methods ────────────────────────────────────────────────────

/**
 * Authenticate the caller, authorize token delegation (key:manage covering every
 * requested project, or an instance-wide admin grant), validate the requested
 * projects exist, mint a user-bound token, persist only its hashed record with
 * owner/grant metadata, and append a redacted audit event. Returns the plaintext
 * token exactly once.
 */
export function mintToken(cfg: HostConfig, credential: string | null, request: TokenMintRequest): string {
  const principal = requirePrincipal(cfg, credential);

  // Authorize delegation: instance-admin may delegate anything; otherwise the
  // caller must hold key:manage for every requested project, and an instance-wide
  // ('*') delegation requires instance-admin.
  const admin = isInstanceAdmin(principal);
  const grants = request.grants ?? [];
  const mayDelegate =
    admin ||
    grants.every((g) =>
      g.projectId === '*' ? admin : coversPermission(principal, g.projectId, KEY_MANAGE_PERMISSION),
    );
  if (!mayDelegate) {
    throw new ForbiddenError('caller may not delegate the requested grants');
  }

  // Validate every referenced project exists ('*' already gated to instance-admin).
  const known = new Set(listProjectRecords(cfg.dataDir).map((p) => p.id));
  for (const g of grants) {
    if (g.projectId !== '*' && !known.has(g.projectId)) {
      throw new Error(`unknown project "${g.projectId}"`);
    }
  }

  // Mint the token and compute its salted hash (same shape as the admin key-mint).
  const token = 'wk_' + crypto.randomBytes(24).toString('hex');
  const projection = compatibilityProjection(grants);
  const record: ApiKeyRecord = {
    id: crypto.randomBytes(6).toString('hex'),
    keyHash: hashToken(token),
    role: projection.role,
    projects: projection.projects,
    createdAt: new Date().toISOString(),
    ownerSubject: { userId: request.ownerUserId, kind: 'service', issuer: 'local' },
    grants,
    label: request.label,
  };
  if (principal.subject) record.createdBySubject = principal.subject;
  if (request.expiresAt) record.expiresAt = request.expiresAt;

  createCredential(cfg.dataDir, record);

  tryAppendAudit(
    cfg,
    buildAuditEvent(principal, 'token.mint', 'security', 'admin', { target: record.id }),
  );

  return token; // plaintext, shown exactly once
}

/**
 * Authenticate the caller, authorize key management for the target token's project
 * scope (or instance-admin), revoke the credential record, and append a redacted
 * audit event.
 */
export function revokeToken(cfg: HostConfig, credential: string | null, tokenId: string): void {
  const principal = requirePrincipal(cfg, credential);

  const admin = isInstanceAdmin(principal);
  const target = listCredentials(cfg.dataDir, '*').find((r) => r.id === tokenId);
  const targetProjects = target?.projects ?? [];
  const mayManage =
    admin ||
    (targetProjects.length > 0 &&
      targetProjects.every((p) =>
        p === '*' ? admin : coversPermission(principal, p, KEY_MANAGE_PERMISSION),
      ));
  if (!mayManage) {
    throw new ForbiddenError('caller may not manage this token');
  }

  revokeCredential(cfg.dataDir, tokenId);

  tryAppendAudit(
    cfg,
    buildAuditEvent(principal, 'token.revoke', 'security', 'admin', { target: tokenId }),
  );
}

/**
 * Authenticate the caller, require an instance-wide admin grant, replace the
 * user's grants wholesale through the repository, and append a redacted audit event.
 */
export function replaceUserGrants(
  cfg: HostConfig,
  credential: string | null,
  userId: string,
  grants: ProjectGrant[],
): HostedUserRecord {
  const principal = requirePrincipal(cfg, credential);
  if (!isInstanceAdmin(principal)) {
    throw new ForbiddenError('grant administration requires an instance-wide admin grant');
  }

  const updated = repoReplaceUserGrants(cfg.dataDir, userId, grants);

  tryAppendAudit(
    cfg,
    buildAuditEvent(principal, 'user.grants.replace', 'security', 'admin', { target: userId }),
  );

  return updated;
}

/**
 * Authenticate the caller, require instance-admin or a user-administration grant,
 * and list hosted users optionally narrowed to one project's grant holders. No
 * audit event (a read).
 */
export function listUsers(
  cfg: HostConfig,
  credential: string | null,
  project?: string,
): HostedUserRecord[] {
  const principal = requirePrincipal(cfg, credential);
  if (!isInstanceAdmin(principal) && !carriesPermission(principal, USER_ADMIN_PERMISSION)) {
    throw new ForbiddenError('user administration required');
  }
  return repoListUsers(cfg.dataDir, undefined, project);
}

/**
 * Authenticate the caller, require instance-admin or an audit:read grant, and
 * return redacted audit events matching the query. No audit event (a read).
 */
export function queryAuditEvents(
  cfg: HostConfig,
  credential: string | null,
  query: AuditQuery,
): AuditEvent[] {
  const principal = requirePrincipal(cfg, credential);
  if (!isInstanceAdmin(principal) && !carriesPermission(principal, AUDIT_READ_PERMISSION)) {
    throw new ForbiddenError('audit read access required');
  }
  return repoQueryAuditEvents(cfg.dataDir, query);
}

/**
 * Authenticate the caller, require an instance-wide admin grant, apply the active
 * retention policy, append a redacted audit event for the prune itself, and return
 * the number of events removed.
 */
export function pruneAuditEvents(cfg: HostConfig, credential: string | null): number {
  const principal = requirePrincipal(cfg, credential);
  if (!isInstanceAdmin(principal)) {
    throw new ForbiddenError('audit administration requires an instance-wide admin grant');
  }

  const policy = resolveAuditPolicy(cfg);
  const removed = repoPruneAuditEvents(cfg.dataDir, policy, new Date().toISOString());

  tryAppendAudit(cfg, buildAuditEvent(principal, 'audit.prune', 'info', 'audit', { target: 'audit' }));

  return removed;
}

/**
 * Authenticate the caller, require an instance-wide admin grant, create or update
 * the hosted user through the repository, and append a redacted audit event
 * distinguishing creation from update.
 */
export function upsertUser(
  cfg: HostConfig,
  credential: string | null,
  record: HostedUserRecord,
): HostedUserRecord {
  const principal = requirePrincipal(cfg, credential);
  if (!isInstanceAdmin(principal)) {
    throw new ForbiddenError('user administration requires an instance-wide admin grant');
  }

  // Distinguish creation from update by probing for an existing record first.
  const existed = getUserById(cfg.dataDir, record.id) !== null;
  const action = existed ? 'user.update' : 'user.create';

  const stored = repoUpsertUser(cfg.dataDir, record);

  tryAppendAudit(cfg, buildAuditEvent(principal, action, 'info', 'admin', { target: record.id }));

  return stored;
}

/**
 * Authenticate the caller, require an instance-wide admin grant, set the user's
 * lifecycle status through the repository, and append a redacted audit event.
 */
export function setUserStatus(
  cfg: HostConfig,
  credential: string | null,
  userId: string,
  status: string,
): HostedUserRecord {
  const principal = requirePrincipal(cfg, credential);
  if (!isInstanceAdmin(principal)) {
    throw new ForbiddenError('user administration requires an instance-wide admin grant');
  }

  const updated = repoSetUserStatus(cfg.dataDir, userId, status);

  tryAppendAudit(
    cfg,
    buildAuditEvent(principal, 'user.status.set', 'security', 'admin', { target: userId }),
  );

  return updated;
}

// ── headless SSO login (unauthenticated pair) ────────────────────────────────
//
// The SSO state is a signed, self-describing payload — a JSON string
// `{ providerId, nonce, redirectUri }` sealed by the auth specialist (signSsoState)
// on start and verified (verifySsoState) on completion. It is the ONLY integrity
// anchor the callback carries: there is no server-side login session. The pair is
// unauthenticated by design — no caller credential is required or accepted; trust
// derives entirely from the signed state plus the provider code exchange.

/** The signed SSO state payload bound on start and re-derived on completion. */
interface SsoStatePayload {
  providerId: string;
  nonce: string;
  redirectUri: string;
}

/** Resolve one ENABLED identity provider by id, or throw a login-rejecting error
 *  (unknown id or a disabled provider both reject identically). */
function resolveEnabledProvider(cfg: HostConfig, providerId: string): IdentityProviderConfig {
  const provider = listIdentityProviderRecords(cfg.dataDir).find((p) => p.id === providerId);
  if (!provider || !provider.enabled) {
    throw new Error(`unknown or disabled identity provider "${providerId}"`);
  }
  return provider;
}

/**
 * Begin a headless SSO login: resolve the enabled provider, generate a nonce, sign
 * an SSO state binding providerId + nonce + redirectUri, build the provider
 * authorization URL, append a best-effort sso.start (info) audit event, and return
 * the authorization URL. Unauthenticated by nature — no caller credential.
 */
export function startSsoLogin(cfg: HostConfig, providerId: string, redirectUri: string): string {
  const provider = resolveEnabledProvider(cfg, providerId);

  const nonce = crypto.randomBytes(16).toString('hex');
  const payload: SsoStatePayload = { providerId, nonce, redirectUri };
  const state = signSsoState(JSON.stringify(payload));
  const url = buildAuthorizationUrl(provider, state, redirectUri);

  tryAppendAudit(cfg, buildSsoAuditEvent(ANONYMOUS_SSO_ACTOR, 'sso.start', 'info', { target: providerId }));

  return url;
}

/**
 * Complete a headless SSO login: verify the signed state (tampered/expired is
 * rejected), resolve the bound enabled provider, exchange the code and resolve the
 * external subject, look up the hosted user by issuer + external subject, provision
 * a first-login active user with EMPTY grants when absent (an admin assigns grants
 * afterwards), mint a user-bound token for the resolved user persisting only its
 * hashed record, append a best-effort sso.login (security) audit event, and return
 * the plaintext token exactly once. Unauthenticated by nature — no caller credential.
 */
export async function completeSsoLogin(cfg: HostConfig, state: string, code: string): Promise<string> {
  // Verify + parse the signed state (throws on a tampered or expired state).
  const payload = JSON.parse(verifySsoState(state)) as SsoStatePayload;
  const { providerId, redirectUri } = payload;

  const provider = resolveEnabledProvider(cfg, providerId);

  // Exchange the code (network I/O) and resolve the external subject, never
  // leaking raw provider tokens across the boundary.
  const summary = await exchangeCode(provider, code, redirectUri);
  const subject = resolveSubject(provider, summary);

  // Look up the hosted user by issuer + external subject; provision on first login.
  let user = repoFindUserByExternalSubject(cfg.dataDir, subject.issuer, subject.externalSubject ?? '');
  if (!user) {
    const provisioned: HostedUserRecord = {
      id: subject.userId,
      subject,
      status: 'active',
      grants: [], // first-login: empty — an admin assigns grants afterwards
      createdAt: new Date().toISOString(),
    };
    user = repoUpsertUser(cfg.dataDir, provisioned);
  }

  // Mint a user-bound token (same record shape as mintToken) carrying the resolved
  // user's CURRENT grants and their role/projects compatibility projection.
  const token = 'wk_' + crypto.randomBytes(24).toString('hex');
  const projection = compatibilityProjection(user.grants);
  const record: ApiKeyRecord = {
    id: crypto.randomBytes(6).toString('hex'),
    keyHash: hashToken(token),
    role: projection.role,
    projects: projection.projects,
    createdAt: new Date().toISOString(),
    ownerSubject: user.subject,
    createdBySubject: user.subject,
    grants: user.grants,
    label: `SSO login (${providerId})`,
  };
  createCredential(cfg.dataDir, record);

  tryAppendAudit(
    cfg,
    buildSsoAuditEvent(user.subject, 'sso.login', 'security', { target: record.id }),
  );

  return token; // plaintext, shown exactly once
}

// ── identity-provider (SSO) administration (instance-admin only) ──────────────

/**
 * Authenticate the caller, require an instance-wide admin grant, and return every
 * configured identity provider by forwarding to the policy repository. Not audited
 * (a read).
 */
export function listIdentityProviders(
  cfg: HostConfig,
  credential: string | null,
): IdentityProviderConfig[] {
  const principal = requirePrincipal(cfg, credential);
  if (!isInstanceAdmin(principal)) {
    throw new ForbiddenError('identity-provider administration requires an instance-wide admin grant');
  }
  return listIdentityProviderRecords(cfg.dataDir);
}

/**
 * Authenticate the caller, require an instance-wide admin grant, create or update
 * one identity-provider configuration through the policy repository (the config
 * carries a clientSecretRef, never a raw secret), append a redacted idp.upsert
 * (security) audit event, and return the stored config.
 */
export function upsertIdentityProvider(
  cfg: HostConfig,
  credential: string | null,
  config: IdentityProviderConfig,
): IdentityProviderConfig {
  const principal = requirePrincipal(cfg, credential);
  if (!isInstanceAdmin(principal)) {
    throw new ForbiddenError('identity-provider administration requires an instance-wide admin grant');
  }

  const stored = upsertIdentityProviderRecord(cfg.dataDir, config);

  tryAppendAudit(cfg, buildAuditEvent(principal, 'idp.upsert', 'security', 'auth', { target: stored.id }));

  return stored;
}

/**
 * Authenticate the caller, require an instance-wide admin grant, remove one
 * identity-provider configuration by id through the policy repository (an unknown
 * id is rejected), and append a redacted idp.remove (security) audit event.
 */
export function removeIdentityProvider(cfg: HostConfig, credential: string | null, id: string): void {
  const principal = requirePrincipal(cfg, credential);
  if (!isInstanceAdmin(principal)) {
    throw new ForbiddenError('identity-provider administration requires an instance-wide admin grant');
  }

  removeIdentityProviderRecord(cfg.dataDir, id);

  tryAppendAudit(cfg, buildAuditEvent(principal, 'idp.remove', 'security', 'auth', { target: id }));
}

/**
 * Authenticate the caller, require instance-admin or an audit:read grant (same
 * authorization as queryAuditEvents), and return the count of redacted audit events
 * matching the query by forwarding to the audit repository. No audit event (a read).
 */
export function countAuditEvents(
  cfg: HostConfig,
  credential: string | null,
  query: AuditQuery,
): number {
  const principal = requirePrincipal(cfg, credential);
  if (!isInstanceAdmin(principal) && !carriesPermission(principal, AUDIT_READ_PERMISSION)) {
    throw new ForbiddenError('audit read access required');
  }
  return repoCountAuditEvents(cfg.dataDir, query);
}

// ── Identity Portal (HTTP) ──────────────────────────────────────────────────
//
// Forwarding to the orchestrator functions above. The router is async because the
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
  const parts = url.pathname.split('/').filter(Boolean); // ['identity', ...]
  try {
    // ── headless SSO login (unauthenticated: no credential) ──────────────────
    // POST /identity/sso/start  { providerId, redirectUri }
    if (req.method === 'POST' && parts.length === 3 && parts[1] === 'sso' && parts[2] === 'start') {
      const url_ = startSsoLogin(cfg, body.providerId as string, body.redirectUri as string);
      return sendJson(res, 200, { url: url_ });
    }
    // GET /identity/sso/callback?state=&code=
    // Headless flow: returns the minted token as JSON. A browser-facing UI would
    // render/exchange this into a session instead of showing it raw — UX watch-item.
    if (req.method === 'GET' && parts.length === 3 && parts[1] === 'sso' && parts[2] === 'callback') {
      const token = await completeSsoLogin(
        cfg,
        url.searchParams.get('state') ?? '',
        url.searchParams.get('code') ?? '',
      );
      return sendJson(res, 200, { token });
    }

    // ── identity-provider (SSO) administration (instance-admin only) ─────────
    // GET /identity/providers
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'providers') {
      return sendJson(res, 200, listIdentityProviders(cfg, credential));
    }
    // PUT /identity/providers/{id}
    if (req.method === 'PUT' && parts.length === 3 && parts[1] === 'providers') {
      const config = { ...(body as IdentityProviderConfig), id: parts[2] };
      return sendJson(res, 200, upsertIdentityProvider(cfg, credential, config));
    }
    // DELETE /identity/providers/{id}
    if (req.method === 'DELETE' && parts.length === 3 && parts[1] === 'providers') {
      removeIdentityProvider(cfg, credential, parts[2]);
      return sendJson(res, 200, { ok: true });
    }
    // GET /identity/audit/count
    if (req.method === 'GET' && parts.length === 3 && parts[1] === 'audit' && parts[2] === 'count') {
      return sendJson(res, 200, { count: countAuditEvents(cfg, credential, auditQueryFromParams(url.searchParams)) });
    }

    // POST /identity/tokens
    if (req.method === 'POST' && parts.length === 2 && parts[1] === 'tokens') {
      return sendJson(res, 201, { key: mintToken(cfg, credential, body as TokenMintRequest) });
    }
    // DELETE /identity/tokens/{id}
    if (req.method === 'DELETE' && parts.length === 3 && parts[1] === 'tokens') {
      revokeToken(cfg, credential, parts[2]);
      return sendJson(res, 200, { ok: true });
    }
    // GET /identity/users?project=
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'users') {
      return sendJson(res, 200, listUsers(cfg, credential, url.searchParams.get('project') ?? undefined));
    }
    // PUT /identity/users/{id}/grants
    if (req.method === 'PUT' && parts.length === 4 && parts[1] === 'users' && parts[3] === 'grants') {
      return sendJson(res, 200, replaceUserGrants(cfg, credential, parts[2], body.grants as ProjectGrant[]));
    }
    // PUT /identity/users/{id}/status
    if (req.method === 'PUT' && parts.length === 4 && parts[1] === 'users' && parts[3] === 'status') {
      return sendJson(res, 200, setUserStatus(cfg, credential, parts[2], body.status as string));
    }
    // PUT /identity/users/{id}
    if (req.method === 'PUT' && parts.length === 3 && parts[1] === 'users') {
      const record = { ...(body as HostedUserRecord), id: parts[2] };
      return sendJson(res, 200, upsertUser(cfg, credential, record));
    }
    // GET /identity/audit/events
    if (req.method === 'GET' && parts.length === 3 && parts[1] === 'audit' && parts[2] === 'events') {
      return sendJson(res, 200, queryAuditEvents(cfg, credential, auditQueryFromParams(url.searchParams)));
    }
    // POST /identity/audit/prune
    if (req.method === 'POST' && parts.length === 3 && parts[1] === 'audit' && parts[2] === 'prune') {
      return sendJson(res, 200, { pruned: pruneAuditEvents(cfg, credential) });
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof UnauthenticatedError) return sendJson(res, 401, { error: 'unauthorized' });
    if (err instanceof ForbiddenError) return sendJson(res, 403, { error: 'forbidden' });
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}
