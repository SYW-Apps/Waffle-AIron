import type { FixtureTree } from '../rules-matrix/harness';
import { habitly, orchestratorFile, projectYaml, type HabitlyOptions } from './conformance-r6-trees.js';
import { HABIT_ENDPOINTS, routerTree } from './conformance-r7-trees.js';

// ---------------------------------------------------------------------------
// The miniature systems the round-8 conformance fixes are judged on, shared by
// the unit tier (tests/core/conformance-round8.test.ts), the rule matrix
// (tests/rules-matrix/families/conformance-r8.fixtures.ts) and the journeys
// against the built CLI (tests/e2e/trials-r8-conformance.test.ts).
// ---------------------------------------------------------------------------

/** A tree with one implementation's (or one method's) conformance dial set. */
export function withDial(tree: FixtureTree, implementation: string, tier: 'off' | 'declared' | 'anchored', method?: string): FixtureTree {
  const impls = (tree.implementations ?? []) as Array<Record<string, unknown> & { id: string; methods: Array<Record<string, unknown>> }>;
  const impl = impls.find(i => i.id === implementation);
  if (!impl) throw new Error(`no implementation ${implementation}`);
  if (method) {
    const m = impl.methods.find(x => x.name === method);
    if (!m) throw new Error(`no method ${method}`);
    m.conformance = tier;
  } else {
    impl.conformance = tier;
  }
  return tree;
}

/**
 * Habitly's Portal holding its Store through a port of its own (`CheckinSink`),
 * with `pre` written before the narrated dispatch — the shape platform's first
 * PR took while the Store's code was still planned.
 */
export const sinkPortal = (pre: string): string => [
  "import type { HabitOrchestrator } from './habit-orchestrator.js';",
  'export interface CheckinSink { addCheckIn(id: string): string; find(id: string): string; }',
  'export class HabitPortal {',
  '  constructor(private readonly habits: HabitOrchestrator, private readonly sink: CheckinSink) {}',
  `  checkIn(id: string): string { ${pre} return this.habits.checkIn(id); }`,
  '}', '',
].join('\n');

/** The legacy JSON helper whose result is typed any — tinkerer's `parseJson`. */
export const JSON_HELPER = 'export function parseJson(text: string): any { return JSON.parse(text); }\n';

/** Habitly with the Portal written as a class holding the Store, `pre` before its dispatch, and the any-typed JSON helper in reach. */
export function anyPortal(pre: string, o: HabitlyOptions = {}): FixtureTree {
  return habitly({
    ...o,
    files: { 'src/json.ts': JSON_HELPER, ...(o.files ?? {}) },
    portal: [
      "import { parseJson } from './json.js';",
      "import type { HabitOrchestrator } from './habit-orchestrator.js';",
      "import type { HabitStore } from './habit-store.js';",
      'export class HabitPortal {',
      '  constructor(private readonly habits: HabitOrchestrator, private readonly store: HabitStore) {}',
      '  checkIn(id: string): string {',
      `    ${pre}`,
      '    return this.habits.checkIn(id);',
      '  }',
      '}', '',
    ].join('\n'),
  });
}

/** Habitly whose Orchestrator also writes in `streak`, which its narrative never claims — what the converse direction judges. */
export function unnarratedWrite(): FixtureTree {
  return habitly({ orchestrator: orchestratorFile({ extra: 'this.checkins.addCheckIn(id);' }) });
}

/** Habitly with the check-in Store realized in Rust: the TypeScript Orchestrator reaches it through a binding. */
export function rustStoreTree(): FixtureTree {
  const tree = habitly({
    store: null,
    orchestrator: orchestratorFile({ storeImport: "import type { HabitStore } from './store-binding.js';" }),
    files: {
      'src/habit_store.rs': 'pub struct HabitStore;\nimpl HabitStore {\n    pub fn add_check_in(&self, id: &str) -> String { id.to_string() }\n    pub fn find(&self, id: &str) -> String { id.to_string() }\n}\n',
      'src/store-binding.ts': 'export interface HabitStore { addCheckIn(id: string): string; find(id: string): string; }\n',
    },
  });
  const impls = tree.implementations as Array<Record<string, unknown> & { id: string }>;
  const store = impls.find(i => i.id === 'habit_store_impl')!;
  store.sourcePath = 'src/habit_store.rs';
  (store.methods as Array<Record<string, unknown>>)[0].symbol = 'add_check_in';
  const orchestrator = impls.find(i => i.id === 'habit_orchestrator_impl')!;
  orchestrator.bindings = ['src/store-binding.ts'];
  return tree;
}

/**
 * A Habitly HTTP Portal whose router lives in a CENTRAL module (`src/routes.ts`),
 * named by `router` in one of the linkage's spellings.
 */
export function centralRouterTree(routesModule: string, router: string, endpoints = HABIT_ENDPOINTS): FixtureTree {
  const tree = routerTree('', endpoints);
  const impl = (tree.implementations as Array<Record<string, unknown>>)[0];
  impl.router = router;
  tree.files = { ...(tree.files ?? {}), 'src/routes.ts': routesModule };
  return tree;
}

/** The Habitly route table as a central module's exported const. */
export const ROUTES_MODULE = (entries: string[] = [
  "{ method: 'GET', path: '/habits', verb: 'listHabits' }",
  "{ method: 'GET', path: '/habits/:habitId', verb: 'getHabit' }",
  "{ method: 'POST', path: '/habits/:habitId/archive', verb: 'archiveHabit' }",
  "{ method: 'GET', path: '/me', verb: 'getMe' }",
]): string => [
  'export const ROUTES = [',
  ...entries.map(entry => `  ${entry},`),
  '];',
  '',
].join('\n');

/** platform's router: an object keyed by template literals over a `const PREFIX`. */
export const PREFIX_KEYED_ROUTER = (extra = ''): string => [
  "const PREFIX = '/habits';",
  'const TABLE = {',
  '  [`GET ${PREFIX}`]: listHabits,',
  '  [`GET ${PREFIX}/:habitId`]: getHabit,',
  '  [`POST ${PREFIX}/:habitId/archive`]: archiveHabit,',
  "  ['GET /me']: getMe,",
  extra,
  '};',
  'export function routeHabitRequest(req: HabitRequest): string | undefined {',
  "  const handler = (TABLE as Record<string, () => string>)[`${req.method ?? 'GET'} ${req.url ?? '/'}`];",
  '  return handler ? handler() : undefined;',
  '}',
].join('\n');

/** lib-and-app's router: a helper RETURNS its table in place, unnamed. */
export const RETURNED_TABLE_ROUTER = (extra = ''): string => [
  'function routes() {',
  '  return [',
  "    { method: 'GET', path: '/habits', verb: 'listHabits' },",
  "    { method: 'GET', path: '/habits/:habitId', verb: 'getHabit' },",
  "    { method: 'POST', path: '/habits/:habitId/archive', verb: 'archiveHabit' },",
  "    { method: 'GET', path: '/me', verb: 'getMe' },",
  extra,
  '  ];',
  '}',
  'export function routeHabitRequest(req: HabitRequest): string | undefined {',
  '  for (const route of routes()) if (route.method === req.method && route.path === req.url) return route.verb;',
  '  return undefined;',
  '}',
].join('\n');

/** lib-and-app R8-8: the router strips `BASE` off the path, then matches a table written under it. */
export const STRIPPING_ROUTER = (base: string): string => [
  `const BASE = '${base}';`,
  'const ROUTES = [',
  "  { method: 'GET', path: '/habits', verb: 'listHabits' },",
  "  { method: 'GET', path: '/habits/:habitId', verb: 'getHabit' },",
  "  { method: 'POST', path: '/habits/:habitId/archive', verb: 'archiveHabit' },",
  "  { method: 'GET', path: '/me', verb: 'getMe' },",
  '];',
  'export function routeHabitRequest(req: HabitRequest): string | undefined {',
  "  const pathname = req.url ?? '/';",
  '  if (!pathname.startsWith(BASE)) return undefined;',
  '  const path = pathname.slice(BASE.length);',
  '  for (const route of ROUTES) if (route.method === req.method && route.path === path) return route.verb;',
  '  return undefined;',
  '}',
].join('\n');

/**
 * Two projects side by side: `consumer` (a habit reminder Adapter) imports from
 * `producer`'s SOURCE (a sibling folder holding its own .wai/project.yaml). The
 * producer's tree is Habitly; whether it exports anything is the options'.
 */
export function siblingSourceImport(o: { importLine: string; call: string; binding?: boolean; member?: string; exportType?: boolean }): {
  consumer: FixtureTree;
  producer: FixtureTree;
} {
  const producer = habitly();
  producer.types = [{
    id: 'habit', kind: 'value-object', subsystem: 'habits', name: 'Habit', description: 'A habit someone keeps.', sourcePath: 'src/types.ts',
    fields: [{ name: 'id', type: 'string' }],
  }];
  producer.files = { ...(producer.files ?? {}), 'src/types.ts': 'export interface Habit { id: string }\n' };
  if (o.exportType) {
    (producer.system as Record<string, unknown>).publicInterfaces = [{ from: 'habits', typeDef: 'habit', as: 'habit' }];
    producer.subsystems = [{ id: 'habits', description: 'Habits, their check-ins and streaks.', publicInterfaces: [{ typeDef: 'habit', details: 'A habit.' }] }];
  }
  const reminderFile = o.binding ? 'src/producer-binding.ts' : 'src/reminder.ts';
  const consumer: FixtureTree = {
    system: { name: 'Reminders', vision: 'Reminds people of their habits.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'reminders', description: 'Reminder delivery.' }],
    components: [{
      id: 'reminder_adapter', componentType: 'Adapter', description: 'Sends a habit reminder email.',
      invokedBy: { kind: 'runtime', caller: 'The nightly reminder job the composition root schedules' },
    }],
    interfaces: [{
      id: 'ireminder_adapter', component: 'reminder_adapter',
      methods: [{ name: 'remind', description: 'Sends one reminder.', params: [{ name: 'id', type: 'string' }], returns: 'string', effect: 'io' }],
    }],
    implementations: [{
      id: 'reminder_adapter_impl', contract: 'ireminder_adapter', sourcePath: 'src/reminder.ts',
      ...(o.binding ? { bindings: ['src/producer-binding.ts'] } : {}),
      methods: [{ name: 'remind', detail: 'intent', intent: 'Sends the reminder email for one habit; a failed send surfaces as a thrown error.' }],
    }],
    files: {
      '.wai/project.yaml': projectYaml('reminders', o.member ? { members: { habitly: o.member } } : {}),
      [reminderFile]: `${o.importLine}\n${o.binding ? 'export { HabitStore };\n' : ''}`,
      ...(o.binding ? { 'src/reminder.ts': `import { HabitStore } from './producer-binding.js';\nexport function remind(id: string): string { return ${o.call}; }\n` } : {}),
    },
  };
  if (!o.binding) consumer.files!['src/reminder.ts'] += `export function remind(id: string): string { return ${o.call}; }\n`;
  return { consumer, producer };
}
