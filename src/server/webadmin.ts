import { authenticateSession } from './auth.js';
import * as identity from './identity.js';
import * as organization from './organization.js';
import * as permissionadmin from './permissionadmin.js';
import { remapScope, removeAssignmentsForScopes } from './permissions.js';
import { remapUnitReferences } from './users.js';
import { appendAuditEvent, DEFAULT_AUDIT_POLICY } from './audit.js';
import { authorize } from './authorization.js';
import { ForbiddenError } from './identity.js';
import { listSecretKeys, setSecret as storeSecret } from '../utils/secrets.js';
import type {
  ApiKeyRecord,
  AuditEvent,
  HostConfig,
  HostedUserRecord,
  IdentityProviderConfig,
  OrganizationUnitRecord,
  PermissionAssignment,
  Principal,
  PrincipalSubject,
  ProjectPlacement,
  Role,
  ScopeKind,
  UnitDisposition,
  UnitIdRemap,
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

/** Resolve the browser session to a Principal and require INSTANCE-level
 *  project:admin, or reject. Shared by the organization-unit, secret-ref, and
 *  identity-provider methods — the instance-structure surfaces.
 *
 *  This is the resolver check `authorize(project:admin, instance)`, NOT the
 *  env-super-admin bypass flag: the env super-admin, the master credential, and
 *  a DELEGATED instance-wide admin (an SSO admin whose sso-admin role binds
 *  project:admin at instance scope, or a direct project:admin@instance
 *  assignment) all pass, matching the "instance ops → project:admin@instance"
 *  rule. A unit-scoped project:admin, however broad, does NOT reach the instance
 *  root, so it is still refused (closing the delegated-capture hole). */
function requireInstanceAdminSession(cfg: HostConfig, sessionId: string): Principal {
  const principal = authenticateSession(cfg.dataDir, sessionId);
  if (authorize(cfg.dataDir, principal, 'project:admin', 'instance', '').value !== 'yes') {
    throw new ForbiddenError('Forbidden — instance-level project:admin required');
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
 * Resolve the session to a Principal, require INSTANCE-level project:admin, and
 * set (or update) one integration secret by key — e.g. `git-token`, the PAT the
 * git adapters inject into an https remote for clone/fetch/push. The VALUE is
 * stored write-only in the secret store and never read back over the API (only
 * the key NAMES are listable). Setting the same key again replaces the value, so
 * a rotated PAT is a re-set. Audited at security level (the key, never the value).
 */
export function setSecret(cfg: HostConfig, sessionId: string, key: string, value: string): void {
  const principal = requireInstanceAdminSession(cfg, sessionId);
  if (!key.trim()) throw new Error('A secret key is required.');
  storeSecret(key.trim(), value);
  tryAppendAudit(cfg, buildOrgAuditEvent(principal, 'secret.set', key.trim()));
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
  // steps 4–8: an existing record takes the metadata-update path; anything else
  // is a create (the registry computes the qualified dot-path id from
  // parent+slug and rejects collisions).
  const existing = record.id ? organization.getOrganizationUnit(cfg.dataDir, record.id) : null;
  // A NEW unit must satisfy the org-unit kind hierarchy (business_entity at the
  // root; otherwise a kind permitted under its parent's kind). Existing units take
  // the metadata-update path and are not retroactively re-validated.
  if (!existing) {
    const parentKind = record.parentId
      ? organization.getOrganizationUnit(cfg.dataDir, record.parentId)?.kind ?? null
      : null;
    organization.validateUnitHierarchy(record.kind, parentKind);
  }
  const stored = existing
    ? organization.updateUnit(cfg.dataDir, record)
    : organization.createUnit(cfg.dataDir, record);
  // steps 9–12: best-effort append (tryAppendAudit wraps the try/jump/catch).
  tryAppendAudit(cfg, buildOrgAuditEvent(principal, 'org.unit.upsert', stored.id));
  return stored; // step 13
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

/** All unit ids in the subtree rooted at `rootId` (root included), resolved by
 *  parentId links over the given unit collection. */
function subtreeUnitIds(units: OrganizationUnitRecord[], rootId: string): Set<string> {
  const subtree = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const u of units) {
      if (u.parentId !== undefined && subtree.has(u.parentId) && !subtree.has(u.id)) {
        subtree.add(u.id);
        grew = true;
      }
    }
  }
  return subtree;
}

/**
 * Resolve the session to a Principal, require an instance-wide admin grant, then
 * dispose of the organization unit per the UnitDisposition — a unit is never
 * silently cascade-deleted:
 *   - migrate     → content moves to an EXISTING target unit outside the subtree;
 *   - alternative → a fresh replacement sibling (newSlug/newName) is created and
 *                   content moves into it (how a rename/replace is expressed);
 *   - absorb      → content moves to the unit's parent (a root cannot absorb);
 *   - cascade     → the whole subtree and its placements are deleted, assignments
 *                   scoped into it are removed (no resurrection at a reused
 *                   path), and user references into it are cleared.
 * Every non-cascade move rewrites external references (assignment scopes, user
 * home units, role-binding scopes) via the returned id remap, then deletes the
 * emptied unit. Appends a best-effort org.unit.remove (security) audit event.
 */
export function removeUnit(
  cfg: HostConfig,
  sessionId: string,
  unitId: string,
  disposition: UnitDisposition,
): void {
  const principal = requireInstanceAdminSession(cfg, sessionId); // steps 1–3
  const unit = organization.getOrganizationUnit(cfg.dataDir, unitId); // step 4
  if (!unit) {
    throw new Error(`Unknown organization unit "${unitId}".`); // steps 5–6
  }
  const units = organization.listOrganizationUnits(cfg.dataDir);
  const subtree = subtreeUnitIds(units, unitId);

  // step 7: route on the disposition.
  if (disposition.kind === 'cascade') {
    // steps 26–28: delete every placement in the subtree.
    for (const placement of organization.listProjectPlacements(cfg.dataDir)) {
      if (subtree.has(placement.unitId)) {
        organization.deletePlacement(cfg.dataDir, placement.id);
      }
    }
    const doomed = [...subtree];
    // step 29: remove assignments scoped into the deleted subtree.
    removeAssignmentsForScopes(cfg.dataDir, doomed);
    // step 30: clear user home units and role bindings scoped into it.
    remapUnitReferences(cfg.dataDir, [], doomed);
    // steps 31–32: delete every unit deepest-first (children before parents).
    const depth = (u: OrganizationUnitRecord): number => u.id.split('.').length;
    const doomedUnits = units.filter((u) => subtree.has(u.id)).sort((a, b) => depth(b) - depth(a));
    for (const u of doomedUnits) {
      organization.deleteUnit(cfg.dataDir, u.id);
    }
  } else {
    // steps 8–16: resolve the destination unit id per the disposition.
    let destination: string;
    if (disposition.kind === 'alternative') {
      if (!disposition.newSlug) {
        throw new Error("An 'alternative' disposition requires newSlug for the replacement unit.");
      }
      // The replacement sibling copies the removed unit's posture so the
      // rename/replace preserves visibility.
      const replacement = organization.createUnit(cfg.dataDir, {
        id: '',
        name: disposition.newName ?? unit.name,
        slug: disposition.newSlug,
        kind: unit.kind,
        ...(unit.parentId !== undefined ? { parentId: unit.parentId } : {}),
        status: 'active',
        ...(unit.visibility !== undefined ? { visibility: unit.visibility } : {}),
        ...(unit.exposeTo !== undefined ? { exposeTo: unit.exposeTo } : {}),
        createdAt: '',
        createdBy: auditActor(principal),
      });
      destination = replacement.id;
    } else if (disposition.kind === 'migrate') {
      const target = disposition.targetUnitId;
      if (!target || target === unitId || subtree.has(target) || !units.some((u) => u.id === target)) {
        throw new Error('Invalid migrate target — must be an existing unit outside the removed subtree.');
      }
      destination = target;
    } else {
      // 'absorb': content moves to the parent, which a root does not have.
      if (unit.parentId === undefined) {
        throw new Error('Cannot absorb a root unit — it has no parent.');
      }
      destination = unit.parentId;
    }

    // steps 17–19: reparent every direct child subtree under the destination,
    // accumulating the old->new id remap; the removed unit's own id maps to the
    // destination (its direct references move there).
    const remap: UnitIdRemap[] = [];
    for (const child of units.filter((u) => u.parentId === unitId)) {
      remap.push(...organization.reparentUnit(cfg.dataDir, child.id, destination));
    }
    remap.push({ oldId: unitId, newId: destination });

    // steps 20–21: re-point the removed unit's own placements onto the
    // destination (child-subtree placements already moved with the reparent).
    for (const placement of organization.listProjectPlacements(cfg.dataDir, undefined, unitId)) {
      organization.placeProject(cfg.dataDir, { ...placement, unitId: destination });
    }

    // steps 22–23: rewrite external references onto the new ids.
    remapScope(cfg.dataDir, remap);
    remapUnitReferences(cfg.dataDir, remap, []);

    // step 24: the unit is now empty — delete it.
    organization.deleteUnit(cfg.dataDir, unitId);
  }

  // steps 33–36: best-effort append.
  tryAppendAudit(cfg, buildOrgAuditEvent(principal, 'org.unit.remove', unitId));
  // step 37: return once the unit has been removed.
}

// ── roles / assignments / bindings (forward to permission_admin_orchestrator) ─

/** Forward to permission_admin_orchestrator.listRoles with the session as the
 *  credential (instance-admin only upstream). */
export function listRoles(cfg: HostConfig, sessionId: string): Role[] {
  return permissionadmin.listRoles(cfg, sessionId);
}

/** Forward to permission_admin_orchestrator.createRole with the session as the credential. */
export function createRole(cfg: HostConfig, sessionId: string, role: Role): Role {
  return permissionadmin.createRole(cfg, sessionId, role);
}

/** Forward to permission_admin_orchestrator.updateRole with the session as the credential. */
export function updateRole(cfg: HostConfig, sessionId: string, role: Role): Role {
  return permissionadmin.updateRole(cfg, sessionId, role);
}

/** Forward to permission_admin_orchestrator.deleteRole with the session as the credential. */
export function deleteRole(cfg: HostConfig, sessionId: string, roleId: string): void {
  permissionadmin.deleteRole(cfg, sessionId, roleId);
}

/** Forward to permission_admin_orchestrator.listAssignments with the session as
 *  the credential (project:admin over the scope upstream). */
export function listAssignments(
  cfg: HostConfig,
  sessionId: string,
  scopeKind?: ScopeKind,
  scopeId?: string,
  subjectKind?: 'user' | 'everyone',
  subjectId?: string,
): PermissionAssignment[] {
  return permissionadmin.listAssignments(cfg, sessionId, scopeKind, scopeId, subjectKind, subjectId);
}

/** Forward to permission_admin_orchestrator.setAssignment with the session as the credential. */
export function setAssignment(
  cfg: HostConfig,
  sessionId: string,
  assignment: PermissionAssignment,
): PermissionAssignment {
  return permissionadmin.setAssignment(cfg, sessionId, assignment);
}

/** Forward to permission_admin_orchestrator.removeAssignment with the session as the credential. */
export function removeAssignment(cfg: HostConfig, sessionId: string, assignmentId: string): void {
  permissionadmin.removeAssignment(cfg, sessionId, assignmentId);
}

/** Forward to permission_admin_orchestrator.bindRole with the session as the credential. */
export function bindRole(
  cfg: HostConfig,
  sessionId: string,
  userId: string,
  roleId: string,
  scopeKind?: ScopeKind,
  scopeId?: string,
): HostedUserRecord {
  return permissionadmin.bindRole(cfg, sessionId, userId, roleId, scopeKind, scopeId);
}

/** Forward to permission_admin_orchestrator.unbindRole with the session as the credential. */
export function unbindRole(
  cfg: HostConfig,
  sessionId: string,
  userId: string,
  roleId: string,
  scopeKind?: ScopeKind,
  scopeId?: string,
): HostedUserRecord {
  return permissionadmin.unbindRole(cfg, sessionId, userId, roleId, scopeKind, scopeId);
}
