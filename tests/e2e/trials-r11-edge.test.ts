import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { FixtureTree } from '../rules-matrix/harness';
import { DIST_CLI, callTool } from './helpers';
import { createTrialSandbox, transcript, type TrialSandbox } from './trials-helpers';
import { projectYaml } from '../helpers/conformance-r6-trees';

// ---------------------------------------------------------------------------
// Round-11 user trials — the EDGE backlog, replayed against the BUILT CLI and
// server on a `../` sibling-member family:
//   1. `status`, after only the member's pin moved, said "this project is
//      drifted" beside "no spec has changed since" — lib-and-app R11-11.
//   2. `lock-check` said "This project's own approval is stale too" where
//      none of the project's own specs had moved — lib-and-app R11-9.
//   3. `project rename` from the member's root never named the parent that
//      declares it under `members:` — lib-and-app R10-12 / R11-3.
//   4. the field rename had no mentions sweep: prose spelling the old field
//      stayed stale with no tool saying so — lib-and-app R11-12.
//   5. the briefs named no binding tag convention — lib-and-app R11-8.
// ---------------------------------------------------------------------------

let sb: TrialSandbox;
let seq = 0;
beforeAll(() => { sb = createTrialSandbox('r11edge'); });
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

async function serve(dir: string): Promise<Client> {
  const env: Record<string, string> = Object.fromEntries(Object.entries(sb.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
  env.WAIRON_PROJECT_DIR = dir;
  const client = new Client({ name: 'wairon-e2e-r11-edge', version: '0.0.1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [DIST_CLI, 'mcp', 'serve'], cwd: dir, env, stderr: 'ignore' }));
  open.push(client);
  return client;
}

/** The SDK: an InProcess library exporting a distance Portal and its point type, whose prose spells the fields. */
function geoSdk(): FixtureTree {
  return {
    system: { name: 'geo-sdk', vision: 'Geospatial maths as a library.', targetLanguage: 'Rust', publicInterfaces: [
      { from: 'distance', component: 'distance_portal', as: 'distance', audience: 'external' },
      { from: 'distance', typeDef: 'coordinate', audience: 'external' },
    ] },
    subsystems: [{ id: 'distance', description: 'Distances.', publicInterfaces: [{ component: 'distance_portal', details: 'Distances.' }, { typeDef: 'coordinate' }] }],
    components: [{ id: 'distance_portal', componentType: 'Portal', transport: 'InProcess', abi: 'c', description: 'The distance API.', invokedBy: { kind: 'entry', caller: 'Applications linking the crate' } }],
    interfaces: [{ id: 'idistance_portal', component: 'distance_portal', methods: [{ name: 'haversine_distance', description: 'd', params: [{ name: 'from', type: 'coordinate' }, { name: 'to', type: 'coordinate' }], returns: 'float', effect: 'none' }] }],
    implementations: [{ id: 'distance_portal_impl', contract: 'idistance_portal', methods: [{ name: 'haversine_distance', narrative: [{ stepNumber: 1, description: 'Compute the great-circle distance from each point\'s lat and lon', type: 'return', outcome: 'success' }] }] }],
    types: [{ id: 'coordinate', kind: 'value-object', subsystem: 'distance', name: 'Coordinate', description: 'A point: lat and lon in degrees.', fields: [{ name: 'lat', type: 'float' }, { name: 'lon', type: 'float' }] }],
  };
}

/** The app: a sequencer reaching the SDK through its alias `geo`. */
function routePlanner(): FixtureTree {
  return {
    system: { name: 'route-planner', vision: 'Plans delivery routes.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'routing', description: 'Routing.' }],
    components: [{ id: 'stop_sequencer', componentType: 'Orchestrator', description: 'Orders stops by distance.', dependsOn: ['geo::distance'], invokedBy: { kind: 'runtime', caller: 'The planning job the composition root schedules' } }],
    interfaces: [{ id: 'istop_sequencer', component: 'stop_sequencer', methods: [{ name: 'sequence', description: 'Order the stops.', params: [{ name: 'stops', type: 'list<geo::coordinate>' }], returns: 'list<geo::coordinate>', effect: 'none' }] }],
    implementations: [{ id: 'stop_sequencer_impl', contract: 'istop_sequencer', sourcePath: 'src/routing/stop_sequencer.ts', methods: [{ name: 'sequence', detail: 'intent', intent: 'Orders the stops nearest-first by their haversine distance from the depot; an empty list answers empty. The lat of a stop is never read here.', calls: ['geo::distance.haversine_distance'] }] }],
  };
}

function family(name: string): { sdk: string; app: string } {
  const folder = sb.project(name);
  const sdk = writeProject(path.join(folder, 'geo-sdk'), geoSdk(), projectYaml('geo-sdk'));
  const app = writeProject(path.join(folder, 'route-planner'), routePlanner(), projectYaml('route-planner', { members: { geo: '../geo-sdk' } }));
  return { sdk, app };
}

async function lockBoth(sdk: string, app: string): Promise<void> {
  for (const dir of [sdk, app]) {
    const lock = await sb.run(['lock', '-y'], dir);
    expect(lock.code, transcript(lock)).toBe(0);
  }
}

describe('1-2. a moved member pin is said as what it is (lib-and-app R11-11, R11-9)', () => {
  it('status names the member re-approved at its own root and the fix, never "drifted" beside "no spec has changed"', async () => {
    const { sdk, app } = family('pin-moved');
    await lockBoth(sdk, app);
    const rename = await sb.run(['type', 'rename-field', 'coordinate', 'lat', 'latitude'], sdk);
    expect(rename.code, transcript(rename)).toBe(0);
    const relock = await sb.run(['lock', '-y'], sdk);
    expect(relock.code, transcript(relock)).toBe(0);

    const status = await sb.run(['status'], app);
    // Round 11: "this project is drifted — its approval no longer covers this tree" and "no spec has changed since".
    expect(status.all, transcript(status)).toContain('none of its own specs changed, but member geo was re-approved at its own root since, and this approval still pins its earlier approval');
    expect(status.all).toContain('none of this project\'s own specs has changed since; what moved is a member\'s approval.');
    expect(status.all).toContain('Member pin moved since approval: geo was re-approved at its own root after this approval');
    expect(status.all).not.toContain('this project is drifted');
    expect(status.all).not.toContain('— no spec has changed since.');

    // The member dirtied again: lock-check names what this approval no longer covers.
    const again = await sb.run(['type', 'rename-field', 'coordinate', 'lon', 'longitude'], sdk);
    expect(again.code, transcript(again)).toBe(0);
    const check = await sb.run(['lock-check'], app);
    expect(check.code, transcript(check)).toBe(1);
    // Round 11: "This project's own approval is stale too".
    expect(check.all).not.toContain('stale too');
    expect(check.all).toContain('None of this project\'s own specs changed, but its approval does not cover it either: a member\'s approval moved since it was taken (this approval still pins geo at an earlier approval)');
  });

  it('lock-check: a dirty member beside an approval that still covers this project says so', async () => {
    const { sdk, app } = family('member-dirty');
    await lockBoth(sdk, app);
    const rename = await sb.run(['type', 'rename-field', 'coordinate', 'lat', 'latitude'], sdk);
    expect(rename.code, transcript(rename)).toBe(0);
    const check = await sb.run(['lock-check'], app);
    expect(check.code, transcript(check)).toBe(1);
    expect(check.all).toContain('This project\'s own approval still covers its design.');
  });
});

describe('3. `project rename` from a member\'s root names the parent declaring it (lib-and-app R10-12 / R11-3)', () => {
  it('the report names route-planner, its folder and its alias, and writes nothing there', async () => {
    const { sdk, app } = family('rename-from-member');
    const before = fs.readFileSync(path.join(app, '.wai', 'project.yaml'), 'utf8');
    const r = await sb.run(['project', 'rename', 'geo-core', '--report'], sdk);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toContain(`Outside this family: route-planner (${path.join('..', 'route-planner')}) declares this project as its member "geo" — nothing there is written. Once this project is re-locked as "geo-core", run \`wairon lock\``);
    expect(fs.readFileSync(path.join(app, '.wai', 'project.yaml'), 'utf8')).toBe(before);
  });
});

describe('4. the field rename reports the prose it leaves alone (lib-and-app R11-12)', () => {
  it('CLI dry run: the type and the implementation spelling the old field are named; a spec without the type in view is not', async () => {
    const { sdk } = family('field-mentions');
    const r = await sb.run(['type', 'rename-field', 'coordinate', 'lat', 'latitude', '--dry-run'], sdk);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toContain('Left alone (prose still names "lat"');
    expect(r.all).toMatch(/Left alone[^\n]*coordinate/);
    expect(r.all).toMatch(/Left alone[^\n]*distance_portal_impl/);
  });

  it('MCP: sdd_rename_field answers `mentions`, dry run and real alike', async () => {
    const { sdk } = family('field-mentions-mcp');
    const client = await serve(sdk);
    const dry = await callTool(client, 'sdd_rename_field', { id: 'coordinate', field: 'lon', newName: 'longitude', dryRun: true });
    expect(dry.ok, dry.text).toBe(true);
    const report = JSON.parse(dry.text) as { mentions: string[]; dryRun: boolean };
    expect(report.dryRun).toBe(true);
    expect(report.mentions).toEqual(['coordinate', 'distance_portal_impl']);
    const real = await callTool(client, 'sdd_rename_field', { id: 'coordinate', field: 'lon', newName: 'longitude' });
    expect(real.ok, real.text).toBe(true);
    expect((JSON.parse(real.text) as { mentions: string[] }).mentions).toEqual(['coordinate', 'distance_portal_impl']);
  });
});

describe('5. the brief names the binding tag convention (lib-and-app R11-8)', () => {
  it('a component reaching a member gets the doc-comment tag spelled with its alias', async () => {
    const { app } = family('brief-tags');
    const r = await sb.run(['agent', 'brief', 'routing-owner'], app);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toContain('Tag each declaration in a binding that mirrors a producer name with a doc comment naming it — `/** geo::<public name> */`');
    expect(r.all).toContain('`/** geo::<public name>.<method> */` above a free function');
  });
});
