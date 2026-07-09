import { authenticateCredential } from './auth.js';
import {
  createApprovalRequest,
  decideApprovalRequest,
  getApprovalRequestById,
  listApprovalRequests,
  markApprovalCompleted,
  expirePendingApprovals,
} from './approvals.js';
import { appendAuditEvent, DEFAULT_AUDIT_POLICY } from './audit.js';
import { UnauthenticatedError, ForbiddenError } from './identity.js';
import { executeApprovedLock, executeApprovedPromote } from './admin.js';
import { evaluateInitRequest, executeApprovedInit } from './policy.js';
import { isValidProjectId, listProjectRecords, existingProjectRoot } from './projects.js';
import type {
  ApprovalRequest,
  ApprovalDecision,
  AuditEvent,
  AuditRetentionPolicy,
  HostConfig,
  Principal,
  PrincipalSubject,
  ProjectInitRequest,
} from './types.js';

// ---------------------------------------------------------------------------
// Self-Service Orchestrator (sdd_host)
//
// Approval-backed self-service workflows for project init / lock / promote
// requested over MCP, CLI, or UI. Every method authenticates the caller
// credential (via the auth specialist) and authorizes by grants; a privileged
// action never runs directly — a request only ever creates/inspects/decides an
// ApprovalRequest, and execution runs solely after an authorized decision,
// through the pre-authorized entry points: project:init flows through the policy
// orchestrator (evaluateInitRequest / executeApprovedInit in policy.ts), and
// project:lock / project:promote through the admin plane (executeApprovedLock /
// executeApprovedPromote in admin.ts).
//
// Exported as plain functions in the same house shape as identity.ts
// (cfg, credential, …) so both the eventual HTTP self-service portal and any
// in-process caller reach the same logic. Every audit append is best-effort: an
// append failure is recorded as a server diagnostic and never fails the primary
// action. Phase 3 retargets init to the pack/profile policy plane: a request is
// validated structurally and then evaluated against the active instance policy —
// an enforcing ('block') policy rejects a non-compliant request at request time,
// while warn/auto_reconcile findings ride the approval summary to the approver.
// ---------------------------------------------------------------------------

/** Approval requests default to a 7-day pending window: long enough for an
 *  out-of-band human decision, short enough that a stale request cannot linger
 *  indefinitely. HostConfig-driven overrides are a later phase. */
const DEFAULT_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The permission that authorizes deciding/listing approval requests. Instance
 *  scope (like audit:read), so authorized via carriesPermission. */
const APPROVAL_DECIDE_PERMISSION = 'approval:decide';
/** The permission that lets a caller request a project's lock/promotion. */
const MCP_WRITE_PERMISSION = 'mcp:write';

// ── authorization helpers (mirrored from identity.ts, which keeps them private) ──
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
 *  scope (or a wildcard '*' permission). Used for instance-wide capabilities. */
function carriesPermission(principal: Principal, permission: string): boolean {
  return (principal.grants ?? []).some(
    (g) => g.permissions.includes('*') || g.permissions.includes(permission),
  );
}

/** True when the caller may decide/list approvals: an approval:decide grant or
 *  an instance-admin grant. */
function mayDecide(principal: Principal): boolean {
  return carriesPermission(principal, APPROVAL_DECIDE_PERMISSION) || isInstanceAdmin(principal);
}

// ── subject / audit helpers (mirrored from identity.ts) ─────────────────────

/** The stable subject for a principal: the resolved subject, or — when a legacy
 *  master/token credential carries none — a synthesized service identity keyed by
 *  the credential's token id. Used for requestedBy, audit actor, and requester
 *  identity comparisons, so all three agree. */
function principalSubject(principal: Principal): PrincipalSubject {
  return (
    principal.subject ?? {
      userId: 'token:' + principal.tokenId,
      kind: 'service',
      issuer: 'local',
    }
  );
}

/** True when `principal` is the original requester of `req`: a matching resolved
 *  subject (falling back to the synthesized token subject), or the same requesting
 *  token id. Backs both status visibility and the self-approval rejection. */
function isOriginalRequester(principal: Principal, req: ApprovalRequest): boolean {
  const subjectMatch = principalSubject(principal).userId === req.requestedBy.userId;
  const tokenMatch =
    !!principal.tokenId && !!req.requestedTokenId && principal.tokenId === req.requestedTokenId;
  return subjectMatch || tokenMatch;
}

/** Resolve the active audit retention policy. Host-config plumbing is a later
 *  phase; until then the secure default (mirrors identity.ts). */
function resolveAuditPolicy(_cfg: HostConfig): AuditRetentionPolicy {
  return DEFAULT_AUDIT_POLICY;
}

function buildAuditEvent(
  principal: Principal,
  action: string,
  level: string,
  over: Partial<AuditEvent> = {},
): AuditEvent {
  const event: AuditEvent = {
    id: '',
    timestamp: '',
    level,
    category: 'approval',
    action,
    outcome: 'success',
    actor: principalSubject(principal),
    ...over,
  };
  if (principal.tokenId) event.tokenId = principal.tokenId;
  return event;
}

/** Append a redacted audit event, best-effort: a failure is recorded as a server
 *  diagnostic and swallowed so an append can never fail the primary action. */
function tryAppendAudit(cfg: HostConfig, event: AuditEvent): void {
  try {
    appendAuditEvent(cfg.dataDir, event, resolveAuditPolicy(cfg));
  } catch (err) {
    // Server diagnostic (audit appends are best-effort by invariant).
    console.error(
      `[selfservice] audit append failed for "${event.action}": ` +
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

/** Build a pending ApprovalRequest with the shared requester/expiry metadata.
 *  The repository stamps the real id, createdAt, and pending status on create;
 *  the placeholder id/createdAt here are overwritten. */
function buildPendingRequest(
  principal: Principal,
  kind: string,
  summary: string,
  projectId: string,
  extra: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  const request: ApprovalRequest = {
    id: '',
    kind,
    status: 'pending',
    requestedBy: principalSubject(principal),
    projectId,
    summary,
    createdAt: '',
    expiresAt: new Date(Date.now() + DEFAULT_APPROVAL_TTL_MS).toISOString(),
    ...extra,
  };
  if (principal.tokenId) request.requestedTokenId = principal.tokenId;
  return request;
}

// ── orchestrator methods ─────────────────────────────────────────────────────

/**
 * Authenticate the caller (any authenticated principal may request), validate the
 * ProjectInitRequest structurally (id shape per the project-id rules createProject
 * enforces, and the project must not already exist), then evaluate it against the
 * active instance pack policy via the policy orchestrator's pre-authorized
 * evaluation: an enforcing ('block') policy rejects a non-compliant request
 * immediately with actionable findings, while warn/auto_reconcile findings are
 * appended to the request's summary so the human approver sees them. Create a
 * pending project:init ApprovalRequest carrying a redacted summary and the request
 * as its payload, audit the creation (best-effort), and return the pending
 * request. Does not create the project.
 */
export function requestProjectInitialization(
  cfg: HostConfig,
  credential: string | null,
  request: ProjectInitRequest,
): ApprovalRequest {
  const principal = requirePrincipal(cfg, credential);

  // Structural validation: id shape and non-collision.
  if (!isValidProjectId(request.id)) {
    throw new Error(
      `Invalid project id "${request.id}" (allowed: lowercase letters, digits, hyphen).`,
    );
  }
  if (listProjectRecords(cfg.dataDir).some((p) => p.id === request.id)) {
    throw new Error(`Project "${request.id}" already exists.`);
  }

  // Phase 3: evaluate the request against the active instance pack policy through
  // the policy orchestrator's pre-authorized entry (the caller is already
  // authenticated). An enforcing policy rejects a non-compliant request at request
  // time; findings are surfaced so the agent learns WHY.
  const evaluation = evaluateInitRequest(cfg, request);
  if (evaluation.mode === 'block' && !evaluation.compliant) {
    throw new ForbiddenError(`Policy violation: ${evaluation.messages.join(' ')}`);
  }

  let summary =
    `Initialize project ${request.id}` +
    (request.displayName ? ` (${request.displayName})` : '');
  // Warn/auto_reconcile findings ride the approval summary to the human approver.
  if (!evaluation.compliant && evaluation.messages.length > 0) {
    summary += ` [policy findings: ${evaluation.messages.join(' ')}]`;
  }

  // Payload is the request itself — a ProjectInitRequest carries no secrets by
  // construction (profileSelection is opaque config, not credentials).
  const pending = buildPendingRequest(principal, 'project:init', summary, request.id, {
    payloadType: 'ProjectInitRequest',
    payload: JSON.stringify(request),
  });
  const created = createApprovalRequest(cfg.dataDir, pending);

  tryAppendAudit(
    cfg,
    buildAuditEvent(principal, 'approval.request.created', 'info', {
      target: created.id,
      projectId: created.projectId,
    }),
  );

  return created;
}

/**
 * Authenticate the caller, authorize by grants (a grant covering the project —
 * mcp:write or an instance-wide wildcard), require the project to exist, create a
 * pending project:lock ApprovalRequest, audit the creation (best-effort), and
 * return it. Does not lock the project.
 */
export function requestProjectLock(
  cfg: HostConfig,
  credential: string | null,
  projectId: string,
): ApprovalRequest {
  return requestProjectAction(cfg, credential, projectId, 'project:lock', 'Lock', 'lock');
}

/**
 * Authenticate the caller, authorize by grants (a grant covering the project —
 * mcp:write or an instance-wide wildcard), require the project to exist, create a
 * pending project:promote ApprovalRequest, audit the creation (best-effort), and
 * return it. Does not promote the project.
 */
export function requestProjectPromotion(
  cfg: HostConfig,
  credential: string | null,
  projectId: string,
): ApprovalRequest {
  return requestProjectAction(cfg, credential, projectId, 'project:promote', 'Promote', 'promotion');
}

/** Shared body for the lock/promotion request workflows: identical authenticate →
 *  authorize (grant covering the project) → project-exists → create pending →
 *  audit → return, differing only in the request kind and summary wording. */
function requestProjectAction(
  cfg: HostConfig,
  credential: string | null,
  projectId: string,
  kind: string,
  verb: string,
  noun: string,
): ApprovalRequest {
  const principal = requirePrincipal(cfg, credential);

  if (!coversPermission(principal, projectId, MCP_WRITE_PERMISSION)) {
    throw new ForbiddenError(`caller may not request a ${noun} for this project`);
  }
  if (!existingProjectRoot(cfg.dataDir, projectId)) {
    throw new Error(`Unknown project "${projectId}".`);
  }

  const pending = buildPendingRequest(principal, kind, `${verb} project ${projectId}`, projectId);
  const created = createApprovalRequest(cfg.dataDir, pending);

  tryAppendAudit(
    cfg,
    buildAuditEvent(principal, 'approval.request.created', 'info', {
      target: created.id,
      projectId,
    }),
  );

  return created;
}

/**
 * Authenticate the caller, lazily expire overdue pending requests first, look up
 * the request by id (not-found error when absent), and return it only to its
 * original requester (matching subject or requesting token id) or to a holder of
 * approval:decide / an instance-admin grant. Unrelated callers are denied. Read —
 * no audit event.
 */
export function getRequestStatus(
  cfg: HostConfig,
  credential: string | null,
  requestId: string,
): ApprovalRequest {
  const principal = requirePrincipal(cfg, credential);
  expirePendingApprovals(cfg.dataDir, new Date().toISOString());

  const req = getApprovalRequestById(cfg.dataDir, requestId);
  if (!req) throw new Error(`Approval request "${requestId}" not found.`);

  if (!isOriginalRequester(principal, req) && !mayDecide(principal)) {
    throw new ForbiddenError('caller may not view this approval request');
  }
  return req;
}

/**
 * Authenticate the caller, authorize by grants (approval:decide or an
 * instance-admin grant only), lazily expire overdue pending requests first, then
 * list the pending approval requests, optionally narrowed to one project. Read —
 * no audit event.
 */
export function listPendingRequests(
  cfg: HostConfig,
  credential: string | null,
  projectId?: string,
): ApprovalRequest[] {
  const principal = requirePrincipal(cfg, credential);
  if (!mayDecide(principal)) {
    throw new ForbiddenError('deciding approvals requires approval:decide or an instance-admin grant');
  }
  expirePendingApprovals(cfg.dataDir, new Date().toISOString());
  return listApprovalRequests(cfg.dataDir, 'pending', projectId);
}

/**
 * Authenticate the caller, authorize by grants (approval:decide or an
 * instance-admin grant), look up the request (not-found when absent), derive the
 * decided-by identity from the AUTHENTICATED caller (the client-supplied decidedBy
 * is never trusted and is overwritten), reject self-approval (the caller is the
 * original requester), record the approval/denial through the repository, audit at
 * security level (best-effort), and return the decided request.
 */
export function decideRequest(
  cfg: HostConfig,
  credential: string | null,
  decision: ApprovalDecision,
): ApprovalRequest {
  const principal = requirePrincipal(cfg, credential);
  if (!mayDecide(principal)) {
    throw new ForbiddenError('deciding approvals requires approval:decide or an instance-admin grant');
  }

  const req = getApprovalRequestById(cfg.dataDir, decision.requestId);
  if (!req) throw new Error(`Approval request "${decision.requestId}" not found.`);

  // Self-approval rejection: the decided-by identity is ALWAYS the authenticated
  // caller — never the client-supplied value — so a requester cannot approve their
  // own request even by forging decidedBy.
  if (isOriginalRequester(principal, req)) {
    throw new ForbiddenError('self-approval is not permitted');
  }

  const effective: ApprovalDecision = {
    ...decision,
    decidedBy: principalSubject(principal), // server-authoritative; client value ignored
    decidedAt: new Date().toISOString(), // decision happens now, server-side
  };
  const decided = decideApprovalRequest(cfg.dataDir, effective);

  tryAppendAudit(
    cfg,
    buildAuditEvent(principal, 'approval.decided', 'security', {
      target: decided.id,
      projectId: decided.projectId,
      metadata: JSON.stringify({ approved: decision.approved }),
    }),
  );

  return decided;
}

/**
 * Authenticate the caller, look up the approved request (not-found when absent),
 * authorize the original requester or an instance-admin, require the request to be
 * in approved status (error naming the actual status) and unexpired, dispatch by
 * kind to the pre-authorized execution entry point (project:init to the policy
 * orchestrator's executeApprovedInit, which re-evaluates the active policy and may
 * reject; project:lock / project:promote to the admin plane), mark the approval
 * completed, audit at security level (best-effort), and return an outcome summary.
 * A re-evaluation failure at execution leaves the approval approved, not completed.
 * Rejects pending, denied, expired, completed, or unauthorized requests.
 */
export function executeApprovedRequest(
  cfg: HostConfig,
  credential: string | null,
  requestId: string,
): string {
  const principal = requirePrincipal(cfg, credential);

  const req = getApprovalRequestById(cfg.dataDir, requestId);
  if (!req) throw new Error(`Approval request "${requestId}" not found.`);

  if (!isOriginalRequester(principal, req) && !isInstanceAdmin(principal)) {
    throw new ForbiddenError('caller may not execute this approval request');
  }
  if (req.status !== 'approved') {
    throw new Error(`Approval request "${req.id}" is ${req.status}, not approved; it cannot be executed.`);
  }
  if (req.expiresAt !== undefined && Date.parse(req.expiresAt) <= Date.now()) {
    throw new Error(`Approval request "${req.id}" expired at ${req.expiresAt} and can no longer be executed.`);
  }

  let outcome: string;
  switch (req.kind) {
    case 'project:init': {
      if (!req.payload) {
        throw new Error(`Approved project:init request "${req.id}" is missing its payload.`);
      }
      // Execute through the policy orchestrator's pre-authorized entry (the request
      // was already authorized by the approval decision). executeApprovedInit
      // RE-EVALUATES the active policy at execution time (it may have changed since
      // the request) and applies the policy's required/default packs plus the
      // request's own profile selection — so an init approved under a permissive
      // policy still fails here if the policy has since flipped to enforcing.
      const init = JSON.parse(req.payload) as ProjectInitRequest;
      const rec = executeApprovedInit(cfg, init);
      outcome = `Initialized project "${rec.id}" under the active pack policy.`;
      break;
    }
    case 'project:lock': {
      const lock = executeApprovedLock(cfg, req.projectId ?? '');
      outcome = `Locked project "${req.projectId}" (status: ${lock.status}).`;
      break;
    }
    case 'project:promote': {
      const promo = executeApprovedPromote(cfg, req.projectId ?? '');
      outcome = `Promotion of project "${req.projectId}": ${promo.status} — ${promo.message}`;
      break;
    }
    default:
      throw new Error(`Unsupported approval kind "${req.kind}".`);
  }

  markApprovalCompleted(cfg.dataDir, req.id);

  tryAppendAudit(
    cfg,
    buildAuditEvent(principal, 'approval.executed', 'security', {
      target: req.id,
      projectId: req.projectId,
      metadata: JSON.stringify({ kind: req.kind }),
    }),
  );

  return outcome;
}
