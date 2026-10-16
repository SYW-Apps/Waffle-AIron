import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { FixtureTree } from '../rules-matrix/harness';
import { DIST_CLI, callTool } from './helpers';
import { createTrialSandbox, readFile, transcript, type TrialSandbox } from './trials-helpers';
import { projectYaml } from '../helpers/conformance-r6-trees';

// ---------------------------------------------------------------------------
// Round-11 user trials (dev.115) — members, externals and approval, replayed
// against the BUILT CLI and server:
//   1. `sdd_get_spec {kind: system, id: "geo::geo-sdk"}` answered the
//      CONSUMER's own L0 under the member's id — lib-and-app top-1.
//   2. `wairon lock` with a dirty member said "its lockedAt … kept" and wrote
//      a new lockedAt — lib-and-app R11-2.
//   3. a write's change report echoed `geo::distance` as the producer's
//      internal `geo-sdk::distance_portal` — lib-and-app R11-9.
//   4. the live externals gate called a moved wire route `unchanged …
//      drifted`, exit 0 — solo-app top-3.
//   5. `surface export --out <folder>` failed on a raw EISDIR — solo-app.
//   6. an approval an older release took, carried over, was silent —
//      lib-and-app R11-1.
// ---------------------------------------------------------------------------

let sb: TrialSandbox;
let seq = 0;
beforeAll(() => { sb = createTrialSandbox('r11surf'); });
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

/** The structured twin of a tool answer. */
const structuredOf = (r: { raw?: unknown }): unknown => (r.raw as { structuredContent?: unknown } | undefined)?.structuredContent;

async function serve(dir: string): Promise<Client> {
  const env: Record<string, string> = Object.fromEntries(Object.entries(sb.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
  env.WAIRON_PROJECT_DIR = dir;
  const client = new Client({ name: 'wairon-e2e-r11-surfaces', version: '0.0.1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [DIST_CLI, 'mcp', 'serve'], cwd: dir, env, stderr: 'ignore' }));
  open.push(client);
  return client;
}

/** The SDK: an InProcess library exporting a distance Portal and its point type. */
function geoSdk(): FixtureTree {
  return {
    system: { name: 'geo-sdk', vision: 'Geospatial maths as a library.', targetLanguage: 'Rust', publicInterfaces: [
      { from: 'distance', component: 'distance_portal', as: 'distance', audience: 'external' },
      { from: 'distance', typeDef: 'coordinate', audience: 'external' },
    ] },
    subsystems: [{ id: 'distance', description: 'Distances.', publicInterfaces: [{ component: 'distance_portal', details: 'Distances.' }, { typeDef: 'coordinate' }] }],
    components: [{ id: 'distance_portal', componentType: 'Portal', transport: 'InProcess', abi: 'c', description: 'The distance API.', invokedBy: { kind: 'entry', caller: 'Applications linking the crate' } }],
    interfaces: [{ id: 'idistance_portal', component: 'distance_portal', methods: [{ name: 'haversine_distance', description: 'd', params: [{ name: 'from', type: 'coordinate' }, { name: 'to', type: 'coordinate' }], returns: 'float', effect: 'none' }] }],
    implementations: [{ id: 'distance_portal_impl', contract: 'idistance_portal', methods: [{ name: 'haversine_distance', narrative: [{ stepNumber: 1, description: 'Compute', type: 'return', outcome: 'success' }] }] }],
    types: [{ id: 'coordinate', kind: 'value-object', subsystem: 'distance', name: 'Coordinate', description: 'A point.', fields: [{ name: 'lat', type: 'float' }, { name: 'lon', type: 'float' }] }],
  };
}

/** The app: a sequencer reaching the SDK through its alias `geo`. */
function routePlanner(): FixtureTree {
  return {
    system: { name: 'route-planner', vision: 'Plans delivery routes.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'routing', description: 'Routing.' }],
    components: [{ id: 'stop_sequencer', componentType: 'Orchestrator', description: 'Orders stops by distance.', dependsOn: ['geo::distance'], invokedBy: { kind: 'runtime', caller: 'The planning job the composition root schedules' } }],
    interfaces: [{ id: 'istop_sequencer', component: 'stop_sequencer', methods: [{ name: 'sequence', description: 'Order the stops.', params: [{ name: 'stops', type: 'list<geo::coordinate>' }], returns: 'list<geo::coordinate>', effect: 'none' }] }],
    implementations: [{ id: 'stop_sequencer_impl', contract: 'istop_sequencer', methods: [{ name: 'sequence', detail: 'intent', intent: 'Orders the stops nearest-first by their haversine distance from the depot; an empty list answers empty.', calls: ['geo::distance.haversine_distance'] }] }],
  };
}

function family(name: string): { sdk: string; app: string } {
  const folder = sb.project(name);
  const sdk = writeProject(path.join(folder, 'geo-sdk'), geoSdk(), projectYaml('geo-sdk'));
  const app = writeProject(path.join(folder, 'route-planner'), routePlanner(), projectYaml('route-planner', { members: { geo: '../geo-sdk' } }));
  return { sdk, app };
}


describe('1. sdd_get_spec reads a member\'s L0 by its alias (lib-and-app top-1)', () => {
  it('kind system, alias::<its name>: the MEMBER\'s own L0 with its export table, never the consumer\'s', async () => {
    const { app } = family('member-l0');
    const client = await serve(app);
    for (const id of ['geo::geo-sdk', 'geo::system', 'geo-sdk::geo-sdk']) {
      const r = await callTool(client, 'sdd_get_spec', { kind: 'system', id });
      // Round 11: `{"id":"geo::geo-sdk","spec":{"name":"route-planner", …}}` — the consumer's own L0 relabelled.
      expect(r.ok, r.text).toBe(true);
      expect(structuredOf(r)).toMatchObject({ kind: 'system', id, spec: { name: 'geo-sdk', vision: 'Geospatial maths as a library.' }, memberProject: { alias: 'geo', project: 'geo-sdk', root: '../geo-sdk', readOnly: true } });
      expect(r.text).toContain('"publicInterfaces"');
      expect(r.text).not.toContain('route-planner is');
      expect(r.text).not.toContain('Plans delivery routes.');
    }
  });

  it('no kind: the member\'s L0 is inferred, where round 11 said "No spec of any kind"', async () => {
    const { app } = family('member-l0-nokind');
    const client = await serve(app);
    const r = await callTool(client, 'sdd_get_spec', { id: 'geo::geo-sdk' });
    expect(r.ok, r.text).toBe(true);
    expect(structuredOf(r)).toMatchObject({ kind: 'system', spec: { name: 'geo-sdk' } });
  });

  it('refuses, never relabels: a name the member\'s L0 does not go by, an unknown alias, and a bare id that is no name of this L0', async () => {
    const { app } = family('member-l0-refusals');
    const client = await serve(app);
    const wrongName = await callTool(client, 'sdd_get_spec', { kind: 'system', id: 'geo::nonsense' });
    expect(wrongName.ok).toBe(false);
    expect(wrongName.text).toContain('the member "geo" (project geo-sdk) has its L0 read as "geo::system" or "geo::geo-sdk"');
    const unknown = await callTool(client, 'sdd_get_spec', { kind: 'system', id: 'nope::system' });
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain('"nope" is no member, part or external of this project');
    const bare = await callTool(client, 'sdd_get_spec', { kind: 'system', id: 'geo-sdk' });
    expect(bare.ok).toBe(false);
    expect(bare.text).toContain('this project\'s L0 is read as "system" or "route-planner"');
    const own = await callTool(client, 'sdd_get_spec', { kind: 'system', id: 'system' });
    expect(own.ok, own.text).toBe(true);
    expect(structuredOf(own)).toMatchObject({ spec: { name: 'route-planner' } });
    expect(structuredOf(own)).not.toHaveProperty('memberProject');
  });

  it('an external\'s L0 is refused naming the names its pin exports', async () => {
    const { producer, consumer } = await pinnedPair('external-l0');
    expect(producer).toBeTruthy();
    const client = await serve(consumer);
    const r = await callTool(client, 'sdd_get_spec', { kind: 'system', id: 'legacy::habitly-api' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('"legacy" is an external of this project: its L0 is not held here');
    expect(r.text).toContain('(habit_portal)');
  });
});

describe('2. `wairon lock` with a drifted member keeps its word (lib-and-app R11-2)', () => {
  it('"lockedAt … kept" is true: the member\'s new state is refreshed beside the unchanged approval', async () => {
    const { sdk, app } = family('dirty-member');
    for (const dir of [sdk, app]) {
      const lock = await sb.run(['lock', '-y'], dir);
      expect(lock.code, transcript(lock)).toBe(0);
    }
    const before = JSON.parse(readFile(app, '.wai/lock.json')) as { lockedAt: string; stateId: unknown; members: Record<string, { state: string }> };
    const rename = await sb.run(['type', 'rename-field', 'coordinate', 'lat', 'latitude'], sdk);
    expect(rename.code, transcript(rename)).toBe(0);
    const relock = await sb.run(['lock', '-y'], app);
    expect(relock.code, transcript(relock)).toBe(0);
    const after = JSON.parse(readFile(app, '.wai/lock.json')) as typeof before;
    // Round 11: the run said "its lockedAt … kept" and wrote a new lockedAt.
    expect(relock.all).toContain('its lockedAt and any restamp trace are kept');
    expect(relock.all).toContain('the member state(s) recorded beside their unchanged pins (geo: approved → drifted)');
    expect(after.lockedAt).toBe(before.lockedAt);
    expect(after.stateId).toEqual(before.stateId);
    expect(after.members.geo.state).toBe('drifted');
    // The gate's word is unchanged: the member is not covered by its own approval.
    const check = await sb.run(['lock-check', '--strict'], app);
    expect(check.code, transcript(check)).toBe(1);
  });
});

describe('3. a write\'s change report echoes what it stores (lib-and-app R11-9)', () => {
  it('a public-name reference is echoed as `geo::distance`, never as the producer\'s internal id', async () => {
    const { app } = family('echo');
    const client = await serve(app);
    const cleared = await callTool(client, 'sdd_update_spec', { kind: 'component', id: 'stop_sequencer', delta: { dependsOn: [] } });
    expect(cleared.ok, cleared.text).toBe(true);
    expect(cleared.text).toContain('"[\\"geo::distance\\"]"');
    const added = await callTool(client, 'sdd_update_spec', { kind: 'component', id: 'stop_sequencer', delta: { dependsOn: ['geo::distance'] } });
    expect(added.ok, added.text).toBe(true);
    expect(added.text).toContain('dependsOn added: "geo::distance"');
    expect(added.text).not.toContain('geo-sdk::distance_portal');
  });
});

// ---------------------------------------------------------------------------
// The live externals gate on a moved route (solo-app top-3).
// ---------------------------------------------------------------------------

/** The habit API: an HTTP Portal exported to other projects. */
function habitApi(): FixtureTree {
  const verb = (name: string, routePath: string) => ({ name, description: name, params: [{ name: 'habitId', type: 'string' }], returns: 'int', effect: 'read', endpoint: { transport: 'HTTP', method: 'PUT', path: routePath } });
  return {
    system: { name: 'Habitly', vision: 'Habits and their check-ins.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'habits', component: 'habit_portal', audience: 'instance' }] },
    subsystems: [{ id: 'habits', description: 'Habits.', publicInterfaces: [{ component: 'habit_portal', details: 'The habit API.' }] }],
    components: [{ id: 'habit_portal', componentType: 'Portal', transport: 'HTTP', description: 'The habit API.', invokedBy: { kind: 'entry', caller: 'Clients, over HTTP' } }],
    interfaces: [{ id: 'ihabit_portal', component: 'habit_portal', methods: [verb('checkIn', '/habits/{habitId}/check-ins')] }],
    implementations: [{ id: 'habit_portal_impl', contract: 'ihabit_portal', methods: [{ name: 'checkIn', narrative: [{ stepNumber: 1, description: 'Answer', type: 'return', outcome: 'success' }] }] }],
  };
}

/** The consumer: a hand-written HTTP client Adapter using the habit API whole. */
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
  return { producer, consumer };
}

describe('4. a moved wire route is a break for the consumer that calls it (solo-app top-3)', () => {
  it('`externals status`: incompatible, exit 1, the route named; validate: EXTERNAL_LIVE_INCOMPATIBLE', async () => {
    const { producer, consumer } = await pinnedPair('route-moved');
    const rel = `.wai/specs/interfaces/${fs.readdirSync(path.join(producer, '.wai/specs/interfaces')).find((f) => f.startsWith('ihabit_portal'))!}`;
    fs.writeFileSync(path.join(producer, rel), readFile(producer, rel).split('path: /habits/{habitId}/check-ins').join('path: /habits/{habitId}/done'));
    const status = await sb.run(['externals', 'status'], consumer);
    // Round 11: "habit_portal.checkIn: unchanged — endpoint moved: … drifted: re-pin when convenient", exit 0.
    expect(status.code, transcript(status)).toBe(1);
    expect(status.all).toContain('incompatible');
    expect(status.all).toContain('habit_portal.checkIn: changed — endpoint moved: PUT /habits/{habitId}/check-ins → PUT /habits/{habitId}/done');
    const validate = await sb.run(['validate'], consumer);
    expect(validate.all, transcript(validate)).toMatch(/\[EXTERNAL_LIVE_INCOMPATIBLE\][^\n]*"habit_portal\.checkIn" changed since it was pinned: endpoint moved/);
  });
});

describe('5. `surface export --out <folder>` says what --out takes (solo-app EDGE)', () => {
  it('a folder is refused naming a file path, never a raw EISDIR', async () => {
    const { producer } = await pinnedPair('out-folder');
    const folder = path.join(producer, 'openapi');
    fs.mkdirSync(folder, { recursive: true });
    const r = await sb.run(['surface', 'export', '--format', 'openapi', '--out', folder], producer);
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).not.toContain('EISDIR');
    expect(r.all).toContain('is a folder: give a file path');
    expect(fs.readdirSync(folder)).toEqual([]);
  });
});

describe('6. an approval an older release took, carried over with no rule moved, is said once (lib-and-app R11-1)', () => {
  it('lock-check, status and validate each name the release that took it, as a notice', async () => {
    const { sdk } = family('carry-over');
    const lock = await sb.run(['lock', '-y'], sdk);
    expect(lock.code, transcript(lock)).toBe(0);
    const record = JSON.parse(readFile(sdk, '.wai/lock.json')) as Record<string, unknown>;
    // The record as an earlier release wrote it: only its stamp differs (the release gate part is this release's).
    fs.writeFileSync(path.join(sdk, '.wai', 'lock.json'), `${JSON.stringify({ ...record, validatorVersion: '5.1.1-dev.1' }, null, 2)}\n`);
    const said = 'approved under wairon 5.1.1-dev.1; this release';
    const check = await sb.run(['lock-check', '--strict'], sdk);
    // Round 11: "✔ … approved <date> by <who>." and nothing about the release.
    expect(check.code, transcript(check)).toBe(0);
    expect(check.all).toContain(said);
    const status = await sb.run(['status'], sdk);
    expect(status.all, transcript(status)).toContain(said);
    const validate = await sb.run(['validate'], sdk);
    expect(validate.code, transcript(validate)).toBe(0);
    expect(validate.all).toContain(`Approval notice: ${said}`);
  });
});
