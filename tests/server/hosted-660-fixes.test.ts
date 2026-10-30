import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { lockProject, decideRequest, withdrawRequest, getApprovalStatus } from '../../src/server/projectlifecycle.js';
import { createProject, checkLockable } from '../../src/server/admin.js';
import { LockValidationError, ForbiddenError } from '../../src/server/errors.js';
import { createUnit } from '../../src/server/organization.js';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import { existingProjectRoot } from '../../src/server/projects.js';
import {
  listApprovalRequests,
  getApprovalRequestById,
  decideApprovalRequest,
  withdrawApprovalRequest,
  cancelApprovalRequest,
} from '../../src/server/approvals.js';
import { setAssignment } from '../../src/server/permissions.js';
import { listUsers } from '../../src/server/identity.js';
import { ensureInstanceIdentity } from '../../src/server/instance.js';
import { upsertUser as storeUser, getUserById } from '../../src/server/users.js';
import { createWebSession } from '../../src/server/websessions.js';
import * as webproject from '../../src/server/webproject.js';
import { runHostUser, runHostPermission } from '../../src/commands/host.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import type { ApiKeyRecord, Capability, HostConfig, PermissionValue, ScopeKind } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// wairon 6.6.0 hosted fixes: a lock request about a tree the approved lock would
// refuse is refused up front; a requester withdraws their own pending request;
// the user listing names grant holders that have no record; `wairon host user`;
// /web/projects carries no absolute server path.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value-660';
const PROJECT = 'kb';

let dataDir: string;
let cfg: HostConfig;
const savedEnv = { ...process.env };

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-660-'));
  process.env.WAIRON_ADMIN_TOKEN = MASTER;
  process.env.WAIRON_DATA_DIR = dataDir;
  cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

function seedProject(): string {
  const unit = createUnit(dataDir, {
    id: '', name: 'team', slug: 'team', kind: 'team', status: 'active', createdAt: '',
    createdBy: { userId: 'u-admin', kind: 'human', issuer: 'local' },
  });
  createProject(cfg, MASTER, PROJECT, unit.id);
  return unit.id;
}

function mintToken(userId: string, projects: string[] = [PROJECT]): string {
  const token = 'wk_' + crypto.randomBytes(8).toString('hex');
  const record: ApiKeyRecord = {
    id: `k-${userId}`,
    keyHash: hashToken(token),
    projects,
    createdAt: new Date().toISOString(),
    ownerSubject: { userId, kind: 'human', issuer: 'local' },
  };
  createCredential(dataDir, record);
  return token;
}

function allow(userId: string, capability: Capability, scopeKind: ScopeKind, scopeId: string | undefined, value: PermissionValue): void {
  setAssignment(dataDir, { id: '', subjectKind: 'user', subjectId: userId, scopeKind, scopeId, capability, value, createdAt: '' });
}

/** A component depending on something nobody declares: a DESIGN error the as-complete gate reports. */
function breakTheTree(): void {
  const root = existingProjectRoot(dataDir, PROJECT)!;
  const stamp = ["createdAt: '2026-01-01T00:00:00.000Z'", "updatedAt: '2026-01-01T00:00:00.000Z'"];
  const write = (file: string, lines: string[]): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [...lines, ''].join('\n'));
  };
  write(path.join(root, '.wai', 'specs', 'subsystems', 'core.yaml'), [
    'id: core', 'name: core', 'description: the domain', `parentSystem: ${PROJECT}`, ...stamp]);
  write(path.join(root, '.wai', 'specs', 'components', 'orch.yaml'), [
    'id: orch', 'name: orch', 'description: depends on nothing real', 'subsystem: core',
    'componentType: Orchestrator', 'owns: []', "dependsOn: ['no_such_component']", ...stamp]);
  invalidateSpecCache();
}

const pending = () => listApprovalRequests(dataDir).filter((r) => r.status === 'pending');

describe('a lock request is refused while the tree has validation errors', () => {
  it('names the error count and each error code, and creates no pending request', () => {
    seedProject();
    const writer = mintToken('u-writer');
    allow('u-writer', 'project:read', 'project', PROJECT, 'yes');
    allow('u-writer', 'project:write', 'project', PROJECT, 'yes');
    breakTheTree();

    let refused: LockValidationError | undefined;
    try {
      lockProject(cfg, writer, PROJECT);
    } catch (e) {
      refused = e as LockValidationError;
    }

    expect(refused).toBeInstanceOf(LockValidationError);
    expect(refused!.errors.length).toBeGreaterThan(0);
    expect(refused!.message).toContain(`${refused!.errors.length} error(s)`);
    for (const e of refused!.errors) expect(refused!.message).toContain(e.code);
    expect(listApprovalRequests(dataDir)).toHaveLength(0);
    expect(fs.existsSync(path.join(existingProjectRoot(dataDir, PROJECT)!, '.wai', 'lock.json'))).toBe(false);
  });

  it('checkLockable is read-only and accepts a clean tree, which then reaches the request', () => {
    seedProject();
    const writer = mintToken('u-writer');
    allow('u-writer', 'project:write', 'project', PROJECT, 'yes');
    expect(() => checkLockable(cfg, PROJECT)).not.toThrow();
    expect(fs.existsSync(path.join(existingProjectRoot(dataDir, PROJECT)!, '.wai', 'lock.json'))).toBe(false);

    const outcome = lockProject(cfg, writer, PROJECT);
    expect(outcome.status).toBe('pending-approval');
    expect(pending()).toHaveLength(1);
  });
});

describe('withdrawing an approval request', () => {
  const approveInput = (requestId: string, approved = true) => ({
    requestId,
    approved,
    decidedBy: { userId: 'ignored', kind: 'human' as const, issuer: 'local' },
    decidedAt: new Date().toISOString(),
  });

  /** A writer's pending lock request, and a separate approver. */
  function requested(): { writer: string; approver: string; requestId: string } {
    seedProject();
    const writer = mintToken('u-writer');
    allow('u-writer', 'project:write', 'project', PROJECT, 'yes');
    const approver = mintToken('u-approver');
    allow('u-approver', 'approval:decide', 'project', PROJECT, 'yes');
    const outcome = lockProject(cfg, writer, PROJECT);
    return { writer, approver, requestId: outcome.approval!.id };
  }

  it('the requester withdraws a pending request: cancelled, with the reason, nothing executed', () => {
    const { writer, requestId } = requested();

    const withdrawn = withdrawRequest(cfg, writer, requestId, 'the tree changed');

    expect(withdrawn.status).toBe('cancelled');
    expect(withdrawn.executionSummary).toBe('withdrawn by the requester: the tree changed');
    expect(getApprovalStatus(cfg, writer, requestId)).toMatchObject({ status: 'cancelled' });
    expect(pending()).toHaveLength(0);
    expect(fs.existsSync(path.join(existingProjectRoot(dataDir, PROJECT)!, '.wai', 'lock.json'))).toBe(false);
  });

  it('the reason is optional', () => {
    const { writer, requestId } = requested();
    expect(withdrawRequest(cfg, writer, requestId).executionSummary).toBe('withdrawn by the requester');
  });

  it('anyone else is refused, an approver included, and the request stays pending', () => {
    const { approver, requestId } = requested();
    const other = mintToken('u-other');
    expect(() => withdrawRequest(cfg, approver, requestId)).toThrow(ForbiddenError);
    expect(() => withdrawRequest(cfg, other, requestId)).toThrow(ForbiddenError);
    expect(getApprovalRequestById(dataDir, requestId)?.status).toBe('pending');
  });

  it('an unknown id is not found', () => {
    const { writer } = requested();
    expect(() => withdrawRequest(cfg, writer, 'apr-nope')).toThrow(/not found/);
  });

  it('a decision after the withdrawal is refused, and nothing is executed', () => {
    const { writer, approver, requestId } = requested();
    withdrawRequest(cfg, writer, requestId);

    expect(() => decideRequest(cfg, approver, approveInput(requestId))).toThrow(/cancelled, not pending/);
    expect(getApprovalRequestById(dataDir, requestId)?.status).toBe('cancelled');
    expect(fs.existsSync(path.join(existingProjectRoot(dataDir, PROJECT)!, '.wai', 'lock.json'))).toBe(false);
  });

  it('a withdrawal after a decision is refused and cannot cancel an approved request', () => {
    const { writer, requestId } = requested();
    // The decision lands first (registry level: approved, not yet executed).
    decideApprovalRequest(dataDir, approveInput(requestId));
    expect(() => withdrawRequest(cfg, writer, requestId)).toThrow(/approved, not pending/);
    expect(() => withdrawApprovalRequest(dataDir, requestId, 'late')).toThrow(/approved, not pending/);
    expect(getApprovalRequestById(dataDir, requestId)?.status).toBe('approved');
  });

  it('a completed, denied or already-withdrawn request is refused naming its status', () => {
    const { writer, approver, requestId } = requested();
    decideRequest(cfg, approver, approveInput(requestId));
    expect(getApprovalRequestById(dataDir, requestId)?.status).toBe('completed');
    expect(() => withdrawRequest(cfg, writer, requestId)).toThrow(/completed, not pending/);

    const second = lockProject(cfg, writer, PROJECT);
    // the project is locked now; a fresh request still pends
    const id2 = second.approval!.id;
    withdrawRequest(cfg, writer, id2);
    expect(() => withdrawRequest(cfg, writer, id2)).toThrow(/cancelled, not pending/);
  });

  it('cancel stays approved-only: a pending request is refused by it', () => {
    const { requestId } = requested();
    expect(() => cancelApprovalRequest(dataDir, requestId, 'x')).toThrow(/not approved/);
  });
});

describe('the user listing and `wairon host user`', () => {
  const subject = (id: string) => ({ userId: id, kind: 'human', issuer: 'local' });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('lists a subject that holds grants but has no record, flagged noRecord with no status', () => {
    seedProject();
    storeUser(dataDir, { id: 'alice', subject: subject('alice'), status: 'active', createdAt: '' });
    allow('alice', 'project:read', 'project', PROJECT, 'yes');
    allow('ghost', 'project:read', 'project', PROJECT, 'yes');

    const users = listUsers(cfg, MASTER);
    const ghost = users.find((u) => u.id === 'ghost');
    expect(ghost).toMatchObject({ id: 'ghost', noRecord: true, subject: { userId: 'ghost' } });
    expect(ghost).not.toHaveProperty('status');
    expect(ghost?.unitId).toBeUndefined();
    const alice = users.find((u) => u.id === 'alice');
    expect(alice?.noRecord).toBeUndefined();
    expect(alice?.status).toBe('active');
    // narrowed to the project's holders, the row still shows
    expect(listUsers(cfg, MASTER, PROJECT).map((u) => u.id).sort()).toEqual(['alice', 'ghost']);
  });

  it('matches a record by its subject id too, and never lists the boot-reserved subjects', () => {
    seedProject();
    storeUser(dataDir, { id: 'rec-1', subject: subject('sub-1'), status: 'active', createdAt: '' });
    allow('sub-1', 'project:read', 'project', PROJECT, 'yes');
    allow('builtin:superadmin', 'project:read', 'project', PROJECT, 'yes');
    const ids = listUsers(cfg, MASTER).map((u) => u.id);
    expect(ids).toContain('rec-1');
    expect(ids).not.toContain('sub-1');
    expect(ids).not.toContain('builtin:superadmin');
  });

  it('a scoped administrator never sees a no-record row (it has no home unit)', () => {
    seedProject();
    const unitId = createUnit(dataDir, {
      id: '', name: 'acme', slug: 'acme', kind: 'business_entity', status: 'active', createdAt: '',
      createdBy: { userId: 'u-admin', kind: 'human', issuer: 'local' },
    }).id;
    storeUser(dataDir, { id: 'admin-1', subject: subject('admin-1'), status: 'active', createdAt: '', unitId });
    allow('admin-1', 'project:admin', 'unit', unitId, 'yes');
    allow('ghost', 'project:read', 'project', PROJECT, 'yes');
    const token = mintToken('admin-1', ['*']);
    const ids = listUsers(cfg, token).map((u) => u.id);
    expect(ids).toContain('admin-1');
    expect(ids).not.toContain('ghost');
  });

  it('host user add / list / set-status', async () => {
    await runHostUser('add', { dataDir, user: 'bob', name: 'Bob', email: 'bob@example.com' });
    const rec = getUserById(dataDir, 'bob');
    expect(rec).toMatchObject({ id: 'bob', status: 'active', displayName: 'Bob', email: 'bob@example.com' });

    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    allow('ghost', 'project:read', 'instance', undefined, 'yes');
    await runHostUser('list', { dataDir });
    const out = lines.join('\n');
    expect(out).toMatch(/bob\s+active/);
    expect(out).toMatch(/ghost\s+no user record/);

    await runHostUser('set-status', { dataDir, user: 'bob', userStatus: 'inactive' });
    expect(getUserById(dataDir, 'bob')?.status).toBe('inactive');
  });

  it('host user set-status says keys and sessions were revoked, and that active restores none', async () => {
    await runHostUser('add', { dataDir, user: 'dave' });
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    await runHostUser('set-status', { dataDir, user: 'dave', userStatus: 'inactive' });
    expect(lines.join('\n')).toMatch(/API keys and web sessions of "dave" were revoked/);
    lines.length = 0;
    await runHostUser('set-status', { dataDir, user: 'dave', userStatus: 'active' });
    expect(lines.join('\n')).toMatch(/No revoked key comes back.*wairon host key mint/);
  });

  it('host user refuses a missing --user, a missing --status and an unknown action', async () => {
    await expect(runHostUser('add', { dataDir })).rejects.toThrow(/--user/);
    await expect(runHostUser('set-status', { dataDir, user: 'bob' })).rejects.toThrow(/--status/);
    await expect(runHostUser('set-status', { dataDir, user: 'nobody', userStatus: 'inactive' })).rejects.toThrow(/not found/);
    await expect(runHostUser('frobnicate', { dataDir })).rejects.toThrow(/Unknown user action/);
  });

  it('host user add refuses an id that already holds a record, keeping the record', async () => {
    await runHostUser('add', { dataDir, user: 'carol', name: 'Carol', email: 'carol@example.com' });
    await expect(runHostUser('add', { dataDir, user: 'carol', name: 'Other' })).rejects.toThrow(/already has a record/);
    expect(getUserById(dataDir, 'carol')).toMatchObject({ displayName: 'Carol', email: 'carol@example.com' });
  });

  it('host user add refuses a reserved built-in subject id', async () => {
    await expect(runHostUser('add', { dataDir, user: 'builtin:superadmin' })).rejects.toThrow(/reserved/);
  });

  it('host permission set warns when the user has no record, stores the grant, and stays quiet with one', async () => {
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.join(' ')); });

    await runHostPermission('set', { dataDir, user: 'svc-bot', capability: 'project:read', instance: true });
    expect(warnings.join('\n')).toMatch(/"svc-bot" has no user record/);
    expect(warnings.join('\n')).toContain('wairon host user add --user svc-bot');

    warnings.length = 0;
    storeUser(dataDir, { id: 'carol', subject: subject('carol'), status: 'active', createdAt: '' });
    await runHostPermission('set', { dataDir, user: 'carol', capability: 'project:read', instance: true });
    expect(warnings.join('\n')).not.toMatch(/no user record/);
  });
});

describe('/web/projects carries no absolute server path', () => {
  it('listProjects and createProject answer records with no rootPath', () => {
    const unitId = seedProject();
    const session = createWebSession(dataDir, {
      id: '',
      subject: { userId: ensureInstanceIdentity(dataDir).superadminUserId, kind: 'human', issuer: 'local' },
      projects: ['*'],
      createdAt: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }).id;
    const stored = existingProjectRoot(dataDir, PROJECT)!;

    const listed = webproject.listProjects(cfg, session);
    expect(listed.map((r) => r.id)).toEqual([PROJECT]);
    expect(JSON.stringify(listed)).not.toContain(stored);
    expect(JSON.stringify(listed)).not.toContain(dataDir);
    for (const r of listed) expect(r.rootPath).toBe('');

    const created = webproject.createProject(cfg, session, 'second', unitId);
    expect(created.record.id).toBe('second');
    expect(JSON.stringify(created)).not.toContain(dataDir);
  });
});
