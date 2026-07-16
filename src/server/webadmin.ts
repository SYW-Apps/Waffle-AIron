import { authenticateSession } from './auth.js';
import * as identity from './identity.js';
import * as organization from './organization.js';
import { appendAuditEvent, DEFAULT_AUDIT_POLICY } from './audit.js';
import { ForbiddenError } from './identity.js';
import { isInstanceAdmin } from './authorization.js';
import { listSecretKeys } from '../utils/secrets.js';
import type {
  ApiKeyRecord,
  AuditEvent,
  HostConfig,
  HostedUserRecord,
  IdentityProviderConfig,
  OrganizationUnitRecord,
  Principal,
  PrincipalSubject,
  ProjectPlacement,
} from './types.js';

// ---------------------------------------------------------------------------
// Web Admin Orchestrator (sdd_host)
//
// The bridge that exposes the control-plane admin capabilities (user, identity-
// provider/SSO, and organization-unit management) on the PUBLIC web/data plane, so
// an authenticated admin manages the instance from the single web UI instead of the
// loopback-only admin listener. It ALSO handles the user-scoped SELF-SERVICE of
// minting a single-project MCP token for an AI agent.
//
// Every method carries the browser sessionId. USER / IdP methods — and the agent
// TOKEN methods — forward to the identity orchestrator PASSING THE SESSION AS THE
// CREDENTIAL — a ws_ session is a first-class data-plane credential that resolves
// to a Principal exactly like a bearer token, so the identity orchestrator's scope
// authorization and auditing apply UNCHANGED (no new authorization surface).
//
// Web-UI login (a HUMAN, via SSO/session) and MCP tokens (an AI AGENT, scoped to
// exactly ONE project) are DELIBERATELY SEPARATE concerns — a token is an agent
// credential entirely distinct from the human's web session, never a mixing of the
// two. mintProjectToken forwards to identity_orchestrator.mintToken, which
// authorizes the mint strictly against the caller's OWN access to that project.
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

// ── agent-token self-service (forward to identity_orchestrator) ──────────────

/**
 * Mint a single-project MCP token for an AI agent. Forwards to the identity
 * orchestrator's SELF-SERVICE mint (identity_orchestrator.mintSelfToken) passing the
 * session as the credential, plus projectId and write; it self-authorizes strictly
 * against the caller's OWN access to that project (no key:manage), OWNS the token to
 * the caller (so a later deactivation of that user revokes it), and returns the
 * plaintext token exactly once. The token is an agent credential entirely separate
 * from the human's web session, but owned by the human who minted it for lifecycle.
 */
export function mintProjectToken(cfg: HostConfig, sessionId: string, projectId: string, write: boolean): string {
  return identity.mintSelfToken(cfg, sessionId, projectId, write);
}

/** Revoke a previously minted MCP token by id. Forward to the identity
 *  orchestrator's SELF-SERVICE revoke (identity_orchestrator.revokeSelfToken) with
 *  the session as the credential — it revokes only a token the caller OWNS (a token
 *  the caller does not own is rejected as not found; no cross-user revocation). */
export function revokeProjectToken(cfg: HostConfig, sessionId: string, tokenId: string): void {
  identity.revokeSelfToken(cfg, sessionId, tokenId);
}

/** Return the caller's own minted MCP tokens (redacted — hashed token only) by
 *  forwarding to identity_orchestrator.listSelfTokens with the session as the
 *  credential. */
export function listMyTokens(cfg: HostConfig, sessionId: string): ApiKeyRecord[] {
  return identity.listSelfTokens(cfg, sessionId);
}

// ── organization-unit administration (owned here) ────────────────────────────

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
 * Resolve the session to a Principal, require an instance-wide admin grant, and
 * return the configured secret KEY NAMES (never the values) — so the identity-
 * provider form can offer existing clientSecretRefs to pick from. The names are
 * not sensitive; the raw secrets never leave the secret store. A read; not audited.
 */
export function listSecretRefs(cfg: HostConfig, sessionId: string): string[] {
  requireInstanceAdminSession(cfg, sessionId);
  return listSecretKeys();
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
