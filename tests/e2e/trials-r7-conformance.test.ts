import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureTree } from '../rules-matrix/harness';
import { createTrialSandbox, countCode, transcript, writeFile, type TrialSandbox } from './trials-helpers';
import { habitly, orchestratorFile, portalFile, type HabitlyOptions } from '../helpers/conformance-r6-trees';
import {
  CLOSURE_STORE_FILE,
  HABIT_TABLE,
  PREFIX_ROUTER,
  TABLE_CONSTANTS,
  classPortal,
  crossProjectPlatform,
  routePortalTree,
  routerTree,
  tableRouter,
  type RoutePortalOptions,
} from '../helpers/conformance-r7-trees';

// ---------------------------------------------------------------------------
// Round-7 user trials, the code gate, against the built CLI: the one-character
// underscore bypass and the front-first, kind-blind parameter pairing
// (lib-and-app R7-5 / R7-15); the fail-closed `any` check that never fired on
// class code and the string-typed computed keys (solo-app top-3); an
// unnarrated write through a port to a Store not written yet (platform); a
// code-only Orchestrator rename read as a Portal write shortcut (solo-app); the
// phantom routes of a router stripping its own prefix and the unreadable route
// table (solo-app top-1, lib-and-app R7-21); and an import from another
// project's source that resolves to nothing (platform).
//
// Every bypass runs beside the honest shape it must leave green.
// ---------------------------------------------------------------------------

let sb: TrialSandbox;
let seq = 0;
const fresh = (tree: FixtureTree): string => sb.materialize(`p${++seq}`, tree);
const habits = (o: HabitlyOptions = {}): string => fresh(habitly(o));
const routes = (o: RoutePortalOptions): string => fresh(routePortalTree(o));

beforeAll(() => { sb = createTrialSandbox('r7conf'); });
afterAll(async () => { await sb?.cleanup(); });

describe('r7 (lib-and-app R7-5 / R7-15): `_` means unused, and pairing is tail-first and kind-aware', () => {
  it('a used `_secret` ahead of the plan request → UNDECLARED_PARAM naming it, --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], routes({ planRoute: '_secret: string, request: PlanRequest', planBody: "return _secret.length > 0 ? 'planned' : 'refused';" }));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[UNDECLARED_PARAM\][^\n]*"_secret"/);
  });
  it('`planRoute(apiKey, req)` names the inserted apiKey, never the request', async () => {
    const r = await sb.run(['validate', '--ci'], routes({ planRoute: 'apiKey: string, req: IncomingMessage' }));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[UNDECLARED_PARAM\][^\n]*"apiKey"/);
    expect(r.all).not.toMatch(/\[UNDECLARED_PARAM\][^\n]*"req"/);
  });
  it('`getRoute(_req, _url, params: Record)` for `getRoute(id: string)` → the substitution is named, --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], routes({ getRoute: '_req: IncomingMessage, _url: RequestUrl, params: Record<string, string>' }));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[UNREALIZED_PARAM\][^\n]*"id" \(the code takes "params", an object, where the contract declares a string\)/);
  });
  it('the honest `(req, url, params)` handler: no PARAM_OPTIONALITY, and the finding names the one green path', async () => {
    const r = await sb.run(['validate'], routes({ nodeHttp: true, getRouteTiles: 'req: IncomingMessage, url: URL, params: Record<string, string>' }));
    expect(countCode(r.all, 'PARAM_OPTIONALITY'), transcript(r)).toBe(0);
    expect(r.all).toContain('`injectedParams` — [req, url]');
    expect(r.all).toContain('getRouteTiles(req, url, id, zoom?)');
  });
  it('control — the green path it names: `(req, url, id, zoom?)` with injectedParams [req, url] → --ci exits 0', async () => {
    const r = await sb.run(['validate', '--ci'], routes({ nodeHttp: true, getRouteTiles: 'req: IncomingMessage, url: URL, id: string, zoom?: number', injectedParams: ['req', 'url'] }));
    expect(r.code, transcript(r)).toBe(0);
  });
  it('control — the request and URL underscore-named and never read, no injection → --ci exits 0', async () => {
    const r = await sb.run(['validate', '--ci'], routes({ getRoute: '_req: IncomingMessage, _url: RequestUrl, id: string' }));
    expect(r.code, transcript(r)).toBe(0);
  });
});

describe('r7 (solo-app top-3): the fail-closed `any` check reads class code exactly as closure code', () => {
  const bypasses: Array<[string, Parameters<typeof classPortal>[0]]> = [
    ['`await (this.store as any).addCheckIn(id)` in a check-in that is not async', { store: 'optional', pre: 'await (this.store as any).addCheckIn(id);' }],
    ['`(this as any).store.addCheckIn(id)`', { store: 'required', pre: 'await (this as any).store.addCheckIn(id);' }],
    ['a const literal key on the cast field', { store: 'required', pre: "const name = 'addCheckIn'; await (this.store as any)[name](id);" }],
    ['a key `as string`', { store: 'required', async: true, pre: "const key = 'addCheckIn' as string; await (this.store as any)[key](id);" }],
    ['a `keyof` concatenation off an optional field', { store: 'optional', async: true, pre: "const k = ('add' + 'CheckIn') as keyof HabitStore; const f = this.store![k] as unknown as (x: string) => string; f.call(this.store, id);" }],
  ];
  for (const [label, o] of bypasses) {
    it(`class Portal — ${label} → PORTAL_CALL_UNRESOLVED, --ci exits 1`, async () => {
      const r = await sb.run(['validate', '--ci'], habits({ portal: classPortal(o) }));
      expect(r.code, transcript(r)).toBe(1);
      expect(r.all).toMatch(/\[PORTAL_CALL_UNRESOLVED\][^\n]*habit_store\.addCheckIn/);
    });
  }
  it('a Store typed by an interface a factory realizes — a string-typed key → PORTAL_CALL_UNRESOLVED', async () => {
    const r = await sb.run(['validate', '--ci'], habits({ store: CLOSURE_STORE_FILE, portal: portalFile({ body: "let key = 'addCheckIn'; if (id === '') key = 'find'; (this.checkins as any)[key](id);" }) }));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[PORTAL_CALL_UNRESOLVED\][^\n]*habit_store\.addCheckIn/);
  });
  it('control — the class Portal reading the Store through the cast: --ci exits 0', async () => {
    const r = await sb.run(['validate', '--ci'], habits({ portal: classPortal({ store: 'required', pre: '(this.store as any).find(id);' }) }));
    expect(countCode(r.all, 'PORTAL_CALL_UNRESOLVED'), transcript(r)).toBe(0);
    expect(r.code, transcript(r)).toBe(0);
  });
});

describe('r7 (platform): an unnarrated write through a port to a Store whose file is not written', () => {
  const portPortal = (call: string): string => [
    "import type { HabitOrchestrator } from './habit-orchestrator.js';",
    'export interface CheckinSink { addCheckIn(id: string): string; find(id: string): string; }',
    'export class HabitPortal {',
    '  constructor(private readonly habits: HabitOrchestrator, private readonly sink: CheckinSink) {}',
    `  checkIn(id: string): string { this.sink.${call}(id); return this.habits.checkIn(id); }`,
    '}', '',
  ].join('\n');
  it('the Store planned → PORTAL_CALL_UNRESOLVED naming the planned write, --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], habits({ store: null, portal: portPortal('addCheckIn') }));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[PORTAL_CALL_UNRESOLVED\][^\n]*habit_store\.addCheckIn[^\n]*has no code yet/);
  });
  it('control — the same port read: no PORTAL_CALL_UNRESOLVED', async () => {
    const r = await sb.run(['validate', '--ci'], habits({ store: null, portal: portPortal('find') }));
    expect(countCode(r.all, 'PORTAL_CALL_UNRESOLVED'), transcript(r)).toBe(0);
  });
});

describe('r7 (solo-app): a code-only rename of an Orchestrator verb is reported as the rename it is', () => {
  const callingPortal = (calls: string): string => [
    "import type { HabitOrchestrator } from './habit-orchestrator.js';",
    'export class HabitPortal {',
    '  constructor(private readonly habits: HabitOrchestrator) {}',
    `  checkIn(id: string): string { ${calls} }`,
    '}', '',
  ].join('\n');
  it('`checkIn` renamed `complete` in the code only → CALL_STEP_UNREALIZED naming it, no PORTAL_WRITE_SHORTCUT_IN_CODE, exit 0 without --ci', async () => {
    const r = await sb.run(['validate'], habits({
      orchestrator: orchestratorFile().replace('checkIn(id: string): string {', 'complete(id: string): string {'),
      portal: callingPortal('return this.habits.complete(id);'),
    }));
    expect(r.code, transcript(r)).toBe(0);
    expect(countCode(r.all, 'PORTAL_WRITE_SHORTCUT_IN_CODE')).toBe(0);
    expect(r.all).toMatch(/\[CALL_STEP_UNREALIZED\][^\n]*calls "complete" on habit_orchestrator's code instead/);
  });
  it('control — the narrated verb: --ci exits 0', async () => {
    const r = await sb.run(['validate', '--ci'], habits({ portal: callingPortal('return this.habits.checkIn(id);') }));
    expect(r.code, transcript(r)).toBe(0);
  });
});

describe('r7 (solo-app top-1, lib-and-app R7-21): the route reader', () => {
  it('a router stripping BASE = /v1/habits under basePath /v1 → no phantom route, only the unrouted GET /me', async () => {
    const r = await sb.run(['validate'], fresh(routerTree(PREFIX_ROUTER)));
    expect(countCode(r.all, 'UNDECLARED_ROUTE'), transcript(r)).toBe(0);
    expect(countCode(r.all, 'UNROUTED_ENDPOINT')).toBe(1);
    expect(r.all).toMatch(/\[UNROUTED_ENDPOINT\][^\n]*"GET \/me"/);
  });
  it('a route table read through a helper → --ci exits 0', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(routerTree(`${TABLE_CONSTANTS}\n${tableRouter(HABIT_TABLE)}`)));
    expect(r.code, transcript(r)).toBe(0);
  });
  it('a table entry no endpoint declares → UNDECLARED_ROUTE, --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(routerTree(`${TABLE_CONSTANTS}\n${tableRouter([...HABIT_TABLE, "{ method: 'DELETE', path: '/habits/:habitId', verb: 'deleteHabit' }"])}`)));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[UNDECLARED_ROUTE\][^\n]*"DELETE \/habits\/\*"/);
  });
  it('a table entry that does not settle → UNREADABLE_ROUTER, never a partial reading', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(routerTree(`${TABLE_CONSTANTS}\n${tableRouter([...HABIT_TABLE, "{ method: 'GET', path: String(Date.now()), verb: 'clock' }"])}`)));
    expect(r.code, transcript(r)).toBe(1);
    expect(countCode(r.all, 'UNREADABLE_ROUTER')).toBe(1);
    expect(countCode(r.all, 'UNROUTED_ENDPOINT')).toBe(0);
  });
});

describe('r7 (platform): an import from another project\'s source that resolves to nothing', () => {
  const platform = (importLine: string): string => {
    const name = `x${++seq}`;
    const { platform: tree, contracts } = crossProjectPlatform(importLine);
    const root = sb.materialize(`${name}/platform`, tree);
    for (const [rel, text] of Object.entries(contracts)) writeFile(path.join(root, '..', 'contracts'), rel, text);
    return root;
  };
  it('`import type { CustomerId }` from a module that now exports only CustomerRef → CROSS_PROJECT_IMPORT_UNRESOLVED, --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], platform("import type { CustomerId } from '../../contracts/src/ids.js';"));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[CROSS_PROJECT_IMPORT_UNRESOLVED\][^\n]*"CustomerId" from "\.\.\/\.\.\/contracts\/src\/ids\.js"/);
  });
  it('control — the name the module exports: --ci exits 0', async () => {
    const r = await sb.run(['validate', '--ci'], platform("import type { CustomerRef } from '../../contracts/src/ids.js';"));
    expect(countCode(r.all, 'CROSS_PROJECT_IMPORT_UNRESOLVED'), transcript(r)).toBe(0);
    expect(r.code, transcript(r)).toBe(0);
  });
});
