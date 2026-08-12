import * as crypto from 'crypto';
import { runWithProjectRoot } from '../utils/fs.js';
import { WAIRON_VERSION } from '../config/defaults.js';

import type { LockRecord } from '../core/lockfile.js';
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
  listProjectRecords,
  removeProjectRecord,
  existingProjectRoot,
  resolveSubprojectMounts,
  SUBPROJECT_SEPARATOR,
} from './projects.js';
import { hostCore, hostGit, hostProducer, validateProjectAsComplete } from './adapters.js';
import type { TreeExportResult, TreeImportResult } from '../core/treetransfer.js';
import type { GitBackingStatus, GitPublish } from '../git/index.js';
import { setSecret as storeSecret, listSecretKeys } from '../utils/secrets.js';
import type { ProducerConfig } from '../producers/index.js';
import type {
  ApiKeyRecord,
  HostConfig,
  HostedProjectRecord,
  Principal,
  PrincipalSubject,
  PromoteResult,
  DisplayRole,
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
 * placed at creation so the permission resolver can always enumerate it — a
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
  // passes via the resolver bypass).
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
  return executeApprovedLock(cfg, project);
}

/**
 * Step 1 of executeApprovedLock / executeApprovedPromote: the root the action
 * concerns. Without a qualifier that is the project's own isolated root; WITH one
 * it is the CHAINED CHILD's tree, resolved through the project registry's
 * containment-checked qualified resolution — the SAME seam the data plane binds
 * through, so a qualifier can never resolve outside the project root.
 *
 * `subproject` is the mount chain only ('a' or 'a::b'), exactly as
 * ProjectBinding.subproject carries it — never the project id. An unknown mount,
 * a subsystem carrying no projectPath, or an escaping path THROWS (the helper's
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
 * Pre-authorized entry for the approval workflow: the same privileged action as
 * lockProject but WITHOUT credential authentication — the caller
 * (project_lifecycle_orchestrator) has already enforced permission-based
 * authorization. Never routed from any portal.
 *
 * An optional `subproject` qualifier binds the CHAINED CHILD's tree instead of
 * the project's own, so every step below (validate-as-complete, promote,
 * StateId, lock record) concerns THAT tree. Note what falls out for free and is
 * deliberately NOT special-cased: the git binding is read from the BOUND root, so
 * a child tree carries none and both the sync (step 2) and the publish (step 8)
 * no-op naturally — a subproject freeze never commits or pushes against the
 * parent's repository. The frozen child tree persists in the project's working
 * tree, but it is NOT staged by the project's own .wai/-scoped commit either: a
 * chained child lives outside that pathspec (e.g. packages/billing/.wai/), so
 * reaching a remote takes a commit whose scope covers the child's path.
 */
export function executeApprovedLock(cfg: HostConfig, projectId: string, subproject?: string): LockRecord {
  const root = boundLifecycleRoot(cfg, projectId, subproject);
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
    // The GATE identity: the lock certifies that these specs passed THIS gate,
    // so the governing doctrine is part of the frozen state.
    const stateId = hostCore.computeGateStateId();

    // Git-backed: the lock is the semantic checkpoint — the auto-publish
    // trigger. Commit ONLY the .wai/ tree (pathspec-scoped, never the shared
    // repo's own code) with a message referencing the validated StateId, and
    // push; returns the commit + compare URL a human opens the PR from. No-op
    // for native projects, and a backup failure never fails the lock (publish
    // itself no-ops rather than throwing on a clean scope).
    const publish = hostGit.publish(`wairon lock: ${projectId} @ ${stateId}`);

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
    storeSecret(credentialRef, pat.trim());
  }
  const rec = createProjectRecord(cfg.dataDir, project); // empty dir + record (no native provisioning)
  runWithProjectRoot(rec.rootPath, () => hostGit.enable(remote, branch || 'main', credentialRef));
  return rec;
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
  await runWithProjectRoot(root, () => hostProducer.produce(target, diagramUrl));
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
  storeSecret(key, value);
}

export function listSecrets(_cfg: HostConfig, credential: string | null): string[] {
  requireAdmin(credential);
  return listSecretKeys();
}

// ── Spec-tree transfer (.waitree) ─────────────────────────────────────────
//
// The hosted half of local↔hosted migration. Both are TREE-scoped like lock and
// promote: a `subproject` qualifier binds the CHAINED CHILD's tree, so a
// credential narrowed to one child exports/imports exactly that child while
// permission resolution stays anchored at the top project.

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
): TreeExportResult {
  const principal = requirePrincipal(cfg, credential);
  if (authorize(cfg.dataDir, principal, 'project:read', 'project', project).value !== 'yes') {
    throw new AdminAuthError("Forbidden — exporting a project's spec tree requires project:read over it");
  }
  const root = boundLifecycleRoot(cfg, project, subproject);
  return runWithProjectRoot(root, () => hostCore.exportSpecTree(includeDerived));
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

export function promoteProject(cfg: HostConfig, credential: string | null, project: string): PromoteResult {
  const principal = requirePrincipal(cfg, credential);
  if (authorize(cfg.dataDir, principal, 'project:write', 'project', project).value !== 'yes') {
    throw new AdminAuthError('Forbidden — promoting a project requires project:write over it');
  }
  return executeApprovedPromote(cfg, project);
}

/**
 * Pre-authorized entry for the approval workflow: the same privileged action as
 * promoteProject but WITHOUT credential authentication — the caller
 * (project_lifecycle_orchestrator) has already enforced permission-based
 * authorization. Never routed from any portal.
 *
 * An optional `subproject` qualifier binds the CHAINED CHILD's tree instead of
 * the project's own, so the lock-record read, the StateId recomputation and the
 * staleness verdict all concern that child's tree.
 */
export function executeApprovedPromote(cfg: HostConfig, projectId: string, subproject?: string): PromoteResult {
  const root = boundLifecycleRoot(cfg, projectId, subproject);
  return runWithProjectRoot(root, () => {
    // One authority for "is this project locked?" — shared with the project config
    // view, `status`, and `doctor`, so promotion and reporting can never disagree.
    // A pack change (or a record written before doctrine was covered, whose
    // algorithm marker differs) reads as stale instead of passing.
    const { state, record: lock, current } = hostCore.readLockState();
    if (state === 'unlocked' || !lock) {
      return { status: 'not-locked', message: 'Project is not locked; run lock first.' };
    }
    if (state === 'stale') {
      return { status: 'stale', stateId: current, message: 'Spec tree or governing doctrine changed since lock; re-lock required.' };
    }
    hostCore.writeLockRecord({ ...lock, status: 'promoted' });
    return { status: 'ready', stateId: current, message: 'Locked state matches; change-set marked ready for promotion.' };
  });
}
