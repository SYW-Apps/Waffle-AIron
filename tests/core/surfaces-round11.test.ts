import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, loadSystemSpec, readProjectSystem, updateSpec } from '../../src/core/specs.js';
import { getExternalsStatus, pinExternals } from '../../src/core/surfaces.js';
import { adviseExternals } from '../../src/core/validation.js';
import { relationHealth } from '../../src/models/index.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness';
import { projectYaml } from '../helpers/conformance-r6-trees';
import { isolateGlobals, serveGit } from '../helpers/stage8-family.js';

// Git-backed fixtures (bare repositories, pins): slow under a loaded full suite.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Round-11 sandbox trials — members, externals and approval. Each block
// replays one finding on a miniature project pair.
// ---------------------------------------------------------------------------

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const c of cleanups.splice(0)) {
    try { c(); } catch { /* windows locks */ }
  }
  for (const dir of roots.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
  }
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-round11-')));
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

/** An exported Portal with one verb bound to `route`, over `transport`. */
function api(transport: 'HTTP' | 'InProcess', route: string): FixtureTree {
  const endpoint = transport === 'HTTP' ? { endpoint: { transport: 'HTTP', method: 'PUT', path: route } } : {};
  return {
    system: { name: 'Habitly', vision: 'Habits and their check-ins.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'habits', component: 'habit_portal', audience: 'instance' }] },
    subsystems: [{ id: 'habits', description: 'Habits.', publicInterfaces: [{ component: 'habit_portal', details: 'The habit API.' }] }],
    components: [{ id: 'habit_portal', componentType: 'Portal', transport, description: 'The habit API.', invokedBy: { kind: 'entry', caller: 'Clients' } }],
    interfaces: [{ id: 'ihabit_portal', component: 'habit_portal', methods: [{ name: 'checkIn', description: 'checkIn', params: [{ name: 'habitId', type: 'string' }], returns: 'int', effect: 'read', ...endpoint }] }],
    implementations: [{ id: 'habit_portal_impl', contract: 'ihabit_portal', methods: [{ name: 'checkIn', narrative: [{ stepNumber: 1, description: 'Answer', type: 'return', outcome: 'success' }] }] }],
  };
}

function consumer(): FixtureTree {
  return {
    system: { name: 'Reminders', vision: 'Sends habit reminders.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'mail', description: 'Mail.' }],
    components: [{ id: 'email_adapter', componentType: 'Adapter', description: 'Records reminders upstream.', dependsOn: ['legacy::habit_portal'], invokedBy: { kind: 'runtime', caller: 'The reminder job' } }],
    interfaces: [{ id: 'iemail_adapter', component: 'email_adapter', methods: [{ name: 'send', description: 'Send one reminder.', params: [{ name: 'habitId', type: 'string' }], returns: 'void', effect: 'io' }] }],
    implementations: [{ id: 'email_adapter_impl', contract: 'iemail_adapter', methods: [{ name: 'send', detail: 'intent', intent: 'Sends the reminder through the provider.' }] }],
  };
}

/** The consumer pinned against the producer, a git external served by a local repository: the kind of external a pin judges. */
function pinnedPair(transport: 'HTTP' | 'InProcess'): { producer: string; consumer: string; release(): void } {
  const folder = tempDir();
  cleanups.push(isolateGlobals(cleanups));
  const producer = writeProject(path.join(folder, 'producer'), api(transport, '/habits/{habitId}/check-ins'), projectYaml('habitly-api'));
  const served = serveGit(cleanups, producer, 'producer');
  const reader = writeProject(path.join(folder, 'consumer'), consumer(), projectYaml('reminders', { externals: { legacy: { project: 'habitly-api', source: { git: served.url } } } }));
  bind(reader);
  expect(pinExternals().map((p) => p.outcome)).toEqual(['pinned']);
  return { producer, consumer: reader, release: () => { served.release(); } };
}

describe('1. a moved wire route is a break (solo-app top-3)', () => {
  it('HTTP: the use is changed and the external incompatible', () => {
    const { producer, consumer: reader, release } = pinnedPair('HTTP');
    fs.rmSync(path.join(producer, '.wai', 'specs', 'interfaces'), { recursive: true, force: true });
    writeProject(producer, api('HTTP', '/habits/{habitId}/done'), projectYaml('habitly-api'));
    release();
    bind(reader);
    const [status] = getExternalsStatus();
    // Round 11: state "unchanged", health "drifted" — exit 0 for a client spelling the route.
    expect(status.uses).toEqual([{ publicName: 'habit_portal', member: 'checkIn', state: 'changed', detail: expect.stringContaining('endpoint moved: PUT /habits/{habitId}/check-ins → PUT /habits/{habitId}/done') }]);
    expect(status.uses[0].detail).toContain('a client calling it over the wire spells the route');
    expect(relationHealth(status)).toBe('incompatible');
    bind(reader);
    // Offline, a pinned git external is not compared: the advisory says so.
    expect(adviseExternals().map((i) => i.code)).toEqual(['EXTERNAL_LIVE_UNCOMPARED']);
  });

  it('InProcess: a library binds no route, so nothing moves and the external stays ok', () => {
    const { consumer: reader } = pinnedPair('InProcess');
    bind(reader);
    const [status] = getExternalsStatus();
    expect(status.uses).toEqual([{ publicName: 'habit_portal', state: 'unchanged' }]);
    expect(relationHealth(status)).toBe('ok');
  });
});

/** geo-sdk + route-planner: the SDK a `../` sibling member under the alias `geo`. */
function family(): { sdk: string; app: string } {
  const folder = tempDir();
  const sdk = writeProject(path.join(folder, 'geo-sdk'), {
    system: { name: 'geo-sdk', vision: 'Geospatial maths as a library.', targetLanguage: 'Rust', publicInterfaces: [
      { from: 'distance', component: 'distance_portal', as: 'distance', audience: 'external' },
    ] },
    subsystems: [{ id: 'distance', description: 'Distances.', publicInterfaces: [{ component: 'distance_portal', details: 'Distances.' }] }],
    components: [{ id: 'distance_portal', componentType: 'Portal', transport: 'InProcess', abi: 'c', description: 'The distance API.', invokedBy: { kind: 'entry', caller: 'Applications linking the crate' } }],
    interfaces: [{ id: 'idistance_portal', component: 'distance_portal', methods: [{ name: 'haversine_distance', description: 'd', params: [{ name: 'a', type: 'float' }], returns: 'float', effect: 'none' }] }],
    implementations: [{ id: 'distance_portal_impl', contract: 'idistance_portal', methods: [{ name: 'haversine_distance', narrative: [{ stepNumber: 1, description: 'Compute', type: 'return', outcome: 'success' }] }] }],
  }, projectYaml('geo-sdk'));
  const app = writeProject(path.join(folder, 'route-planner'), {
    system: { name: 'route-planner', vision: 'Plans delivery routes.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'routing', description: 'Routing.' }],
    components: [{ id: 'stop_sequencer', componentType: 'Orchestrator', description: 'Orders stops by distance.', dependsOn: ['geo::distance'], invokedBy: { kind: 'runtime', caller: 'The planning job' } }],
  }, projectYaml('route-planner', { members: { geo: '../geo-sdk' } }));
  return { sdk, app };
}

describe('2. readProjectSystem: which L0 a system id names (lib-and-app top-1)', () => {
  it('a member\'s own L0 by alias::system, alias::<its name> and project-id::<its name>', () => {
    const { app } = family();
    bind(app);
    for (const id of ['geo::system', 'geo::geo-sdk', 'geo-sdk::geo-sdk']) {
      const read = readProjectSystem(id);
      expect(read).toMatchObject({ source: 'member', alias: 'geo', project: 'geo-sdk', root: '../geo-sdk', spec: { name: 'geo-sdk' } });
      expect(read.problem).toBeUndefined();
    }
  });

  it('this project\'s own L0 only by one of its names', () => {
    const { app } = family();
    bind(app);
    expect(readProjectSystem('system')).toMatchObject({ source: 'own', spec: { name: 'route-planner' } });
    expect(readProjectSystem('route-planner')).toMatchObject({ source: 'own', spec: { name: 'route-planner' } });
    const other = readProjectSystem('geo-sdk');
    expect(other.spec).toBeUndefined();
    expect(other.problem).toContain('no L0 is named "geo-sdk"');
  });

  it('refuses, naming why: a name the member\'s L0 does not go by, an unknown prefix', () => {
    const { app } = family();
    bind(app);
    const wrong = readProjectSystem('geo::route-planner');
    expect(wrong.spec).toBeUndefined();
    expect(wrong.problem).toContain('has its L0 read as "geo::system" or "geo::geo-sdk"');
    const unknown = readProjectSystem('nope::system');
    expect(unknown).toMatchObject({ source: 'unknown' });
    expect(unknown.problem).toContain('"nope" is no member, part or external of this project');
  });

  it('an external: its L0 is not held here, its pin\'s exports named', () => {
    const { consumer: reader } = pinnedPair('HTTP');
    bind(reader);
    const read = readProjectSystem('legacy::habitly-api');
    expect(read).toMatchObject({ source: 'external', alias: 'legacy', exports: ['habit_portal'] });
    expect(read.spec).toBeUndefined();
  });
});

describe('3. a change report echoes what the write stores (lib-and-app R11-9)', () => {
  it('`geo::distance` is echoed as written, never as `geo-sdk::distance_portal`', () => {
    const { app } = family();
    bind(app);
    const cleared = updateSpec('component', 'stop_sequencer', { dependsOn: [] });
    expect(JSON.stringify(cleared.changes)).toContain('geo::distance');
    expect(JSON.stringify(cleared.changes)).not.toContain('geo-sdk::distance_portal');
    bind(app);
    const added = updateSpec('component', 'stop_sequencer', { dependsOn: ['geo::distance'] });
    expect(added.changes).toEqual([expect.objectContaining({ path: 'dependsOn', change: 'added', after: expect.stringContaining('geo::distance') })]);
    expect(JSON.stringify(added.changes)).not.toContain('geo-sdk::');
    const stored = fs.readFileSync(path.join(app, '.wai', 'specs', 'components', fs.readdirSync(path.join(app, '.wai', 'specs', 'components'))[0]), 'utf8');
    expect(stored).toContain('geo::distance');
  });
});

describe('5. a requirement added as { description } takes its siblings\' form (lib-and-app R11-4)', () => {
  it('text beside text, never an object in a list of strings', () => {
    const { app } = family();
    bind(app);
    updateSpec('system', 'system', { globalRequirements: ['No panics on user input.'] });
    bind(app);
    updateSpec('system', 'system', { globalRequirements: [{ description: 'No `unsafe`.' }] });
    bind(app);
    // Round 11: the added one was stored as an object beside plain strings.
    expect(loadSystemSpec()!.globalRequirements).toEqual(['No panics on user input.', 'No `unsafe`.']);
  });
});
