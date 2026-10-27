import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as identity from '../../src/server/identity.js';
import { ForbiddenError } from '../../src/server/errors.js';
import { authenticate } from '../../src/server/auth.js';
import { authorize, isInstanceAdmin, resolveFamilyReach, visibleScopes } from '../../src/server/authorization.js';
import { createProjectRecord, registerMemberRecord } from '../../src/server/projects.js';
import { placeProject } from '../../src/server/organization.js';
import { mintUserToken, allow, seedUnit } from './helpers.js';
import type { HostConfig, Principal } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// An API key narrowed to projects acts as its owner only within them. Its
// narrowing was enforced where a request binds a project, but routes that
// authorize the owner's permissions alone (the self-service mint, approval
// decisions, the admin views) let it reach every project its owner can. The
// narrowing is now an authorization source of its own.
// ---------------------------------------------------------------------------

describe('a key narrowed to projects acts as its owner only within them', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-key-narrowing-'));
    process.env.WAIRON_ADMIN_TOKEN = 'master-key-narrowing';
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true } as HostConfig;
    createProjectRecord(dataDir, 'proj-a');
    createProjectRecord(dataDir, 'proj-b');
    registerMemberRecord(dataDir, { id: 'billing', rootPath: '', status: 'active', createdAt: '', parentProjectId: 'proj-a', memberPath: 'packages/billing' });
    // The owner reads and writes both projects.
    for (const p of ['proj-a', 'proj-b']) {
      allow(dataDir, 'owner', 'project:read', 'project', p);
      allow(dataDir, 'owner', 'project:write', 'project', p);
      allow(dataDir, 'owner', 'approval:decide', 'project', p);
    }
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  let keySeq = 0;
  const keyFor = (projects: string[]): string => mintUserToken(dataDir, { id: `k-${keySeq++}`, userId: 'owner', projects });

  it('cannot mint a key for a project outside its narrowing, and still can inside it', () => {
    const keyA = keyFor(['proj-a']);
    expect(() => identity.mintSelfToken(cfg, keyA, 'proj-b', false)).toThrow(ForbiddenError);
    expect(identity.mintSelfToken(cfg, keyA, 'proj-a', true)).toMatch(/^wk_/);
    // A member below a covered project is covered too.
    expect(identity.mintSelfToken(cfg, keyA, 'billing', false)).toMatch(/^wk_/);
  });

  it('is denied outside its narrowing by the key narrowing, and judged by its owner within it', () => {
    const principal = authenticate(dataDir, keyFor(['proj-a']));
    expect(principal.keyNarrowing).toEqual(['proj-a']);
    expect(authorize(dataDir, principal, 'approval:decide', 'project', 'proj-b')).toEqual({ value: 'no', source: 'key-narrowing' });
    expect(authorize(dataDir, principal, 'project:write', 'subsystem', 'proj-b/orders')).toEqual({ value: 'no', source: 'key-narrowing' });
    expect(authorize(dataDir, principal, 'approval:decide', 'project', 'proj-a').value).toBe('yes');
    expect(authorize(dataDir, principal, 'project:read', 'project', 'billing').value).toBe('yes');
  });

  it('an unnarrowed key and its owner reach everything the owner can', () => {
    const principal = authenticate(dataDir, keyFor(['*']));
    expect(principal.keyNarrowing).toBeUndefined();
    expect(authorize(dataDir, principal, 'approval:decide', 'project', 'proj-b').value).toBe('yes');
    expect(identity.mintSelfToken(cfg, keyFor(['*']), 'proj-b', false)).toMatch(/^wk_/);
  });

  it('never holds the instance-admin bypass, and is denied every unit and instance scope', () => {
    const admin: Principal = {
      tokenId: 'k-admin',
      role: 'admin',
      projects: ['proj-a'],
      authenticated: true,
      permissionSubject: { subjectId: 'owner', roleBindings: [], instanceAdmin: true },
      keyNarrowing: ['proj-a'],
    };
    expect(isInstanceAdmin(admin)).toBe(false);
    expect(isInstanceAdmin({ ...admin, keyNarrowing: undefined })).toBe(true);
    expect(authorize(dataDir, admin, 'project:admin', 'instance', '')).toEqual({ value: 'no', source: 'key-narrowing' });
    expect(authorize(dataDir, admin, 'project:admin', 'unit', 'company')).toEqual({ value: 'no', source: 'key-narrowing' });
    expect(authorize(dataDir, admin, 'project:read', 'project', 'proj-a').value).toBe('yes');
  });

  it('sees and reaches only the projects its narrowing covers', () => {
    seedUnit(dataDir, 'company');
    for (const projectId of ['proj-a', 'proj-b']) {
      placeProject(dataDir, { id: '', projectId, unitId: 'company', role: 'owner', createdAt: '', createdBy: { userId: 'u-seeder', kind: 'human', issuer: 'local' } } as never);
    }
    allow(dataDir, 'owner', 'project:read', 'unit', 'company');
    const principal = authenticate(dataDir, keyFor(['proj-a']));
    const scopes = visibleScopes(dataDir, principal, 'project:read');
    const actionable = scopes.filter((s) => !s.context).map((s) => `${s.scopeKind}:${s.scopeId}`);
    expect(actionable).not.toContain('project:proj-b');
    expect(actionable).not.toContain('unit:company');
    expect(scopes.find((s) => s.scopeKind === 'unit' && s.scopeId === 'company')?.context).toBe(true);
    const reach = resolveFamilyReach(dataDir, principal, ['proj-a', 'proj-b']);
    expect(reach.readable).toEqual(['proj-a']);
    expect(reach.writable).toEqual(['proj-a']);
  });
});
