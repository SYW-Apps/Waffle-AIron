import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { FixtureTree } from '../rules-matrix/harness';
import { createTrialSandbox, countCode, gitInit, readFile, transcript, writeFile, type TrialSandbox } from './trials-helpers';
import { projectYaml } from '../helpers/conformance-r6-trees';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';

// ---------------------------------------------------------------------------
// Round-9 user trials — surfaces, externals and members, replayed against the
// BUILT CLI:
//   1. an endpoint path move was invisible to the consumer (status, validate,
//      the re-pin all silent) — tinkerer top-1.
//   2. the sibling-member model: the producer saw no consumer; a verb removed
//      from a member never reached the consumer's binding; the OpenAPI
//      document could not describe a sibling member's types — lib-and-app top-1.
//   3. `surface diff` missed a gateway's wire change through a local record
//      that embeds a member type — platform.
//   4. an OPTIONAL object body was wrapped under its name; `status: 299` was
//      accepted silently — solo-app, tinkerer.
// ---------------------------------------------------------------------------

let sb: TrialSandbox;
let seq = 0;

beforeAll(() => { sb = createTrialSandbox('r9surf'); });
afterAll(async () => { await sb?.cleanup(); });

/** A project written from a fixture tree into `dir`, its configuration given. */
function writeProject(dir: string, tree: FixtureTree, config: string): string {
  const at = sb.materialize(`tmp${++seq}`, { ...tree, files: { ...(tree.files ?? {}), '.wai/project.yaml': config } });
  fs.cpSync(at, dir, { recursive: true });
  fs.rmSync(at, { recursive: true, force: true });
  return dir;
}

/** A spec file of a kind whose name starts with the id. */
function specFile(dir: string, kind: string, id: string): string {
  const folder = path.join(dir, '.wai', 'specs', kind);
  return `.wai/specs/${kind}/${fs.readdirSync(folder).find((f) => f.startsWith(id))!}`;
}

function git(dir: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd: dir, stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'trial', GIT_AUTHOR_EMAIL: 'trial@example.invalid', GIT_COMMITTER_NAME: 'trial', GIT_COMMITTER_EMAIL: 'trial@example.invalid' },
  });
}

/** An approval record committed with the tree as it stands: what the member's last approval is. */
function commitApproval(dir: string, digest: string): void {
  writeFile(dir, '.wai/lock.json', JSON.stringify({ format: 3, stateId: { algorithm: 'sha256+design-2', digest } }, null, 2));
  git(dir, 'add', '-A');
  git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'approved');
}

/** Linkshort's stats API: an HTTP Portal exported to other projects. */
function statsApi(): FixtureTree {
  return {
    system: { name: 'Linkshort', vision: 'Short links and their statistics.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'stats', component: 'stats_portal', audience: 'instance' }] },
    subsystems: [{ id: 'stats', description: 'Statistics.', publicInterfaces: [{ component: 'stats_portal', details: 'The stats API.' }] }],
    components: [{ id: 'stats_portal', componentType: 'Portal', transport: 'HTTP', description: 'The stats API.', invokedBy: { kind: 'entry', caller: 'The dashboard, over HTTP' } }],
    interfaces: [{ id: 'istats_portal', component: 'stats_portal', methods: [
      { name: 'getStats', description: 'Stats of one code.', params: [{ name: 'shortCode', type: 'string' }], returns: 'int', effect: 'read', endpoint: { transport: 'HTTP', method: 'GET', path: '/stats/{shortCode}' } },
    ] }],
    implementations: [{ id: 'stats_portal_impl', contract: 'istats_portal', methods: [{ name: 'getStats', narrative: [{ stepNumber: 1, description: 'Answer the count', type: 'return', outcome: 'success' }] }] }],
  };
}

/** The dashboard: its client Adapter calls getStats over HTTP. */
function dashboard(): FixtureTree {
  return {
    system: { name: 'Dashboard', vision: 'Shows link statistics.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'board', description: 'The board.' }],
    components: [{ id: 'stats_client', componentType: 'Adapter', description: 'Reads the stats over HTTP.', dependsOn: ['linkshort::stats_portal'], invokedBy: { kind: 'runtime', caller: 'The board refresh timer the composition root registers' } }],
    interfaces: [{ id: 'istats_client', component: 'stats_client', methods: [{ name: 'refresh', description: 'Refresh one code.', params: [{ name: 'code', type: 'string' }], returns: 'int', effect: 'io' }] }],
    implementations: [{ id: 'stats_client_impl', contract: 'istats_client', methods: [{ name: 'refresh', detail: 'intent', intent: 'Reads the stats of one code.', calls: ['linkshort::stats_portal.getStats'] }] }],
  };
}

/** The geo SDK: a Rust library exporting its distance Portal and the coordinate type. */
function geoSdk(): FixtureTree {
  const methods = ['haversine_distance', 'vincenty_distance'].map((name) => ({ name, description: name, params: [{ name: 'from', type: 'coordinate' }, { name: 'to', type: 'coordinate' }], returns: 'float', effect: 'none' }));
  return {
    system: { name: 'geo-sdk', vision: 'Geospatial maths as a library.', targetLanguage: 'Rust', publicInterfaces: [
      { from: 'distance', component: 'distance_portal', as: 'distance', audience: 'external' },
      { from: 'distance', typeDef: 'coordinate', audience: 'external' },
    ] },
    subsystems: [{ id: 'distance', description: 'Distances.', publicInterfaces: [{ component: 'distance_portal', details: 'Distances.' }, { typeDef: 'coordinate' }] }],
    components: [{ id: 'distance_portal', componentType: 'Portal', transport: 'InProcess', description: 'The distance API.', invokedBy: { kind: 'entry', caller: 'Applications linking the crate' } }],
    interfaces: [{ id: 'idistance_portal', component: 'distance_portal', methods }],
    implementations: [{ id: 'distance_portal_impl', contract: 'idistance_portal', methods: methods.map((m) => ({ name: m.name, narrative: [{ stepNumber: 1, description: 'Compute the distance', type: 'return', outcome: 'success' }] })) }],
    types: [{ id: 'coordinate', kind: 'value-object', subsystem: 'distance', name: 'Coordinate', description: 'A point.', fields: [{ name: 'lat', type: 'float' }, { name: 'lon', type: 'float' }] }],
  };
}

/** The route planner: composes ../geo-sdk as a MEMBER, calls geo::distance through a binding, and answers its own HTTP API. */
function routePlanner(): FixtureTree {
  return {
    system: { name: 'route-planner', vision: 'Plans delivery routes.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'routing', description: 'Routing.' }],
    components: [
      { id: 'stop_sequencer', componentType: 'Orchestrator', description: 'Orders stops by distance.', dependsOn: ['geo::distance'], invokedBy: { kind: 'runtime', caller: 'The planning job the composition root schedules' } },
      { id: 'route_portal', componentType: 'Portal', transport: 'HTTP', description: 'The routing API.', invokedBy: { kind: 'entry', caller: 'The dispatch web app, over HTTPS' } },
    ],
    interfaces: [
      { id: 'istop_sequencer', component: 'stop_sequencer', methods: [{ name: 'sequence', description: 'Order the stops.', params: [{ name: 'stops', type: 'list<geo::coordinate>' }], returns: 'list<geo::coordinate>', effect: 'none' }] },
      { id: 'iroute_portal', component: 'route_portal', methods: [{ name: 'nearest', description: 'The nearest depot.', params: [{ name: 'at', type: 'geo::coordinate' }], returns: 'geo::coordinate', effect: 'read', endpoint: { transport: 'HTTP', method: 'POST', path: '/nearest' } }] },
    ],
    implementations: [{
      id: 'stop_sequencer_impl', contract: 'istop_sequencer', sourcePath: 'src/sequencer.ts', bindings: ['src/geo-binding.ts'],
      methods: [{ name: 'sequence', detail: 'intent', intent: 'Orders the stops by distance.', calls: ['geo::distance.haversine_distance'] }],
    }],
    files: {
      'src/sequencer.ts': 'export function sequence(stops: unknown[]): unknown[] { return stops; }\n',
      'src/geo-binding.ts': [
        'export interface Coordinate { lat: number; lon: number }',
        'export function haversine_distance(from: Coordinate, to: Coordinate): number { return 0; }',
        'export function vincenty_distance(from: Coordinate, to: Coordinate): number { return 0; }',
        '',
      ].join('\n'),
    },
  };
}

/** The SDK and the app that composes it as a `../` sibling member, side by side. */
function siblingFamily(name: string): { sdk: string; app: string } {
  const folder = sb.project(name);
  return {
    sdk: writeProject(path.join(folder, 'geo-sdk'), geoSdk(), projectYaml('geo-sdk')),
    app: writeProject(path.join(folder, 'route-planner'), routePlanner(), projectYaml('route-planner', { members: { geo: '../geo-sdk' } })),
  };
}

describe('1. a used verb\'s route moving reaches the consumer (tinkerer top-1)', () => {
  it('status, validate and the re-pin each name the moved route', async () => {
    const folder = sb.project('linkshort-move');
    const producer = writeProject(path.join(folder, 'linkshort'), statsApi(), projectYaml('linkshort'));
    const consumer = writeProject(path.join(folder, 'dashboard'), dashboard(), projectYaml('dashboard', { externals: { linkshort: { project: 'linkshort', source: { path: '../linkshort' } } } }));
    const pin = await sb.run(['externals', 'pin'], consumer);
    expect(pin.code, transcript(pin)).toBe(0);
    const rel = specFile(producer, 'interfaces', 'istats_portal');
    writeFile(producer, rel, readFile(producer, rel).split('path: /stats/{shortCode}').join('path: /v2/stats/{shortCode}'));

    const status = await sb.run(['externals', 'status', '--json'], consumer);
    const [s] = JSON.parse(status.stdout) as { drifted: boolean; uses: { state: string; detail?: string }[] }[];
    // Round 9: "unchanged", drifted: false.
    expect(s.drifted, transcript(status)).toBe(true);
    expect(s.uses[0].detail).toContain('endpoint moved: GET /stats/{shortCode} → GET /v2/stats/{shortCode}');

    const validate = await sb.run(['validate'], consumer);
    expect(validate.all, transcript(validate)).toMatch(/\[EXTERNAL_DRIFTED\][^\n]*the route of "stats_portal\.getStats" \(GET \/stats\/\{shortCode\} → GET \/v2\/stats\/\{shortCode\}\) moved/);

    // Round 9: the re-pin rewrote the path "without a word".
    const repin = await sb.run(['externals', 'pin'], consumer);
    expect(repin.all, transcript(repin)).toContain('moved since the last pin: endpoint of stats_portal.getStats (GET /stats/{shortCode} → GET /v2/stats/{shortCode})');
  });
});

describe('2. the sibling-member model (lib-and-app top-1)', () => {
  it('a: the producer names the parent that composes it as a `../` member as its consumer', async () => {
    const { sdk } = siblingFamily('sibling-consumers');
    const r = await sb.run(['externals', 'consumers'], sdk);
    expect(r.code, transcript(r)).toBe(0);
    // Round 9: "No project of the family in reach, nor in the searched folders, consumes this project."
    expect(r.all).toMatch(/route-planner \(members\.geo\)[^\n]*coordinate, distance/);
    const searched = await sb.run(['externals', 'consumers', '--search', '..'], sdk);
    expect(searched.all.match(/route-planner \(members\.geo\)/g), transcript(searched)).toHaveLength(1);
  });

  it('b: a verb removed from the member since its approval reaches the consumer\'s bare binding export', async () => {
    const { sdk, app } = siblingFamily('sibling-removal');
    git(sdk, 'init', '-q');
    commitApproval(sdk, 'a'.repeat(64));
    for (const kind of ['interfaces', 'implementations']) {
      const rel = specFile(sdk, kind, kind === 'interfaces' ? 'idistance_portal' : 'distance_portal_impl');
      const spec = readYamlFile(path.join(sdk, rel)) as { methods: { name: string }[] };
      writeYamlFile(path.join(sdk, rel), { ...spec, methods: spec.methods.filter((m) => m.name !== 'vincenty_distance') });
    }
    expect(readFile(sdk, specFile(sdk, 'interfaces', 'idistance_portal'))).not.toContain('vincenty_distance');
    const r = await sb.run(['validate'], app);
    // Round 9: no finding through two runs — a member has no pin to say "an earlier pin held it".
    expect(r.all, transcript(r)).toMatch(/\[BINDING_DRIFT\][^\n]*"vincenty_distance" was removed from geo::distance \(the member's approved design held it\)/);
  });

  it('c: the OpenAPI document describes a sibling member\'s types', async () => {
    const { app } = siblingFamily('sibling-openapi');
    const out = path.join(app, 'api.json');
    const r = await sb.run(['surface', 'export', '--format', 'openapi', '--out', out], app);
    expect(r.code, transcript(r)).toBe(0);
    // Round 9: "no schema for … geo::coordinate … pin the external it comes from".
    expect(r.all).not.toContain('no schema for');
    expect(Object.keys(JSON.parse(fs.readFileSync(out, 'utf8')).components.schemas)).toEqual(['geo.coordinate']);
  });
});

describe('3. surface diff names a gateway verb whose local record embeds a renamed member field (platform)', () => {
  it('the verb answering `orders.order` is listed with the field rename', async () => {
    const shop = sb.project('shop-diff');
    writeProject(shop, {
      system: { name: 'shop-platform', vision: 'The shop.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'shared', typeDef: 'money', audience: 'project' }] },
      subsystems: [{ id: 'orders', description: 'Orders.' }, { id: 'edge', description: 'The public API.' }],
      components: [{ id: 'shop_api_portal', componentType: 'Portal', transport: 'HTTP', subsystem: 'edge', description: 'The shop API.', invokedBy: { kind: 'entry', caller: 'The shop web client, over HTTPS' } }],
      interfaces: [{ id: 'ishop_api_portal', component: 'shop_api_portal', methods: [
        { name: 'getOrder', description: 'One order.', params: [{ name: 'orderId', type: 'string' }], returns: 'async orders.order', effect: 'read', endpoint: { transport: 'HTTP', method: 'GET', path: '/v1/orders/{orderId}' } },
      ] }],
      implementations: [{ id: 'shop_api_portal_impl', contract: 'ishop_api_portal', methods: [{ name: 'getOrder', narrative: [{ stepNumber: 1, description: 'Answer the order', type: 'return', outcome: 'success' }] }] }],
      types: [{ id: 'order', kind: 'entity', subsystem: 'orders', name: 'Order', description: 'An order.', fields: [{ name: 'id', type: 'string' }, { name: 'total', type: 'shared::money' }] }],
    }, projectYaml('shop-platform', { members: { shared: 'libs/contracts' } }));
    const contracts = writeProject(path.join(shop, 'libs', 'contracts'), {
      system: { name: 'contracts', vision: 'Shared contracts.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'money', typeDef: 'money', audience: 'project' }] },
      subsystems: [{ id: 'money', description: 'Money.', publicInterfaces: [{ typeDef: 'money' }] }],
      types: [{ id: 'money', kind: 'value-object', subsystem: 'money', name: 'Money', description: 'An amount.', fields: [{ name: 'amountMinor', type: 'int' }, { name: 'currency', type: 'string' }] }],
    }, projectYaml('contracts'));
    writeFile(shop, '.wai/lock.json', JSON.stringify({ format: 3, stateId: { algorithm: 'sha256+design-2', digest: 'c'.repeat(64) } }));
    gitInit(shop);
    const rel = specFile(contracts, 'types', 'money');
    writeFile(contracts, rel, readFile(contracts, rel).replace('name: currency\n', 'name: currencyCode\n    previousNames:\n      - currency\n'));
    const r = await sb.run(['surface', 'diff', '--json'], shop);
    expect(r.code, transcript(r)).toBe(0);
    const changes = (JSON.parse(r.stdout) as { changes: { kind: string; name: string; member?: string; detail: string }[] }).changes;
    // Round 9: no shop_api_portal row — the public JSON body changed with no verb named.
    expect(changes).toContainEqual(expect.objectContaining({ kind: 'changed', name: 'shop_api_portal', member: 'getOrder', detail: expect.stringContaining('"currencyCode"') }));
  });
});

describe('4. OpenAPI bodies and stated statuses (solo-app, tinkerer)', () => {
  function habits(status?: number): FixtureTree {
    return {
      system: { name: 'Habitly', vision: 'A habit-tracking API.', targetLanguage: 'TypeScript' },
      subsystems: [{ id: 'habits', description: 'Habits.' }],
      components: [{ id: 'habit_portal', componentType: 'Portal', transport: 'HTTP', description: 'The habit API.', invokedBy: { kind: 'entry', caller: 'The Habitly mobile app, over HTTP' } }],
      interfaces: [{ id: 'ihabit_portal', component: 'habit_portal', methods: [
        { name: 'setReminder', description: 'Set or clear a reminder.', params: [{ name: 'habitId', type: 'string' }, { name: 'reminder', type: 'reminder?', description: 'JSON body; null clears the reminder' }], returns: 'void', effect: 'write', endpoint: { transport: 'HTTP', method: 'PUT', path: '/v1/habits/{habitId}/reminder' } },
        { name: 'getHabit', description: 'One habit.', params: [{ name: 'habitId', type: 'string' }], returns: 'reminder', effect: 'read', endpoint: { transport: 'HTTP', method: 'GET', path: '/v1/habits/{habitId}', ...(status !== undefined ? { status } : {}) } },
      ] }],
      implementations: [{ id: 'habit_portal_impl', contract: 'ihabit_portal', methods: ['setReminder', 'getHabit'].map((name) => ({ name, narrative: [{ stepNumber: 1, description: 'Answer', type: 'return', outcome: 'success' }] })) }],
      types: [{ id: 'reminder', kind: 'value-object', subsystem: 'habits', name: 'Reminder', description: 'A reminder.', fields: [{ name: 'time', type: 'string' }, { name: 'timeZone', type: 'string' }] }],
    };
  }

  it('an optional object param is the bare (nullable) body, never a `{ "reminder": … }` wrapper', async () => {
    const dir = writeProject(sb.project('habitly-body'), habits(), projectYaml('habitly'));
    const out = path.join(dir, 'api.json');
    const r = await sb.run(['surface', 'export', '--format', 'openapi', '--out', out], dir);
    expect(r.code, transcript(r)).toBe(0);
    const op = JSON.parse(fs.readFileSync(out, 'utf8')).paths['/v1/habits/{habitId}/reminder'].put;
    expect(op['x-wairon-body-param']).toBe('reminder');
    expect(op.requestBody.content['application/json'].schema.properties).toBeUndefined();
    expect(JSON.stringify(op.requestBody.content['application/json'].schema)).toContain('#/components/schemas/reminder');
  });

  it('a status no client names, and a redirect answering a record, are each a warning', async () => {
    const odd = await sb.run(['validate'], writeProject(sb.project('habitly-299'), habits(299), projectYaml('habitly')));
    expect(odd.all, transcript(odd)).toMatch(/\[ENDPOINT_STATUS_MISMATCH\][^\n]*299 is no standard success or redirect code/);
    const redirect = await sb.run(['validate'], writeProject(sb.project('habitly-302'), habits(302), projectYaml('habitly')));
    expect(redirect.all, transcript(redirect)).toMatch(/\[ENDPOINT_STATUS_MISMATCH\][^\n]*302 is a redirect/);
    const plain = await sb.run(['validate'], writeProject(sb.project('habitly-200'), habits(200), projectYaml('habitly')));
    expect(countCode(plain.all, 'ENDPOINT_STATUS_MISMATCH'), transcript(plain)).toBe(0);
  });
});
