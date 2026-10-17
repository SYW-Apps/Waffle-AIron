import type { FixtureTree } from '../rules-matrix/harness';
import { projectYaml } from './conformance-r6-trees.js';

// ---------------------------------------------------------------------------
// The miniature systems the round-7 conformance fixes are judged on, shared by
// the unit tier (tests/core/conformance-round7.test.ts), the rule matrix
// (tests/rules-matrix/families/conformance-r7.fixtures.ts) and the journeys
// against the built CLI (tests/e2e/trials-r7-conformance.test.ts).
// ---------------------------------------------------------------------------

const INTENT = 'Performs its one thing; failures surface as thrown errors.';
const intent = (name: string): Record<string, unknown> => ({ name, detail: 'intent', intent: INTENT });

/** Habitly's Store written the closure way: an interface a factory realizes, no class. */
export const CLOSURE_STORE_FILE = [
  'export interface HabitStore {',
  '  addCheckIn(id: string): string;',
  '  find(id: string): string;',
  '}',
  'export function createHabitStore(): HabitStore {',
  '  return { addCheckIn: (id: string) => id, find: (id: string) => id };',
  '}', '',
].join('\n');

export interface ClassPortalOptions {
  /** How the Portal holds the Store: an optional, a required or a `| undefined` constructor field, or none. */
  store: 'optional' | 'required' | 'union' | 'none';
  /** The statement(s) written before the narrated dispatch in checkIn. */
  pre: string;
  /** Whether checkIn is declared async (a non-async one reads `await (x)` as a call to a name nothing declares). */
  async?: boolean;
}

/** Habitly's Portal written as a class with the Store a constructor field — the shape solo-app's round-7 code took. */
export function classPortal(o: ClassPortalOptions): string {
  const field = o.store === 'optional' ? 'private readonly store?: HabitStore'
    : o.store === 'union' ? 'private readonly store: HabitStore | undefined'
      : o.store === 'required' ? 'private readonly store: HabitStore' : '';
  return [
    "import type { HabitOrchestrator } from './habit-orchestrator.js';",
    o.store === 'none' ? '' : "import type { HabitStore } from './habit-store.js';",
    'export class HabitPortal {',
    `  constructor(private readonly habits: HabitOrchestrator${field ? `, ${field}` : ''}) {}`,
    `  ${o.async ? 'async ' : ''}checkIn(id: string): ${o.async ? 'Promise<string>' : 'string'} {`,
    `    ${o.pre}`,
    '    return this.habits.checkIn(id);',
    '  }',
    '}', '',
  ].join('\n');
}

export interface RoutePortalOptions {
  /** The realized signatures of the three verbs (defaults: the contract's own). */
  planRoute?: string;
  getRoute?: string;
  getRouteTiles?: string;
  injectedParams?: string[];
  /** Take IncomingMessage from node:http (unresolvable without @types/node) instead of declaring it locally. */
  nodeHttp?: boolean;
  /** Add a private dispatch table keyed by the same verb names, as a router module writes one. */
  dispatchTable?: boolean;
  /** planRoute's body (default: `return 'planned';`). */
  planBody?: string;
}

/**
 * RoutePlanner's HTTP Portal: planRoute(request: plan_request), getRoute(id),
 * getRouteTiles(id, zoom?), realized as a class whose handlers take what the
 * options say — the shapes lib-and-app's round-7 handlers took.
 */
export function routePortalTree(o: RoutePortalOptions): FixtureTree {
  const signatures = {
    planRoute: o.planRoute ?? 'request: PlanRequest',
    getRoute: o.getRoute ?? 'id: string',
    getRouteTiles: o.getRouteTiles ?? 'id: string, zoom?: number',
  };
  return {
    system: { name: 'RoutePlanner', vision: 'Plans delivery routes for a dispatcher.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'routing', description: 'Route planning over HTTP.' }],
    components: [{
      id: 'route_portal', componentType: 'Portal', transport: 'InProcess', description: 'The route planner API.',
      invokedBy: { kind: 'entry', caller: 'The dispatcher web app, over the node:http server in main.ts' },
    }],
    interfaces: [{
      id: 'iroute_portal', component: 'route_portal', methods: [
        { name: 'planRoute', description: 'Plans and files a route.', params: [{ name: 'request', type: 'plan_request' }], returns: 'string', effect: 'none' },
        { name: 'getRoute', description: 'A planned route by id.', params: [{ name: 'id', type: 'string' }], returns: 'string', effect: 'none' },
        {
          name: 'getRouteTiles', description: 'The map tiles covering a route.',
          params: [{ name: 'id', type: 'string' }, { name: 'zoom', type: 'int', optional: true }], returns: 'string', effect: 'none',
        },
      ],
    }],
    types: [{
      id: 'plan_request', kind: 'value-object', subsystem: 'routing', name: 'PlanRequest', description: 'The stops a route visits.', sourcePath: 'src/route-portal.ts',
      fields: [{ name: 'stops', type: 'list<string>' }],
    }],
    implementations: [{
      id: 'route_portal_impl', contract: 'iroute_portal', sourcePath: 'src/route-portal.ts',
      ...(o.injectedParams ? { injectedParams: o.injectedParams } : {}),
      methods: [intent('planRoute'), intent('getRoute'), intent('getRouteTiles')],
    }],
    files: {
      '.wai/project.yaml': projectYaml('route-planner'),
      'src/route-portal.ts': [
        o.nodeHttp ? "import type { IncomingMessage } from 'node:http';" : 'export interface IncomingMessage { url?: string; headers: Record<string, string> }',
        'export interface RequestUrl { pathname: string; search: string }',
        'export interface PlanRequest { stops: string[] }',
        'export class RoutePortal {',
        `  planRoute(${signatures.planRoute}): string { ${o.planBody ?? "return 'planned';"} }`,
        `  getRoute(${signatures.getRoute}): string { return 'route'; }`,
        `  getRouteTiles(${signatures.getRouteTiles}): string { return 'tiles'; }`,
        '}',
        ...(o.dispatchTable ? [
          'const DISPATCH = {',
          '  planRoute: (portal: RoutePortal, req: IncomingMessage): string => portal.getRoute(String(req.url)),',
          '};',
          'export const dispatchCount = Object.keys(DISPATCH).length;',
        ] : []),
        '',
      ].join('\n'),
    },
  };
}

/** One HTTP endpoint of the Habitly API Portal the router trees serve. */
interface HabitEndpoint { name: string; method: string; path: string }

/** The Habitly API's endpoints, written under the Portal's basePath `/v1`. */
export const HABIT_ENDPOINTS: HabitEndpoint[] = [
  { name: 'listHabits', method: 'GET', path: '/habits' },
  { name: 'getHabit', method: 'GET', path: '/habits/{habitId}' },
  { name: 'archiveHabit', method: 'POST', path: '/habits/{habitId}/archive' },
  { name: 'getMe', method: 'GET', path: '/me' },
];

/**
 * The Habitly HTTP Portal (basePath `/v1`) with its router entry
 * `routeHabitRequest` written as `router` says — the shapes solo-app's and
 * lib-and-app's round-7 routers took.
 */
export function routerTree(router: string, endpoints: HabitEndpoint[] = HABIT_ENDPOINTS): FixtureTree {
  return {
    system: { name: 'Habitly', vision: 'A habit tracking API a solo developer can maintain.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'habits', description: 'Habits over HTTP.' }],
    components: [{
      id: 'habit_portal', componentType: 'Portal', transport: 'HTTP', basePath: '/v1', description: 'The habits HTTP API.',
      invokedBy: { kind: 'entry', caller: 'The Habitly mobile app and web client, over HTTPS with a bearer token' },
    }],
    interfaces: [{
      id: 'ihabit_portal', component: 'habit_portal',
      methods: endpoints.map(endpoint => ({
        name: endpoint.name, description: `${endpoint.name} over HTTP.`, returns: 'string', effect: 'none',
        endpoint: { transport: 'HTTP', method: endpoint.method, path: endpoint.path },
      })),
    }],
    implementations: [{
      id: 'habit_portal_impl', contract: 'ihabit_portal', sourcePath: 'src/habit-portal.ts', router: 'routeHabitRequest',
      methods: endpoints.map(endpoint => intent(endpoint.name)),
    }],
    files: {
      '.wai/project.yaml': projectYaml('habitly'),
      'src/habit-portal.ts': [
        'export interface HabitRequest { method?: string; url?: string }',
        "export function listHabits(): string { return 'habits'; }",
        "export function getHabit(): string { return 'habit'; }",
        "export function archiveHabit(): string { return 'archived'; }",
        "export function getMe(): string { return 'me'; }",
        router,
        '',
      ].join('\n'),
    },
  };
}

/** solo-app's router: it strips `BASE = '/v1/habits'` off the path before splitting it — the same URLs the endpoints name under basePath `/v1`. */
export const PREFIX_ROUTER = [
  "const BASE = '/v1/habits';",
  'export function routeHabitRequest(req: HabitRequest): string | undefined {',
  "  const pathname = req.url ?? '/';",
  "  if (pathname !== BASE && !pathname.startsWith(BASE + '/')) return undefined;",
  "  const parts = pathname.slice(BASE.length).split('/').filter((s) => s !== '');",
  '  if (parts.length === 0) {',
  "    if (req.method === 'GET') return listHabits();",
  '  } else {',
  "    if (parts.length === 1 && req.method === 'GET') return getHabit();",
  "    if (parts.length === 2 && parts[1] === 'archive' && req.method === 'POST') return archiveHabit();",
  '  }',
  '  return undefined;',
  '}',
].join('\n');

/** lib-and-app's router: the entry delegates to a helper that reads a route table, under BASE_PATH. */
export const tableRouter = (entries: string[]): string => [
  "const ROUTES = [",
  ...entries.map(entry => `  ${entry},`),
  '];',
  'function resolveRoute(method: string, path: string): string | undefined {',
  '  for (const route of ROUTES) if (route.method === method && route.path === path) return route.verb;',
  '  return undefined;',
  '}',
  'export function routeHabitRequest(req: HabitRequest): string | undefined {',
  "  return resolveRoute(req.method ?? 'GET', req.url ?? '/');",
  '}',
].join('\n');

/** The table entries matching the Habitly endpoints, paths under the basePath. */
export const HABIT_TABLE = [
  "{ method: 'GET', path: '/habits', verb: 'listHabits' }",
  "{ method: 'GET', path: '/habits/:habitId', verb: 'getHabit' }",
  "{ method: 'POST', path: `/habits/:habitId/${ARCHIVE}`, verb: 'archiveHabit' }",
  "{ method: 'GET', path: ME, verb: 'getMe' }",
];

/** The constants HABIT_TABLE reads. */
export const TABLE_CONSTANTS = "const ARCHIVE = 'archive';\nconst ME = '/me';";

/**
 * A platform project whose code imports a type from a SIBLING project's
 * source (`../contracts`, a folder holding its own .wai/project.yaml) — the
 * shape platform's round-7 gateway took. `importLine` is the import the
 * resolver's file writes; the contracts file exports CustomerRef only.
 */
export function crossProjectPlatform(importLine: string): { platform: FixtureTree; contracts: Record<string, string> } {
  return {
    platform: {
      system: { name: 'Platform', vision: 'The API gateway of the platform.', targetLanguage: 'TypeScript' },
      subsystems: [{ id: 'gateway', description: 'Authentication at the edge.' }],
      components: [{
        id: 'principal_resolver', componentType: 'Portal', transport: 'InProcess', description: 'Resolves the principal a token names.',
        invokedBy: { kind: 'entry', caller: 'The gateway middleware every request passes through' },
      }],
      interfaces: [{
        id: 'iprincipal_resolver', component: 'principal_resolver',
        methods: [{ name: 'resolve', description: 'The customer a token names.', params: [{ name: 'token', type: 'string' }], returns: 'string', effect: 'none' }],
      }],
      implementations: [{
        id: 'principal_resolver_impl', contract: 'iprincipal_resolver', sourcePath: 'src/principal.ts',
        methods: [{ name: 'resolve', narrative: [{ stepNumber: 1, type: 'return', description: 'Answer the customer the token names', outcome: 'success' }] }],
      }],
      files: {
        '.wai/project.yaml': projectYaml('platform'),
        'src/principal.ts': `${importLine}\nexport function resolve(token: string): string { return token; }\n`,
      },
    },
    contracts: {
      '.wai/project.yaml': projectYaml('contracts'),
      'src/ids.ts': 'export type CustomerRef = string;\n',
    },
  };
}
