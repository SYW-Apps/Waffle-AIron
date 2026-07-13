import { authenticateSession } from './auth.js';
import * as identity from './identity.js';
import * as admin from './admin.js';
import * as organization from './organization.js';
import { appendAuditEvent, DEFAULT_AUDIT_POLICY } from './audit.js';
import { ForbiddenError } from './identity.js';
import type {
  ApiKeyRecord,
  AuditEvent,
  HostConfig,
  HostedUserRecord,
  IdentityProviderConfig,
  OrganizationUnitRecord,
  Principal,
  PrincipalSubject,
  ProjectGrant,
  ProjectPlacement,
  Role,
} from './types.js';

// ---------------------------------------------------------------------------
// Web Admin Orchestrator (sdd_host)
//
// The bridge that exposes the control-plane admin capabilities (user, identity-
// provider/SSO, API-key, and organization-unit management) on the PUBLIC web/data
// plane, so an authenticated admin manages the instance from the single web UI
// instead of the loopback-only admin listener.
//
// Every method carries the browser sessionId. USER / IdP / KEY methods forward
// 1:1 to the existing identity and admin orchestrators PASSING THE SESSION AS THE
// CREDENTIAL — a ws_ session is a first-class data-plane credential that resolves
// to a Principal exactly like a bearer token, so those orchestrators' scope
// authorization and auditing apply UNCHANGED (no new authorization surface).
//
// ORGANIZATION-UNIT reads/writes have no upstream orchestrator, so this component
// owns that workflow directly: resolve the session to a Principal via the auth
// specialist, require an instance-wide admin grant, mutate through the
// organization repository, and append a best-effort audit event.
// ---------------------------------------------------------------------------

// ── user administration (forward to identity_orchestrator) ───────────────────

/** Forward to identity_orchestrator.listUsers with the session as the credential
 *  (its user:admin scope filtering applies). */
export function listUsers(cfg: HostConfig, sessionId: string, project?: string): HostedUserRecord[] {
  return identity.listUsers(cfg, sessionId, project);
}

/** Forward to identity_orchestrator.upsertUser with the session as the credential. */
export function upsertUser(cfg: HostConfig, sessionId: string, record: HostedUserRecord): HostedUserRecord {
  return identity.upsertUser(cfg, sessionId, record);
}

/** Forward to identity_orchestrator.setUserStatus with the session as the credential
 *  (a deactivation revokes the user's tokens and web sessions upstream). */
export function setUserStatus(cfg: HostConfig, sessionId: string, userId: string, status: string): HostedUserRecord {
  return identity.setUserStatus(cfg, sessionId, userId, status);
}

/** Forward to identity_orchestrator.replaceUserGrants with the session as the
 *  credential (privilege-escalation guarded upstream). */
export function replaceUserGrants(
  cfg: HostConfig,
  sessionId: string,
  userId: string,
  grants: ProjectGrant[],
): HostedUserRecord {
  return identity.replaceUserGrants(cfg, sessionId, userId, grants);
}

// ── identity-provider (SSO) administration (forward to identity_orchestrator) ─

/** Forward to identity_orchestrator.listIdentityProviders (instance-admin only upstream). */
export function listIdentityProviders(cfg: HostConfig, sessionId: string): IdentityProviderConfig[] {
  return identity.listIdentityProviders(cfg, sessionId);
}

/** Forward to identity_orchestrator.upsertIdentityProvider with the session as the
 *  credential (the config carries a clientSecretRef, never a raw secret). */
export function upsertIdentityProvider(
  cfg: HostConfig,
  sessionId: string,
  config: IdentityProviderConfig,
): IdentityProviderConfig {
  return identity.upsertIdentityProvider(cfg, sessionId, config);
}

/** Forward to identity_orchestrator.removeIdentityProvider with the session as the credential. */
export function removeIdentityProvider(cfg: HostConfig, sessionId: string, id: string): void {
  identity.removeIdentityProvider(cfg, sessionId, id);
}

// ── API-key administration (forward to admin_orchestrator) ───────────────────

/** Forward to admin_orchestrator.listKeys with the session as the credential. */
export function listKeys(cfg: HostConfig, sessionId: string, project: string): ApiKeyRecord[] {
  return admin.listKeys(cfg, sessionId, project);
}

/** Forward to admin_orchestrator.mintKey with the session as the credential; the
 *  plaintext key is returned once. */
export function mintKey(cfg: HostConfig, sessionId: string, project: string, role: string): string {
  return admin.mintKey(cfg, sessionId, project, role as Role);
}

/** Forward to admin_orchestrator.revokeKey with the session as the credential. */
export function revokeKey(cfg: HostConfig, sessionId: string, id: string): void {
  admin.revokeKey(cfg, sessionId, id);
}

// ── organization-unit administration (owned here) ────────────────────────────

/** Instance-admin = a grant scoped to every project ('*') carrying every
 *  permission ('*'). Mirrors identity.ts's isInstanceAdmin so the two agree. */
function isInstanceAdmin(principal: Principal): boolean {
  return (principal.grants ?? []).some((g) => g.projectId === '*' && g.permissions.includes('*'));
}

/** The audit actor for an org-admin action: the session principal's resolved
 *  subject, or a synthesized service identity for a credential without one. */
function auditActor(principal: Principal): PrincipalSubject {
  return principal.subject ?? { userId: 'token:' + principal.tokenId, kind: 'service', issuer: 'local' };
}

/** Append a redacted audit event best-effort: an append failure is recorded as a
 *  server diagnostic and swallowed so it can never fail the primary action. */
function tryAppendAudit(cfg: HostConfig, event: AuditEvent): void {
  try {
    appendAuditEvent(cfg.dataDir, event, DEFAULT_AUDIT_POLICY);
  } catch (err) {
    console.error(
      `[webadmin] audit append failed for "${event.action}": ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/** Build a redacted security-level audit event attributed to the session principal. */
function buildOrgAuditEvent(principal: Principal, action: string, target: string): AuditEvent {
  const event: AuditEvent = {
    id: '',
    timestamp: '',
    level: 'security',
    category: 'admin',
    action,
    outcome: 'success',
    actor: auditActor(principal),
    target,
  };
  if (principal.tokenId) event.tokenId = principal.tokenId;
  return event;
}

/** Resolve the browser session to a Principal and require an instance-wide admin
 *  grant, or reject. Shared by every organization-unit method. */
function requireInstanceAdminSession(cfg: HostConfig, sessionId: string): Principal {
  const principal = authenticateSession(cfg.dataDir, sessionId);
  if (!isInstanceAdmin(principal)) {
    throw new ForbiddenError('Forbidden — instance-admin required');
  }
  return principal;
}

/**
 * Resolve the session to a Principal, require an instance-wide admin grant, and
 * return every organization unit through the organization repository. Not audited
 * (a read).
 */
export function listOrganizationUnits(cfg: HostConfig, sessionId: string): OrganizationUnitRecord[] {
  requireInstanceAdminSession(cfg, sessionId); // steps 1–3
  return organization.listOrganizationUnits(cfg.dataDir); // steps 4–5
}

/**
 * Resolve the session to a Principal, require an instance-wide admin grant, create
 * or update an organization unit through the organization repository (id/createdAt
 * stamping and parent referential + cycle validation happen there), and append a
 * best-effort org.unit.upsert (security) audit event.
 */
export function upsertOrganizationUnit(
  cfg: HostConfig,
  sessionId: string,
  record: OrganizationUnitRecord,
): OrganizationUnitRecord {
  const principal = requireInstanceAdminSession(cfg, sessionId); // steps 1–3
  const stored = organization.upsertOrganizationUnit(cfg.dataDir, record); // step 4 (atomic)
  // steps 5–8: best-effort append (tryAppendAudit wraps the try/jump/catch).
  tryAppendAudit(cfg, buildOrgAuditEvent(principal, 'org.unit.upsert', stored.id));
  return stored; // step 9
}

/**
 * Resolve the session to a Principal, require an instance-wide admin grant, place a
 * project into an organization unit through the organization repository (id/createdAt
 * stamping and unitId referential validation happen there), and append a best-effort
 * org.placement.set (security) audit event.
 */
export function placeProject(cfg: HostConfig, sessionId: string, projectId: string, unitId: string): void {
  const principal = requireInstanceAdminSession(cfg, sessionId); // steps 1–3
  // step 4: build the ProjectPlacement binding projectId to unitId.
  const placement: ProjectPlacement = {
    id: '',
    projectId,
    unitId,
    role: 'owner',
    createdAt: '',
    createdBy: auditActor(principal),
  };
  organization.placeProject(cfg.dataDir, placement); // step 5 (atomic)
  // steps 6–9: best-effort append.
  tryAppendAudit(cfg, buildOrgAuditEvent(principal, 'org.placement.set', projectId));
  // step 10: return once placed.
}
