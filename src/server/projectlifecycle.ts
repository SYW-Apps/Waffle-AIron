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
import { UnauthenticatedError, ForbiddenError } from './errors.js';
import { executeApprovedLock } from './admin.js';
import { evaluateInitRequest, executeApprovedInit } from './policy.js';
import { isValidProjectId, listProjectRecords, existingProjectRoot } from './projects.js';
import { authorize, visibleScopes, isInstanceAdmin, actionableProjectIds } from './authorization.js';
import type {
  ApprovalRequest,
  ApprovalDecision,
  AuditEvent,
  AuditRetentionPolicy,
  HostConfig,
  Principal,
  PrincipalSubject,
  ProjectActionOutcome,
  ProjectInitRequest,
} from './types.js';

// ---------------------------------------------------------------------------
// Project Lifecycle Orchestrator (sdd_host)
//
// EXECUTE-PRIMARY project lifecycle actions — initialize / lock —
// requested over MCP, CLI, or UI. The action is the caller's normal intent;
// an approval request is the EXCEPTION added for separation of duties. Every
// method authenticates the caller credential (via the auth specialist) and
// resolves their permission through the authorization seam, then acts on the
// resolved value:
//   yes      → execute directly through the pre-authorized entry points
//              (project:init through the policy orchestrator's
//              executeApprovedInit; project:lock through the admin plane's
//              executeApprovedLock) and
//              return a completed ProjectActionOutcome.
//   approval → create a pending ApprovalRequest and return a pending-approval
//              outcome; deciding it AUTO-EXECUTES the action.
//   no       → Forbidden (403).
//
// A caller whose own permission is yes executes directly and never enters the
// approval path, so the self-approval guard cannot deadlock a single-admin
// instance.
//
// Exported as plain functions in the same house shape as identity.ts
// (cfg, credential, …). Every audit append is best-effort: an append failure is
// recorded as a server diagnostic and never fails the primary action. A
// project-init request is validated structurally and then evaluated against the
// active instance pack policy — an enforcing ('block') policy rejects a
// non-compliant request immediately, while warn/auto_reconcile findings ride
// the summary.
// ---------------------------------------------------------------------------

/** Approval requests default to a 7-day pending window: long enough for an
 *  out-of-band human decision, short enough that a stale request cannot linger
 *  indefinitely. HostConfig-driven overrides are a later phase. */
const DEFAULT_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The capability that authorizes deciding/listing/viewing approval requests.
 *  Resolved hierarchically: an instance-level value decides everywhere, a
 *  unit-scoped value decides within its subtree's projects. */
const APPROVAL_DECIDE_CAPABILITY = 'approval:decide';
/** The capability that lets a caller lock a project. The legacy
 *  `mcp:write` / `lock:create` / `promote:mark-ready` permissions all map here. */
const PROJECT_WRITE_CAPABILITY = 'project:write';
/** The capability that lets a caller initialize a project into a unit. */
const PROJECT_CREATE_CAPABILITY = 'project:create';

/** awaitApproval long-poll bounds: the server re-reads the request every
 *  POLL_INTERVAL_MS until it leaves pending or the (clamped) timeout elapses. */
const AWAIT_POLL_INTERVAL_MS = 500;
const AWAIT_MAX_TIMEOUT_S = 300;

// ── authorization ────────────────────────────────────────────────────────────
//
// Every decision resolves through the permission resolver (authorization.ts).
// isInstanceAdmin is imported rather than re-implemented: the previous local
// copy had to be kept "in lockstep" with three other copies by hand, which is
// exactly how the model drifted.

/**
 * True when the caller may decide/view an approval for a request's project.
 *
 * Fails CLOSED on a request with no projectId (e.g. a project:init whose target
 * does not exist yet): only an instance-admin may decide those, because there is
 * no scope to resolve a delegated permission against.
 */
function canDecideFor(cfg: HostConfig, principal: Principal, projectId?: string): boolean {
  if (isInstanceAdmin(principal)) return true;
  if (!projectId) return false;
  return authorize(cfg.dataDir, principal, APPROVAL_DECIDE_CAPABILITY, 'project', projectId).value === 'yes';
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
      `[projectlifecycle] audit append failed for "${event.action}": ` +
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

/** Create the pending request, audit its creation, and shape the pending-approval
 *  outcome — the shared "approval exception" tail of every lifecycle action. */
function createPendingOutcome(
  cfg: HostConfig,
  principal: Principal,
  pending: ApprovalRequest,
  action: ProjectActionOutcome['action'],
): ProjectActionOutcome {
  const created = createApprovalRequest(cfg.dataDir, pending);
  tryAppendAudit(
    cfg,
    buildAuditEvent(principal, 'approval.request.created', 'info', {
      target: created.id,
      projectId: created.projectId,
    }),
  );
  return {
    status: 'pending-approval',
    action,
    summary: `Approval required: request ${created.id} submitted and awaiting a decision.`,
    approval: created,
  };
}

// ── orchestrator methods ─────────────────────────────────────────────────────

/**
 * EXECUTE-PRIMARY project initialization. Authenticate the caller, validate the
 * ProjectInitRequest structurally (id shape per the project-id rules
 * createProject enforces, non-collision, and the REQUIRED ownerUnitId — every
 * project is placed at creation so the permission resolver can always see it),
 * then evaluate it against the active instance pack policy via the policy
 * orchestrator's pre-authorized evaluation: an enforcing ('block') policy
 * rejects a non-compliant request immediately with actionable findings, while
 * warn/auto_reconcile findings ride the summary. Resolve the caller's
 * project:create permission over the owner unit:
 *   yes      → initialize directly via executeApprovedInit → completed outcome.
 *   approval → create a pending project:init ApprovalRequest → pending outcome.
 *   no       → Forbidden.
 */
export function initializeProject(
  cfg: HostConfig,
  credential: string | null,
  request: ProjectInitRequest,
): ProjectActionOutcome {
  const principal = requirePrincipal(cfg, credential);

  // Structural validation: id shape, non-collision, and the required owner unit.
  if (!isValidProjectId(request.id)) {
    throw new Error(
      `Invalid project id "${request.id}" (allowed: lowercase letters, digits, hyphen).`,
    );
  }
  if (listProjectRecords(cfg.dataDir).some((p) => p.id === request.id)) {
    throw new Error(`Project "${request.id}" already exists.`);
  }
  if (!request.ownerUnitId) {
    throw new Error(
      'ProjectInitRequest.ownerUnitId is required — every project is placed in an organization unit at creation. ' +
        'A fresh instance must create its first organization unit before initializing projects.',
    );
  }

  // Evaluate the request against the active instance pack policy through the
  // policy orchestrator's pre-authorized entry (the caller is already
  // authenticated). An enforcing policy rejects a non-compliant request up
  // front; findings are surfaced so the agent learns WHY.
  const evaluation = evaluateInitRequest(cfg, request);
  if (evaluation.mode === 'block' && !evaluation.compliant) {
    throw new ForbiddenError(`Policy violation: ${evaluation.messages.join(' ')}`);
  }

  let summary =
    `Initialize project ${request.id}` +
    (request.displayName ? ` (${request.displayName})` : '');
  // Warn/auto_reconcile findings ride the summary (and, on the approval path,
  // reach the human approver).
  if (!evaluation.compliant && evaluation.messages.length > 0) {
    summary += ` [policy findings: ${evaluation.messages.join(' ')}]`;
  }

  // Resolve project:create over the REQUIRED owner unit: yes executes, no
  // forbids, approval creates the request.
  const effective = authorize(cfg.dataDir, principal, PROJECT_CREATE_CAPABILITY, 'unit', request.ownerUnitId);
  switch (effective.value) {
    case 'yes': {
      const rec = executeApprovedInit(cfg, request);
      tryAppendAudit(
        cfg,
        buildAuditEvent(principal, 'lifecycle.completed', 'info', {
          target: rec.id,
          projectId: rec.id,
          metadata: JSON.stringify({ kind: 'project:init' }),
        }),
      );
      return {
        status: 'completed',
        action: 'project:init',
        summary: `Initialized project "${rec.id}" under the active pack policy.`,
      };
    }
    case 'no':
      throw new ForbiddenError('caller may not initialize a project in this organization unit');
    default: {
      // Approval is the exception: payload is the request itself — a
      // ProjectInitRequest carries no secrets by construction (profileSelection
      // is opaque config, not credentials).
      const pending = buildPendingRequest(principal, 'project:init', summary, request.id, {
        payloadType: 'ProjectInitRequest',
        payload: JSON.stringify(request),
      });
      return createPendingOutcome(cfg, principal, pending, 'project:init');
    }
  }
}

/**
 * EXECUTE-PRIMARY project lock: resolve the caller's project:write permission
 * over the project — yes locks directly via the admin plane's pre-authorized
 * executeApprovedLock (completed outcome carrying the lock record), approval
 * creates a pending project:lock request, no forbids.
 *
 * An optional `subproject` qualifier ('a' or 'a::b' — the mount chain only)
 * CONFINES the action to a chained child's tree: it is forwarded to the
 * pre-authorized entry, which freezes that child's own spec tree instead of the
 * whole project. Permission resolution and audit provenance stay anchored at the
 * TOP project id — a qualifier narrows which tree is acted on, never which grants
 * apply — so nothing below the switch changes.
 */
export function lockProject(
  cfg: HostConfig,
  credential: string | null,
  projectId: string,
  subproject?: string,
): ProjectActionOutcome {
  return lifecycleAction(cfg, credential, projectId, {
    action: 'project:lock',
    verb: 'Lock',
    noun: 'lock',
    subproject,
    execute: () => {
      const lock = executeApprovedLock(cfg, projectId, subproject);
      return {
        status: 'completed',
        action: 'project:lock',
        summary: `Locked project "${projectId}"${subprojectSuffix(subproject)} (status: ${lock.status}).`,
        lock,
      };
    },
  });
}

/** The completed-outcome summary fragment naming the confined child tree, empty
 *  for an unqualified action (whose wording is unchanged). */
function subprojectSuffix(subproject?: string): string {
  return subproject ? ` subproject "${subproject}"` : '';
}

/** The payloadType a lock ApprovalRequest carries when its requester was
 *  confined to a chained subproject. */
const SUBPROJECT_SCOPE_PAYLOAD = 'SubprojectScope';

/**
 * The ApprovalRequest payload fields recording a subproject qualifier — empty for
 * an unqualified request, so existing requests keep their exact shape.
 *
 * Approval is the one path where the requester does not perform the action, so the
 * qualifier has to survive on the REQUEST or the confinement is lost the moment
 * someone approves it (a subproject-bound caller would obtain a whole-project
 * lock). It rides in the existing payload/payloadType fields — the same mechanism
 * project:init already uses to carry its execution input — rather than a new
 * ApprovalRequest field, and carries no secret: a mount chain is spec topology.
 */
function subprojectScopePayload(subproject?: string): { payloadType?: string; payload?: string } {
  if (!subproject) return {};
  return { payloadType: SUBPROJECT_SCOPE_PAYLOAD, payload: JSON.stringify({ subproject }) };
}

/** The subproject qualifier recorded on an approved lock request, or
 *  undefined for an unqualified one (or a payload that does not parse — a
 *  malformed payload must not silently widen the action to the whole project,
 *  so the caller treats undefined as "no confinement was requested" only when
 *  payloadType is absent; see readSubprojectScope's callers). */
function readSubprojectScope(req: ApprovalRequest): string | undefined {
  if (req.payloadType !== SUBPROJECT_SCOPE_PAYLOAD || !req.payload) return undefined;
  const parsed = JSON.parse(req.payload) as { subproject?: unknown };
  if (typeof parsed.subproject !== 'string' || !parsed.subproject) {
    throw new Error(
      `Approved ${req.kind} request "${req.id}" carries a ${SUBPROJECT_SCOPE_PAYLOAD} payload with no usable ` +
        `subproject qualifier — refusing to execute, because falling back to the whole project would widen the ` +
        `scope the requester was confined to.`,
    );
  }
  return parsed.subproject;
}

/** Shared body for the gated lifecycle actions: authenticate → resolve
 *  project:write over the project → switch on the resolved value (yes executes
 *  through the supplied pre-authorized entry, no forbids, approval creates the
 *  pending request), differing only in the kind, wording, and execution.
 *
 *  A subproject qualifier is CLOSED OVER by opts.execute (the yes path) and is
 *  deliberately absent from this body: the permission resolved here and the audit
 *  event appended below anchor at the TOP project id, exactly as before. The
 *  APPROVAL path likewise carries no qualifier — an ApprovalRequest records only
 *  `projectId`, so a request queued from a qualified credential describes, and on
 *  approval executes, the WHOLE project (its summary says so). Confining the
 *  approval path would need a qualifier field on ApprovalRequest, i.e. a spec
 *  change; until then a qualified credential should hold a yes-valued
 *  project:write. */
function lifecycleAction(
  cfg: HostConfig,
  credential: string | null,
  projectId: string,
  opts: {
    action: 'project:lock';
    verb: string;
    noun: string;
    execute: () => ProjectActionOutcome;
    /** The bound mount chain, when the caller is confined to a chained subproject.
     *  Recorded onto an APPROVAL request so the approved execution stays confined
     *  (see subprojectScopePayload) — the direct path is confined by `execute`. */
    subproject?: string;
  },
): ProjectActionOutcome {
  const principal = requirePrincipal(cfg, credential);

  // Resolve project:write over the project through the permission resolver: the
  // leaf->root walk reaches a project-scoped value, a unit-scoped value for the
  // subtree it is placed in, or an instance-level default — so a unit admin is
  // first-class over their subtree and nobody reaches across tenants.
  const effective = authorize(cfg.dataDir, principal, PROJECT_WRITE_CAPABILITY, 'project', projectId);
  switch (effective.value) {
    case 'yes': {
      // The pre-authorized entries validate existence themselves (Unknown project).
      const outcome = opts.execute();
      tryAppendAudit(
        cfg,
        buildAuditEvent(principal, 'lifecycle.completed', 'security', {
          target: projectId,
          projectId,
          metadata: JSON.stringify({ kind: opts.action }),
        }),
      );
      return outcome;
    }
    case 'no':
      throw new ForbiddenError(`caller may not ${opts.noun} this project`);
    default: {
      if (!existingProjectRoot(cfg.dataDir, projectId)) {
        throw new Error(`Unknown project "${projectId}".`);
      }
      // A subproject-bound caller must not be able to obtain a WHOLE-PROJECT
      // action by routing through approval: record the qualifier on the request
      // (the same payload mechanism a project:init request uses to carry its
      // execution input) so executeApproved forwards it, and name the subproject
      // in the summary so an approver sees the real scope before deciding.
      const pending = buildPendingRequest(
        principal,
        opts.action,
        `${opts.verb} project ${projectId}${subprojectSuffix(opts.subproject)}`,
        projectId,
        subprojectScopePayload(opts.subproject),
      );
      return createPendingOutcome(cfg, principal, pending, opts.action);
    }
  }
}

/**
 * Authenticate the caller, lazily expire overdue pending requests first, look up
 * the request by id (not-found error when absent), and return it only to its
 * original requester (matching subject or requesting token id) or to a caller
 * whose RESOLVED approval:decide scope covers the request's project — the same
 * point-check decideRequest applies, so view authority equals decide authority.
 * Unrelated callers are denied. Read — no audit event.
 */
export function getApprovalStatus(
  cfg: HostConfig,
  credential: string | null,
  requestId: string,
): ApprovalRequest {
  const principal = requirePrincipal(cfg, credential);
  expirePendingApprovals(cfg.dataDir, new Date().toISOString());

  const req = getApprovalRequestById(cfg.dataDir, requestId);
  if (!req) throw new Error(`Approval request "${requestId}" not found.`);

  // Visible to the original requester, or to a caller whose resolved
  // approval:decide scope permits the request's project (a request with no
  // projectId is visible only to a super-admin — permits fails closed). A flat
  // instance-permission check would let a unit-scoped '*'+orgUnitId grant view
  // ANY tenant's requests.
  if (!isOriginalRequester(principal, req) && !canDecideFor(cfg, principal, req.projectId)) {
    throw new ForbiddenError('caller may not view this approval request');
  }
  return req;
}

/**
 * Authenticate the caller, authorize by the resolved approval:decide permission
 * (or instance-admin), lazily expire overdue pending requests first, then list
 * the pending approval requests, optionally narrowed to one project. Read — no
 * audit event.
 */
export function listPendingRequests(
  cfg: HostConfig,
  credential: string | null,
  projectId?: string,
): ApprovalRequest[] {
  const principal = requirePrincipal(cfg, credential);
  const admin = isInstanceAdmin(principal);
  const decidable = admin
    ? []
    : actionableProjectIds(visibleScopes(cfg.dataDir, principal, APPROVAL_DECIDE_CAPABILITY));
  if (!admin && decidable.length === 0) {
    throw new ForbiddenError('deciding approvals requires approval:decide over at least one project');
  }
  expirePendingApprovals(cfg.dataDir, new Date().toISOString());
  const pending = listApprovalRequests(cfg.dataDir, 'pending', projectId);
  if (admin) return pending;
  // Filter to requests whose project the caller may decide (honoring any optional
  // project narrowing already applied above). A request with no projectId is
  // instance-admin-only, so it is excluded here — fail closed.
  const inScope = new Set(decidable);
  return pending.filter((r) => r.projectId !== undefined && inScope.has(r.projectId));
}

/**
 * Authenticate the caller, authorize by the resolved approval:decide permission
 * over the request's project, look up the request (not-found when absent), derive
 * the decided-by identity from the AUTHENTICATED caller (the client-supplied
 * decidedBy is never trusted and is overwritten), reject self-approval (the
 * caller is the original requester — a yes-permission caller executes directly
 * and never enters the approval path, so this guard cannot deadlock), record the
 * approval/denial through the repository, then AUTO-EXECUTE an approved request
 * immediately through the pre-authorized entry points and mark it completed.
 * Audits at security level (best-effort) and returns the request in its final
 * state (completed after a successful auto-execution). An execution failure
 * propagates and leaves the approval APPROVED, not completed — retryable via
 * executeApprovedRequest.
 */
export function decideRequest(
  cfg: HostConfig,
  credential: string | null,
  decision: ApprovalDecision,
): ApprovalRequest {
  const principal = requirePrincipal(cfg, credential);

  const req = getApprovalRequestById(cfg.dataDir, decision.requestId);
  if (!req) throw new Error(`Approval request "${decision.requestId}" not found.`);

  // Point-check: the caller must hold approval:decide over the request's project.
  // A request with no projectId (e.g. a project:init whose target does not exist
  // yet) is decidable only by an instance-admin — canDecideFor fails closed.
  if (!canDecideFor(cfg, principal, req.projectId)) {
    throw new ForbiddenError("deciding this approval requires approval:decide over the request's project");
  }

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

  // Approved = done: auto-execute through the pre-authorized entry points and
  // mark completed, so the requester's awaitApproval resolves to a finished
  // action. An execution failure propagates AFTER the decision was durably
  // recorded — the approval stays approved (not completed) and is retryable via
  // executeApprovedRequest.
  let final = decided;
  if (decided.status === 'approved') {
    executeApproved(cfg, decided);
    markApprovalCompleted(cfg.dataDir, decided.id);
    final = getApprovalRequestById(cfg.dataDir, decided.id) ?? decided;
  }

  tryAppendAudit(
    cfg,
    buildAuditEvent(principal, 'approval.decided', 'security', {
      target: decided.id,
      projectId: decided.projectId,
      metadata: JSON.stringify({ approved: decision.approved, autoExecuted: decided.status === 'approved' }),
    }),
  );

  return final;
}

/** Dispatch an APPROVED request to its pre-authorized execution entry point by
 *  kind, returning the human-readable outcome. Shared by decideRequest's
 *  auto-execution and the manual executeApprovedRequest retry path. */
function executeApproved(cfg: HostConfig, req: ApprovalRequest): string {
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
      return `Initialized project "${rec.id}" under the active pack policy.`;
    }
    case 'project:lock': {
      // Forward the qualifier the requester was confined to, so approving a
      // subproject-scoped request freezes THAT child tree — an approval must never
      // widen the scope its requester was bound to.
      const scope = readSubprojectScope(req);
      const lock = executeApprovedLock(cfg, req.projectId ?? '', scope);
      return `Locked project "${req.projectId}"${subprojectSuffix(scope)} (status: ${lock.status}).`;
    }
    default:
      throw new Error(`Unsupported approval kind "${req.kind}".`);
  }
}

/**
 * Authenticate the caller, look up the approved request (not-found when absent),
 * authorize the original requester or an instance-admin, require the request to be
 * in approved status (error naming the actual status) and unexpired, dispatch by
 * kind to the pre-authorized execution entry point (project:init to the policy
 * orchestrator's executeApprovedInit, which re-evaluates the active policy and may
 * reject; project:lock to the admin plane), mark the approval
 * completed, audit at security level (best-effort), and return an outcome summary.
 * The manual retry path behind decideRequest's auto-execution. A re-evaluation
 * failure at execution leaves the approval approved, not completed. Rejects
 * pending, denied, expired, completed, or unauthorized requests.
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

  const outcome = executeApproved(cfg, req);

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

/**
 * Long-poll for a decision so an MCP agent can wait then continue: authenticate
 * the caller (ONLY the original requester may await), then block server-side
 * re-reading the request until it leaves pending status (approved / denied /
 * completed / expired) or the timeout elapses, and return the request in its
 * current state. Pairs with decideRequest's auto-execution, so an approved
 * request returns already completed. The timeout is clamped to
 * [0, AWAIT_MAX_TIMEOUT_S]; a zero timeout returns the current state
 * immediately. Read — no audit event.
 */
export async function awaitApproval(
  cfg: HostConfig,
  credential: string | null,
  requestId: string,
  timeoutSeconds: number,
): Promise<ApprovalRequest> {
  const principal = requirePrincipal(cfg, credential);

  const req = getApprovalRequestById(cfg.dataDir, requestId);
  if (!req) throw new Error(`Approval request "${requestId}" not found.`);

  if (!isOriginalRequester(principal, req)) {
    throw new ForbiddenError('only the original requester may await this request');
  }

  const clamped = Math.max(0, Math.min(Number.isFinite(timeoutSeconds) ? timeoutSeconds : 0, AWAIT_MAX_TIMEOUT_S));
  const deadline = Date.now() + clamped * 1000;

  let current = req;
  while (current.status === 'pending' && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(AWAIT_POLL_INTERVAL_MS, remaining)));
    // Realize any lazy expiry, then re-read the current state.
    expirePendingApprovals(cfg.dataDir, new Date().toISOString());
    current = getApprovalRequestById(cfg.dataDir, requestId) ?? current;
  }
  return current;
}
