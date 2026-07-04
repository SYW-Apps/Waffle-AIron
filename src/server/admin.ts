import * as crypto from 'crypto';
import { runWithProjectRoot } from '../utils/fs.js';
import { WAIRON_VERSION } from '../config/defaults.js';
import { stateIdEquals } from '../core/statehash.js';
import type { LockRecord } from '../core/lockfile.js';
import { authenticateMaster, signViewToken } from './auth.js';
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
import { hostCore, hostGit, validateProjectAsComplete } from './adapters.js';
import type {
  ApiKeyRecord,
  HostConfig,
  HostedProjectRecord,
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
  constructor() {
    super('Forbidden: a valid admin credential is required.');
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

export function createProject(cfg: HostConfig, credential: string | null, id: string): HostedProjectRecord {
  requireAdmin(credential);
  const rec = createProjectRecord(cfg.dataDir, id);
  runWithProjectRoot(rec.rootPath, () => hostCore.provisionProject(id));
  return rec;
}

export function destroyProject(cfg: HostConfig, credential: string | null, id: string): void {
  requireAdmin(credential);
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
  requireAdmin(credential);
  const root = existingProjectRoot(cfg.dataDir, project);
  if (!root) throw new Error(`Unknown project "${project}".`);
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
    const publish = hostGit.publish(`wairon lock: ${project}`);

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
  requireAdmin(credential);
  const root = existingProjectRoot(cfg.dataDir, project);
  if (!root) throw new Error(`Unknown project "${project}".`);
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
