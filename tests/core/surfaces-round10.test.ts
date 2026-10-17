import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { diff, getExternalsStatus, pinExternals } from '../../src/core/surfaces.js';
import { adviseExternals, validateProject } from '../../src/core/validation.js';
import { readYamlFile } from '../../src/utils/yaml.js';
import { fieldChangesSince, memberDigest, relationHealth, SurfaceSnapshotSchema, type SurfaceSnapshot } from '../../src/models/index.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness';
import { projectYaml } from '../helpers/conformance-r6-trees';

// ---------------------------------------------------------------------------
// Round-10 sandbox trials — surfaces and externals. Each block replays one
// finding on a miniature project pair.
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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-round10-')));
  roots.push(dir);
  return dir;
}

function writeProject(dir: string, tree: FixtureTree, config: string): string {
  fs.mkdirSync(dir, { recursive: true });
  materializeFixtureProject(dir, { ...tree, files: { ...(tree.files ?? {}), '.wai/project.yaml': config } });
  return dir;
}

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

interface Verb { name: string; previousNames?: string[]; path: string }

/** The habit API: an HTTP Portal exported to other projects, its verbs given. */
function habitApi(verbs: Verb[] = [{ name: 'checkIn', path: '/habits/{habitId}/check-ins' }, { name: 'getHabit', path: '/habits/{habitId}' }]): FixtureTree {
  return {
    system: { name: 'Habitly', vision: 'Habits and their check-ins.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'habits', component: 'habit_portal', audience: 'instance' }] },
    subsystems: [{ id: 'habits', description: 'Habits.', publicInterfaces: [{ component: 'habit_portal', details: 'The habit API.' }] }],
    components: [{ id: 'habit_portal', componentType: 'Portal', transport: 'HTTP', description: 'The habit API.', invokedBy: { kind: 'entry', caller: 'Clients, over HTTP' } }],
    interfaces: [{ id: 'ihabit_portal', component: 'habit_portal', methods: verbs.map((v) => ({
      name: v.name, description: v.name, params: [{ name: 'habitId', type: 'string' }], returns: 'int', effect: 'read',
      ...(v.previousNames ? { previousNames: v.previousNames } : {}),
      endpoint: { transport: 'HTTP', method: 'PUT', path: v.path },
    })) }],
    implementations: [{ id: 'habit_portal_impl', contract: 'ihabit_portal', methods: verbs.map((v) => ({ name: v.name, narrative: [{ stepNumber: 1, description: 'Answer', type: 'return', outcome: 'success' }] })) }],
  };
}

/** The consumer: its email Adapter depends on the habit API AS A WHOLE — a bare dependsOn, no call named. */
function wholeContractConsumer(): FixtureTree {
  return {
    system: { name: 'Reminders', vision: 'Sends habit reminders.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'mail', description: 'Mail.' }],
    components: [{ id: 'email_adapter', componentType: 'Adapter', description: 'Sends reminders and records them upstream.', dependsOn: ['legacy::habit_portal'], invokedBy: { kind: 'runtime', caller: 'The reminder job the composition root schedules' } }],
    interfaces: [{ id: 'iemail_adapter', component: 'email_adapter', methods: [{ name: 'send', description: 'Send one reminder.', params: [{ name: 'habitId', type: 'string' }], returns: 'void', effect: 'io' }] }],
    implementations: [{ id: 'email_adapter_impl', contract: 'iemail_adapter', methods: [{ name: 'send', detail: 'intent', intent: 'Sends the reminder through the provider.' }] }],
  };
}

describe('1. a contract used as a whole: every method it holds is compared live (solo-app top-1)', () => {
  function pinnedPair(): { producer: string; consumer: string } {
    const folder = tempDir();
    const producer = writeProject(path.join(folder, 'producer'), habitApi(), projectYaml('habitly-api'));
    const consumer = writeProject(path.join(folder, 'consumer'), wholeContractConsumer(), projectYaml('reminders', { externals: { legacy: { project: 'habitly-api', source: { path: '../producer' } } } }));
    bind(consumer);
    expect(pinExternals().map((p) => p.outcome)).toEqual(['pinned']);
    // The lock records the contract as a whole: no member named.
    expect(readYamlFile<{ externals: Record<string, { used: Record<string, Record<string, string>> }> }>(path.join(consumer, '.wai', 'externals.lock.yaml')).externals.legacy.used).toEqual({ habit_portal: {} });
    return { producer, consumer };
  }

  /** The producer rewritten with other verbs. */
  function republish(producer: string, verbs: Verb[]): void {
    for (const dir of ['interfaces', 'implementations']) fs.rmSync(path.join(producer, '.wai', 'specs', dir), { recursive: true, force: true });
    writeProject(producer, habitApi(verbs), projectYaml('habitly-api'));
    invalidateSpecCache();
  }

  it('unchanged producer: one unchanged row for the contract', () => {
    const { consumer } = pinnedPair();
    bind(consumer);
    const [status] = getExternalsStatus();
    expect(status.uses).toEqual([{ publicName: 'habit_portal', state: 'unchanged' }]);
    expect(relationHealth(status)).toBe('ok');
  });

  it('a verb REMOVED is removed by name — incompatible, never "nothing this project uses changed"', () => {
    const { producer, consumer } = pinnedPair();
    republish(producer, [{ name: 'getHabit', path: '/habits/{habitId}' }]);
    bind(consumer);
    const [status] = getExternalsStatus();
    expect(status.uses).toEqual([{ publicName: 'habit_portal', member: 'checkIn', state: 'removed' }]);
    expect(relationHealth(status)).toBe('incompatible');
    bind(consumer);
    const advised = adviseExternals();
    expect(advised.map((i) => i.code)).toEqual(['EXTERNAL_LIVE_INCOMPATIBLE']);
    expect(advised[0].message).toContain('"habit_portal.checkIn" gone from the producer\'s live export table');
  });

  it('a verb RENAMED is renamed to its new name', () => {
    const { producer, consumer } = pinnedPair();
    republish(producer, [{ name: 'markDone', previousNames: ['ihabit_portal.checkIn'], path: '/habits/{habitId}/check-ins' }, { name: 'getHabit', path: '/habits/{habitId}' }]);
    bind(consumer);
    const [status] = getExternalsStatus();
    expect(status.uses).toEqual([expect.objectContaining({ publicName: 'habit_portal', member: 'checkIn', state: 'renamed', renamedTo: 'habit_portal.markDone' })]);
    expect(relationHealth(status)).toBe('incompatible');
  });

  it('an endpoint MOVED breaks the use and names the route on the member (round 11: no longer a drift)', () => {
    const { producer, consumer } = pinnedPair();
    republish(producer, [{ name: 'checkIn', path: '/habits/{habitId}/done' }, { name: 'getHabit', path: '/habits/{habitId}' }]);
    bind(consumer);
    const [status] = getExternalsStatus();
    expect(status.uses).toEqual([{ publicName: 'habit_portal', member: 'checkIn', state: 'changed', detail: expect.stringContaining('endpoint moved: PUT /habits/{habitId}/check-ins → PUT /habits/{habitId}/done') }]);
    expect(relationHealth(status)).toBe('incompatible');
  });
});

// ---------------------------------------------------------------------------
// 2. surface diff on an unchanged tree with a `../` sibling member (lib-and-app top-1)
// ---------------------------------------------------------------------------

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
  });
}

/** An approval record committed with the tree as it stands; `members` is what the record says of each member. */
function approve(dir: string, digest: string, members?: Record<string, string>): void {
  const record = {
    format: 3, stateId: { algorithm: 'sha256+design-2', digest }, specs: {},
    ...(members ? { members: Object.fromEntries(Object.entries(members).map(([alias, d]) => [alias, { as: 'project', project: 'geo-sdk', subject: `sha256+design-2:${d}`, state: 'approved' }])) } : {}),
  };
  fs.writeFileSync(path.join(dir, '.wai', 'lock.json'), JSON.stringify(record, null, 2));
  git(dir, 'add', '-A');
  git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `approved ${digest.slice(0, 4)}`);
}

/** The geo SDK: exports its coordinate type, whose fields are latitude and longitude newtypes. */
function geoSdk(lon = 'lon', formerly?: string): FixtureTree {
  return {
    system: { name: 'geo-sdk', vision: 'Geospatial maths as a library.', targetLanguage: 'Rust', publicInterfaces: [{ from: 'distance', typeDef: 'coordinate', audience: 'external' }] },
    subsystems: [{ id: 'distance', description: 'Distances.', publicInterfaces: [{ typeDef: 'coordinate' }] }],
    types: [
      { id: 'coordinate', kind: 'value-object', subsystem: 'distance', name: 'Coordinate', description: 'A point.', fields: [{ name: 'lat', type: 'latitude' }, { name: lon, type: 'longitude', ...(formerly ? { previousNames: [formerly] } : {}) }] },
      { id: 'latitude', kind: 'value-object', subsystem: 'distance', name: 'Latitude', description: 'Degrees.', holds: 'float' },
      { id: 'longitude', kind: 'value-object', subsystem: 'distance', name: 'Longitude', description: 'Degrees.', holds: 'float' },
    ],
  };
}

/** The route planner: an HTTP API answering the sibling member's coordinate. */
function routePlanner(): FixtureTree {
  return {
    system: { name: 'route-planner', vision: 'Plans delivery routes.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'routing', component: 'route_portal', audience: 'instance' }] },
    subsystems: [{ id: 'routing', description: 'Routing.', publicInterfaces: [{ component: 'route_portal', details: 'The routing API.' }] }],
    components: [{ id: 'route_portal', componentType: 'Portal', transport: 'HTTP', description: 'The routing API.', invokedBy: { kind: 'entry', caller: 'The dispatch web app, over HTTPS' } }],
    interfaces: [{ id: 'iroute_portal', component: 'route_portal', methods: [
      { name: 'nearest', description: 'The nearest depot.', params: [{ name: 'at', type: 'geo::coordinate' }], returns: 'geo::coordinate', effect: 'read', endpoint: { transport: 'HTTP', method: 'POST', path: '/nearest' } },
    ] }],
    implementations: [{ id: 'route_portal_impl', contract: 'iroute_portal', methods: [{ name: 'nearest', narrative: [{ stepNumber: 1, description: 'Answer', type: 'return', outcome: 'success' }] }] }],
  };
}

describe('2. surface diff reads a `../` sibling member as the baseline\'s approval recorded it', () => {
  const A = 'a'.repeat(64);
  function approvedPair(): { sdk: string; app: string } {
    const folder = tempDir();
    const sdk = writeProject(path.join(folder, 'geo-sdk'), geoSdk(), projectYaml('geo-sdk'));
    const app = writeProject(path.join(folder, 'route-planner'), routePlanner(), projectYaml('route-planner', { members: { geo: '../geo-sdk' } }));
    git(sdk, 'init', '-q');
    approve(sdk, A);
    git(app, 'init', '-q');
    approve(app, 'c'.repeat(64), { geo: A });
    return { sdk, app };
  }

  it('nothing changed since the approval: no change — never "a type it names changed shape"', () => {
    const { app } = approvedPair();
    bind(app);
    // Round 10: `changed route_portal.nearest — signature reads the same, but a type it names changed shape: "geo::coordinate", …`.
    expect(diff().changes).toEqual([]);
  });

  it('a member field renamed since the approval is still named on the verb', () => {
    const { sdk, app } = approvedPair();
    for (const dir of ['types']) fs.rmSync(path.join(sdk, '.wai', 'specs', dir), { recursive: true, force: true });
    writeProject(sdk, geoSdk('lng', 'lon'), projectYaml('geo-sdk'));
    bind(app);
    const changes = diff().changes;
    expect(changes).toEqual([expect.objectContaining({ kind: 'changed', name: 'route_portal', member: 'nearest', detail: expect.stringContaining('"geo::coordinate.lon" → "lng"') })]);
  });
});

// ---------------------------------------------------------------------------
// 3a. an added field is named in the live comparison (tinkerer)
// ---------------------------------------------------------------------------

const snap = (over: Partial<SurfaceSnapshot>): SurfaceSnapshot => SurfaceSnapshotSchema.parse({ projectName: 'linkshort', origin: 'generated', generatedAt: '2026-10-09T10:00:00.000Z', interfaces: [], types: [], ...over });

describe('3a. the live comparison names a field added to (or removed from) a used member\'s closure', () => {
  const stats = (fields: SurfaceSnapshot['types'][number]['fields'], extra: SurfaceSnapshot['types'] = []): SurfaceSnapshot => snap({
    interfaces: [{ id: 'stats_api', name: 'Stats', audience: 'instance', type: 'REST', component: 'stats_portal', methods: [
      { name: 'getStats', description: 'd', signature: 'getStats(code: string): code_stats', returns: 'code_stats', params: [{ name: 'code', type: 'string' }] },
    ] } as never],
    types: [{ id: 'code_stats', name: 'CodeStats', kind: 'value-object', fields }, ...extra],
  });
  const pinned = stats([{ name: 'hits', type: 'int' }, { name: 'lastHitAt', type: 'string' }]);
  const digest = (): string => memberDigest(pinned, 'stats_api', 'getStats')!;

  it('a rename and an added field: both named, and the reading is the whole change', () => {
    const live = stats(
      [{ name: 'hits', type: 'int' }, { name: 'lastSeenAt', type: 'string', formerly: ['lastHitAt'] }, { name: 'window', type: 'stats_window' }],
      [{ id: 'stats_window', name: 'StatsWindow', kind: 'value-object', fields: [{ name: 'from', type: 'string' }, { name: 'to', type: 'string' }] }],
    );
    expect(fieldChangesSince(pinned, live, 'stats_api', 'getStats', digest())).toEqual({
      renames: ['field "code_stats.lastHitAt" renamed to "lastSeenAt"'], added: ['field "code_stats.window" added'], removed: [], fieldsOnly: true,
    });
  });

  it('a removed field is named removed; a field whose type changed is beyond the field changes', () => {
    expect(fieldChangesSince(pinned, stats([{ name: 'hits', type: 'int' }]), 'stats_api', 'getStats', digest()))
      .toMatchObject({ removed: ['field "code_stats.lastHitAt" removed'], fieldsOnly: true });
    expect(fieldChangesSince(pinned, stats([{ name: 'hits', type: 'string' }, { name: 'lastHitAt', type: 'string' }, { name: 'extra', type: 'int' }]), 'stats_api', 'getStats', digest()))
      .toMatchObject({ added: ['field "code_stats.extra" added'], fieldsOnly: false });
  });

  it('the consumer\'s status names the added field — never only "its shape changed beyond that"', () => {
    const folder = tempDir();
    const withRecord = (fields: { name: string; type: string; previousNames?: string[] }[]): FixtureTree => {
      const tree = habitApi();
      const contract = tree.interfaces![0] as { methods: { name: string }[] };
      return {
        ...tree,
        interfaces: [{ ...tree.interfaces![0], methods: contract.methods.map((m) => (m.name === 'getHabit' ? { ...m, returns: 'habit' } : m)) }],
        types: [{ id: 'habit', kind: 'value-object', subsystem: 'habits', name: 'Habit', description: 'A habit.', fields }],
      };
    };
    const producer = writeProject(path.join(folder, 'producer'), withRecord([{ name: 'name', type: 'string' }]), projectYaml('habitly-api'));
    const consumer = writeProject(path.join(folder, 'consumer'), wholeContractConsumer(), projectYaml('reminders', { externals: { legacy: { project: 'habitly-api', source: { path: '../producer' } } } }));
    bind(consumer);
    expect(pinExternals().map((p) => p.outcome)).toEqual(['pinned']);
    writeProject(producer, withRecord([{ name: 'title', type: 'string', previousNames: ['name'] }, { name: 'cadence', type: 'string' }]), projectYaml('habitly-api'));
    bind(consumer);
    const [status] = getExternalsStatus();
    // Round 10: 'field "habit.name" renamed to "title" (and its shape changed beyond that)'.
    expect(status.uses).toEqual([{ publicName: 'habit_portal', member: 'getHabit', state: 'changed', detail: 'field "habit.name" renamed to "title"; field "habit.cadence" added (its shape is otherwise unchanged) — follow the rename' }]);
  });
});

// ---------------------------------------------------------------------------
// 5. BINDING_DRIFT against a member says the member's, never "the pin's" (lib-and-app)
// ---------------------------------------------------------------------------

describe('5. a binding into a sibling member is compared with the member\'s live export, and says so', () => {
  it('a parameter and a field the member never traced read "the member\'s"', () => {
    const folder = tempDir();
    writeProject(path.join(folder, 'geo-sdk'), {
      system: { name: 'geo-sdk', vision: 'Geospatial maths as a library.', targetLanguage: 'Rust', publicInterfaces: [
        { from: 'distance', component: 'distance_portal', as: 'distance', audience: 'external' },
        { from: 'distance', typeDef: 'coordinate', audience: 'external' },
      ] },
      subsystems: [{ id: 'distance', description: 'Distances.', publicInterfaces: [{ component: 'distance_portal', details: 'Distances.' }, { typeDef: 'coordinate' }] }],
      components: [{ id: 'distance_portal', componentType: 'Portal', transport: 'InProcess', description: 'The distance API.', invokedBy: { kind: 'entry', caller: 'Applications linking the crate' } }],
      interfaces: [{ id: 'idistance_portal', component: 'distance_portal', methods: [{ name: 'haversine_distance', description: 'd', params: [{ name: 'from', type: 'coordinate' }, { name: 'to', type: 'coordinate' }], returns: 'float', effect: 'none' }] }],
      implementations: [{ id: 'distance_portal_impl', contract: 'idistance_portal', methods: [{ name: 'haversine_distance', narrative: [{ stepNumber: 1, description: 'Compute', type: 'return', outcome: 'success' }] }] }],
      types: [{ id: 'coordinate', kind: 'value-object', subsystem: 'distance', name: 'Coordinate', description: 'A point.', fields: [{ name: 'lat', type: 'float' }, { name: 'lon', type: 'float' }] }],
    }, projectYaml('geo-sdk'));
    const app = writeProject(path.join(folder, 'route-planner'), {
      system: { name: 'route-planner', vision: 'Plans delivery routes.', targetLanguage: 'TypeScript' },
      subsystems: [{ id: 'routing', description: 'Routing.' }],
      components: [{ id: 'stop_sequencer', componentType: 'Orchestrator', description: 'Orders stops by distance.', dependsOn: ['geo::distance'], invokedBy: { kind: 'runtime', caller: 'The planning job the composition root schedules' } }],
      interfaces: [{ id: 'istop_sequencer', component: 'stop_sequencer', methods: [{ name: 'sequence', description: 'Order the stops.', params: [{ name: 'stops', type: 'list<geo::coordinate>' }], returns: 'list<geo::coordinate>', effect: 'none' }] }],
      implementations: [{ id: 'stop_sequencer_impl', contract: 'istop_sequencer', sourcePath: 'src/sequencer.ts', bindings: ['src/geo-binding.ts'], methods: [{ name: 'sequence', detail: 'intent', intent: 'Orders the stops.', calls: ['geo::distance.haversine_distance'] }] }],
      files: {
        'src/sequencer.ts': 'export function sequence(stops: unknown[]): unknown[] { return stops; }\n',
        'src/geo-binding.ts': 'export interface Coordinate { lat: number; lng: number }\nexport function haversine_distance(origin: Coordinate, to: Coordinate): number { return 0; }\n',
      },
    }, projectYaml('route-planner', { members: { geo: '../geo-sdk' } }));
    bind(app);
    const text = validateProject().issues.filter((i) => i.code === 'BINDING_DRIFT').map((i) => i.message).join('\n');
    // Round 10: "the pin's is "from"" and "the pinned type" for a member that is never pinned.
    expect(text).toContain('parameter 1 of "haversine_distance" is "origin", the member\'s is "from"');
    expect(text).toContain('field "lng" is not in the member\'s type; the member\'s type has field "lon" the binding does not declare');
    expect(text).not.toMatch(/the pin's|the pinned type/);
  });
});
