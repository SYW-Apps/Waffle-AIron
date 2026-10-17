import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { execFileSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DIST_CLI, callTool } from './helpers';
import { createTrialSandbox, readFile, transcript, type TrialSandbox } from './trials-helpers';
import type { FixtureTree } from '../rules-matrix/harness';

// ---------------------------------------------------------------------------
// Round-9 user trials (dev.113) — the authoring tools and family migrations,
// replayed against the BUILT server and CLI.
//
//  - tinkerer: two sessions writing one spec at the same moment lost one
//    write while both answered "Updated"; a path-shaped subsystem wrote into
//    another project's tree.
//  - platform: sdd_move_spec of a type left the dot-form references dangling;
//    sdd_initialize_system from an empty subfolder re-authored the parent's L0.
//  - solo-app: a connected cluster could not be moved at all; sdd_get_spec
//    did not read `alias::name`, nor an external from its pin.
//  - lib-and-app: `member rename-alias` refused its own plan on a trait
//    implementer (implements + signatureFrom naming one text).
// ---------------------------------------------------------------------------

let sb: TrialSandbox;
beforeAll(() => { sb = createTrialSandbox('r9authoring'); });
afterAll(async () => { await sb?.cleanup(); });

/** A materialized project with an id and extra configuration. */
function project(name: string, tree: FixtureTree, id?: string, extra: Record<string, unknown> = {}): string {
  const dir = sb.materialize(name, tree);
  const file = path.join(dir, '.wai', 'project.yaml');
  const config = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(file, yaml.dump({ ...config, ...(id ? { id, name: id } : {}), ...extra }));
  return dir;
}

const open: Client[] = [];
afterAll(async () => { for (const c of open) { try { await c.close(); } catch { /* gone */ } } });

/** A built stdio server: pinned to `dir`, or — with `cwd` alone — bound by the binding rule from that folder. */
async function serve(opts: { dir?: string; cwd?: string }): Promise<Client> {
  const env: Record<string, string> = Object.fromEntries(Object.entries(sb.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
  if (opts.dir) env.WAIRON_PROJECT_DIR = opts.dir;
  const client = new Client({ name: 'wairon-e2e-r9-authoring', version: '0.0.1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [DIST_CLI, 'mcp', 'serve'], cwd: opts.cwd ?? opts.dir!, env, stderr: 'ignore' }));
  open.push(client);
  return client;
}

describe('journey: two sessions write one spec at the same moment (tinkerer-r9 MAJOR 4, EDGE)', () => {
  it('both writes land, every time', async () => {
    const dir = project('race', {
      subsystems: [{ id: 'analytics', status: 'complete' }],
      components: [{ id: 'stats_store', subsystem: 'analytics', componentType: 'Store', durability: 'ram-projection', status: 'complete' }],
    });
    const [a, b] = await Promise.all([serve({ dir }), serve({ dir })]);
    for (let round = 0; round < 4; round++) {
      const [ra, rb] = await Promise.all([
        callTool(a, 'sdd_update_spec', { kind: 'component', id: 'stats_store', delta: { description: `WRITTEN BY SESSION A, round ${round}` } }),
        callTool(b, 'sdd_update_spec', { kind: 'component', id: 'stats_store', delta: { name: `Written by session B, round ${round}` } }),
      ]);
      expect(ra.ok, ra.text).toBe(true);
      expect(rb.ok, rb.text).toBe(true);
      const stored = yaml.load(readFile(dir, '.wai/specs/components/stats_store.yaml')) as Record<string, unknown>;
      expect(stored.description, `round ${round}`).toBe(`WRITTEN BY SESSION A, round ${round}`);
      expect(stored.name, `round ${round}`).toBe(`Written by session B, round ${round}`);
    }
    expect(fs.existsSync(path.join(dir, '.wai', '.spec-write.lock'))).toBe(false);
  }, 240_000);
});

describe('journey: moving specs between subsystems (platform-r9 top-1, solo-app-r9 cluster)', () => {
  it('a type move follows the dot form and the :: form inside generics and returns; validate stays clean of dangling types', async () => {
    const dir = project('typemove', {
      subsystems: [{ id: 'api', status: 'complete' }, { id: 'orders', status: 'complete' }],
      components: [{ id: 'order_flow', subsystem: 'orders', componentType: 'Orchestrator', status: 'complete' }],
      interfaces: [{ id: 'iorder_flow', component: 'order_flow', methods: [{ name: 'status', description: 'A status.', params: [{ name: 'history', type: 'list<api.rate_limit_status>' }], returns: 'api::rate_limit_status?' }] }],
      types: [
        { id: 'rate_limit_status', kind: 'value-object', subsystem: 'api', fields: [{ name: 'left', type: 'int' }] },
        { id: 'order', kind: 'value-object', subsystem: 'orders', fields: [{ name: 'status', type: 'api.rate_limit_status' }] },
      ],
    });
    const client = await serve({ dir });
    const dry = await callTool(client, 'sdd_move_spec', { kind: 'type', id: 'rate_limit_status', subsystem: 'orders', dryRun: true });
    expect(dry.ok, dry.text).toBe(true);
    expect(dry.text).toMatch(/"order"/);
    expect(dry.text).toMatch(/"iorder_flow"/);
    const moved = await callTool(client, 'sdd_move_spec', { kind: 'type', id: 'rate_limit_status', subsystem: 'orders' });
    expect(moved.ok, moved.text).toBe(true);
    const v = await sb.run(['validate'], dir);
    expect(v.all, transcript(v)).not.toMatch(/UNDEFINED_TYPE_REFERENCE/);
    expect(readFile(dir, '.wai/specs/types/order.yaml')).toContain('orders.rate_limit_status');
  });

  it('a connected cluster moves in one call with `together`, after a single move names the collaborators', async () => {
    const dir = project('cluster', {
      subsystems: [{ id: 'app', status: 'complete' }, { id: 'accounts', status: 'complete' }],
      components: [
        { id: 'account_portal', subsystem: 'app', componentType: 'Portal', transport: 'HTTP', dependsOn: ['account_orchestrator'], invokedBy: { kind: 'entry', caller: 'Browsers.' }, status: 'complete' },
        { id: 'account_orchestrator', subsystem: 'app', componentType: 'Orchestrator', dependsOn: ['user_store'], status: 'complete' },
        { id: 'user_store', subsystem: 'app', componentType: 'Store', durability: 'ram-projection', status: 'complete' },
      ],
    });
    const client = await serve({ dir });
    const single = await callTool(client, 'sdd_move_spec', { kind: 'component', id: 'account_orchestrator', subsystem: 'accounts' });
    expect(single.ok).toBe(false);
    expect(single.text).toMatch(/together: \["account_portal", "user_store"\]/);
    const all = await callTool(client, 'sdd_move_spec', { kind: 'component', id: 'account_orchestrator', subsystem: 'accounts', together: ['account_portal', 'user_store'] });
    expect(all.ok, all.text).toBe(true);
    for (const id of ['account_orchestrator', 'account_portal', 'user_store']) {
      expect((yaml.load(readFile(dir, `.wai/specs/components/${id}.yaml`)) as { subsystem: string }).subsystem).toBe('accounts');
    }
  });
});

describe('journey: a path-shaped subsystem stays inside the tree (tinkerer-r9 MAJOR 3, EDGE)', () => {
  it('sdd_add_component under a climbing subsystem path is refused and the sibling project is untouched', async () => {
    const own = sb.project('authlab');
    const sibling = sb.project('dashboard');
    for (const dir of [own, sibling]) {
      const init = await sb.run(['init', '-y'], dir);
      expect(init.code, transcript(init)).toBe(0);
    }
    const sib = await serve({ dir: sibling });
    expect((await callTool(sib, 'sdd_add_subsystem', { id: 'dashboard', name: 'Dashboard', description: 'The dashboard.' })).ok).toBe(true);
    const before = fs.readdirSync(path.join(sibling, '.wai', 'specs'), { recursive: true }).map(String).sort();
    const client = await serve({ dir: own });
    expect((await callTool(client, 'sdd_add_subsystem', { id: 'links', name: 'Links', description: 'Links.' })).ok).toBe(true);
    for (const subsystem of ['../../dashboard/.wai/specs/dashboard', '../../../dashboard/.wai/specs/dashboard', 'links/../links', 'Links']) {
      const r = await callTool(client, 'sdd_add_component', { id: 'boundary_probe', name: 'Probe', description: 'probe', subsystem, componentType: 'Orchestrator' });
      expect(r.ok, `${subsystem}: ${r.text}`).toBe(false);
    }
    expect(fs.readdirSync(path.join(sibling, '.wai', 'specs'), { recursive: true }).map(String).sort()).toEqual(before);
  }, 180_000);
});

describe('journey: sdd_initialize_system from an empty subfolder (platform-r9 top-3)', () => {
  it('is refused with the root and the member add step; the parent\'s L0 is untouched', async () => {
    const root = sb.project('shop');
    const init = await sb.run(['init', '-y'], root);
    expect(init.code, transcript(init)).toBe(0);
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    const sub = path.join(root, 'services', 'recommendations');
    fs.mkdirSync(sub, { recursive: true });
    const before = readFile(root, '.wai/specs/.index.yaml');
    const client = await serve({ cwd: sub });
    const r = await callTool(client, 'sdd_initialize_system', { name: 'recommendations', vision: 'Recommendations.', targetLanguage: 'python' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/wairon member add recommendations services\/recommendations --project/);
    expect(readFile(root, '.wai/specs/.index.yaml')).toBe(before);
  }, 180_000);
});

/** geo-sdk (a sibling library exporting a trait) and route-planner implementing it under the alias `geo`. */
function traitFamily(): string {
  const geo = project('geo-sdk', {
    system: {
      name: 'geo-sdk', vision: 'A geo library.', targetLanguage: 'Rust',
      publicInterfaces: [{ from: 'geocoding', component: 'provider_port', as: 'geocoding-provider', role: 'implement', audience: 'external' }, { from: 'geocoding', typeDef: 'coordinate', audience: 'external' }],
    },
    subsystems: [{ id: 'geocoding', status: 'complete', publicInterfaces: [{ component: 'provider_port', details: 'The provider.', role: 'implement' }, { typeDef: 'coordinate', details: 'A coordinate.' }] }],
    components: [{ id: 'provider_port', subsystem: 'geocoding', componentType: 'Adapter', status: 'complete' }],
    interfaces: [{ id: 'iprovider_port', component: 'provider_port', methods: [
      { name: 'forward', description: 'Address to coordinate.', params: [{ name: 'query', type: 'string' }], returns: 'coordinate' },
      { name: 'reverse', description: 'Coordinate to address.', params: [{ name: 'at', type: 'coordinate' }], returns: 'string' },
    ] }],
    types: [{ id: 'coordinate', kind: 'value-object', subsystem: 'geocoding', fields: [{ name: 'lat', type: 'float' }] }],
  }, 'geo-sdk');
  void geo;
  return project('route-planner', {
    system: { name: 'route-planner', vision: 'Routes.', targetLanguage: 'Rust' },
    subsystems: [{ id: 'routing', status: 'complete' }],
    components: [{ id: 'nominatim_provider', subsystem: 'routing', componentType: 'Adapter', status: 'complete' }],
    interfaces: [{ id: 'inominatim_provider', component: 'nominatim_provider', implements: 'geo::geocoding-provider', methods: [
      { name: 'forward', description: 'Search.', signatureFrom: 'geo::geocoding-provider.forward' },
      { name: 'reverse', description: 'Reverse.', signatureFrom: 'geo::geocoding-provider.reverse' },
    ] }],
  }, 'route-planner', { members: { geo: '../geo-sdk' } });
}

describe('journey: member rename-alias on a trait implementer (lib-and-app-r9 R9-11)', () => {
  it('the report plans it and -y applies it on an unchanged tree', async () => {
    const app = traitFamily();
    const report = await sb.run(['member', 'rename-alias', 'geo', 'sdk', '--report'], app);
    expect(report.code, transcript(report)).toBe(0);
    expect(report.all).not.toMatch(/not at its position any more/);
    const applied = await sb.run(['member', 'rename-alias', 'geo', 'sdk', '-y'], app);
    expect(applied.code, transcript(applied)).toBe(0);
    const text = readFile(app, '.wai/specs/interfaces/inominatim_provider.yaml');
    expect(text).toContain('implements: sdk::geocoding-provider');
    expect(text).toContain('sdk::geocoding-provider.forward');
    expect(text).toContain('sdk::geocoding-provider.reverse');
  }, 180_000);
});

describe('journey: sdd_get_spec reads alias::name, an external from its pin (solo-app-r9 MAJOR 3)', () => {
  it('an external\'s type reads from the pinned snapshot, marked read-only', async () => {
    project('fam9-ext', {
      system: { name: 'fam9-ext', vision: 'A producer.', publicInterfaces: [{ from: 'cal', typeDef: 'cadence', audience: 'external' }] },
      subsystems: [{ id: 'cal', status: 'complete', publicInterfaces: [{ typeDef: 'cadence', details: 'A cadence.' }] }],
      types: [{ id: 'cadence', kind: 'value-object', subsystem: 'cal', fields: [{ name: 'every', type: 'int' }] }],
    }, 'fam9-ext');
    const app = project('fam9', { system: { name: 'fam9', vision: 'A consumer.' }, subsystems: [{ id: 'habit', status: 'complete' }] }, 'fam9', { externals: { ext: { project: 'fam9-ext', source: { path: '../fam9-ext' } } } });
    const pin = await sb.run(['externals', 'pin', 'ext'], app);
    expect(pin.code, transcript(pin)).toBe(0);
    const client = await serve({ dir: app });
    const r = await callTool(client, 'sdd_get_spec', { kind: 'type', id: 'ext::cadence' });
    expect(r.ok, r.text).toBe(true);
    expect(r.text).toMatch(/"pinnedSnapshot"/);
    expect(r.text).toMatch(/"readOnly": true/);
    expect(r.text).toMatch(/every/);
  }, 180_000);
});
