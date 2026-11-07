import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { buildPack as sdkBuildPack, extractPack, packContentDigest } from '@wairon/sdk';
import { installPack, publishPack, syncPacks } from '../../src/commands/packs.js';
import { listInstalledPacks, computePackDigest } from '../../src/core/packstore.js';
import { assertionFullCode } from '../../src/core/extensions.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { logger } from '../../src/utils/logger.js';
import { WAIRON_MAJOR } from '../../src/config/defaults.js';

// ---------------------------------------------------------------------------
// The pack registry client: `wairon pack install <name>` resolves against the
// registry, gates unverified code behind explicit consent, checks the content
// against the registry's integrity and records the registry's source;
// `wairon pack publish` uploads; `wairon pack sync` applies the trust rule.
// A local HTTP server plays the registry.
// ---------------------------------------------------------------------------

interface Routes {
  resolve?: (url: URL) => { status: number; body: unknown };
  archive?: Uint8Array;
  put?: (req: http.IncomingMessage, body: Buffer) => { status: number; body: unknown };
}

let server: http.Server;
let base = '';
let routes: Routes = {};
const seen: { method: string; url: string; auth?: string }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      seen.push({ method: req.method ?? '', url: url.pathname + url.search, auth: req.headers.authorization });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && url.pathname.endsWith('/resolve') && routes.resolve) {
        const r = routes.resolve(url);
        return send(r.status, r.body);
      }
      if (req.method === 'GET' && url.pathname.endsWith('/archive') && routes.archive) {
        res.writeHead(200, { 'content-type': 'application/zip' });
        return res.end(Buffer.from(routes.archive));
      }
      if (req.method === 'PUT' && routes.put) {
        const r = routes.put(req, Buffer.concat(chunks));
        return send(r.status, r.body);
      }
      send(404, { error: { code: 'NOT_FOUND', message: 'no route' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/registry`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let work: string;
const saved = { packs: process.env.WAIRON_PACKS_DIR, registry: process.env.WAIRON_REGISTRY, token: process.env.WAIRON_REGISTRY_TOKEN };
let errors: string[];
let infos: string[];

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-registry-test-'));
  fs.mkdirSync(path.join(work, 'store'));
  fs.mkdirSync(path.join(work, 'cwd'));
  process.env.WAIRON_PACKS_DIR = path.join(work, 'store');
  process.env.WAIRON_REGISTRY = base;
  delete process.env.WAIRON_REGISTRY_TOKEN;
  vi.spyOn(process, 'cwd').mockReturnValue(path.join(work, 'cwd'));
  errors = [];
  infos = [];
  vi.spyOn(logger, 'error').mockImplementation((m: string) => { errors.push(m); });
  vi.spyOn(logger, 'warn').mockImplementation((m: string) => { infos.push(m); });
  vi.spyOn(logger, 'info').mockImplementation((m: string) => { infos.push(m); });
  vi.spyOn(logger, 'success').mockImplementation((m: string) => { infos.push(m); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  routes = {};
  seen.length = 0;
  process.exitCode = 0;
  invalidateSpecCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of [['WAIRON_PACKS_DIR', saved.packs], ['WAIRON_REGISTRY', saved.registry], ['WAIRON_REGISTRY_TOKEN', saved.token]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.exitCode = 0;
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* win file locks */ }
});

/** The .wpack envelope of a declarative pack. */
function envelope(name: string, version: string): string {
  return `formatVersion: 1\nname: "${name}"\nversion: ${version}\nkind: declarative\nentry: pack.yaml\n`;
}

/** A built .wpack of a small declarative pack, and its content integrity. */
function archiveOf(name: string, version: string): { archive: Uint8Array; integrity: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-registry-pack-'));
  fs.writeFileSync(path.join(dir, 'pack.yaml'), `name: "${name}"\nversion: ${version}\ndescription: A test pack.\nguarantees: [demo-guarantee]\n`);
  fs.writeFileSync(path.join(dir, 'wairon-pack.yaml'), envelope(name, version));
  const { archive } = sdkBuildPack(dir);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-registry-extract-'));
  extractPack(archive, path.join(out, 'pack'));
  const integrity = computePackDigest(path.join(out, 'pack'));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
  return { archive, integrity };
}

function resolution(name: string, version: string, integrity: string, over: Record<string, unknown> = {}) {
  return {
    name, range: '*', version, integrity, archiveDigest: 'sha256-x', kind: 'declarative',
    yanked: false, archiveUrl: `${base}/v1/packs/${name}/${version}/archive`,
    source: `${base}/v1/packs/${name}/{version}/archive`, verifiedAtPublish: true,
    publisher: { handle: 'acme', verified: true }, ...over,
  };
}

describe('content integrity', () => {
  it('the SDK digest equals the pack store digest over the same files, and skips the same names', () => {
    const files = [
      { path: 'pack.yaml', contents: new TextEncoder().encode('name: a\n') },
      { path: 'skills/x/SKILL.md', contents: new TextEncoder().encode('# x\n') },
      { path: '.install.yaml', contents: new TextEncoder().encode('origin: y\n') },
      { path: 'node_modules/m/index.js', contents: new TextEncoder().encode('x') },
    ];
    const dir = path.join(work, 'digest');
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
      fs.writeFileSync(path.join(dir, f.path), f.contents);
    }
    expect(packContentDigest(files)).toBe(computePackDigest(dir));
    // Order-independent, and a published test vector the registry checks its use against.
    expect(packContentDigest(files.slice(0, 2))).toBe(packContentDigest([files[1], files[0]]));
    expect(packContentDigest([{ path: 'pack.yaml', contents: new TextEncoder().encode('name: a\n') }]))
      .toBe('sha256-ec449383218274b11d82458ad0b173a4782052c1490bc42e8f8c5a45d0b4cdf8');
  });
});

describe('scoped names', () => {
  it('rule codes keep the scope apart with a double underscore; flat names are unchanged', () => {
    expect(assertionFullCode('@acme/sec-lint', 'NO_EVAL')).toBe('ACME__SEC_LINT_NO_EVAL');
    expect(assertionFullCode('acme-sec-lint', 'NO_EVAL')).toBe('ACME_SEC_LINT_NO_EVAL');
  });
});

describe('wairon pack install <registry name>', () => {
  it('resolves, downloads, checks integrity, nests a scoped name and records the registry source', async () => {
    const { archive, integrity } = archiveOf('@acme/demo', '1.2.0');
    routes.archive = archive;
    routes.resolve = (url) => {
      expect(url.pathname).toBe('/registry/v1/packs/@acme/demo/resolve');
      expect(url.searchParams.get('range')).toBe('^1');
      expect(url.searchParams.get('wairon')).toMatch(new RegExp(`^${WAIRON_MAJOR}\\.`));
      return { status: 200, body: resolution('@acme/demo', '1.2.0', integrity, { range: '^1' }) };
    };
    await installPack('@acme/demo@^1');
    expect(errors).toEqual([]);
    const installed = listInstalledPacks().find((p) => p.name === '@acme/demo');
    expect(installed?.version).toBe('1.2.0');
    expect(installed?.path).toBe(path.join(work, 'store', '@acme', 'demo', '1.2.0'));
    expect(installed?.digest).toBe(integrity);
    expect(fs.readFileSync(path.join(installed!.path, '.install.yaml'), 'utf8')).toContain(`${base}/v1/packs/@acme/demo/{version}/archive`);
  });

  it('refuses and uninstalls content that does not match the registry\'s integrity', async () => {
    const { archive } = archiveOf('@acme/demo', '1.0.0');
    routes.archive = archive;
    routes.resolve = () => ({ status: 200, body: resolution('@acme/demo', '1.0.0', 'sha256-0000') });
    await installPack('@acme/demo');
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('sha256-0000');
    expect(listInstalledPacks().some((p) => p.name === '@acme/demo')).toBe(false);
  });

  it('a code pack from an unverified publisher needs --allow-unverified-code without a terminal; --yes is not consent', async () => {
    const { archive, integrity } = archiveOf('@eve/tool', '0.1.0');
    routes.archive = archive;
    routes.resolve = () => ({ status: 200, body: resolution('@eve/tool', '0.1.0', integrity, { kind: 'code', verifiedAtPublish: false, publisher: { handle: 'eve', verified: false } }) });
    const tty = { in: process.stdin.isTTY, out: process.stdout.isTTY };
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await installPack('@eve/tool', true);
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('--allow-unverified-code');
      expect(seen.some((r) => r.url.endsWith('/archive'))).toBe(false);
      expect(listInstalledPacks()).toEqual([]);

      process.exitCode = 0;
      errors.length = 0;
      await installPack('@eve/tool', false, { allowUnverifiedCode: true });
      expect(errors).toEqual([]);
      expect(listInstalledPacks().map((p) => p.name)).toEqual(['@eve/tool']);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty.in, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: tty.out, configurable: true });
    }
  });

  it('a name that exists on disk stays a path, unless --registry', async () => {
    fs.mkdirSync(path.join(work, 'cwd', 'demo'));
    routes.resolve = () => ({ status: 404, body: { error: { code: 'PACK_NOT_FOUND', message: 'no pack named demo' } } });
    await installPack('demo');
    expect(seen).toEqual([]);
    expect(infos.join('\n')).toContain('--registry');
    process.exitCode = 0;
    errors.length = 0;
    await installPack('demo', false, { registry: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].url.startsWith('/registry/v1/packs/demo/resolve?range=*&wairon=')).toBe(true);
    expect(errors.join('\n')).toContain('PACK_NOT_FOUND');
  });
});

describe('wairon pack publish', () => {
  function packDir(name: string, version: string): string {
    const dir = path.join(work, 'src-pack');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.yaml'), `name: "${name}"\nversion: ${version}\nguarantees: [demo-guarantee]\n`);
    fs.writeFileSync(path.join(dir, 'wairon-pack.yaml'), envelope(name, version));
    return dir;
  }

  it('refuses without a token, naming WAIRON_REGISTRY_TOKEN', async () => {
    await publishPack(packDir('@acme/demo', '1.0.0'));
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('WAIRON_REGISTRY_TOKEN');
    expect(seen).toEqual([]);
  });

  it('builds a directory and PUTs it with the token; reports published', async () => {
    process.env.WAIRON_REGISTRY_TOKEN = 'wrt_test';
    routes.put = (req) => {
      expect(req.url).toBe('/registry/v1/packs/@acme/demo/1.0.0');
      expect(req.headers['content-type']).toBe('application/zip');
      return { status: 201, body: { name: '@acme/demo', version: '1.0.0', integrity: 'sha256-abc', url: 'https://example/p' } };
    };
    await publishPack(packDir('@acme/demo', '1.0.0'));
    expect(errors).toEqual([]);
    expect(seen[0].auth).toBe('Bearer wrt_test');
    expect(infos.join('\n')).toContain('Published @acme/demo@1.0.0');
  });

  it('an existing version with the same content is not an error; a refusal lists the findings', async () => {
    process.env.WAIRON_REGISTRY_TOKEN = 'wrt_test';
    // The same .wpack sent again (a rebuilt archive carries a new build time in
    // its envelope, which is part of the content, so it differs).
    const dir = packDir('@acme/demo', '1.0.0');
    const file = path.join(work, 'demo-1.0.0.wpack');
    const archive = sdkBuildPack(dir).archive;
    fs.writeFileSync(file, archive);
    const out = path.join(work, 'x');
    extractPack(archive, out);
    const same = computePackDigest(out);
    routes.put = () => ({ status: 409, body: { error: { code: 'VERSION_EXISTS', message: 'exists', details: { integrity: same } } } });
    await publishPack(file);
    expect(process.exitCode).toBe(0);
    expect(errors.join('\n')).toContain('same content');

    errors.length = 0;
    routes.put = () => ({ status: 422, body: { error: { code: 'INVALID_PACK', message: 'invalid', details: { findings: [{ message: 'version is not SemVer' }] } } } });
    await publishPack(dir);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('INVALID_PACK');
    expect(errors.join('\n')).toContain('version is not SemVer');
  });
});

describe('wairon pack sync from the registry', () => {
  function project(selection: Record<string, unknown>): void {
    const wai = path.join(work, 'cwd', '.wai');
    fs.mkdirSync(path.join(wai, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(wai, 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', waironMajor: WAIRON_MAJOR, name: 'p', projectType: 'backend',
      targets: [], rules: {}, extensions: { useGlobalPacks: false, packs: [selection] },
      createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z',
    }));
  }

  it('without an integrity pin, unverified code needs consent; with a pin it syncs', async () => {
    const { archive, integrity } = archiveOf('@eve/tool', '0.1.0');
    routes.archive = archive;
    routes.resolve = () => ({ status: 200, body: resolution('@eve/tool', '0.1.0', integrity, { kind: 'code', verifiedAtPublish: false, publisher: { handle: 'eve', verified: false } }) });
    const tty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      project({ name: '@eve/tool', version: '0.1.0', source: `${base}/v1/packs/@eve/tool/{version}/archive` });
      await syncPacks();
      expect(process.exitCode).toBe(1);
      expect(listInstalledPacks()).toEqual([]);

      process.exitCode = 0;
      errors.length = 0;
      project({ name: '@eve/tool', version: '0.1.0', integrity, source: `${base}/v1/packs/@eve/tool/{version}/archive` });
      await syncPacks();
      expect(errors).toEqual([]);
      expect(listInstalledPacks().map((p) => p.name)).toEqual(['@eve/tool']);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
    }
  });
});
