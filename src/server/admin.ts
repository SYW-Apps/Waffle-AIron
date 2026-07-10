import * as crypto from 'crypto';
import { runWithProjectRoot } from '../utils/fs.js';
import { WAIRON_VERSION } from '../config/defaults.js';
import { stateIdEquals } from '../core/statehash.js';
import type { LockRecord } from '../core/lockfile.js';
import { authenticateMaster, authenticateCredential, signViewToken } from './auth.js';
import { resolveScopeFor, permits } from './scope.js';
import { placeProject as placeProjectInUnit } from './organization.js';
import {
  hashToken,
  createCredential,
  revokeCredential,
  listCredentials,
} from './credentials.js';
import {
  createProjectRecord,
  listProjectRecords,
  removeProjectRecord,
  existingProjectRoot,
} from './projects.js';
import { hostCore, hostGit, hostProducer, validateProjectAsComplete } from './adapters.js';
import { setSecret as storeSecret, listSecretKeys } from '../utils/secrets.js';
import type { ProducerConfig } from '../producers/index.js';
import type {
  ApiKeyRecord,
  HostConfig,
  HostedProjectRecord,
  Principal,
  PrincipalSubject,
  PromoteResult,
  Role,
} from './types.js';

// ---------------------------------------------------------------------------
// Admin Orchestrator (sdd_host)
//
// The control-plane workflows: master-credential auth, then project/key
// lifecycle and the state-scoped lock / gated promote. Exported as plain
// functions so BOTH entry points reach the same logic — the HTTP admin portal
// (src/server/http.ts) and the in-process CLI adapter (src/commands/host.ts).
// Never performs a merge; promote only marks a change-set ready after the
// StateId re-check.
// ---------------------------------------------------------------------------

export class AdminAuthError extends Error {
  // A default message covers a missing/unauthenticated credential; the scoped
  // project-lifecycle methods pass a specific reason for a scope denial (an
  // authenticated caller lacking authority). Both map to 403 on the admin plane.
  constructor(message = 'Forbidden: a valid admin credential is required.') {
    super(message);
    this.name = 'AdminAuthError';
  }
}

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
 * Authenticate the caller and resolve their project:create scope over the
 * organization tree. A super-admin (bootstrap master or an instance-wide grant)
 * may create anywhere and optionally place the project; a unit-scoped creator
 * holding project:create for an organization unit MUST supply a target unit within
 * their scope, and the new project is auto-placed there so the creator retains
 * scope over it. A caller with no create authority, or a unit-scoped caller with a
 * missing/out-of-scope target unit, is rejected.
 */
export function createProject(
  cfg: HostConfig,
  credential: string | null,
  id: string,
  unitId?: string,
): HostedProjectRecord {
  const principal = requirePrincipal(cfg, credential);
  const scope = resolveScopeFor(cfg, principal, 'project:create');

  // No create authority at all: not a super-admin and no in-scope units.
  if (!scope.all && scope.unitIds.length === 0) {
    throw new AdminAuthError('Forbidden — creating a project requires project:create authority');
  }
  // A unit-scoped creator must target an in-scope unit; a super-admin may skip.
  if (!scope.all && (!unitId || !scope.unitIds.includes(unitId))) {
    throw new AdminAuthError(
      'Forbidden — a unit-scoped project creator must target an organization unit within their scope',
    );
  }

  // Allocate, provision, and bind the isolated tree (steps 9–11).
  const rec = executeApprovedCreate(cfg, id);

  // When a target unit was provided, auto-place the new project in it so the
  // creator retains scope over what they just created (a super-admin may create
  // without placing when no unit is given).
  if (unitId) {
    placeProjectInUnit(cfg.dataDir, {
      id: '',
      projectId: id,
      unitId,
      role: 'owner',
      createdAt: '',
      createdBy: principalSubject(principal),
    });
  }
  return rec;
}

/**
 * Pre-authorized entry for the approval workflow: the same privileged action as
 * createProject but WITHOUT credential authentication — the caller
 * (self_service_orchestrator) has already enforced approval-based authorization.
 * Never routed from any portal.
 */
export function executeApprovedCreate(cfg: HostConfig, id: string): HostedProjectRecord {
  const rec = createProjectRecord(cfg.dataDir, id);
  runWithProjectRoot(rec.rootPath, () => hostCore.provisionProject(id));
  return rec;
}

export function destroyProject(cfg: HostConfig, credential: string | null, id: string): void {
  const principal = requirePrincipal(cfg, credential);
  const scope = resolveScopeFor(cfg, principal, 'project:destroy');
  if (!permits(scope, id)) {
    throw new AdminAuthError('Forbidden — destroying a project requires project:destroy scope over it');
  }
  removeProjectRecord(cfg.dataDir, id);
}

export function listProjects(cfg: HostConfig, credential: string | null): HostedProjectRecord[] {
  requireAdmin(credential);
  return listProjectRecords(cfg.dataDir);
}

export function mintKey(cfg: HostConfig, credential: string | null, project: string, role: Role): string {
  requireAdmin(credential);
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
  const scope = resolveScopeFor(cfg, principal, 'lock:create');
  if (!permits(scope, project)) {
    throw new AdminAuthError('Forbidden — locking a project requires lock:create scope over it');
  }
  return executeApprovedLock(cfg, project);
}

/**
 * Pre-authorized entry for the approval workflow: the same privileged action as
 * lockProject but WITHOUT credential authentication — the caller
 * (self_service_orchestrator) has already enforced approval-based authorization.
 * Never routed from any portal.
 */
export function executeApprovedLock(cfg: HostConfig, projectId: string): LockRecord {
  const root = existingProjectRoot(cfg.dataDir, projectId);
  if (!root) throw new Error(`Unknown project "${projectId}".`);
  return runWithProjectRoot(root, () => {
    // Git-backed: pull the default branch into the working branch first so the
    // lock (and PR) is based on the latest. No-op for native projects.
    hostGit.sync();

    const result = validateProjectAsComplete();
    const errors = result.issues.filter((i) => i.severity === 'error');
    if (errors.length) {
      throw new LockValidationError(errors.map((e) => ({ code: e.code, message: e.message, specId: e.specId })));
    }
    hostCore.promoteAllComplete();
    const stateId = hostCore.computeStateId();

    // Git-backed: commit the promoted working tree and push the working branch;
    // returns the commit + compare URL a human opens the PR from. No-op if native.
    const publish = hostGit.publish(`wairon lock: ${projectId}`);

    const record: LockRecord = {
      stateId,
      lockedAt: new Date().toISOString(),
      lockedBy: 'admin:master',
      validatorVersion: WAIRON_VERSION,
      validationResult: {
        valid: true,
        errors: 0,
        warnings: result.issues.filter((i) => i.severity === 'warning').length,
      },
      status: 'ready',
      ...(publish.published ? { commitSha: publish.commitSha, compareUrl: publish.compareUrl } : {}),
    };
    hostCore.writeLockRecord(record);
    return record;
  });
}

// ── Git backing ─────────────────────────────────────────────────────────────

/** Enable git backing on a fresh project (clones the remote onto a working branch). */
export function enableGit(cfg: HostConfig, credential: string | null, project: string, remote: string, branch: string): HostedProjectRecord {
  requireAdmin(credential);
  if (existingProjectRoot(cfg.dataDir, project)) {
    throw new Error(`Project "${project}" already exists; destroy it first to git-enable a fresh clone.`);
  }
  const rec = createProjectRecord(cfg.dataDir, project); // empty dir + record (no native provisioning)
  runWithProjectRoot(rec.rootPath, () => hostGit.enable(remote, branch || 'main'));
  return rec;
}

/** Disable git backing for a project (leaves the checkout in place). */
export function disableGit(cfg: HostConfig, credential: string | null, project: string): void {
  requireAdmin(credential);
  const root = existingProjectRoot(cfg.dataDir, project);
  if (!root) throw new Error(`Unknown project "${project}".`);
  runWithProjectRoot(root, () => hostGit.disable());
}

/** Sync a project's default branch into its working branch. */
export function syncGit(cfg: HostConfig, credential: string | null, project: string): void {
  requireAdmin(credential);
  const root = existingProjectRoot(cfg.dataDir, project);
  if (!root) throw new Error(`Unknown project "${project}".`);
  runWithProjectRoot(root, () => hostGit.sync());
}

// ── Producers ───────────────────────────────────────────────────────────────

function boundProject(cfg: HostConfig, project: string): string {
  const root = existingProjectRoot(cfg.dataDir, project);
  if (!root) throw new Error(`Unknown project "${project}".`);
  return root;
}

export function configureProducer(cfg: HostConfig, credential: string | null, project: string, target: string, parentPageId: string): void {
  requireAdmin(credential);
  runWithProjectRoot(boundProject(cfg, project), () => hostProducer.configure(target, parentPageId));
}

export async function produceProducer(cfg: HostConfig, credential: string | null, project: string, target: string): Promise<void> {
  requireAdmin(credential);
  const root = boundProject(cfg, project);
  const base = process.env['WAIRON_PUBLIC_URL'] || `http://${cfg.host}:${cfg.port}`;
  const diagramUrl = `${base}/view/diagram?token=${signViewToken(project, 'canvas')}`;
  await runWithProjectRoot(root, () => hostProducer.produce(target, diagramUrl));
}

export function removeProducer(cfg: HostConfig, credential: string | null, project: string, target: string): void {
  requireAdmin(credential);
  runWithProjectRoot(boundProject(cfg, project), () => hostProducer.remove(target));
}

export function listProducers(cfg: HostConfig, credential: string | null, project: string): ProducerConfig[] {
  requireAdmin(credential);
  return runWithProjectRoot(boundProject(cfg, project), () => hostProducer.list());
}

// ── Secrets (runtime-configurable integration tokens) ─────────────────────────

export function setSecret(_cfg: HostConfig, credential: string | null, key: string, value: string): void {
  requireAdmin(credential);
  storeSecret(key, value);
}

export function listSecrets(_cfg: HostConfig, credential: string | null): string[] {
  requireAdmin(credential);
  return listSecretKeys();
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

export function promoteProject(cfg: HostConfig, credential: string | null, project: string): PromoteResult {
  const principal = requirePrincipal(cfg, credential);
  const scope = resolveScopeFor(cfg, principal, 'promote:mark-ready');
  if (!permits(scope, project)) {
    throw new AdminAuthError('Forbidden — promoting a project requires promote:mark-ready scope over it');
  }
  return executeApprovedPromote(cfg, project);
}

/**
 * Pre-authorized entry for the approval workflow: the same privileged action as
 * promoteProject but WITHOUT credential authentication — the caller
 * (self_service_orchestrator) has already enforced approval-based authorization.
 * Never routed from any portal.
 */
export function executeApprovedPromote(cfg: HostConfig, projectId: string): PromoteResult {
  const root = existingProjectRoot(cfg.dataDir, projectId);
  if (!root) throw new Error(`Unknown project "${projectId}".`);
  return runWithProjectRoot(root, () => {
    const lock = hostCore.readLockRecord();
    if (!lock) {
      return { status: 'not-locked', message: 'Project is not locked; run lock first.' };
    }
    const current = hostCore.computeStateId();
    if (!stateIdEquals(current, lock.stateId)) {
      return { status: 'stale', stateId: current, message: 'Spec tree changed since lock; re-lock required.' };
    }
    hostCore.writeLockRecord({ ...lock, status: 'promoted' });
    return { status: 'ready', stateId: current, message: 'Locked state matches; change-set marked ready for promotion.' };
  });
}
