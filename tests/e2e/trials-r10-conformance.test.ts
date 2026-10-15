import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureTree } from '../rules-matrix/harness';
import { createTrialSandbox, countCode, transcript, type TrialSandbox } from './trials-helpers';
import { analyticsTree } from '../helpers/conformance-r9-trees';
import { bodyTree, checkInTree, classRouterTree, dispatchedRoutes } from '../helpers/conformance-r10-trees';

// ---------------------------------------------------------------------------
// Round-10 user trials, the code gate, against the built CLI: the record a
// plain node:http handler reads through a body helper (platform top-1); a
// Portal served by a class's method and the names ROUTER_UNDECLARED suggests
// (solo-app); a Portal's own table left out of the table the server
// dispatches (tinkerer); an any-typed object in a scalar's place and an
// injection naming a contract parameter (solo-app).
//
// Every bypass runs beside the honest shape it must leave green.
// ---------------------------------------------------------------------------

let sb: TrialSandbox;
let seq = 0;
const fresh = (tree: FixtureTree): string => sb.materialize(`p${++seq}`, tree);
const PARAM_CODES = ['UNREALIZED_PARAM', 'UNDECLARED_PARAM', 'PARAM_TYPE_MISMATCH', 'PARAM_NAME_MISMATCH'];

beforeAll(() => { sb = createTrialSandbox('r10conf'); });
afterAll(async () => { await sb?.cleanup(); });

describe('r10 (platform top-1): the record read whole through a body helper', () => {
  const honest: Array<[string, string]> = [
    ['V1', 'const hit = await readJsonBody(req); return record(hit as HitEvent);'],
    ['V2', 'const hit = (await readJsonBody(req)) as HitEvent; return record(hit);'],
    ['V3', 'const hit: HitEvent = await readJsonBody<HitEvent>(req); return record(hit);'],
    ['V4', 'const body = await readJsonBody(req); const hit = body as HitEvent; return record(hit);'],
  ];
  for (const [label, body] of honest) {
    it(`${label}: \`acceptHit\` reading its hit through readJsonBody(req) → no parameter finding, --ci exits 0`, async () => {
      const r = await sb.run(['validate', '--ci'], fresh(bodyTree(body)));
      for (const code of PARAM_CODES) expect(countCode(r.all, code), transcript(r)).toBe(0);
      expect(r.code, transcript(r)).toBe(0);
    });
  }
  it('control — the parsed body only read for a field: `hit` stays UNREALIZED_PARAM, naming both honest spellings; --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(bodyTree('const hit = await readJsonBody<HitEvent>(req); return hit.code;')));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[UNREALIZED_PARAM\][^\n]*"hit"[^\n]*`const hit = await readJsonBody\(req\)`/);
  });
});

describe('r10 (solo-app): a Portal served by a class method', () => {
  it('`router: HabitPortal.handle` is accepted and read: an extra route is UNDECLARED_ROUTE', async () => {
    const clean = await sb.run(['validate', '--ci'], fresh(classRouterTree('HabitPortal.handle')));
    expect(clean.code, transcript(clean)).toBe(0);
    for (const code of ['UNREALIZED_EXPORT_HANDLE', 'UNREADABLE_ROUTER', 'ROUTER_UNDECLARED']) expect(countCode(clean.all, code), transcript(clean)).toBe(0);
    const extra = await sb.run(['validate', '--ci'], fresh(classRouterTree('HabitPortal.handle', { extraRoute: true })));
    expect(extra.code, transcript(extra)).toBe(1);
    expect(extra.all).toMatch(/\[UNDECLARED_ROUTE\][^\n]*"DELETE \/habits\/\*"/);
  });
  it('no router: ROUTER_UNDECLARED offers `HabitPortal.handle` and says to export the private table', async () => {
    const r = await sb.run(['validate'], fresh(classRouterTree(undefined)));
    expect(r.all, transcript(r)).toMatch(/\[ROUTER_UNDECLARED\][^\n]*HabitPortal\.handle \(src\/habit-portal\.ts\)[^\n]*ROUTES \(src\/habit-portal\.ts\)[^\n]*not exported/);
  });
  it('`router: handle` is refused naming the `HabitPortal.handle` spelling', async () => {
    const r = await sb.run(['validate'], fresh(classRouterTree('handle')));
    expect(r.all, transcript(r)).toMatch(/\[UNREALIZED_EXPORT_HANDLE\][^\n]*name it `HabitPortal\.handle`/);
  });
});

describe('r10 (tinkerer): a Portal\'s own table left out of the dispatched aggregate', () => {
  const ownTables = (dispatched: string[]): FixtureTree =>
    analyticsTree({ routesFile: dispatchedRoutes(dispatched), router: { hit_ingest_portal: 'ingestRoutes', stats_portal: 'statsRoutes' } });
  it('`statsRoutes` taken out of `routes = [...ingestRoutes]` → ROUTER_NOT_DISPATCHED notice; --ci still judges notices as notices', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(ownTables(['ingestRoutes'])));
    expect(countCode(r.all, 'ROUTER_NOT_DISPATCHED'), transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[ROUTER_NOT_DISPATCHED\][^\n]*`src\/analytics\/routes\.ts#routes`/);
  });
  it('control — both tables spread → no ROUTER_NOT_DISPATCHED', async () => {
    const r = await sb.run(['validate'], fresh(ownTables(['ingestRoutes', 'statsRoutes'])));
    expect(countCode(r.all, 'ROUTER_NOT_DISPATCHED'), transcript(r)).toBe(0);
  });
});

describe('r10 (solo-app Q4/Q7): a scalar realized by an any-typed object, an injection naming a contract parameter', () => {
  it('Q4 `checkIn(authorization, args: any)` reading args.habitId and args.date → PARAM_TYPE_MISMATCH on `date`, --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(checkInTree({ dateType: 'date', signature: 'authorization: string, args: any', body: 'return authorization + args.habitId + args.date;' })));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[PARAM_TYPE_MISMATCH\][^\n]*"date" \(the code takes "args" typed "any"[^\n]*reads it as an object/);
  });
  it('Q7 `injectedParams: [authorization, habitId, date]` → the UNREALIZED_PARAM names the injection', async () => {
    const r = await sb.run(['validate'], fresh(checkInTree({
      signature: 'authorization: string, habitId: string, date: string', body: 'return authorization + habitId + date;',
      injectedParams: ['authorization', 'habitId', 'date'],
    })));
    expect(r.all, transcript(r)).toMatch(/\[UNREALIZED_PARAM\][^\n]*`injectedParams` names "habitId", "date" — the contract's own parameter\(s\)/);
  });
  it('control — the honest signature: no parameter finding', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(checkInTree({ signature: 'authorization: string, habitId: string, date: string', body: 'return authorization + habitId + date;' })));
    for (const code of PARAM_CODES) expect(countCode(r.all, code), transcript(r)).toBe(0);
    expect(r.code, transcript(r)).toBe(0);
  });
});
