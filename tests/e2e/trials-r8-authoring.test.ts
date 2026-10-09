import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DIST_CLI, REPO_ROOT, callTool } from './helpers';
import { createTrialSandbox, countCode, readFile, transcript, writeFile, type TrialSandbox } from './trials-helpers';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness';

// ---------------------------------------------------------------------------
// Round-8 user trials (dev.112) — the authoring tools and family migrations.
//
// lib-and-app R8-26 / R8-24 / R8-6: a library checked out beside its app,
// consumed as the external `geo`. `member attach geo ../geo-sdk` pointed at
// `member adopt geo`, and adopt refused the `../` sibling as not-contained —
// a loop. Attached anyway (after `externals remove`), the sibling member was
// judged as a never-pinned external: EXTERNAL_CHECK_UNAVAILABLE on every use,
// `externals pin geo` pinning it under its alias as its id, and the trait
// implementer red with SIGNATURE_SOURCE_UNRESOLVED and IMPLEMENTS_MISMATCH.
// Each journey replays it against the BUILT server and CLI.
// ---------------------------------------------------------------------------

/** geo-sdk: a Rust library — an InProcess Portal and a geocoding-provider extension point consumers implement. */
function geoSdk(): FixtureTree {
  return {
    system: {
      name: 'geo-sdk', vision: 'A geospatial library other programs link against.', targetLanguage: 'Rust',
      publicInterfaces: [
        { from: 'geocoding', component: 'geocoding_portal', as: 'geocoding', audience: 'external' },
        { from: 'geocoding', component: 'provider_port', as: 'geocoding_provider', role: 'implement', audience: 'external' },
        { from: 'geocoding', typeDef: 'coordinate', audience: 'external' },
      ],
    },
    subsystems: [{
      id: 'geocoding', description: 'Geocoding over a provider the consumer supplies.', status: 'complete',
      publicInterfaces: [
        { component: 'geocoding_portal', details: 'The geocoder.' },
        { component: 'provider_port', details: 'The provider consumers implement.', role: 'implement' },
        { typeDef: 'coordinate', details: 'A coordinate.' },
      ],
    }],
    components: [
      { id: 'geocoding_portal', subsystem: 'geocoding', componentType: 'Portal', transport: 'InProcess', abi: 'c', description: 'The geocoder API.', invokedBy: { kind: 'entry', caller: 'Applications linking the crate.' }, status: 'complete' },
      { id: 'provider_port', subsystem: 'geocoding', componentType: 'Adapter', description: 'The port geocoding goes through.', status: 'complete' },
    ],
    interfaces: [
      { id: 'igeocoding_portal', component: 'geocoding_portal', methods: [{ name: 'locate', description: 'Locate an address.', params: [{ name: 'query', type: 'string' }], returns: 'coordinate', effect: 'none' }] },
      { id: 'iprovider_port', component: 'provider_port', methods: [{ name: 'forward', description: 'Resolve an address to a coordinate.', params: [{ name: 'query', type: 'string' }], returns: 'coordinate' }] },
    ],
    types: [{ id: 'coordinate', kind: 'value-object', subsystem: 'geocoding', description: 'A coordinate.', holds: 'string' }],
  };
}

/** route-planner: implements geo's provider (its signature taken across) and calls its geocoder. */
function routePlanner(): FixtureTree {
  return {
    system: { name: 'route-planner', vision: 'Plans routes over the geo-sdk geocoder.', targetLanguage: 'Rust' },
    subsystems: [{ id: 'routing', description: 'Route planning.', status: 'complete' }],
    components: [
      { id: 'route_planner', subsystem: 'routing', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Plans a route.', dependsOn: ['geo::geocoding'], status: 'complete' },
      { id: 'nominatim_provider', subsystem: 'routing', componentType: 'Adapter', description: 'Our geocoding provider over Nominatim.', status: 'complete' },
    ],
    interfaces: [
      { id: 'iroute_planner', component: 'route_planner', methods: [{ name: 'plan', description: 'Plan a route to an address.', params: [{ name: 'to', type: 'string' }], returns: 'geo::coordinate' }] },
      { id: 'inominatim_provider', component: 'nominatim_provider', implements: 'geo::geocoding_provider', methods: [{ name: 'forward', description: 'Nominatim search.', signatureFrom: 'geo::geocoding_provider.forward' }] },
    ],
    implementations: [{
      id: 'route_planner_impl', contract: 'iroute_planner',
      methods: [{ name: 'plan', narrative: [
        { stepNumber: 1, type: 'call', description: 'Locate the destination.', targetComponent: 'geo::geocoding', targetMethod: 'locate' },
        { stepNumber: 2, type: 'return', description: 'Answer it.', outcome: 'the coordinate' },
      ] }],
    }],
  };
}

/** Rewrite a materialized project's configuration with its id and extra fields. */
function configure(dir: string, id: string, extra: Record<string, unknown> = {}): void {
  const file = path.join(dir, '.wai', 'project.yaml');
  const config = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(file, yaml.dump({ ...config, id, name: id, ...extra }));
}

/** An MCP client on the built server, bound to an existing sandbox project. */
async function mcpAt(dir: string): Promise<Client> {
  const client = new Client({ name: 'wairon-e2e-r8-authoring', version: '0.0.1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [DIST_CLI, 'mcp', 'serve'],
    cwd: REPO_ROOT,
    env: { ...getDefaultEnvironment(), WAIRON_PROJECT_DIR: dir },
    stderr: 'ignore',
  }));
  return client;
}

/** The codes R8-26 met on a sibling member. */
const R8_26 = ['EXTERNAL_CHECK_UNAVAILABLE', 'SIGNATURE_SOURCE_UNRESOLVED', 'IMPLEMENTS_MISMATCH', 'EXTERNAL_UNPINNED', 'EXTERNAL_UNDECLARED'];
const r826 = (text: string): string[] => R8_26.filter((code) => countCode(text, code) > 0);

let sb: TrialSandbox;
beforeAll(() => { sb = createTrialSandbox('r8authoring'); });
afterAll(async () => { await sb?.cleanup(); });

describe('journey: a library checked out beside its app becomes a member and back (lib-and-app-r8 R8-26/R8-24, MAJOR)', () => {
  let app: string;
  let client: Client;
  beforeAll(async () => {
    const sdk = sb.materialize('geo-sdk', geoSdk());
    configure(sdk, 'geo-sdk');
    app = sb.materialize('route-planner', routePlanner());
    configure(app, 'route-planner', { externals: { geo: { project: 'geo-sdk', source: { path: '../geo-sdk' } } } });
    const pinned = await sb.run(['externals', 'pin', 'geo'], app);
    expect(pinned.code, transcript(pinned)).toBe(0);
    client = await mcpAt(app);
  }, 180_000);
  afterAll(async () => { try { await client?.close(); } catch { /* gone */ } });

  it('green as an external: the trait implementer resolves against the pin', async () => {
    const r = await sb.run(['validate'], app);
    expect(r826(r.all), transcript(r)).toEqual([]);
  });

  it('member attach from the sibling path is refused while the external exists, exits non-zero, and points at adopt', async () => {
    const before = readFile(app, '.wai/project.yaml');
    const r = await sb.run(['member', 'attach', 'geo', '../geo-sdk', '--report'], app);
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/already-member/);
    expect(r.all).toMatch(/wairon member adopt geo/);
    expect(readFile(app, '.wai/project.yaml')).toBe(before);
  });

  it('member adopt geo takes the `../` sibling: the dry run plans it, the apply makes it a member', async () => {
    const before = readFile(app, '.wai/project.yaml');
    const dry = await callTool(client, 'sdd_adopt_member', { alias: 'geo', dryRun: true });
    expect(dry.ok, dry.text).toBe(true);
    expect(dry.text).not.toMatch(/not-contained/);
    expect(dry.text).toMatch(/members: geo → \.\.\/geo-sdk/);
    expect(readFile(app, '.wai/project.yaml')).toBe(before);
    const applied = await sb.run(['member', 'adopt', 'geo', '--yes'], app);
    expect(applied.code, transcript(applied)).toBe(0);
    const config = yaml.load(readFile(app, '.wai/project.yaml')) as Record<string, any>;
    expect(config.members).toEqual({ geo: '../geo-sdk' });
    expect(config.externals).toBeUndefined();
  });

  it('as a member it is composed live: no unavailable check, the implementer green, and no pin needed or taken', async () => {
    const r = await sb.run(['validate'], app);
    expect(r826(r.all), transcript(r)).toEqual([]);
    const pin = await sb.run(['externals', 'pin', 'geo'], app);
    expect(pin.code, transcript(pin)).not.toBe(0);
    expect(pin.all).toMatch(/"geo" is a member of this project, read live .* never pinned/);
    expect(fs.existsSync(path.join(app, '.wai', 'externals', 'geo.yaml'))).toBe(false);
  });

  it('member detach geo takes it back to a pinned external by path, green again', async () => {
    const r = await sb.run(['member', 'detach', 'geo', '--yes'], app);
    expect(r.code, transcript(r)).toBe(0);
    const config = yaml.load(readFile(app, '.wai/project.yaml')) as Record<string, any>;
    expect(config.members).toBeUndefined();
    expect(config.externals.geo).toMatchObject({ project: 'geo-sdk', source: { path: '../geo-sdk' } });
    const v = await sb.run(['validate'], app);
    expect(r826(v.all), transcript(v)).toEqual([]);
  });
});

describe('journey: a member attached from the sibling path after the external is removed is green with no pin (lib-and-app-r8 R8-26)', () => {
  let app: string;
  beforeAll(async () => {
    const sdk = sb.materialize('geo-sdk-2', geoSdk());
    configure(sdk, 'geo-sdk');
    app = sb.materialize('route-planner-2', routePlanner());
    configure(app, 'route-planner', { externals: { geo: { project: 'geo-sdk', source: { path: '../geo-sdk-2' } } } });
  }, 180_000);

  it('externals remove, then member attach ../geo-sdk-2: the plan announces no unavailable check, and the result has none', async () => {
    const removed = await sb.run(['externals', 'remove', 'geo'], app);
    expect(removed.code, transcript(removed)).toBe(0);
    const report = await sb.run(['member', 'attach', 'geo', '../geo-sdk-2', '--report'], app);
    expect(report.code, transcript(report)).toBe(0);
    expect(r826(report.all), transcript(report)).toEqual([]);
    const applied = await sb.run(['member', 'attach', 'geo', '../geo-sdk-2', '--yes'], app);
    expect(applied.code, transcript(applied)).toBe(0);
    const v = await sb.run(['validate'], app);
    expect(r826(v.all), transcript(v)).toEqual([]);
    writeFile(app, '.wai/notes.txt', 'nothing');
  });
});

// ===========================================================================
// The authoring tools (round 8): the project boundary every write asks, the
// break report of a delete and a method removal, the moves and renames the
// refusals name, the cross-subsystem gate, the dry runs.
// ===========================================================================

/** An MCP client on the built server, bound to an existing sandbox project. */
async function authoringClientAt(dir: string): Promise<Client> {
  const client = new Client({ name: 'wairon-e2e-r8-authoring', version: '0.0.1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [DIST_CLI, 'mcp', 'serve'],
    cwd: REPO_ROOT,
    env: { ...getDefaultEnvironment(), WAIRON_PROJECT_DIR: dir },
    stderr: 'ignore',
  }));
  return client;
}

/** Every file under a project's specs folder, relative and sorted. */
function authoringSpecFiles(dir: string): string[] {
  const root = path.join(dir, '.wai', 'specs');
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}

/**
 * The platform family, cut down: a root "shop" consuming the member project
 * "payments" (id payments_svc), which exports a Portal and a type the root's
 * client Adapter calls.
 */
function paymentsFamily(sbx: TrialSandbox, name: string): { root: string; member: string } {
  const root = sbx.materialize(name, {
    system: { name: 'Shop', vision: 'Sells things and takes payments through its payments service.', targetLanguage: 'typescript' },
    subsystems: [{ id: 'orders', description: 'Order handling.', status: 'complete' }],
    components: [{ id: 'payments_client', subsystem: 'orders', componentType: 'Adapter', dependsOn: ['payments::payment_portal'], status: 'complete' }],
    interfaces: [{ id: 'ipayments_client', component: 'payments_client', methods: [{ name: 'charge', params: [{ name: 'orderId', type: 'string' }], returns: 'void' }] }],
    implementations: [{ id: 'payments_client_http', contract: 'ipayments_client', methods: [{ name: 'charge', narrative: [
      { stepNumber: 1, description: 'Ask the payments service to take the payment', type: 'call', targetComponent: 'payments::payment_portal', targetMethod: 'getPayment' },
    ] }] }],
  });
  const member = path.join(root, 'services', 'payments');
  materializeFixtureProject(member, {
    system: {
      name: 'Payments', vision: 'Takes payments for the shop and answers what was paid.', targetLanguage: 'typescript',
      publicInterfaces: [{ from: 'payments' }],
    },
    subsystems: [{ id: 'payments', description: 'Payments.', status: 'complete', publicInterfaces: [{ component: 'payment_portal', details: 'The payments API' }] }],
    components: [
      { id: 'payment_portal', subsystem: 'payments', componentType: 'Portal', transport: 'InProcess', invokedBy: { kind: 'entry', caller: 'The shop service, in the same process' }, status: 'complete' },
      { id: 'payment_store', subsystem: 'payments', componentType: 'Store', durability: 'ram-projection', status: 'complete' },
    ],
    interfaces: [
      { id: 'ipayment_portal', component: 'payment_portal', methods: [
        { name: 'getPayment', params: [{ name: 'id', type: 'string' }], returns: 'string' },
        { name: 'refund', params: [{ name: 'id', type: 'string' }], returns: 'void' },
      ] },
      { id: 'ipayment_store', component: 'payment_store', methods: [{ name: 'put', params: [{ name: 'id', type: 'string' }], returns: 'void' }] },
    ],
    implementations: [
      { id: 'payment_portal_impl', contract: 'ipayment_portal', methods: [{ name: 'getPayment', narrative: [] }, { name: 'refund', narrative: [] }] },
      { id: 'payment_store_mem', contract: 'ipayment_store', methods: [{ name: 'put', narrative: [] }] },
    ],
    types: [{ id: 'sku_id', kind: 'value-object', fields: [{ name: 'v', type: 'string' }] }],
  });
  writeFile(member, '.wai/project.yaml', `id: payments_svc\n${readFile(member, '.wai/project.yaml')}`);
  writeFile(root, '.wai/project.yaml', `${readFile(root, '.wai/project.yaml')}members:\n  payments: services/payments\n`);
  return { root, member };
}

describe('journey: a root session cannot write a MEMBER project\'s spec (platform-r8 BLOCKER)', () => {
  let root: string;
  let member: string;
  let client: Client;
  beforeAll(async () => {
    ({ root, member } = paymentsFamily(sb, 'boundary-family'));
    client = await authoringClientAt(root);
  }, 120_000);
  afterAll(async () => { try { await client?.close(); } catch { /* gone */ } });

  it('sdd_delete_spec on payments_svc::payment_store is refused — dry run and real, no force needed — naming the member\'s folder; nothing in the member changes', async () => {
    const before = authoringSpecFiles(member);
    for (const dryRun of [true, false]) {
      const r = await callTool(client, 'sdd_delete_spec', { kind: 'component', id: 'payments_svc::payment_store', dryRun });
      expect(r.ok, r.text).toBe(false);
      expect(r.text).toMatch(/chained-spec: "payments_svc::payment_store" lives in another project; delete it from that project's own root.*services\/payments.*sdd_delete_spec component payment_store there/s);
    }
    expect(authoringSpecFiles(member)).toEqual(before);
  });

  it('a member TYPE, by the member key and by the alias, gets the same refusal — never "file may not exist"', async () => {
    for (const id of ['payments_svc::sku_id', 'payments::sku_id']) {
      const r = await callTool(client, 'sdd_delete_spec', { kind: 'type', id, dryRun: true });
      expect(r.ok, r.text).toBe(false);
      expect(r.text).toMatch(/lives in another project/);
      expect(r.text).not.toMatch(/may not exist/);
    }
  });

  it('the same refusal from the create, move and rename tools', async () => {
    const before = authoringSpecFiles(member);
    const calls: [string, Record<string, unknown>][] = [
      ['sdd_define_interface', { id: 'iintruder', name: 'I', description: 'i', component: 'payments_svc::payment_store', methods: [] }],
      ['sdd_rename_spec', { kind: 'implementation', id: 'payments_svc::payment_store_mem', newId: 'mem' }],
      ['sdd_move_spec', { kind: 'component', id: 'payments_svc::payment_store', subsystem: 'orders', dryRun: true }],
      ['sdd_update_spec', { kind: 'component', id: 'payments_svc::payment_store', delta: { description: 'x' } }],
    ];
    for (const [tool, args] of calls) {
      const r = await callTool(client, tool, args);
      expect(r.ok, `${tool}: ${r.text}`).toBe(false);
      expect(r.text, tool).toMatch(/lives in another project/);
    }
    expect(authoringSpecFiles(member)).toEqual(before);
  });
});

describe('journey: a producer-side delete and a published verb\'s removal name the consumers they break (platform-r8, tinkerer-r8)', () => {
  let member: string;
  let client: Client;
  beforeAll(async () => {
    ({ member } = paymentsFamily(sb, 'breaks-family'));
    client = await authoringClientAt(member);
  }, 120_000);
  afterAll(async () => { try { await client?.close(); } catch { /* gone */ } });

  it('deleting the exported Portal (dry run) publishes it and names the root that calls it', async () => {
    const r = await callTool(client, 'sdd_delete_spec', { kind: 'component', id: 'payment_portal', dryRun: true });
    expect(r.ok, r.text).toBe(true);
    const data = (r.raw as { structuredContent?: { published: { publicName: string }[]; breaks?: { project: string; uses?: { members: string[] }[] }[] } }).structuredContent;
    expect(data?.published.map((u) => u.publicName)).toContain('payment_portal');
    expect(data?.breaks?.length, r.text).toBe(1);
    expect(r.text).toMatch(/BREAKS 1 consumer/);
  });

  it('removing the verb another project calls cascades its implementation entry and names the break — a caller in another project is no reference this tree can edit', async () => {
    const r = await callTool(client, 'sdd_update_spec', { kind: 'interface', id: 'ipayment_portal', delta: { methods: [{ name: 'getPayment', action: 'delete' }] }, dryRun: true });
    expect(r.ok, r.text).toBe(true);
    const data = (r.raw as { structuredContent?: { cascaded?: string[]; published?: unknown[]; breaks?: unknown[] } }).structuredContent;
    expect(data?.cascaded).toEqual(['payment_portal_impl.getPayment']);
    expect(data?.published?.length).toBe(1);
    expect(data?.breaks?.length, r.text).toBe(1);
    expect(r.text).toMatch(/Cascaded: would remove the implementation entry "payment_portal_impl\.getPayment"/);
  });

  it('removing an uncalled verb cascades its entry and breaks nobody', async () => {
    const r = await callTool(client, 'sdd_update_spec', { kind: 'interface', id: 'ipayment_portal', delta: { methods: [{ name: 'refund', action: 'delete' }] } });
    expect(r.ok, r.text).toBe(true);
    expect(readFile(member, '.wai/specs/implementations/payment_portal_impl.yaml')).not.toMatch(/name: refund/);
    const data = (r.raw as { structuredContent?: { breaks?: unknown[] } }).structuredContent;
    expect(data?.breaks).toBeUndefined();
  });
});

describe('journey: renames and moves keep every file with its owner (platform-r8, tinkerer-r8 MAJOR)', () => {
  let dir: string;
  let client: Client;
  beforeAll(async () => {
    dir = sb.project('movelab');
    const init = await sb.run(['init', '-y'], dir);
    expect(init.code, transcript(init)).toBe(0);
    client = await authoringClientAt(dir);
    const ok = async (tool: string, args: Record<string, unknown>): Promise<void> => {
      const r = await callTool(client, tool, args);
      expect(r.ok, `${tool}: ${r.text}`).toBe(true);
    };
    await ok('sdd_initialize_system', { name: 'Shortener', vision: 'Shortens links and counts their hits for the dashboards.' });
    await ok('sdd_add_subsystem', { id: 'links', name: 'Links', description: 'Short links.' });
    await ok('sdd_add_subsystem', { id: 'analytics', name: 'Analytics', description: 'Hit counting.' });
    await ok('sdd_add_component', { id: 'links_portal', name: 'Links Portal', description: 'The link API.', subsystem: 'links', componentType: 'Portal', transport: 'HTTP' });
    await ok('sdd_add_component', { id: 'stats_store', name: 'Stats Store', description: 'Holds the hit counts.', subsystem: 'analytics', componentType: 'Store', durability: 'ram-projection' });
    await ok('sdd_define_interface', { id: 'istats_store', name: 'Stats', description: 'Hit counts.', component: 'stats_store', methods: [{ name: 'get', description: 'Reads a count.', params: [{ name: 'code', type: 'string' }], returns: 'int' }] });
    await ok('sdd_write_narrative', { id: 'memory_stats_store', name: 'In memory', description: 'A map.', contract: 'istats_store', methods: [{ name: 'get', narrative: [] }] });
  }, 180_000);
  afterAll(async () => { try { await client?.close(); } catch { /* gone */ } });

  it('a cross-subsystem Portal -> Store edge is refused at the write, dry run included (tinkerer top 1)', async () => {
    for (const dryRun of [true, false]) {
      const r = await callTool(client, 'sdd_update_spec', { kind: 'component', id: 'links_portal', delta: { dependsOn: ['stats_store'] }, dryRun });
      expect(r.ok, r.text).toBe(false);
      expect(r.text).toMatch(/CROSS_SUBSYSTEM_NON_ADAPTER/);
    }
  });

  it('sdd_rename_component takes an implementation whose id is not derived from the component\'s along to the new folder', async () => {
    const r = await callTool(client, 'sdd_rename_component', { id: 'stats_store', newId: 'hit_counter_store' });
    expect(r.ok, r.text).toBe(true);
    const files = authoringSpecFiles(dir);
    expect(files.filter((f) => f.includes('stats_store'))).toEqual([]);
    expect(files).toContain('analytics/hit_counter_store/.implementation.yaml');
  });

  it('sdd_rename_spec renames that implementation on its own (dry run first)', async () => {
    const dry = await callTool(client, 'sdd_rename_spec', { kind: 'implementation', id: 'memory_stats_store', newId: 'hit_counter_store_mem', dryRun: true });
    expect(dry.ok, dry.text).toBe(true);
    expect(readFile(dir, '.wai/specs/analytics/hit_counter_store/.implementation.yaml')).toMatch(/id: memory_stats_store/);
    const r = await callTool(client, 'sdd_rename_spec', { kind: 'implementation', id: 'memory_stats_store', newId: 'hit_counter_store_mem' });
    expect(r.ok, r.text).toBe(true);
    expect(readFile(dir, '.wai/specs/analytics/hit_counter_store/.implementation.yaml')).toMatch(/id: hit_counter_store_mem/);
  });

  it('sdd_move_spec moves the component with its contract and implementation, and a delta that tries it names the tool', async () => {
    const viaDelta = await callTool(client, 'sdd_update_spec', { kind: 'component', id: 'hit_counter_store', delta: { subsystem: 'links' } });
    expect(viaDelta.ok).toBe(false);
    expect(viaDelta.text).toMatch(/sdd_move_spec/);
    const r = await callTool(client, 'sdd_move_spec', { kind: 'component', id: 'hit_counter_store', subsystem: 'links' });
    expect(r.ok, r.text).toBe(true);
    const files = authoringSpecFiles(dir);
    expect(files.filter((f) => f.startsWith('links/hit_counter_store/'))).toEqual([
      'links/hit_counter_store/.implementation.yaml', 'links/hit_counter_store/.index.yaml', 'links/hit_counter_store/.interface.yaml',
    ]);
    expect(files.some((f) => f.startsWith('analytics/hit_counter_store'))).toBe(false);
  });

  it('sdd_add_type and sdd_set_endpoints take a dry run; every description names its arguments', async () => {
    const before = authoringSpecFiles(dir);
    const t = await callTool(client, 'sdd_add_type', { kind: 'value-object', id: 'code', name: 'Code', holds: 'string', dryRun: true });
    expect(t.ok, t.text).toBe(true);
    expect(t.text).toMatch(/^DRY RUN/);
    expect(authoringSpecFiles(dir)).toEqual(before);
    const tools = (await client.listTools()).tools;
    expect(tools.find((x) => x.name === 'sdd_externalize_subsystem')?.description).toMatch(/Arguments: subsystem/);
    expect(tools.find((x) => x.name === 'sdd_rename_component')?.description).toMatch(/Arguments: id, newId, dryRun\?\./);
    expect(tools.find((x) => x.name === 'sdd_set_endpoints')?.inputSchema.properties).toHaveProperty('dryRun');
  });

  it('a delete of an id nothing holds says what it might have meant', async () => {
    const r = await callTool(client, 'sdd_delete_spec', { kind: 'component', id: 'analytics' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/"analytics" is a subsystem — pass kind "subsystem"/);
  });
});
