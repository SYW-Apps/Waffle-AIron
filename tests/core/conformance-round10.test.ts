import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { validateProject, type ValidationIssue } from '../../src/core/validation.js';
import { routerLinkage } from '../../src/models/index.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';
import { analyticsTree, implementationsOf } from '../helpers/conformance-r9-trees.js';
import {
  bodyTree,
  checkInTree,
  classRouterTree,
  dispatchedRoutes,
  SERVER_MODULE,
} from '../helpers/conformance-r10-trees.js';

// ---------------------------------------------------------------------------
// The code<->spec gaps the tenth round of user trials found:
//
//   1. The one record parameter read whole through a body helper
//      (`const cart = await readJsonBody(req)`) is realized — and stays
//      unrealized for the dishonest shapes (platform top-1).
//   2. A Portal served by a class method has an accepted `router:` spelling
//      (`Class.method`), and ROUTER_UNDECLARED suggests only names the linkage
//      accepts, saying "export it" for the rest (solo-app).
//   3. A Portal's own table named while the server dispatches a sibling that
//      leaves it out is ROUTER_NOT_DISPATCHED (tinkerer).
//   5. An opaque value read as an object in a scalar's place is
//      PARAM_TYPE_MISMATCH; an injection naming a contract parameter is said
//      in the UNREALIZED_PARAM it causes (solo-app).
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const dir of roots.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
  }
});

function run(tree: FixtureTree): ValidationIssue[] {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-round10-')));
  roots.push(dir);
  materializeFixtureProject(dir, tree);
  for (const [rel, text] of Object.entries(tree.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  setProjectRoot(dir);
  invalidateSpecCache();
  return validateProject().issues;
}

const byCode = (issues: ValidationIssue[], code: string): ValidationIssue[] => issues.filter(i => i.code === code);
const said = (issues: ValidationIssue[]): string => issues.map(i => `${i.code}: ${i.message.slice(0, 400)}`).join('\n');
const messages = (issues: ValidationIssue[], code: string): string => byCode(issues, code).map(i => i.message).join('\n');

describe('1. the record read whole through a body helper (platform top-1)', () => {
  // platform-r10's V1-V4, each the one record of acceptHit(hit: hit_event).
  const honest: Array<[string, string]> = [
    ['V1 `const hit = await readJsonBody(req)`', 'const hit = await readJsonBody(req); return record(hit as HitEvent);'],
    ['V2 `(await readJsonBody(req)) as HitEvent`', 'const hit = (await readJsonBody(req)) as HitEvent; return record(hit);'],
    ['V3 annotated and generic `const hit: HitEvent = await readJsonBody<HitEvent>(req)`', 'const hit: HitEvent = await readJsonBody<HitEvent>(req); return record(hit);'],
    ['V4 two steps `const body = await readJsonBody(req); const hit = body as HitEvent`', 'const body = await readJsonBody(req); const hit = body as HitEvent; return record(hit);'],
    ['returned whole', 'const hit = await readJsonBody<HitEvent>(req); return JSON.stringify({ hit });'],
  ];
  for (const [label, body] of honest) {
    it(`${label} → realized, no parameter finding on acceptHit`, () => {
      const issues = run(bodyTree(body));
      expect(messages(issues, 'UNREALIZED_PARAM'), said(issues)).not.toContain('Method "acceptHit"');
    });
  }

  const dishonest: Array<[string, string, string?]> = [
    ['the result never bound', 'await readJsonBody(req); return \'ok\';'],
    ['the result bound and never used', 'const hit = await readJsonBody(req); void 0; return \'ok\';'],
    ['the result only destructured', 'const { code } = await readJsonBody<HitEvent>(req); return code;'],
    ['the result only read for members', 'const hit = await readJsonBody<HitEvent>(req); return hit.code;'],
    ['the request not the first argument', 'const hit = await readFrom(res, req); return record(hit);', "async function readFrom(_res: ServerResponse, _req: IncomingMessage): Promise<HitEvent> { return { code: '', at: '' }; }"],
  ];
  for (const [label, body, head] of dishonest) {
    it(`control: ${label} → \`hit\` stays UNREALIZED_PARAM`, () => {
      const issues = run(bodyTree(body, { head }));
      expect(messages(issues, 'UNREALIZED_PARAM'), said(issues)).toContain('declares 1 parameter(s) the function "acceptHit"');
    });
  }

  it('control: a collaborator reached through a field of the class is never a body helper', () => {
    const tree = bodyTree('return \'unused\';');
    tree.files = {
      ...(tree.files ?? {}),
      'src/stats-portal.ts': [
        "import type { IncomingMessage, ServerResponse } from './http.js';",
        'export function pathParams(req: IncomingMessage): Record<string, string> { return { code: req.url ?? \'\' }; }',
        'export class StatsPortal {',
        '  constructor(private readonly sink: { accept(req: IncomingMessage): string }) {}',
        "  getStats(req: IncomingMessage, res: ServerResponse): string { void res; const { code } = pathParams(req); return code + String(new URL(req.url ?? '/', 'http://x').searchParams.get('limit')); }",
        '  acceptHit(req: IncomingMessage, res: ServerResponse): string { void res; const placed = this.sink.accept(req); return String(placed); }',
        '}',
        '',
      ].join('\n'),
    };
    const issues = run(tree);
    expect(messages(issues, 'UNREALIZED_PARAM'), said(issues)).toContain('Method "acceptHit"');
  });

  it('an unrealized record through an injected request names both honest spellings with the method\'s own names', () => {
    const issues = run(bodyTree('return \'nothing\';'));
    const text = messages(issues, 'UNREALIZED_PARAM');
    expect(text, said(issues)).toContain('Through the injected request "req"');
    expect(text).toContain('`req.body`');
    expect(text).toContain('`const hit = await readJsonBody(req)`');
  });
});

describe('2. a Portal served by a class method (solo-app)', () => {
  it('routerLinkage reads `Class.method` and `file#Class.method`, and leaves a file and a plain name alone', () => {
    expect(routerLinkage('HabitPortal.handle')).toEqual({ owner: 'HabitPortal', name: 'handle' });
    expect(routerLinkage('src/http/habit-portal.ts#HabitPortal.handle')).toEqual({ file: 'src/http/habit-portal.ts', owner: 'HabitPortal', name: 'handle' });
    expect(routerLinkage('src/routes.ts')).toEqual({ file: 'src/routes.ts' });
    expect(routerLinkage('routes.ts')).toEqual({ file: 'routes.ts' });
    expect(routerLinkage('ROUTES')).toEqual({ name: 'ROUTES' });
  });

  for (const router of ['HabitPortal.handle', 'src/habit-portal.ts#HabitPortal.handle']) {
    it(`\`router: ${router}\` is accepted and read: clean, and an extra route is UNDECLARED_ROUTE`, () => {
      const clean = run(classRouterTree(router));
      for (const code of ['UNREALIZED_EXPORT_HANDLE', 'UNREADABLE_ROUTER', 'UNDECLARED_ROUTE', 'UNROUTED_ENDPOINT', 'ROUTER_UNDECLARED']) {
        expect(byCode(clean, code), said(clean)).toEqual([]);
      }
      const extra = run(classRouterTree(router, { extraRoute: true }));
      expect(messages(extra, 'UNDECLARED_ROUTE'), said(extra)).toContain('DELETE /habits/*');
    });
  }

  it('control: a method the class does not have, or a class nobody exports → UNREALIZED_EXPORT_HANDLE', () => {
    const missing = run(classRouterTree('HabitPortal.dispatch'));
    expect(messages(missing, 'UNREALIZED_EXPORT_HANDLE'), said(missing)).toContain('a class "HabitPortal" with a method "dispatch"');
    const hidden = run(classRouterTree('HabitPortal.handle', { exportClass: false }));
    expect(byCode(hidden, 'UNREALIZED_EXPORT_HANDLE'), said(hidden)).toHaveLength(1);
  });

  it('ROUTES_UNCHECKED (a router its files hold, named by nothing) suggests only accepted spellings, and says "export it" for the private table and function', () => {
    const issues = run(classRouterTree(undefined));
    const found = byCode(issues, 'ROUTES_UNCHECKED');
    expect(found, said(issues)).toHaveLength(1);
    expect(found[0].severity).toBe('warning');
    expect(byCode(issues, 'ROUTER_UNDECLARED')).toEqual([]);
    expect(found[0].message).toContain('HabitPortal.handle (src/habit-portal.ts)');
    expect(found[0].message).toMatch(/ROUTES \(src\/habit-portal\.ts\), matchRoute \(src\/habit-portal\.ts\) read as a router or a route table but are not exported[^.]*export the one the server dispatches/);
    expect(found[0].message).not.toMatch(/accepts it: [^.]*ROUTES/);
  });

  it('an exported table is suggested by its own name', () => {
    const issues = run(classRouterTree(undefined, { exportRoutes: true }));
    expect(messages(issues, 'ROUTES_UNCHECKED'), said(issues)).toMatch(/accepts it: .*ROUTES \(src\/habit-portal\.ts\)\./);
  });
});

describe('3. a Portal\'s own table left out of the table the server dispatches (tinkerer)', () => {
  const ownTables = (routesFile: string, files?: Record<string, string>): FixtureTree =>
    analyticsTree({ routesFile, router: { hit_ingest_portal: 'ingestRoutes', stats_portal: 'statsRoutes' }, files });

  it('`statsRoutes` named while `routes = [...ingestRoutes]` leaves it out → ROUTER_NOT_DISPATCHED (notice) naming the sibling', () => {
    const issues = run(ownTables(dispatchedRoutes(['ingestRoutes'])));
    const found = byCode(issues, 'ROUTER_NOT_DISPATCHED');
    expect(found, said(issues)).toHaveLength(1);
    expect(found[0].severity).toBe('notice');
    expect(found[0].message).toContain('"routes" (src/analytics/routes.ts)');
    expect(found[0].message).toContain('`src/analytics/routes.ts#routes`');
    expect(byCode(issues, 'UNROUTED_ENDPOINT')).toEqual([]);
  });

  it('the aggregate in another module importing the tables is followed too', () => {
    const issues = run(ownTables(dispatchedRoutes([]),
      { 'src/analytics/hit_ingest_portal.ts': SERVER_MODULE(['ingestRoutes']) }));
    expect(messages(issues, 'ROUTER_NOT_DISPATCHED'), said(issues)).toContain('"served" (src/analytics/hit_ingest_portal.ts)');
  });

  it('control: every table spread into the aggregate, or the aggregate itself named → silent', () => {
    expect(byCode(run(ownTables(dispatchedRoutes(['ingestRoutes', 'statsRoutes']))), 'ROUTER_NOT_DISPATCHED')).toEqual([]);
    const aggregate = analyticsTree({ routesFile: dispatchedRoutes(['ingestRoutes']) });
    implementationsOf(aggregate).forEach((impl) => { impl.router = 'routes'; });
    const issues = run(aggregate);
    expect(byCode(issues, 'ROUTER_NOT_DISPATCHED')).toEqual([]);
    expect(messages(issues, 'UNROUTED_ENDPOINT'), said(issues)).toContain('GET /stats/top');
  });
});

describe('5. a scalar realized by an opaque object, and an injection naming a contract parameter (solo-app)', () => {
  it('Q4 `checkIn(authorization, args: any)` reading `args.habitId`, `args.date` → PARAM_TYPE_MISMATCH on `date`', () => {
    const issues = run(checkInTree({ signature: 'authorization: string, args: any', body: 'return authorization + args.habitId + args.date;' }));
    const text = messages(issues, 'PARAM_TYPE_MISMATCH');
    expect(text, said(issues)).toContain('"date" (the code takes "args" typed "any", a type that admits any value, and reads it as an object (.date, .habitId), where the contract declares a string)');
    expect(messages(issues, 'UNREALIZED_PARAM')).toContain('"habitId"');
  });

  it('the same where the contract declares a `date` (the contract solo-app wrote) → PARAM_TYPE_MISMATCH; a Date read as one is not', () => {
    const issues = run(checkInTree({ dateType: 'date', signature: 'authorization: string, args: any', body: 'return authorization + args.habitId + args.date;' }));
    expect(messages(issues, 'PARAM_TYPE_MISMATCH'), said(issues)).toContain('where the contract declares a date)');
    const honest = run(checkInTree({ dateType: 'date', signature: 'authorization: string, habitId: string, date: any', body: 'return authorization + habitId + String(date.getTime());' }));
    expect(byCode(honest, 'PARAM_TYPE_MISMATCH'), said(honest)).toEqual([]);
  });

  it('control: an any-typed scalar read only as the string it is → no PARAM_TYPE_MISMATCH', () => {
    const issues = run(checkInTree({ signature: 'authorization: string, habitId: string, date: any', body: 'return authorization + habitId + date.trim() + String(date.length);' }));
    expect(byCode(issues, 'PARAM_TYPE_MISMATCH'), said(issues)).toEqual([]);
  });

  it('control: the honest signature → no parameter finding', () => {
    const issues = run(checkInTree({ signature: 'authorization: string, habitId: string, date: string', body: 'return authorization + habitId + date;' }));
    for (const code of ['PARAM_TYPE_MISMATCH', 'UNREALIZED_PARAM', 'UNDECLARED_PARAM']) expect(byCode(issues, code), said(issues)).toEqual([]);
  });

  it('Q7 injecting the contract\'s own names → UNREALIZED_PARAM naming the injection', () => {
    const issues = run(checkInTree({
      signature: 'authorization: string, habitId: string, date: string', body: 'return authorization + habitId + date;',
      injectedParams: ['authorization', 'habitId', 'date'],
    }));
    const text = messages(issues, 'UNREALIZED_PARAM');
    expect(text, said(issues)).toContain('The implementation\'s `injectedParams` names "habitId", "date" — the contract\'s own parameter(s)');
    expect(text).toContain('Drop them from `injectedParams`');
  });
});
