import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { lockProject, decideRequest } from '../../src/server/projectlifecycle.js';
import { lockProject as webLockProject } from '../../src/server/webproject.js';
import { createWebSession } from '../../src/server/websessions.js';
import { createProject, lockProject as adminLockProject } from '../../src/server/admin.js';
import { AdminAuthError, ForbiddenError } from '../../src/server/errors.js';
import { createUnit } from '../../src/server/organization.js';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import { existingProjectRoot } from '../../src/server/projects.js';
import { listApprovalRequests } from '../../src/server/approvals.js';
import { setAssignment } from '../../src/server/permissions.js';
import { computeGateStateId } from '../../src/server/adapters/validator.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { gatePartsProblem } from '../../src/models/lock.js';
import type { ApiKeyRecord, Capability, HostConfig, PermissionValue, ScopeKind } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// A hosted lock is the project's APPROVAL: it is decided by approval:decide
// over the project, never by the right to edit the project. A writer requests
// the lock for someone else to approve; every surface that locks agrees (the
// web UI forwards to the admin plane's lockProject).
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';
const PROJECT = 'kb';

describe('a hosted lock needs approval:decide, per role', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-lockcap-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    const unit = createUnit(dataDir, {
      id: '', name: 'team', slug: 'team', kind: 'team', status: 'active', createdAt: '',
      createdBy: { userId: 'u-admin', kind: 'human', issuer: 'local' },
    });
    createProject(cfg, MASTER, PROJECT, unit.id);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  function mintToken(userId: string): string {
    const token = 'wk_' + crypto.randomBytes(8).toString('hex');
    const record: ApiKeyRecord = {
      id: `k-${userId}`,
      keyHash: hashToken(token),
      projects: [PROJECT],
      createdAt: new Date().toISOString(),
      ownerSubject: { userId, kind: 'human', issuer: 'local' },
    };
    createCredential(dataDir, record);
    return token;
  }

  function allow(userId: string, capability: Capability, scopeKind: ScopeKind, scopeId: string | undefined, value: PermissionValue): void {
    setAssignment(dataDir, { id: '', subjectKind: 'user', subjectId: userId, scopeKind, scopeId, capability, value, createdAt: '' });
  }

  const lockFile = () => path.join(existingProjectRoot(dataDir, PROJECT)!, '.wai', 'lock.json');
  const lockedBy = () => (JSON.parse(fs.readFileSync(lockFile(), 'utf8')) as { lockedBy?: { id?: string; source?: string } }).lockedBy;
  const pending = () => listApprovalRequests(dataDir).filter((r) => r.status === 'pending');
  const approve = (requestId: string) => ({
    requestId,
    approved: true,
    decidedBy: { userId: 'ignored', kind: 'human' as const, issuer: 'local' },
    decidedAt: new Date().toISOString(),
  });

  it('a writer without approval:decide only requests the lock; nothing is approved', () => {
    const writer = mintToken('u-writer');
    allow('u-writer', 'project:read', 'project', PROJECT, 'yes');
    allow('u-writer', 'project:write', 'project', PROJECT, 'yes');

    const outcome = lockProject(cfg, writer, PROJECT);

    expect(outcome.status).toBe('pending-approval');
    expect(outcome.approval?.kind).toBe('project:lock');
    expect(outcome.lock).toBeUndefined();
    expect(fs.existsSync(lockFile())).toBe(false);
    expect(pending()).toHaveLength(1);
  });

  it('a writer whose approval:decide is denied still only requests the lock', () => {
    const writer = mintToken('u-denied');
    allow('u-denied', 'project:write', 'project', PROJECT, 'yes');
    allow('u-denied', 'approval:decide', 'project', PROJECT, 'no');

    const outcome = lockProject(cfg, writer, PROJECT);

    expect(outcome.status).toBe('pending-approval');
    expect(fs.existsSync(lockFile())).toBe(false);
    expect(pending()).toHaveLength(1);
  });

  it('a writer cannot lock through the admin plane, which the web UI forwards to', () => {
    const writer = mintToken('u-writer2');
    allow('u-writer2', 'project:write', 'project', PROJECT, 'yes');

    expect(() => adminLockProject(cfg, writer, PROJECT)).toThrow(AdminAuthError);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('a caller whose approval:decide is yes locks directly on every surface, recorded as the approver', () => {
    const approver = mintToken('u-approver');
    allow('u-approver', 'approval:decide', 'project', PROJECT, 'yes');

    const outcome = lockProject(cfg, approver, PROJECT);
    expect(outcome.status).toBe('completed');
    expect(lockedBy()).toMatchObject({ id: 'u-approver', source: 'hosted' });
    expect(pending()).toHaveLength(0);

    fs.rmSync(lockFile());
    adminLockProject(cfg, approver, PROJECT);
    expect(lockedBy()).toMatchObject({ id: 'u-approver', source: 'hosted' });
  });

  it('a requested lock is approved by someone holding approval:decide, never by the requester', () => {
    const writer = mintToken('u-req');
    allow('u-req', 'project:write', 'project', PROJECT, 'yes');
    const reviewer = mintToken('u-rev');
    allow('u-rev', 'approval:decide', 'project', PROJECT, 'yes');

    const request = lockProject(cfg, writer, PROJECT).approval!;
    expect(() => decideRequest(cfg, writer, approve(request.id))).toThrow(ForbiddenError);
    expect(fs.existsSync(lockFile())).toBe(false);

    const decided = decideRequest(cfg, reviewer, approve(request.id));
    expect(decided.status).toBe('completed');
    expect(lockedBy()).toMatchObject({ id: 'u-rev', source: 'hosted' });
  });

  it('a read-only user may neither lock nor request one', () => {
    const reader = mintToken('u-reader');
    allow('u-reader', 'project:read', 'project', PROJECT, 'yes');

    expect(() => lockProject(cfg, reader, PROJECT)).toThrow(ForbiddenError);
    expect(() => adminLockProject(cfg, reader, PROJECT)).toThrow(AdminAuthError);
    expect(listApprovalRequests(dataDir)).toHaveLength(0);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('a user who may write only one subsystem may neither lock nor request one', () => {
    const scoped = mintToken('u-scoped');
    allow('u-scoped', 'project:read', 'project', PROJECT, 'yes');
    allow('u-scoped', 'project:write', 'subsystem', `${PROJECT}/workflow`, 'yes');

    expect(() => lockProject(cfg, scoped, PROJECT)).toThrow(ForbiddenError);
    expect(() => adminLockProject(cfg, scoped, PROJECT)).toThrow(AdminAuthError);
    expect(listApprovalRequests(dataDir)).toHaveLength(0);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('approval:decide valued approval turns the lock into a request', () => {
    const lead = mintToken('u-lead');
    allow('u-lead', 'approval:decide', 'project', PROJECT, 'approval');

    const outcome = lockProject(cfg, lead, PROJECT);
    expect(outcome.status).toBe('pending-approval');
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  // The web UI's Lock button goes through the same decision as the MCP tool,
  // for the signed-in principal (the session is the credential).
  function webSession(userId: string): string {
    return createWebSession(dataDir, {
      id: '',
      subject: { userId, kind: 'human', issuer: 'local' },
      projects: ['*'],
      createdAt: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }).id;
  }

  it('the web Lock action: a decider locks directly under their own name, with no request', () => {
    allow('u-webdecider', 'approval:decide', 'project', PROJECT, 'yes');

    const outcome = webLockProject(cfg, webSession('u-webdecider'), PROJECT);

    expect(outcome.status).toBe('completed');
    expect(outcome.lock).toBeDefined();
    expect(lockedBy()).toMatchObject({ id: 'u-webdecider', source: 'hosted' });
    expect(pending()).toHaveLength(0);
  });

  it('the web Lock action: a writer creates a pending approval request instead of an error', () => {
    allow('u-webwriter', 'project:write', 'project', PROJECT, 'yes');

    const outcome = webLockProject(cfg, webSession('u-webwriter'), PROJECT);

    expect(outcome.status).toBe('pending-approval');
    expect(outcome.approval?.kind).toBe('project:lock');
    expect(fs.existsSync(lockFile())).toBe(false);
    expect(pending()).toHaveLength(1);
  });

  it('the web Lock action: a read-only user is refused and nothing is requested', () => {
    allow('u-webreader', 'project:read', 'project', PROJECT, 'yes');

    expect(() => webLockProject(cfg, webSession('u-webreader'), PROJECT)).toThrow(ForbiddenError);
    expect(listApprovalRequests(dataDir)).toHaveLength(0);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('the instance super-admin still locks directly, so a single-admin instance never deadlocks', () => {
    expect(lockProject(cfg, MASTER, PROJECT).status).toBe('completed');
  });

  it('a hosted lock records its gate parts, exactly as the local lock does', () => {
    lockProject(cfg, MASTER, PROJECT);
    const record = JSON.parse(fs.readFileSync(lockFile(), 'utf8')) as { stateId: { algorithm: string; digest: string }; gateParts?: Record<string, string> };
    const root = existingProjectRoot(dataDir, PROJECT)!;
    const now = runWithProjectRoot(root, () => computeGateStateId());
    expect(record.gateParts).toBeDefined();
    expect(record.gateParts).toEqual(now.parts);
    // The parts break the recorded identity down, so no reading calls the record stale.
    expect(gatePartsProblem(record as never, now)).toBeNull();
  });
});
