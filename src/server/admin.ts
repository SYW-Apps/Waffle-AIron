import * as crypto from 'crypto';
import { runWithProjectRoot } from '../utils/fs.js';
import { WAIRON_VERSION } from '../config/defaults.js';

import type { LockRecord, MemberPin } from '../core/lockfile.js';
import type { StateId } from '../core/statehash.js';
import type { ValidationResult } from '../core/validation.js';
import type { ProjectConfig } from '../models/project.js';
import { designOnly, type ApproverIdentity, type CodeAnalysis, type ProjectApproval } from '../models/lock.js';
import { effectiveProjectId } from '../models/project.js';
import { authenticateMaster, authenticateCredential, signViewToken } from './auth.js';
import { authorize } from './authorization.js';
import { placeProject, listOrganizationUnits } from './organization.js';
import {
  hashToken,
  createCredential,
  revokeCredential,
  listCredentials,
} from './credentials.js';
import {
  createProjectRecord,
  registerProjectRecord,
  listProjectRecords,
  removeProjectRecord,
  existingProjectRoot,
  resolveSubprojectMounts,
  SUBPROJECT_SEPARATOR,
} from './projects.js';
import * as hostCore from './adapters/core.js';
import * as hostGit from './adapters/git.js';
import * as hostProducer from './adapters/producer.js';
import { validateAsComplete, computeGateStateId, familyApprovals } from './adapters/validator.js';
import type { TreeExportResult, TreeImportResult } from '../core/treetransfer.js';
import type { GitBackingStatus, GitPublish } from '../git/index.js';
// The secret store's write is reached through its module namespace: this module
// exports its own credential-checked setSecret, and a call written through an
// import alias is one the call-graph conformance analysis cannot follow.
import * as secretStore from '../utils/secrets.js';
import { listSecretKeys, resolveSecret } from '../utils/secrets.js';
import type { ProducerConfig } from '../producers/index.js';
import type {
  ApiKeyRecord,
  HostConfig,
  HostedProjectRecord,
  Principal,
  PrincipalSubject,
  DisplayRole,
} from './types.js';

// ---------------------------------------------------------------------------
// Admin Orchestrator (sdd_host)
//
// The control-plane workflows: master-credential auth, then project/key
// lifecycle and the state-scoped lock. Exported as plain functions so BOTH
// entry points reach the same logic — the HTTP admin portal
// (src/server/http.ts) and the in-process local admin portal
// (src/server/local-admin.ts), which the CLI reaches through its adapter.
// Never performs a merge: a lock records an approval, and a human merges the PR
// the git-backed publish opens.
// ---------------------------------------------------------------------------

// AdminAuthError lives with the shared control-plane errors; republished here
// as the historical import site for the admin plane's consumers.
import { AdminAuthError } from './errors.js';
export { AdminAuthError } from './errors.js';

export class LockValidationError extends Error {
  constructor(public readonly errors: { code: string; message: string; specId?: string }[]) {
    super(`Cannot lock: the spec tree does not validate as-complete (${errors.length} error(s)).`);
    this.name = 'LockValidationError';
  }
}

function requireAdmin(credential: string | null): void {
  if (!authenticateMaster(credential).authenticated) throw new AdminAuthError();
}

/**
 * Authenticate the caller credential (bootstrap master — which resolves to an
 * instance-wide super-admin — or a user-bound token) to a Principal, or reject.
 * Mirrors identity.ts's requirePrincipal, but throws the admin-plane AdminAuthError
 * (→ 403) so an unauthenticated request is rejected exactly as the former
 * master-only gate did. Scope, not authentication, decides authority afterwards.
 */
function requirePrincipal(cfg: HostConfig, credential: string | null): Principal {
  const principal = authenticateCredential(cfg.dataDir, credential);
  if (!principal.authenticated) throw new AdminAuthError();
  return principal;
}

/** The audit/placement subject for a principal: its resolved subject, or a
 *  synthesized service identity keyed by the token id for legacy credentials. */
function principalSubject(principal: Principal): PrincipalSubject {
  return (
    principal.subject ?? { userId: 'token:' + principal.tokenId, kind: 'service', issuer: 'local' }
  );
}

/**
 * Authenticate the caller, validate the REQUIRED target unit (every project is
 * placed at creation so permission rules can always enumerate it — a
 * fresh instance must create its first organization unit before creating
 * projects; `wairon dev` provisions a synthetic local unit at boot), resolve the
 * caller's project:create permission over that unit (must be yes; an
 * approval-valued caller must use the execute-primary project-lifecycle path),
 * then allocate, provision, and place the project.
 */
export function createProject(
  cfg: HostConfig,
  credential: string | null,
  id: string,
  unitId: string,
): HostedProjectRecord {
  const principal = requirePrincipal(cfg, credential);

  // Validate the REQUIRED target unit up front (missing or unknown rejects) and
  // resolve the caller's project:create permission over it — a creator must hold
  // project:create over THE unit the project is placed in (an instance-admin
  // passes via the permission-rules bypass).
  requireExistingUnit(cfg, unitId);
  if (authorize(cfg.dataDir, principal, 'project:create', 'unit', unitId).value !== 'yes') {
    throw new AdminAuthError(
      'Forbidden — creating a project requires project:create over the target organization unit',
    );
  }

  // Allocate, provision, place, and bind the isolated tree (steps 6–9).
  return executeApprovedCreate(cfg, id, unitId, principalSubject(principal));
}

/** Reject a missing or unknown target organization unit. Every project is
 *  placed at creation; a fresh instance must create its first unit before
 *  creating projects (`wairon dev` provisions a synthetic local unit at boot). */
function requireExistingUnit(cfg: HostConfig, unitId: string): void {
  if (!unitId) {
    throw new Error(
      'A target organization unit is required — every project is placed at creation. ' +
        'Create an organization unit first, then create the project into it.',
    );
  }
  if (!listOrganizationUnits(cfg.dataDir).some((u) => u.id === unitId)) {
    throw new Error(`Unknown organization unit "${unitId}".`);
  }
}

/**
 * Pre-authorized entry for the approval workflow: the same privileged action as
 * createProject but WITHOUT credential authentication — the caller
 * (project_lifecycle_orchestrator) has already enforced permission-based
 * authorization. Creates the project AND places it in the REQUIRED owner unit,
 * so the approval path can never mint an unplaced project. Never routed from
 * any portal.
 */
export function executeApprovedCreate(
  cfg: HostConfig,
  id: string,
  unitId: string,
  placedBy?: PrincipalSubject,
): HostedProjectRecord {
  requireExistingUnit(cfg, unitId);
  const rec = createProjectRecord(cfg.dataDir, id);
  runWithProjectRoot(rec.rootPath, () => hostCore.provisionProject(id));
  placeProject(cfg.dataDir, {
    id: '',
    projectId: id,
    unitId,
    role: 'owner',
    createdAt: '',
    createdBy: placedBy ?? { userId: 'system', kind: 'service', issuer: 'local' },
  });
  return rec;
}

export function destroyProject(cfg: HostConfig, credential: string | null, id: string): void {
  const principal = requirePrincipal(cfg, credential);
  if (authorize(cfg.dataDir, principal, 'project:admin', 'project', id).value !== 'yes') {
    throw new AdminAuthError('Forbidden — destroying a project requires project:admin over it');
  }
  removeProjectRecord(cfg.dataDir, id);
}

/**
 * Register the local development server's single project at the developer's
 * own working directory (upsert by id). `wairon dev` runs with auth off and no
 * credential exists, so the workflow admits only a development-mode host
 * configuration and refuses every other.
 */
export function registerLocalDevProject(cfg: HostConfig, id: string, rootPath: string): HostedProjectRecord {
  // Step 1–2: only a development-mode configuration may register a project at a caller-named directory
  if (!cfg.devMode) {
    throw new Error('Registering a project at a working directory is reserved for the local development server.');
  }
  // Step 3–4: register the record and return it
  return registerProjectRecord(cfg.dataDir, id, rootPath);
}

export function listProjects(cfg: HostConfig, credential: string | null): HostedProjectRecord[] {
  requireAdmin(credential);
  return listProjectRecords(cfg.dataDir);
}

export function mintKey(cfg: HostConfig, credential: string | null, project: string, role: DisplayRole): string {
  requireAdmin(credential);
  // Strict "built-in is the only super-admin": a '*' project narrowing or the
  // legacy admin display role would mint an instance-wide bearer — a second
  // super-admin route beside the env-anchored built-in account. Only
  // project-scoped, non-super-admin keys are mintable. The WAIRON_ADMIN_TOKEN
  // master principal and the built-in password login are NOT minted keys and
  // remain the only instance-admins (their auth paths are untouched).
  if (role === 'admin' || project === '*') {
    throw new Error(
      'instance-wide super-admin (*:*) keys cannot be minted — the built-in admin account (WAIRON_ADMIN_USER) is the only super-admin',
    );
  }
  const token = 'wk_' + crypto.randomBytes(24).toString('hex');
  const record: ApiKeyRecord = {
    id: crypto.randomBytes(6).toString('hex'),
    keyHash: hashToken(token),
    role,
    projects: project === '*' ? ['*'] : [project],
    createdAt: new Date().toISOString(),
  };
  createCredential(cfg.dataDir, record);
  return token; // plaintext, shown once
}

export function revokeKey(cfg: HostConfig, credential: string | null, id: string): void {
  requireAdmin(credential);
  revokeCredential(cfg.dataDir, id);
}

export function listKeys(cfg: HostConfig, credential: string | null, project: string): ApiKeyRecord[] {
  requireAdmin(credential);
  return listCredentials(cfg.dataDir, project);
}

export function lockProject(cfg: HostConfig, credential: string | null, project: string): LockRecord {
  const principal = requirePrincipal(cfg, credential);
  if (authorize(cfg.dataDir, principal, 'project:write', 'project', project).value !== 'yes') {
    throw new AdminAuthError('Forbidden — locking a project requires project:write over it');
  }
  return executeApprovedLock(cfg, project, hostedApprover(principal.subject));
}

/**
 * The hosted caller as the identity a lock records.
 *
 * This is the one surface where wairon actually AUTHENTICATED who is approving —
 * the instance issued the credential and resolved it to a subject — so the
 * record says so (`source: 'hosted'`) rather than settling for the self-declared
 * git or machine identity a local lock has to use. It previously wrote the
 * constant 'admin:master' and threw the real identity away.
 *
 * No subject means the bootstrap master credential: a real actor, but an
 * instance-wide one belonging to no user, and named as exactly that.
 */
export function hostedApprover(subject?: PrincipalSubject): ApproverIdentity {
  if (!subject) return { id: 'master', name: 'instance master credential', source: 'hosted' };
  return {
    id: subject.userId,
    ...(subject.displayName ? { name: subject.displayName } : {}),
    source: 'hosted',
  };
}

/**
 * Step 1 of executeApprovedLock: the root the action
 * concerns. Without a qualifier that is the project's own isolated root; WITH one
 * it is the CHAINED CHILD's tree, resolved through the project registry's
 * containment-checked qualified resolution — the SAME seam the data plane binds
 * through, so a qualifier can never resolve outside the project root.
 *
 * `subproject` is the member chain only ('a' or 'a::b', one member alias per
 * hop), exactly as ProjectBinding.subproject carries it — never the project id.
 * An alias that declares no member, an internal subsystem, or an escaping path
 * THROWS (the helper's
 * own actionable errors): the resolution never silently falls back to the project
 * root, because that fallback is precisely the confinement failure being closed.
 */
function boundLifecycleRoot(cfg: HostConfig, projectId: string, subproject?: string): string {
  const root = existingProjectRoot(cfg.dataDir, projectId);
  if (!root) throw new Error(`Unknown project "${projectId}".`);
  if (!subproject) return root;
  return resolveSubprojectMounts(projectId, root, subproject.split(SUBPROJECT_SEPARATOR));
}

/**
 * Thrown when a hosted lock refuses before writing anything for a reason other
 * than design errors: the design moved after the lock was requested, an input
 * moved while the lock ran, or composition.requireApprovedMembers found a
 * direct member not approved. Nothing is written in any of these cases.
 */
class LockRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockRefusedError';
  }
}

/** A gate identity rendered the way requests and member pins store it. */
function renderIdentity(stateId: StateId): string {
  return `${stateId.algorithm}:${stateId.digest}`;
}

/**
 * The gate identity of the tree a lock of this project (or of the member the
 * qualifier binds) would certify NOW, rendered `<algorithm>:<digest>`.
 * Pre-authorized like executeApprovedLock and for the same caller: the project
 * lifecycle orchestrator records it on a project:lock request when the request
 * is created, so the approved execution can refuse a tree that moved after the
 * request. Read-only: no sync, no validation, no write.
 */
export function gateIdentity(cfg: HostConfig, projectId: string, subproject?: string): string {
  const root = boundLifecycleRoot(cfg, projectId, subproject);
  return runWithProjectRoot(root, () => renderIdentity(computeGateStateId()));
}

/**
 * Pre-authorized entry for the approval workflow: the same privileged action as
 * lockProject but WITHOUT credential authentication — the caller
 * (project_lifecycle_orchestrator, or lockProject after its own authorization)
 * has already enforced permission-based authorization and resolved `approver`
 * from the credential. Never routed from any portal.
 *
 * The same flow as the local `wairon lock` (stage 5): the gate identity is
 * CAPTURED before validation; an `expected` identity (an approval request's
 * gateStateId) must equal it; only the DESIGN half of the as-complete run may
 * refuse (code findings are recorded beside the claim as `code`);
 * composition.requireApprovedMembers refuses while a direct member is drifted
 * or never approved; the identity is re-confirmed before the record is
 * written; and the record is format 2 (`members`, never `children`). It
 * writes one file, the bound root's .wai/lock.json, and nothing below it.
 *
 * An optional `subproject` qualifier binds the member's tree instead of the
 * project's own. The git binding is read from the BOUND root, so a member
 * carries none and both the sync and the publish no-op naturally — a member
 * lock never commits or pushes against the parent's repository. The frozen
 * member tree persists in the project's working tree but is NOT staged by the
 * project's own .wai/-scoped commit: a member lives outside that pathspec.
 */
export function executeApprovedLock(
  cfg: HostConfig,
  projectId: string,
  approver: ApproverIdentity,
  subproject?: string,
  expected?: string,
): LockRecord {
  const root = boundLifecycleRoot(cfg, projectId, subproject);
  return runWithProjectRoot(root, () => {
    // Git-backed: pull the default branch into the working branch first so the
    // lock (and PR) is based on the latest. No-op for native projects.
    hostGit.sync();
    // Capture what the record will certify before anything is judged.
    const captured = computeGateStateId();
    refuseUnrequestedDesign(captured, expected);
    const gate = validateAsComplete();
    const design = refuseDesignErrors(gate);
    const members = familyApprovals(1).filter((a) => a.parent === '');
    const config = hostCore.loadProjectConfig();
    refuseUnapprovedMembers(config?.composition?.requireApprovedMembers === true, members);
    const specs = hostCore.captureApprovedSpecs();
    // Did any input move while the lock ran? Then the validation just
    // performed does not describe what would be recorded.
    refuseMovedInputs(captured, computeGateStateId());
    const record = lockRecordOf(captured, approver, design, gate, config, specs, members);
    // Write the record BEFORE publishing, so the commit that ships the specs
    // also contains the approval that certifies them.
    hostCore.writeLockRecord(record);
    return publishLock(record);
  });
}

/** Refuse, writing nothing, when the lock was requested about a different design. */
function refuseUnrequestedDesign(captured: StateId, expected: string | undefined): void {
  if (expected === undefined || renderIdentity(captured) === expected) return;
  throw new LockRefusedError(
    'The design changed since the lock was requested — approving now would certify a design nobody asked '
      + `to have approved (requested at ${expected}, now ${renderIdentity(captured)}). Nothing was written; `
      + 'the requester asks again.',
  );
}

/** The design half of the as-complete run, or a refusal naming its errors. */
function refuseDesignErrors(gate: ValidationResult): ValidationResult {
  const design = designOnly(gate);
  const errors = design.issues.filter((i) => i.severity === 'error');
  if (errors.length) {
    throw new LockValidationError(errors.map((e) => ({ code: e.code, message: e.message, specId: e.specId })));
  }
  return design;
}

/** composition.requireApprovedMembers: refuse, naming each direct member not approved. */
function refuseUnapprovedMembers(required: boolean, members: ProjectApproval[]): void {
  const unapproved = members.filter((m) => m.state !== 'approved');
  if (!required || unapproved.length === 0) return;
  const named = unapproved.map((m) => `${m.alias ?? m.key} (${m.state}${
    m.upgraded ? ' — approved under the pre-stage-5 identity, re-lock it once' : ''})`);
  throw new LockRefusedError(
    `composition.requireApprovedMembers: direct member(s) not approved — ${named.join(', ')}. `
      + 'Lock each at its own root first; a parent never approves below itself. Nothing was written.',
  );
}

/** Refuse, writing nothing, when the gate identity moved between capture and write. */
function refuseMovedInputs(captured: StateId, now: StateId): void {
  if (now.algorithm === captured.algorithm && now.digest === captured.digest) return;
  throw new LockRefusedError(
    'The lock\'s inputs changed while it ran — a spec, the doctrine, an input, the composition block or a '
      + 'member\'s approval moved between the validation and the write. Nothing was written; run the lock again.',
  );
}

/** A format-2 record at the captured identity: members and code beside the claim, never `children`. */
function lockRecordOf(
  captured: StateId,
  approver: ApproverIdentity,
  design: ValidationResult,
  gate: ValidationResult,
  config: ProjectConfig | null,
  specs: LockRecord['specs'],
  members: ProjectApproval[],
): LockRecord {
  const count = (severity: string): number => design.issues.filter((i) => i.severity === severity).length;
  // The bound tree's effective id, so a later id change is caught (PROJECT_ID_CHANGED).
  const projectId = config ? effectiveProjectId(config) : null;
  return {
    format: 2,
    stateId: captured,
    lockedAt: new Date().toISOString(),
    lockedBy: approver,
    validatorVersion: WAIRON_VERSION,
    validationResult: { valid: design.valid, errors: count('error'), warnings: count('warning'), notices: count('notice') },
    status: 'ready',
    ...(projectId !== null ? { projectId } : {}),
    specs,
    members: memberPins(members),
    ...(gate.analysis ? { code: withoutCodes(gate.analysis) } : {}),
  };
}

/** Each direct member's alias → {project, subject, state} as it stands now. */
function memberPins(members: ProjectApproval[]): Record<string, MemberPin> {
  const pins: Record<string, MemberPin> = {};
  for (const m of members) {
    pins[m.alias ?? m.key] = {
      ...(m.projectId !== undefined ? { project: m.projectId } : {}),
      ...(m.subject !== undefined ? { subject: m.subject } : {}),
      state: m.state,
    };
  }
  return pins;
}

/** The analysis as a lock records it: its codes list is noise the analyzer identity already pins. */
function withoutCodes(analysis: CodeAnalysis): CodeAnalysis {
  const { codes: _codes, ...rest } = analysis;
  return rest;
}

/**
 * Git-backed: the lock is the semantic checkpoint — commit ONLY the .wai/ tree
 * (pathspec-scoped) with a message referencing the certified identity, and
 * push. No-op for a native project and for a member-scoped lock (no binding at
 * the bound member root). Only a real publish has a commit to record: the two
 * published fields are known only AFTER the commit, so they are re-written into
 * a record the commit already carries.
 */
function publishLock(record: LockRecord): LockRecord {
  const publish = hostGit.publish(`wairon lock: ${record.projectId ?? 'project'} @ ${renderIdentity(record.stateId)}`);
  if (!publish.published) return record;
  const published: LockRecord = { ...record, commitSha: publish.commitSha, compareUrl: publish.compareUrl };
  hostCore.writeLockRecord(published);
  return published;
}

// ── Git backing ─────────────────────────────────────────────────────────────
//
// The per-project binding is to the project's REAL repository: wairon manages
// ONLY the .wai/ tree inside it (commits are pathspec-scoped, never
// `git add -A`), so the repository is safely shared with the team's own code.

/** Bind a fresh project to its REAL repository (clones the remote onto an
 *  isolated working branch). Binding is project administration. */
/** The per-project git connection's own PAT lives under this secret key; the
 *  binding resolves it first, then the shared instance-wide `git-token`. */
export function projectGitCredentialKey(project: string): string {
  return `git-project:${project}`;
}

export function enableGit(
  cfg: HostConfig,
  credential: string | null,
  project: string,
  remote: string,
  branch: string,
  pat?: string,
): HostedProjectRecord {
  const principal = requirePrincipal(cfg, credential);
  if (authorize(cfg.dataDir, principal, 'project:admin', 'project', project).value !== 'yes') {
    throw new AdminAuthError('Forbidden — binding a repository requires project:admin over the project');
  }
  if (existingProjectRoot(cfg.dataDir, project)) {
    throw new Error(`Project "${project}" already exists; destroy it first to git-enable a fresh clone.`);
  }
  // A PAT supplied inline becomes this connection's own credential (project:admin
  // over the project authorizes storing its scoped git secret). Stored BEFORE the
  // clone so authentication is available; a connection without a PAT falls back
  // to the shared git-token.
  let credentialRef: string | undefined;
  if (pat && pat.trim()) {
    credentialRef = projectGitCredentialKey(project);
    secretStore.setSecret(credentialRef, pat.trim());
  }
  const rec = createProjectRecord(cfg.dataDir, project); // empty dir + record (no native provisioning)
  // The clone authenticates with the token the host resolves and hands in: the
  // connection's own PAT when it has one, else the shared git-token.
  const token = gitToken(credentialRef);
  runWithProjectRoot(rec.rootPath, () => hostGit.enable(remote, branch || 'main', token, credentialRef));
  return rec;
}

/**
 * The git token for one connection, resolved from the host's own secret
 * repository: the connection's own credential ref first, when it has one, so
 * each connection can carry a distinct PAT, then the shared `git-token`. Null
 * when neither is set (a public remote clones without one).
 */
function gitToken(credentialRef?: string): string | null {
  const own = credentialRef ? resolveSecret(credentialRef) : null;
  return own ?? resolveSecret('git-token');
}

/** Disable git backing for a project (clears the binding; the checkout stays). */
export function disableGit(cfg: HostConfig, credential: string | null, project: string): void {
  const principal = requirePrincipal(cfg, credential);
  if (authorize(cfg.dataDir, principal, 'project:admin', 'project', project).value !== 'yes') {
    throw new AdminAuthError('Forbidden — unbinding a repository requires project:admin over the project');
  }
  const root = existingProjectRoot(cfg.dataDir, project);
  if (!root) throw new Error(`Unknown project "${project}".`);
  runWithProjectRoot(root, () => hostGit.disable());
}

/** Sync a project's default branch into its working branch. */
export function syncGit(cfg: HostConfig, credential: string | null, project: string): void {
  const principal = requirePrincipal(cfg, credential);
  if (authorize(cfg.dataDir, principal, 'project:write', 'project', project).value !== 'yes') {
    throw new AdminAuthError('Forbidden — syncing a project\'s repository requires project:write over it');
  }
  const root = existingProjectRoot(cfg.dataDir, project);
  if (!root) throw new Error(`Unknown project "${project}".`);
  runWithProjectRoot(root, () => hostGit.sync());
}

/**
 * Publish a DELIBERATE, SCOPED backup commit: stage ONLY .wai/ (or the finer
 * .wai/specs/<subsystem>/ subpath when given), commit, and push — commit is the
 * local save, push is the actual backup; both happen. A clean scope publishes
 * nothing. CAVEAT: a subsystem-scoped commit is a staging convenience only —
 * git history is per-repo, so the log still interleaves all commits; the
 * project is the clean unit.
 */
export function commitProject(
  cfg: HostConfig,
  credential: string | null,
  project: string,
  subsystem?: string,
  message?: string,
): GitPublish {
  const principal = requirePrincipal(cfg, credential);
  if (authorize(cfg.dataDir, principal, 'project:write', 'project', project).value !== 'yes') {
    throw new AdminAuthError('Forbidden — committing a project\'s specs requires project:write over it');
  }
  const root = existingProjectRoot(cfg.dataDir, project);
  if (!root) throw new Error(`Unknown project "${project}".`);
  const scope = subsystem ? `.wai/specs/${subsystem}/` : '.wai/';
  const msg =
    message ??
    `wairon commit: ${project}${subsystem ? ` (${subsystem})` : ''} @ ${new Date().toISOString()}`;
  return runWithProjectRoot(root, () => hostGit.publish(msg, scope));
}

/** Read a project's git-backing status (remote/branch, sync setting, scoped
 *  .wai/ dirtiness). A read; not audited. */
export function getGitBinding(cfg: HostConfig, credential: string | null, project: string): GitBackingStatus {
  const principal = requirePrincipal(cfg, credential);
  if (authorize(cfg.dataDir, principal, 'project:admin', 'project', project).value !== 'yes') {
    throw new AdminAuthError('Forbidden — reading a project\'s git binding requires project:admin over it');
  }
  const root = existingProjectRoot(cfg.dataDir, project);
  if (!root) throw new Error(`Unknown project "${project}".`);
  return runWithProjectRoot(root, () => hostGit.status());
}

/** Persist a project's periodic-sync setting (interval + skip-if-clean; an
 *  absent interval disables periodic sync). Binding administration. */
export function configureGitSync(
  cfg: HostConfig,
  credential: string | null,
  project: string,
  periodicSyncMinutes?: number,
  skipIfClean?: boolean,
): void {
  const principal = requirePrincipal(cfg, credential);
  if (authorize(cfg.dataDir, principal, 'project:admin', 'project', project).value !== 'yes') {
    throw new AdminAuthError('Forbidden — configuring the periodic sync requires project:admin over the project');
  }
  const root = existingProjectRoot(cfg.dataDir, project);
  if (!root) throw new Error(`Unknown project "${project}".`);
  runWithProjectRoot(root, () => hostGit.configureSync(periodicSyncMinutes, skipIfClean));
}

/**
 * Pre-authorized sweep for the host supervisor's periodic backup timer — NO
 * authentication; never exposed on any portal. For each git-bound project whose
 * binding enables periodic sync and whose interval has elapsed, publish a
 * .wai/-scoped commit+push, skipping clean projects (skip-if-clean) so a quiet
 * project never commits noise. One project's failure never aborts the sweep.
 */
export function runPeriodicGitSync(cfg: HostConfig): void {
  for (const rec of listProjectRecords(cfg.dataDir)) {
    try {
      runWithProjectRoot(rec.rootPath, () => {
        const backing = hostGit.status();
        if (!backing.enabled || backing.periodicSyncMinutes === undefined) return;
        const due =
          backing.lastSyncAt === undefined ||
          Date.now() - Date.parse(backing.lastSyncAt) >= backing.periodicSyncMinutes * 60_000;
        if (!due) return;
        if (backing.skipIfClean !== false && backing.dirty !== true) return;
        hostGit.publish(`wairon periodic sync: ${rec.id} @ ${new Date().toISOString()}`);
      });
    } catch (err) {
      console.error(
        `[git-sync] periodic publish failed for "${rec.id}": ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}

// ── Producers ───────────────────────────────────────────────────────────────

function boundProject(cfg: HostConfig, project: string): string {
  const root = existingProjectRoot(cfg.dataDir, project);
  if (!root) throw new Error(`Unknown project "${project}".`);
  return root;
}

/** A producer publishes the project's specs to an external target — project
 *  administration. Shared gate for the four producer methods. */
function requireProducerAdmin(cfg: HostConfig, credential: string | null, project: string, verb: string): void {
  const principal = requirePrincipal(cfg, credential);
  if (authorize(cfg.dataDir, principal, 'project:admin', 'project', project).value !== 'yes') {
    throw new AdminAuthError(`Forbidden — ${verb} requires project:admin over the project`);
  }
}

export function configureProducer(cfg: HostConfig, credential: string | null, project: string, target: string, parentPageId: string): void {
  requireProducerAdmin(cfg, credential, project, 'configuring a producer');
  runWithProjectRoot(boundProject(cfg, project), () => hostProducer.configure(target, parentPageId));
}

export async function produceProducer(cfg: HostConfig, credential: string | null, project: string, target: string): Promise<void> {
  requireProducerAdmin(cfg, credential, project, 'running a producer');
  const root = boundProject(cfg, project);
  const base = process.env['WAIRON_PUBLIC_URL'] || `http://${cfg.host}:${cfg.port}`;
  const diagramUrl = `${base}/view/diagram?token=${signViewToken(project, 'canvas')}`;
  // The host resolves the target's token from its own secret repository and
  // hands it to the one call it authorizes; the producer never asks for it. An
  // unconfigured target needs no token: the producer refuses it by name.
  const configured = runWithProjectRoot(root, () => hostProducer.list()).some((p) => p.target === target);
  const token = configured ? resolveSecret(`${target}-token`) : null;
  if (configured && !token) {
    const label = target.charAt(0).toUpperCase() + target.slice(1);
    throw new Error(`No ${label} token — set WAIRON_${target.toUpperCase()}_TOKEN or run \`wairon host secret set ${target}-token <secret>\`.`);
  }
  await runWithProjectRoot(root, () => hostProducer.produce(target, diagramUrl, token ?? ''));
}

export function removeProducer(cfg: HostConfig, credential: string | null, project: string, target: string): void {
  requireProducerAdmin(cfg, credential, project, 'removing a producer');
  runWithProjectRoot(boundProject(cfg, project), () => hostProducer.remove(target));
}

export function listProducers(cfg: HostConfig, credential: string | null, project: string): ProducerConfig[] {
  requireProducerAdmin(cfg, credential, project, 'listing producers');
  return runWithProjectRoot(boundProject(cfg, project), () => hostProducer.list());
}

// ── Secrets (runtime-configurable integration tokens) ─────────────────────────

export function setSecret(_cfg: HostConfig, credential: string | null, key: string, value: string): void {
  requireAdmin(credential);
  secretStore.setSecret(key, value);
}

export function listSecrets(_cfg: HostConfig, credential: string | null): string[] {
  requireAdmin(credential);
  return listSecretKeys();
}

// ── Spec-tree transfer (.waitree) ─────────────────────────────────────────
//
// The hosted half of local↔hosted migration. Both are TREE-scoped like lock:
// a `subproject` qualifier (a member chain, one alias per hop) binds that
// MEMBER's tree, so a credential narrowed to one member exports/imports
// exactly that member while permission resolution stays anchored at the top
// project.

/**
 * Pack a hosted project's spec tree into a .waitree archive. Requires
 * project:read — the same grant that already reads every spec individually, so
 * a bulk export grants nothing new.
 */
export function exportProjectTree(
  cfg: HostConfig,
  credential: string | null,
  project: string,
  subproject?: string,
  includeDerived?: boolean,
  allowPartial?: boolean,
): TreeExportResult {
  const principal = requirePrincipal(cfg, credential);
  if (authorize(cfg.dataDir, principal, 'project:read', 'project', project).value !== 'yes') {
    throw new AdminAuthError("Forbidden — exporting a project's spec tree requires project:read over it");
  }
  const root = boundLifecycleRoot(cfg, project, subproject);
  return runWithProjectRoot(root, () => hostCore.exportSpecTree(includeDerived, allowPartial));
}

/**
 * Replace a hosted project's spec tree from a .waitree archive. Requires
 * project:admin — deliberately above project:write, because this replaces the
 * whole design rather than editing one spec. Executable entries are ALWAYS
 * refused: the archive arrived over the wire, and executable doctrine installs
 * only through the trusted filesystem (the same rule the pack surface applies).
 */
export function importProjectTree(
  cfg: HostConfig,
  credential: string | null,
  project: string,
  archive: Uint8Array,
  subproject?: string,
  replaceExisting?: boolean,
): TreeImportResult {
  const principal = requirePrincipal(cfg, credential);
  if (authorize(cfg.dataDir, principal, 'project:admin', 'project', project).value !== 'yes') {
    throw new AdminAuthError("Forbidden — importing a project's spec tree requires project:admin over it");
  }
  const root = boundLifecycleRoot(cfg, project, subproject);
  return runWithProjectRoot(root, () =>
    hostCore.importSpecTree(archive, {
      destDir: root,
      replaceExisting: replaceExisting === true,
      refuseExecutableEntries: true,
    }),
  );
}

// ── Diagrams ──────────────────────────────────────────────────────────────

/** Render a project's diagram artifact in the requested format. */
export function generateDiagram(cfg: HostConfig, credential: string | null, project: string, format: string): string {
  requireAdmin(credential);
  const root = existingProjectRoot(cfg.dataDir, project);
  if (!root) throw new Error(`Unknown project "${project}".`);
  return runWithProjectRoot(root, () => hostCore.renderDiagram(format));
}

/** Same as generateDiagram; the HTTP layer sets a download disposition. */
export function downloadDiagram(cfg: HostConfig, credential: string | null, project: string, format: string): string {
  return generateDiagram(cfg, credential, project, format);
}

/** Mint a short-lived signed relative link to view the project's canvas in a browser. */
export function diagramViewLink(cfg: HostConfig, credential: string | null, project: string): string {
  requireAdmin(credential);
  if (!existingProjectRoot(cfg.dataDir, project)) throw new Error(`Unknown project "${project}".`);
  return `/view/diagram?token=${signViewToken(project, 'canvas')}`;
}

