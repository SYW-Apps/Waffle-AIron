import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { fromOpenApi, toOpenApiSet } from '../../src/core/openapi.js';
import { exportSurface, getExternalsStatus, listConsumers, pinExternals } from '../../src/core/surfaces.js';
import { adviseExternals, familyRelations, validateProject } from '../../src/core/validation.js';
import { execFileSync } from 'child_process';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
import { canonicalTypeRef, carriedFactChanges, relationHealth, surfaceChanges, SurfaceSnapshotSchema, type SurfaceSnapshot } from '../../src/models/index.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness';
import { projectYaml } from '../helpers/conformance-r6-trees';

// ---------------------------------------------------------------------------
// Round-9 sandbox trials — surfaces, externals, members and the OpenAPI
// codec. Each block replays one finding on a miniature snapshot or project.
// ---------------------------------------------------------------------------

const NOW = '2026-10-09T10:00:00.000Z';
const roots: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const dir of roots.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
  }
});

const snap = (over: Partial<SurfaceSnapshot>): SurfaceSnapshot => SurfaceSnapshotSchema.parse({ projectName: 'p', origin: 'generated', generatedAt: NOW, interfaces: [], types: [], ...over });

// ---------------------------------------------------------------------------
// 3. surface diff (platform, lib-and-app R9-25)
// ---------------------------------------------------------------------------

describe('3. surface diff names the wire change a verb makes', () => {
  it('a field renamed in an exported member type that a LOCAL record embeds names the verb answering the record', () => {
    // The gateway answers its own unexported `order`, whose `total` is the member's `money`, which the root re-exports.
    const gateway = (field: string, formerly?: string[]) => snap({
      projectName: 'shop-platform', projectId: 'shop-platform',
      interfaces: [{ id: 'shop_api_portal', name: 'Shop API', audience: 'project', type: 'REST', component: 'shop_api_portal', methods: [
        { name: 'getOrder', description: 'd', signature: 'getOrder(orderId: string): order', returns: 'order', params: [{ name: 'orderId', type: 'string' }], endpoint: { transport: 'HTTP', method: 'GET', path: '/orders/{orderId}' } },
      ] } as never],
      types: [
        { id: 'order', name: 'Order', kind: 'entity', fields: [{ name: 'id', type: 'string' }, { name: 'total', type: 'shared::money' }] },
        { id: 'shared::money', name: 'Money', kind: 'value-object', fields: [{ name: 'amountMinor', type: 'int' }, { name: field, type: 'string', ...(formerly ? { formerly } : {}) }] },
      ],
      exportedTypes: [{ id: 'money', type: 'shared::money', audience: 'project' }],
    });
    const rows = surfaceChanges(gateway('currencyCode', ['currency']), gateway('currency'));
    // The exported type's own row, as before…
    expect(rows).toContainEqual({ kind: 'renamed', name: 'money', member: 'currencyCode', from: 'currency', detail: 'field "currency" renamed to "currencyCode"' });
    // …and the verb whose response changed on the wire (round 9: missing).
    expect(rows).toContainEqual({ kind: 'changed', name: 'shop_api_portal', member: 'getOrder', detail: 'signature reads the same, but it names renamed types: renamed field "shared::money.currency" → "currencyCode"' });
  });

  it('a verb naming the exported type DIRECTLY is still left to the type\'s own row', () => {
    const portal = (field: string, formerly?: string[]) => snap({
      projectName: 'shop-platform',
      interfaces: [{ id: 'price_portal', name: 'Prices', audience: 'project', type: 'REST', component: 'price_portal', methods: [
        { name: 'price', description: 'd', signature: 'price(): shared::money', returns: 'shared::money', params: [], endpoint: { transport: 'HTTP', method: 'GET', path: '/price' } },
      ] } as never],
      types: [{ id: 'shared::money', name: 'Money', kind: 'value-object', fields: [{ name: field, type: 'string', ...(formerly ? { formerly } : {}) }] }],
      exportedTypes: [{ id: 'money', type: 'shared::money', audience: 'project' }],
    });
    const rows = surfaceChanges(portal('currencyCode', ['currency']), portal('currency'));
    expect(rows.filter((r) => r.name === 'price_portal')).toEqual([]);
  });

  it('a signature row renders each parameter under its own name, never respelled as a type', () => {
    const portal = (type: string, signature: string) => snap({
      projectName: 'shop-platform',
      interfaces: [{ id: 'orders_portal', name: 'Orders', audience: 'project', type: 'REST', component: 'orders_portal', methods: [
        { name: 'cancel', description: 'd', signature, returns: 'void', params: [{ name: 'orderId', type }] },
      ] } as never],
    });
    // The stored display signature of the older surface was respelled by the canonicalizer (round 9).
    const rows = surfaceChanges(portal('shared::order_id', 'cancel(contracts::order_id: shared::order_id): void'), portal('string', 'cancel(orderId: string): void'));
    expect(rows).toEqual([{ kind: 'changed', name: 'orders_portal', member: 'cancel', detail: 'signature cancel(orderId: string): void → cancel(orderId: shared::order_id): void' }]);
  });

  it('a type swap the consumer followed names the renames inside the type, the field a client reads included', () => {
    const portal = (returns: string, types: SurfaceSnapshot['types']) => snap({
      projectName: 'route-planner',
      interfaces: [{ id: 'route_portal', name: 'Routes', audience: 'project', type: 'REST', component: 'route_portal', methods: [
        { name: 'getRouteTiles', description: 'd', signature: `getRouteTiles(id: string): ${returns}`, returns, params: [{ name: 'id', type: 'string' }] },
      ] } as never],
      types,
    });
    // The older side could not expand the member's type; the newer one carries its rename trace.
    const older = portal('list<geo::tile_coord>', []);
    const newer = portal('list<geo::tile>', [{ id: 'geo::tile', name: 'Tile', kind: 'value-object', formerly: ['geo::tile_coord'], fields: [{ name: 'x', type: 'int' }, { name: 'y', type: 'int' }, { name: 'z', type: 'int', formerly: ['zoom'] }] }]);
    const [row] = surfaceChanges(newer, older);
    expect(row.detail).toBe('signature getRouteTiles(id: string): list<geo::tile_coord> → getRouteTiles(id: string): list<geo::tile> (type "geo::tile_coord" renamed to "geo::tile"; field "geo::tile.zoom" renamed to "z")');
  });
});

// ---------------------------------------------------------------------------
// 4. OpenAPI: an OPTIONAL object param was wrapped under its name (solo-app)
// ---------------------------------------------------------------------------

describe('4. the single object body param, optional or nullable, is the bare body', () => {
  const habits = (param: Record<string, unknown>) => snap({
    projectName: 'habitly',
    interfaces: [{ id: 'habit_portal', name: 'Habits', audience: 'project', type: 'REST', component: 'habit_portal', methods: [
      { name: 'setReminder', description: 'd', signature: 'setReminder(habitId: string, reminder: reminder?): void', returns: 'void', params: [{ name: 'habitId', type: 'string' }, param], endpoint: { transport: 'HTTP', method: 'PUT', path: '/v1/habits/{habitId}/reminder' } },
    ] } as never],
    types: [{ id: 'reminder', name: 'Reminder', kind: 'value-object', fields: [{ name: 'time', type: 'string' }, { name: 'timeZone', type: 'string' }] }],
  });

  it('a `T?` param is the nullable body, required (null clears), named under x-wairon-body-param — and reads back exactly', () => {
    const s = habits({ name: 'reminder', type: 'reminder?', description: 'JSON body; null clears the reminder' });
    const doc = JSON.parse(toOpenApiSet(s)[0].document);
    const op = doc.paths['/v1/habits/{habitId}/reminder'].put;
    expect(op['x-wairon-body-param']).toBe('reminder');
    expect(op.requestBody.required).toBe(true);
    const schema = op.requestBody.content['application/json'].schema;
    expect(JSON.stringify(schema)).toContain('#/components/schemas/reminder');
    expect(schema.properties).toBeUndefined();
    const back = fromOpenApi(toOpenApiSet(s)[0].document, 'habitly').interfaces[0].methods[0].params;
    expect(back?.find((p) => p.name === 'reminder')).toEqual({ name: 'reminder', type: 'reminder?', description: 'JSON body; null clears the reminder' });
  });

  it('an optional object param is the optional body, never a wrapper', () => {
    const doc = JSON.parse(toOpenApiSet(habits({ name: 'reminder', type: 'reminder', optional: true }))[0].document);
    const op = doc.paths['/v1/habits/{habitId}/reminder'].put;
    expect(op['x-wairon-body-param']).toBe('reminder');
    expect(op.requestBody.required).toBe(false);
    expect(op.requestBody.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/reminder' });
  });
});

// ---------------------------------------------------------------------------
// Shared: real temp projects from fixture trees.
// ---------------------------------------------------------------------------

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-round9-')));
  roots.push(dir);
  return dir;
}

/** A project written from a fixture tree into `dir`, its configuration given. */
function writeProject(dir: string, tree: FixtureTree, config: string): string {
  fs.mkdirSync(dir, { recursive: true });
  materializeFixtureProject(dir, { ...tree, files: { ...(tree.files ?? {}), '.wai/project.yaml': config } });
  return dir;
}

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
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

/** The producer's contract file, its route rewritten — or its endpoint dropped (`to` null). */
function moveRoute(producer: string, from: string, to: string | null): void {
  const dir = path.join(producer, '.wai', 'specs', 'interfaces');
  const file = path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith('istats_portal'))!);
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, to === null
    ? text.replace(/\n(\s*)endpoint:\n(?:\1\s+.*\n)+/, '\n')
    : text.split(`path: ${from}`).join(`path: ${to}`));
  invalidateSpecCache();
}

// ---------------------------------------------------------------------------
// 1. An endpoint path move was invisible to the consumer (tinkerer top-1)
// ---------------------------------------------------------------------------

describe('1. a used verb\'s route moving reaches the consumer', () => {
  function pinnedPair(): { producer: string; consumer: string } {
    const folder = tempDir();
    const producer = writeProject(path.join(folder, 'linkshort'), statsApi(), projectYaml('linkshort'));
    const consumer = writeProject(path.join(folder, 'dashboard'), dashboard(), projectYaml('dashboard', { externals: { linkshort: { project: 'linkshort', source: { path: '../linkshort' } } } }));
    bind(consumer);
    expect(pinExternals().map((p) => p.outcome)).toEqual(['pinned']);
    return { producer, consumer };
  }

  it('a moved path drifts the external, names the route on the use and in the advisory — and the re-pin says what moved', () => {
    const { producer, consumer } = pinnedPair();
    moveRoute(producer, '/stats/{shortCode}', '/v2/stats/{shortCode}');
    bind(consumer);
    const [status] = getExternalsStatus();
    expect(status.uses).toEqual([{ publicName: 'stats_portal', member: 'getStats', state: 'unchanged', detail: expect.stringContaining('endpoint moved: GET /stats/{shortCode} → GET /v2/stats/{shortCode}') }]);
    expect(status.drifted).toBe(true);
    expect(status.staleFacts).toContain('endpoint of stats_portal.getStats (GET /stats/{shortCode} → GET /v2/stats/{shortCode})');
    expect(relationHealth(status)).toBe('drifted');
    bind(consumer);
    const advised = adviseExternals();
    expect(advised.map((i) => i.code)).toEqual(['EXTERNAL_DRIFTED']);
    expect(advised[0].message).toContain('the route of "stats_portal.getStats" (GET /stats/{shortCode} → GET /v2/stats/{shortCode}) moved');
    // The re-pin rewrites the route with a word, never silently (round 9: "pinned 1 used name(s)").
    bind(consumer);
    const [pin] = pinExternals();
    expect(pin.detail).toContain('moved since the last pin: endpoint of stats_portal.getStats (GET /stats/{shortCode} → GET /v2/stats/{shortCode})');
    bind(consumer);
    expect(relationHealth(getExternalsStatus()[0])).toBe('ok');
  });

  it('a verb stating a new status moves the route too', () => {
    const { producer, consumer } = pinnedPair();
    moveRoute(producer, '/stats/{shortCode}', '/stats/{shortCode}\n      status: 203');
    bind(consumer);
    const [status] = getExternalsStatus();
    expect(status.uses[0].detail).toContain('endpoint moved: GET /stats/{shortCode} → GET /stats/{shortCode} (answers 203)');
  });

  it('a route removed is a break: the use is changed and the relation incompatible', () => {
    const { producer, consumer } = pinnedPair();
    moveRoute(producer, '/stats/{shortCode}', null);
    bind(consumer);
    const [status] = getExternalsStatus();
    expect(status.uses[0]).toMatchObject({ state: 'changed', detail: expect.stringContaining('endpoint GET /stats/{shortCode} removed') });
    expect(relationHealth(status)).toBe('incompatible');
  });

  it('carriedFactChanges names an endpoint move, and a pin that recorded no endpoint moves nothing', () => {
    const entry = (endpoint?: Record<string, unknown>) => snap({ interfaces: [{ id: 'api', name: 'API', audience: 'instance', type: 'REST', component: 'api', methods: [
      { name: 'get', description: 'd', signature: 'get(): int', returns: 'int', params: [], ...(endpoint ? { endpoint } : {}) },
    ] } as never] });
    expect(carriedFactChanges(entry({ transport: 'HTTP', method: 'GET', path: '/a' }), entry({ transport: 'HTTP', method: 'PUT', path: '/a' }))).toEqual(['endpoint of api.get (GET /a → PUT /a)']);
    expect(carriedFactChanges(entry(), entry({ transport: 'HTTP', method: 'GET', path: '/a' }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The sibling-member model (lib-and-app top-1)
// ---------------------------------------------------------------------------

/** The geo SDK: a Rust library exporting its distance Portal (InProcess) and a type. */
function geoSdk(methods: { name: string; params: { name: string; type: string }[]; returns: string }[] = [
  { name: 'haversine_distance', params: [{ name: 'from', type: 'coordinate' }, { name: 'to', type: 'coordinate' }], returns: 'float' },
  { name: 'vincenty_distance', params: [{ name: 'from', type: 'coordinate' }, { name: 'to', type: 'coordinate' }], returns: 'float' },
]): FixtureTree {
  return {
    system: { name: 'geo-sdk', vision: 'Geospatial maths as a library.', targetLanguage: 'Rust', publicInterfaces: [
      { from: 'distance', component: 'distance_portal', as: 'distance', audience: 'external' },
      { from: 'distance', typeDef: 'coordinate', audience: 'external' },
    ] },
    subsystems: [{ id: 'distance', description: 'Distances.', publicInterfaces: [{ component: 'distance_portal', details: 'Distances.' }, { typeDef: 'coordinate' }] }],
    components: [{ id: 'distance_portal', componentType: 'Portal', transport: 'InProcess', description: 'The distance API.', invokedBy: { kind: 'entry', caller: 'Applications linking the crate' } }],
    interfaces: [{ id: 'idistance_portal', component: 'distance_portal', methods: methods.map((m) => ({ ...m, description: m.name, effect: 'none' })) }],
    implementations: [{ id: 'distance_portal_impl', contract: 'idistance_portal', methods: methods.map((m) => ({ name: m.name, narrative: [{ stepNumber: 1, description: 'Compute the distance', type: 'return', outcome: 'success' }] })) }],
    types: [{ id: 'coordinate', kind: 'value-object', subsystem: 'distance', name: 'Coordinate', description: 'A point.', fields: [{ name: 'lat', type: 'float' }, { name: 'lon', type: 'float' }] }],
  };
}

/** The route planner: composes ../geo-sdk as a MEMBER; its stop sequencer calls geo::distance. */
function routePlanner(binding?: string): FixtureTree {
  return {
    system: { name: 'route-planner', vision: 'Plans delivery routes.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'routing', description: 'Routing.' }],
    components: [{ id: 'stop_sequencer', componentType: 'Orchestrator', description: 'Orders stops by distance.', dependsOn: ['geo::distance'], invokedBy: { kind: 'runtime', caller: 'The planning job the composition root schedules' } }],
    interfaces: [{ id: 'istop_sequencer', component: 'stop_sequencer', methods: [{ name: 'sequence', description: 'Order the stops.', params: [{ name: 'stops', type: 'list<geo::coordinate>' }], returns: 'list<geo::coordinate>', effect: 'none' }] }],
    implementations: [{
      id: 'stop_sequencer_impl', contract: 'istop_sequencer', sourcePath: 'src/sequencer.ts',
      ...(binding ? { bindings: ['src/geo-binding.ts'] } : {}),
      methods: [{ name: 'sequence', detail: 'intent', intent: 'Orders the stops by distance.', calls: ['geo::distance.haversine_distance'] }],
    }],
    files: binding ? { 'src/geo-binding.ts': binding } : {},
  };
}

/** A folder holding the SDK and the app that composes it as a `../` sibling member. */
function siblingFamily(binding?: string): { folder: string; sdk: string; app: string } {
  const folder = tempDir();
  const sdk = writeProject(path.join(folder, 'geo-sdk'), geoSdk(), projectYaml('geo-sdk'));
  const app = writeProject(path.join(folder, 'route-planner'), routePlanner(binding), projectYaml('route-planner', { members: { geo: '../geo-sdk' } }));
  return { folder, sdk, app };
}

describe('2a. a project composing this one as a sibling member is its consumer', () => {
  it('found from the producer\'s root with no search — the enclosing folder holds the parent', () => {
    const { sdk } = siblingFamily();
    bind(sdk);
    const consumers = listConsumers();
    expect(consumers.map((c) => [c.project, c.section, c.alias, c.names])).toEqual([['route-planner', 'members', 'geo', ['coordinate', 'distance']]]);
    expect(consumers[0].uses).toContainEqual(expect.objectContaining({ publicName: 'distance', members: ['haversine_distance'] }));
  });

  it('found by `--search ..` too, once', () => {
    const { sdk, folder } = siblingFamily();
    bind(sdk);
    const consumers = listConsumers([folder]);
    expect(consumers.map((c) => [c.project, c.section])).toEqual([['route-planner', 'members']]);
  });

  it('a project that composes something else is no consumer', () => {
    const { sdk, folder } = siblingFamily();
    writeProject(path.join(folder, 'other'), routePlanner(), projectYaml('other', { members: { geo: '../route-planner' } }));
    bind(sdk);
    expect(listConsumers([folder]).map((c) => c.project)).toEqual(['route-planner']);
  });
});

describe('2c. the OpenAPI document describes a sibling member\'s types, and the parent\'s re-exports a promoted member names', () => {
  /** The route planner's own HTTP API, answering the sibling SDK's coordinate. */
  function routeApi(): FixtureTree {
    const tree = routePlanner();
    return {
      ...tree,
      components: [...tree.components!, { id: 'route_portal', componentType: 'Portal', transport: 'HTTP', description: 'The routing API.', invokedBy: { kind: 'entry', caller: 'The dispatch web app, over HTTPS' } }],
      interfaces: [...tree.interfaces!, { id: 'iroute_portal', component: 'route_portal', methods: [
        { name: 'nearest', description: 'The nearest depot.', params: [{ name: 'at', type: 'geo::coordinate' }], returns: 'geo::coordinate', effect: 'read', endpoint: { transport: 'HTTP', method: 'POST', path: '/nearest' } },
      ] }],
    };
  }

  it('a `../` sibling member\'s types resolve as a contained member\'s do (round 9: "Unresolved type", "pin the external")', () => {
    const folder = tempDir();
    writeProject(path.join(folder, 'geo-sdk'), geoSdk(), projectYaml('geo-sdk'));
    const app = writeProject(path.join(folder, 'route-planner'), routeApi(), projectYaml('route-planner', { members: { geo: '../geo-sdk' } }));
    bind(app);
    const result = exportSurface('project', 'openapi');
    expect(result.unresolvedTypes).toBeUndefined();
    const doc = JSON.parse(result.renderedSet![0].document);
    expect(Object.keys(doc.components.schemas)).toEqual(['geo.coordinate']);
    expect(doc.components.schemas['geo.coordinate'].properties).toHaveProperty('lat');
  });

  it('a type a member names through this project\'s own id (its L0 re-export) resolves from the project\'s own surface', () => {
    const shop = tempDir();
    writeProject(shop, {
      system: { name: 'shop-platform', vision: 'The shop.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'shared', typeDef: 'money', audience: 'project' }] },
      subsystems: [{ id: 'edge', description: 'The public API.' }],
      components: [{ id: 'shop_api_portal', componentType: 'Portal', transport: 'HTTP', description: 'The shop API.', invokedBy: { kind: 'entry', caller: 'The shop web client, over HTTPS' } }],
      interfaces: [{ id: 'ishop_api_portal', component: 'shop_api_portal', methods: [
        { name: 'getPayment', description: 'One payment.', params: [{ name: 'paymentId', type: 'string' }], returns: 'payments_svc::payment', effect: 'read', endpoint: { transport: 'HTTP', method: 'GET', path: '/payments/{paymentId}' } },
      ] }],
    }, projectYaml('shop-platform', { members: { payments_svc: 'services/payments', shared: 'libs/contracts' } }));
    writeProject(path.join(shop, 'libs', 'contracts'), {
      system: { name: 'contracts', vision: 'Shared contracts.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'money', typeDef: 'money', audience: 'project' }] },
      subsystems: [{ id: 'money', description: 'Money.', publicInterfaces: [{ typeDef: 'money' }] }],
      types: [{ id: 'money', kind: 'value-object', subsystem: 'money', name: 'Money', description: 'An amount.', fields: [{ name: 'amountMinor', type: 'int' }, { name: 'currencyCode', type: 'string' }] }],
    }, projectYaml('contracts'));
    // The promoted member names the money type through its parent's re-export.
    writeProject(path.join(shop, 'services', 'payments'), {
      system: { name: 'payments', vision: 'Payments.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'payments', typeDef: 'payment', audience: 'project' }] },
      subsystems: [{ id: 'payments', description: 'Payments.', publicInterfaces: [{ typeDef: 'payment' }] }],
      types: [{ id: 'payment', kind: 'entity', subsystem: 'payments', name: 'Payment', description: 'A payment.', fields: [{ name: 'id', type: 'string' }, { name: 'total', type: 'shop-platform::money' }] }],
    }, projectYaml('payments_svc', { externals: { 'shop-platform': { project: 'shop-platform', source: { path: '../..' } } } }));
    bind(shop);
    const result = exportSurface('project', 'openapi');
    expect(result.unresolvedTypes).toBeUndefined();
    expect(result.renderedSet![0].document).not.toContain('Unresolved type');
  });
});

// ---------------------------------------------------------------------------
// 2b / 5. A live member is compared with the approval it is judged against
// ---------------------------------------------------------------------------

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
  });
}

/** An approval record the member commits: what its lock's stateId digest is. */
function approve(dir: string, digest: string, message: string): void {
  fs.writeFileSync(path.join(dir, '.wai', 'lock.json'), JSON.stringify({ format: 3, stateId: { algorithm: 'sha256+design-2', digest } }, null, 2));
  git(dir, 'add', '-A');
  git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
}

const BINDING = [
  'export interface Coordinate { lat: number; lon: number }',
  'export function haversine_distance(from: Coordinate, to: Coordinate): number { return 0; }',
  'export function vincenty_distance(from: Coordinate, to: Coordinate): number { return 0; }',
  '',
].join('\n');

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

/** The SDK approved at v1 (commit A), then v2 drops vincenty_distance — committed with its own re-approval (B) when asked. */
function approvedThenDropped(relock: boolean): { sdk: string; app: string } {
  const { sdk, app } = siblingFamily(BINDING);
  git(sdk, 'init', '-q');
  approve(sdk, A, 'v1 approved');
  fs.writeFileSync(path.join(app, 'src', 'sequencer.ts'), 'export function sequence(stops: unknown[]): unknown[] { return stops; }\n');
  // v2: vincenty_distance removed from the contract and its realization, no trace.
  for (const [kind, prefix] of [['interfaces', 'idistance_portal'], ['implementations', 'distance_portal_impl']]) {
    const dir = path.join(sdk, '.wai', 'specs', kind);
    const file = path.join(dir, fs.readdirSync(dir).find((x) => x.startsWith(prefix))!);
    const spec = readYamlFile(file) as { methods: { name: string }[] };
    writeYamlFile(file, { ...spec, methods: spec.methods.filter((m) => m.name !== 'vincenty_distance') });
  }
  if (relock) approve(sdk, B, 'v2 approved');
  invalidateSpecCache();
  return { sdk, app };
}

describe('2b. a verb removed from a sibling member reaches the consumer\'s binding', () => {
  it('a bare binding export the member\'s approved design held, and its live export no longer does, is named removed', () => {
    const { app } = approvedThenDropped(false);
    bind(app);
    const drift = validateProject().issues.filter((i) => i.code === 'BINDING_DRIFT');
    expect(drift.map((i) => i.message)).toEqual([expect.stringContaining('"vincenty_distance" was removed from geo::distance (the member\'s approved design held it)')]);
  });

  it('judged against the approval the CONSUMER\'s lock records — even after the member re-approved without it', () => {
    const { app } = approvedThenDropped(true);
    // The consumer's approval recorded the member at v1.
    fs.writeFileSync(path.join(app, '.wai', 'lock.json'), JSON.stringify({ format: 3, stateId: { algorithm: 'sha256+design-2', digest: 'c'.repeat(64) }, specs: {}, members: { geo: { as: 'project', project: 'geo-sdk', subject: `sha256+design-2:${A}`, state: 'approved' } } }));
    bind(app);
    expect(validateProject().issues.filter((i) => i.code === 'BINDING_DRIFT').map((i) => i.message)).toEqual([expect.stringContaining('"vincenty_distance" was removed from geo::distance')]);
    // Re-approved by the consumer at v2: the member's design it approved no longer holds it.
    fs.writeFileSync(path.join(app, '.wai', 'lock.json'), JSON.stringify({ format: 3, stateId: { algorithm: 'sha256+design-2', digest: 'c'.repeat(64) }, specs: {}, members: { geo: { as: 'project', project: 'geo-sdk', subject: `sha256+design-2:${B}`, state: 'approved' } } }));
    bind(app);
    expect(validateProject().issues.filter((i) => i.code === 'BINDING_DRIFT')).toEqual([]);
  });
});

describe('5. a live member\'s relation health reports drift and incompatibility against its approved surface', () => {
  it('a member that dropped a verb the consumer does not use is drifted; one that changed a used verb is incompatible', () => {
    const { app, sdk } = approvedThenDropped(false);
    bind(app);
    const geo = () => familyRelations().find((r) => r.project === '')!.externals.find((s) => s.alias === 'geo')!;
    const drifted = geo();
    expect(drifted.drifted).toBe(true);
    expect(relationHealth(drifted)).toBe('drifted');
    // haversine_distance now answers an int: a used verb changed since the approval.
    const dir = path.join(sdk, '.wai', 'specs', 'interfaces');
    const file = path.join(dir, fs.readdirSync(dir).find((x) => x.startsWith('idistance_portal'))!);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('returns: float').join('returns: int'));
    invalidateSpecCache();
    bind(app);
    const changed = geo();
    expect(changed.uses).toContainEqual(expect.objectContaining({ publicName: 'distance', member: 'haversine_distance', state: 'changed' }));
    expect(relationHealth(changed)).toBe('incompatible');
  });
});

describe('2. the `member promote` shape: a binding reached through this project\'s own re-exports is compared', () => {
  it('a gateway client whose signatures spell this project\'s re-export of a member type compares its binding with that member', () => {
    const shop = tempDir();
    writeProject(shop, {
      system: { name: 'shop-platform', vision: 'The shop.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'shared', typeDef: 'money', audience: 'project' }] },
      subsystems: [{ id: 'edge', description: 'The public API.' }],
      components: [{ id: 'payments_client', componentType: 'Adapter', description: 'Calls the payments service.', dependsOn: ['payments_svc::payments'], invokedBy: { kind: 'runtime', caller: 'The checkout job the composition root schedules' } }],
      interfaces: [{ id: 'ipayments_client', component: 'payments_client', methods: [
        { name: 'charge', description: 'Charge an amount.', params: [{ name: 'amount', type: 'shop-platform::money' }], returns: 'void', effect: 'io' },
      ] }],
      implementations: [{ id: 'payments_client_impl', contract: 'ipayments_client', sourcePath: 'src/payments-client.ts', bindings: ['src/contracts-binding.ts'],
        methods: [{ name: 'charge', detail: 'intent', intent: 'Charges the amount through the payments service.', calls: ['payments_svc::payments.charge'] }] }],
      files: {
        'src/payments-client.ts': 'export function charge(amount: unknown): void { void amount; }\n',
        'src/contracts-binding.ts': 'export interface Money { amountCents: number; currencyCode: string }\n',
      },
    }, projectYaml('shop-platform', { members: { payments_svc: 'services/payments', shared: 'libs/contracts' } }));
    writeProject(path.join(shop, 'libs', 'contracts'), {
      system: { name: 'contracts', vision: 'Shared contracts.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'money', typeDef: 'money', audience: 'project' }] },
      subsystems: [{ id: 'money', description: 'Money.', publicInterfaces: [{ typeDef: 'money' }] }],
      types: [{ id: 'money', kind: 'value-object', subsystem: 'money', name: 'Money', description: 'An amount.', fields: [{ name: 'amountMinor', type: 'int' }, { name: 'currencyCode', type: 'string' }] }],
    }, projectYaml('contracts'));
    writeProject(path.join(shop, 'services', 'payments'), {
      system: { name: 'payments', vision: 'Payments.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'payments', component: 'payments_portal', as: 'payments', audience: 'project' }] },
      subsystems: [{ id: 'payments', description: 'Payments.', publicInterfaces: [{ component: 'payments_portal' }] }],
      components: [{ id: 'payments_portal', componentType: 'Portal', transport: 'InProcess', description: 'The payments API.', invokedBy: { kind: 'entry', caller: 'The shop gateway, in process' } }],
      interfaces: [{ id: 'ipayments_portal', component: 'payments_portal', methods: [
        { name: 'charge', description: 'Charge.', params: [{ name: 'amount', type: 'shop-platform::money' }], returns: 'void', effect: 'io' },
      ] }],
      implementations: [{ id: 'payments_portal_impl', contract: 'ipayments_portal', methods: [{ name: 'charge', narrative: [{ stepNumber: 1, description: 'Charge it', type: 'return', outcome: 'success' }] }] }],
    }, projectYaml('payments_svc', { externals: { 'shop-platform': { project: 'shop-platform', source: { path: '../..' } } } }));
    bind(shop);
    const drift = validateProject().issues.filter((i) => i.code === 'BINDING_DRIFT' || i.code === 'BINDING_UNREAD');
    // Round 9: uncompared until the member switched to the library — the planted field went unnoticed.
    expect(drift.map((i) => `${i.code} ${i.message}`)).toEqual([expect.stringMatching(/BINDING_DRIFT[^\n]*"Money" no longer matches shared::money[^\n]*field "amountCents" is not in the pinned type/)]);
  });
});

describe('3b. a local record spelled `<subsystem>.<id>` is read with its closure', () => {
  it('a verb answering `orders.order` names the member field renamed inside it (platform: getOrder missing)', () => {
    const gateway = (field: string, formerly?: string[]) => snap({
      projectName: 'shop-platform', projectId: 'shop-platform',
      interfaces: [{ id: 'shop_api_portal', name: 'Shop API', audience: 'project', type: 'REST', component: 'shop_api_portal', methods: [
        { name: 'getOrder', description: 'd', signature: 'getOrder(orderId: string): async orders.order', returns: 'async orders.order', params: [{ name: 'orderId', type: 'string' }] },
      ] } as never],
      types: [
        { id: 'order', name: 'Order', kind: 'entity', fields: [{ name: 'total', type: 'shared::money' }] },
        { id: 'shared::money', name: 'Money', kind: 'value-object', fields: [{ name: field, type: 'string', ...(formerly ? { formerly } : {}) }] },
      ],
    });
    expect(canonicalTypeRef(gateway('currency'), 'async orders.order')).toBe('async order');
    // `shared::order` is another project's spelling: never the local record.
    expect(canonicalTypeRef(gateway('currency'), 'shared::order')).toBe('shared::order');
    expect(surfaceChanges(gateway('currencyCode', ['currency']), gateway('currency'))).toEqual([
      { kind: 'changed', name: 'shop_api_portal', member: 'getOrder', detail: 'signature reads the same, but it names renamed types: renamed field "shared::money.currency" → "currencyCode"' },
    ]);
  });
});
