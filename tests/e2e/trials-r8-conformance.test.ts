import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureTree } from '../rules-matrix/harness';
import { createTrialSandbox, countCode, transcript, writeFile, type TrialSandbox } from './trials-helpers';
import { habitly, type HabitlyOptions } from '../helpers/conformance-r6-trees';
import { classPortal, routePortalTree, routerTree, type RoutePortalOptions } from '../helpers/conformance-r7-trees';
import {
  anyPortal,
  centralRouterTree,
  PREFIX_KEYED_ROUTER,
  RETURNED_TABLE_ROUTER,
  ROUTES_MODULE,
  rustStoreTree,
  siblingSourceImport,
  sinkPortal,
  STRIPPING_ROUTER,
  withDial,
} from '../helpers/conformance-r8-trees';

// ---------------------------------------------------------------------------
// Round-8 user trials, the code gate, against the built CLI: the write taken
// as a value off an `any` receiver (lib-and-app R8-9), the any-typed closure
// parameter and the any from parseJson (tinkerer), the cast-away port to a
// planned Store (platform); objects and transport handles in a record's place
// and same-arity framework handlers (lib-and-app R8-22, platform); framework
// handlers with no green path and a conformance dial named `off` that was not
// (tinkerer MAJOR 4); another project's source imported directly (solo-app,
// lib-and-app R8-20); central, template-keyed, returned and prefix-stripped
// route tables (tinkerer, platform, lib-and-app R8-25 / R8-8); and a TS call
// graph judging calls into Rust (lib-and-app R8-26).
//
// Every bypass runs beside the honest shape it must leave green.
// ---------------------------------------------------------------------------

let sb: TrialSandbox;
let seq = 0;
const fresh = (tree: FixtureTree): string => sb.materialize(`p${++seq}`, tree);
const habits = (o: HabitlyOptions = {}): string => fresh(habitly(o));
const routes = (o: RoutePortalOptions): string => fresh(routePortalTree(o));

beforeAll(() => { sb = createTrialSandbox('r8conf'); });
afterAll(async () => { await sb?.cleanup(); });

describe('r8 (lib-and-app R8-9, tinkerer, platform): fail closed on any opaque receiver', () => {
  const bypasses: Array<[string, () => string]> = [
    ['a write taken as a value off a cast receiver and invoked later', () => habits({ portal: classPortal({ store: 'required', pre: 'const f = (this.store as any).addCheckIn; f(id);' }) })],
    ['a closure with an any-typed parameter', () => fresh(anyPortal('const run = (deps: any) => deps.addCheckIn(id); run(this.store);'))],
    ['an any receiver returned from parseJson', () => fresh(anyPortal('const svc = parseJson(id); svc.addCheckIn(id);'))],
    ['a planned Store\'s port cast to any', () => habits({ store: null, portal: sinkPortal('(this.sink as any).addCheckIn(id);') })],
    ['a planned Store\'s port copied into a local typed any', () => habits({ store: null, portal: sinkPortal('const s: any = this.sink; s.addCheckIn(id);') })],
  ];
  for (const [label, make] of bypasses) {
    it(`${label} → PORTAL_CALL_UNRESOLVED, --ci exits 1`, async () => {
      const r = await sb.run(['validate', '--ci'], make());
      expect(r.code, transcript(r)).toBe(1);
      expect(r.all).toMatch(/\[PORTAL_CALL_UNRESOLVED\][^\n]*habit_store\.addCheckIn/);
    });
  }
  it('control — the planned port read through the cast: no PORTAL_CALL_UNRESOLVED', async () => {
    const r = await sb.run(['validate'], habits({ store: null, portal: sinkPortal('(this.sink as any).find(id);') }));
    expect(countCode(r.all, 'PORTAL_CALL_UNRESOLVED'), transcript(r)).toBe(0);
  });
});

describe('r8 (lib-and-app R8-22, platform, solo-app): parameters', () => {
  it('`planRoute(session: { user: string }, …)` for `planRoute(request: plan_request)` → a substitution, --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], routes({ planRoute: 'session: { user: string }, _url: RequestUrl, _params: Record<string, string>', planBody: 'return session.user;' }));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[UNREALIZED_PARAM\][^\n]*"request" \(the code takes "session", an object sharing none of its fields/);
  });
  it('`planRoute(req: IncomingMessage, …)` → a transport handle in a record\'s place, --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], routes({ planRoute: 'req: IncomingMessage, _url: RequestUrl, _params: Record<string, string>', planBody: 'return String(req.url);' }));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[UNREALIZED_PARAM\][^\n]*a transport handle, where the contract declares the record "plan_request"/);
  });
  it('a same-arity framework handler `getRouteTiles(req, res)` → named, with the green path', async () => {
    const r = await sb.run(['validate', '--ci'], routes({ getRouteTiles: 'req, res' }));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[UNREALIZED_PARAM\][^\n]*"id" \(the code takes "req", a transport handle/);
    expect(r.all).toContain('getRouteTiles(req, res, id, zoom?)');
  });
  it('a declared injection nothing takes → UNUSED_INJECTED_PARAM (a notice since round 9: --ci exits 0)', async () => {
    const r = await sb.run(['validate', '--ci'], routes({ injectedParams: ['req'] }));
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toMatch(/\[UNUSED_INJECTED_PARAM\][^\n]*"req"/);
  });
  it('control — the honest `planRoute(request: PlanRequest)`: --ci exits 0', async () => {
    const r = await sb.run(['validate', '--ci'], routes({}));
    expect(r.code, transcript(r)).toBe(0);
  });
});

describe('r8 (tinkerer MAJOR 4): framework handlers have a green path, and `off` is off', () => {
  it('`getRoute(ctx, req, res)` with injectedParams [_ctx, req, res], reading id off the request → --ci exits 0', async () => {
    const tree = routePortalTree({ getRoute: 'ctx: object, req: { params: Record<string, string> }, res: IncomingMessage', injectedParams: ['_ctx', 'req', 'res'] });
    tree.files!['src/route-portal.ts'] = tree.files!['src/route-portal.ts'].replace(
      "getRoute(ctx: object, req: { params: Record<string, string> }, res: IncomingMessage): string { return 'route'; }",
      "getRoute(ctx: object, req: { params: Record<string, string> }, res: IncomingMessage): string { void ctx; void res; return req.params.id ?? ''; }",
    );
    const r = await sb.run(['validate', '--ci'], fresh(tree));
    expect(r.code, transcript(r)).toBe(0);
  });
  it('a trailing injected `res` → --ci exits 0', async () => {
    const r = await sb.run(['validate', '--ci'], routes({ getRoute: 'id: string, res: IncomingMessage', injectedParams: ['res'] }));
    expect(r.code, transcript(r)).toBe(0);
  });
  it('the same handler with `conformance: off` on the implementation → no parameter finding, --ci exits 0', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(withDial(routePortalTree({ getRouteTiles: 'req: any, res: any' }), 'route_portal_impl', 'off')));
    expect(r.code, transcript(r)).toBe(0);
    expect(countCode(r.all, 'UNREALIZED_PARAM')).toBe(0);
  });
  it('control — without the dial, the same handler → --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], routes({ getRouteTiles: 'req: any, res: any' }));
    expect(r.code, transcript(r)).toBe(1);
  });
});

describe('r8 (solo-app, lib-and-app R8-20): another project\'s source', () => {
  const twoProjects = (name: string, o: Parameters<typeof siblingSourceImport>[0]): string => {
    const { consumer, producer } = siblingSourceImport(o);
    const root = sb.materialize(`${name}/reminders`, consumer);
    const producerRoot = sb.materialize(`${name}/habitly`, producer);
    void producerRoot;
    return root;
  };
  const STORE_IMPORT = "import { HabitStore } from '../../habitly/src/habit-store.js';";
  it('importing a sibling project\'s Store class from its source → CROSS_PROJECT_SOURCE_IMPORT, --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], twoProjects('s1', { importLine: STORE_IMPORT, call: 'new HabitStore().addCheckIn(id)' }));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[CROSS_PROJECT_SOURCE_IMPORT\][^\n]*"HabitStore"/);
  });
  it('control — the same reach through a declared binding module: no CROSS_PROJECT_SOURCE_IMPORT', async () => {
    const r = await sb.run(['validate'], twoProjects('s2', { importLine: STORE_IMPORT, call: 'new HabitStore().addCheckIn(id)', binding: true }));
    expect(countCode(r.all, 'CROSS_PROJECT_SOURCE_IMPORT'), transcript(r)).toBe(0);
  });
});

describe('r8 (tinkerer, platform, lib-and-app R8-25 / R8-8): routers', () => {
  const routeCodes = (all: string): number => ['UNDECLARED_ROUTE', 'UNROUTED_ENDPOINT', 'UNREADABLE_ROUTER', 'UNREALIZED_EXPORT_HANDLE'].reduce((n, c) => n + countCode(all, c), 0);
  it('a central `src/routes.ts#ROUTES` table → read, --ci exits 0', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(centralRouterTree(ROUTES_MODULE(), 'src/routes.ts#ROUTES')));
    expect(r.code, transcript(r)).toBe(0);
  });
  it('the central table with an extra DELETE → UNDECLARED_ROUTE', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(centralRouterTree(ROUTES_MODULE([
      "{ method: 'GET', path: '/habits', verb: 'listHabits' }",
      "{ method: 'GET', path: '/habits/:habitId', verb: 'getHabit' }",
      "{ method: 'POST', path: '/habits/:habitId/archive', verb: 'archiveHabit' }",
      "{ method: 'GET', path: '/me', verb: 'getMe' }",
      "{ method: 'DELETE', path: '/habits/:habitId', verb: 'deleteHabit' }",
    ]), 'src/routes.ts#ROUTES')));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[UNDECLARED_ROUTE\][^\n]*"DELETE \/habits\/\*"/);
  });
  it('template-literal keys over `const PREFIX` and a returned table → read, no UNREADABLE_ROUTER', async () => {
    for (const router of [PREFIX_KEYED_ROUTER(), RETURNED_TABLE_ROUTER()]) {
      const r = await sb.run(['validate'], fresh(routerTree(router)));
      expect(routeCodes(r.all), transcript(r)).toBe(0);
    }
  });
  it('a table under a stripped `/v9` against basePath `/v1` → both directions, naming the two', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(routerTree(STRIPPING_ROUTER('/v9'))));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[UNDECLARED_ROUTE\][^\n]*strips "\/v9"/);
    expect(r.all).toMatch(/\[UNROUTED_ENDPOINT\][^\n]*basePath is "\/v1"/);
  });
  it('control — the stripped prefix IS the basePath → --ci exits 0', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(routerTree(STRIPPING_ROUTER('/v1'))));
    expect(r.code, transcript(r)).toBe(0);
  });
});

describe('r8 (lib-and-app R8-26): a call into code in another language', () => {
  it('a TS Orchestrator claiming calls into a Rust Store → one CALL_ACROSS_LANGUAGE notice, no CALL_STEP_UNREALIZED', async () => {
    const root = fresh(rustStoreTree());
    writeFile(path.join(root), 'README.md', 'Habit tracking with a Rust store behind a TypeScript binding.\n');
    const r = await sb.run(['validate'], root);
    expect(countCode(r.all, 'CALL_STEP_UNREALIZED'), transcript(r)).toBe(0);
    expect(countCode(r.all, 'CALL_ACROSS_LANGUAGE')).toBe(1);
  });
  it('control — a TypeScript Store: no language boundary', async () => {
    const r = await sb.run(['validate'], habits());
    expect(countCode(r.all, 'CALL_ACROSS_LANGUAGE'), transcript(r)).toBe(0);
  });
});
