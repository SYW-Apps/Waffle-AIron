import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { getStatusReport } from '../../src/core/status.js';
import { validateProject, type ValidationIssue } from '../../src/core/validation.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';
import { routePortalTree } from '../helpers/conformance-r7-trees.js';
import { centralRouterTree, ROUTES_MODULE, withDial } from '../helpers/conformance-r8-trees.js';
import {
  analyticsRoutes,
  analyticsTree,
  implementationsOf,
  ordersTree,
  plannerTree,
  STATS_HEAD,
  statsTree,
} from '../helpers/conformance-r9-trees.js';

// ---------------------------------------------------------------------------
// The code<->spec gaps the ninth round of user trials found:
//
//   1. Parameters fail closed: an opaque or partial type where a record is
//      declared (PARAM_TYPE_MISMATCH); a hand-typed handle beside contract
//      types from a member project; an object bundling scalar parameters.
//   2. The framework-handler green path: node:http reads (URL search params,
//      helpers of the same file or an unclaimed one, the body read whole).
//   3. UNUSED_INJECTED_PARAM is a notice: it hides nothing.
//   4. Route coverage is never silently off: no router declared, spread
//      tables, one literal table shared by two Portals.
//   5. `conformance: off` is said (REALIZATION_UNCHECKED, and in status).
//   6. A Portal binds its transport framework (TECH_ON_LOGIC_COMPONENT).
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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-round9-')));
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

const byCode = (issues: ValidationIssue[], code: string): ValidationIssue[] => issues.filter(i => i.code === code);
const said = (issues: ValidationIssue[]): string => issues.map(i => `${i.code}: ${i.message.slice(0, 500)}`).join('\n');
const messages = (issues: ValidationIssue[], code: string): string => byCode(issues, code).map(i => i.message).join('\n');
const PARAM_CODES = ['UNREALIZED_PARAM', 'UNDECLARED_PARAM', 'PARAM_NAME_MISMATCH', 'PARAM_OPTIONALITY', 'PARAM_TYPE_MISMATCH'];
const paramFindings = (issues: ValidationIssue[]): ValidationIssue[] => issues.filter(i => PARAM_CODES.includes(i.code));
const ROUTE_CODES = ['UNDECLARED_ROUTE', 'UNROUTED_ENDPOINT', 'UNREADABLE_ROUTER', 'ROUTER_UNDECLARED'];
const routeFindings = (issues: ValidationIssue[]): ValidationIssue[] => issues.filter(i => ROUTE_CODES.includes(i.code));

describe('1a. a record parameter fails closed on a type that cannot hold it (lib-and-app R9-8)', () => {
  for (const type of ['any', 'unknown', 'Record<string, unknown>', 'object']) {
    it(`\`planRoute(request: ${type})\` realizing \`planRoute(request: plan_request)\` → PARAM_TYPE_MISMATCH`, () => {
      const issues = run(plannerTree({ planRoute: `request: ${type}` }));
      const text = messages(issues, 'PARAM_TYPE_MISMATCH');
      expect(text, said(issues)).toContain(`"request" (the code takes "request" typed "${type}", a type that admits any value`);
      expect(text).toContain('the record "plan_request"');
    });
  }

  it('a partial object smuggling a field (`{ stops: unknown[]; secret: string }`) → PARAM_TYPE_MISMATCH naming what is missing and added', () => {
    const issues = run(plannerTree({ planRoute: 'request: { stops: unknown[]; secret: string }' }));
    expect(messages(issues, 'PARAM_TYPE_MISMATCH'), said(issues)).toContain('an object missing "ref", "tags" and adding "secret"');
  });

  it('every field of the record plus one more (`… secret: string`) → PARAM_TYPE_MISMATCH: the extra field is what rides unread', () => {
    const issues = run(plannerTree({ planRoute: 'request: { stops: string[]; ref: string; tags: string[]; secret: string }' }));
    expect(messages(issues, 'PARAM_TYPE_MISMATCH'), said(issues)).toContain('an object adding "secret"');
  });

  it('no annotation at all in a TypeScript file (`planRoute(request)`) → PARAM_TYPE_MISMATCH', () => {
    const issues = run(plannerTree({ planRoute: 'request' }));
    expect(messages(issues, 'PARAM_TYPE_MISMATCH'), said(issues)).toContain('"request" (the code takes "request" with no annotation');
  });

  it('control: the honest `planRoute(request: PlanRequest)` → nothing', () => {
    const issues = run(plannerTree());
    expect(paramFindings(issues), said(issues)).toEqual([]);
  });

  it('control: an inline object holding exactly the record\'s fields → nothing', () => {
    const issues = run(plannerTree({ planRoute: 'request: { stops: string[]; ref: string; tags: string[] }' }));
    expect(paramFindings(issues), said(issues)).toEqual([]);
  });

  it('control: unannotated JavaScript says nothing about a type it never wrote', () => {
    const issues = run(plannerTree({ javascript: true }));
    expect(byCode(issues, 'PARAM_TYPE_MISMATCH'), said(issues)).toEqual([]);
  });
});

describe('1b. a hand-typed handle beside a MEMBER\'s contract types is never a silent pairing (platform top-2)', () => {
  it('`cancelOrder(req: Req, res: Res)` reading nothing → both contract parameters substituted', () => {
    const issues = run(ordersTree({ cancelOrder: 'req: Req, res: Res', body: "void req; void res; return 'cancelled';" }));
    const text = messages(issues, 'UNREALIZED_PARAM');
    expect(text, said(issues)).toContain('"orderId" (the code takes "req", an object, where the contract declares a string)');
    expect(text).toContain('"customerId" (the code takes "res", an object, where the contract declares a string)');
  });

  it('`cancelOrder(req: Req, res: Res)` reading only orderId off req → still named, with the green path', () => {
    const issues = run(ordersTree({ cancelOrder: 'req: Req, res: Res', body: 'void res; return req.params.orderId;' }));
    const text = messages(issues, 'UNREALIZED_PARAM');
    expect(text, said(issues)).toContain('"orderId" (the code takes "req", an object');
    expect(text).toContain('`injectedParams`');
  });

  it('contract types of a project nothing resolves (`ghost::order_id`): the hand-typed handles are still substitutions', () => {
    const issues = run(ordersTree({ types: 'unresolved', cancelOrder: 'req: Req, res: Res', body: "void res; return req.params.orderId ?? '';" }));
    const text = messages(issues, 'UNREALIZED_PARAM');
    expect(text, said(issues)).toContain('"orderId" (the code takes "req", a transport handle, where the contract declares an argument of its own)');
    expect(text).toContain('"customerId" (the code takes "res", a transport handle');
  });

  it('`cancelOrder(ctx: Req, token: string)` → the handle substituted and the stray credential named as a rename of the member type it stands for', () => {
    const issues = run(ordersTree({ cancelOrder: 'ctx: Req, token: string', body: 'void token; return ctx.params.orderId;' }));
    expect(messages(issues, 'UNREALIZED_PARAM'), said(issues)).toContain('"orderId" (the code takes "ctx", an object');
    expect(messages(issues, 'PARAM_NAME_MISMATCH')).toContain('"customerId" (the code calls it "token")');
  });

  it('the member\'s types resolve live: `cancelOrder(orderId: number, …)` is a different kind of value from the member\'s order_id (a string)', () => {
    const issues = run(ordersTree({ cancelOrder: 'id: number, customerId: string', body: "void id; void customerId; return 'x';" }));
    expect(messages(issues, 'UNREALIZED_PARAM'), said(issues)).toContain('"orderId" (the code takes "id", a number, where the contract declares a string)');
  });

  it('control: the injected handles reading both parameters off req → nothing', () => {
    const issues = run(ordersTree({
      cancelOrder: 'req: Req, res: Res', injectedParams: ['req', 'res'],
      body: 'void res; const { orderId, customerId } = req.params; return orderId + customerId;',
    }));
    expect(paramFindings(issues), said(issues)).toEqual([]);
  });

  it('control: the contract\'s own parameters, typed by the member\'s code names → nothing', () => {
    const issues = run(ordersTree({ cancelOrder: 'orderId: string, customerId: string', body: 'return orderId + customerId;' }));
    expect(paramFindings(issues), said(issues)).toEqual([]);
  });
});

describe('1c. an object bundling scalar parameters names every one of them (platform O1/O3, solo-app O7)', () => {
  for (const types of ['member', 'string'] as const) {
    it(`\`cancelOrder(input: { orderId; customerId })\` (${types} types) → both unrealized, the object undeclared`, () => {
      const issues = run(ordersTree({ types, cancelOrder: 'input: { orderId: string; customerId: string }', body: 'return input.orderId + input.customerId;' }));
      const text = messages(issues, 'UNREALIZED_PARAM');
      expect(text, said(issues)).toContain('"orderId" (the code takes it inside the object "input"');
      expect(text).toContain('"customerId" (the code takes it inside the object "input"');
      expect(messages(issues, 'UNDECLARED_PARAM')).toContain('"input" (an object bundling the contract\'s own parameters orderId, customerId)');
      expect(byCode(issues, 'PARAM_NAME_MISMATCH')).toEqual([]);
    });
  }

  it('`cancelOrder(cmd: { id; who })` sharing no name (member types) → both unrealized, never "orderId" alone', () => {
    const issues = run(ordersTree({ cancelOrder: 'cmd: { id: string; who: string }', body: 'return cmd.id + cmd.who;' }));
    const text = messages(issues, 'UNREALIZED_PARAM');
    expect(text, said(issues)).toContain('"orderId"');
    expect(text).toContain('"customerId" (the code takes "cmd", an object, where the contract declares a string)');
  });

  it('control: an object carrying a field named like a parameter another argument already takes is no bundle', () => {
    const issues = run(ordersTree({ types: 'string', cancelOrder: 'orderId: string, customerId: string', body: 'return orderId + customerId;' }));
    expect(byCode(issues, 'UNDECLARED_PARAM'), said(issues)).toEqual([]);
  });
});

describe('2. the framework-handler green path reads what real handlers read (platform, tinkerer)', () => {
  const handlers = (getStats: string, acceptHit = "void res; return String(req.body);"): string => [
    STATS_HEAD,
    "import { readHit } from './hit-reader.js';",
    'export function pathParams(req: IncomingMessage): Record<string, string> {',
    "  const parts = (req.url ?? '').split('/');",
    '  return { code: parts[2] ?? \'\' };',
    '}',
    `export function getStats(req: IncomingMessage, res: ServerResponse): string { ${getStats} }`,
    `export function acceptHit(req: IncomingMessage, res: ServerResponse): string { ${acceptHit} }`,
    "void readHit;",
    '',
  ].join('\n');
  const reader = { 'src/hit-reader.ts': "export function readHit(body: unknown): string { return String(body); }\n" };

  it('`url.searchParams.get(\'limit\')` on a URL built from req, `const { code } = pathParams(req)` (a helper of the same file) → both realized', () => {
    const issues = run(statsTree({
      files: reader,
      portal: handlers("void res; const url = new URL(req.url ?? '/', 'http://local'); const limit = url.searchParams.get('limit'); const { code } = pathParams(req); return code + String(limit);"),
    }));
    expect(messages(issues, 'UNREALIZED_PARAM'), said(issues)).not.toContain('Method "getStats"');
  });

  it('a helper in a module no implementation claims, handed the request → its reads realize the parameters', () => {
    const issues = run(statsTree({
      files: {
        ...reader,
        'src/request-reader.ts': "import type { IncomingMessage } from './http.js';\nexport function statsQuery(req: IncomingMessage): { code: string; limit: string } { const url = new URL(req.url ?? '/', 'http://local'); return { code: url.pathname, limit: url.searchParams.get('limit') ?? '' }; }\n",
      },
      portal: handlers("void res; const { code, limit } = statsQuery(req); return code + limit;").split("import { readHit } from './hit-reader.js';").join("import { readHit } from './hit-reader.js';\nimport { statsQuery } from './request-reader.js';"),
    }));
    expect(messages(issues, 'UNREALIZED_PARAM'), said(issues)).not.toContain('Method "getStats"');
  });

  it('control: the same helper in a file another component\'s implementation claims is not followed → UNREALIZED_PARAM', () => {
    const issues = run(statsTree({
      claimOther: true,
      files: {
        ...reader,
        'src/other.ts': "import type { IncomingMessage } from './http.js';\nexport function count(code: string): string { return code; }\nexport function statsQuery(req: IncomingMessage): string { return (req.url ?? '') + 'code' + 'limit'; }\n",
      },
      portal: handlers('void res; return statsQuery(req);').split("import { readHit } from './hit-reader.js';").join("import { readHit } from './hit-reader.js';\nimport { statsQuery } from './other.js';"),
    }));
    expect(messages(issues, 'UNREALIZED_PARAM'), said(issues)).toContain('Method "getStats"');
  });

  it('the body IS the record: `acceptHit(hit: hit_event)` realized by reading `req.body` whole', () => {
    const issues = run(statsTree({
      files: reader,
      portal: handlers("void res; const { code } = pathParams(req); return code + String(new URL(req.url ?? '/', 'http://x').searchParams.get('limit'));", 'void res; return readHit(req.body);'),
    }));
    expect(messages(issues, 'UNREALIZED_PARAM'), said(issues)).not.toContain('Method "acceptHit"');
  });

  it('control: a handler reading neither the body nor the record\'s name → `hit` stays UNREALIZED_PARAM', () => {
    const issues = run(statsTree({
      files: reader,
      portal: handlers("void res; const { code } = pathParams(req); return code + String(new URL(req.url ?? '/', 'http://x').searchParams.get('limit'));", "void res; return req.method ?? '';"),
    }));
    expect(messages(issues, 'UNREALIZED_PARAM'), said(issues)).toContain('declares 1 parameter(s) the function "acceptHit"');
  });

  it('control: reading something else off the request → `code` stays UNREALIZED_PARAM', () => {
    const issues = run(statsTree({ files: reader, portal: handlers("void res; return req.headers['x-limit'] ?? '';") }));
    expect(messages(issues, 'UNREALIZED_PARAM'), said(issues)).toContain('"code"');
  });
});

describe('3. UNUSED_INJECTED_PARAM is a notice: an injection nothing takes hides nothing (solo-app top-1)', () => {
  it('a declared injection no function takes → a NOTICE, never a warning', () => {
    const found = byCode(run(routePortalTree({ injectedParams: ['req', 'pool'] })), 'UNUSED_INJECTED_PARAM');
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('notice');
    expect(found[0].message).toContain('"req", "pool"');
    expect(found[0].message).toContain('hides nothing');
  });
});

describe('4. route coverage is never silently off', () => {
  it('a route table in another module, no `router:` declared (solo-app O6b) → ROUTER_UNDECLARED naming router:', () => {
    const tree = centralRouterTree(ROUTES_MODULE(), 'src/routes.ts#ROUTES');
    delete implementationsOf(tree)[0].router;
    const issues = run(tree);
    const found = byCode(issues, 'ROUTER_UNDECLARED');
    expect(found, said(issues)).toHaveLength(1);
    expect(found[0].severity).toBe('notice');
    expect(found[0].message).toContain('names no router (`router:`)');
    expect(found[0].message).toContain('4 HTTP endpoint(s)');
  });

  it('control: the same tree with the router named → no ROUTER_UNDECLARED, every route judged', () => {
    const issues = run(centralRouterTree(ROUTES_MODULE(), 'src/routes.ts#ROUTES'));
    expect(routeFindings(issues), said(issues)).toEqual([]);
  });

  it('a spread table `[...ingestRoutes, ...statsRoutes]` named by both Portals → read: a dropped route is UNROUTED_ENDPOINT', () => {
    const issues = run(analyticsTree({ routesFile: analyticsRoutes({ dropTop: true }) }));
    expect(messages(issues, 'UNROUTED_ENDPOINT'), said(issues)).toContain('"GET /stats/top"');
    expect(byCode(issues, 'UNDECLARED_ROUTE')).toEqual([]);
  });

  it('control: the spread table intact → nothing', () => {
    const issues = run(analyticsTree({ routesFile: analyticsRoutes() }));
    expect(routeFindings(issues), said(issues)).toEqual([]);
  });

  it('a spread of a table another module exports is followed through the checker', () => {
    const routesFile = [
      "import { statsRoutes } from './stats-routes.js';",
      "export const ingestRoutes = [\n  { method: 'POST', path: '/hits', handler: 'recordHit' },\n];",
      'export const routes = [...ingestRoutes, ...statsRoutes];', '',
    ].join('\n');
    const files = { 'src/analytics/stats-routes.ts': "export const statsRoutes = [\n  { method: 'GET', path: '/stats/:code', handler: 'getStats' },\n];\n" };
    const issues = run(analyticsTree({ routesFile, files }));
    expect(messages(issues, 'UNROUTED_ENDPOINT'), said(issues)).toContain('"GET /stats/top"');
    expect(byCode(issues, 'UNREADABLE_ROUTER')).toEqual([]);
  });

  it('a table the Portal\'s file imports and names as its router is read where it is declared', () => {
    const tree = centralRouterTree(ROUTES_MODULE([
      "{ method: 'GET', path: '/habits', verb: 'listHabits' }",
      "{ method: 'GET', path: '/habits/:habitId', verb: 'getHabit' }",
      "{ method: 'POST', path: '/habits/:habitId/archive', verb: 'archiveHabit' }",
      "{ method: 'GET', path: '/me', verb: 'getMe' }",
      "{ method: 'DELETE', path: '/habits/:habitId', verb: 'deleteHabit' }",
    ]), 'ROUTES');
    tree.files!['src/habit-portal.ts'] = `import { ROUTES } from './routes.js';\nexport { ROUTES };\n${tree.files!['src/habit-portal.ts']}`;
    const issues = run(tree);
    expect(messages(issues, 'UNDECLARED_ROUTE'), said(issues)).toContain('"DELETE /habits/*"');
  });

  it('one literal table named by two Portals is ONE router: no Portal is blamed for the other\'s routes', () => {
    const issues = run(analyticsTree({ routesFile: analyticsRoutes({ spread: false }) }));
    expect(routeFindings(issues), said(issues)).toEqual([]);
  });

  it('the shared literal table with a route neither Portal declares → UNDECLARED_ROUTE once, naming both Portals', () => {
    const issues = run(analyticsTree({ routesFile: analyticsRoutes({ spread: false, extra: "  { method: 'DELETE', path: '/hits/:id', handler: 'dropHit' },\n" }) }));
    const found = byCode(issues, 'UNDECLARED_ROUTE');
    expect(found, said(issues)).toHaveLength(1);
    expect(found[0].message).toContain('"DELETE /hits/*"');
    expect(found[0].message).toContain('"hit_ingest_portal", "stats_portal"');
  });

  it('a spread of something that settles on no table → UNREADABLE_ROUTER, never silence', () => {
    const issues = run(analyticsTree({ routesFile: [analyticsRoutes(), 'export function extraRoutes() { return []; }', ''].join('\n').split('...statsRoutes]').join('...statsRoutes, ...extraRoutes()]') }));
    expect(messages(issues, 'UNREADABLE_ROUTER'), said(issues)).toContain('"routes"');
  });
});

describe('5. `conformance: off` is said, never silent (lib-and-app R9-14)', () => {
  it('the dial off on an implementation → REALIZATION_UNCHECKED, a notice naming it', () => {
    const issues = run(withDial(routePortalTree({ getRouteTiles: 'req: any, res: any' }), 'route_portal_impl', 'off'));
    const found = byCode(issues, 'REALIZATION_UNCHECKED');
    expect(found, said(issues)).toHaveLength(1);
    expect(found[0].severity).toBe('notice');
    expect(found[0].message).toContain('Realization not checked: conformance off on "route_portal_impl", on the implementation itself');
  });

  it('the dial off on one method → REALIZATION_UNCHECKED naming that method', () => {
    const issues = run(withDial(routePortalTree({}), 'route_portal_impl', 'off', 'getRouteTiles'));
    expect(messages(issues, 'REALIZATION_UNCHECKED'), said(issues)).toContain('on 1 method(s) of contract "iroute_portal" — "getRouteTiles"');
  });

  it('control: no dial → no REALIZATION_UNCHECKED', () => {
    expect(byCode(run(routePortalTree({})), 'REALIZATION_UNCHECKED')).toEqual([]);
  });

  it('`status` names the implementation whose dial is off', () => {
    const dir = tempDir();
    materialize(dir, withDial(routePortalTree({}), 'route_portal_impl', 'off'));
    setProjectRoot(dir);
    invalidateSpecCache();
    const report = getStatusReport();
    expect(report.text).toContain('Conformance off: route_portal_impl (every method) — realization not checked');
  });

  it('control: `status` with no dial off says nothing about it', () => {
    const dir = tempDir();
    materialize(dir, routePortalTree({}));
    setProjectRoot(dir);
    invalidateSpecCache();
    expect(getStatusReport().text).not.toContain('Conformance off:');
  });
});

describe('6. a Portal binds its transport framework (platform)', () => {
  const techTree = (portalTech: string[], storeTech: string[]): FixtureTree => ({
    system: { name: 'Recommendations', vision: 'Ranks products for each customer.', targetLanguage: 'Python' },
    subsystems: [{ id: 'recs', description: 'Recommendations over HTTP.' }],
    components: [
      {
        id: 'recommendation_portal', componentType: 'Portal', transport: 'HTTP', description: 'The recommendations HTTP API.', dependsOn: ['ranking_store'],
        invokedBy: { kind: 'entry', caller: 'The api-gateway, over the platform network' },
      },
      { id: 'ranking_store', componentType: 'Store', durability: 'read-through', description: 'Keeps the rankings per customer.', lint: { allow: [{ code: 'UNOWNED_STORE', reason: 'Keyed reads only.' }] } },
    ],
    interfaces: [
      { id: 'irecommendation_portal', component: 'recommendation_portal', methods: [{ name: 'get_recommendations', description: 'The ranked products.', params: [{ name: 'customer_id', type: 'string' }], returns: 'string', effect: 'read', endpoint: { transport: 'HTTP', method: 'GET', path: '/recommendations/{customer_id}' } }] },
      { id: 'iranking_store', component: 'ranking_store', methods: [{ name: 'find', description: 'One ranking.', params: [{ name: 'customer_id', type: 'string' }], returns: 'string', effect: 'read' }] },
    ],
    implementations: [
      { id: 'recommendation_portal_impl', contract: 'irecommendation_portal', technologies: portalTech, methods: [{ name: 'get_recommendations', detail: 'intent', intent: 'Answers the ranking.' }] },
      { id: 'ranking_store_impl', contract: 'iranking_store', technologies: storeTech, methods: [{ name: 'find', detail: 'intent', intent: 'Reads the ranking.' }] },
    ],
  });

  it('a Portal binding its web framework (fastapi) → no TECH_ON_LOGIC_COMPONENT', () => {
    const issues = run(techTree(['fastapi'], ['postgres']));
    expect(byCode(issues, 'TECH_ON_LOGIC_COMPONENT'), said(issues)).toEqual([]);
  });

  it('a Portal binding the data technology its Store binds (postgres) → TECH_ON_LOGIC_COMPONENT naming it', () => {
    const issues = run(techTree(['fastapi', 'postgres'], ['postgres']));
    const text = messages(issues, 'TECH_ON_LOGIC_COMPONENT');
    expect(text, said(issues)).toContain('binds postgres on Portal "recommendation_portal"');
    expect(text).not.toContain('fastapi');
  });
});
