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
  revokeAllForOwner,
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
import { listOrganizationUnits } from './organization.js';
import { resolveScopeFor, permits } from './scope.js';
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
  ScopeResolution,
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

/** True when the caller may delegate every grant in `grants` — for each grant,
 *  the caller must hold each of its permissions over that grant's scope (a
 *  unit-scoped grant → the unit is in the caller's scope for that permission; a
 *  project grant → the project is). A '*' projectId requires instance-admin.
 *  Super-admin delegates anything. Shared by mintToken and replaceUserGrants so
 *  neither can hand out authority the caller doesn't itself hold. */
function callerMayDelegateGrants(cfg: HostConfig, principal: Principal, grants: ProjectGrant[]): boolean {
  if (isInstanceAdmin(principal)) return true;
  const memo = new Map<string, ScopeResolution>();
  const scopeFor = (permission: string): ScopeResolution => {
    let s = memo.get(permission);
    if (s === undefined) {
      s = resolveScopeFor(cfg, principal, permission);
      memo.set(permission, s);
    }
    return s;
  };
  const covers = (g: ProjectGrant, p: string): boolean => {
    const s = scopeFor(p);
    if (s.all) return true;
    if (g.orgUnitId !== undefined && g.orgUnitId !== '') return s.unitIds.includes(g.orgUnitId);
    return permits(s, g.projectId);
  };
  return grants.every((g) => (g.projectId === '*' ? false : g.permissions.every((p) => covers(g, p))));
}

// Phase 6 scoped administration: an instance-wide ('*') grant carrying the
// permission resolves to scope.all (super-admin); a UNIT-scoped grant carrying
// it resolves to that unit subtree's projects+units; a specific-project grant
// resolves to just that project. A caller with neither an in-scope project nor
// an in-scope unit (and not super-admin) has no authority and is denied outright.
function scopeIsEmpty(scope: ScopeResolution): boolean {
  return !scope.all && scope.projectIds.length === 0 && scope.unitIds.length === 0;
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

/**
 * Gather the audit events the caller may read for `query`, constrained to their
 * resolved audit:read scope. A super-admin (scope.all) reads instance-wide. A
 * scoped caller reads only events tagged with one of their in-scope project ids:
 * the audit query carries a single projectId, so a caller-supplied projectId is
 * intersected with the in-scope set (an out-of-scope filter yields nothing) and
 * an unfiltered read runs the query once per in-scope project and merges. Events
 * with no projectId (instance-level) are never surfaced to a scoped caller. The
 * result is ordered newest-first and the query's limit is applied to the merge,
 * so a scoped caller can NEVER see an out-of-scope project's events.
 */
function scopedAuditEvents(cfg: HostConfig, scope: ScopeResolution, query: AuditQuery): AuditEvent[] {
  if (scope.all) return repoQueryAuditEvents(cfg.dataDir, query);

  const inScope = new Set(scope.projectIds);
  const targets =
    query.projectId !== undefined
      ? inScope.has(query.projectId)
        ? [query.projectId]
        : []
      : scope.projectIds;

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
 * Authenticate the caller, then authorize token delegation strictly against the
 * caller's OWN scope: instance-admin may delegate anything; otherwise, for every
 * requested grant the caller must hold BOTH key:manage AND each requested
 * permission for the target project (so callers only delegate what they hold),
 * AND — expanding the caller's unit-scoped grants across each unit's recursive
 * subtree — the caller's resolved scope for every requested permission must cover
 * the grant's target (its specific projectId, or its orgUnitId, or a super-admin
 * scope). Validate the requested projects/units exist, mint a user-bound token,
 * persist only its hashed record with owner/grant metadata, and append a redacted
 * audit event. Returns the plaintext token exactly once.
 */
export function mintToken(cfg: HostConfig, credential: string | null, request: TokenMintRequest): string {
  const principal = requirePrincipal(cfg, credential);

  const admin = isInstanceAdmin(principal);
  const grants = request.grants ?? [];
  // A grant carrying no permissions is malformed: it would still project to an
  // editor token for the project (compatibility projection), so an empty
  // permissions[] must NOT vacuously pass the delegation check below.
  if (grants.some((g) => g.projectId !== '*' && (g.permissions?.length ?? 0) === 0)) {
    throw new ForbiddenError('each requested grant must carry at least one permission');
  }

  // Resolve the caller's own scope per permission once (org data is gathered
  // inside resolveScopeFor); a requested grant's target is delegable for a
  // permission only when the caller is super-admin for it, the requested
  // projectId is in that scope, or the requested orgUnitId is in that scope.
  const scopeMemo = new Map<string, ScopeResolution>();
  const callerScope = (permission: string): ScopeResolution => {
    let s = scopeMemo.get(permission);
    if (s === undefined) {
      s = resolveScopeFor(cfg, principal, permission);
      scopeMemo.set(permission, s);
    }
    return s;
  };
  const scopeCovers = (grant: ProjectGrant, permission: string): boolean => {
    const s = callerScope(permission);
    if (s.all) return true;
    if (grant.orgUnitId !== undefined && grant.orgUnitId !== '') {
      return s.unitIds.includes(grant.orgUnitId);
    }
    return permits(s, grant.projectId);
  };

  // Instance-admin may delegate anything; otherwise, for every requested grant
  // the caller must hold key:manage AND each permission for the project (S5), and
  // that permission's resolved scope must cover the grant's target. An
  // instance-wide ('*') delegation still requires instance-admin.
  const mayDelegate =
    admin ||
    grants.every((g) =>
      g.projectId === '*'
        ? admin
        : coversPermission(principal, g.projectId, KEY_MANAGE_PERMISSION) &&
          g.permissions.every((p) => coversPermission(principal, g.projectId, p)) &&
          g.permissions.every((p) => scopeCovers(g, p)),
    );
  if (!mayDelegate) {
    throw new ForbiddenError('caller may not delegate the requested grants');
  }

  // Validate every referenced target exists: a specific projectId among the known
  // hosted projects, and an orgUnitId among the organization units ('*' already
  // gated to instance-admin above).
  const knownProjects = new Set(listProjectRecords(cfg.dataDir).map((p) => p.id));
  const knownUnits = new Set(listOrganizationUnits(cfg.dataDir).map((u) => u.id));
  for (const g of grants) {
    if (g.orgUnitId !== undefined && g.orgUnitId !== '') {
      if (!knownUnits.has(g.orgUnitId)) {
        throw new Error(`unknown organization unit "${g.orgUnitId}"`);
      }
    } else if (g.projectId !== '*' && g.projectId !== '') {
      if (!knownProjects.has(g.projectId)) {
        throw new Error(`unknown project "${g.projectId}"`);
      }
    }
  }

  // Refuse minting a token for a user record that has been deactivated — else
  // deactivation could be undone by an authorized delegator minting fresh tokens
  // for the inactive owner. A token's owner id can be EITHER a record id or the
  // record's subject.userId (they diverge for admin-created users), so resolve
  // by both — matching the revocation sweep — or the guard is dodgeable with the
  // other id. A request.ownerUserId with no user record (a service principal) is
  // allowed.
  const owner =
    getUserById(cfg.dataDir, request.ownerUserId) ??
    repoListUsers(cfg.dataDir).find((u) => u.subject?.userId === request.ownerUserId) ??
    null;
  if (owner && owner.status !== 'active') {
    throw new ForbiddenError('cannot mint a token for a deactivated user');
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
 * Authenticate the caller, authorize grant administration by an instance-wide OR
 * unit-scoped user:admin grant: the caller's scope must permit the target user's
 * home unit, and — the privilege-escalation guard — a non-super-admin caller may
 * not assign grants exceeding its own authority (no instance-wide '*', no org unit
 * or project outside its scope). Replace the user's grants wholesale through the
 * repository, and append a redacted audit event. A super-admin bypasses both checks.
 */
export function replaceUserGrants(
  cfg: HostConfig,
  credential: string | null,
  userId: string,
  grants: ProjectGrant[],
): HostedUserRecord {
  const principal = requirePrincipal(cfg, credential);
  const scope = resolveScopeFor(cfg, principal, USER_ADMIN_PERMISSION);

  // Read the target's current home unit (and separate not-found from a scope
  // denial) before authorizing.
  const existing = getUserById(cfg.dataDir, userId);
  if (existing === null) {
    throw new Error(`Hosted user "${userId}" not found.`);
  }

  // (1) Target visibility: a scope.all caller — a true super-admin OR a delegated
  //     instance-wide user:admin — may manage any user. Otherwise the target's
  //     home unit must be in scope (a user with no home unit is super-admin-only).
  if (!scope.all && !(existing.unitId !== undefined && scope.unitIds.includes(existing.unitId))) {
    throw new ForbiddenError("grant administration requires scope over the target user's home unit");
  }

  // (2) Delegation guard: ONLY a genuine super-admin ('*'/'*') may assign
  //     arbitrary authority. A delegated instance-wide user:admin has scope.all
  //     for target VISIBILITY but is NOT omnipotent — it, like every non-admin,
  //     may not assign grants exceeding the authority it itself holds (else it
  //     could self-grant '*' → full admin on next SSO login). Gate on
  //     isInstanceAdmin, matching mintToken (the two must not diverge).
  if (!isInstanceAdmin(principal) && !callerMayDelegateGrants(cfg, principal, grants)) {
    throw new ForbiddenError("grant administration may not assign authority the caller does not itself hold");
  }

  const updated = repoReplaceUserGrants(cfg.dataDir, userId, grants);

  tryAppendAudit(
    cfg,
    buildAuditEvent(principal, 'user.grants.replace', 'security', 'admin', { target: userId }),
  );

  return updated;
}

/**
 * Authenticate the caller, authorize user administration by an instance-wide OR
 * unit-scoped user:admin grant, and list hosted users FILTERED to the caller's
 * scope: a super-admin sees all, a scoped caller sees only users whose home unit
 * is within scope.unitIds (a user with no home unit is visible only to a
 * super-admin). Optionally narrowed to one project's grant holders. No audit
 * event (a read).
 */
export function listUsers(
  cfg: HostConfig,
  credential: string | null,
  project?: string,
): HostedUserRecord[] {
  const principal = requirePrincipal(cfg, credential);
  const scope = resolveScopeFor(cfg, principal, USER_ADMIN_PERMISSION);
  if (scopeIsEmpty(scope)) {
    throw new ForbiddenError('user administration required');
  }
  const users = repoListUsers(cfg.dataDir, undefined, project);
  if (scope.all) return users;
  const inScope = new Set(scope.unitIds);
  return users.filter((u) => u.unitId !== undefined && inScope.has(u.unitId));
}

/**
 * Authenticate the caller, authorize audit read access by an instance-wide OR
 * unit-scoped audit:read grant, and return redacted audit events matching the
 * query FILTERED to the caller's scope: a super-admin reads instance-wide, a
 * scoped caller reads only their in-scope projects' events. No audit event (a read).
 */
export function queryAuditEvents(
  cfg: HostConfig,
  credential: string | null,
  query: AuditQuery,
): AuditEvent[] {
  const principal = requirePrincipal(cfg, credential);
  const scope = resolveScopeFor(cfg, principal, AUDIT_READ_PERMISSION);
  if (scopeIsEmpty(scope)) {
    throw new ForbiddenError('audit read access required');
  }
  return scopedAuditEvents(cfg, scope, query);
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
 * Authenticate the caller, authorize user administration by an instance-wide OR
 * unit-scoped user:admin grant whose scope permits the target user's home unit
 * (both the incoming record's home unit and, on update, the existing record's),
 * create or update the hosted user through the repository, and append a redacted
 * audit event distinguishing creation from update. A super-admin bypasses the
 * home-unit check; a user with no home unit is manageable only by a super-admin.
 */
export function upsertUser(
  cfg: HostConfig,
  credential: string | null,
  record: HostedUserRecord,
): HostedUserRecord {
  const principal = requirePrincipal(cfg, credential);
  const scope = resolveScopeFor(cfg, principal, USER_ADMIN_PERMISSION);

  // Distinguish creation from update, and read the existing home unit, by probing
  // for an existing record first.
  const existing = getUserById(cfg.dataDir, record.id);
  const existed = existing !== null;

  // A scoped (non-super-admin) admin may only manage users within its unit
  // subtree: the incoming record's home unit — and, on update, the existing
  // record's home unit — must both be in scope.
  if (!scope.all) {
    const inScope = new Set(scope.unitIds);
    const incomingInScope = record.unitId !== undefined && inScope.has(record.unitId);
    const existingInScope =
      !existed || (existing!.unitId !== undefined && inScope.has(existing!.unitId));
    if (!incomingInScope || !existingInScope) {
      throw new ForbiddenError("user administration requires scope over the target user's home unit");
    }
  }

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
  const scope = resolveScopeFor(cfg, principal, USER_ADMIN_PERMISSION);

  // Look up the target to read its home unit (and separate not-found from a scope
  // denial). A scoped admin may only act on a user within its unit subtree; a user
  // with no home unit is manageable only by a super-admin.
  const existing = getUserById(cfg.dataDir, userId);
  if (existing === null) {
    throw new Error(`Hosted user "${userId}" not found.`);
  }
  if (!scope.all) {
    const inScope = new Set(scope.unitIds);
    if (existing.unitId === undefined || !inScope.has(existing.unitId)) {
      throw new ForbiddenError("user administration requires scope over the target user's home unit");
    }
  }

  const updated = repoSetUserStatus(cfg.dataDir, userId, status);

  // Deactivation (any non-'active' status) cuts off the user's existing access:
  // revoke every one of their non-revoked credentials at the credential layer so
  // authenticate() rejects them. Returning to 'active' does NOT restore tokens.
  const deactivating = status !== 'active';
  // Sweep by every id a token could be owned under: the record id AND the
  // resolved subject id (they diverge for admin-created users whose id != the
  // subject's userId), so revocation can't silently miss tokens.
  let revokedTokens = 0;
  if (deactivating) {
    const ownerIds = new Set([userId]);
    if (updated.subject?.userId) ownerIds.add(updated.subject.userId);
    for (const ownerId of ownerIds) revokedTokens += revokeAllForOwner(cfg.dataDir, ownerId);
  }

  const event = deactivating
    ? buildAuditEvent(principal, 'user.deactivate', 'security', 'admin', {
        target: userId,
        metadata: JSON.stringify({ revokedTokens }),
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
 * afterwards), reject re-login for an existing deactivated user before minting,
 * mint a user-bound token for the resolved user persisting only its hashed record,
 * append a best-effort sso.login (security) audit event, and return the plaintext
 * token exactly once. Unauthenticated by nature — no caller credential.
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

  // Reject re-login for a deactivated user before minting. A freshly provisioned
  // first-login record is always active, so only an existing deactivated user is
  // rejected here — deactivation blocks SSO re-login as well as revoking tokens.
  if (user.status !== 'active') {
    throw new ForbiddenError('deactivated user may not sign in');
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
 * Authenticate the caller, authorize audit read access by an instance-wide OR
 * unit-scoped audit:read grant (same authorization as queryAuditEvents), and
 * return the count of redacted audit events matching the query SCOPED to the
 * caller: a super-admin counts instance-wide, a scoped caller counts only their
 * in-scope projects' events. No audit event (a read).
 */
export function countAuditEvents(
  cfg: HostConfig,
  credential: string | null,
  query: AuditQuery,
): number {
  const principal = requirePrincipal(cfg, credential);
  const scope = resolveScopeFor(cfg, principal, AUDIT_READ_PERMISSION);
  if (scopeIsEmpty(scope)) {
    throw new ForbiddenError('audit read access required');
  }
  if (scope.all) return repoCountAuditEvents(cfg.dataDir, query);
  // A count ignores the query limit; scope the query to the in-scope projects.
  return scopedAuditEvents(cfg, scope, { ...query, limit: undefined }).length;
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
