import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { routeData } from '../../src/server/http.js';
import { ensureInstanceIdentity } from '../../src/server/instance.js';
import { createWebSession } from '../../src/server/websessions.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { assembleArchive } from '../../sdk/src/archive.js';
import { allow, mintUserToken, createPlacedProject, seedChainedMount } from './helpers.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Hosted spec-tree transfer (sdd_host): sdd_host_export_tree /
// sdd_host_import_tree on the MCP data plane, and the /web/projects/tree routes.
//
// The claims under test: export needs project:read and import project:admin;
// both are TREE-scoped (a subproject-qualified credential transfers exactly that
// child); executable content is always refused over the wire; and a refused
// import leaves the destination exactly as it was.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';
const FUTURE = (): string => new Date(Date.now() + 3_600_000).toISOString();

describe('hosted spec-tree transfer', () => {
  let dataDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let port: number;
  const savedEnv = { ...process.env };

  /** An HTTP call capturing the body as BYTES — an archive download is binary. */
  function raw(opts: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: opts.method, path: opts.path, headers: opts.headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.from(c)));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
          );
        },
      );
      req.on('error', reject);
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });
  }

  /** One authenticated, project-bound tools/call through the REAL hosted path. */
  async function call(
    token: string,
    project: string,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ text: string; isError: boolean }> {
    const res = await raw({
      method: 'POST',
      path: `/mcp?project=${encodeURIComponent(project)}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body.toString('utf8'));
    return { text: parsed.result?.content?.[0]?.text ?? '', isError: parsed.result?.isError === true };
  }

  /** Seed a real, AUTHORED spec tree into a hosted project's isolated root —
   *  an L0 spec plus a subsystem, so it counts as design rather than the empty
   *  bootstrap every hosted project is created with. */
  function seedTree(projectId: string, systemName: string): string {
    const root = path.join(dataDir, 'projects', projectId);
    const specs = path.join(root, '.wai', 'specs');
    fs.mkdirSync(specs, { recursive: true });
    fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), `schemaVersion: 1.0.0\nname: ${systemName}\n`);
    fs.writeFileSync(
      path.join(specs, '.index.yaml'),
      `schemaVersion: 1.0.0\nname: ${systemName}\nvision: v\nboundaries: []\nglobalRequirements: []\n` +
        `createdAt: '2026-01-01T00:00:00.000Z'\nupdatedAt: '2026-01-01T00:00:00.000Z'\n`,
    );
    fs.mkdirSync(path.join(specs, 'subsystems'), { recursive: true });
    fs.writeFileSync(
      path.join(specs, 'subsystems', 'core.yaml'),
      `id: core\nname: core\ndescription: subsystem core\nparentSystem: ${systemName}\n` +
        `publicInterfaces: []\ntrustedLinks: []\nstatus: draft\n` +
        `createdAt: '2026-01-01T00:00:00.000Z'\nupdatedAt: '2026-01-01T00:00:00.000Z'\n`,
    );
    invalidateSpecCache();
    return root;
  }

  function adminCookie(): string {
    const inst = ensureInstanceIdentity(dataDir);
    const s = createWebSession(dataDir, {
      id: '',
      subject: { userId: inst.superadminUserId, kind: 'human', issuer: 'local' },
      projects: ['*'],
      createdAt: '',
      expiresAt: FUTURE(),
    });
    return `wairon_session=${s.id}`;
  }

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-tree-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    fs.writeFileSync(
      path.join(dataDir, 'exposure-policy.json'),
      JSON.stringify({ webUiEnabled: true, requireTls: false }),
    );
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    server = http.createServer((req, res) => routeData(cfg, req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env = { ...savedEnv };
    invalidateSpecCache();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  it('exports on project:read and round-trips into another project on project:admin', async () => {
    createPlacedProject(cfg, MASTER, 'source');
    createPlacedProject(cfg, MASTER, 'target');
    seedTree('source', 'Source System');
    allow(dataDir, 'u-mover', 'project:read', 'project', 'source');
    allow(dataDir, 'u-mover', 'project:admin', 'project', 'target');
    const token = mintUserToken(dataDir, { id: 'k-mover', userId: 'u-mover', projects: ['source', 'target'] });

    const exported = await call(token, 'source', 'sdd_host_export_tree');
    expect(exported.isError, exported.text).toBe(false);
    const payload = JSON.parse(exported.text);
    expect(payload.projectName).toBe('Source System');
    expect(payload.roots).toEqual(['.']);
    expect(payload.suggestedFileName).toBe('source-system.waitree');
    expect(payload.stateId).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.archiveBase64.length).toBeGreaterThan(0);

    // 'target' was created but never authored — a freshly provisioned project
    // carries only an empty L0 spec, so the import needs no replace override.
    const imported = await call(token, 'target', 'sdd_host_import_tree', {
      archiveBase64: payload.archiveBase64,
    });
    expect(imported.isError, imported.text).toBe(false);
    const result = JSON.parse(imported.text);
    expect(result.projectName).toBe('Source System');
    // The bootstrap tree it replaced was still preserved, costing nothing.
    expect(result.replaced).toBe(true);

    // The tree really landed in the TARGET project's isolated root.
    const targetConfig = path.join(dataDir, 'projects', 'target', '.wai', 'project.yaml');
    expect(fs.readFileSync(targetConfig, 'utf8')).toContain('Source System');
  });

  it('refuses export without project:read and import without project:admin', async () => {
    createPlacedProject(cfg, MASTER, 'demo');
    seedTree('demo', 'Demo');
    // A read+write agent: enough to export, NOT enough to replace the tree.
    allow(dataDir, 'u-agent', 'project:read', 'project', 'demo');
    allow(dataDir, 'u-agent', 'project:write', 'project', 'demo');
    const agent = mintUserToken(dataDir, { id: 'k-agent', userId: 'u-agent', projects: ['demo'] });

    const exported = await call(agent, 'demo', 'sdd_host_export_tree');
    expect(exported.isError, exported.text).toBe(false);

    const imported = await call(agent, 'demo', 'sdd_host_import_tree', {
      archiveBase64: JSON.parse(exported.text).archiveBase64,
      replaceExisting: true,
    });
    expect(imported.isError).toBe(true);
    expect(imported.text).toMatch(/project:admin/);

    // A grantless owner cannot even export.
    const stranger = mintUserToken(dataDir, { id: 'k-stranger', userId: 'u-stranger', projects: ['demo'] });
    const denied = await call(stranger, 'demo', 'sdd_host_export_tree');
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/project:read/);
  });

  it('refuses an occupied destination unless replaceExisting is set, then backs the previous tree up', async () => {
    createPlacedProject(cfg, MASTER, 'source');
    createPlacedProject(cfg, MASTER, 'target');
    seedTree('source', 'Incoming');
    seedTree('target', 'Existing');
    allow(dataDir, 'u-adm', 'project:admin', 'project', 'source');
    allow(dataDir, 'u-adm', 'project:admin', 'project', 'target');
    allow(dataDir, 'u-adm', 'project:read', 'project', 'source');
    const token = mintUserToken(dataDir, { id: 'k-adm', userId: 'u-adm', projects: ['source', 'target'] });

    const archiveBase64 = JSON.parse((await call(token, 'source', 'sdd_host_export_tree')).text).archiveBase64;
    const targetConfig = path.join(dataDir, 'projects', 'target', '.wai', 'project.yaml');

    const refused = await call(token, 'target', 'sdd_host_import_tree', { archiveBase64 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/already holds an authored spec tree/);
    expect(fs.readFileSync(targetConfig, 'utf8')).toContain('Existing'); // untouched

    const replaced = await call(token, 'target', 'sdd_host_import_tree', {
      archiveBase64,
      replaceExisting: true,
    });
    expect(replaced.isError, replaced.text).toBe(false);
    const result = JSON.parse(replaced.text);
    expect(result.replaced).toBe(true);
    expect(result.backupPath).toBeTruthy();
    expect(fs.readFileSync(targetConfig, 'utf8')).toContain('Incoming');
    // Recoverable: the previous tree sits intact under the backup.
    expect(fs.readFileSync(path.join(result.backupPath, '.wai', 'project.yaml'), 'utf8')).toContain('Existing');
  });

  it('ALWAYS refuses executable content arriving over the wire', async () => {
    createPlacedProject(cfg, MASTER, 'target');
    allow(dataDir, 'u-adm', 'project:admin', 'project', 'target');
    const token = mintUserToken(dataDir, { id: 'k-adm', userId: 'u-adm', projects: ['target'] });

    const enc = new TextEncoder();
    const smuggled = assembleArchive([
      {
        path: 'wairon-tree.yaml',
        contents: enc.encode("formatVersion: 1\nprojectName: Smuggler\nroots: ['.']\n"),
      },
      { path: '.wai/project.yaml', contents: enc.encode('schemaVersion: 1.0.0\nname: Smuggler\n') },
      { path: '.wai/packs/evil/rules.cjs', contents: enc.encode('module.exports = {}') },
    ]);

    const imported = await call(token, 'target', 'sdd_host_import_tree', {
      archiveBase64: Buffer.from(smuggled).toString('base64'),
      replaceExisting: true,
    });
    expect(imported.isError).toBe(true);
    expect(imported.text).toMatch(/executable content/);
    // Nothing was written: the guard runs before a single entry is inflated, so
    // neither the smuggled pack nor the archive's own tree reached the project —
    // its provisioned tree is exactly as it was.
    const targetRoot = path.join(dataDir, 'projects', 'target');
    expect(fs.existsSync(path.join(targetRoot, '.wai', 'packs'))).toBe(false);
    expect(fs.readFileSync(path.join(targetRoot, '.wai', 'project.yaml'), 'utf8')).not.toContain('Smuggler');
    expect(fs.readdirSync(targetRoot).filter((e) => e.startsWith('.wai-staging-'))).toEqual([]);
  });

  it('is TREE-scoped: a subproject-qualified credential exports exactly that child', async () => {
    createPlacedProject(cfg, MASTER, 'parent');
    const root = seedTree('parent', 'Parent System');
    const childDir = seedChainedMount(root, 'billing', 'packages/billing');
    fs.writeFileSync(path.join(childDir, '.wai', 'project.yaml'), 'schemaVersion: 1.0.0\nname: Billing\n');
    fs.writeFileSync(
      path.join(childDir, '.wai', 'specs', '.index.yaml'),
      "schemaVersion: 1.0.0\nname: Billing\nvision: v\nboundaries: []\nglobalRequirements: []\n" +
        "createdAt: '2026-01-01T00:00:00.000Z'\nupdatedAt: '2026-01-01T00:00:00.000Z'\n",
    );
    invalidateSpecCache();

    allow(dataDir, 'u-child', 'project:read', 'project', 'parent');
    const childToken = mintUserToken(dataDir, {
      id: 'k-child',
      userId: 'u-child',
      projects: ['parent::billing'],
    });

    const exported = await call(childToken, 'parent::billing', 'sdd_host_export_tree');
    expect(exported.isError, exported.text).toBe(false);
    const payload = JSON.parse(exported.text);
    // The CHILD's own tree, not the parent's — the qualifier bound the child root.
    expect(payload.projectName).toBe('Billing');
    expect(payload.roots).toEqual(['.']);
  });

  it('serves the web download + upload routes for a session', async () => {
    createPlacedProject(cfg, MASTER, 'source');
    createPlacedProject(cfg, MASTER, 'target');
    seedTree('source', 'Web System');
    const cookie = adminCookie();

    const download = await raw({
      method: 'GET',
      path: '/web/projects/tree/export?projectId=source',
      headers: { cookie },
    });
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toBe('application/zip');
    expect(download.headers['content-disposition']).toContain('web-system.waitree');
    expect(download.body.length).toBeGreaterThan(0);

    const upload = await raw({
      method: 'POST',
      path: '/web/projects/tree/import?projectId=target',
      headers: { cookie, 'content-type': 'application/zip', 'x-wairon-web': '1' },
      body: download.body,
    });
    expect(upload.status).toBe(200);
    expect(JSON.parse(upload.body.toString('utf8')).projectName).toBe('Web System');
    expect(fs.readFileSync(path.join(dataDir, 'projects', 'target', '.wai', 'project.yaml'), 'utf8'))
      .toContain('Web System');
  });
});
