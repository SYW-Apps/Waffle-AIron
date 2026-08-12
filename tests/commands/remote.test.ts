import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { routeData } from '../../src/server/http.js';
import { invalidateSpecCache, saveSystemSpec, saveSubsystemSpec } from '../../src/core/specs.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { pushTree, pullTree, runRemote } from '../../src/commands/remote.js';
import { allow, mintUserToken, createPlacedProject } from '../server/helpers.js';
import type { HostConfig } from '../../src/server/types.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// `wairon remote push|pull` — the CLI half of local↔hosted migration, driven
// against a REAL hosted data plane over HTTP (no mocks, no in-process shortcut).
//
// What matters here: the transport is the same authenticated MCP endpoint an
// agent uses, a hosted refusal surfaces as a CLI error rather than a silent
// success, and neither direction touches the destination until the other side
// has produced a complete archive.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';
const now = new Date().toISOString();

describe('wairon remote (push/pull against a live hosted instance)', () => {
  let dataDir: string;
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

  /** Every file under a .wai directory as sorted relative POSIX paths — the
   *  layout-agnostic way to assert a tree arrived intact (spec placement is the
   *  workspace's business, and differs between flat and nested layouts). */
  function specFiles(waiDir: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel);
        else out.push(rel);
      }
    };
    walk(waiDir, '');
    return out.sort();
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

  function authorSubsystem(id: string, parentSystem: string): void {
    const spec: SubsystemSpec = {
      id,
      name: id,
      description: `subsystem ${id}`,
      parentSystem,
      publicInterfaces: [],
      trustedLinks: [],
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    };
    saveSubsystemSpec(spec);
  }

  beforeEach(async () => {
    dataDir = mkTmp('wairon-remote-host-');
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    server = http.createServer((req, res) => routeData(cfg, req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    local = mkTmp('wairon-remote-local-');
    initLocalProject(local, 'Local System');
    authorSubsystem('core', 'Local System');
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

  /** A token owning every grant the migration needs over `projectId`. */
  function adminToken(projectId: string, id = 'k-cli'): string {
    allow(dataDir, `u-${id}`, 'project:read', 'project', projectId);
    allow(dataDir, `u-${id}`, 'project:admin', 'project', projectId);
    return mintUserToken(dataDir, { id, userId: `u-${id}`, projects: [projectId] });
  }

  it('pushes the local tree into a hosted project, then pulls it back into a fresh checkout', async () => {
    createPlacedProject(cfg, MASTER, 'demo');
    const token = adminToken('demo');
    const target = { url, projectId: 'demo', token };

    const pushed = await pushTree(target, {});
    expect(pushed.direction).toBe('push');
    expect(pushed.projectName).toBe('Local System');
    expect(pushed.roots).toEqual(['.']);
    expect(pushed.fileCount).toBeGreaterThan(0);
    // The tree really landed in the hosted project's isolated root, file for file.
    const hosted = path.join(dataDir, 'projects', 'demo', '.wai');
    expect(fs.readFileSync(path.join(hosted, 'project.yaml'), 'utf8')).toContain('Local System');
    expect(specFiles(hosted)).toEqual(specFiles(path.join(local, '.wai')));

    // ...and comes back down into an empty checkout unchanged.
    const fresh = mkTmp('wairon-remote-fresh-');
    const pulled = await pullTree(target, { destDir: fresh });
    expect(pulled.direction).toBe('pull');
    expect(pulled.projectName).toBe('Local System');
    expect(fs.readFileSync(path.join(fresh, '.wai', 'project.yaml'), 'utf8')).toContain('Local System');
    expect(specFiles(path.join(fresh, '.wai'))).toEqual(specFiles(path.join(local, '.wai')));
  });

  it('creates the destination project as part of a first push', async () => {
    // Creating rides the WEB plane (the data plane cannot address a project that
    // does not exist yet), so the instance must expose it.
    fs.writeFileSync(
      path.join(dataDir, 'exposure-policy.json'),
      JSON.stringify({ webUiEnabled: true, requireTls: false }),
    );
    // The unit must exist; the project must not.
    const unit = createPlacedProject(cfg, MASTER, 'placeholder');
    allow(dataDir, 'u-creator', 'project:create', 'unit', unit.id);
    allow(dataDir, 'u-creator', 'project:admin', 'project', 'brand-new');
    const token = mintUserToken(dataDir, { id: 'k-creator', userId: 'u-creator', projects: ['*'] });

    const pushed = await pushTree({ url, projectId: 'brand-new', token }, { createUnitId: unit.id });
    expect(pushed.createdProject).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, 'projects', 'brand-new', '.wai', 'project.yaml'), 'utf8'))
      .toContain('Local System');
  });

  it('says so plainly when --unit is used against an instance with no web plane', async () => {
    // No exposure policy written: the web plane answers 404, and a create cannot
    // ride the data plane at all.
    const unit = createPlacedProject(cfg, MASTER, 'placeholder');
    allow(dataDir, 'u-creator', 'project:create', 'unit', unit.id);
    const token = mintUserToken(dataDir, { id: 'k-creator', userId: 'u-creator', projects: ['*'] });

    await expect(
      pushTree({ url, projectId: 'brand-new', token }, { createUnitId: unit.id }),
    ).rejects.toThrow(/does not expose the project route/);
  });

  it('carries a chained subproject through the round trip', async () => {
    // Chain a child into the local project, then migrate the whole family.
    const child = path.join(local, 'packages', 'billing');
    initLocalProject(child, 'Billing');
    setProjectRoot(local);
    invalidateSpecCache();
    saveSubsystemSpec({
      id: 'billing',
      name: 'billing',
      description: 'chained billing',
      parentSystem: 'Local System',
      publicInterfaces: [],
      projectPath: 'packages/billing',
      trustedLinks: [],
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    });

    createPlacedProject(cfg, MASTER, 'family');
    const target = { url, projectId: 'family', token: adminToken('family') };

    const pushed = await pushTree(target, {});
    expect(pushed.roots).toEqual(['.', 'packages/billing']);
    expect(fs.readFileSync(path.join(dataDir, 'projects', 'family', 'packages', 'billing', '.wai', 'project.yaml'), 'utf8'))
      .toContain('Billing');

    const fresh = mkTmp('wairon-remote-family-');
    const pulled = await pullTree(target, { destDir: fresh });
    expect(pulled.roots).toEqual(['.', 'packages/billing']);
    expect(fs.existsSync(path.join(fresh, 'packages', 'billing', '.wai', 'project.yaml'))).toBe(true);
  });

  it('writes the archive to a file when asked, so an air-gapped move is the same command', async () => {
    createPlacedProject(cfg, MASTER, 'demo');
    const archiveDir = mkTmp('wairon-remote-archive-');
    const out = path.join(archiveDir, 'moved.waitree');

    const pushed = await pushTree({ url, projectId: 'demo', token: adminToken('demo') }, { archivePath: out });
    expect(pushed.archivePath).toBe(out);
    expect(fs.statSync(out).size).toBeGreaterThan(0);
  });

  it('surfaces a hosted REFUSAL as an error, not a silent success', async () => {
    createPlacedProject(cfg, MASTER, 'demo');
    // Seed authored design on the hosted side so a no-force push must be refused.
    await pushTree({ url, projectId: 'demo', token: adminToken('demo') }, {});

    const target = { url, projectId: 'demo', token: adminToken('demo', 'k-second') };
    await expect(pushTree(target, {})).rejects.toThrow(/already holds an authored spec tree/);

    // With --force it goes through and reports the hosted backup.
    const forced = await pushTree(target, { replaceExisting: true });
    expect(forced.backupPath).toBeTruthy();
  });

  it('refuses a read-only token with an actionable message', async () => {
    createPlacedProject(cfg, MASTER, 'demo');
    allow(dataDir, 'u-reader', 'project:read', 'project', 'demo');
    const token = mintUserToken(dataDir, { id: 'k-reader', userId: 'u-reader', projects: ['demo'] });

    await expect(pushTree({ url, projectId: 'demo', token }, {})).rejects.toThrow(/project:admin/);
    // A read grant is enough to pull, though.
    const fresh = mkTmp('wairon-remote-read-');
    await expect(pullTree({ url, projectId: 'demo', token }, { destDir: fresh })).resolves.toBeTruthy();
  });

  it('reports a bad credential and an unreachable instance clearly', async () => {
    createPlacedProject(cfg, MASTER, 'demo');
    await expect(pushTree({ url, projectId: 'demo', token: 'wk_not-a-real-token' }, {})).rejects.toThrow(
      /Unauthorized|Forbidden/,
    );
    await expect(
      pullTree({ url: 'http://127.0.0.1:1', projectId: 'demo', token: 'x' }, { destDir: mkTmp('wai-none-') }),
    ).rejects.toThrow(/Could not reach the hosted instance/);
  });

  it('runRemote resolves the target from the environment and rejects an unknown action', async () => {
    createPlacedProject(cfg, MASTER, 'demo');
    process.env.WAIRON_REMOTE_URL = url;
    process.env.WAIRON_REMOTE_PROJECT = 'demo';
    process.env.WAIRON_REMOTE_TOKEN = adminToken('demo');

    await expect(runRemote('push', {})).resolves.toBeUndefined();
    expect(fs.readFileSync(path.join(dataDir, 'projects', 'demo', '.wai', 'project.yaml'), 'utf8'))
      .toContain('Local System');

    await expect(runRemote('teleport', {})).rejects.toThrow(/Unknown remote action/);
  });

  it('runRemote names every missing connection detail at once', async () => {
    delete process.env.WAIRON_REMOTE_URL;
    delete process.env.WAIRON_REMOTE_PROJECT;
    delete process.env.WAIRON_REMOTE_TOKEN;
    await expect(runRemote('push', {})).rejects.toThrow(/--url .*--project .*--token/s);
  });
});
