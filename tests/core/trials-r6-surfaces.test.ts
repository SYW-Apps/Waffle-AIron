import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fromOpenApi, toOpenApiSet } from '../../src/core/openapi.js';
import { diff, projectOwnSurface } from '../../src/core/surfaces.js';
import { runSurface } from '../../src/commands/surface.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { materializeFixtureProject, runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';
import type { SurfaceSnapshot } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Round-6 trials (solo-app, platform, lib-and-app R6-23 + R6-12, tinkerer):
// two verbs bound to one route passed validate and the OpenAPI export kept
// one of them; an L0 export entry over a subsystem publishing nothing passed
// validate, exported "✔ 0 interface(s)" and diffed as "no change"; the OpenAPI
// stdout carried a status line; `scheme: custom` invented an Authorization
// header; every operation answered 200 only; `surface diff --against` an
// OpenAPI file dumped a raw schema error array.
// ---------------------------------------------------------------------------

const now = '2026-10-08T00:00:00.000Z';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function snapshot(methods: any[], auth?: any): SurfaceSnapshot {
  return {
    projectName: 'shop', origin: 'generated', generatedAt: now,
    interfaces: [{ id: 'order_portal', name: 'Orders API', audience: 'project', type: 'REST', component: 'order_portal', basePath: '/v1', ...(auth ? { auth } : {}), methods }],
    types: [
      { id: 'order', name: 'Order', kind: 'value-object', fields: [{ name: 'id', type: 'string' }] },
      { id: 'order_error', name: 'OrderError', kind: 'enum', fields: [], values: [{ name: 'not_found' }, { name: 'invalid' }] },
    ],
  } as unknown as SurfaceSnapshot;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m = (name: string, verb: string, p: string, returns = 'order', params: any[] = [{ name: 'orderId', type: 'string' }]) =>
  ({ name, description: name, signature: `${name}()`, returns, params, endpoint: { transport: 'HTTP', method: verb, path: p } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc = (s: SurfaceSnapshot): any => JSON.parse(toOpenApiSet(s)[0].document);

describe('item 5 — a duplicate route is refused by the OpenAPI export, never dropped', () => {
  it('two operations on GET /orders/{orderId} — :id and {orderId} alike — are refused naming both', () => {
    const s = snapshot([m('getOrder', 'GET', '/orders/{orderId}'), m('getOrderAgain', 'GET', '/orders/:id', 'order', [{ name: 'id', type: 'string' }])]);
    expect(() => toOpenApiSet(s)).toThrow(/"getOrder" and "getOrderAgain" both bind GET \/v1\/orders\/\{id\}.*Nothing was written/s);
  });

  it('the same path under two verbs is two operations', () => {
    const d = doc(snapshot([m('getOrder', 'GET', '/orders/{orderId}'), m('cancelOrder', 'DELETE', '/orders/{orderId}', 'void')]));
    expect(Object.keys(d.paths['/v1/orders/{orderId}']).sort()).toEqual(['delete', 'get']);
  });

  it('ENDPOINT_ROUTE_DUPLICATE fires in validate for the trial shape', () => {
    const run = runRuleFixture({
      code: 'ENDPOINT_ROUTE_DUPLICATE', expectFire: true, scenario: 'Two verbs of the order portal on GET /orders/{orderId}.',
      tree: {
        system: { name: 'Shop', vision: 'An online shop.' },
        subsystems: [{ id: 'orders', description: 'Orders.' }],
        components: [{ id: 'order_portal', componentType: 'Portal', transport: 'HTTP', basePath: '/v1', invokedBy: { kind: 'entry', caller: 'Browsers of the shop customers, over HTTPS' }, description: 'The order API.' }],
        interfaces: [{ id: 'iorder_portal', component: 'order_portal', methods: [
          { name: 'getOrder', description: 'Read.', params: [{ name: 'orderId', type: 'string' }], returns: 'string', endpoint: { transport: 'HTTP', method: 'GET', path: '/orders/{orderId}' } },
          { name: 'getOrderAgain', description: 'Read again.', params: [{ name: 'orderId', type: 'string' }], returns: 'string', endpoint: { transport: 'HTTP', method: 'GET', path: '/orders/{orderId}' } },
        ] }],
      },
    });
    expect(run.matching).toHaveLength(1);
    expect(run.matching[0].severity).toBe('error');
    expect(run.matching[0].message).toMatch(/"getOrder".*"getOrderAgain"/);
  });
});

describe('item 9 — success codes and the failure of a result<T, E>', () => {
  it('GET answers 200, POST 201, a method returning nothing 204 with no content', () => {
    const d = doc(snapshot([m('getOrder', 'GET', '/orders/{orderId}'), m('placeOrder', 'POST', '/orders', 'order', []), m('cancelOrder', 'DELETE', '/orders/{orderId}', 'async void')]));
    expect(Object.keys(d.paths['/v1/orders/{orderId}'].get.responses)).toEqual(['200']);
    expect(Object.keys(d.paths['/v1/orders'].post.responses)).toEqual(['201']);
    expect(d.paths['/v1/orders/{orderId}'].delete.responses['204']).toEqual({ description: 'Success, with no content' });
  });

  it('a result<T, E> answers T on success and E as the default error response, and round-trips', () => {
    const s = snapshot([m('getOrder', 'GET', '/orders/{orderId}', 'result<order, order_error>')]);
    const op = doc(s).paths['/v1/orders/{orderId}'].get;
    expect(op.responses['200'].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/order' });
    expect(op.responses.default.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/order_error' });
    const back = fromOpenApi(toOpenApiSet(s)[0].document, 'shop').interfaces[0].methods[0];
    expect(back.returns).toBe('result<order, order_error>');
  });

  it('an import reads a 204 as void and any 2xx as the success', () => {
    const back = fromOpenApi(toOpenApiSet(snapshot([m('cancelOrder', 'DELETE', '/orders/{orderId}', 'void'), m('placeOrder', 'POST', '/orders', 'order', [])]))[0].document, 'shop').interfaces[0].methods;
    expect(back.find((x) => x.name === 'cancelOrder')!.returns).toBe('void');
    expect(back.find((x) => x.name === 'placeOrder')!.returns).toBe('order');
  });
});

describe('item 9 — a custom auth scheme never invents an Authorization header', () => {
  it('naming no header: an http scheme `custom`, no apiKey named Authorization', () => {
    const d = doc(snapshot([m('getOrder', 'GET', '/orders/{orderId}')], { scheme: 'custom', description: 'PSP webhook signature (HMAC)' }));
    const scheme = Object.values(d.components.securitySchemes)[0] as Record<string, unknown>;
    expect(scheme).toEqual({ type: 'http', scheme: 'custom', description: 'PSP webhook signature (HMAC)' });
    expect(JSON.stringify(d)).not.toContain('"Authorization"');
    expect(fromOpenApi(toOpenApiSet(snapshot([m('getOrder', 'GET', '/orders/{orderId}')], { scheme: 'custom', description: 'x' }))[0].document, 'shop').interfaces[0].auth)
      .toEqual({ scheme: 'custom', description: 'x' });
  });

  it('naming its header: an apiKey scheme in that header', () => {
    const d = doc(snapshot([m('getOrder', 'GET', '/orders/{orderId}')], { scheme: 'custom', name: 'Stripe-Signature' }));
    expect(Object.values(d.components.securitySchemes)[0]).toMatchObject({ type: 'apiKey', in: 'header', name: 'Stripe-Signature' });
  });
});

// ---- a materialized project: item 6 and the CLI ---------------------------

const ROUTE_PORTAL = { id: 'route_portal', componentType: 'Portal', transport: 'HTTP', invokedBy: { kind: 'entry', caller: 'Browsers of the dispatch office, over plain HTTP' }, description: 'The route API.' };
const IROUTE = { id: 'iroute_api', component: 'route_portal', methods: [{ name: 'getRoute', description: 'Read.', params: [{ name: 'routeId', type: 'string' }], returns: 'string', endpoint: { transport: 'HTTP', method: 'GET', path: '/routes/{routeId}' } }] };
function routePlanner(publicInterfaces: unknown[]): FixtureTree {
  return {
    system: { name: 'RoutePlanner', vision: 'Plans multi-stop routes.', publicInterfaces },
    subsystems: [{ id: 'routing', description: 'Routes.', publicInterfaces: [] }],
    components: [ROUTE_PORTAL], interfaces: [IROUTE],
  };
}

let root: string | null = null;
function bind(tree: FixtureTree): string {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r6-surf-')));
  materializeFixtureProject(root, tree);
  invalidateSpecCache();
  setProjectRoot(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  setProjectRoot(null);
  invalidateSpecCache();
  if (root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ } root = null; }
});

describe('item 6 — an L0 export entry over a subsystem that publishes nothing', () => {
  it('a wildcard over it is EXPORT_INVALID, naming the subsystem', () => {
    const run = runRuleFixture({ code: 'EXPORT_INVALID', expectFire: true, scenario: 'The planner exports everything routing exports; routing publishes nothing.', tree: routePlanner([{ from: 'routing', audience: 'external' }]) });
    expect(run.matching.map((i) => i.message).join('\n')).toMatch(/re-exports everything subsystem "routing" exports, but its L1 publicInterfaces publish no component and no type/);
  });

  it('`surface export` prints no ✔ for zero interfaces: it warns that nothing is published and that the gate refuses it', async () => {
    bind(routePlanner([{ from: 'routing', audience: 'external' }]));
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSurface('export', { format: 'native' });
    const text = err.join('');
    expect(text).not.toContain('✔');
    expect(text).toMatch(/0 interface\(s\), 0 type\(s\).*publishes nothing/);
    expect(text).toMatch(/The design has \d+ error\(s\) \(.*EXPORT_INVALID/);
  });

  it('`surface diff` against a saved snapshot names the new entry that publishes nothing — never "no change"', () => {
    const dir = bind(routePlanner([{ from: 'routing', audience: 'external' }]));
    const saved = path.join(dir, 'before.yaml');
    fs.writeFileSync(saved, JSON.stringify(projectOwnSurface('project')));
    const answer = diff(saved);
    expect(answer.changes).toEqual([expect.objectContaining({ kind: 'added', detail: expect.stringMatching(/publishes nothing — it re-exports everything subsystem "routing" exports/) })]);
  });

  it('`surface diff --against` an OpenAPI document is one sentence, never a raw schema error array', () => {
    const dir = bind(routePlanner([]));
    const openapi = path.join(dir, 'api.json');
    fs.writeFileSync(openapi, JSON.stringify({ openapi: '3.1.0', info: { title: 'x', version: '1' }, paths: {} }));
    expect(() => diff(openapi)).toThrow(/is an OpenAPI document; --against compares with a native surface snapshot/);
    const junk = path.join(dir, 'junk.yaml');
    fs.writeFileSync(junk, 'projectName: 5\n');
    let message = '';
    try { diff(junk); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/is not a native surface snapshot \(at .*\).*or a git revision/);
    expect(message).not.toContain('"code"');
  });
});
