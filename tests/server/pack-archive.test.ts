import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildPack } from '@wairon/sdk';
import { zipSync } from 'fflate';
import { invalidateSpecCache } from '../../src/core/specs.js';
import * as packs from '../../src/server/packs.js';
import { AdminAuthError } from '../../src/server/admin.js';
import { UnauthenticatedError } from '../../src/server/errors.js';
import { createPlacedProject, mintUserToken } from './helpers.js';
import { loadProjectConfig } from '../../src/config/loader.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { routeData } from '../../src/server/http.js';
import { createWebSession } from '../../src/server/websessions.js';
import { ensureInstanceIdentity } from '../../src/server/instance.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Integration test for hosted ZIP (.wpack) pack-archive install (sdd_host).
// Exercises the pack orchestrator + registry archive path (host_sdk_adapter →
// @wairon/sdk): declarative install at server-global and project scope, the
// code-pack rejection, an unsafe (zip-slip) archive rejection, name-from-
// envelope vs the override, and the raw-zip web upload route end to end.
// ---------------------------------------------------------------------------

const ADMIN = 'test-admin-secret';
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const srcRoots: string[] = [];

/** A minimal declarative pack source directory (envelope + inner pack.yaml with
 *  one profile + one language table), whose identity is `name`. */
function writeDeclarativeSource(name: string, version = '1.0.0'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpack-src-'));
  srcRoots.push(dir);
  const pack = path.join(dir, name);
  fs.mkdirSync(pack, { recursive: true });
  fs.writeFileSync(
    path.join(pack, 'wairon-pack.yaml'),
    ['formatVersion: 1', `name: ${name}`, `version: ${version}`, 'kind: declarative', 'entry: pack.yaml', ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(pack, 'pack.yaml'),
    [
      `name: ${name}`,
      `version: ${version}`,
      'profiles:',
      '  ddd:',
      '    family: backend-like',
      '    forbiddenStereotypes:',
      '      - types: [Portal]',
      '        reason: the domain layer must stay transport-free',
      'languages:',
      '  rust:',
      '    unsupportedFlow: {}',
      '    foreignBuiltins: []',
      '',
    ].join('\n'),
  );
  return pack;
}

/** Build an installable declarative `.wpack` archive (bytes) named `name`. */
function declarativeWpack(name: string, version = '1.0.0'): Uint8Array {
  return buildPack(writeDeclarativeSource(name, version)).archive;
}

/** Build an installable CODE `.wpack` archive (envelope kind: code). */
function codeWpack(name: string, version = '1.0.0'): Uint8Array {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpack-code-'));
  srcRoots.push(dir);
  const pack = path.join(dir, name);
  fs.mkdirSync(pack, { recursive: true });
  fs.writeFileSync(
    path.join(pack, 'wairon-pack.yaml'),
    ['formatVersion: 1', `name: ${name}`, `version: ${version}`, 'kind: code', 'entry: pack.cjs', ''].join('\n'),
  );
  fs.writeFileSync(path.join(pack, 'package.json'), `${JSON.stringify({ name, version }, null, 2)}\n`);
  fs.writeFileSync(path.join(pack, 'pack.cjs'), `module.exports = { name: ${JSON.stringify(name)}, rules: [] };\n`);
  return buildPack(pack).archive;
}

/** A raw ZIP carrying a valid declarative envelope PLUS a zip-slip (`../`) entry. */
function zipSlipWpack(): Uint8Array {
  return zipSync({
    'wairon-pack.yaml': enc(
      ['formatVersion: 1', 'name: slip', 'version: 1.0.0', 'kind: declarative', 'entry: pack.yaml', ''].join('\n'),
    ),
    'pack.yaml': enc('name: slip\nversion: 1.0.0\n'),
    '../evil.txt': enc('pwned'),
  });
}

afterAll(() => {
  for (const dir of srcRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  }
});

describe('hosted pack archive install (sdd_host)', () => {
  let base: string;
  let dataDir: string;
  let packsDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    invalidateSpecCache();
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-packarch-it-'));
    dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    packsDir = path.join(dataDir, 'packs');
    process.env.WAIRON_ADMIN_TOKEN = ADMIN;
    process.env.WAIRON_PACKS_DIR = packsDir;
    process.env.WAIRON_IMAGE_PACKS_DIR = path.join(dataDir, 'image-packs');
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });

  afterEach(() => {
    invalidateSpecCache();
    process.env = { ...savedEnv };
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  describe('server-global scope', () => {
    it('installs a declarative .wpack into <name>/ on the instance tier, lists it, and returns the probe', () => {
      const desc = packs.installGlobalPackArchive(cfg, ADMIN, declarativeWpack('acme-doctrine'));
      expect(desc.name).toBe('acme-doctrine');
      expect(desc.scope).toBe('global');
      expect(desc.tier).toBe('instance');
      expect(desc.profiles).toBe(1);
      expect(desc.languages).toBe(1);
      expect(desc.error).toBeUndefined();

      // Extracted as a DIRECTORY pack under the mutable instance tier (data volume).
      expect(fs.existsSync(path.join(packsDir, 'acme-doctrine', 'pack.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(packsDir, 'acme-doctrine', 'wairon-pack.yaml'))).toBe(true);

      expect(packs.listGlobalPacks(cfg, ADMIN).map((p) => p.name)).toContain('acme-doctrine');
    });

    it('names the pack directory from the envelope, or the explicit override', () => {
      // Override: the on-disk directory + ref follow the override, the descriptor
      // name still reflects the pack's declared identity.
      const desc = packs.installGlobalPackArchive(cfg, ADMIN, declarativeWpack('acme-doctrine'), 'custom');
      expect(desc.ref).toBe('custom');
      expect(desc.name).toBe('acme-doctrine');
      expect(fs.existsSync(path.join(packsDir, 'custom', 'pack.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(packsDir, 'acme-doctrine'))).toBe(false);
    });

    it('rejects a code pack BEFORE any bytes touch disk', () => {
      expect(() => packs.installGlobalPackArchive(cfg, ADMIN, codeWpack('evil-code'))).toThrow(/code pack/i);
      expect(fs.existsSync(path.join(packsDir, 'evil-code'))).toBe(false);
    });

    it('rejects an unsafe (zip-slip) archive and leaves nothing behind', () => {
      expect(() => packs.installGlobalPackArchive(cfg, ADMIN, zipSlipWpack())).toThrow();
      expect(fs.existsSync(path.join(packsDir, 'slip'))).toBe(false);
      // The traversal target was never written outside the packs dir either.
      expect(fs.existsSync(path.join(dataDir, 'evil.txt'))).toBe(false);
    });

    it('rejects a bad credential (401) and an authenticated non-admin (403) before any effect', () => {
      expect(() => packs.installGlobalPackArchive(cfg, 'wrong', declarativeWpack('acme-doctrine'))).toThrow(
        UnauthenticatedError,
      );
      const plain = mintUserToken(dataDir, { id: 'k-plain', userId: 'u-plain' });
      expect(() => packs.installGlobalPackArchive(cfg, plain, declarativeWpack('acme-doctrine'))).toThrow(AdminAuthError);
      expect(fs.existsSync(path.join(packsDir, 'acme-doctrine'))).toBe(false);
    });
  });

  describe('project scope', () => {
    it('extracts into .wai/packs/<name>/, registers the directory ref, and lists it', () => {
      createPlacedProject(cfg, ADMIN, 'demo');

      const desc = packs.installProjectPackArchive(cfg, ADMIN, 'demo', declarativeWpack('acme-doctrine'));
      expect(desc.scope).toBe('project');
      expect(desc.profiles).toBe(1);

      const root = path.join(dataDir, 'projects', 'demo');
      expect(fs.existsSync(path.join(root, '.wai', 'packs', 'acme-doctrine', 'pack.yaml'))).toBe(true);
      const registered = runWithProjectRoot(root, () => loadProjectConfig()).extensions?.packs ?? [];
      expect(registered).toContain('.wai/packs/acme-doctrine');

      expect(packs.listProjectPacks(cfg, ADMIN, 'demo').map((p) => p.name)).toContain('acme-doctrine');
    });

    it('rejects a code pack for a bound project', () => {
      createPlacedProject(cfg, ADMIN, 'demo');
      expect(() => packs.installProjectPackArchive(cfg, ADMIN, 'demo', codeWpack('evil-code'))).toThrow(/code pack/i);
      const root = path.join(dataDir, 'projects', 'demo');
      expect(fs.existsSync(path.join(root, '.wai', 'packs', 'evil-code'))).toBe(false);
    });

    it('rejects the archive install on an unknown project', () => {
      expect(() => packs.installProjectPackArchive(cfg, ADMIN, 'ghost', declarativeWpack('acme-doctrine'))).toThrow(
        /Unknown project/,
      );
    });
  });
});

// ── Web portal upload routes (raw application/zip body → descriptor) ──────────

describe('web portal pack archive upload (sdd_host)', () => {
  const MASTER = 'master-credential-secret-value';
  let base: string;
  let dataDir: string;
  let packsDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let port: number;
  const savedEnv = { ...process.env };

  function enableWebUi(): void {
    fs.writeFileSync(
      path.join(dataDir, 'exposure-policy.json'),
      JSON.stringify({ webUiEnabled: true, requireTls: false }),
    );
  }

  /** A cookie bound to the persisted built-in super-admin (resolver bypass). */
  function adminCookie(): string {
    const instance = ensureInstanceIdentity(dataDir);
    const session = createWebSession(dataDir, {
      id: '',
      subject: { userId: instance.superadminUserId, kind: 'human', issuer: 'local' },
      projects: ['*'],
      createdAt: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    return `wairon_session=${session.id}`;
  }

  function postArchive(opts: {
    path: string;
    archive: Uint8Array;
    headers?: Record<string, string>;
  }): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const buf = Buffer.from(opts.archive);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: opts.path,
          headers: { 'content-type': 'application/zip', 'content-length': buf.length, ...(opts.headers ?? {}) },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on('error', reject);
      req.write(buf);
      req.end();
    });
  }

  beforeEach(async () => {
    invalidateSpecCache();
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-packarch-web-'));
    dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    packsDir = path.join(dataDir, 'packs');
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    process.env.WAIRON_PACKS_DIR = packsDir;
    process.env.WAIRON_IMAGE_PACKS_DIR = path.join(dataDir, 'image-packs');
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    server = http.createServer((req, res) => routeData(cfg, req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    invalidateSpecCache();
    process.env = { ...savedEnv };
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  it('POST /web/admin/packs/upload installs a raw .wpack (name from the envelope) → descriptor', async () => {
    enableWebUi();
    const cookie = adminCookie();

    const res = await postArchive({
      path: '/web/admin/packs/upload',
      archive: declarativeWpack('acme-doctrine'),
      headers: { cookie, 'x-wairon-web': '1' },
    });
    expect(res.status).toBe(200);
    const desc = JSON.parse(res.body);
    expect(desc.name).toBe('acme-doctrine');
    expect(desc.tier).toBe('instance');
    expect(fs.existsSync(path.join(packsDir, 'acme-doctrine', 'pack.yaml'))).toBe(true);
  });

  it('honors the X-Wairon-Pack-Name override header for the on-disk directory', async () => {
    enableWebUi();
    const cookie = adminCookie();

    const res = await postArchive({
      path: '/web/admin/packs/upload',
      archive: declarativeWpack('acme-doctrine'),
      headers: { cookie, 'x-wairon-web': '1', 'x-wairon-pack-name': 'renamed' },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).ref).toBe('renamed');
    expect(fs.existsSync(path.join(packsDir, 'renamed', 'pack.yaml'))).toBe(true);
  });

  it('POST /web/projects/packs/upload?projectId= installs into the bound project → descriptor', async () => {
    enableWebUi();
    createPlacedProject(cfg, MASTER, 'demo');
    const cookie = adminCookie();

    const res = await postArchive({
      path: '/web/projects/packs/upload?projectId=demo',
      archive: declarativeWpack('acme-doctrine'),
      headers: { cookie, 'x-wairon-web': '1' },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).scope).toBe('project');
    const root = path.join(dataDir, 'projects', 'demo');
    expect(fs.existsSync(path.join(root, '.wai', 'packs', 'acme-doctrine', 'pack.yaml'))).toBe(true);
  });

  it('a cookie-authenticated upload without the CSRF header is 403', async () => {
    enableWebUi();
    const cookie = adminCookie();
    const res = await postArchive({
      path: '/web/admin/packs/upload',
      archive: declarativeWpack('acme-doctrine'),
      headers: { cookie },
    });
    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(packsDir, 'acme-doctrine'))).toBe(false);
  });

  it('rejects a code pack over the upload route (declarative-only surface) → 400', async () => {
    enableWebUi();
    const cookie = adminCookie();
    const res = await postArchive({
      path: '/web/admin/packs/upload',
      archive: codeWpack('evil-code'),
      headers: { cookie, 'x-wairon-web': '1' },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatch(/code pack/i);
    expect(fs.existsSync(path.join(packsDir, 'evil-code'))).toBe(false);
  });
});
