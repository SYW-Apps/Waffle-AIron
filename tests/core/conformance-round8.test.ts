import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { validateProject, type ValidationIssue } from '../../src/core/validation.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';
import { habitly, NO_FIELD, orchestratorFile, portalFile, type HabitlyOptions } from '../helpers/conformance-r6-trees.js';
import { classPortal, routePortalTree, routerTree, type RoutePortalOptions } from '../helpers/conformance-r7-trees.js';
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
  unnarratedWrite,
  withDial,
} from '../helpers/conformance-r8-trees.js';

// ---------------------------------------------------------------------------
// The code<->spec gaps the eighth round of user trials found:
//
//   1. Fail-closed holes: a write taken as a VALUE off an `any` receiver and
//      invoked later; an `any` receiver reached two ways in two functions (the
//      first finding hid the second); and a cast-away port while the Store it
//      stands for is still planned.
//   2. Parameters: an object in a record's place, a transport object where a
//      domain record is declared, same-arity framework handlers in unannotated
//      code, a fresh same-kind name for a date, and an injection nothing takes.
//   3. Framework handlers: injectedParams matched with or without `_`, at the
//      trailing end too; contract parameters read off the injected request;
//      and the conformance dial honoured where it should be.
//   4. Another project's SOURCE imported directly.
//   5. Routers: a central route table, template-literal keys over a const, an
//      anonymous returned table, and a stripped prefix that is not basePath.
//   6. A call into code written in another language.
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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-round8-')));
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

function run(tree: FixtureTree): ValidationIssue[] {
  const dir = tempDir();
  materialize(dir, tree);
  setProjectRoot(dir);
  invalidateSpecCache();
  return validateProject().issues;
}

const habits = (o: HabitlyOptions = {}): ValidationIssue[] => run(habitly(o));
const routes = (o: RoutePortalOptions): ValidationIssue[] => run(routePortalTree(o));
const byCode = (issues: ValidationIssue[], code: string): ValidationIssue[] => issues.filter(i => i.code === code);
const said = (issues: ValidationIssue[]): string => issues.map(i => `${i.code}: ${i.message.slice(0, 400)}`).join('\n');
const messages = (issues: ValidationIssue[], code: string): string => byCode(issues, code).map(i => i.message).join('\n');
const PARAM_CODES = ['UNREALIZED_PARAM', 'UNDECLARED_PARAM', 'PARAM_NAME_MISMATCH', 'PARAM_OPTIONALITY', 'UNUSED_INJECTED_PARAM'];
const paramFindings = (issues: ValidationIssue[]): ValidationIssue[] => issues.filter(i => PARAM_CODES.includes(i.code));

describe('1. fail closed on any opaque receiver, however obtained', () => {
  it('a write taken as a VALUE off a cast receiver and invoked later (`const f = (this.store as any).addCheckIn; f(id)`) → PORTAL_CALL_UNRESOLVED', () => {
    const issues = habits({ portal: classPortal({ store: 'required', pre: 'const f = (this.store as any).addCheckIn; f(id);' }) });
    const text = messages(issues, 'PORTAL_CALL_UNRESOLVED');
    expect(text, said(issues)).toContain('habit_store.addCheckIn');
    expect(text).toContain('(taken as a value)');
  });

  it('a closure with an any-typed parameter and an any from parseJson, in two functions → one finding EACH, never one hiding the other', () => {
    const tree = anyPortal('return this.habits.checkIn(id);');
    tree.files!['src/habit-portal.ts'] = tree.files!['src/habit-portal.ts'].replace(
      '  checkIn(id: string): string {',
      [
        '  variantB(id: string): void { const run = (deps: any) => deps.addCheckIn(id); run(this.store); }',
        '  variantD(id: string): void { const svc = parseJson(id); svc.addCheckIn(id); }',
        '  variantA(id: string): void { const d: any = this.store; d.addCheckIn(id); }',
        '  checkIn(id: string): string {',
      ].join('\n'),
    );
    const issues = run(tree);
    const found = byCode(issues, 'PORTAL_CALL_UNRESOLVED');
    // The closure's call sits in the arrow bound to `run`: that is the body it is reported in.
    expect(found.map(f => f.message).join('\n'), said(issues)).toContain('function "run"');
    expect(found.map(f => f.message).join('\n')).toContain('function "variantD"');
    expect(found.map(f => f.message).join('\n')).toContain('function "variantA"');
  });

  it('the Store PLANNED, its port cast to any (`(this.sink as any).addCheckIn(id)`) → PORTAL_CALL_UNRESOLVED', () => {
    const issues = habits({ store: null, portal: sinkPortal('(this.sink as any).addCheckIn(id);') });
    expect(messages(issues, 'PORTAL_CALL_UNRESOLVED'), said(issues)).toContain('habit_store.addCheckIn');
  });

  it('the Store PLANNED, its port copied into a local typed any (`const s: any = this.sink`) → PORTAL_CALL_UNRESOLVED', () => {
    const issues = habits({ store: null, portal: sinkPortal('const s: any = this.sink; s.addCheckIn(id);') });
    expect(messages(issues, 'PORTAL_CALL_UNRESOLVED'), said(issues)).toContain('habit_store.addCheckIn');
  });

  it('control: the planned port read through the cast → nothing', () => {
    const issues = habits({ store: null, portal: sinkPortal('(this.sink as any).find(id);') });
    expect(byCode(issues, 'PORTAL_CALL_UNRESOLVED'), said(issues)).toEqual([]);
  });

  it('control: a value read off a parsed body under a name no write carries → nothing', () => {
    const issues = run(anyPortal('const body = parseJson(id); const name = body.title; void name;'));
    expect(byCode(issues, 'PORTAL_CALL_UNRESOLVED'), said(issues)).toEqual([]);
  });
});

describe('2. parameters: objects, transport handles, fresh names, stale injections', () => {
  it('`planRoute(req: IncomingMessage, …)` realizing `planRoute(request: plan_request)` → a substitution, never a silent pairing', () => {
    const issues = routes({ planRoute: 'req: IncomingMessage, _url: RequestUrl, _params: Record<string, string>', planBody: 'return String(req.url);' });
    expect(messages(issues, 'UNREALIZED_PARAM'), said(issues)).toContain('"request" (the code takes "req", a transport handle, where the contract declares the record "plan_request")');
  });

  it('`planRoute(session: { user: string }, …)` → an object sharing none of the record\'s fields is a substitution', () => {
    const issues = routes({ planRoute: 'session: { user: string }, _url: RequestUrl, _params: Record<string, string>', planBody: 'return session.user;' });
    expect(messages(issues, 'UNREALIZED_PARAM'), said(issues)).toContain('an object sharing none of its fields (stops)');
    expect(messages(issues, 'UNDECLARED_PARAM')).toContain('"session"');
  });

  it('control: an inline object holding every field of the record under another name → a rename', () => {
    const issues = routes({ planRoute: 'body: { stops: string[] }', planBody: 'return body.stops.join();' });
    expect(byCode(issues, 'UNREALIZED_PARAM'), said(issues)).toEqual([]);
    expect(messages(issues, 'PARAM_NAME_MISMATCH')).toContain('"request" (the code calls it "body")');
  });

  it('control: the honest `planRoute(request: PlanRequest)` → nothing', () => {
    expect(paramFindings(routes({}))).toEqual([]);
  });

  it('a same-arity handler of UNUSED handles `getRouteTiles(_req, _res)` → UNREALIZED_PARAM: the handles are set aside, the contract\'s parameters are not taken', () => {
    const issues = routes({ getRouteTiles: '_req, _res' });
    expect(messages(issues, 'UNREALIZED_PARAM'), said(issues)).toContain('"id", "zoom"');
  });

  for (const signature of ['req, res', 'req: any, res: any', 'req, _res']) {
    it(`a same-arity framework handler \`getRouteTiles(${signature})\` for \`getRouteTiles(id, zoom?)\` → UNREALIZED_PARAM naming the green path`, () => {
      const issues = routes({ getRouteTiles: signature });
      const text = messages(issues, 'UNREALIZED_PARAM');
      expect(text, said(issues)).toContain('"id"');
      expect(text).toContain('`injectedParams`');
    });
  }

  it('unannotated JavaScript `cancelOrder(req, res)` realizing `cancelOrder(orderId, customerId)` → a substitution of both', () => {
    const tree = routePortalTree({});
    (tree.interfaces as Array<{ methods: Array<Record<string, unknown>> }>)[0].methods.push({
      name: 'cancelOrder', description: 'Cancels an order.', params: [{ name: 'orderId', type: 'string' }, { name: 'customerId', type: 'string' }], returns: 'string', effect: 'none',
    });
    (tree.implementations as Array<{ methods: Array<Record<string, unknown>> }>)[0].methods.push({ name: 'cancelOrder', sourcePath: 'src/orders.js', detail: 'intent', intent: 'Cancels the order; an unknown order surfaces as a thrown error.' });
    tree.files!['src/orders.js'] = 'export function cancelOrder(req, res) { return String(req.url) + String(res.statusCode); }\n';
    const issues = run(tree);
    const text = messages(issues, 'UNREALIZED_PARAM');
    expect(text, said(issues)).toContain('"orderId" (the code takes "req", a transport handle');
    expect(text).toContain('"customerId" (the code takes "res", a transport handle');
  });

  it('a fresh same-kind name for a date (`checkIn(id, when: string)` for `checkIn(id, date: date)`) → PARAM_NAME_MISMATCH', () => {
    const tree = habitly({ portal: portalFile({ signature: 'id: string, when: string', field: NO_FIELD, head: '', body: 'void when;' }) });
    (tree.interfaces as Array<{ id: string; methods: Array<{ params: unknown[] }> }>).find(i => i.id === 'ihabit_portal')!.methods[0].params.push({ name: 'date', type: 'date' });
    const issues = run(tree);
    expect(messages(issues, 'PARAM_NAME_MISMATCH'), said(issues)).toContain('"date" (the code calls it "when")');
  });

  it('the parameter\'s retired name still in the code → PARAM_NAME_MISMATCH saying so', () => {
    const tree = habitly({ portal: portalFile({ signature: 'id: string, day: string', field: NO_FIELD, head: '', body: 'void day;' }) });
    (tree.interfaces as Array<{ id: string; methods: Array<{ params: unknown[] }> }>).find(i => i.id === 'ihabit_portal')!.methods[0].params.push({ name: 'date', type: 'date', previousNames: ['day'] });
    const issues = run(tree);
    expect(messages(issues, 'PARAM_NAME_MISMATCH'), said(issues)).toContain('"date" (the code calls it "day", the name the contract retired)');
  });

  it('a declared injection no realizing function takes → UNUSED_INJECTED_PARAM', () => {
    const issues = routes({ injectedParams: ['req'] });
    expect(messages(issues, 'UNUSED_INJECTED_PARAM'), said(issues)).toContain('"req"');
  });

  it('control: an injection one handler takes → nothing', () => {
    const issues = routes({ getRoute: 'req: IncomingMessage, id: string', injectedParams: ['req'] });
    expect(byCode(issues, 'UNUSED_INJECTED_PARAM'), said(issues)).toEqual([]);
  });
});

describe('3. framework handlers have a green path that needs no design change', () => {
  it('injectedParams [req] matches the code\'s `_req`, and [_req] the code\'s `req`', () => {
    expect(paramFindings(routes({ getRoute: '_req: IncomingMessage, id: string', injectedParams: ['req'] }))).toEqual([]);
    expect(paramFindings(routes({ getRoute: 'req: IncomingMessage, id: string', injectedParams: ['_req'], planBody: "return 'planned';" }))).toEqual([]);
  });

  it('a TRAILING injected handle (`getRoute(id, res)` with injectedParams [res]) → nothing', () => {
    expect(paramFindings(routes({ getRoute: 'id: string, res: IncomingMessage', injectedParams: ['res'] }))).toEqual([]);
  });

  it('`handler(ctx, req, res)` reading the contract\'s parameter off the injected request → realized through it', () => {
    const tree = routePortalTree({ getRoute: 'ctx: object, req: { params: Record<string, string> }, res: IncomingMessage', injectedParams: ['_ctx', 'req', 'res'] });
    tree.files!['src/route-portal.ts'] = tree.files!['src/route-portal.ts'].replace(
      "getRoute(ctx: object, req: { params: Record<string, string> }, res: IncomingMessage): string { return 'route'; }",
      'getRoute(ctx: object, req: { params: Record<string, string> }, res: IncomingMessage): string { void ctx; void res; return req.params.id ?? \'\'; }',
    );
    expect(paramFindings(run(tree))).toEqual([]);
  });

  it('the same handler reading something else off the request → the contract\'s id stays UNREALIZED_PARAM', () => {
    const tree = routePortalTree({ getRoute: 'req: { params: Record<string, string> }, res: IncomingMessage', injectedParams: ['req', 'res'] });
    tree.files!['src/route-portal.ts'] = tree.files!['src/route-portal.ts'].replace(
      "getRoute(req: { params: Record<string, string> }, res: IncomingMessage): string { return 'route'; }",
      "getRoute(req: { params: Record<string, string> }, res: IncomingMessage): string { void res; return req.params.ref ?? ''; }",
    );
    const issues = run(tree);
    expect(messages(issues, 'UNREALIZED_PARAM'), said(issues)).toContain('"id"');
  });

  it('`conformance: off` on the implementation switches the parameter and async checks off', () => {
    const issues = run(withDial(routePortalTree({ getRouteTiles: 'req: any, res: any' }), 'route_portal_impl', 'off'));
    expect(paramFindings(issues), said(issues)).toEqual([]);
  });

  it('`conformance: off` on ONE method switches that method off and leaves its siblings judged', () => {
    const issues = run(withDial(routePortalTree({ getRouteTiles: 'req: any, res: any', getRoute: 'params: Record<string, string>' }), 'route_portal_impl', 'off', 'getRouteTiles'));
    expect(messages(issues, 'UNREALIZED_PARAM'), said(issues)).toContain('Method "getRoute"');
    expect(messages(issues, 'UNREALIZED_PARAM')).not.toContain('Method "getRouteTiles"');
  });

  it('`conformance: off` never switches the converse off: an unnarrated write is still UNDECLARED_WRITE_CALL', () => {
    const issues = run(withDial(unnarratedWrite(), 'habit_orchestrator_impl', 'off'));
    expect(messages(issues, 'UNDECLARED_WRITE_CALL'), said(issues)).toContain('habit_store.addCheckIn');
  });

  it('`conformance: off` switches the forward call check off: a code-only rename is no longer CALL_STEP_UNREALIZED', () => {
    const renamed = orchestratorFile().replace('checkIn(id: string): string {', 'complete(id: string): string {');
    const portal = classPortal({ store: 'none', pre: '' }).replace('return this.habits.checkIn(id);', 'return this.habits.complete(id);');
    expect(messages(habits({ orchestrator: renamed, portal }), 'CALL_STEP_UNREALIZED')).toContain('habit_orchestrator.checkIn');
    const off = run(withDial(habitly({ orchestrator: renamed, portal }), 'habit_portal_impl', 'off'));
    expect(byCode(off, 'CALL_STEP_UNREALIZED'), said(off)).toEqual([]);
  });
});

describe('4. another project\'s SOURCE, imported directly', () => {
  const twoProjects = (o: Parameters<typeof siblingSourceImport>[0], nested = false): ValidationIssue[] => {
    const dir = tempDir();
    const { consumer, producer } = siblingSourceImport(o);
    const consumerRoot = path.join(dir, 'reminders');
    fs.mkdirSync(consumerRoot, { recursive: true });
    materialize(consumerRoot, consumer);
    const producerRoot = nested ? path.join(consumerRoot, 'libs', 'habitly') : path.join(dir, 'habitly');
    fs.mkdirSync(producerRoot, { recursive: true });
    materialize(producerRoot, producer);
    setProjectRoot(consumerRoot);
    invalidateSpecCache();
    return validateProject().issues;
  };
  const STORE_IMPORT = "import { HabitStore } from '../../habitly/src/habit-store.js';";

  it('a sibling project\'s Store class imported and written through → CROSS_PROJECT_SOURCE_IMPORT', () => {
    const issues = twoProjects({ importLine: STORE_IMPORT, call: 'new HabitStore().addCheckIn(id)' });
    const text = messages(issues, 'CROSS_PROJECT_SOURCE_IMPORT');
    expect(text, said(issues)).toContain('"HabitStore"');
    expect(text).toContain('"../../habitly/src/habit-store.js"');
  });

  it('a MEMBER\'s Store imported from its source → CROSS_PROJECT_SOURCE_IMPORT naming the member and the Store it realizes', () => {
    const issues = twoProjects({ importLine: "import { HabitStore } from '../libs/habitly/src/habit-store.js';", call: 'new HabitStore().addCheckIn(id)', member: 'libs/habitly' }, true);
    const text = messages(issues, 'CROSS_PROJECT_SOURCE_IMPORT');
    expect(text, said(issues)).toContain('the member');
    expect(text).toContain('habit_store');
  });

  it('control: the member\'s EXPORTED type, imported from its source → nothing', () => {
    const issues = twoProjects({ importLine: "import type { Habit } from '../libs/habitly/src/types.js';", call: "({ id } as Habit).id", member: 'libs/habitly', exportType: true }, true);
    expect(byCode(issues, 'CROSS_PROJECT_SOURCE_IMPORT'), said(issues)).toEqual([]);
  });

  it('control: the same reach written in a declared binding module → nothing here (binding conformance\'s subject)', () => {
    const issues = twoProjects({ importLine: STORE_IMPORT, call: 'new HabitStore().addCheckIn(id)', binding: true });
    expect(byCode(issues, 'CROSS_PROJECT_SOURCE_IMPORT'), said(issues)).toEqual([]);
  });
});

describe('5. routers: central tables, template keys, returned tables, stripped prefixes', () => {
  const routeCodes = (issues: ValidationIssue[]): ValidationIssue[] =>
    issues.filter(i => ['UNDECLARED_ROUTE', 'UNROUTED_ENDPOINT', 'UNREADABLE_ROUTER', 'UNREALIZED_EXPORT_HANDLE'].includes(i.code));

  it('a central `src/routes.ts#ROUTES` table → read; matching endpoints → nothing', () => {
    const issues = run(centralRouterTree(ROUTES_MODULE(), 'src/routes.ts#ROUTES'));
    expect(routeCodes(issues), said(issues)).toEqual([]);
  });

  it('the central table with an entry no endpoint declares → UNDECLARED_ROUTE', () => {
    const issues = run(centralRouterTree(ROUTES_MODULE([
      "{ method: 'GET', path: '/habits', verb: 'listHabits' }",
      "{ method: 'GET', path: '/habits/:habitId', verb: 'getHabit' }",
      "{ method: 'POST', path: '/habits/:habitId/archive', verb: 'archiveHabit' }",
      "{ method: 'GET', path: '/me', verb: 'getMe' }",
      "{ method: 'DELETE', path: '/habits/:habitId', verb: 'deleteHabit' }",
    ]), 'src/routes.ts#ROUTES'));
    expect(messages(issues, 'UNDECLARED_ROUTE'), said(issues)).toContain('"DELETE /habits/*"');
  });

  it('the module named alone (`src/routes.ts`) → every route-bearing export read', () => {
    const issues = run(centralRouterTree(ROUTES_MODULE(), 'src/routes.ts'));
    expect(routeCodes(issues), said(issues)).toEqual([]);
  });

  it('a linkage naming an export the module does not have → UNREALIZED_EXPORT_HANDLE', () => {
    const issues = run(centralRouterTree(ROUTES_MODULE(), 'src/routes.ts#TABLE'));
    expect(messages(issues, 'UNREALIZED_EXPORT_HANDLE'), said(issues)).toContain('exports no "TABLE"');
  });

  it('an object keyed by template literals over `const PREFIX` → read; an extra key → UNDECLARED_ROUTE', () => {
    expect(routeCodes(run(routerTree(PREFIX_KEYED_ROUTER())))).toEqual([]);
    const issues = run(routerTree(PREFIX_KEYED_ROUTER('  [`DELETE ${PREFIX}/:habitId`]: getHabit,')));
    expect(messages(issues, 'UNDECLARED_ROUTE'), said(issues)).toContain('"DELETE /habits/*"');
    expect(byCode(issues, 'UNREADABLE_ROUTER')).toEqual([]);
  });

  it('an anonymous `return [ … ]` table → read; an extra entry → UNDECLARED_ROUTE', () => {
    expect(routeCodes(run(routerTree(RETURNED_TABLE_ROUTER())))).toEqual([]);
    const issues = run(routerTree(RETURNED_TABLE_ROUTER("    { method: 'DELETE', path: '/habits/:habitId', verb: 'deleteHabit' },")));
    expect(messages(issues, 'UNDECLARED_ROUTE'), said(issues)).toContain('"DELETE /habits/*"');
  });

  it('a table under a stripped prefix that IS the basePath (`/v1`) → nothing', () => {
    expect(routeCodes(run(routerTree(STRIPPING_ROUTER('/v1'))))).toEqual([]);
  });

  it('a table under a stripped prefix that is NOT the basePath (`/v9`) → both directions, naming the two prefixes', () => {
    const issues = run(routerTree(STRIPPING_ROUTER('/v9')));
    const text = messages(issues, 'UNDECLARED_ROUTE');
    expect(text, said(issues)).toContain('"GET /v9/habits"');
    expect(text).toContain('strips "/v9"');
    expect(messages(issues, 'UNROUTED_ENDPOINT')).toContain('basePath is "/v1"');
  });
});

describe('6. a call into code written in another language', () => {
  it('a TypeScript Orchestrator claiming a call into a Rust Store → one CALL_ACROSS_LANGUAGE notice, no CALL_STEP_UNREALIZED', () => {
    const issues = run(rustStoreTree());
    expect(byCode(issues, 'CALL_STEP_UNREALIZED'), said(issues)).toEqual([]);
    const notices = byCode(issues, 'CALL_ACROSS_LANGUAGE');
    expect(notices).toHaveLength(1);
    expect(notices[0].severity).toBe('notice');
    expect(notices[0].message).toContain('rust');
    expect(notices[0].message).toContain('habit_orchestrator_impl.checkIn → habit_store.addCheckIn');
  });

  it('control: the same Store in TypeScript → no language boundary', () => {
    expect(byCode(habits(), 'CALL_ACROSS_LANGUAGE')).toEqual([]);
  });
});
