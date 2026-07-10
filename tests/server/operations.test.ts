import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  runChecks,
  collectUsage,
  buildHealthReport,
  evaluateUsage,
  getHealthReport,
  getUsage,
  evaluateQuota,
} from '../../src/server/operations.js';
import { routeAdmin } from '../../src/server/http.js';
import { createProject } from '../../src/server/admin.js';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import { UnauthenticatedError, ForbiddenError } from '../../src/server/errors.js';
import type {
  ApiKeyRecord,
  HostConfig,
  HostedProjectRecord,
  PrincipalSubject,
  ProjectGrant,
  ResourceQuotaPolicy,
  ResourceUsageSnapshot,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Operations orchestrator + diagnostics/quota specialists + portal (sdd_host)
// — Phase 5b. The two specialists are exercised as PURE functions over hand-built
// records; the orchestrator + portal are exercised over a real <dataDir> with
// real minted credentials, mirroring landscape.test.ts. Covers registry
// consistency / state / count checks, usage-snapshot shape, worst-status health
// aggregation, advisory quota annotation (observe/warn + block downgrade +
// disabled), operations:read gating, and the three read-only HTTP endpoints.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';
const SUBJECT: PrincipalSubject = { userId: 'u-test', kind: 'human', issuer: 'local' };

function rec(over: Partial<HostedProjectRecord> = {}): HostedProjectRecord {
  return {
    id: 'p',
    rootPath: '/data/projects/p',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function snapshot(over: Partial<ResourceUsageSnapshot> = {}): ResourceUsageSnapshot {
  return { scope: 'instance', capturedAt: '2026-01-01T00:00:00.000Z', quotaMessages: [], ...over };
}

// ── Pure specialists ─────────────────────────────────────────────────────────

describe('diagnostics specialist (pure)', () => {
  it('runChecks: consistent records → all checks pass', () => {
    const checks = runChecks([rec({ id: 'a', rootPath: '/x/a' }), rec({ id: 'b', rootPath: '/x/b' })]);
    const consistency = checks.find((c) => c.id === 'project-registry-consistency')!;
    expect(consistency.status).toBe('pass');
    expect(checks.find((c) => c.id === 'project-state-presence')!.status).toBe('pass');
    expect(checks.find((c) => c.id === 'project-count-sanity')!.status).toBe('pass');
    for (const c of checks) expect(Date.parse(c.observedAt)).toBeGreaterThan(0);
  });

  it('runChecks: a ghost record with an unresolvable root fails the consistency check', () => {
    const checks = runChecks([rec({ id: 'a', rootPath: '/x/a' }), rec({ id: 'ghost', rootPath: '' })]);
    const consistency = checks.find((c) => c.id === 'project-registry-consistency')!;
    expect(consistency.status).toBe('fail');
    expect(consistency.message).toMatch(/unresolvable root/i);
  });

  it('runChecks: duplicate ids fail the consistency check', () => {
    const checks = runChecks([rec({ id: 'dup', rootPath: '/x/1' }), rec({ id: 'dup', rootPath: '/x/2' })]);
    expect(checks.find((c) => c.id === 'project-registry-consistency')!.status).toBe('fail');
  });

  it('runChecks: a disabled record warns the state-presence check', () => {
    const checks = runChecks([rec({ id: 'a', rootPath: '/x/a' }), rec({ id: 'b', rootPath: '/x/b', status: 'disabled' })]);
    expect(checks.find((c) => c.id === 'project-state-presence')!.status).toBe('warn');
  });

  it('runChecks: zero active projects warns the count-sanity check', () => {
    const checks = runChecks([]);
    expect(checks.find((c) => c.id === 'project-count-sanity')!.status).toBe('warn');
  });

  it('runChecks: a scope selector narrows the checks to one project', () => {
    // Ghost record is 'b'; scoping to the healthy 'a' hides it → consistency passes.
    const checks = runChecks([rec({ id: 'a', rootPath: '/x/a' }), rec({ id: 'b', rootPath: '' })], 'a');
    expect(checks.find((c) => c.id === 'project-registry-consistency')!.status).toBe('pass');
  });

  it('collectUsage: scope unset yields only an instance snapshot with the active count', () => {
    const usage = collectUsage([rec({ id: 'a' }), rec({ id: 'b' }), rec({ id: 'c', status: 'disabled' })]);
    expect(usage).toHaveLength(1);
    expect(usage[0].scope).toBe('instance');
    expect(usage[0].projectCount).toBe(2);
    expect(usage[0].quotaMessages).toEqual([]);
    expect(Date.parse(usage[0].capturedAt)).toBeGreaterThan(0);
  });

  it('collectUsage: a project scope adds a project-scoped snapshot', () => {
    const usage = collectUsage([rec({ id: 'a' }), rec({ id: 'b' })], 'b');
    expect(usage.map((u) => u.scope)).toEqual(['instance', 'b']);
    expect(usage[1].quotaMessages).toEqual([]);
  });

  it('collectUsage: scope "instance" yields only the instance snapshot', () => {
    const usage = collectUsage([rec({ id: 'a' })], 'instance');
    expect(usage.map((u) => u.scope)).toEqual(['instance']);
  });

  it('buildHealthReport: worst-status aggregation (fail → unhealthy beats warn)', () => {
    const usage = collectUsage([rec({ id: 'a' })]);
    expect(buildHealthReport([{ id: 'x', status: 'pass', message: '', observedAt: '' }], usage).status).toBe('ok');
    expect(
      buildHealthReport(
        [
          { id: 'x', status: 'pass', message: '', observedAt: '' },
          { id: 'y', status: 'warn', message: '', observedAt: '' },
        ],
        usage,
      ).status,
    ).toBe('degraded');
    const report = buildHealthReport(
      [
        { id: 'x', status: 'warn', message: '', observedAt: '' },
        { id: 'y', status: 'fail', message: '', observedAt: '' },
      ],
      usage,
    );
    expect(report.status).toBe('unhealthy');
    expect(report.usage).toBe(usage);
    expect(Date.parse(report.generatedAt)).toBeGreaterThan(0);
  });
});

describe('quota specialist (pure, advisory)', () => {
  it('evaluateUsage: a disabled policy returns the snapshots unchanged', () => {
    const snaps = [snapshot({ projectCount: 99 })];
    const policy: ResourceQuotaPolicy = { enabled: false, mode: 'warn', maxProjectsPerUser: 1 };
    expect(evaluateUsage(snaps, policy)).toBe(snaps);
    expect(evaluateUsage(snaps, policy)[0].quotaMessages).toEqual([]);
  });

  it('evaluateUsage: warn mode annotates an exceeded limit as [warn]', () => {
    const out = evaluateUsage([snapshot({ projectCount: 3 })], { enabled: true, mode: 'warn', maxProjectsPerUser: 2 });
    expect(out[0].quotaMessages).toHaveLength(1);
    expect(out[0].quotaMessages[0]).toMatch(/^\[warn\] projectCount 3 exceeds limit 2$/);
  });

  it('evaluateUsage: observe mode annotates as [observe]', () => {
    const out = evaluateUsage([snapshot({ projectBytes: 100 })], { enabled: true, mode: 'observe', maxProjectBytes: 10 });
    expect(out[0].quotaMessages[0]).toMatch(/^\[observe\] projectBytes 100 exceeds limit 10$/);
  });

  it('evaluateUsage: block mode is downgraded to an advisory [observe] (never blocks)', () => {
    const out = evaluateUsage(
      [snapshot({ mcpRequestsLastMinute: 50, auditEventsToday: 500 })],
      { enabled: true, mode: 'block', maxMcpRequestsPerMinute: 10, maxAuditEventsPerDay: 100 },
    );
    expect(out[0].quotaMessages).toHaveLength(2);
    expect(out[0].quotaMessages.every((m) => m.startsWith('[observe]'))).toBe(true);
  });

  it('evaluateUsage: within-limit snapshots are returned unchanged', () => {
    const snaps = [snapshot({ projectCount: 1 })];
    const out = evaluateUsage(snaps, { enabled: true, mode: 'warn', maxProjectsPerUser: 5 });
    expect(out[0].quotaMessages).toEqual([]);
    expect(out[0]).toBe(snaps[0]); // unchanged snapshot object reused
  });
});

// ── Orchestrator (real dataDir, minted credentials) ──────────────────────────

describe('operations orchestrator (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-operations-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  let tokenSeq = 0;
  function mintToken(grants: ProjectGrant[]): string {
    const token = 'wk_' + crypto.randomBytes(8).toString('hex');
    const record: ApiKeyRecord = {
      id: `tok-${tokenSeq++}`,
      keyHash: hashToken(token),
      role: 'editor',
      projects: grants.map((g) => g.projectId),
      grants,
      createdAt: new Date().toISOString(),
      ownerSubject: SUBJECT,
    };
    createCredential(dataDir, record);
    return token;
  }

  const opsToken = () => mintToken([{ projectId: '*', permissions: ['operations:read'] }]);
  const plainToken = () => mintToken([{ projectId: '*', permissions: ['mcp:write'] }]);

  /** Overwrite projects.json directly (used to seed a ghost record). */
  function seedRegistry(records: HostedProjectRecord[]): void {
    fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify(records, null, 2) + '\n');
  }

  it('getHealthReport: operations:read → ok; plain token → 403; unauthenticated → 401; admin → ok', () => {
    createProject(cfg, MASTER, 'proj-a');

    const report = getHealthReport(cfg, opsToken());
    expect(report.status).toBe('ok');
    expect(report.checks.length).toBe(3);
    expect(report.usage?.[0].scope).toBe('instance');

    expect(() => getHealthReport(cfg, plainToken())).toThrow(ForbiddenError);
    expect(() => getHealthReport(cfg, null)).toThrow(UnauthenticatedError);
    expect(() => getHealthReport(cfg, 'bogus-token')).toThrow(UnauthenticatedError);
    expect(getHealthReport(cfg, MASTER).status).toBe('ok');
  });

  it('getHealthReport: a ghost project record makes the instance unhealthy', () => {
    seedRegistry([rec({ id: 'ghost', rootPath: '', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' })]);
    expect(getHealthReport(cfg, MASTER).status).toBe('unhealthy');
  });

  it('getUsage: returns the instance snapshot with the active project count', () => {
    createProject(cfg, MASTER, 'proj-a');
    createProject(cfg, MASTER, 'proj-b');
    const usage = getUsage(cfg, opsToken());
    expect(usage[0].scope).toBe('instance');
    expect(usage[0].projectCount).toBe(2);
    expect(() => getUsage(cfg, plainToken())).toThrow(ForbiddenError);
  });

  it('evaluateQuota: disabled default → no messages; a configured warn policy annotates', () => {
    createProject(cfg, MASTER, 'proj-a');

    // No cfg.quotaPolicy → disabled default → advisory annotation is a no-op.
    expect(evaluateQuota(cfg, opsToken())[0].quotaMessages).toEqual([]);

    // A configured warn policy annotates the instance snapshot.
    const warned = evaluateQuota(
      { ...cfg, quotaPolicy: { enabled: true, mode: 'warn', maxProjectsPerUser: 0 } },
      opsToken(),
    );
    expect(warned[0].quotaMessages.some((m) => m.startsWith('[warn]'))).toBe(true);
    expect(() => evaluateQuota(cfg, plainToken())).toThrow(ForbiddenError);
  });
});

// ── HTTP portal (routeAdmin) ─────────────────────────────────────────────────

describe('operations portal (sdd_host http)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let baseUrl: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-operations-http-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    cfg = {
      host: '127.0.0.1',
      port: 0,
      adminHost: '127.0.0.1',
      adminPort: 0,
      dataDir,
      authEnabled: true,
      quotaPolicy: { enabled: true, mode: 'warn', maxProjectsPerUser: 0 },
    };
    server = http.createServer((req, res) => {
      void routeAdmin(cfg, req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  let tokenSeq = 0;
  function mintToken(grants: ProjectGrant[]): string {
    const token = 'wk_' + crypto.randomBytes(8).toString('hex');
    createCredential(dataDir, {
      id: `htok-${tokenSeq++}`,
      keyHash: hashToken(token),
      role: 'editor',
      projects: grants.map((g) => g.projectId),
      grants,
      createdAt: new Date().toISOString(),
      ownerSubject: SUBJECT,
    });
    return token;
  }

  async function api(
    method: string,
    pathname: string,
    opts: { cred?: string } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = {};
    if (opts.cred) headers['Authorization'] = `Bearer ${opts.cred}`;
    const res = await fetch(baseUrl + pathname, { method, headers });
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  it('the three operations endpoints respond with the correct statuses through routeAdmin', async () => {
    createProject(cfg, MASTER, 'proj-a');

    const health = await api('GET', '/operations/health', { cred: MASTER });
    expect(health.status).toBe(200);
    expect(['ok', 'degraded', 'unhealthy']).toContain(health.json.status);
    expect(Array.isArray(health.json.checks)).toBe(true);

    const usage = await api('GET', '/operations/usage', { cred: MASTER });
    expect(usage.status).toBe(200);
    expect(usage.json[0].scope).toBe('instance');

    const quota = await api('GET', '/operations/quota?scope=instance', { cred: MASTER });
    expect(quota.status).toBe(200);
    expect(quota.json[0].quotaMessages.some((m: string) => m.startsWith('[warn]'))).toBe(true);
  });

  it('operations endpoints enforce auth: unauthenticated → 401, plain token → 403', async () => {
    expect((await api('GET', '/operations/health')).status).toBe(401);
    const plain = mintToken([{ projectId: '*', permissions: ['mcp:write'] }]);
    expect((await api('GET', '/operations/health', { cred: plain })).status).toBe(403);
  });

  it('an unknown operations path is 404', async () => {
    expect((await api('GET', '/operations/nope', { cred: MASTER })).status).toBe(404);
  });
});
