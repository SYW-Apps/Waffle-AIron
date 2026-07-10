import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { routeAdmin, resolveExposurePolicy, startHostServer, type HostServerHandle } from '../../src/server/http.js';
import type { HostConfig, HostExposurePolicy } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// HostExposurePolicy control-plane gating (sdd_host) — Phase 5b.
//
// The secure COMPATIBLE default keeps existing deployments unchanged: every
// control-plane surface mounted on the loopback admin listener. An explicit
// policy (HostConfig.exposurePolicy or the <dataDir>/exposure-policy.json file)
// gates OFF only what it disables; a disabled surface answers 404. adminApiMode
// 'disabled' unmounts everything on the admin listener, while the data plane
// (/healthz, /readyz, /mcp) rides a separate listener and is unaffected.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';

/** Grab a currently-free TCP port (best-effort; standard test pattern). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function writePolicyFile(dataDir: string, policy: Partial<HostExposurePolicy>): void {
  fs.writeFileSync(path.join(dataDir, 'exposure-policy.json'), JSON.stringify(policy));
}

// ── resolveExposurePolicy (unit) ─────────────────────────────────────────────

describe('resolveExposurePolicy', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-exposure-unit-'));
  });
  afterEach(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  function cfg(over: Partial<HostConfig> = {}): HostConfig {
    return { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true, ...over };
  }

  it('with no policy and no file → the compatible default (all surfaces on, adminApiMode local_only)', () => {
    const p = resolveExposurePolicy(cfg());
    expect(p.adminApiMode).toBe('local_only');
    expect(p.identityApiEnabled).toBe(true);
    expect(p.landscapeApiEnabled).toBe(true);
    expect(p.projectPolicyApiEnabled).toBe(true);
    expect(p.operationsApiEnabled).toBe(true);
    expect(p.adminUiEnabled).toBe(true);
    expect(p.cliControlEnabled).toBe(true);
    expect(p.requireTls).toBe(true);
  });

  it('a partial exposure-policy.json overrides only its flags, leaving the rest at the compatible default', () => {
    writePolicyFile(dataDir, { identityApiEnabled: false });
    const p = resolveExposurePolicy(cfg());
    expect(p.identityApiEnabled).toBe(false);
    expect(p.operationsApiEnabled).toBe(true); // untouched flag stays on
    expect(p.adminApiMode).toBe('local_only');
  });

  it('an explicit HostConfig.exposurePolicy wins over the file', () => {
    writePolicyFile(dataDir, { operationsApiEnabled: false });
    const p = resolveExposurePolicy(cfg({ exposurePolicy: { operationsApiEnabled: true } as HostExposurePolicy }));
    expect(p.operationsApiEnabled).toBe(true);
  });
});

// ── admin-plane surface gating (routeAdmin) ──────────────────────────────────

describe('exposure gating (routeAdmin)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let baseUrl: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-exposure-http-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
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

  async function status(pathname: string): Promise<number> {
    const res = await fetch(baseUrl + pathname, { headers: { Authorization: `Bearer ${MASTER}` } });
    await res.text();
    return res.status;
  }

  it('default (no policy): every control-plane surface is mounted', async () => {
    expect(await status('/admin/projects')).toBe(200);
    expect(await status('/identity/providers')).toBe(200);
    expect(await status('/landscape/graph')).toBe(200);
    expect(await status('/operations/health')).toBe(200);
  });

  it('disabling identityApiEnabled 404s /identity/* while /admin/* and /operations/* still work', async () => {
    writePolicyFile(dataDir, { identityApiEnabled: false });
    expect(await status('/identity/providers')).toBe(404);
    expect(await status('/admin/projects')).toBe(200);
    expect(await status('/operations/health')).toBe(200);
    expect(await status('/landscape/graph')).toBe(200);
  });

  it('disabling operationsApiEnabled 404s /operations/* while the rest still work', async () => {
    writePolicyFile(dataDir, { operationsApiEnabled: false });
    expect(await status('/operations/health')).toBe(404);
    expect(await status('/admin/projects')).toBe(200);
    expect(await status('/identity/providers')).toBe(200);
  });

  it('adminApiMode "disabled" 404s every surface on the admin listener', async () => {
    writePolicyFile(dataDir, { adminApiMode: 'disabled' });
    expect(await status('/admin/projects')).toBe(404);
    expect(await status('/identity/providers')).toBe(404);
    expect(await status('/landscape/graph')).toBe(404);
    expect(await status('/operations/health')).toBe(404);
  });
});

// ── adminApiMode disabled leaves the data plane untouched (both listeners) ────

describe('exposure gating: data plane unaffected (startHostServer)', () => {
  let dataDir: string;
  const savedEnv = { ...process.env };
  const handles: HostServerHandle[] = [];

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-exposure-dual-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
  });

  afterEach(() => {
    while (handles.length) handles.pop()!.close();
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  it('adminApiMode "disabled": admin plane 404s but /healthz on the data plane is still 200', async () => {
    writePolicyFile(dataDir, { adminApiMode: 'disabled' });
    const port = await freePort();
    const adminPort = await freePort();
    const cfg: HostConfig = { host: '127.0.0.1', port, adminHost: '127.0.0.1', adminPort, dataDir, authEnabled: true };
    handles.push(startHostServer(cfg));

    // Admin plane: everything 404s.
    const adminRes = await fetch(`http://127.0.0.1:${adminPort}/admin/projects`, {
      headers: { Authorization: `Bearer ${MASTER}` },
    });
    await adminRes.text();
    expect(adminRes.status).toBe(404);

    const opsRes = await fetch(`http://127.0.0.1:${adminPort}/operations/health`, {
      headers: { Authorization: `Bearer ${MASTER}` },
    });
    await opsRes.text();
    expect(opsRes.status).toBe(404);

    // Data plane: unaffected.
    const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = await healthz.json();
    expect(healthz.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });
});
