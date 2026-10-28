import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as identity from '../../src/server/identity.js';
import { ForbiddenError } from '../../src/server/errors.js';
import { authenticate } from '../../src/server/auth.js';
import { authorize, isInstanceAdmin, resolveFamilyReach, visibleScopes } from '../../src/server/authorization.js';
import { startHostServer, type HostServerHandle } from '../../src/server/http.js';
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

describe('a refusal caused by the key narrowing says so, and reveals nothing about the project', () => {
  let dataDir: string;
  let handle: HostServerHandle | undefined;
  const savedEnv = { ...process.env };
  const NOTE = /This key is narrowed to its projects, and this project is not one of them./;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-key-narrowing-note-'));
    process.env.WAIRON_ADMIN_TOKEN = 'master-key-narrowing-note';
    createProjectRecord(dataDir, 'proj-a');
    createProjectRecord(dataDir, 'proj-b');
    for (const p of ['proj-a', 'proj-b']) {
      allow(dataDir, 'owner', 'project:read', 'project', p);
      allow(dataDir, 'owner', 'project:write', 'project', p);
      allow(dataDir, 'owner', 'approval:decide', 'project', p);
      allow(dataDir, 'owner', 'project:admin', 'project', p);
    }
  });

  afterEach(() => {
    handle?.close();
    handle = undefined;
    process.env = { ...savedEnv };
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const start = async (): Promise<{ data: string; admin: string }> => {
    handle = startHostServer({ host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true } as HostConfig);
    const ports = await handle.listening;
    return { data: `http://127.0.0.1:${ports.port}`, admin: `http://127.0.0.1:${ports.adminPort}` };
  };
  const key = (projects: string[]): string => mintUserToken(dataDir, { id: `n-${keySeq++}`, userId: 'owner', projects });
  let keySeq = 0;
  const mcp = (base: string, token: string, project: string) =>
    fetch(`${base}/mcp?project=${project}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  it('the MCP binding says it for another project and for an unknown one alike, with the status unchanged', async () => {
    const { data } = await start();
    const token = key(['proj-a']);
    const other = await mcp(data, token, 'proj-b');
    const unknown = await mcp(data, token, 'no-such-project');
    expect(other.status).toBe(403);
    expect(unknown.status).toBe(403);
    const a = (await other.json()) as { error: string };
    const b = (await unknown.json()) as { error: string };
    expect(a.error).toMatch(/^project not authorized, unknown, or not specified. /);
    expect(a.error).toMatch(NOTE);
    expect(b).toEqual(a);
  });

  it('adds nothing for an unnarrowed key, or for a project the key covers', async () => {
    const { data } = await start();
    const wide = await mcp(data, key(['*']), 'no-such-project');
    expect(wide.status).toBe(403);
    expect(((await wide.json()) as { error: string }).error).toBe('project not authorized, unknown, or not specified');
    const covered = await mcp(data, key(['proj-a', 'ghost']), 'ghost');
    expect(covered.status).toBe(403);
    expect(((await covered.json()) as { error: string }).error).toBe('project not authorized, unknown, or not specified');
  });

  it('an admin route refuses another project and an unknown one alike', async () => {
    const { admin } = await start();
    const token = key(['proj-a']);
    const lock = (project: string) =>
      fetch(`${admin}/admin/projects/${project}/lock`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    const other = await lock('proj-b');
    const unknown = await lock('no-such-project');
    expect(other.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toEqual(await other.json());
  });

  it('the self-service mint refuses another project and an unknown one with the same words', () => {
    const cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true } as HostConfig;
    const token = key(['proj-a']);
    const refusal = (project: string): string => {
      try {
        identity.mintSelfToken(cfg, token, project, false);
      } catch (e) {
        return (e as Error).message;
      }
      return 'minted';
    };
    expect(refusal('proj-b')).toBe(refusal('no-such-project'));
    expect(refusal('proj-b')).toMatch(/caller lacks project:read/);
  });
});

describe('a read-only key is refused the admin plane\'s writes', () => {
  let dataDir: string;
  let handle: HostServerHandle | undefined;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-read-only-key-'));
    process.env.WAIRON_ADMIN_TOKEN = 'master-read-only-key';
    createProjectRecord(dataDir, 'proj-a');
    for (const capability of ['project:read', 'project:write', 'approval:decide', 'project:admin'] as const) allow(dataDir, 'owner', capability, 'project', 'proj-a');
  });

  afterEach(() => {
    handle?.close();
    handle = undefined;
    process.env = { ...savedEnv };
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('locking the project is refused for the read-only key, not for the owner\'s write key', async () => {
    const cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true } as HostConfig;
    handle = startHostServer(cfg);
    const ports = await handle.listening;
    const owner = mintUserToken(dataDir, { id: 'owner-key', userId: 'owner', projects: ['proj-a'] });
    const lock = (token: string) =>
      fetch(`http://127.0.0.1:${ports.adminPort}/admin/projects/proj-a/lock`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    const readOnly = await lock(identity.mintSelfToken(cfg, owner, 'proj-a', false));
    expect(readOnly.status).toBe(403);
    const write = await lock(identity.mintSelfToken(cfg, owner, 'proj-a', true));
    expect(write.status).not.toBe(403);
  });
});
