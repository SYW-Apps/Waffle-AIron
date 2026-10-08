import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as yaml from 'js-yaml';
import type { FixtureTree } from '../rules-matrix/harness';
import { createTrialSandbox, countCode, gitInit, readFile, transcript, writeFile, type TrialSandbox } from './trials-helpers';
import { round7 } from '../rules-matrix/families/conformance-binding.fixtures';
import { geoKit, projectYaml } from '../helpers/conformance-r6-trees';

// ---------------------------------------------------------------------------
// Round-7 user trials — surfaces, externals, binding modules, rename break
// reports and the OpenAPI codec, replayed against the BUILT CLI:
//   1. binding modules: a member declared under an alias other than its id
//      was "not compared … pin it" (a pin a member cannot have); a types-only
//      library was "reach no other project"; a CommonJS binding passed unread.
//   2. a parameter renamed on the method a published Portal verb forwards
//      named no export; asked on the Portal it was refused.
//   3. the consumer's own HTTP answer reshaped by a re-pin was "no change".
//   4. a member project's types were "Unresolved" under a ✔; a single object
//      body was wrapped under its name; every POST answered 201.
//   5. `member add <git url>` accepted a producer exported at `project`.
// ---------------------------------------------------------------------------

let sb: TrialSandbox;
let seq = 0;
const fresh = (tree: FixtureTree): string => sb.materialize(`p${++seq}`, tree);

beforeAll(() => { sb = createTrialSandbox('r7surf'); });
afterAll(async () => { await sb?.cleanup(); });

/** Every spec file's text under a project's .wai/specs. */
function specTexts(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const p = path.join(at, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(path.join(dir, '.wai', 'specs'));
  return out;
}

/** A project written from a fixture tree into `dir`, its configuration given. */
function writeProject(dir: string, tree: FixtureTree, config: string): void {
  const at = sb.materialize(`tmp${++seq}`, { ...tree, files: { ...(tree.files ?? {}), '.wai/project.yaml': config } });
  fs.cpSync(at, dir, { recursive: true });
  fs.rmSync(at, { recursive: true, force: true });
}

describe('1. binding modules (platform top-2, lib-and-app R7-9/R7-10, solo-app)', () => {
  it('a binding into a member declared as `geo` (its id `geokit`) is compared with what the member exports now — never "pin it"', async () => {
    const r = await sb.run(['validate'], fresh(round7.aliasedMember.tree));
    expect(r.all, transcript(r)).toMatch(/\[BINDING_DRIFT\][^\n]*geo::tiles as its member project exports it now[^\n]*parameter "zoom" of "tileAt" was renamed to "z"/);
    expect(r.all).not.toContain('wairon externals pin');
    expect(countCode(r.all, 'BINDING_UNREAD')).toBe(0);
  });

  it('control — the member binding following the member\'s names draws nothing', async () => {
    const r = await sb.run(['validate'], fresh(round7.aliasedMemberControl.tree));
    expect(countCode(r.all, 'BINDING_DRIFT'), transcript(r)).toBe(0);
    expect(countCode(r.all, 'BINDING_UNREAD'), transcript(r)).toBe(0);
  });

  it('a binding to a types-only library is reached through the types the contract names', async () => {
    const r = await sb.run(['validate'], fresh(round7.typesOnly.tree));
    expect(r.all, transcript(r)).toMatch(/\[BINDING_DRIFT\][^\n]*"TileKey" no longer matches geokit::tile_key as pinned — field "zoom" was renamed to "z"/);
  });

  it('a CommonJS binding is compared; one that only re-exports a native addon is reported unread, naming the form', async () => {
    const cjs = await sb.run(['validate'], fresh(round7.commonJs.tree));
    expect(cjs.all, transcript(cjs)).toMatch(/\[BINDING_DRIFT\][^\n]*"tileFor" was renamed to "tileAt"/);
    const unread = await sb.run(['validate'], fresh(round7.requireOnly.tree));
    expect(unread.all, transcript(unread)).toMatch(/\[BINDING_UNREAD\][^\n]*`module\.exports = require\(…\)`/);
  });

  it('a verb the producer removed, still declared as a free function, is named from the pin\'s retired list', async () => {
    const r = await sb.run(['validate'], fresh(round7.removedVerb.tree));
    expect(r.all, transcript(r)).toMatch(/\[BINDING_DRIFT\][^\n]*"vincenty_distance" was removed from geokit::tiles/);
  });
});

/** LinkShort: `hit_orchestrator.getStats(code)`, forwarded by the published stats Portal's verb `statsFor`. */
function linkShort(): FixtureTree {
  return {
    system: {
      name: 'LinkShort', vision: 'Short links and their hit statistics.', targetLanguage: 'TypeScript',
      publicInterfaces: [{ from: 'links', component: 'stats_portal', as: 'stats-api' }],
    },
    subsystems: [{ id: 'links', description: 'Short links and hits.', publicInterfaces: [{ component: 'stats_portal', details: 'The stats API' }] }],
    components: [
      { id: 'hit_orchestrator', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Reads the statistics of a link.' },
      {
        id: 'stats_portal', componentType: 'Portal', transport: 'HTTP', description: 'The statistics API.', dependsOn: ['hit_orchestrator'],
        invokedBy: { kind: 'entry', caller: 'The dashboard of the marketing team, over HTTP' },
      },
    ],
    interfaces: [
      { id: 'ihit_orchestrator', component: 'hit_orchestrator', methods: [{ name: 'getStats', description: 'The hits of a link.', params: [{ name: 'code', type: 'string' }], returns: 'int', effect: 'none' }] },
      { id: 'istats_portal', component: 'stats_portal', methods: [{ name: 'statsFor', description: 'The hits of a link.', signatureFrom: 'hit_orchestrator.getStats', endpoint: { transport: 'HTTP', method: 'GET', path: '/stats/{code}' } }] },
    ],
    implementations: [
      { id: 'hit_orchestrator_impl', contract: 'ihit_orchestrator', methods: [{ name: 'getStats', detail: 'intent', intent: 'Counts the hits recorded for the code; an unknown code answers zero.' }] },
      { id: 'stats_portal_impl', contract: 'istats_portal', methods: [{ name: 'statsFor', narrative: [
        { stepNumber: 1, description: 'Ask the orchestrator', type: 'call', targetComponent: 'hit_orchestrator', targetMethod: 'getStats' },
        { stepNumber: 2, description: 'Answer the hits', type: 'return', outcome: 'success' },
      ] }] },
    ],
    files: { '.wai/project.yaml': projectYaml('linkshort') },
  };
}

describe('2. rename break reports follow signatureFrom (tinkerer N6, platform top-3)', () => {
  it('the parameter dry run names the Portal export forwarding the method', async () => {
    const dir = fresh(linkShort());
    const r = await sb.run(['method', 'rename-param', 'hit_orchestrator', 'getStats', 'code', 'shortCode', '--dry-run'], dir);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toContain('istats_portal.statsFor: {code} -> {shortCode}');
    expect(r.all).toMatch(/Published as: stats-api, stats_portal/);
  });

  it('asked on the Portal verb, the rename is made on its source and says so', async () => {
    const dir = fresh(linkShort());
    const r = await sb.run(['method', 'rename-param', 'stats_portal', 'statsFor', 'code', 'shortCode'], dir);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toContain('"stats_portal.statsFor" takes its signature from "hit_orchestrator.getStats"');
    const specs = specTexts(dir);
    expect(specs.find((t) => t.includes('id: ihit_orchestrator'))).toContain('name: shortCode');
    expect(specs.find((t) => t.includes('id: istats_portal'))).toContain('/stats/{shortCode}');
  });
});

/** RoutePlanner: its own HTTP API answers GeoKit's coordinate type as is. */
function routeApi(): FixtureTree {
  return {
    system: { name: 'RoutePlanner', vision: 'Plans delivery routes over GeoKit.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'routing', description: 'Route planning.' }],
    components: [{
      id: 'route_portal', componentType: 'Portal', transport: 'HTTP', description: 'The route API the web client calls.',
      invokedBy: { kind: 'entry', caller: 'The planner web client, over HTTP' },
    }],
    interfaces: [{
      id: 'iroute_portal', component: 'route_portal',
      methods: [{ name: 'stopsOf', description: 'The stops of a route.', params: [{ name: 'routeId', type: 'string' }], returns: 'list<geo::coordinate>', effect: 'read', endpoint: { transport: 'HTTP', method: 'GET', path: '/routes/{routeId}/stops' } }],
    }],
    implementations: [{ id: 'route_portal_impl', contract: 'iroute_portal', methods: [{ name: 'stopsOf', narrative: [{ stepNumber: 1, description: 'Answer the stops of the route in visiting order', type: 'return', outcome: 'success' }] }] }],
  };
}

describe('3. the consumer\'s own API reshaped by a re-pin is a change of its own surface (lib-and-app R6-23b / R7-18)', () => {
  it('`surface diff` names the Portal verb and the renamed field it now answers with', async () => {
    const folder = sb.project('reshape');
    const geo = path.join(folder, 'geo');
    const planner = path.join(folder, 'route-planner');
    writeProject(geo, geoKit(), projectYaml('geo-kit'));
    writeProject(planner, routeApi(), projectYaml('route-planner', { externals: { geo: { source: { path: '../geo' } } } }));
    const pin = await sb.run(['externals', 'pin', 'geo'], planner);
    expect(pin.code, transcript(pin)).toBe(0);
    const lock = await sb.run(['lock', '--yes'], planner);
    expect(lock.code, transcript(lock)).toBe(0);
    gitInit(planner);
    const quiet = await sb.run(['surface', 'diff', '--json'], planner);
    expect((JSON.parse(quiet.stdout) as { changes: unknown[] }).changes, transcript(quiet)).toEqual([]);
    // GeoKit renames the coordinate's `lat`; the planner re-pins.
    const rename = await sb.run(['type', 'rename-field', 'coordinate', 'lat', 'latitude'], geo);
    expect(rename.code, transcript(rename)).toBe(0);
    const repin = await sb.run(['externals', 'pin', 'geo'], planner);
    expect(repin.code, transcript(repin)).toBe(0);
    const diff = await sb.run(['surface', 'diff', '--json'], planner);
    expect(diff.code, transcript(diff)).toBe(0);
    const changes = (JSON.parse(diff.stdout) as { changes: { kind: string; name: string; member?: string; detail: string }[] }).changes;
    // Round 7: "no change — every exported name, method and signature is as it was."
    expect(changes).toContainEqual(expect.objectContaining({ kind: 'changed', name: 'route_portal', member: 'stopsOf' }));
    expect(changes.find((c) => c.member === 'stopsOf')?.detail).toContain('renamed field "geo::coordinate.lat" → "latitude"');
  });
});

describe('4. the OpenAPI export (platform, solo-app)', () => {
  /** A gateway whose HTTP Portal takes and answers types of its member `shared` (project id `contracts`). */
  function gateway(exportOrder: boolean): string {
    const dir = sb.project(`gateway-${exportOrder ? 'ok' : 'unexported'}`);
    writeProject(dir, {
      system: { name: 'Gateway', vision: 'The shop API gateway.', targetLanguage: 'TypeScript' },
      subsystems: [{ id: 'edge', description: 'The public API.' }],
      components: [{ id: 'shop_portal', componentType: 'Portal', transport: 'HTTP', description: 'The shop API.', invokedBy: { kind: 'entry', caller: 'The shop web client, over HTTP' } }],
      interfaces: [{ id: 'ishop_portal', component: 'shop_portal', methods: [
        { name: 'placeOrder', description: 'Place an order.', params: [{ name: 'request', type: 'shared::order_request' }], returns: 'shared::order_view', effect: 'write', endpoint: { transport: 'HTTP', method: 'POST', path: '/orders' } },
        { name: 'cancelOrder', description: 'Cancel an order.', params: [{ name: 'orderId', type: 'string' }], returns: 'shared::order_view', effect: 'write', endpoint: { transport: 'HTTP', method: 'POST', path: '/orders/{orderId}/cancel' } },
      ] }],
      implementations: [{ id: 'shop_portal_impl', contract: 'ishop_portal', methods: [
        { name: 'placeOrder', narrative: [{ stepNumber: 1, description: 'Accept the order and answer its view', type: 'return', outcome: 'success' }] },
        { name: 'cancelOrder', narrative: [{ stepNumber: 1, description: 'Cancel the order and answer its view', type: 'return', outcome: 'success' }] },
      ] }],
    }, projectYaml('gateway', { members: { shared: 'libs/contracts' } }));
    writeProject(path.join(dir, 'libs', 'contracts'), {
      system: {
        name: 'Contracts', vision: 'The shared order contracts.', targetLanguage: 'TypeScript',
        publicInterfaces: exportOrder ? [{ from: 'orders', typeDef: 'order_request', audience: 'project' }, { from: 'orders', typeDef: 'order_view', audience: 'project' }] : [],
      },
      subsystems: [{ id: 'orders', description: 'Order shapes.', publicInterfaces: exportOrder ? [{ typeDef: 'order_request' }, { typeDef: 'order_view' }] : [] }],
      types: [
        { id: 'order_request', kind: 'value-object', subsystem: 'orders', name: 'OrderRequest', description: 'What a client orders.', fields: [{ name: 'sku', type: 'string' }, { name: 'quantity', type: 'int' }] },
        { id: 'order_view', kind: 'value-object', subsystem: 'orders', name: 'OrderView', description: 'An order as a client sees it.', fields: [{ name: 'orderId', type: 'string' }, { name: 'status', type: 'string' }] },
      ],
    }, projectYaml('contracts'));
    return dir;
  }

  it('a member project\'s types are components; the one object param is the bare body; 201 only for the creating POST', async () => {
    const dir = gateway(true);
    const r = await sb.run(['surface', 'export', '--format', 'openapi', '--portal', 'shop_portal'], dir);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.stdout).not.toContain('Unresolved type');
    const doc = JSON.parse(r.stdout) as { paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: unknown }> }; responses: Record<string, unknown> }>>; components: { schemas: Record<string, unknown> } };
    expect(Object.keys(doc.components.schemas).sort()).toEqual(['shared.order_request', 'shared.order_view']);
    expect(doc.paths['/orders'].post.requestBody!.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/shared.order_request' });
    expect(Object.keys(doc.paths['/orders'].post.responses)).toEqual(['201']);
    expect(Object.keys(doc.paths['/orders/{orderId}/cancel'].post.responses)).toEqual(['200']);
    expect(r.stderr).toMatch(/✔\s+Projected surface/);
  });

  it('a type no export resolves is a warning naming it, never a ✔', async () => {
    const r = await sb.run(['surface', 'export', '--format', 'openapi', '--portal', 'shop_portal'], gateway(false));
    expect(r.stderr, transcript(r)).toMatch(/The document has no schema for 2 type\(s\) it names: shared::order_request, shared::order_view/);
    expect(r.stderr).not.toMatch(/✔\s+Projected surface/);
  });
});

describe('5. `member add <git url>` refuses a producer exported too narrowly (platform)', () => {
  it('refused with the audience reason, nothing written', async () => {
    const folder = sb.project('narrow');
    const work = path.join(folder, 'contracts-work');
    const tree = geoKit();
    (tree.system as { publicInterfaces: Record<string, unknown>[] }).publicInterfaces = [{ from: 'geometry', typeDef: 'coordinate', audience: 'project' }];
    writeProject(work, tree, projectYaml('geo-kit'));
    gitInit(work);
    const bare = path.join(folder, 'geo.git');
    execFileSync('git', ['clone', '-q', '--bare', work, bare], { stdio: 'ignore' });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work }).toString().trim();
    const app = path.join(folder, 'app');
    writeProject(app, { system: { name: 'App', vision: 'An app on GeoKit.', targetLanguage: 'TypeScript' } }, projectYaml('app'));
    const url = `file:///${bare.replace(/\\/g, '/').replace(/^\//, '')}`;
    const r = await sb.run(['member', 'add', 'geo', `${url}#${commit}`], app);
    expect(r.code, transcript(r)).not.toBe(0);
    expect(r.all).toMatch(/the producer exports its 1 name\(s\) \("coordinate"\) to `project` only, and a git member is read from outside its family, at `instance`/);
    expect((yaml.load(readFile(app, '.wai/project.yaml')) as { members?: unknown }).members).toBeUndefined();
  });
});

// Keep writeFile referenced for journeys that patch a file in place.
void writeFile;
