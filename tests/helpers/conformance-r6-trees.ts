import * as yaml from 'js-yaml';
import type { FixtureTree } from '../rules-matrix/harness';

// ---------------------------------------------------------------------------
// The miniature systems the round-6 conformance fixes are judged on, shared by
// the unit tier (tests/core/conformance-round6.test.ts) and the journeys
// against the built CLI (tests/e2e/trials-r6-conformance.test.ts).
//
// Habitly — Portal habit_portal -> Orchestrator habit_orchestrator ->
// standalone Store habit_store (addCheckIn write, find read), one file each.
// RoutePlanner + GeoKit — a consumer whose stop sequencer takes a list of the
// producer's exported coordinate type.
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z';
const INTENT = 'Performs its one thing against held state; failures surface as thrown errors.';
const intent = (name: string): Record<string, unknown> => ({ name, detail: 'intent', intent: INTENT });
const method = (name: string, effect?: string): Record<string, unknown> => ({
  name,
  description: `${name} does its one thing, carefully and observably`,
  params: [{ name: 'id', type: 'string', description: 'The id of the habit the call is about' }],
  returns: 'string',
  ...(effect ? { effect } : {}),
});

export const projectYaml = (id: string, extra: Record<string, unknown> = {}): string => yaml.dump({
  schemaVersion: '1.0.0',
  id,
  name: id,
  targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
  extensions: { packs: [], useGlobalPacks: false },
  ...extra,
  createdAt: TS,
  updatedAt: TS,
}, { noRefs: true, lineWidth: 200 });

export const STORE_FILE = [
  'export class HabitStore {',
  '  addCheckIn(id: string): string { return id; }',
  '  find(id: string): string { return id; }',
  '}', '',
].join('\n');

/** The Orchestrator: checkIn writes, streak reads; `extra` runs first in streak. */
export const orchestratorFile = (o: { storeImport?: string; field?: string; recv?: string; extra?: string } = {}): string => [
  o.storeImport ?? "import type { HabitStore } from './habit-store.js';",
  'export class HabitOrchestrator {',
  `  constructor(${o.field ?? 'private readonly checkins: HabitStore'}) {}`,
  `  checkIn(id: string): string { ${o.recv ?? 'this.checkins'}.find(id); return ${o.recv ?? 'this.checkins'}.addCheckIn(id); }`,
  `  streak(id: string): string { ${o.extra ?? ''} return ${o.recv ?? 'this.checkins'}.find(id); }`,
  '  archive(id: string): string { return id; }',
  '}', '',
].join('\n');

export const NO_FIELD = 'private readonly unused?: number';

/** The Portal: checkIn runs `body` before its narrated dispatch to the Orchestrator. */
export const portalFile = (o: { body?: string; field?: string; head?: string; signature?: string; dispatch?: string } = {}): string => [
  "import type { HabitOrchestrator } from './habit-orchestrator.js';",
  o.head ?? "import type { HabitStore } from './habit-store.js';",
  'export class HabitPortal {',
  `  constructor(private readonly habits: HabitOrchestrator, ${o.field ?? 'private readonly checkins: HabitStore'}) {}`,
  `  checkIn(${o.signature ?? 'id: string'}): string { ${o.body ?? ''} return this.habits.checkIn(${o.dispatch ?? 'id'}); }`,
  '}', '',
].join('\n');

export interface HabitlyOptions {
  /** The Orchestrator verbs' declared effects (default: checkIn write, streak read, archive none declared). */
  effects?: { checkIn?: string; streak?: string; archive?: string };
  /** The Portal file (default: a plain forwarder with a Store-typed second field). */
  portal?: string;
  /** The Orchestrator file (default: orchestratorFile()). */
  orchestrator?: string;
  /** The Store file; null leaves it unwritten — the Store's realization has not begun. */
  store?: string | null;
  files?: Record<string, string>;
  /** Give archive a narrative calling the Store's write (or read), and the code that realizes it. */
  archiveCalls?: 'addCheckIn' | 'find';
  /** Leave archive at intent detail — no narrative, no declared calls: nothing says what it does to state. */
  archiveIntent?: boolean;
  /** Bind the Store's implementation to postgres, making it that technology's home. */
  postgres?: boolean;
}

export function habitly(o: HabitlyOptions = {}): FixtureTree {
  const effects = { checkIn: 'write', streak: 'read', ...(o.effects ?? {}) } as Record<string, string | undefined>;
  return {
    system: { name: 'Habitly', vision: 'A habit tracking API a solo developer can maintain.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'habits', description: 'Habits, their check-ins and streaks.' }],
    components: [
      {
        id: 'habit_store', componentType: 'Store', durability: 'read-through',
        description: 'Holds habits and check-ins.',
        lint: { allow: [{ code: 'UNOWNED_STORE', reason: 'simple keyed rows; lookups beyond the key are single indexed queries' }] },
      },
      { id: 'habit_orchestrator', componentType: 'Orchestrator', description: 'Owns the check-in workflow and its rules.', dependsOn: ['habit_store'] },
      {
        id: 'habit_portal', componentType: 'Portal', transport: 'InProcess', description: 'The API layer of the habits service.', dependsOn: ['habit_orchestrator'],
        invokedBy: { kind: 'entry', caller: 'The mobile app and the web client of Habitly, over the router in main.ts' },
      },
    ],
    interfaces: [
      { id: 'ihabit_store', component: 'habit_store', methods: [method('addCheckIn', 'write'), method('find', 'read')] },
      {
        id: 'ihabit_orchestrator', component: 'habit_orchestrator', methods: [
          method('checkIn', effects.checkIn),
          { ...method('streak', effects.streak), invokedBy: { kind: 'runtime', caller: 'The nightly streak digest job the composition root schedules' } },
          { ...method('archive', effects.archive), invokedBy: { kind: 'runtime', caller: 'The weekly clean-up job the composition root schedules' } },
        ],
      },
      { id: 'ihabit_portal', component: 'habit_portal', methods: [method('checkIn', 'write')] },
    ],
    implementations: [
      { id: 'habit_store_impl', contract: 'ihabit_store', sourcePath: 'src/habit-store.ts', ...(o.postgres ? { technologies: ['postgres'] } : {}), methods: [intent('addCheckIn'), intent('find')] },
      {
        id: 'habit_orchestrator_impl', contract: 'ihabit_orchestrator', sourcePath: 'src/habit-orchestrator.ts',
        methods: [
          {
            name: 'checkIn', narrative: [
              { stepNumber: 1, description: 'Load the habit to check it exists', type: 'call', targetComponent: 'habit_store', targetMethod: 'find' },
              { stepNumber: 2, description: 'Record the check-in', type: 'call', targetComponent: 'habit_store', targetMethod: 'addCheckIn' },
              { stepNumber: 3, description: 'Checked in', type: 'return', outcome: 'success' },
            ],
          },
          {
            name: 'streak', narrative: [
              { stepNumber: 1, description: 'Read the habit', type: 'call', targetComponent: 'habit_store', targetMethod: 'find' },
              { stepNumber: 2, description: 'Answer its streak', type: 'return', outcome: 'success' },
            ],
          },
          o.archiveCalls ? {
            name: 'archive', narrative: [
              { stepNumber: 1, description: 'Touch the habit', type: 'call', targetComponent: 'habit_store', targetMethod: o.archiveCalls },
              { stepNumber: 2, description: 'Archived', type: 'return', outcome: 'success' },
            ],
          } : o.archiveIntent ? intent('archive') : { name: 'archive', narrative: [{ stepNumber: 1, description: 'Retire the habit', type: 'return', outcome: 'success' }] },
        ],
      },
      {
        id: 'habit_portal_impl', contract: 'ihabit_portal', sourcePath: 'src/habit-portal.ts',
        methods: [{
          name: 'checkIn', narrative: [
            { stepNumber: 1, description: 'Dispatch the check-in to the orchestrator', type: 'call', targetComponent: 'habit_orchestrator', targetMethod: 'checkIn' },
            { stepNumber: 2, description: 'Checked in', type: 'return', outcome: 'success' },
          ],
        }],
      },
    ],
    files: {
      '.wai/project.yaml': projectYaml('habitly'),
      ...(o.store === null ? {} : { 'src/habit-store.ts': o.store ?? STORE_FILE }),
      'src/habit-orchestrator.ts': o.orchestrator ?? (o.archiveCalls ? orchestratorFile().replace('archive(id: string): string { return id; }', `archive(id: string): string { return this.checkins.${o.archiveCalls}(id); }`) : orchestratorFile()),
      'src/habit-portal.ts': o.portal ?? portalFile(),
      ...(o.files ?? {}),
    },
  };
}

/** GeoKit: a TypeScript geometry library exporting its coordinate type and a distance function. */
export function geoKit(): FixtureTree {
  return {
    system: {
      name: 'GeoKit', vision: 'Geometry for map applications.', targetLanguage: 'TypeScript',
      publicInterfaces: [{ from: 'geometry', component: 'distance_library' }, { from: 'geometry', typeDef: 'coordinate' }],
    },
    subsystems: [{
      id: 'geometry', description: 'Points on the earth and the distances between them.',
      publicInterfaces: [{ component: 'distance_library', details: 'Great-circle distances.' }, { typeDef: 'coordinate', details: 'A point on the earth.' }],
    }],
    components: [{
      id: 'distance_library', componentType: 'Portal', transport: 'InProcess',
      description: 'The library\'s distance API.', invokedBy: { kind: 'entry', caller: 'Applications linking the library.' },
    }],
    interfaces: [{
      id: 'idistance_library', component: 'distance_library',
      methods: [{ name: 'haversine', description: 'Great-circle distance in km.', params: [{ name: 'from', type: 'coordinate' }, { name: 'to', type: 'coordinate' }], returns: 'float', effect: 'none' }],
    }],
    types: [{
      id: 'coordinate', kind: 'value-object', subsystem: 'geometry', name: 'Coordinate', description: 'A point on the earth.',
      fields: [{ name: 'lat', type: 'float' }, { name: 'lon', type: 'float' }],
    }],
  };
}

/** RoutePlanner: orders the stops of a route; its sequencer takes a list of GeoKit's coordinate (`sequence(stops: list<geo::coordinate>)`). */
export function routePlanner(signature: string): FixtureTree {
  return {
    system: { name: 'RoutePlanner', vision: 'Plans delivery routes over GeoKit.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'routing', description: 'Route planning.' }],
    components: [{
      id: 'stop_sequencer', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Orders the stops of a route.',
      invokedBy: { kind: 'entry', caller: 'The route planner CLI a dispatcher runs.' },
    }],
    interfaces: [{
      id: 'istop_sequencer', component: 'stop_sequencer',
      methods: [{ name: 'sequence', description: 'The stops in visiting order, as a count of legs.', params: [{ name: 'stops', type: 'list<geo::coordinate>' }], returns: 'int', effect: 'none' }],
    }],
    implementations: [{
      id: 'stop_sequencer_impl', contract: 'istop_sequencer', sourcePath: 'src/stop-sequencer.ts',
      methods: [{ name: 'sequence', detail: 'intent', intent: 'Orders the stops nearest-neighbour first and answers the number of legs; an empty list answers zero.' }],
    }],
    files: {
      'src/geo.ts': 'export interface Coordinate {\n  lat: number;\n  lon: number;\n}\n',
      'src/stop-sequencer.ts': `import type { Coordinate } from './geo.js';\nexport function sequence(${signature}): number { return 0; }\n`,
    },
  };
}
