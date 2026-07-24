import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { runSurface } from '../../src/commands/surface.js';
import { createChainedSubsystem } from '../../src/core/provision.js';
import type { ComponentSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// `wairon surface export` (cli_surfaces_client_adapter) — the multi-portal
// deltas. An OpenAPI document IS one API, so a project with several public
// portals renders several documents: --portal picks one, --out writes one file
// per portal (every path reported), and with neither the command names the
// portals instead of silently printing something else.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

const subsystem = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'multi-portal-system',
  publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now, ...over,
});
const component = (id: string, sub: string, over: Partial<ComponentSpec> = {}): ComponentSpec => ({
  id, name: id, description: 'd', subsystem: sub, componentType: 'Orchestrator',
  owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);
const iface = (id: string, comp: string, methods: InterfaceSpec['methods']): InterfaceSpec => ({
  id, name: id, description: 'd', component: comp, methods, status: 'complete', createdAt: now, updatedAt: now,
});

/** Two public HTTP portals — the shape the single-document export cannot serve. */
function buildTwoPortalProject(rootDir: string): void {
  fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'multi-portal-system',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    createdAt: now,
    updatedAt: now,
  }));
  setProjectRoot(rootDir);

  saveSystemSpec({
    schemaVersion: '1.0.0',
    name: 'multi-portal-system',
    vision: 'two published APIs',
    boundaries: [],
    globalRequirements: [],
    publicInterfaces: [
      { id: 'gateway', name: 'Gateway API', subsystem: 'core-sub', component: 'gateway-portal', type: 'REST', details: 'public api', audience: 'external' },
      { id: 'admin', name: 'Admin API', subsystem: 'core-sub', component: 'admin-portal', type: 'REST', details: 'operator api', audience: 'external' },
    ],
    createdAt: now,
    updatedAt: now,
  });
  saveSubsystemSpec(subsystem('core-sub', {
    publicInterfaces: [
      { type: 'REST', details: 'public api', component: 'gateway-portal' },
      { type: 'REST', details: 'operator api', component: 'admin-portal' },
    ],
  }));
  saveComponentSpec(component('gateway-portal', 'core-sub', {
    componentType: 'Portal', portalType: 'HTTP_API', basePath: '/api',
    auth: { scheme: 'bearer', bearerFormat: 'JWT' },
  } as Partial<ComponentSpec>));
  saveComponentSpec(component('admin-portal', 'core-sub', {
    componentType: 'Portal', portalType: 'HTTP_API', basePath: '/admin',
    auth: { scheme: 'apiKey', in: 'header', name: 'X-Admin-Key' },
  } as Partial<ComponentSpec>));
  saveInterfaceSpec(iface('igateway-portal', 'gateway-portal', [
    {
      name: 'fetchRecord', description: 'Fetches a record by id.',
      signature: 'fetchRecord(id: string): json', returns: 'json',
      params: [{ name: 'id', type: 'string' }],
      endpoint: { transport: 'HTTP', method: 'GET', path: '/records/{id}' },
    },
  ]));
  saveInterfaceSpec(iface('iadmin-portal', 'admin-portal', [
    {
      name: 'purgeCache', description: 'Purges the read cache.',
      signature: 'purgeCache(): void', returns: 'void', params: [],
      endpoint: { transport: 'HTTP', method: 'POST', path: '/cache/purge' },
    },
  ]));
  invalidateSpecCache();
  setProjectRoot(rootDir);
}

describe('wairon surface export — multi-portal OpenAPI', () => {
  let rootDir: string;
  let logged: string[];
  let stdout: string[];

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-surf-cmd-'));
    buildTwoPortalProject(rootDir);
    logged = [];
    stdout = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(args.join(' ')); });
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  it('--portal selects exactly that portal\'s document and prints it', async () => {
    await runSurface('export', { format: 'openapi', portal: 'admin-portal' });

    expect(stdout).toHaveLength(1);
    const doc = JSON.parse(stdout[0]);
    expect(doc.info.title).toBe('Admin API');
    expect(Object.keys(doc.paths)).toEqual(['/cache/purge']);
    expect(doc.servers).toEqual([{ url: '/admin' }]);
    // The OTHER portal's API is absent — a selection is a selection.
    expect(stdout[0]).not.toContain('/records/{id}');
  });

  it('--portal with --out writes exactly one file at the given path', async () => {
    const out = path.join(rootDir, 'out', 'surface.json');
    await runSurface('export', { format: 'openapi', portal: 'gateway-portal', out });

    expect(fs.existsSync(out)).toBe(true);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).info.title).toBe('Gateway API');
    // No per-portal suffixing when one portal was selected.
    expect(fs.readdirSync(path.join(rootDir, 'out'))).toEqual(['surface.json']);
    expect(logged.join('\n')).toContain(out);
  });

  it('--out with no --portal writes ONE FILE PER PORTAL and reports every path', async () => {
    const out = path.join(rootDir, 'out', 'surface.json');
    await runSurface('export', { format: 'openapi', out });

    const gatewayFile = path.join(rootDir, 'out', 'surface.gateway-portal.json');
    const adminFile = path.join(rootDir, 'out', 'surface.admin-portal.json');
    expect(fs.existsSync(gatewayFile)).toBe(true);
    expect(fs.existsSync(adminFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(gatewayFile, 'utf8')).info.title).toBe('Gateway API');
    expect(JSON.parse(fs.readFileSync(adminFile, 'utf8')).info.title).toBe('Admin API');

    // EVERY written path is reported — naming only the first would hide an API.
    const output = logged.join('\n');
    expect(output).toContain(gatewayFile);
    expect(output).toContain(adminFile);
  });

  it('no --out and no --portal lists the available portals instead of the interface listing', async () => {
    await runSurface('export', { format: 'openapi' });

    // Nothing was printed to stdout: there is no single document to print.
    expect(stdout).toHaveLength(0);
    const output = logged.join('\n');
    expect(output).toContain('--portal');
    expect(output).toContain('gateway-portal');
    expect(output).toContain('Gateway API');
    expect(output).toContain('admin-portal');
    expect(output).toContain('Admin API');
  });

  it('an unknown --portal is refused, naming the portals that do exist', async () => {
    await expect(runSurface('export', { format: 'openapi', portal: 'no-such-portal' }))
      .rejects.toThrow(/no-such-portal/);
    await expect(runSurface('export', { format: 'openapi', portal: 'no-such-portal' }))
      .rejects.toThrow(/gateway-portal.*admin-portal/s);
  });

  it('refuses --portal on a non-openapi export instead of silently ignoring it', async () => {
    await expect(runSurface('export', { format: 'native', portal: 'gateway-portal' }))
      .rejects.toThrow(/--portal.*openapi/s);
  });

  it('the native format still prints the interface listing', async () => {
    await runSurface('export', {});

    expect(stdout).toHaveLength(0);
    const output = logged.join('\n');
    expect(output).toContain('gateway');
    expect(output).toContain('admin');
    expect(output).toContain('method(s)');
  });
});

// ---------------------------------------------------------------------------
// `wairon surface externals` — the external-surface discovery table: one row
// per vendored snapshot with sourceKind, key, origin, freshness, and the
// interface ids it exposes.
// ---------------------------------------------------------------------------

describe('wairon surface externals — external-surface discovery', () => {
  let rootDir: string;
  let childDir: string;
  let logged: string[];

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-surf-ext-'));
    buildTwoPortalProject(rootDir);
    createChainedSubsystem(subsystem('kid', { projectPath: 'packages/kid', status: 'draft' }), 'kid');
    invalidateSpecCache();
    setProjectRoot(rootDir);
    await runSurface('generate-children', {});
    childDir = path.join(rootDir, 'packages', 'kid');
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(args.join(' ')); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  it('prints one row per entry: sourceKind, key, origin, freshness, interface ids', async () => {
    setProjectRoot(childDir);
    await runSurface('externals', {});

    const output = logged.join('\n');
    // The family surface delivered by the chaining parent...
    expect(output).toMatch(/parent\s+.*multi-portal-system/);
    // ...and the core-sub sibling surface, both generated and fresh.
    expect(output).toMatch(/sibling\s+.*multi-portal-system::core-sub/);
    expect(output).toContain('[generated]');
    expect(output).toContain('fresh');
    expect(output).not.toContain('stale');
    // The discovery summary names the exposed interface ids.
    expect(output).toContain('gateway');
    expect(output).toContain('admin');
  });

  it('says so when no external surfaces are stored', async () => {
    // The PARENT holds no vendored snapshots — generation writes into children.
    setProjectRoot(rootDir);
    await runSurface('externals', {});
    expect(logged.join('\n')).toContain('No external surfaces available');
  });

  it('an unknown action names externals among the supported ones', async () => {
    setProjectRoot(childDir);
    await expect(runSurface('bogus', {})).rejects.toThrow(/externals/);
  });
});
