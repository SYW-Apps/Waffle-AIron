import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { routeData } from '../../src/server/http.js';
import { invalidateSpecCache, saveSystemSpec } from '../../src/core/specs.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  attach,
  detach,
  describeAttachment,
  resolveTarget,
  storeCredential,
  forgetCredential,
  listStoredInstances,
  storedCredentialFor,
  validateAttached,
  statusAttached,
  lockAttached,
  runRemote,
  runLogin,
  runLogout,
} from '../../src/commands/remote.js';
import { readBinding } from '../../src/commands/remotebinding.js';
import { detectHostedMcpSource } from '../../src/commands/mcp.js';
import { allow, mintUserToken, createPlacedProject } from '../server/helpers.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// `wairon remote attach` — the standing binding that makes ordinary commands
// run against a hosted project, and the credential store behind it.
//
// The claims under test: an attach that cannot reach the instance fails LOUDLY
// rather than recording a broken binding; the binding file never holds a
// credential; resolution falls back to the agent's own MCP configuration (the
// whole point — an already-wired agent means the CLI needs no second setup);
// and logout is honest that it does not revoke anything.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';
const now = new Date().toISOString();

describe('remote attachment', () => {
  let dataDir: string;
  let home: string;
  let cfg: HostConfig;
  let server: http.Server;
  let url: string;
  let local: string;
  const cleanups: string[] = [];
  const savedEnv = { ...process.env };

  function mkTmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(dir);
    return dir;
  }

  function initLocalProject(dir: string, systemName: string): void {
    fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), `schemaVersion: 1.0.0\nname: ${systemName}\n`);
    setProjectRoot(dir);
    invalidateSpecCache();
    saveSystemSpec({
      schemaVersion: '1.0.0',
      name: systemName,
      vision: `vision for ${systemName}`,
      boundaries: [],
      globalRequirements: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  function adminToken(projectId: string, id = 'k-cli'): string {
    allow(dataDir, `u-${id}`, 'project:read', 'project', projectId);
    allow(dataDir, `u-${id}`, 'project:write', 'project', projectId);
    allow(dataDir, `u-${id}`, 'project:admin', 'project', projectId);
    return mintUserToken(dataDir, { id, userId: `u-${id}`, projects: [projectId] });
  }

  beforeEach(async () => {
    dataDir = mkTmp('wairon-attach-host-');
    home = mkTmp('wairon-attach-home-');
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    // The credential store lives in the user's home — redirect it per test.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.WAIRON_REMOTE_URL;
    delete process.env.WAIRON_REMOTE_PROJECT;
    delete process.env.WAIRON_REMOTE_TOKEN;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    server = http.createServer((req, res) => routeData(cfg, req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    local = mkTmp('wairon-attach-local-');
    initLocalProject(local, 'Local System');
  });

  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env = { ...savedEnv };
    setProjectRoot(null);
    invalidateSpecCache();
    for (const dir of cleanups.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* windows file locks */
      }
    }
  });

  it('attaches, records a binding WITHOUT the credential, and resolves it back', async () => {
    createPlacedProject(cfg, MASTER, 'demo');
    const token = adminToken('demo');

    const binding = await attach(local, { url, projectId: 'demo', token });
    expect(binding.projectId).toBe('demo');
    expect(binding.source).toBe('binding-file');

    // The binding file is committable: it holds the instance and project, never a secret.
    const raw = fs.readFileSync(path.join(local, '.wai', 'remote.json'), 'utf8');
    expect(raw).toContain('demo');
    expect(raw).not.toContain(token);
    // The credential went to the user's store instead.
    expect(storedCredentialFor(url)).toBe(token);
    expect(listStoredInstances()).toContain(url.toLowerCase());

    // A later command resolves the whole target with no flags at all.
    const resolved = resolveTarget(local, {});
    expect(resolved).toEqual({ url, projectId: 'demo', token });
  });

  it('REFUSES to record a binding it cannot verify', async () => {
    createPlacedProject(cfg, MASTER, 'demo');
    // A token with no grants: the probe is refused, so the attach must fail.
    const stranger = mintUserToken(dataDir, { id: 'k-none', userId: 'u-none', projects: ['demo'] });

    await expect(attach(local, { url, projectId: 'demo', token: stranger })).rejects.toThrow();
    // Nothing was recorded — a broken binding would make every later command a mystery.
    expect(readBinding(local)).toBeNull();
    expect(storedCredentialFor(url)).toBeNull();
  });

  it('detach removes the binding but keeps the machine credential', async () => {
    createPlacedProject(cfg, MASTER, 'demo');
    await attach(local, { url, projectId: 'demo', token: adminToken('demo') });

    detach(local);
    expect(readBinding(local)).toBeNull();
    expect(resolveTarget(local, {})).toBeNull();
    // The credential belongs to the machine — other checkouts may still use it.
    expect(storedCredentialFor(url)).toBeTruthy();
  });

  it("falls back to the agent's own MCP configuration when nothing is attached", async () => {
    createPlacedProject(cfg, MASTER, 'demo');
    const token = adminToken('demo');
    // Exactly what `wairon mcp install --hosted` writes.
    fs.writeFileSync(
      path.join(local, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          wairon: {
            type: 'http',
            url: `${url}/mcp`,
            headers: { Authorization: `Bearer ${token}`, 'X-Wairon-Project': 'demo' },
          },
        },
      }),
    );

    const detected = detectHostedMcpSource(local);
    expect(detected?.kind).toBe('hosted');
    expect(detected?.url).toBe(url);
    expect(detected?.projectId).toBe('demo');

    // No attach, no flags, no env — the CLI addresses the same project the agent does.
    expect(resolveTarget(local, {})).toEqual({ url, projectId: 'demo', token });
    // ...and reports it as DERIVED, not as an explicit attachment.
    expect(describeAttachment(local)?.source).toBe('mcp-config');
  });

  it('reads a LOCAL stdio MCP entry as not-hosted', () => {
    fs.writeFileSync(
      path.join(local, '.mcp.json'),
      JSON.stringify({ mcpServers: { wairon: { command: 'wairon', args: ['mcp', 'serve'], env: {} } } }),
    );
    expect(detectHostedMcpSource(local)?.kind).toBe('local');
    expect(resolveTarget(local, {})).toBeNull();
  });

  it('survives a corrupt agent config instead of breaking the command', () => {
    fs.writeFileSync(path.join(local, '.mcp.json'), '{ this is not json');
    expect(detectHostedMcpSource(local)).toBeNull();
    expect(resolveTarget(local, {})).toBeNull();
  });

  it('runs validate, status and lock against the ATTACHED project', async () => {
    createPlacedProject(cfg, MASTER, 'demo');
    const token = adminToken('demo');
    const target = { url, projectId: 'demo', token };

    const report = (await validateAttached(target)) as { errors?: unknown[] };
    expect(Array.isArray(report.errors)).toBe(true);

    const status = await statusAttached(target);
    expect(status.length).toBeGreaterThan(0);

    // A hosted lock of a bootstrap tree either freezes or refuses with findings —
    // either way it is the INSTANCE's verdict, reported verbatim.
    await expect(lockAttached(target)).resolves.toBeTypeOf('string');
  });

  it('login stores a credential (verified when a project is named) and logout is honest', async () => {
    createPlacedProject(cfg, MASTER, 'demo');
    const token = adminToken('demo');

    await storeCredential(url, token, 'demo');
    expect(storedCredentialFor(url)).toBe(token);

    forgetCredential(url);
    expect(storedCredentialFor(url)).toBeNull();
    // Assert THIS instance is forgotten rather than the store being empty: the
    // store is per-machine, so other entries are none of this test's business.
    expect(listStoredInstances()).not.toContain(url.toLowerCase());
  });

  it('login refuses a credential the instance rejects', async () => {
    createPlacedProject(cfg, MASTER, 'demo');
    await expect(storeCredential(url, 'wk_bogus', 'demo')).rejects.toThrow();
    expect(storedCredentialFor(url)).toBeNull();
  });

  it('drives the whole flow through the command entry points', async () => {
    createPlacedProject(cfg, MASTER, 'demo');
    const token = adminToken('demo');
    setProjectRoot(local);

    await runLogin(url, { token, project: 'demo' });
    expect(storedCredentialFor(url)).toBe(token);

    // attach with no --token: the stored credential is found for this instance.
    await runRemote('attach', { url, project: 'demo' });
    expect(readBinding(local)?.projectId).toBe('demo');

    await runRemote('status', {});
    await runRemote('detach', {});
    expect(readBinding(local)).toBeNull();

    await runLogout(url, {});
    expect(storedCredentialFor(url)).toBeNull();

    await expect(runRemote('teleport', { url, project: 'demo', token })).rejects.toThrow(
      /Unknown remote action/,
    );
  });

  it('status and detach work on an unattached checkout without demanding a target', async () => {
    setProjectRoot(local);
    await expect(runRemote('status', {})).resolves.toBeUndefined();
    await expect(runRemote('detach', {})).resolves.toBeUndefined();
    // ...but push still names exactly what is missing.
    await expect(runRemote('push', {})).rejects.toThrow(/not attached/);
  });
});
