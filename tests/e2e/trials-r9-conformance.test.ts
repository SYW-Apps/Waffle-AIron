import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureTree } from '../rules-matrix/harness';
import { createTrialSandbox, countCode, transcript, type TrialSandbox } from './trials-helpers';
import { routePortalTree } from '../helpers/conformance-r7-trees';
import { centralRouterTree, ROUTES_MODULE, withDial } from '../helpers/conformance-r8-trees';
import {
  analyticsRoutes,
  analyticsTree,
  implementationsOf,
  ordersTree,
  plannerTree,
  STATS_HEAD,
  statsTree,
} from '../helpers/conformance-r9-trees';

// ---------------------------------------------------------------------------
// Round-9 user trials, the code gate, against the built CLI: a record
// parameter typed any / unknown / partially (lib-and-app R9-8); hand-typed
// handles beside a member's contract types and objects bundling scalars
// (platform top-2); node:http handlers reading their parameters through URLs,
// helpers and the body (platform, tinkerer); an injection nothing takes as a
// notice (solo-app top-1); route coverage switched off by a moved table, a
// spread table or a shared one (solo-app, tinkerer); `conformance: off` said
// in validate and status (lib-and-app R9-14).
//
// Every bypass runs beside the honest shape it must leave green.
// ---------------------------------------------------------------------------

let sb: TrialSandbox;
let seq = 0;
const fresh = (tree: FixtureTree): string => sb.materialize(`p${++seq}`, tree);

beforeAll(() => { sb = createTrialSandbox('r9conf'); });
afterAll(async () => { await sb?.cleanup(); });

describe('r9 (lib-and-app R9-8): a record parameter fails closed on a type that cannot hold it', () => {
  const bypasses: Array<[string, string]> = [
    ['typed any', 'request: any'],
    ['typed unknown', 'request: unknown'],
    ['typed Record<string, unknown>', 'request: Record<string, unknown>'],
    ['an object sharing one field and smuggling a secret', 'request: { stops: unknown[]; secret: string }'],
  ];
  for (const [label, signature] of bypasses) {
    it(`\`planRoute\` taking its request ${label} → PARAM_TYPE_MISMATCH, --ci exits 1`, async () => {
      const r = await sb.run(['validate', '--ci'], fresh(plannerTree({ planRoute: signature })));
      expect(r.code, transcript(r)).toBe(1);
      expect(r.all).toMatch(/\[PARAM_TYPE_MISMATCH\][^\n]*"request" \(the code takes "request"/);
    });
  }
  it('control — the honest `planRoute(request: PlanRequest)`: no parameter finding', async () => {
    const r = await sb.run(['validate'], fresh(plannerTree()));
    for (const code of ['PARAM_TYPE_MISMATCH', 'UNREALIZED_PARAM', 'UNDECLARED_PARAM']) expect(countCode(r.all, code), transcript(r)).toBe(0);
  });
});

describe('r9 (platform top-2): hand-typed handles and a member\'s contract types', () => {
  it('`cancelOrder(req: Req, res: Res)` realizing `cancelOrder(orderId: shared::order_id, customerId: shared::customer_ref)` → both named, --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(ordersTree({ cancelOrder: 'req: Req, res: Res', body: "void res; return req.params.orderId ?? '';" })));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[UNREALIZED_PARAM\][^\n]*"orderId" \(the code takes "req"[^\n]*"customerId" \(the code takes "res"/);
  });
  it('an object bundling both parameters → both named, never one half', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(ordersTree({ cancelOrder: 'input: { orderId: string; customerId: string }', body: 'return input.orderId + input.customerId;' })));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[UNREALIZED_PARAM\][^\n]*"orderId" \(the code takes it inside the object "input"[^\n]*"customerId" \(the code takes it inside the object "input"/);
  });
  it('control — the injected handles reading both parameters off the request: no parameter finding', async () => {
    const r = await sb.run(['validate'], fresh(ordersTree({
      cancelOrder: 'req: Req, res: Res', injectedParams: ['req', 'res'],
      body: 'void res; const { orderId, customerId } = req.params; return orderId + customerId;',
    })));
    for (const code of ['UNREALIZED_PARAM', 'UNDECLARED_PARAM', 'PARAM_NAME_MISMATCH']) expect(countCode(r.all, code), transcript(r)).toBe(0);
  });
});

describe('r9 (platform, tinkerer): node:http handlers have an honest green path', () => {
  const portal = (getStats: string, acceptHit: string): string => [
    STATS_HEAD,
    'export function pathParams(req: IncomingMessage): Record<string, string> {',
    "  return { code: (req.url ?? '').split('/')[2] ?? '' };",
    '}',
    `export function getStats(req: IncomingMessage, res: ServerResponse): string { void res; ${getStats} }`,
    `export function acceptHit(req: IncomingMessage, res: ServerResponse): string { void res; ${acceptHit} }`,
    '',
  ].join('\n');
  it('reads through a URL, a same-file helper and the body read whole → no UNREALIZED_PARAM', async () => {
    const r = await sb.run(['validate'], fresh(statsTree({
      portal: portal("const url = new URL(req.url ?? '/', 'http://local'); const { code } = pathParams(req); return code + String(url.searchParams.get('limit'));", 'return String(req.body);'),
    })));
    expect(countCode(r.all, 'UNREALIZED_PARAM'), transcript(r)).toBe(0);
  });
  it('control — a handler reading neither the body nor the code → UNREALIZED_PARAM names both', async () => {
    const r = await sb.run(['validate'], fresh(statsTree({ portal: portal("return req.method ?? '';", "return req.method ?? '';") })));
    expect(r.all).toMatch(/\[UNREALIZED_PARAM\][^\n]*Method "getStats"/);
    expect(r.all).toMatch(/\[UNREALIZED_PARAM\][^\n]*Method "acceptHit"/);
  });
});

describe('r9 (solo-app top-1): an injection nothing takes is a notice', () => {
  it('a stale `injectedParams` entry → UNUSED_INJECTED_PARAM as a notice, --ci exits 0', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(routePortalTree({ injectedParams: ['req', 'pool'] })));
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toMatch(/notice[^\n]*\[UNUSED_INJECTED_PARAM\][^\n]*"req", "pool"/);
  });
});

describe('r9 (solo-app, tinkerer): route coverage is never silently off', () => {
  it('a route table moved out of the Portal\'s file with no `router:` → ROUTER_UNDECLARED, a notice naming router:', async () => {
    const tree = centralRouterTree(ROUTES_MODULE(), 'src/routes.ts#ROUTES');
    delete implementationsOf(tree)[0].router;
    const r = await sb.run(['validate'], fresh(tree));
    expect(r.all, transcript(r)).toMatch(/notice[^\n]*\[ROUTER_UNDECLARED\][^\n]*names no router \(`router:`\)/);
  });
  it('a spread table with a route dropped → UNROUTED_ENDPOINT, --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(analyticsTree({ routesFile: analyticsRoutes({ dropTop: true }) })));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[UNROUTED_ENDPOINT\][^\n]*"GET \/stats\/top"/);
  });
  it('control — one literal table named by both Portals: no Portal blamed for the other\'s routes', async () => {
    const r = await sb.run(['validate'], fresh(analyticsTree({ routesFile: analyticsRoutes({ spread: false }) })));
    for (const code of ['UNDECLARED_ROUTE', 'UNROUTED_ENDPOINT', 'UNREADABLE_ROUTER', 'ROUTER_UNDECLARED']) expect(countCode(r.all, code), transcript(r)).toBe(0);
  });
});

describe('r9 (lib-and-app R9-14): `conformance: off` is visible', () => {
  it('the dial off → REALIZATION_UNCHECKED in validate, and a line in status', async () => {
    const dir = fresh(withDial(routePortalTree({ getRouteTiles: 'req: any, res: any' }), 'route_portal_impl', 'off'));
    const v = await sb.run(['validate', '--ci'], dir);
    expect(v.code, transcript(v)).toBe(0);
    expect(v.all).toMatch(/notice[^\n]*\[REALIZATION_UNCHECKED\][^\n]*conformance off on "route_portal_impl"/);
    const s = await sb.run(['status'], dir);
    expect(s.all, transcript(s)).toContain('Conformance off: route_portal_impl (every method) — realization not checked');
  });
  it('control — the dial left alone: neither says a word', async () => {
    const dir = fresh(routePortalTree({}));
    const v = await sb.run(['validate'], dir);
    expect(countCode(v.all, 'REALIZATION_UNCHECKED'), transcript(v)).toBe(0);
    const s = await sb.run(['status'], dir);
    expect(s.all).not.toContain('Conformance off:');
  });
});
