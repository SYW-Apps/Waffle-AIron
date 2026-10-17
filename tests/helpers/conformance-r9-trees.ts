import * as yaml from 'js-yaml';
import type { FixtureTree } from '../rules-matrix/harness';
import { projectYaml } from './conformance-r6-trees.js';

// ---------------------------------------------------------------------------
// The miniature systems the round-9 conformance fixes are judged on, shared by
// the unit tier (tests/core/conformance-round9.test.ts), the rule matrix
// (tests/rules-matrix/families/conformance-r9.fixtures.ts) and the journeys
// against the built CLI (tests/e2e/trials-r9-conformance.test.ts).
// ---------------------------------------------------------------------------

const INTENT = 'Performs its one thing; failures surface as thrown errors.';
const intent = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ name, detail: 'intent', intent: INTENT, ...extra });
const TS = '2026-10-09T00:00:00.000Z';
const dump = (value: unknown): string => yaml.dump(value, { noRefs: true, lineWidth: 200 });

// ---- lib-and-app: a record parameter realized by an opaque or partial type ----

export interface PlannerOptions {
  /** planRoute's realized signature (default: the contract's own, `request: PlanRequest`). */
  planRoute?: string;
  /** planRoute's body (default: `return 'planned';`). */
  planBody?: string;
  /** Write the Portal in plain JavaScript (`src/route-portal.js`) instead. */
  javascript?: boolean;
}

/**
 * RoutePlanner's Portal: planRoute(request: plan_request), plan_request a
 * record of stops, ref and tags — realized the way the options say.
 */
export function plannerTree(o: PlannerOptions = {}): FixtureTree {
  const file = o.javascript ? 'src/route-portal.js' : 'src/route-portal.ts';
  const signature = o.planRoute ?? (o.javascript ? 'request' : 'request: PlanRequest');
  return {
    system: { name: 'RoutePlanner', vision: 'Plans delivery routes for a dispatcher.', targetLanguage: o.javascript ? 'JavaScript' : 'TypeScript' },
    subsystems: [{ id: 'routing', description: 'Route planning for the dispatcher app.' }],
    components: [{
      id: 'route_portal', componentType: 'Portal', transport: 'InProcess', description: 'The route planner API.',
      invokedBy: { kind: 'entry', caller: 'The dispatcher web app, linking the planner library' },
    }],
    interfaces: [{
      id: 'iroute_portal', component: 'route_portal', methods: [
        { name: 'planRoute', description: 'Plans and files a route.', params: [{ name: 'request', type: 'plan_request' }], returns: 'string', effect: 'none' },
      ],
    }],
    types: [{
      id: 'plan_request', kind: 'value-object', subsystem: 'routing', name: 'PlanRequest', description: 'The stops a route visits, its reference and tags.',
      sourcePath: 'src/plan-request.ts',
      fields: [{ name: 'stops', type: 'list<string>' }, { name: 'ref', type: 'string' }, { name: 'tags', type: 'list<string>' }],
    }],
    implementations: [{ id: 'route_portal_impl', contract: 'iroute_portal', sourcePath: file, methods: [intent('planRoute')] }],
    files: {
      '.wai/project.yaml': projectYaml('route-planner'),
      'src/plan-request.ts': 'export interface PlanRequest { stops: string[]; ref: string; tags: string[] }\n',
      [file]: [
        ...(o.javascript ? [] : ["import type { PlanRequest } from './plan-request.js';", 'export type { PlanRequest };']),
        `export function planRoute(${signature}) { ${o.planBody ?? "return 'planned';"} }`,
        '',
      ].join('\n'),
    },
  };
}

// ---- platform: hand-typed handles, contract types from a MEMBER project ----

/** The contracts member project (`libs/contracts`, alias `shared`): ids as named scalars, and an order record. */
export function contractsMemberFiles(): Record<string, string> {
  const base = 'libs/contracts/.wai';
  const type = (id: string, name: string, extra: Record<string, unknown>): string => dump({
    schemaVersion: '1.0.0', id, name, kind: 'value-object', subsystem: 'ids', description: `The ${name} every service shares.`,
    ...extra, createdAt: TS, updatedAt: TS,
  });
  return {
    [`${base}/project.yaml`]: projectYaml('contracts'),
    [`${base}/specs/.index.yaml`]: dump({
      schemaVersion: '1.0.0', name: 'Contracts', vision: 'The types the shop services exchange.', targetLanguage: 'TypeScript',
      publicInterfaces: [
        { from: 'ids', typeDef: 'order_id', as: 'order_id' },
        { from: 'ids', typeDef: 'customer_ref', as: 'customer_ref' },
        { from: 'ids', typeDef: 'cancel_request', as: 'cancel_request' },
      ],
      createdAt: TS, updatedAt: TS,
    }),
    [`${base}/specs/subsystems/ids.yaml`]: dump({
      schemaVersion: '1.0.0', id: 'ids', name: 'Ids', description: 'Identifiers and requests the services share.', parentSystem: 'Contracts',
      publicInterfaces: [
        { typeDef: 'order_id', details: 'An order id.' },
        { typeDef: 'customer_ref', details: 'A customer reference.' },
        { typeDef: 'cancel_request', details: 'A request to cancel an order.' },
      ],
      createdAt: TS, updatedAt: TS,
    }),
    [`${base}/specs/types/order_id.yaml`]: type('order_id', 'OrderId', { holds: 'string', sourcePath: 'src/ids.ts' }),
    [`${base}/specs/types/customer_ref.yaml`]: type('customer_ref', 'CustomerRef', { holds: 'string', sourcePath: 'src/ids.ts' }),
    [`${base}/specs/types/cancel_request.yaml`]: type('cancel_request', 'CancelRequest', {
      sourcePath: 'src/ids.ts', fields: [{ name: 'orderId', type: 'order_id' }, { name: 'reason', type: 'string' }],
    }),
    'libs/contracts/src/ids.ts': 'export type OrderId = string;\nexport type CustomerRef = string;\nexport interface CancelRequest { orderId: OrderId; reason: string }\n',
  };
}

export interface OrdersOptions {
  /** cancelOrder's realized signature. */
  cancelOrder: string;
  /** cancelOrder's body (default: `return 'cancelled';`). */
  body?: string;
  injectedParams?: string[];
  /** The contract's parameter types: the member's (`shared::…`, default), plain strings, or another project's no member or pin resolves. */
  types?: 'member' | 'string' | 'unresolved';
}

/**
 * The orders service of the shop platform: a Portal whose contract is
 * cancelOrder(orderId, customerId), typed by the contracts MEMBER project, and
 * whose code declares its own request and response shapes by hand.
 */
export function ordersTree(o: OrdersOptions): FixtureTree {
  const member = (o.types ?? 'member') === 'member';
  const typed = (id: string): string => (o.types === 'string' ? 'string' : o.types === 'unresolved' ? `ghost::${id}` : `shared::${id}`);
  return {
    system: { name: 'ShopPlatform', vision: 'The online shop, one service per team.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'orders', description: 'Order lifecycle over the platform network.' }],
    components: [{
      id: 'order_portal', componentType: 'Portal', transport: 'InProcess', description: 'The orders service API.',
      invokedBy: { kind: 'entry', caller: 'The api-gateway service, through its order client' },
    }],
    interfaces: [{
      id: 'iorder_portal', component: 'order_portal', methods: [{
        name: 'cancelOrder', description: 'Cancels an order for its customer.', returns: 'string', effect: 'none',
        params: [{ name: 'orderId', type: typed('order_id') }, { name: 'customerId', type: typed('customer_ref') }],
      }],
    }],
    implementations: [{
      id: 'order_portal_impl', contract: 'iorder_portal', sourcePath: 'src/order-portal.ts',
      ...(o.injectedParams ? { injectedParams: o.injectedParams } : {}),
      methods: [intent('cancelOrder')],
    }],
    files: {
      '.wai/project.yaml': projectYaml('shop-platform', member ? { members: { shared: 'libs/contracts' } } : {}),
      ...(member ? contractsMemberFiles() : {}),
      'src/order-portal.ts': [
        'type Req = { params: Record<string, string>; body: unknown };',
        'type Res = { status(code: number): Res; json(body: unknown): void };',
        'export class OrderPortal {',
        `  cancelOrder(${o.cancelOrder}): string { ${o.body ?? "return 'cancelled';"} }`,
        '}',
        'export type { Req, Res };',
        '',
      ].join('\n'),
    },
  };
}

// ---- platform / tinkerer: node:http handlers reading the request ----

export interface StatsOptions {
  /** The handlers' source (the whole file). */
  portal: string;
  /** Extra files (a helper module, another component's file). */
  files?: Record<string, string>;
  /** Claim `src/other.ts` for another component (a Store), so a helper there is not followed. */
  claimOther?: boolean;
}

/**
 * Linkshort's stats Portal written as node:http handlers `(req, res)` with
 * the handles injected: getStats(code, limit?) and acceptHit(hit: hit_event),
 * the body of POST /hits being the record itself.
 */
export function statsTree(o: StatsOptions): FixtureTree {
  return {
    system: { name: 'Linkshort', vision: 'Short links and the stats of their hits.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'analytics', description: 'Hit ingestion and stats.' }],
    components: [
      {
        id: 'stats_portal', componentType: 'Portal', transport: 'InProcess', description: 'The stats API handlers.',
        invokedBy: { kind: 'entry', caller: 'The node:http server in main.ts, routing each request to its handler' },
      },
      ...(o.claimOther ? [{
        id: 'hit_store', componentType: 'Store', durability: 'read-through', description: 'Keeps hit counts per short code.',
        invokedBy: { kind: 'runtime', caller: 'The composition root, which hands it to the handlers' },
        lint: { allow: [{ code: 'UNOWNED_STORE', reason: 'Keyed reads and writes only; the fixture needs a claimed file.' }] },
      }] : []),
    ],
    interfaces: [
      {
        id: 'istats_portal', component: 'stats_portal', methods: [
          {
            name: 'getStats', description: 'The stats of one short code.', returns: 'string', effect: 'none',
            params: [{ name: 'code', type: 'string' }, { name: 'limit', type: 'int', optional: true }],
          },
          { name: 'acceptHit', description: 'Records one hit.', returns: 'string', effect: 'none', params: [{ name: 'hit', type: 'hit_event' }] },
        ],
      },
      ...(o.claimOther ? [{
        id: 'ihit_store', component: 'hit_store', methods: [
          { name: 'count', description: 'The hits of one code.', params: [{ name: 'code', type: 'string' }], returns: 'string', effect: 'read' },
        ],
      }] : []),
    ],
    types: [{
      id: 'hit_event', kind: 'value-object', subsystem: 'analytics', name: 'HitEvent', description: 'One hit on a short link.', sourcePath: 'src/hit-event.ts',
      fields: [{ name: 'code', type: 'string' }, { name: 'at', type: 'string' }],
    }],
    implementations: [
      { id: 'stats_portal_impl', contract: 'istats_portal', sourcePath: 'src/stats-portal.ts', injectedParams: ['req', 'res'], methods: [intent('getStats'), intent('acceptHit')] },
      ...(o.claimOther ? [{ id: 'hit_store_impl', contract: 'ihit_store', sourcePath: 'src/other.ts', methods: [intent('count')] }] : []),
    ],
    files: {
      '.wai/project.yaml': projectYaml('linkshort'),
      'src/hit-event.ts': 'export interface HitEvent { code: string; at: string }\n',
      'src/http.ts': 'export interface IncomingMessage { url?: string; method?: string; body?: unknown; headers: Record<string, string> }\nexport interface ServerResponse { end(text: string): void }\n',
      'src/stats-portal.ts': o.portal,
      ...(o.files ?? {}),
    },
  };
}

/** The stats handlers' module head: the handle types from the local http module. */
export const STATS_HEAD = "import type { IncomingMessage, ServerResponse } from './http.js';";

// ---- routers: a table in another module, spread tables, shared tables ----

/** One Portal of the analytics service: its id, verbs and their routes. */
interface AnalyticsPortal { id: string; verbs: Array<{ name: string; method: string; path: string }> }

export const INGEST: AnalyticsPortal = { id: 'hit_ingest_portal', verbs: [{ name: 'recordHit', method: 'POST', path: '/hits' }] };
export const STATS: AnalyticsPortal = {
  id: 'stats_portal',
  verbs: [{ name: 'getTopCodes', method: 'GET', path: '/stats/top' }, { name: 'getStats', method: 'GET', path: '/stats/{code}' }],
};

/** The analytics routes module: each Portal's own table, and `routes`, the whole service's (spread, or written out). */
export const analyticsRoutes = (o: { spread?: boolean; dropTop?: boolean; extra?: string; tail?: string } = {}): string => [
  `export const ingestRoutes = [\n  { method: 'POST', path: '/hits', handler: 'recordHit' },\n];`,
  `export const statsRoutes = [\n${o.dropTop ? '' : "  { method: 'GET', path: '/stats/top', handler: 'getTopCodes' },\n"}  { method: 'GET', path: '/stats/:code', handler: 'getStats' },\n];`,
  o.spread === false
    ? `export const routes = [\n  { method: 'POST', path: '/hits', handler: 'recordHit' },\n${o.dropTop ? '' : "  { method: 'GET', path: '/stats/top', handler: 'getTopCodes' },\n"}  { method: 'GET', path: '/stats/:code', handler: 'getStats' },\n${o.extra ?? ''}];`
    : `export const routes = [...ingestRoutes, ...statsRoutes${o.tail ?? ''}];`,
  '',
].join('\n');

/**
 * Linkshort's analytics service: two Portals (ingest, stats) whose
 * implementations both name `router` — by default one route table both
 * share, the tinkerer's T2 shape.
 */
export function analyticsTree(o: { routesFile: string; router?: Partial<Record<string, string>>; files?: Record<string, string> }): FixtureTree {
  const portals = [INGEST, STATS];
  return {
    system: { name: 'Linkshort', vision: 'Short links and the stats of their hits.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'analytics', description: 'Hit ingestion and stats.' }],
    components: portals.map(p => ({
      id: p.id, componentType: 'Portal', transport: 'HTTP', description: `The ${p.id.replace(/_/g, ' ')} HTTP API.`,
      invokedBy: { kind: 'entry', caller: 'Browsers and the link redirector, over HTTPS' },
    })),
    interfaces: portals.map(p => ({
      id: `i${p.id}`, component: p.id,
      methods: p.verbs.map(v => ({
        name: v.name, description: `${v.name} over HTTP.`, returns: 'string', effect: 'none',
        endpoint: { transport: 'HTTP', method: v.method, path: v.path },
      })),
    })),
    implementations: portals.map(p => {
      const router = o.router?.[p.id] ?? (o.router && p.id in o.router ? undefined : 'routes');
      return {
        id: `${p.id}_impl`, contract: `i${p.id}`, sourcePath: 'src/analytics/routes.ts',
        ...(router ? { router } : {}),
        methods: p.verbs.map(v => intent(v.name, { sourcePath: `src/analytics/${p.id}.ts` })),
      };
    }),
    files: {
      '.wai/project.yaml': projectYaml('linkshort'),
      'src/analytics/routes.ts': o.routesFile,
      'src/analytics/hit_ingest_portal.ts': "export function recordHit(): string { return 'recorded'; }\n",
      'src/analytics/stats_portal.ts': "export function getTopCodes(): string { return 'top'; }\nexport function getStats(): string { return 'stats'; }\n",
      ...(o.files ?? {}),
    },
  };
}

/** A tree's implementations, typed for the edits a test makes. */
export const implementationsOf = (tree: FixtureTree): Array<Record<string, unknown> & { id: string }> =>
  (tree.implementations ?? []) as Array<Record<string, unknown> & { id: string }>;
