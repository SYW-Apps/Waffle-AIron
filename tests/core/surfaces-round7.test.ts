import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { validateProject, type ValidationIssue } from '../../src/core/validation.js';
import { getExternalsStatus, pinExternals, withForeignTypes } from '../../src/core/surfaces.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';
import { geoKit, projectYaml, routePlanner } from '../helpers/conformance-r6-trees.js';
import { saveSystemSpec, saveSpec, saveComponentSpec, saveInterfaceSpec } from '../../src/core/specs.js';
import { renameField, renameParam } from '../../src/core/provision.js';
import { narrowedToUses, surfaceChanges, SurfaceSnapshotSchema, type SurfaceSnapshot } from '../../src/models/index.js';
import { createMember } from '../../src/core/index.js';
import { fromOpenApi, toOpenApiSet } from '../../src/core/openapi.js';
import { isolateGlobals, bareFrom, writeLedger, writeShop, tempDir as stage8TempDir, system as stage8System, projectYaml as stage8ProjectYaml } from '../helpers/stage8-family.js';
import type { ComponentSpec, ExternalConsumer, SubsystemSpec, TypeSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Round-7 sandbox trials — surfaces, externals, rename break reports and the
// OpenAPI codec. Each block replays one finding on a miniature project:
//   pin. A verb the producer removed and a consumer's binding still declares
//        as a free function was "the binding's own" — never named.
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const dir of roots.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
  }
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-round7-')));
  roots.push(dir);
  return dir;
}

function materialize(dir: string, tree: FixtureTree): void {
  materializeFixtureProject(dir, tree);
  for (const [rel, text] of Object.entries(tree.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

const said = (issues: ValidationIssue[]): string => issues.map(i => `${i.code}: ${i.message}`).join('\n');

/** GeoKit with a second distance verb, `vincenty`, beside haversine. */
function geoKitWithVincenty(): FixtureTree {
  const tree = geoKit();
  const [contract] = tree.interfaces!;
  const methods = contract.methods as Record<string, unknown>[];
  return { ...tree, interfaces: [{ ...contract, methods: [...methods, { ...methods[0], name: 'vincenty', description: 'Ellipsoidal distance in km.' }] }] };
}

describe('pin: a verb the producer removed is carried as retired, and a binding still declaring it is told', () => {
  it('re-pinning after a removal records it, and BINDING_DRIFT names the free function', () => {
    const root = tempDir();
    const geo = path.join(root, 'geo');
    const studio = path.join(root, 'route-planner');
    materialize(geo, geoKitWithVincenty());
    fs.writeFileSync(path.join(geo, '.wai', 'project.yaml'), projectYaml('geo-kit'));
    const planner = routePlanner('stops: Coordinate[]');
    planner.implementations = planner.implementations!.map((impl) => ({ ...impl, bindings: ['src/geo-binding.ts'] }));
    materialize(studio, planner);
    fs.writeFileSync(path.join(studio, 'src', 'geo-binding.ts'), 'export interface Coordinate { lat: number; lon: number }\nexport function haversine(from: Coordinate, to: Coordinate): number;\nexport function vincenty(from: Coordinate, to: Coordinate): number;\n');
    fs.writeFileSync(path.join(studio, '.wai', 'project.yaml'), projectYaml('route-planner', { externals: { geo: { source: { path: '../geo' } } } }));
    setProjectRoot(studio);
    invalidateSpecCache();
    pinExternals();
    // GeoKit drops vincenty; the consumer re-pins.
    materialize(geo, geoKit());
    invalidateSpecCache();
    pinExternals();
    invalidateSpecCache();
    const snapshot = yaml.load(fs.readFileSync(path.join(studio, '.wai', 'externals', 'geo.yaml'), 'utf8')) as { interfaces: { retired?: string[] }[] };
    expect(snapshot.interfaces[0].retired).toEqual(['vincenty']);
    const issues = validateProject().issues.filter((i) => i.code === 'BINDING_DRIFT');
    expect(said(issues)).toContain('"vincenty" was removed from geo::distance_library (an earlier pin held it)');
    // A second re-pin with nothing new keeps the record and reports no change.
    const [again] = pinExternals();
    expect(again.outcome).toBe('unchanged');
  });
});

// ---------------------------------------------------------------------------
// 2. Rename break reports (tinkerer N6, platform top-3): a parameter renamed
//    on the method a published Portal verb forwards named no export and no
//    break; asked on the Portal it was refused; and after a method rename a
//    field rename dropped the consumer whose call no longer resolved.
// ---------------------------------------------------------------------------

const NOW = '2026-10-08T10:00:00.000Z';

/** LinkShort: `hit_orchestrator.getStats(code)` forwarded by the published stats Portal's verb `statsFor` (formerly getStats), answering link_stats. */
function linkShort(): string {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({ schemaVersion: '1.0.0', id: 'linkshort', name: 'linkshort', targets: [], rules: {}, createdAt: NOW, updatedAt: NOW }));
  setProjectRoot(dir);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'linkshort', vision: 'v', boundaries: [], globalRequirements: [], createdAt: NOW, updatedAt: NOW,
    publicInterfaces: [{ from: 'links', component: 'stats_portal', as: 'stats-api' }, { from: 'links', typeDef: 'link_stats' }],
  } as never);
  saveSpec('subsystem', {
    id: 'links', name: 'links', description: 'd', parentSystem: 'linkshort', trustedLinks: [], createdAt: NOW, updatedAt: NOW,
    publicInterfaces: [{ component: 'stats_portal', details: 'The stats API' }, { typeDef: 'link_stats' }],
  } as unknown as SubsystemSpec);
  saveSpec('type', { id: 'link_stats', name: 'LinkStats', kind: 'value-object', subsystem: 'links', fields: [{ name: 'hits', type: 'int' }, { name: 'lastHitAt', type: 'datetime' }], createdAt: NOW, updatedAt: NOW } as unknown as TypeSpec);
  saveComponentSpec({ id: 'hit_orchestrator', name: 'hit', description: 'd', subsystem: 'links', componentType: 'Orchestrator', owns: [], dependsOn: [], createdAt: NOW, updatedAt: NOW } as ComponentSpec);
  saveComponentSpec({ id: 'stats_portal', name: 'stats', description: 'd', subsystem: 'links', componentType: 'Portal', transport: 'HTTP', owns: [], dependsOn: ['hit_orchestrator'], createdAt: NOW, updatedAt: NOW } as ComponentSpec);
  saveInterfaceSpec({
    id: 'ihit_orchestrator', name: 'ihit', description: 'c', component: 'hit_orchestrator', createdAt: NOW, updatedAt: NOW,
    methods: [{ name: 'getStats', description: 'Stats of a link.', signature: 'getStats(code: string): link_stats', returns: 'link_stats', params: [{ name: 'code', type: 'string' }] }],
  });
  saveInterfaceSpec({
    id: 'istats_portal', name: 'istats', description: 'c', component: 'stats_portal', createdAt: NOW, updatedAt: NOW,
    methods: [{ name: 'statsFor', description: 'Stats of a link.', signatureFrom: 'hit_orchestrator.getStats', previousNames: ['getStats'], endpoint: { transport: 'HTTP', method: 'GET', path: '/stats/{code}' } }],
  } as never);
  invalidateSpecCache();
  return dir;
}

/** A consumer as listConsumers reads it, with the uses (and broken names) given. */
const dashboard = (uses: ExternalConsumer['uses'], broken?: string[]): ExternalConsumer => ({
  project: 'dashboard', key: 'dashboard', directory: '/dashboard', alias: 'linkshort', section: 'externals',
  names: (uses ?? []).map((u) => u.publicName), uses, ...(broken ? { broken } : {}), found: 'search',
});

describe('2. rename break reports follow signatureFrom and keep consumers already broken', () => {
  it('a parameter renamed on the forwarded method names the Portal export and the consumer calling its verb', () => {
    linkShort();
    const dry = renameParam('hit_orchestrator', 'getStats', 'code', 'shortCode', true);
    expect(dry.publishedIn).toEqual(['stats-api', 'stats_portal']);
    expect(dry.published?.find((u) => u.publicName === 'stats-api')).toMatchObject({ members: ['statsFor'], formerMembers: { statsFor: ['getStats'] } });
    expect(dry.rewritten).toEqual(['istats_portal.statsFor: {code} -> {shortCode}']);
    const consumer = dashboard([{ publicName: 'stats-api', kind: 'component', members: ['statsFor'], specs: ['stats_client'] }]);
    expect(narrowedToUses(consumer, dry.published!)?.uses).toEqual([{ publicName: 'stats-api', kind: 'component', members: ['statsFor'], specs: ['stats_client'] }]);
  });

  it('asked on the Portal verb, the rename is made on its source and says so', () => {
    linkShort();
    const routed = renameParam('stats_portal', 'statsFor', 'code', 'shortCode', true);
    expect(routed).toMatchObject({ component: 'hit_orchestrator', method: 'getStats', routedFrom: 'stats_portal.statsFor', publishedIn: ['stats-api', 'stats_portal'] });
  });

  it('a refusal for a source the rename cannot reach names it and says the rename reaches the verb from there', () => {
    linkShort();
    saveInterfaceSpec({
      id: 'istats_portal', name: 'istats', description: 'c', component: 'stats_portal', createdAt: NOW, updatedAt: NOW,
      methods: [{ name: 'statsFor', description: 'Stats.', signatureFrom: 'stats_sig' }],
    } as never);
    invalidateSpecCache();
    expect(() => renameParam('stats_portal', 'statsFor', 'code', 'shortCode', true)).toThrow(/param-missing: "istats_portal.statsFor" takes its parameters from stats_sig \(a signature type\); rename the parameter there — a rename made on stats_sig reaches/);
  });

  it('a field rename after a method rename still names the consumer calling the former verb, and one still writing a renamed type', () => {
    linkShort();
    const dry = renameField('link_stats', 'lastHitAt', 'lastSeenAt', true);
    const portal = dry.publishedIn.find((u) => u.publicName === 'stats-api');
    expect(portal).toMatchObject({ members: ['statsFor'], formerMembers: { statsFor: ['getStats'] } });
    // The dashboard's call still says getStats: it no longer resolves, and it still breaks on the field.
    const stale = dashboard([{ publicName: 'stats-api', kind: 'component', members: ['getStats'], specs: ['stats_client'] }]);
    expect(narrowedToUses(stale, dry.publishedIn)?.uses).toEqual([{ publicName: 'stats-api', kind: 'component', members: ['getStats'], specs: ['stats_client'] }]);
    // A consumer whose reference to a renamed type no longer binds (broken) is kept under its former name.
    const type = dry.publishedIn.find((u) => u.publicName === 'link_stats')!;
    const broken = dashboard([], ['link_stats_v1']);
    expect(narrowedToUses(broken, [{ ...type, formerNames: ['link_stats_v1'] }])?.uses).toEqual([{ publicName: 'link_stats_v1', kind: 'type', members: ['type'] }]);
  });
});

// ---------------------------------------------------------------------------
// 5. `member add <git url>` accepted a producer exported at audience
//    `project`, and every later message said its names were "gone".
// ---------------------------------------------------------------------------

describe('5. a git member exported too narrowly is refused at add, and named at pin', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0).reverse()) {
      try { c(); } catch { /* windows file locks */ }
    }
  });

  /** The ledger, its one Portal exported at audience `project` only, served from a local bare repository. */
  function narrowLedger(): { url: string; commit: string; base: string } {
    cleanups.push(isolateGlobals(cleanups));
    const base = stage8TempDir(cleanups, 'wairon-r7-narrow-');
    const work = path.join(base, 'ledger-work');
    writeLedger(work);
    stage8System(work, 'Ledger', [{ from: 'books', component: 'ledger-portal', audience: 'project' }]);
    const repo = bareFrom(cleanups, work, 'ledger');
    return { url: repo.url, commit: repo.commit, base };
  }

  it('member add refuses it, naming the audience it is exported at and the one a git member is read at', () => {
    const { url, commit, base } = narrowLedger();
    const shop = path.join(base, 'shop');
    stage8ProjectYaml(shop, { id: 'shop', name: 'Shop' });
    stage8System(shop, 'Shop');
    setProjectRoot(shop);
    invalidateSpecCache();
    expect(() => createMember('ledger', `${url}#${commit}`)).toThrow(/Refusing to add the git member "ledger": the producer exports its 1 name\(s\) \("ledger-portal"\) to `project` only, and a git member is read from outside its family, at `instance`/);
    expect(fs.readFileSync(path.join(shop, '.wai', 'project.yaml'), 'utf8')).not.toContain('ledger');
  });

  it('a pin of such a member says the name is exported narrower, never gone', () => {
    const { url, commit, base } = narrowLedger();
    const shop = path.join(base, 'shop');
    writeShop(shop, { members: { ledger: `${url}#${commit}` } });
    setProjectRoot(shop);
    invalidateSpecCache();
    const [pin] = pinExternals();
    expect(pin.detail).toContain('the producer exports "ledger-portal" to `project` only, and this project reads it at `instance`');
    expect(pin.detail).toContain('nothing is gone');
  });
});

// ---------------------------------------------------------------------------
// 3. The surface changelog lost changes: a field rename vanished once its
//    type's public entry changed, a type reshaped only by an embedded rename
//    had no row, the consumer's own wire shape moving through a pinned type was
//    "no change", and a renamed method read "(its signature is unchanged)"
//    beside a renamed parameter and a changed answer type.
// ---------------------------------------------------------------------------

const snap = (over: Partial<SurfaceSnapshot>): SurfaceSnapshot => SurfaceSnapshotSchema.parse({ projectName: 'geo', origin: 'generated', generatedAt: NOW, interfaces: [], types: [], ...over });

describe('3. the surface changelog keeps every change', () => {
  const tileV1 = { id: 'tile_coord', name: 'TileCoord', kind: 'value-object', fields: [{ name: 'x', type: 'int' }, { name: 'y', type: 'int' }, { name: 'zoom', type: 'int' }] };

  it('a field rename keeps its row beside a traced type rename', () => {
    const tileV2 = { id: 'tile', name: 'Tile', kind: 'value-object', formerly: ['tile_coord'], fields: [{ name: 'x', type: 'int' }, { name: 'y', type: 'int' }, { name: 'z', type: 'int', formerly: ['zoom'] }] };
    const rows = surfaceChanges(snap({ types: [tileV2], exportedTypes: [{ id: 'tile', type: 'tile', audience: 'external' }] }), snap({ types: [tileV1], exportedTypes: [{ id: 'tile_coord', type: 'tile_coord', audience: 'external' }] }));
    expect(rows.map((r) => `${r.kind} ${r.name}${r.member ? `.${r.member}` : ''}: ${r.detail}`)).toEqual([
      'renamed tile: type renamed from "tile_coord"',
      'renamed tile.z: field "zoom" renamed to "z"',
    ]);
  });

  it('a public-name change of the same definition is a rename, never removed + added, and keeps its field rows', () => {
    const tileV2 = { ...tileV1, fields: [{ name: 'x', type: 'int' }, { name: 'y', type: 'int' }, { name: 'z', type: 'int', formerly: ['zoom'] }] };
    const rows = surfaceChanges(snap({ types: [tileV2], exportedTypes: [{ id: 'tile', type: 'tile_coord', audience: 'external' }] }), snap({ types: [tileV1], exportedTypes: [{ id: 'tile_coord', type: 'tile_coord', audience: 'external' }] }));
    expect(rows.map((r) => `${r.kind} ${r.name}${r.member ? `.${r.member}` : ''}`)).toEqual(['renamed tile', 'renamed tile.z']);
  });

  it('a project\'s own API answering another project\'s type moves when the re-pin reshapes that type', () => {
    // The consumer's own Portal, answering list<geo::tile_coord> — and after the re-pin list<geo::tile>.
    const portal = (returns: string) => ({
      id: 'route_portal', name: 'Routes', audience: 'project', type: 'REST', component: 'route_portal',
      methods: [{ name: 'tilesFor', description: 'The tiles of a route.', signature: `tilesFor(routeId: string): ${returns}`, returns, params: [{ name: 'routeId', type: 'string' }] }],
    });
    const pinV1 = snap({ types: [tileV1], exportedTypes: [{ id: 'tile_coord', type: 'tile_coord', audience: 'external' }] });
    const pinV2 = snap({
      types: [{ id: 'tile', name: 'Tile', kind: 'value-object', formerly: ['tile_coord'], fields: [{ name: 'x', type: 'int' }, { name: 'y', type: 'int' }, { name: 'z', type: 'int', formerly: ['zoom'] }] }],
      exportedTypes: [{ id: 'tile', type: 'tile', audience: 'external' }],
    });
    const before = withForeignTypes(snap({ projectName: 'route-planner', interfaces: [portal('list<geo::tile_coord>')] }), new Map([['geo', pinV1]]));
    const after = withForeignTypes(snap({ projectName: 'route-planner', interfaces: [portal('list<geo::tile>')] }), new Map([['geo', pinV2]]));
    expect(after.types.map((t) => t.id)).toEqual(['geo::tile']);
    const rows = surfaceChanges(after, before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'changed', name: 'route_portal', member: 'tilesFor' });
    expect(rows[0].detail).toBe('signature reads the same, but it names renamed types: renamed type "geo::tile_coord" → "geo::tile"; renamed field "geo::tile.zoom" → "z"');
  });
});

describe('3d. externals status says what moved with a renamed method', () => {
  it('a renamed method whose parameter and answer type moved is never "(its signature is unchanged)"', () => {
    const root = tempDir();
    const geo = path.join(root, 'geo');
    const studio = path.join(root, 'route-planner');
    materialize(geo, geoKit());
    fs.writeFileSync(path.join(geo, '.wai', 'project.yaml'), projectYaml('geo-kit'));
    const planner = routePlanner('stops: Coordinate[]');
    planner.components = planner.components!.map((c) => ({ ...c, dependsOn: ['geo::distance_library'] }));
    planner.implementations = planner.implementations!.map((impl) => ({
      ...impl,
      methods: [{ name: 'sequence', detail: 'intent', intent: 'Orders the stops nearest-neighbour first by great-circle distance and answers the number of legs.', calls: ['geo::distance_library.haversine'] }],
    }));
    materialize(studio, planner);
    fs.writeFileSync(path.join(studio, '.wai', 'project.yaml'), projectYaml('route-planner', { externals: { geo: { source: { path: '../geo' } } } }));
    setProjectRoot(studio);
    invalidateSpecCache();
    pinExternals();
    // GeoKit renames haversine → greatCircle, its `from` → `origin`, and the coordinate's lat → latitude.
    const renamed = geoKit();
    renamed.interfaces = renamed.interfaces!.map((i) => ({
      ...i,
      methods: [{ name: 'greatCircle', previousNames: ['haversine'], description: 'Great-circle distance in km.', params: [{ name: 'origin', type: 'coordinate', previousNames: ['from'] }, { name: 'to', type: 'coordinate' }], returns: 'float', effect: 'none' }],
    }));
    renamed.types = renamed.types!.map((t) => ({ ...t, fields: [{ name: 'latitude', type: 'float', previousNames: ['lat'] }, { name: 'lon', type: 'float' }] }));
    materialize(geo, renamed);
    invalidateSpecCache();
    const [status] = getExternalsStatus(true);
    const use = status.uses.find((u) => u.member === 'haversine');
    expect(use?.state).toBe('renamed');
    expect(use?.detail).toContain('parameter "from" renamed to "origin"');
    expect(use?.detail).toContain('field "coordinate.lat" renamed to "latitude"');
    expect(use?.detail).not.toContain('its signature is unchanged');
  });
});

// ---------------------------------------------------------------------------
// 4. OpenAPI: a single object body was wrapped under its parameter's name
//    (`{"input": …}`), every POST answered 201, and a member project's types
//    were "Unresolved" under a ✔.
// ---------------------------------------------------------------------------

describe('4. the OpenAPI codec', () => {
  const habits = (methods: Record<string, unknown>[]): SurfaceSnapshot => snap({
    projectName: 'habitly',
    interfaces: [{ id: 'habit_portal', name: 'Habits', audience: 'project', type: 'REST', component: 'habit_portal', methods } as never],
    types: [
      { id: 'new_habit', name: 'NewHabit', kind: 'value-object', fields: [{ name: 'name', type: 'string' }, { name: 'cadence', type: 'string' }] },
      { id: 'habit', name: 'Habit', kind: 'entity', fields: [{ name: 'id', type: 'string' }, { name: 'name', type: 'string' }] },
      { id: 'habit_id', name: 'HabitId', kind: 'value-object', fields: [], holds: 'string' },
    ],
  });
  const method = (name: string, verb: string, path: string, params: { name: string; type: string }[], extra: Record<string, unknown> = {}) => ({
    name, description: name, signature: `${name}()`, returns: 'habit', params, endpoint: { transport: 'HTTP', method: verb, path }, ...extra,
  });
  const doc = (s: SurfaceSnapshot): any => JSON.parse(toOpenApiSet(s)[0].document);

  it('sends a single object param as the bare body, and wraps only several', () => {
    const d = doc(habits([
      method('createHabit', 'POST', '/v1/habits', [{ name: 'input', type: 'new_habit' }]),
      method('rename', 'PUT', '/v1/habits/{habitId}', [{ name: 'habitId', type: 'string' }, { name: 'name', type: 'string' }]),
      method('retag', 'PATCH', '/v1/habits/{habitId}/tags', [{ name: 'habitId', type: 'string' }, { name: 'id', type: 'habit_id' }]),
    ]));
    expect(d.paths['/v1/habits'].post.requestBody.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/new_habit' });
    expect(d.paths['/v1/habits'].post['x-wairon-body-param']).toBe('input');
    // A scalar keeps its property: only an object can be the body itself.
    expect(d.paths['/v1/habits/{habitId}'].put.requestBody.content['application/json'].schema.properties).toHaveProperty('name');
    expect(d.paths['/v1/habits/{habitId}/tags'].patch.requestBody.content['application/json'].schema.properties).toHaveProperty('id');
  });

  it('round-trips the bare body back into the one param it was', () => {
    const [spec] = toOpenApiSet(habits([method('createHabit', 'POST', '/v1/habits', [{ name: 'input', type: 'new_habit' }])]));
    const back = fromOpenApi(spec.document, 'habitly');
    expect(back.interfaces[0].methods[0].params).toEqual([{ name: 'input', type: 'new_habit' }]);
  });

  it('answers 201 only for a POST that creates', () => {
    const d = doc(habits([
      method('createHabit', 'POST', '/v1/habits', [{ name: 'input', type: 'new_habit' }]),
      method('signUp', 'POST', '/v1/auth/signup', [{ name: 'credentials', type: 'new_habit' }]),
      method('logIn', 'POST', '/v1/auth/login', [{ name: 'credentials', type: 'new_habit' }]),
      method('archiveHabit', 'POST', '/v1/habits/{habitId}/archive', [{ name: 'habitId', type: 'string' }]),
      method('cancel', 'POST', '/orders/{orderId}/cancel', [{ name: 'orderId', type: 'string' }], { effect: 'write' }),
      method('enrol', 'POST', '/enrolments', [{ name: 'input', type: 'new_habit' }], { effect: 'lifecycle' }),
      method('addUp', 'POST', '/sum', [{ name: 'input', type: 'new_habit' }], { effect: 'none' }),
    ]));
    const code = (p: string): string => Object.keys(d.paths[p].post.responses)[0];
    expect(code('/v1/habits')).toBe('201');
    expect(code('/v1/auth/signup')).toBe('201');
    expect(code('/v1/auth/login')).toBe('200');
    expect(code('/v1/habits/{habitId}/archive')).toBe('200');
    expect(code('/orders/{orderId}/cancel')).toBe('200');
    expect(code('/enrolments')).toBe('201');
    expect(code('/sum')).toBe('200');
  });

  it('resolves a type another project publishes by its public name, from the context', () => {
    const contracts = snap({
      projectName: 'contracts',
      types: [{ id: 'order_request', name: 'OrderRequest', kind: 'value-object', fields: [{ name: 'sku', type: 'string' }] }],
      exportedTypes: [{ id: 'create_order_request', type: 'order_request', audience: 'project' }],
    });
    const s = snap({ projectName: 'gateway', interfaces: [{ id: 'api', name: 'API', audience: 'project', type: 'REST', component: 'api',
      methods: [method('placeOrder', 'POST', '/orders', [{ name: 'request', type: 'shared::create_order_request' }], { returns: 'string' })] } as never] });
    const d = JSON.parse(toOpenApiSet(s, { externals: new Map([['shared', contracts]]) })[0].document);
    expect(d.paths['/orders'].post.requestBody.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/shared.order_request' });
    expect(Object.keys(d.components.schemas)).toEqual(['shared.order_request']);
  });
});
