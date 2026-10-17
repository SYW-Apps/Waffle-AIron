import type { FixtureTree } from '../rules-matrix/harness';
import { projectYaml } from './conformance-r6-trees.js';
import { routerTree } from './conformance-r7-trees.js';
import { STATS_HEAD, statsTree } from './conformance-r9-trees.js';

// ---------------------------------------------------------------------------
// The miniature systems the round-10 conformance fixes are judged on, shared by
// the unit tier (tests/core/conformance-round10.test.ts), the rule matrix
// (tests/rules-matrix/families/conformance-r10.fixtures.ts) and the journeys
// against the built CLI (tests/e2e/trials-r10-conformance.test.ts).
// ---------------------------------------------------------------------------

// ---- platform: the record read whole through a body helper ----

/** The body helper module no implementation claims: plain node:http has no `req.body`. */
export const BODY_MODULE = [
  "import type { IncomingMessage } from './http.js';",
  '// Plain node:http: the body arrives as a stream of chunks, never as a field.',
  'export function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {',
  '  return new Promise((resolve) => {',
  "    let text = '';",
  "    (req as unknown as { on(event: string, listener: (chunk: string) => void): void }).on('data', (chunk) => { text += chunk; });",
  "    resolve(JSON.parse(text || '{}') as T);",
  '  });',
  '}',
  '',
].join('\n');

/**
 * The stats handlers of Linkshort, getStats reading its parameters through a
 * path helper and the URL, acceptHit reading its body as `acceptHit` says —
 * the record `hit` handed in whole, or not.
 */
export const bodyHandlers = (acceptHit: string, o: { head?: string } = {}): string => [
  STATS_HEAD,
  "import type { HitEvent } from './hit-event.js';",
  "import { readJsonBody } from './body.js';",
  o.head ?? '',
  'export function pathParams(req: IncomingMessage): Record<string, string> {',
  "  return { code: (req.url ?? '').split('/')[2] ?? '' };",
  '}',
  'export function record(hit: HitEvent): string { return hit.code; }',
  "export function getStats(req: IncomingMessage, res: ServerResponse): string { void res; const { code } = pathParams(req); return code + String(new URL(req.url ?? '/', 'http://x').searchParams.get('limit')); }",
  `export async function acceptHit(req: IncomingMessage, res: ServerResponse): Promise<string> { void res; ${acceptHit} }`,
  'export type { HitEvent };',
  '',
].join('\n');

/** Linkshort's stats Portal with acceptHit's body as given, the body helper in its own unclaimed module. */
export function bodyTree(acceptHit: string, o: { head?: string } = {}): FixtureTree {
  const tree = statsTree({ portal: bodyHandlers(acceptHit, o), files: { 'src/body.ts': BODY_MODULE } });
  // acceptHit awaits its body: the contract says it completes later.
  const contract = (tree.interfaces as Array<{ methods: Array<Record<string, unknown>> }>)[0];
  const accept = contract.methods.find(m => m.name === 'acceptHit');
  if (accept) accept.returns = 'async string';
  return tree;
}

// ---- solo-app: a Portal served by a class method ----

/**
 * Habitly's Portal as a class whose `handle` method routes through a
 * module-private `matchRoute` over a module-private `ROUTES` table — round
 * 8's own layout — with `router` as given (none when undefined).
 */
export function classRouterTree(router: string | undefined, o: { extraRoute?: boolean; exportRoutes?: boolean; exportClass?: boolean } = {}): FixtureTree {
  const tree = routerTree('');
  const impl = (tree.implementations as Array<Record<string, unknown>>)[0];
  if (router === undefined) delete impl.router;
  else impl.router = router;
  tree.files = {
    ...(tree.files ?? {}),
    'src/habit-portal.ts': [
      'export interface HabitRequest { method?: string; url?: string }',
      'interface Route { method: string; path: string; verb: string }',
      `${o.exportRoutes ? 'export ' : ''}const ROUTES: Route[] = [`,
      "  { method: 'GET', path: '/habits', verb: 'listHabits' },",
      "  { method: 'GET', path: '/habits/:habitId', verb: 'getHabit' },",
      "  { method: 'POST', path: '/habits/:habitId/archive', verb: 'archiveHabit' },",
      "  { method: 'GET', path: '/me', verb: 'getMe' },",
      ...(o.extraRoute ? ["  { method: 'DELETE', path: '/habits/:habitId', verb: 'deleteHabit' },"] : []),
      '];',
      'function matchRoute(method: string, pathname: string): Route | undefined {',
      '  for (const route of ROUTES) if (route.method === method && route.path === pathname) return route;',
      '  return undefined;',
      '}',
      `${o.exportClass === false ? '' : 'export '}class HabitPortal {`,
      "  listHabits(): string { return 'habits'; }",
      "  getHabit(): string { return 'habit'; }",
      "  archiveHabit(): string { return 'archived'; }",
      "  getMe(): string { return 'me'; }",
      "  handle(req: HabitRequest): string | undefined { return matchRoute(req.method ?? 'GET', req.url ?? '/')?.verb; }",
      '}',
      '',
    ].join('\n'),
  };
  return tree;
}

// ---- tinkerer: a Portal's own table named while the server dispatches a sibling ----

/** The analytics routes module: each Portal's table, and `routes`, spreading the ones `dispatched` names. */
export const dispatchedRoutes = (dispatched: string[]): string => [
  "export const ingestRoutes = [\n  { method: 'POST', path: '/hits', handler: 'recordHit' },\n];",
  "export const statsRoutes = [\n  { method: 'GET', path: '/stats/top', handler: 'getTopCodes' },\n  { method: 'GET', path: '/stats/:code', handler: 'getStats' },\n];",
  `export const routes = [${dispatched.map(name => `...${name}`).join(', ')}];`,
  '',
].join('\n');

/** The aggregate in another module the design names (the ingest Portal's verbs), importing the Portals' tables. */
export const SERVER_MODULE = (dispatched: string[]): string => [
  "import { ingestRoutes, statsRoutes } from './routes.js';",
  `export const served = [${dispatched.map(name => `...${name}`).join(', ')}];`,
  'void ingestRoutes; void statsRoutes;',
  "export function recordHit(): string { return 'recorded'; }",
  '',
].join('\n');

// ---- solo-app: the parameter shapes of the class Portal's checkIn ----

export interface CheckInOptions {
  /** checkIn's realized signature. */
  signature: string;
  /** checkIn's body. */
  body: string;
  injectedParams?: string[];
  /** The contract type of `date` (default string). */
  dateType?: string;
}

/**
 * Habitly's check-in Portal: checkIn(habitId: string, date: string), the
 * credential injected ahead of them — realized the way the options say.
 */
export function checkInTree(o: CheckInOptions): FixtureTree {
  return {
    system: { name: 'Habitly', vision: 'A habit tracking API a solo developer can maintain.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'habits', description: 'Habits for the mobile app.' }],
    components: [{
      id: 'checkin_portal', componentType: 'Portal', transport: 'InProcess', description: 'The check-in API.',
      invokedBy: { kind: 'entry', caller: 'The Habitly mobile app, linking the API library' },
    }],
    interfaces: [{
      id: 'icheckin_portal', component: 'checkin_portal', methods: [{
        name: 'checkIn', description: 'Checks a habit in for a day.', returns: 'string', effect: 'none',
        params: [{ name: 'habitId', type: 'string' }, { name: 'date', type: o.dateType ?? 'string' }],
      }],
    }],
    implementations: [{
      id: 'checkin_portal_impl', contract: 'icheckin_portal', sourcePath: 'src/checkin-portal.ts',
      injectedParams: o.injectedParams ?? ['authorization'],
      methods: [{ name: 'checkIn', detail: 'intent', intent: 'Performs its one thing; failures surface as thrown errors.' }],
    }],
    files: {
      '.wai/project.yaml': projectYaml('habitly'),
      'src/checkin-portal.ts': [
        'export class CheckinPortal {',
        `  checkIn(${o.signature}): string { ${o.body} }`,
        '}',
        '',
      ].join('\n'),
    },
  };
}
