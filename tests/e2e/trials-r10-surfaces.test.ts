import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { FixtureTree } from '../rules-matrix/harness';
import { DIST_CLI, callTool } from './helpers';
import { createTrialSandbox, readFile, transcript, writeFile, type TrialSandbox } from './trials-helpers';
import { projectYaml } from '../helpers/conformance-r6-trees';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';

// ---------------------------------------------------------------------------
// Round-10 user trials (dev.114) — surfaces, externals and members, replayed
// against the BUILT CLI and server:
//   1. the consumer's live gate did not see a verb it reaches through a
//      contract it uses WHOLE removed, renamed or re-routed — solo-app top-1.
//   2. `surface diff` reported every verb naming a `../` sibling member's type
//      "changed" right after a clean re-lock — lib-and-app top-1.
//   3. an added field was "its shape changed beyond that"; a route move named
//      no consumer it breaks — tinkerer.
//   4. `sdd_get_spec` read neither an external's carried type nor a pinned
//      contract with `methods` and no kind — solo-app, tinkerer.
//   5. BINDING_DRIFT said "the pin's" for a member — lib-and-app.
// ---------------------------------------------------------------------------

let sb: TrialSandbox;
let seq = 0;
beforeAll(() => { sb = createTrialSandbox('r10surf'); });
const open: Client[] = [];
afterAll(async () => {
  for (const c of open) { try { await c.close(); } catch { /* gone */ } }
  await sb?.cleanup();
});

function writeProject(dir: string, tree: FixtureTree, config: string): string {
  const at = sb.materialize(`tmp${++seq}`, { ...tree, files: { ...(tree.files ?? {}), '.wai/project.yaml': config } });
  fs.cpSync(at, dir, { recursive: true });
  fs.rmSync(at, { recursive: true, force: true });
  return dir;
}

function specFile(dir: string, kind: string, id: string): string {
  const folder = path.join(dir, '.wai', 'specs', kind);
  return `.wai/specs/${kind}/${fs.readdirSync(folder).find((f) => f.startsWith(id))!}`;
}

function git(dir: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd: dir, stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'trial', GIT_AUTHOR_EMAIL: 'trial@example.invalid', GIT_COMMITTER_NAME: 'trial', GIT_COMMITTER_EMAIL: 'trial@example.invalid' },
  });
}

async function serve(dir: string): Promise<Client> {
  const env: Record<string, string> = Object.fromEntries(Object.entries(sb.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
  env.WAIRON_PROJECT_DIR = dir;
  const client = new Client({ name: 'wairon-e2e-r10-surfaces', version: '0.0.1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [DIST_CLI, 'mcp', 'serve'], cwd: dir, env, stderr: 'ignore' }));
  open.push(client);
  return client;
}

/** The habit API: an HTTP Portal exported to other projects; getHabit answers a record it does not export. */
function habitApi(): FixtureTree {
  const verb = (name: string, routePath: string, returns = 'int') => ({ name, description: name, params: [{ name: 'habitId', type: 'string' }], returns, effect: 'read', endpoint: { transport: 'HTTP', method: 'PUT', path: routePath } });
  return {
    system: { name: 'Habitly', vision: 'Habits and their check-ins.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'habits', component: 'habit_portal', audience: 'instance' }] },
    subsystems: [{ id: 'habits', description: 'Habits.', publicInterfaces: [{ component: 'habit_portal', details: 'The habit API.' }] }],
    components: [{ id: 'habit_portal', componentType: 'Portal', transport: 'HTTP', description: 'The habit API.', invokedBy: { kind: 'entry', caller: 'Clients, over HTTP' } }],
    interfaces: [{ id: 'ihabit_portal', component: 'habit_portal', methods: [verb('checkIn', '/habits/{habitId}/check-ins'), verb('getHabit', '/habits/{habitId}', 'habit')] }],
    implementations: [{ id: 'habit_portal_impl', contract: 'ihabit_portal', methods: ['checkIn', 'getHabit'].map((name) => ({ name, narrative: [{ stepNumber: 1, description: 'Answer', type: 'return', outcome: 'success' }] })) }],
    types: [{ id: 'habit', kind: 'value-object', subsystem: 'habits', name: 'Habit', description: 'A habit.', fields: [{ name: 'name', type: 'string' }] }],
  };
}

/** The consumer: its email Adapter depends on the habit API as a whole — no call named. */
function reminders(): FixtureTree {
  return {
    system: { name: 'Reminders', vision: 'Sends habit reminders.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'mail', description: 'Mail.' }],
    components: [{ id: 'email_adapter', componentType: 'Adapter', description: 'Sends reminders and records them upstream.', dependsOn: ['legacy::habit_portal'], invokedBy: { kind: 'runtime', caller: 'The reminder job the composition root schedules' } }],
    interfaces: [{ id: 'iemail_adapter', component: 'email_adapter', methods: [{ name: 'send', description: 'Send one reminder.', params: [{ name: 'habitId', type: 'string' }], returns: 'void', effect: 'io' }] }],
    implementations: [{ id: 'email_adapter_impl', contract: 'iemail_adapter', methods: [{ name: 'send', detail: 'intent', intent: 'Sends the reminder through the provider.' }] }],
  };
}

async function pinnedPair(name: string): Promise<{ producer: string; consumer: string }> {
  const folder = sb.project(name);
  const producer = writeProject(path.join(folder, 'producer'), habitApi(), projectYaml('habitly-api'));
  const consumer = writeProject(path.join(folder, 'consumer'), reminders(), projectYaml('reminders', { externals: { legacy: { project: 'habitly-api', source: { path: '../producer' }, use: ['habit_portal'] } } }));
  const pin = await sb.run(['externals', 'pin'], consumer);
  expect(pin.code, transcript(pin)).toBe(0);
  expect(readFile(consumer, '.wai/externals.lock.yaml')).toMatch(/habit_portal: \{\}/);
  return { producer, consumer };
}

/** Rewrite the producer's contract file. */
function editContract(producer: string, edit: (text: string) => string): void {
  const rel = specFile(producer, 'interfaces', 'ihabit_portal');
  writeFile(producer, rel, edit(readFile(producer, rel)));
}

describe('1. a contract used whole: the live gate sees a verb removed, renamed or re-routed (solo-app top-1)', () => {
  it('removed: incompatible by name, exit 1, EXTERNAL_LIVE_INCOMPATIBLE', async () => {
    const { producer, consumer } = await pinnedPair('whole-removed');
    const client = await serve(producer);
    const removed = await callTool(client, 'sdd_update_spec', { kind: 'interface', id: 'ihabit_portal', delta: { methods: [{ name: 'checkIn', action: 'delete' }] } });
    expect(removed.ok, removed.text).toBe(true);
    const status = await sb.run(['externals', 'status'], consumer);
    // Round 10: "habit_portal: unchanged · drifted: re-pin when convenient", exit 0.
    expect(status.code, transcript(status)).toBe(1);
    expect(status.all).toContain('habit_portal.checkIn: removed');
    const validate = await sb.run(['validate'], consumer);
    expect(validate.all, transcript(validate)).toMatch(/\[EXTERNAL_LIVE_INCOMPATIBLE\][^\n]*"habit_portal\.checkIn" gone from the producer's live export table/);
    expect(validate.all).not.toContain('nothing this project uses changed');
  });

  it('renamed: "renamed to" the new name, exit 1', async () => {
    const { producer, consumer } = await pinnedPair('whole-renamed');
    const rename = await sb.run(['method', 'rename', 'habit_portal', 'checkIn', 'markDone'], producer);
    expect(rename.code, transcript(rename)).toBe(0);
    const status = await sb.run(['externals', 'status', '--json'], consumer);
    expect(status.code, transcript(status)).toBe(1);
    const [s] = JSON.parse(status.stdout) as { uses: { member?: string; state: string; renamedTo?: string }[] }[];
    expect(s.uses).toEqual([expect.objectContaining({ member: 'checkIn', state: 'renamed', renamedTo: 'habit_portal.markDone' })]);
  });

  it('a moved route: incompatible (round 11), the verb and its route named', async () => {
    const { producer, consumer } = await pinnedPair('whole-moved');
    editContract(producer, (text) => text.split('path: /habits/{habitId}/check-ins').join('path: /habits/{habitId}/done'));
    const status = await sb.run(['externals', 'status'], consumer);
    expect(status.all, transcript(status)).toContain('habit_portal.checkIn: changed — endpoint moved: PUT /habits/{habitId}/check-ins → PUT /habits/{habitId}/done');
    expect(status.all).toContain('incompatible');
    expect(status.code).toBe(1);
  });
});

describe('2. surface diff on an unchanged tree with a `../` sibling member (lib-and-app top-1)', () => {
  it('right after a committed approval: no change', async () => {
    const folder = sb.project('sibling-diff');
    const sdk = writeProject(path.join(folder, 'geo-sdk'), {
      system: { name: 'geo-sdk', vision: 'Geospatial maths as a library.', targetLanguage: 'Rust', publicInterfaces: [{ from: 'distance', typeDef: 'coordinate', audience: 'external' }] },
      subsystems: [{ id: 'distance', description: 'Distances.', publicInterfaces: [{ typeDef: 'coordinate' }] }],
      types: [
        { id: 'coordinate', kind: 'value-object', subsystem: 'distance', name: 'Coordinate', description: 'A point.', fields: [{ name: 'lat', type: 'latitude' }, { name: 'lon', type: 'longitude' }] },
        { id: 'latitude', kind: 'value-object', subsystem: 'distance', name: 'Latitude', description: 'Degrees.', holds: 'float' },
        { id: 'longitude', kind: 'value-object', subsystem: 'distance', name: 'Longitude', description: 'Degrees.', holds: 'float' },
      ],
    }, projectYaml('geo-sdk'));
    const app = writeProject(path.join(folder, 'route-planner'), {
      system: { name: 'route-planner', vision: 'Plans delivery routes.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'routing', component: 'route_portal', audience: 'instance' }] },
      subsystems: [{ id: 'routing', description: 'Routing.', publicInterfaces: [{ component: 'route_portal', details: 'The routing API.' }] }],
      components: [{ id: 'route_portal', componentType: 'Portal', transport: 'HTTP', description: 'The routing API.', invokedBy: { kind: 'entry', caller: 'The dispatch web app, over HTTPS' } }],
      interfaces: [{ id: 'iroute_portal', component: 'route_portal', methods: [
        { name: 'nearest', description: 'The nearest depot.', params: [{ name: 'at', type: 'geo::coordinate' }], returns: 'geo::coordinate', effect: 'read', endpoint: { transport: 'HTTP', method: 'POST', path: '/nearest' } },
      ] }],
      implementations: [{ id: 'route_portal_impl', contract: 'iroute_portal', methods: [{ name: 'nearest', narrative: [{ stepNumber: 1, description: 'Answer', type: 'return', outcome: 'success' }] }] }],
    }, projectYaml('route-planner', { members: { geo: '../geo-sdk' } }));
    git(sdk, 'init', '-q');
    git(app, 'init', '-q');
    for (const dir of [sdk, app]) {
      const lock = await sb.run(['lock', '-y'], dir);
      expect(lock.code, transcript(lock)).toBe(0);
      git(dir, 'add', '-A');
      git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'approved');
    }
    const diff = await sb.run(['surface', 'diff'], app);
    expect(diff.code, transcript(diff)).toBe(0);
    // Round 10: "changed route_portal.nearest — signature reads the same, but a type it names changed shape: "geo::coordinate", …".
    expect(diff.all).toContain('no change');
    expect(diff.all).not.toContain('changed shape');
  });
});

describe('3. the live comparison and the producer\'s route move (tinkerer)', () => {
  it('an added field is named; the route move names the consumer it breaks', async () => {
    const { producer, consumer } = await pinnedPair('fields-and-routes');
    const types = path.join(producer, specFile(producer, 'types', 'habit'));
    const habit = readYamlFile(types) as { fields: unknown[] };
    writeYamlFile(types, { ...habit, fields: [{ name: 'title', type: 'string', previousNames: ['name'] }, { name: 'cadence', type: 'string' }] });
    expect(readFile(producer, specFile(producer, 'types', 'habit'))).toContain('cadence');
    const status = await sb.run(['externals', 'status'], consumer);
    expect(status.all, transcript(status)).toContain('field "habit.name" renamed to "title"; field "habit.cadence" added (its shape is otherwise unchanged)');

    const client = await serve(producer);
    const move = await callTool(client, 'sdd_set_endpoints', { interface: 'ihabit_portal', endpoints: [{ method: 'checkIn', transport: 'HTTP', httpMethod: 'PUT', path: '/habits/{habitId}/done' }], dryRun: true, search: ['..'] });
    expect(move.ok, move.text).toBe(true);
    // Round 10: no breaks section on a route move.
    expect(move.text).toMatch(/PUBLISHED as: habit_portal \(checkIn\)[^\n]*the route of each would move/);
    expect(move.text).toMatch(/BREAKS 1 consumer\(s\)[^\n]*\n- reminders \(externals\.legacy\)/);
  });
});

describe('4. sdd_get_spec reads an external\'s pin by alias::name (solo-app, tinkerer)', () => {
  it('a carried type, and a contract narrowed to methods with no kind', async () => {
    const { consumer } = await pinnedPair('pinned-reads');
    const client = await serve(consumer);
    const type = await callTool(client, 'sdd_get_spec', { kind: 'type', id: 'legacy::habit' });
    // Round 10: `Spec of kind "type" with ID "legacy::habit" does not exist.`
    expect(type.ok, type.text).toBe(true);
    expect(type.text).toMatch(/carried by \\"habit_portal\\"/);
    const narrowed = await callTool(client, 'sdd_get_spec', { id: 'legacy::habit_portal', methods: ['getHabit'] });
    // Round 10: `No spec of any kind has the ID "legacy::habit_portal".`
    expect(narrowed.ok, narrowed.text).toBe(true);
    expect(narrowed.text).toContain('"partialResult"');
    expect(narrowed.text).not.toContain('"checkIn"');
  });
});

describe('5. BINDING_DRIFT into a member says the member\'s (lib-and-app)', () => {
  it('a parameter and a field read "the member\'s"', async () => {
    const folder = sb.project('member-binding');
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
    const r = await sb.run(['validate'], app);
    expect(r.all, transcript(r)).toContain('parameter 1 of "haversine_distance" is "origin", the member\'s is "from"');
    expect(r.all).toContain('the member\'s type has field "lon" the binding does not declare');
    expect(r.all).not.toMatch(/the pin's|the pinned type/);
  });
});
