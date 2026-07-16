import * as crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { authenticateCredential, signSsoState, verifySsoState } from './auth.js';
import { resolveEndpoints, buildAuthorizationUrl, exchangeCode, resolveSubject, resolveGroups } from './idp.js';
import {
  listIdentityProviderRecords,
  upsertIdentityProviderRecord,
  removeIdentityProviderRecord,
} from './policy.js';
import {
  hashToken,
  createCredential,
  revokeCredential,
  revokeAllForOwner,
  listByOwner,
} from './credentials.js';
import {
  getUserById,
  listUsers as repoListUsers,
  upsertUser as repoUpsertUser,
  setUserStatus as repoSetUserStatus,
  findUserByExternalSubject as repoFindUserByExternalSubject,
} from './users.js';
import { listAssignments } from './permissions.js';
import {
  appendAuditEvent,
  queryAuditEvents as repoQueryAuditEvents,
  pruneAuditEvents as repoPruneAuditEvents,
  countAuditEvents as repoCountAuditEvents,
  DEFAULT_AUDIT_POLICY,
} from './audit.js';
import { listProjectRecords } from './projects.js';
import { removeAllWebSessionsForSubject } from './websessions.js';
import {
  authorize,
  visibleScopes,
  isInstanceAdmin,
  actionableProjectIds,
  actionableUnitIds,
} from './authorization.js';
import { isReservedSubject } from './auth.js';
import { SSO_ADMIN_ROLE_ID } from './types.js';
import { sendJson } from './httpio.js';
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
} from './types.js';

// ---------------------------------------------------------------------------
// Identity Orchestrator + Portal (sdd_host)
//
// The identity control-plane workflows: authenticate the caller credential
// (bootstrap master or user-bound token) via the auth specialist, resolve the
// caller's permission through the authorization seam, then manage user-bound
// MCP/API tokens, hosted users, and audit access. Exported as plain functions so
// both the HTTP identity portal (handleIdentityRequest, below) and any
// in-process caller reach the same logic — mirroring admin.ts. Every audit
// append is best-effort: an append failure is recorded as a server diagnostic
// and never fails the primary action.
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
  /** The token's project NARROWING (which projects it may name), or ['*'] for
   *  the owner's full accessible set. NOT a grant: the token acts as the OWNER's
   *  live permission, resolved fresh on every request. */
  projects?: string[];
  /** Optional ISO-8601 token expiry. */
  expiresAt?: string;
}

// Error classes moved to errors.ts (breaking the identity↔policy import cycle);
// imported for local use and re-exported so existing importers keep working.
import { UnauthenticatedError, ForbiddenError } from './errors.js';
export { UnauthenticatedError, ForbiddenError };

// ── authorization helpers (hierarchical resolver) ───────────────────────────
//
// Every decision resolves through the authorization seam (authorization.ts):
// user administration = project:admin over the target user's home unit; audit
// reads = project:admin over the caller's actionable projects; IdP config and
// audit administration = project:admin at the instance root. isInstanceAdmin is
// the env-anchored resolver bypass (built-in super-admin / master / devMode
// subject) — a delegated instance-wide project:admin is NOT instanceAdmin.

/** The capability the legacy user:admin / audit:read / key:manage / grant
 *  permissions all map onto. */
const PROJECT_ADMIN_CAPABILITY = 'project:admin';
const PROJECT_READ_CAPABILITY = 'project:read';
const PROJECT_WRITE_CAPABILITY = 'project:write';

/** Require a yes-valued project:admin at the instance root (a delegated
 *  instance-wide admin passes; an instance-admin bypasses). */
function requireInstanceProjectAdmin(cfg: HostConfig, principal: Principal, what: string): void {
  if (authorize(cfg.dataDir, principal, PROJECT_ADMIN_CAPABILITY, 'instance', '').value !== 'yes') {
    throw new ForbiddenError(`${what} requires instance-level project:admin`);
  }
}

/** Require a yes-valued project:admin over a user's home unit — a user with no
 *  home unit resolves at the instance root (manageable only by an instance-level
 *  admin, fail closed). */
function requireAdminOverHomeUnit(cfg: HostConfig, principal: Principal, unitId: string | undefined): void {
  const kind = unitId ? 'unit' : 'instance';
  if (authorize(cfg.dataDir, principal, PROJECT_ADMIN_CAPABILITY, kind, unitId ?? '').value !== 'yes') {
    throw new ForbiddenError("user administration requires project:admin over the target user's home unit");
  }
}

/** Reject a user/owner id that claims a reserved built-in subject id (the
 *  persisted boot-reserved UUIDs or the legacy 'builtin:*' literals) — an
 *  admin-created record must never inherit the built-in bypass. */
function assertNotReservedSubjectId(cfg: HostConfig, ids: (string | undefined)[]): void {
  for (const id of ids) {
    if (id && isReservedSubject(cfg.dataDir, id)) {
      throw new ForbiddenError('the built-in subject ids are reserved and can never be claimed by a user record or token owner');
    }
  }
}

/** True when the verified groups intersect the provider's adminGroupClaims (an
 *  unset or empty adminGroupClaims never matches). Exported for the web plane. */
export function isInAdminGroup(provider: IdentityProviderConfig, groups: string[]): boolean {
  const claims = provider.adminGroupClaims ?? [];
  return claims.length > 0 && groups.some((g) => claims.includes(g));
}

/** True when the caller resolves a yes-valued project:admin at the instance
 *  root — the env-anchored bypass OR a delegated instance-wide admin. Grants
 *  instance-WIDE visibility for listings/audit (delegated admins administer the
 *  whole instance even though their authority stays overridable). */
function hasInstanceProjectAdmin(cfg: HostConfig, principal: Principal): boolean {
  if (isInstanceAdmin(principal)) return true;
  return authorize(cfg.dataDir, principal, PROJECT_ADMIN_CAPABILITY, 'instance', '').value === 'yes';
}

/** The caller's audit-read view: an instance-level admin reads instance-wide;
 *  otherwise the ACTIONABLE projects of their project:admin visibility view. */
function auditReadView(cfg: HostConfig, principal: Principal): { all: boolean; projectIds: string[] } {
  if (hasInstanceProjectAdmin(cfg, principal)) return { all: true, projectIds: [] };
  return {
    all: false,
    projectIds: actionableProjectIds(visibleScopes(cfg.dataDir, principal, PROJECT_ADMIN_CAPABILITY)),
  };
}

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
export const ANONYMOUS_SSO_ACTOR: PrincipalSubject = { userId: 'anonymous', kind: 'service', issuer: 'local' };

/** Build a redacted audit event for an actor SUBJECT directly (category 'auth'),
 *  for the unauthenticated SSO login pair (start/complete) which carries no
 *  Principal. Mirrors buildAuditEvent but takes the resolved subject as the actor.
 *  Exported so the web plane (web.ts) builds its web sign-in / sign-out events. */
export function buildSsoAuditEvent(
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
 *  diagnostic and swallowed so an append can never fail the primary action.
 *  Exported so the web plane (web.ts) reuses the same best-effort append path. */
export function tryAppendAudit(cfg: HostConfig, event: AuditEvent): void {
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

/**
 * Gather the audit events the caller may read for `query`, constrained to their
 * audit-read view. An instance-admin reads instance-wide. A scoped caller reads
 * only events tagged with one of their actionable project ids: the audit query
 * carries a single projectId, so a caller-supplied projectId is intersected with
 * the in-view set (an out-of-view filter yields nothing) and an unfiltered read
 * runs the query once per in-view project and merges. Events with no projectId
 * (instance-level) are never surfaced to a scoped caller. The result is ordered
 * newest-first and the query's limit is applied to the merge, so a scoped caller
 * can NEVER see an out-of-view project's events.
 */
function scopedAuditEvents(
  cfg: HostConfig,
  view: { all: boolean; projectIds: string[] },
  query: AuditQuery,
): AuditEvent[] {
  if (view.all) return repoQueryAuditEvents(cfg.dataDir, query);

  const inScope = new Set(view.projectIds);
  const targets =
    query.projectId !== undefined
      ? inScope.has(query.projectId)
        ? [query.projectId]
        : []
      : view.projectIds;

  // Query per in-scope project without the limit, then merge, order newest-first,
  // and apply the limit globally so the top-N is correct across projects.
  const { limit, ...rest } = query;
  const merged: AuditEvent[] = [];
  for (const projectId of targets) {
    merged.push(...repoQueryAuditEvents(cfg.dataDir, { ...rest, projectId }));
  }
  merged.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return limit !== undefined && limit >= 0 ? merged.slice(0, limit) : merged;
}

/** Authenticate the caller credential or throw (401-mapping). */
function requirePrincipal(cfg: HostConfig, credential: string | null): Principal {
  const principal = authenticateCredential(cfg.dataDir, credential);
  if (!principal.authenticated) throw new UnauthenticatedError();
  return principal;
}

// ── orchestrator methods ────────────────────────────────────────────────────

/**
 * Authenticate the caller and require INSTANCE-ADMIN. A minted token carries NO
 * permissions of its own — it acts as its OWNER's LIVE permission, resolved
 * fresh on every request — so minting for another user is confused-deputy
 * territory: a delegated admin could otherwise mint a token whose live authority
 * exceeds their own. Only the instance super-admin (who dominates every owner)
 * may mint here; delegated minting-with-dominance is deferred. Rejects a
 * reserved owner id (the built-in subjects can never own a mintable bearer), a
 * deactivated owner (deactivation must stay revoked), and unknown projects in
 * the narrowing. Persists only the hashed record with owner/narrowing metadata
 * and appends a redacted audit event. Returns the plaintext token exactly once.
 */
export function mintToken(cfg: HostConfig, credential: string | null, request: TokenMintRequest): string {
  const principal = requirePrincipal(cfg, credential);

  if (!isInstanceAdmin(principal)) {
    throw new ForbiddenError('minting a token for another user requires the instance admin');
  }

  // Reserved-subject guard: a token owned by a built-in subject id would BE an
  // instance-admin bearer — the env-anchored paths are the only super-admin routes.
  assertNotReservedSubjectId(cfg, [request.ownerUserId]);

  // The token's project NARROWING (never a grant): which projects it may name.
  // ['*'] (or omitted) = the owner's full accessible set, still resolved live.
  const projects = request.projects?.length ? request.projects : ['*'];
  const knownProjects = new Set(listProjectRecords(cfg.dataDir).map((p) => p.id));
  for (const p of projects) {
    if (p !== '*' && !knownProjects.has(p)) {
      throw new Error(`unknown project "${p}"`);
    }
  }

  // Refuse minting a token for a user record that has been deactivated — else
  // deactivation could be undone by minting fresh tokens for the inactive owner.
  // A token's owner id can be EITHER a record id or the record's subject.userId
  // (they diverge for admin-created users), so resolve by both — matching the
  // revocation sweep — or the guard is dodgeable with the other id. A
  // request.ownerUserId with no user record (a service principal) is allowed.
  const owner =
    getUserById(cfg.dataDir, request.ownerUserId) ??
    repoListUsers(cfg.dataDir).find((u) => u.subject?.userId === request.ownerUserId) ??
    null;
  if (owner && owner.status !== 'active') {
    throw new ForbiddenError('cannot mint a token for a deactivated user');
  }

  // Mint the token and compute its salted hash. The record carries the owner's
  // REAL subject when a user record exists (so the deactivation sweep and the
  // live permission resolution key on the same identity), else a synthesized
  // service identity for a record-less service principal.
  const token = 'wk_' + crypto.randomBytes(24).toString('hex');
  const record: ApiKeyRecord = {
    id: crypto.randomBytes(6).toString('hex'),
    keyHash: hashToken(token),
    projects,
    createdAt: new Date().toISOString(),
    ownerSubject: owner?.subject ?? { userId: request.ownerUserId, kind: 'service', issuer: 'local' },
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
 * Authenticate the caller and require INSTANCE-ADMIN, revoke the credential
 * record, and append a redacted audit event. (Self-revocation of one's OWN
 * tokens rides revokeSelfToken; this is the administrative kill switch.)
 */
export function revokeToken(cfg: HostConfig, credential: string | null, tokenId: string): void {
  const principal = requirePrincipal(cfg, credential);

  if (!isInstanceAdmin(principal)) {
    throw new ForbiddenError('revoking another user\'s token requires the instance admin');
  }

  revokeCredential(cfg.dataDir, tokenId);

  tryAppendAudit(
    cfg,
    buildAuditEvent(principal, 'token.revoke', 'security', 'admin', { target: tokenId }),
  );
}

// ── self-service single-project token lifecycle (owned by the caller) ─────────
//
// mintSelfToken / listSelfTokens / revokeSelfToken are the USER-facing counterpart
// to the admin mintToken/revokeToken delegation path. They are SELF-scoped: a caller
// mints, lists, and revokes only their OWN tokens, so no key:manage is required or
// consulted. Crucially, the minted token is OWNED by the caller (ownerSubject = the
// caller's subject), which is what makes deactivation cut it off — setUserStatus's
// revokeAllForOwner sweep matches on ownerSubject.userId. The token stays a SEPARATE
// credential from the caller's login session (its own ApiKeyRecord), never a share.

/**
 * Self-service single-project MCP token mint. Authenticate the caller (a ws_ session
 * or bearer token) to their principal; require the caller's OWN resolved permission
 * to already cover project:read on projectId (and project:write when write) — the
 * token can never exceed the caller's own access at mint time, and it acts as the
 * OWNER's LIVE permission afterwards. Mint a token OWNED BY the caller
 * (ownerSubject AND createdBySubject = the caller's subject, so deactivating the
 * caller revokes it via revokeAllForOwner) NARROWED to exactly one project, persist
 * only its hashed record, append a best-effort token.mint.self (security) audit
 * event, and return the plaintext once.
 */
export function mintSelfToken(
  cfg: HostConfig,
  credential: string | null,
  projectId: string,
  write: boolean,
): string {
  const principal = requirePrincipal(cfg, credential);

  // Self-scoped authorization through the resolver: the caller must ALREADY hold
  // a yes-valued permission over this exact project (a unit-scoped assignment
  // covers its own subtree, never another tenant's).
  if (authorize(cfg.dataDir, principal, PROJECT_READ_CAPABILITY, 'project', projectId).value !== 'yes') {
    throw new ForbiddenError('caller lacks project:read on the requested project');
  }
  if (write && authorize(cfg.dataDir, principal, PROJECT_WRITE_CAPABILITY, 'project', projectId).value !== 'yes') {
    throw new ForbiddenError('caller lacks project:write on the requested project');
  }

  // Mint the token owned by the caller, NARROWED to exactly the one project. It
  // stores no permissions: the data-plane gate resolves the owner's live
  // permission per request, so revoking the owner's access cuts the token off.
  const token = 'wk_' + crypto.randomBytes(24).toString('hex');
  const owner = auditActor(principal);
  const record: ApiKeyRecord = {
    id: crypto.randomBytes(6).toString('hex'),
    keyHash: hashToken(token),
    projects: [projectId],
    createdAt: new Date().toISOString(),
    ownerSubject: owner,
    createdBySubject: owner,
    label: `agent token (${projectId})`,
  };
  createCredential(cfg.dataDir, record);

  tryAppendAudit(
    cfg,
    buildAuditEvent(principal, 'token.mint.self', 'security', 'admin', { target: record.id }),
  );

  return token; // plaintext, shown exactly once
}

/**
 * Authenticate the caller and return their OWN minted credential records
 * (ownerSubject.userId = caller) through the credential registry, redacted — each
 * carries the hashed token only (the plaintext is never stored), with its id,
 * project, label, createdAt and revokedAt for the client to render and offer revoke.
 * A read; not audited.
 */
export function listSelfTokens(cfg: HostConfig, credential: string | null): ApiKeyRecord[] {
  const principal = requirePrincipal(cfg, credential);
  return listByOwner(cfg.dataDir, auditActor(principal).userId);
}

/**
 * Authenticate the caller, confirm tokenId is among the caller's OWN tokens
 * (ownerSubject.userId = caller) — a token the caller does not own is rejected as
 * not found, so there is no cross-user revocation and no key:manage escalation —
 * then revoke it through the credential registry and append a best-effort
 * token.revoke.self (security) audit event.
 */
export function revokeSelfToken(cfg: HostConfig, credential: string | null, tokenId: string): void {
  const principal = requirePrincipal(cfg, credential);

  const own = listByOwner(cfg.dataDir, auditActor(principal).userId);
  if (!own.some((r) => r.id === tokenId)) {
    throw new Error(`token "${tokenId}" not found`);
  }

  revokeCredential(cfg.dataDir, tokenId);

  tryAppendAudit(
    cfg,
    buildAuditEvent(principal, 'token.revoke.self', 'security', 'admin', { target: tokenId }),
  );
}

/**
 * Authenticate the caller, authorize user administration via project:admin over
 * the caller's actionable units, and list hosted users FILTERED to that view: an
 * instance-admin sees all, a scoped caller sees only users whose home unit is
 * within their actionable units (a user with no home unit is visible only to an
 * instance-admin). The optional project filter narrows to users holding a DIRECT
 * assignment at that project scope — resolved HERE from the permission grid,
 * since user records carry no project reference of their own (the user store
 * owns no project filter). No audit event (a read).
 */
export function listUsers(
  cfg: HostConfig,
  credential: string | null,
  project?: string,
): HostedUserRecord[] {
  const principal = requirePrincipal(cfg, credential);
  // The grid answers project membership: users holding a DIRECT assignment at
  // that exact project scope.
  const narrowToProject = (users: HostedUserRecord[]): HostedUserRecord[] => {
    if (!project) return users;
    const holders = new Set(
      listAssignments(cfg.dataDir, [project], 'user')
        .map((a) => a.subjectId)
        .filter((id): id is string => id !== undefined),
    );
    return users.filter((u) => holders.has(u.id));
  };
  // An instance-level admin (bypass OR delegated) sees every user, including
  // no-home-unit users a unit filter could never surface.
  if (hasInstanceProjectAdmin(cfg, principal)) {
    return narrowToProject(repoListUsers(cfg.dataDir));
  }
  const units = new Set(actionableUnitIds(visibleScopes(cfg.dataDir, principal, PROJECT_ADMIN_CAPABILITY)));
  if (units.size === 0) {
    throw new ForbiddenError('user administration requires project:admin over at least one unit');
  }
  const users = narrowToProject(repoListUsers(cfg.dataDir));
  return users.filter((u) => u.unitId !== undefined && units.has(u.unitId));
}

/**
 * Authenticate the caller, authorize audit read access via project:admin (the
 * capability the legacy audit:read maps onto), and return redacted audit events
 * matching the query FILTERED to the caller's view: an instance-admin reads
 * instance-wide, a scoped caller reads only their actionable projects' events.
 * No audit event (a read).
 */
export function queryAuditEvents(
  cfg: HostConfig,
  credential: string | null,
  query: AuditQuery,
): AuditEvent[] {
  const principal = requirePrincipal(cfg, credential);
  const view = auditReadView(cfg, principal);
  if (!view.all && view.projectIds.length === 0) {
    throw new ForbiddenError('audit read access requires project:admin over at least one project');
  }
  return scopedAuditEvents(cfg, view, query);
}

/**
 * Authenticate the caller, require instance-level project:admin, apply the active
 * retention policy, append a redacted audit event for the prune itself, and return
 * the number of events removed.
 */
export function pruneAuditEvents(cfg: HostConfig, credential: string | null): number {
  const principal = requirePrincipal(cfg, credential);
  requireInstanceProjectAdmin(cfg, principal, 'audit administration');

  const policy = resolveAuditPolicy(cfg);
  const removed = repoPruneAuditEvents(cfg.dataDir, policy, new Date().toISOString());

  tryAppendAudit(cfg, buildAuditEvent(principal, 'audit.prune', 'info', 'audit', { target: 'audit' }));

  return removed;
}

/**
 * Authenticate the caller, resolve the caller's project:admin permission over the
 * target user's home unit (both the incoming record's and, on update, the
 * existing record's — a user with no home unit resolves at the instance root),
 * REJECT a record claiming a reserved built-in subject id (the persisted
 * boot-reserved UUIDs or the legacy 'builtin:*' literals — an admin-created user
 * must never inherit the built-in bypass), create or update the hosted user
 * through the repository, and append a redacted audit event distinguishing
 * creation from update. User PERMISSIONS live in roleBindings + the assignment
 * grid, never on the record.
 */
export function upsertUser(
  cfg: HostConfig,
  credential: string | null,
  record: HostedUserRecord,
): HostedUserRecord {
  const principal = requirePrincipal(cfg, credential);

  // Distinguish creation from update, and read the existing home unit, by probing
  // for an existing record first.
  const existing = getUserById(cfg.dataDir, record.id);
  const existed = existing !== null;

  // The caller must cover the incoming record's home unit — and, on an update
  // that involves a different existing home unit, that one too (else a scoped
  // admin could capture a foreign user by rewriting their unit).
  requireAdminOverHomeUnit(cfg, principal, record.unitId);
  if (existed && existing!.unitId !== record.unitId) {
    requireAdminOverHomeUnit(cfg, principal, existing!.unitId);
  }

  // Reserved-subject guard: neither the record id nor its subject id may claim a
  // built-in identity (UUID = unguessable, this guard = unclaimable).
  assertNotReservedSubjectId(cfg, [record.id, record.subject?.userId]);

  const action = existed ? 'user.update' : 'user.create';

  const stored = repoUpsertUser(cfg.dataDir, record);

  tryAppendAudit(cfg, buildAuditEvent(principal, action, 'info', 'admin', { target: record.id }));

  return stored;
}

/**
 * Authenticate the caller, require a user-administration instance grant, set the
 * user's lifecycle status through the repository, and — when the change deactivates
 * the user (any non-'active' status) — revoke every one of the user's non-revoked
 * credentials so existing tokens can no longer authenticate, auditing a
 * security-level user.deactivate (with the revoked-token count) rather than the
 * info-level user.status.set. Returning to 'active' does not restore revoked tokens.
 */
export function setUserStatus(
  cfg: HostConfig,
  credential: string | null,
  userId: string,
  status: string,
): HostedUserRecord {
  const principal = requirePrincipal(cfg, credential);

  // Look up the target to read its home unit (and separate not-found from a
  // permission denial). The caller must cover the target's home unit; a user
  // with no home unit resolves at the instance root (instance-level admins only).
  const existing = getUserById(cfg.dataDir, userId);
  if (existing === null) {
    throw new Error(`Hosted user "${userId}" not found.`);
  }
  requireAdminOverHomeUnit(cfg, principal, existing.unitId);

  const updated = repoSetUserStatus(cfg.dataDir, userId, status);

  // Deactivation (any non-'active' status) cuts off the user's existing access:
  // revoke every one of their non-revoked credentials at the credential layer so
  // authenticate() rejects them. Returning to 'active' does NOT restore tokens.
  const deactivating = status !== 'active';
  // Sweep by every id a credential could be owned under: the record id AND the
  // resolved subject id (they diverge for admin-created users whose id != the
  // subject's userId), so revocation can't silently miss anything.
  let revokedTokens = 0;
  let revokedSessions = 0;
  if (deactivating) {
    const ownerIds = new Set([userId]);
    if (updated.subject?.userId) ownerIds.add(updated.subject.userId);
    for (const ownerId of ownerIds) {
      revokedTokens += revokeAllForOwner(cfg.dataDir, ownerId);
      // Browser web sessions are a SEPARATE credential store the data-plane auth
      // bridge accepts (a ws_ cookie drives /mcp like a bearer). Deactivation must
      // sweep them too, or a deactivated user keeps a live session until it expires.
      revokedSessions += removeAllWebSessionsForSubject(cfg.dataDir, ownerId);
    }
  }

  const event = deactivating
    ? buildAuditEvent(principal, 'user.deactivate', 'security', 'admin', {
        target: userId,
        metadata: JSON.stringify({ revokedTokens, revokedSessions }),
      })
    : buildAuditEvent(principal, 'user.status.set', 'info', 'admin', { target: userId });
  tryAppendAudit(cfg, event);

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

/** The signed SSO state payload bound on start and re-derived on completion.
 *  Exported so the web plane (web.ts) signs/verifies the identical payload shape. */
export interface SsoStatePayload {
  providerId: string;
  nonce: string;
  redirectUri: string;
}

/** Resolve one ENABLED identity provider by id, or throw a login-rejecting error
 *  (unknown id or a disabled provider both reject identically). Exported so the
 *  web plane (web.ts) reuses the exact same provider resolution + rejection. */
export function resolveEnabledProvider(cfg: HostConfig, providerId: string): IdentityProviderConfig {
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
export async function startSsoLogin(cfg: HostConfig, providerId: string, redirectUri: string): Promise<string> {
  const provider = resolveEnabledProvider(cfg, providerId);

  const nonce = crypto.randomBytes(16).toString('hex');
  const payload: SsoStatePayload = { providerId, nonce, redirectUri };
  const state = signSsoState(JSON.stringify(payload));
  // Resolve the provider's concrete OIDC endpoints (overrides -> discovery ->
  // template), then build the authorization URL against the front-channel endpoint.
  const endpoints = await resolveEndpoints(provider);
  const url = buildAuthorizationUrl(provider, endpoints, state, redirectUri);

  tryAppendAudit(cfg, buildSsoAuditEvent(ANONYMOUS_SSO_ACTOR, 'sso.start', 'info', { target: providerId }));

  return url;
}

/**
 * Complete a headless SSO login: verify the signed state (tampered/expired is
 * rejected), resolve the bound enabled provider, exchange the code and resolve the
 * external subject, look up the hosted user by issuer + external subject, provision
 * a first-login active user when absent (binding the built-in sso-admin role when
 * the verified groups match adminGroupClaims, and recording displayName/email from
 * the verified claims), reject re-login for an existing deactivated user before
 * minting, refresh the sso-admin binding + claims on re-login, mint a user-bound
 * token (acting as the owner's LIVE permission) persisting only its hashed record,
 * append a best-effort sso.login (security) audit event, and return the plaintext
 * token exactly once. Unauthenticated by nature — no caller credential.
 */
export async function completeSsoLogin(cfg: HostConfig, state: string, code: string): Promise<string> {
  // Verify + parse the signed state (throws on a tampered or expired state).
  const payload = JSON.parse(verifySsoState(state)) as SsoStatePayload;
  const { providerId, redirectUri } = payload;

  const provider = resolveEnabledProvider(cfg, providerId);

  // Resolve the provider endpoints (front-channel authorize + back-channel
  // token/jwks), then exchange the code (network I/O) and verify+resolve the
  // external subject against the provider JWKS, never leaking raw provider tokens.
  const endpoints = await resolveEndpoints(provider);
  const summary = await exchangeCode(provider, endpoints, code, redirectUri);
  const subject = await resolveSubject(provider, endpoints, summary);

  // steps 10–11: the groups claim is read from the SAME summary resolveSubject
  // just verified, then intersected with the provider's adminGroupClaims.
  const groups = resolveGroups(summary);
  const inAdminGroup = isInAdminGroup(provider, groups);

  // Look up the hosted user by issuer + external subject; provision on first login.
  let user = repoFindUserByExternalSubject(cfg.dataDir, subject.issuer, subject.externalSubject ?? '');
  if (!user) {
    const provisioned: HostedUserRecord = {
      id: subject.userId,
      subject,
      status: 'active',
      // first-login: bind the built-in sso-admin ROLE when the verified groups
      // match adminGroupClaims, otherwise no bindings — an admin assigns roles
      // and grid assignments later. The role resolves through the permission
      // resolver (project:admin + project:create @instance, OVERRIDABLE — never
      // the instance-admin bypass).
      roleBindings: inAdminGroup ? [{ roleId: SSO_ADMIN_ROLE_ID }] : [],
      createdAt: new Date().toISOString(),
      // displayName/email come from the VERIFIED id_token claims (resolveSubject),
      // so admin views can show a name instead of the opaque subject id.
      ...(subject.displayName ? { displayName: subject.displayName } : {}),
      ...(subject.email ? { email: subject.email } : {}),
    };
    user = repoUpsertUser(cfg.dataDir, provisioned);
  }

  // Reject re-login for a deactivated user before minting. A freshly provisioned
  // first-login record is always active, so only an existing deactivated user is
  // rejected here — deactivation blocks SSO re-login as well as revoking tokens.
  if (user.status !== 'active') {
    throw new ForbiddenError('deactivated user may not sign in');
  }

  // steps 18–19: refresh the sso-admin ROLE BINDING when it disagrees with the
  // verified admin-group membership — entering the group binds the role, leaving
  // it unbinds it on this login (server-driven, straight through the repository) —
  // and refresh displayName/email from the verified claims on every re-login.
  const bindings = user.roleBindings ?? [];
  const hasSsoAdmin = bindings.some((b) => b.roleId === SSO_ADMIN_ROLE_ID);
  const identityDrifted =
    (subject.displayName !== undefined && subject.displayName !== user.displayName) ||
    (subject.email !== undefined && subject.email !== user.email);
  if (hasSsoAdmin !== inAdminGroup || identityDrifted) {
    user = repoUpsertUser(cfg.dataDir, {
      ...user,
      roleBindings: inAdminGroup
        ? hasSsoAdmin
          ? bindings
          : [...bindings, { roleId: SSO_ADMIN_ROLE_ID }]
        : bindings.filter((b) => b.roleId !== SSO_ADMIN_ROLE_ID),
      ...(subject.displayName ? { displayName: subject.displayName } : {}),
      ...(subject.email ? { email: subject.email } : {}),
    });
  }

  // Mint a user-bound token (same record shape as mintToken). It carries NO
  // permissions and no narrowing: it acts as the owner's LIVE permission,
  // resolved by the auth specialist + resolver on every request — so a later
  // role/assignment revocation cuts this token down immediately.
  const token = 'wk_' + crypto.randomBytes(24).toString('hex');
  const record: ApiKeyRecord = {
    id: crypto.randomBytes(6).toString('hex'),
    keyHash: hashToken(token),
    projects: ['*'],
    createdAt: new Date().toISOString(),
    ownerSubject: user.subject,
    createdBySubject: user.subject,
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
 * Authenticate the caller, require instance-level project:admin, and return every
 * configured identity provider by forwarding to the policy repository. Not audited
 * (a read).
 */
export function listIdentityProviders(
  cfg: HostConfig,
  credential: string | null,
): IdentityProviderConfig[] {
  const principal = requirePrincipal(cfg, credential);
  requireInstanceProjectAdmin(cfg, principal, 'identity-provider administration');
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
  requireInstanceProjectAdmin(cfg, principal, 'identity-provider administration');

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
  requireInstanceProjectAdmin(cfg, principal, 'identity-provider administration');

  removeIdentityProviderRecord(cfg.dataDir, id);

  tryAppendAudit(cfg, buildAuditEvent(principal, 'idp.remove', 'security', 'auth', { target: id }));
}

/**
 * Authenticate the caller, authorize audit read access via project:admin (same
 * authorization as queryAuditEvents), and return the count of redacted audit
 * events matching the query SCOPED to the caller: an instance-admin counts
 * instance-wide, a scoped caller counts only their actionable projects' events.
 * No audit event (a read).
 */
export function countAuditEvents(
  cfg: HostConfig,
  credential: string | null,
  query: AuditQuery,
): number {
  const principal = requirePrincipal(cfg, credential);
  const view = auditReadView(cfg, principal);
  if (!view.all && view.projectIds.length === 0) {
    throw new ForbiddenError('audit read access requires project:admin over at least one project');
  }
  if (view.all) return repoCountAuditEvents(cfg.dataDir, query);
  // A count ignores the query limit; scope the query to the in-view projects.
  return scopedAuditEvents(cfg, view, { ...query, limit: undefined }).length;
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
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['identity', ...]
  try {
    // ── headless SSO login (unauthenticated: no credential) ──────────────────
    // POST /identity/sso/start  { providerId, redirectUri }
    if (req.method === 'POST' && parts.length === 3 && parts[1] === 'sso' && parts[2] === 'start') {
      const url_ = await startSsoLogin(cfg, body.providerId as string, body.redirectUri as string);
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
