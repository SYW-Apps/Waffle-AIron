import { authenticateCredential } from './auth.js';
import { UnauthenticatedError, ForbiddenError } from './errors.js';
import { appendAuditEvent, DEFAULT_AUDIT_POLICY } from './audit.js';
import { authorize } from './authorization.js';
import {
  createRole as repoCreateRole,
  updateRole as repoUpdateRole,
  deleteRole as repoDeleteRole,
  listRoles as repoListRoles,
  isBuiltinRoleId,
} from './roles.js';
import {
  setAssignment as repoSetAssignment,
  removeAssignment as repoRemoveAssignment,
  getAssignment,
  listAssignments as repoListAssignments,
} from './permissions.js';
import { findUserByRecordOrSubjectId, getUserById, upsertUser } from './users.js';
import type {
  AuditEvent,
  HostConfig,
  HostedUserRecord,
  PermissionAssignment,
  Principal,
  PrincipalSubject,
  Role,
  RoleBinding,
  ScopeKind,
} from './types.js';

// ---------------------------------------------------------------------------
// Permission Admin Orchestrator (sdd_host)
//
// Control-plane management workflows for the permission model: role definitions
// (create/update/delete/list), the assignment grid (set/remove/list one
// subject×scope×capability value), and user role bindings (bind/unbind a role
// to a user at a scope). Every method authenticates the caller and authorizes
// through the authorization seam — role management requires INSTANCE-level
// project:admin (roles are instance-level templates); assignment and binding
// management require project:admin over the TARGET scope — and audits at
// security level (best-effort, never failing the primary action).
//
// Two hard reservations:
//   - built-in role ids (e.g. 'sso-admin') are intrinsic constants, never
//     stored rows — create/update/delete refuse them BEFORE anything else;
//   - there is NO '*' instance-admin capability in the grid — the bypass is
//     env-anchored to the built-in admin subject and can never be conferred by
//     an assignment, so setAssignment rejects the marker before authorization.
//
// Grant management (the legacy replaceUserGrants) is superseded by
// setAssignment/bindRole here.
// ---------------------------------------------------------------------------

const PROJECT_ADMIN_CAPABILITY = 'project:admin';

/**
 * The canonical assignment key for a user subject is the subject's userId —
 * the id every live Principal carries into the resolver. Callers routinely
 * pass the user RECORD id instead (the Users list shows it); when the two
 * have diverged, storing the record id would key a row the resolver only
 * honors via the alias path. Canonicalize at the write/read boundary; an id
 * with no user record (a pre-provisioned subject) passes through unchanged.
 */
function canonicalSubjectId(cfg: HostConfig, subjectId: string): string {
  const user = findUserByRecordOrSubjectId(cfg.dataDir, subjectId);
  return user?.subject.userId || subjectId;
}

/** Authenticate the caller credential or throw (401-mapping). */
function requirePrincipal(cfg: HostConfig, credential: string | null): Principal {
  const principal = authenticateCredential(cfg.dataDir, credential);
  if (!principal.authenticated) throw new UnauthenticatedError();
  return principal;
}

/** Require the caller's resolved project:admin over a scope to be yes
 *  (approval never acts on the permission-admin plane). */
function requireAdminOverScope(
  cfg: HostConfig,
  principal: Principal,
  scopeKind: ScopeKind,
  scopeId: string,
  denial: string,
): void {
  if (authorize(cfg.dataDir, principal, PROJECT_ADMIN_CAPABILITY, scopeKind, scopeId).value !== 'yes') {
    throw new ForbiddenError(denial);
  }
}

/** The subject behind an action for audit provenance: the resolved subject, or a
 *  synthesized service identity keyed by the token id for legacy credentials. */
function principalSubject(principal: Principal): PrincipalSubject {
  return (
    principal.subject ?? { userId: 'token:' + principal.tokenId, kind: 'service', issuer: 'local' }
  );
}

function buildAuditEvent(
  principal: Principal,
  action: string,
  target: string,
): AuditEvent {
  const event: AuditEvent = {
    id: '',
    timestamp: '',
    level: 'security',
    category: 'admin',
    action,
    outcome: 'success',
    actor: principalSubject(principal),
    target,
  };
  if (principal.tokenId) event.tokenId = principal.tokenId;
  return event;
}

/** Append a redacted audit event, best-effort: a failure is recorded as a server
 *  diagnostic and swallowed so an append can never fail the primary action. */
function tryAppendAudit(cfg: HostConfig, event: AuditEvent): void {
  try {
    appendAuditEvent(cfg.dataDir, event, DEFAULT_AUDIT_POLICY);
  } catch (err) {
    console.error(
      `[permissionadmin] audit append failed for "${event.action}": ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

// ── role management (instance-level templates) ────────────────────────────────

/** Refuse the intrinsic built-in role ids BEFORE anything else — they are
 *  constants merged at resolution, not admin-defined stored rows. */
function rejectBuiltinRoleId(roleId: string, verb: string): void {
  if (isBuiltinRoleId(roleId)) {
    throw new ForbiddenError(`built-in reserved roles are intrinsic and cannot be ${verb}`);
  }
}

/**
 * Authenticate, require instance-level project:admin, create a role through the
 * role repository (duplicate ids reject there), and audit. Roles are
 * instance-level templates; a reserved built-in id is refused before anything else.
 */
export function createRole(cfg: HostConfig, credential: string | null, role: Role): Role {
  rejectBuiltinRoleId(role.id, 'created or overridden'); // steps 1–2
  const principal = requirePrincipal(cfg, credential); // step 3
  // steps 4–6: roles are instance-level, so managing them is instance-level.
  requireAdminOverScope(cfg, principal, 'instance', '', 'managing roles requires instance-level project:admin');
  const stored = repoCreateRole(cfg.dataDir, { ...role, createdBy: principalSubject(principal) }); // step 7
  tryAppendAudit(cfg, buildAuditEvent(principal, 'role.create', stored.id)); // steps 8–11
  return stored; // step 12
}

/**
 * Authenticate, require instance-level project:admin, update a role's
 * metadata/permissions through the role repository, and audit. A reserved
 * built-in id is refused before anything else.
 */
export function updateRole(cfg: HostConfig, credential: string | null, role: Role): Role {
  rejectBuiltinRoleId(role.id, 'modified'); // steps 1–2
  const principal = requirePrincipal(cfg, credential); // step 3
  requireAdminOverScope(cfg, principal, 'instance', '', 'managing roles requires instance-level project:admin'); // steps 4–6
  const stored = repoUpdateRole(cfg.dataDir, role); // step 7
  tryAppendAudit(cfg, buildAuditEvent(principal, 'role.update', stored.id)); // steps 8–11
  return stored; // step 12
}

/**
 * Authenticate, require instance-level project:admin, delete a role through the
 * role repository, and audit. Bindings referencing a deleted role become inert
 * (the resolver ignores unknown roles). A reserved built-in id is refused
 * before anything else.
 */
export function deleteRole(cfg: HostConfig, credential: string | null, roleId: string): void {
  rejectBuiltinRoleId(roleId, 'deleted'); // steps 1–2
  const principal = requirePrincipal(cfg, credential); // step 3
  requireAdminOverScope(cfg, principal, 'instance', '', 'managing roles requires instance-level project:admin'); // steps 4–6
  repoDeleteRole(cfg.dataDir, roleId); // step 7
  tryAppendAudit(cfg, buildAuditEvent(principal, 'role.delete', roleId)); // steps 8–11
}

/** Authenticate, require instance-level project:admin, and list the stored
 *  (admin-defined) roles. A read; not audited. */
export function listRoles(cfg: HostConfig, credential: string | null): Role[] {
  const principal = requirePrincipal(cfg, credential); // step 1
  requireAdminOverScope(cfg, principal, 'instance', '', 'listing roles requires instance-level project:admin'); // steps 2–4
  return repoListRoles(cfg.dataDir); // steps 5–6
}

// ── the assignment grid ───────────────────────────────────────────────────────

/**
 * Authenticate, reject the reserved '*' instance-admin marker unconditionally,
 * require project:admin over the ASSIGNMENT'S scope, upsert the assignment
 * through the permission repository, and audit at security level.
 */
export function setAssignment(
  cfg: HostConfig,
  credential: string | null,
  assignment: PermissionAssignment,
): PermissionAssignment {
  const principal = requirePrincipal(cfg, credential); // step 1
  // steps 2–3: HARD RESERVATION — there is no instance-admin assignment. The
  // capability arrives as untrusted input, so compare the raw string.
  if (String(assignment.capability) === '*' && assignment.scopeKind === 'instance') {
    throw new ForbiddenError(
      "the instance-admin marker ('*'@instance) is reserved to the built-in admin account",
    );
  }
  // steps 4–6: the caller must administer the scope the assignment lands on.
  requireAdminOverScope(
    cfg,
    principal,
    assignment.scopeKind,
    assignment.scopeId ?? '',
    'setting an assignment requires project:admin over its scope',
  );
  const stored = repoSetAssignment(cfg.dataDir, {
    ...assignment,
    // Canonical grid key: user-kind subjects store the subject's userId, so
    // the resolver's primary match (not the legacy-alias path) serves them.
    ...(assignment.subjectKind === 'user' && assignment.subjectId
      ? { subjectId: canonicalSubjectId(cfg, assignment.subjectId) }
      : {}),
    createdBy: principalSubject(principal),
  }); // step 7
  tryAppendAudit(cfg, buildAuditEvent(principal, 'permission.set', stored.id)); // steps 8–11
  return stored; // step 12
}

/**
 * Authenticate, look up the assignment (not-found when absent), require
 * project:admin over ITS scope (never a caller-supplied one), remove it through
 * the permission repository, and audit.
 */
export function removeAssignment(
  cfg: HostConfig,
  credential: string | null,
  assignmentId: string,
): void {
  const principal = requirePrincipal(cfg, credential); // step 1
  const existing = getAssignment(cfg.dataDir, assignmentId); // step 2
  if (!existing) {
    throw new Error(`Assignment "${assignmentId}" not found.`); // steps 3–4
  }
  // steps 5–7: authorize over the assignment's OWN scope.
  requireAdminOverScope(
    cfg,
    principal,
    existing.scopeKind,
    existing.scopeId ?? '',
    'removing an assignment requires project:admin over its scope',
  );
  repoRemoveAssignment(cfg.dataDir, assignmentId); // step 8
  tryAppendAudit(cfg, buildAuditEvent(principal, 'permission.remove', assignmentId)); // steps 9–12
}

/**
 * Authenticate, require project:admin over the queried scope (an absent scope
 * filter queries the whole instance, so it requires instance-level
 * project:admin), and list assignments filtered by scope/subject through the
 * permission repository. A read; not audited.
 */
export function listAssignments(
  cfg: HostConfig,
  credential: string | null,
  scopeKind?: ScopeKind,
  scopeId?: string,
  subjectKind?: 'user' | 'everyone',
  subjectId?: string,
): PermissionAssignment[] {
  const principal = requirePrincipal(cfg, credential); // step 1
  requireAdminOverScope(
    cfg,
    principal,
    scopeKind ?? 'instance',
    scopeId ?? '',
    'listing assignments requires project:admin over the scope',
  ); // steps 2–4
  // steps 5–6: the repository filters by subject; the scope filter narrows to
  // the exact {scopeKind, scopeId} anchor when given (kind-qualified — a unit
  // and a project id never cross-match). A user-subject filter matches the
  // raw id AND its canonical form, so legacy rows keyed by a diverged record
  // id stay visible next to canonical ones.
  const subjectIds = subjectKind === 'user' && subjectId
    ? [...new Set([subjectId, canonicalSubjectId(cfg, subjectId)])]
    : undefined;
  const assignments = subjectIds
    ? subjectIds.flatMap((id) => repoListAssignments(cfg.dataDir, undefined, subjectKind, id))
    : repoListAssignments(cfg.dataDir, undefined, subjectKind, subjectId);
  const seen = new Set<string>();
  return assignments.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    if (scopeKind !== undefined && a.scopeKind !== scopeKind) return false;
    if (scopeId !== undefined && (a.scopeId ?? '') !== scopeId) return false;
    return true;
  });
}

// ── user role bindings ────────────────────────────────────────────────────────

/** The binding's anchor scope: an unscoped binding applies instance-wide. */
function bindingScope(scopeKind?: ScopeKind, scopeId?: string): { kind: ScopeKind; id: string } {
  return { kind: scopeKind ?? 'instance', id: scopeId ?? '' };
}

/** True when two bindings name the same {roleId, scopeKind, scopeId} anchor
 *  (an unscoped binding and an explicit instance binding are the same anchor). */
function sameBinding(a: RoleBinding, b: RoleBinding): boolean {
  return (
    a.roleId === b.roleId &&
    (a.scopeKind ?? 'instance') === (b.scopeKind ?? 'instance') &&
    (a.scopeId ?? '') === (b.scopeId ?? '')
  );
}

/**
 * Authenticate, require project:admin over the binding's scope, add a
 * {roleId, scope} binding to the target user's roleBindings (idempotent — no
 * duplicate) through the user repository, and audit.
 */
export function bindRole(
  cfg: HostConfig,
  credential: string | null,
  userId: string,
  roleId: string,
  scopeKind?: ScopeKind,
  scopeId?: string,
): HostedUserRecord {
  const principal = requirePrincipal(cfg, credential); // step 1
  const scope = bindingScope(scopeKind, scopeId);
  requireAdminOverScope(cfg, principal, scope.kind, scope.id, 'binding a role requires project:admin over the scope'); // steps 2–4
  const user = getUserById(cfg.dataDir, userId); // step 5
  if (!user) {
    throw new Error(`User "${userId}" not found.`); // steps 6–7
  }
  // step 8: idempotent add — no duplicate {roleId, scope} anchor.
  const binding: RoleBinding = {
    roleId,
    ...(scopeKind !== undefined ? { scopeKind } : {}),
    ...(scopeId !== undefined ? { scopeId } : {}),
  };
  const bindings = user.roleBindings ?? [];
  const next = bindings.some((b) => sameBinding(b, binding)) ? bindings : [...bindings, binding];
  const stored = upsertUser(cfg.dataDir, { ...user, roleBindings: next }); // step 9
  tryAppendAudit(cfg, buildAuditEvent(principal, 'role.bind', `${userId}:${roleId}`)); // steps 10–13
  return stored; // step 14
}

/**
 * Authenticate, require project:admin over the binding's scope, remove the
 * matching {roleId, scope} binding from the target user's roleBindings through
 * the user repository, and audit.
 */
export function unbindRole(
  cfg: HostConfig,
  credential: string | null,
  userId: string,
  roleId: string,
  scopeKind?: ScopeKind,
  scopeId?: string,
): HostedUserRecord {
  const principal = requirePrincipal(cfg, credential); // step 1
  const scope = bindingScope(scopeKind, scopeId);
  requireAdminOverScope(cfg, principal, scope.kind, scope.id, 'unbinding a role requires project:admin over the scope'); // steps 2–4
  const user = getUserById(cfg.dataDir, userId); // step 5
  if (!user) {
    throw new Error(`User "${userId}" not found.`); // steps 6–7
  }
  const target: RoleBinding = {
    roleId,
    ...(scopeKind !== undefined ? { scopeKind } : {}),
    ...(scopeId !== undefined ? { scopeId } : {}),
  };
  const next = (user.roleBindings ?? []).filter((b) => !sameBinding(b, target)); // step 8
  const stored = upsertUser(cfg.dataDir, { ...user, roleBindings: next }); // step 9
  tryAppendAudit(cfg, buildAuditEvent(principal, 'role.unbind', `${userId}:${roleId}`)); // steps 10–13
  return stored; // step 14
}
