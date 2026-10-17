/**
 * What the code reaches, round nine — src/core/rules/conformance/param-conformance.ts,
 * route-coverage.ts, method-realization.ts and the parameter, read and route
 * facts of src/core/source-analysis.ts.
 *
 * Documented intents pinned here (rule descriptions):
 *  - Where the contract declares a record, a parameter typed opaquely (any,
 *    unknown, an index signature, no annotation in TypeScript) or as an object
 *    missing the record's fields or adding its own fails closed
 *    (PARAM_TYPE_MISMATCH).
 *  - A transport handle's name in a contract parameter's place is a
 *    substitution however the handle is typed and wherever the declared type
 *    lives (a member's type is read live); an object bundling scalar
 *    parameters names every one of them (UNREALIZED_PARAM).
 *  - A contract parameter read off an injected request through a URL built
 *    from it, a helper of the same file or of a file no implementation claims,
 *    or — for the one record left — the body read whole, is realized.
 *  - Route coverage is never silently off: no router named is ROUTER_UNDECLARED
 *    (a notice); a spread table is read, and one that does not settle is
 *    UNREADABLE_ROUTER; one literal table shared by two Portals is one router.
 *  - A conformance dial turned off is said as REALIZATION_UNCHECKED (a notice).
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';
import { routePortalTree } from '../../helpers/conformance-r7-trees.js';
import { centralRouterTree, ROUTES_MODULE, withDial } from '../../helpers/conformance-r8-trees.js';
import {
  analyticsRoutes,
  analyticsTree,
  implementationsOf,
  ordersTree,
  plannerTree,
  STATS_HEAD,
  statsTree,
} from '../../helpers/conformance-r9-trees.js';

/** A tree without its own project.yaml: the harness writes the fixture's. */
function bare(t: FixtureTree): FixtureTree {
  const files = { ...(t.files ?? {}) };
  delete files['.wai/project.yaml'];
  return { ...t, files };
}

/** The habits API with its route table in a central module and no router named. */
function routerUndeclared(): FixtureTree {
  const tree = bare(centralRouterTree(ROUTES_MODULE(), 'src/routes.ts#ROUTES'));
  delete implementationsOf(tree)[0].router;
  return tree;
}

/** The stats handlers, getStats reading its parameters as `body` says. */
const statsHandlers = (body: string): string => [
  STATS_HEAD,
  'export function pathParams(req: IncomingMessage): Record<string, string> {',
  "  return { code: (req.url ?? '').split('/')[2] ?? '' };",
  '}',
  `export function getStats(req: IncomingMessage, res: ServerResponse): string { void res; ${body} }`,
  'export function acceptHit(req: IncomingMessage, res: ServerResponse): string { void res; return String(req.body); }',
  '',
].join('\n');

export default [
  defineRuleFixture({
    code: 'PARAM_TYPE_MISMATCH',
    expectFire: true,
    severity: 'warning',
    scenario: 'The route planner\'s planRoute takes its request typed any where its contract declares the plan request record.',
    tree: bare(plannerTree({ planRoute: 'request: any' })),
  }),
  defineRuleFixture({
    code: 'PARAM_TYPE_MISMATCH',
    expectFire: true,
    severity: 'warning',
    scenario: 'The route planner\'s planRoute takes an inline object holding the stops and a secret where its contract declares the plan request record of stops, ref and tags.',
    tree: bare(plannerTree({ planRoute: 'request: { stops: unknown[]; secret: string }' })),
  }),
  defineRuleFixture({
    code: 'PARAM_TYPE_MISMATCH',
    expectFire: false,
    reason: 'The parameter is typed as the record itself.',
    scenario: 'The route planner\'s planRoute takes its request typed as the PlanRequest record its contract declares.',
    tree: bare(plannerTree()),
  }),
  defineRuleFixture({
    code: 'UNREALIZED_PARAM',
    expectFire: true,
    severity: 'warning',
    scenario: 'The orders service\'s cancelOrder is a handler taking a hand-typed request and response where its contract declares the order id and customer reference the contracts member project defines.',
    tree: ordersTree({ cancelOrder: 'req: Req, res: Res', body: "void res; return req.params.orderId ?? '';" }),
  }),
  defineRuleFixture({
    code: 'UNREALIZED_PARAM',
    expectFire: true,
    severity: 'warning',
    scenario: 'The orders service\'s cancelOrder takes one input object carrying the order id and customer id where its contract declares them as two parameters.',
    tree: ordersTree({ cancelOrder: 'input: { orderId: string; customerId: string }', body: 'return input.orderId + input.customerId;' }),
  }),
  defineRuleFixture({
    code: 'UNREALIZED_PARAM',
    expectFire: false,
    reason: 'Both parameters are read off the injected request through a URL built from it and a helper of the same file.',
    scenario: 'The link stats handler reads the short code through a path helper and the limit off the URL\'s search params of the request it is handed.',
    tree: bare(statsTree({ portal: statsHandlers("const url = new URL(req.url ?? '/', 'http://local'); const { code } = pathParams(req); return code + String(url.searchParams.get('limit'));") })),
  }),
  defineRuleFixture({
    code: 'ROUTER_UNDECLARED',
    expectFire: true,
    severity: 'notice',
    scenario: 'The habits API moved its route table to a central routes module and its Portal\'s implementation names no router.',
    tree: routerUndeclared(),
  }),
  defineRuleFixture({
    code: 'ROUTER_UNDECLARED',
    expectFire: false,
    reason: 'The implementation names the central table as its router.',
    scenario: 'The habits API Portal names the central routes module\'s table as its router.',
    tree: bare(centralRouterTree(ROUTES_MODULE(), 'src/routes.ts#ROUTES')),
  }),
  defineRuleFixture({
    code: 'UNROUTED_ENDPOINT',
    expectFire: true,
    severity: 'warning',
    scenario: 'The analytics service\'s ingest and stats Portals share one route table spread from their own tables, and the stats table lost its top-codes route.',
    tree: bare(analyticsTree({ routesFile: analyticsRoutes({ dropTop: true }) })),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_ROUTE',
    expectFire: false,
    reason: 'One literal table shared by two Portals is one router: each route is declared by one of them.',
    scenario: 'The analytics service\'s ingest and stats Portals both name the service\'s one literal route table as their router.',
    tree: bare(analyticsTree({ routesFile: analyticsRoutes({ spread: false }) })),
  }),
  defineRuleFixture({
    code: 'UNREADABLE_ROUTER',
    expectFire: true,
    severity: 'warning',
    scenario: 'The analytics service\'s shared route table spreads the result of a function call that settles on no table.',
    tree: bare(analyticsTree({
      routesFile: [analyticsRoutes(), 'export function extraRoutes() { return []; }', ''].join('\n').split('...statsRoutes]').join('...statsRoutes, ...extraRoutes()]'),
    })),
  }),
  defineRuleFixture({
    code: 'UNREADABLE_ROUTER',
    expectFire: false,
    reason: 'Every spread of the shared table names a table that settles.',
    scenario: 'The analytics service\'s shared route table spreads the ingest and stats tables.',
    tree: bare(analyticsTree({ routesFile: analyticsRoutes() })),
  }),
  defineRuleFixture({
    code: 'REALIZATION_UNCHECKED',
    expectFire: true,
    severity: 'notice',
    scenario: 'The route planner\'s Portal implementation has its conformance dial switched off.',
    tree: bare(withDial(routePortalTree({}), 'route_portal_impl', 'off')),
  }),
  defineRuleFixture({
    code: 'REALIZATION_UNCHECKED',
    expectFire: false,
    reason: 'No dial is off: the realization is checked.',
    scenario: 'The route planner\'s Portal implementation keeps the default conformance dial.',
    tree: bare(routePortalTree({})),
  }),
];
