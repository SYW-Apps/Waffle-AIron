import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { routeData } from '../../src/server/http.js';
import { getExposurePolicy, setExposurePolicy } from '../../src/server/operations.js';
import { ForbiddenError } from '../../src/server/errors.js';
import { ensureInstanceIdentity } from '../../src/server/instance.js';
import { createWebSession } from '../../src/server/websessions.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { allow, mintUserToken, seedUnit, subjectOf, createPlacedProject } from './helpers.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Project ops surfacing (sdd_host): the exposure-policy administration, the new
// /web routes riding the project ops orchestrator, and the hosted project-ops
// MCP tools dispatched on the data plane — all resolver-gated by their OWNING
// orchestrators (the seam itself holds no gates).
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';

describe('exposure-policy administration (operations orchestrator)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-exposure-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  it('reads the EFFECTIVE policy (safe default: web UI off) and replaces it wholesale, audited at security level', () => {
    const initial = getExposurePolicy(cfg, MASTER);
    expect(initial.webUiEnabled).toBe(false); // the safe default
    expect(initial.requireTls).toBe(true);

    const stored = setExposurePolicy(cfg, MASTER, { ...initial, webUiEnabled: true });
    expect(stored.webUiEnabled).toBe(true);
    // Persisted: a fresh read reflects it, and the file exists.
    expect(getExposurePolicy(cfg, MASTER).webUiEnabled).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'exposure-policy.json'))).toBe(true);

    const events = queryAuditEvents(dataDir, { action: 'exposure.set' });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('security');
  });

  it('requires instance-level project:admin — a unit-scoped admin is refused', () => {
    const unit = seedUnit(dataDir, 'team');
    allow(dataDir, 'u-adm', 'project:admin', 'unit', unit.id);
    const token = mintUserToken(dataDir, { id: 'k-adm', userId: 'u-adm' });
    expect(() => getExposurePolicy(cfg, token)).toThrow(ForbiddenError);
    expect(() => setExposurePolicy(cfg, token, getExposurePolicy(cfg, MASTER))).toThrow(ForbiddenError);
  });
});

describe('project ops over HTTP (/web routes + MCP data-plane tools)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let port: number;
  const savedEnv = { ...process.env };
  const FUTURE = (): string => new Date(Date.now() + 3_600_000).toISOString();

  function raw(opts: { method: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: opts.method, path: opts.path, headers: opts.headers },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on('error', reject);
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });
  }

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-ops-http-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    fs.writeFileSync(path.join(dataDir, 'exposure-policy.json'), JSON.stringify({ webUiEnabled: true, requireTls: false }));
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    server = http.createServer((req, res) => routeData(cfg, req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  function adminCookie(): string {
    const inst = ensureInstanceIdentity(dataDir);
    const s = createWebSession(dataDir, {
      id: '', subject: { userId: inst.superadminUserId, kind: 'human', issuer: 'local' },
      projects: ['*'], createdAt: '', expiresAt: FUTURE(),
    });
    return `wairon_session=${s.id}`;
  }

  it('the /web/admin ops routes answer for an instance admin and refuse a viewer', async () => {
    const cookie = adminCookie();

    // Global packs, pack policy, exposure, audit, git backing — all reachable.
    expect((await raw({ method: 'GET', path: '/web/admin/packs', headers: { cookie } })).status).toBe(200);
    expect((await raw({ method: 'GET', path: '/web/admin/policy', headers: { cookie } })).status).toBe(200);
    const exposure = await raw({ method: 'GET', path: '/web/admin/exposure', headers: { cookie } });
    expect(exposure.status).toBe(200);
    expect(JSON.parse(exposure.body).webUiEnabled).toBe(true);
    expect((await raw({ method: 'GET', path: '/web/admin/audit', headers: { cookie } })).status).toBe(200);
    expect((await raw({ method: 'GET', path: '/web/admin/audit/count', headers: { cookie } })).status).toBe(200);
    expect((await raw({ method: 'GET', path: '/web/admin/git-backing', headers: { cookie } })).status).toBe(200);

    // A viewer session: the instance-admin-gated reads refuse (403), never leak.
    const viewer = createWebSession(dataDir, {
      id: '', subject: { userId: 'viewer', kind: 'human', issuer: 'local' },
      projects: ['*'], createdAt: '', expiresAt: FUTURE(),
    });
    const vc = `wairon_session=${viewer.id}`;
    expect((await raw({ method: 'GET', path: '/web/admin/packs', headers: { cookie: vc } })).status).toBe(403);
    expect((await raw({ method: 'GET', path: '/web/admin/exposure', headers: { cookie: vc } })).status).toBe(403);
    expect((await raw({ method: 'GET', path: '/web/admin/audit', headers: { cookie: vc } })).status).toBe(403);
  });

  it('the per-project ops routes ride the project scope (packs list 200; a CSRF-less cookie mutation 403)', async () => {
    const cookie = adminCookie();
    createPlacedProject(cfg, MASTER, 'demo');

    const packsList = await raw({ method: 'GET', path: '/web/projects/packs?projectId=demo', headers: { cookie } });
    expect(packsList.status).toBe(200);
    expect(JSON.parse(packsList.body).packs).toEqual([]);

    // Policy evaluation (project:write) works for the admin over HTTP.
    const evaluation = await raw({ method: 'GET', path: '/web/projects/policy?projectId=demo', headers: { cookie } });
    expect(evaluation.status).toBe(200);

    // A cookie-authenticated mutation WITHOUT the CSRF header never dispatches.
    const noCsrf = await raw({
      method: 'POST',
      path: '/web/projects/git/commit',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'demo' }),
    });
    expect(noCsrf.status).toBe(403);

    // With the header: a non-git-backed project publishes nothing (200, published:false).
    const commit = await raw({
      method: 'POST',
      path: '/web/projects/git/commit',
      headers: { cookie, 'content-type': 'application/json', 'x-wairon-web': '1' },
      body: JSON.stringify({ projectId: 'demo' }),
    });
    expect(commit.status).toBe(200);
    expect(JSON.parse(commit.body).published).toBe(false);
  });

  it('GET /web/projects/profiles lists the project-scoped profile catalog (project:read) and fails closed', async () => {
    const cookie = adminCookie();
    createPlacedProject(cfg, MASTER, 'demo');

    // Authorized (instance admin): the project-scoped catalog, envelope-keyed
    // 'profiles' exactly like /web/admin/profiles, includes the built-ins.
    const listed = await raw({ method: 'GET', path: '/web/projects/profiles?projectId=demo', headers: { cookie } });
    expect(listed.status).toBe(200);
    const profiles = JSON.parse(listed.body).profiles;
    expect(Array.isArray(profiles)).toBe(true);
    expect(profiles.map((p: { id: string }) => p.id)).toContain('backend');

    // No session at all: unauthenticated.
    const anon = await raw({ method: 'GET', path: '/web/projects/profiles?projectId=demo' });
    expect(anon.status).toBe(401);

    // A session with no grant over the project (or its unit/instance): forbidden.
    const viewer = createWebSession(dataDir, {
      id: '', subject: { userId: 'viewer-profiles', kind: 'human', issuer: 'local' },
      projects: ['*'], createdAt: '', expiresAt: FUTURE(),
    });
    const vc = `wairon_session=${viewer.id}`;
    const forbidden = await raw({ method: 'GET', path: '/web/projects/profiles?projectId=demo', headers: { cookie: vc } });
    expect(forbidden.status).toBe(403);
  });

  it('MCP data plane: the hosted ops tools dispatch bound to THE authorized project, resolver-gated upstream', async () => {
    createPlacedProject(cfg, MASTER, 'demo');
    allow(dataDir, 'u-agent', 'project:read', 'project', 'demo');
    allow(dataDir, 'u-agent', 'project:write', 'project', 'demo');
    const token = mintUserToken(dataDir, { id: 'k-agent', userId: 'u-agent', projects: ['demo'] });

    const call = (name: string, args: Record<string, unknown> = {}) =>
      raw({
        method: 'POST',
        path: '/mcp',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });

    // pack list (project:read) → an empty listing for a fresh project.
    const list = await call('sdd_host_pack_list');
    expect(list.status).toBe(200);
    const listResult = JSON.parse(list.body).result;
    expect(listResult.isError).toBeFalsy();
    expect(JSON.parse(listResult.content[0].text)).toEqual([]);

    // policy evaluate (project:write) → a compliance result.
    const evaluated = await call('sdd_host_policy_evaluate');
    expect(JSON.parse(evaluated.body).result.isError).toBeFalsy();

    // pack install needs project:admin — the read/write agent is refused.
    const install = await call('sdd_host_pack_install', { name: 'acme', content: 'name: acme' });
    const installResult = JSON.parse(install.body).result;
    expect(installResult.isError).toBe(true);
    expect(installResult.content[0].text).toMatch(/project:admin/);

    // commit on a non-git-backed project: allowed (project:write), publishes nothing.
    const commit = await call('sdd_host_commit_project', { message: 'save' });
    const commitResult = JSON.parse(commit.body).result;
    expect(commitResult.isError).toBeFalsy();
    expect(JSON.parse(commitResult.content[0].text)).toEqual({ published: false });
  });
});
