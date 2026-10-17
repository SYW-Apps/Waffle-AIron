import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  createTrialSandbox,
  readFile,
  transcript,
  writeFile,
  type TrialSandbox,
} from './trials-helpers';
import { BASE_FIXTURE_RULES, materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DIST_CLI, REPO_ROOT } from './helpers';

// ---------------------------------------------------------------------------
// Round-5 trial regression journeys — approval and lock integrity, doctor,
// externals and surfaces, the OpenAPI codec. Each journey replays a probe the
// round-5 trials (tinkerer, solo-app, lib-and-app, platform) ran by hand on
// the BUILT CLI and asserts what the fix promises: exit codes and the words a
// person reads.
//
//   1  a corrupt or unsupported .wai/lock.json fails closed everywhere; a
//      deleted L0 with spec files below it is an error, never "empty"
//   2  doctor --fix never records the machine's installed packs into a repo
//   3  effect travels through signatureFrom; surface diff names an undeclared effect
//   4  field and parameter renames reach the consumer with their new names;
//      a use beyond the pin is named by validate
//   5  dry runs say they are dry runs
//   6  the OpenAPI document of a project's own HTTP Portal
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z';

function configYaml(id: string, extra: Record<string, unknown> = {}): string {
  return yaml.dump({
    schemaVersion: '1.0.0', id, name: id,
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: BASE_FIXTURE_RULES,
    extensions: { packs: [], useGlobalPacks: false },
    ...extra, createdAt: TS, updatedAt: TS,
  }, { noRefs: true, lineWidth: 200 });
}

/** (Re)write a project's .wai from a fixture tree, keeping its lock record and pins. */
function writeProject(dir: string, id: string, tree: FixtureTree, extra: Record<string, unknown> = {}): void {
  const keep = ['lock.json', 'externals.lock.yaml', 'externals'];
  const stash = path.join(dir, '.wai-keep');
  const saved: string[] = [];
  for (const name of keep) {
    const p = path.join(dir, '.wai', name);
    if (fs.existsSync(p)) {
      fs.mkdirSync(stash, { recursive: true });
      fs.renameSync(p, path.join(stash, name));
      saved.push(name);
    }
  }
  fs.rmSync(path.join(dir, '.wai'), { recursive: true, force: true });
  materializeFixtureProject(dir, tree);
  for (const name of saved) fs.renameSync(path.join(stash, name), path.join(dir, '.wai', name));
  fs.rmSync(stash, { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), configYaml(id, extra));
}

const ENTRY = { kind: 'entry', caller: 'Browsers of the habit tracker, over the public internet.' };

/** Habitly: one subsystem with a Portal and its orchestrator. */
function habitly(): FixtureTree {
  return {
    system: { name: 'Habitly', vision: 'A habit-tracking API for people building routines.' },
    subsystems: [{ id: 'habits', description: 'Habits and their check-ins.' }],
    components: [
      { id: 'habit_portal', componentType: 'Portal', transport: 'HTTP', invokedBy: ENTRY, dependsOn: ['habit_orchestrator'] },
      { id: 'habit_orchestrator', componentType: 'Orchestrator' },
    ],
    interfaces: [
      { id: 'ihabit_portal', component: 'habit_portal', methods: [{ name: 'checkIn', description: 'Record a check-in.', signature: 'checkIn(): void', returns: 'void', endpoint: { transport: 'HTTP', method: 'POST', path: '/check-ins' } }] },
      { id: 'ihabit_orchestrator', component: 'habit_orchestrator', methods: [{ name: 'checkIn', description: 'Record a check-in.', signature: 'checkIn(): void', returns: 'void' }] },
    ],
    implementations: [
      { id: 'habit_portal_impl', contract: 'ihabit_portal', lint: { allow: [{ code: 'MISSING_SOURCE_PATH', reason: 'design-only e2e journey — the code lives outside this scratch project' }] }, methods: [{ name: 'checkIn', narrative: [{ stepNumber: 1, type: 'call', description: 'Record it.', targetComponent: 'habit_orchestrator', targetMethod: 'checkIn' }] }] },
      { id: 'habit_orchestrator_impl', contract: 'ihabit_orchestrator', lint: { allow: [{ code: 'MISSING_SOURCE_PATH', reason: 'design-only e2e journey — the code lives outside this scratch project' }] }, methods: [{ name: 'checkIn', detail: 'intent', intent: 'Records one check-in for today on the habit it names, and fails when that habit is unknown or archived.' }] },
    ],
  };
}

let sb: TrialSandbox;

beforeAll(() => {
  sb = createTrialSandbox('r5-approval');
});

afterAll(async () => {
  await sb?.cleanup();
});

/** A locked Habitly project, ready to have its lock record or L0 broken. */
async function lockedHabitly(name: string): Promise<string> {
  const dir = sb.project(name);
  writeProject(dir, 'habitly', habitly());
  const lock = await sb.run(['lock', '--yes'], dir);
  expect(lock.code, transcript(lock)).toBe(0);
  return dir;
}

// ---------------------------------------------------------------------------

describe('1a — a corrupt or unsupported lock record fails closed on every command (tinkerer R5 M1)', () => {
  const corrupt: [string, string][] = [
    ['a truncated object', '{'],
    ['JSON null', 'null'],
    ['an empty file', ''],
    ['a BOM alone', '﻿'],
    ['a string', '"str"'],
    ['valid JSON that is no lock record', '{"formatVersion": 99}'],
  ];

  for (const [what, content] of corrupt) {
    it(`${what}: lock-check (plain and --strict), status and validate each say the record cannot be read, exit non-zero`, async () => {
      const dir = await lockedHabitly(`corrupt-${corrupt.findIndex(([w]) => w === what)}`);
      fs.writeFileSync(path.join(dir, '.wai', 'lock.json'), content);
      for (const args of [['lock-check'], ['lock-check', '--strict'], ['status'], ['validate', '--ci']]) {
        const r = await sb.run(args, dir);
        expect(r.code, `${args.join(' ')}\n${transcript(r)}`).not.toBe(0);
        expect(r.all).toContain('.wai/lock.json cannot be read as an approval record');
        // Round 5: "No approval on record (.wai/lock.json is absent)" and a green plain lock-check.
        expect(r.all).not.toContain('is absent');
        expect(r.all).not.toContain('Cannot read properties of undefined');
        expect(r.all).not.toMatch(/\n\s+at /);
      }
    });
  }

  it('a record of a newer format is refused as unsupported, naming the format', async () => {
    const dir = await lockedHabitly('newer-format');
    const record = JSON.parse(readFile(dir, '.wai/lock.json')) as Record<string, unknown>;
    fs.writeFileSync(path.join(dir, '.wai', 'lock.json'), JSON.stringify({ ...record, format: 99 }, null, 2));
    const r = await sb.run(['lock-check'], dir);
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toContain('it is lock record format 99, written by a newer wairon');
  });

  it('`lock` never overwrites a record it cannot read: refused, saying what to do, the bytes untouched', async () => {
    const dir = await lockedHabitly('lock-overwrite');
    fs.writeFileSync(path.join(dir, '.wai', 'lock.json'), '{');
    const r = await sb.run(['lock', '--yes'], dir);
    expect(r.code, transcript(r)).not.toBe(0);
    expect(r.all).toContain('wairon never overwrites a record it cannot read');
    expect(r.all).toContain('git checkout -- .wai/lock.json');
    expect(readFile(dir, '.wai/lock.json')).toBe('{');
  });

  it('doctor names the unreadable record instead of staying silent', async () => {
    const dir = await lockedHabitly('doctor-corrupt');
    fs.writeFileSync(path.join(dir, '.wai', 'lock.json'), 'null');
    const r = await sb.run(['doctor'], dir);
    expect(r.all).toContain('.wai/lock.json cannot be read as an approval record');
  });

  it('control: an editor\'s BOM before a valid record changes nothing — still approved', async () => {
    const dir = await lockedHabitly('bom-record');
    fs.writeFileSync(path.join(dir, '.wai', 'lock.json'), `﻿${readFile(dir, '.wai/lock.json')}`);
    const r = await sb.run(['lock-check', '--strict'], dir);
    expect(r.code, transcript(r)).toBe(0);
  });

  it('control: no record at all is still "no approval on record", and plain lock-check still passes it', async () => {
    const dir = sb.project('no-record');
    writeProject(dir, 'habitly', habitly());
    const r = await sb.run(['lock-check'], dir);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toContain('No approval on record (.wai/lock.json is absent)');
  });
});

describe('1b — a deleted L0 with spec files below it fails closed (tinkerer R5 M2)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await lockedHabitly('deleted-l0');
    fs.rmSync(path.join(dir, '.wai', 'specs', '.index.yaml'));
  });

  it('validate and validate --ci report the missing L0 as an error, never "the spec tree is empty"', async () => {
    for (const args of [['validate'], ['validate', '--ci']]) {
      const r = await sb.run(args, dir);
      expect(r.code, transcript(r)).toBe(1);
      expect(r.all).toContain('.wai/specs/.index.yaml');
      expect(r.all).toMatch(/spec file\(s\) remain/);
      expect(r.all).not.toContain('Nothing to check yet');
    }
  });

  it('plain lock-check fails, never "nothing is gated"', async () => {
    const r = await sb.run(['lock-check'], dir);
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/spec file\(s\) remain/);
    expect(r.all).not.toContain('nothing is gated');
  });

  it('control: an empty project still reads as no tree, and passes plain lock-check', async () => {
    const empty = sb.project('empty-tree');
    writeProject(empty, 'empty', habitly());
    fs.rmSync(path.join(empty, '.wai', 'specs'), { recursive: true, force: true });
    const r = await sb.run(['lock-check'], empty);
    expect(r.code, transcript(r)).toBe(0);
  });
});

describe('2 — doctor --fix never records the machine\'s installed packs into the repository (tinkerer R5 M4, solo-app "doctor pack leak")', () => {
  let dir: string;

  beforeAll(async () => {
    // A pack an earlier piece of work left in this machine's home store.
    const source = sb.project('leftover-pack');
    writeFile(source, 'pack.yaml', 'name: mypack\nversion: 0.1.0\nprofiles:\n  mypack-profile:\n    family: neutral\n');
    const install = await sb.run(['pack', 'install', source], source);
    expect(install.code, transcript(install)).toBe(0);
    // A project that never declared a position on machine-wide packs (no `extensions` key).
    dir = await lockedHabitly('pack-leak');
    const config = yaml.load(readFile(dir, '.wai/project.yaml')) as Record<string, unknown>;
    delete config.extensions;
    fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), yaml.dump(config));
    const relock = await sb.run(['lock', '--yes'], dir);
    expect(relock.code, transcript(relock)).toBe(0);
  });

  it('doctor names the installed pack and how to select it, but --fix writes no selection and the approval holds', async () => {
    const before = readFile(dir, '.wai/project.yaml');
    const report = await sb.run(['doctor'], dir);
    expect(report.all).toContain('mypack@0.1.0');
    expect(report.all).toContain('wairon pack use <name>');
    const fix = await sb.run(['doctor', '--fix', '--yes'], dir);
    // Round 5: "✓ Recorded 1 installed pack(s) as explicit selections: mypack@0.1.0".
    expect(fix.all, transcript(fix)).not.toContain('as explicit selections');
    expect(readFile(dir, '.wai/project.yaml')).toBe(before);
    expect(readFile(dir, '.wai/project.yaml')).not.toContain('mypack');
    const lc = await sb.run(['lock-check', '--strict'], dir);
    expect(lc.code, transcript(lc)).toBe(0);
    const v = await sb.run(['validate', '--ci'], dir);
    expect(v.all).not.toContain('PACK_SOURCE_UNFETCHABLE');
  });
});

// ---------------------------------------------------------------------------
// A producer library whose Portal verb takes its signature from a pure method,
// and a consumer that calls it from pure logic.

/** GeoKit: the Portal verb forwards a pure tile computation (signatureFrom), declaring no effect of its own. */
function geoKit(o: { zoomName?: string; zoomFormerly?: string[]; paramName?: string; paramFormerly?: string[] } = {}): FixtureTree {
  return {
    system: {
      name: 'GeoKit', vision: 'A tiling library for map applications.', targetLanguage: 'TypeScript',
      publicInterfaces: [{ from: 'tiling', component: 'tile-library' }, { from: 'tiling', typeDef: 'tile-key' }],
    },
    subsystems: [{
      id: 'tiling', description: 'Tile arithmetic.',
      publicInterfaces: [{ component: 'tile-library', details: 'The library\'s tile API.' }, { typeDef: 'tile-key', details: 'A tile key.' }],
    }],
    components: [
      { id: 'tile-library', componentType: 'Portal', transport: 'InProcess', description: 'The library\'s tile API.', dependsOn: ['tile-math'], invokedBy: { kind: 'entry', caller: 'Applications that link the GeoKit library and call it directly.' } },
      { id: 'tile-math', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Tile arithmetic over its arguments.' },
    ],
    interfaces: [
      { id: 'itile_library', component: 'tile-library', methods: [{ name: 'tileFor', description: 'The tile key for a zoom.', signatureFrom: 'tile-math.tileFor' }] },
      { id: 'itile_math', component: 'tile-math', methods: [{ name: 'tileFor', description: 'The tile key for a zoom.', params: [{ name: o.paramName ?? 'zoom', type: 'int', ...(o.paramFormerly ? { previousNames: o.paramFormerly } : {}) }], returns: 'tile-key', effect: 'none' }] },
    ],
    implementations: [
      { id: 'tile_library_impl', contract: 'itile_library', lint: { allow: [{ code: 'MISSING_SOURCE_PATH', reason: 'design-only e2e journey — the code lives outside this scratch project' }] }, methods: [{ name: 'tileFor', narrative: [{ stepNumber: 1, type: 'call', description: 'Compute it.', targetComponent: 'tile-math', targetMethod: 'tileFor' }] }] },
      { id: 'tile_math_impl', contract: 'itile_math', lint: { allow: [{ code: 'MISSING_SOURCE_PATH', reason: 'design-only e2e journey — the code lives outside this scratch project' }] }, methods: [{ name: 'tileFor', narrative: [{ stepNumber: 1, type: 'local', description: 'Work out the column of the tile covering the map centre at this zoom.' }, { stepNumber: 2, type: 'return', description: 'Answer the key.', outcome: 'the tile key' }] }] },
    ],
    types: [{
      id: 'tile-key', kind: 'value-object', subsystem: 'tiling', description: 'A tile key.',
      fields: [{ name: 'x', type: 'int' }, { name: o.zoomName ?? 'zoom', type: 'int', ...(o.zoomFormerly ? { previousNames: o.zoomFormerly } : {}) }],
    }],
  };
}

/** TileStudio: calls GeoKit's verb from pure logic (or, before it does, references nothing of it). */
function tileStudio(uses = true): FixtureTree {
  if (!uses) {
    return {
      system: { name: 'TileStudio', vision: 'A map editor that renders tiles computed by GeoKit.', targetLanguage: 'TypeScript' },
      subsystems: [{ id: 'editor', description: 'The map editing canvas.' }],
      components: [{ id: 'map-renderer', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Works out which tiles the map needs.' }],
      interfaces: [{ id: 'imap_renderer', component: 'map-renderer', methods: [{ name: 'visibleTile', description: 'The tile the map centre needs.', params: [{ name: 'zoom', type: 'int' }], returns: 'string', effect: 'none', invokedBy: { kind: 'runtime', caller: 'The editor canvas, once on every pan or zoom of the map view.' } }] }],
      implementations: [{
        id: 'map_renderer_impl', contract: 'imap_renderer',
        lint: { allow: [{ code: 'MISSING_SOURCE_PATH', reason: 'design-only e2e journey — the code lives outside this scratch project' }] },
        methods: [{ name: 'visibleTile', narrative: [{ stepNumber: 1, type: 'local', description: 'Work out the centre tile name.' }, { stepNumber: 2, type: 'return', description: 'Answer it.', outcome: 'the tile name' }] }],
      }],
    };
  }
  return {
    system: { name: 'TileStudio', vision: 'A map editor that renders tiles computed by GeoKit.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'editor', description: 'The map editing canvas.' }],
    components: [
      { id: 'map-renderer', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Works out which tiles the map needs.', dependsOn: ['geo::tile-library'] },
    ],
    interfaces: [
      { id: 'imap_renderer', component: 'map-renderer', methods: [{ name: 'visibleTile', description: 'The tile the map centre needs.', params: [{ name: 'zoom', type: 'int' }], returns: 'geo::tile-key', effect: 'none', invokedBy: { kind: 'runtime', caller: 'The editor canvas, once on every pan or zoom of the map view.' } }] },
    ],
    implementations: [{
      id: 'map_renderer_impl', contract: 'imap_renderer',
      lint: { allow: [{ code: 'MISSING_SOURCE_PATH', reason: 'design-only e2e journey — the code lives outside this scratch project' }] },
      methods: [{
        name: 'visibleTile', narrative: [
          { stepNumber: 1, type: 'call', description: 'Ask GeoKit for the tile key.', targetComponent: 'geo::tile-library', targetMethod: 'tileFor' },
          { stepNumber: 2, type: 'return', description: 'Answer it.', outcome: 'the tile key' },
        ],
      }],
    }],
  };
}

/** A producer + consumer pair under one folder, the consumer pinned to the producer. */
async function pinnedPair(name: string, usesAtPin = true): Promise<{ geo: string; studio: string }> {
  const folder = sb.project(name);
  const geo = path.join(folder, 'geo');
  const studio = path.join(folder, 'studio');
  fs.mkdirSync(geo, { recursive: true });
  fs.mkdirSync(studio, { recursive: true });
  writeProject(geo, 'geo', geoKit());
  writeProject(studio, 'studio', tileStudio(usesAtPin), { externals: { geo: { source: '../geo' } } });
  const pin = await sb.run(['externals', 'pin', 'geo'], studio);
  expect(pin.code, transcript(pin)).toBe(0);
  if (!usesAtPin) writeProject(studio, 'studio', tileStudio(), { externals: { geo: { source: '../geo' } } });
  return { geo, studio };
}

describe('3 — effect travels through signatureFrom (lib-and-app R5-11, R5-16)', () => {
  let p: { geo: string; studio: string };

  beforeAll(async () => {
    p = await pinnedPair('effect');
  });

  it('a pure consumer may call a verb whose signature comes from a pure method: no LIBRARY_CALL_IMPURE', async () => {
    const producer = await sb.run(['validate', '--ci'], p.geo);
    expect(producer.code, transcript(producer)).toBe(0);
    const v = await sb.run(['validate', '--ci'], p.studio);
    // Round 5: LIBRARY_CALL_IMPURE "… whose effect is not declared".
    expect(v.all, transcript(v)).not.toContain('LIBRARY_CALL_IMPURE');
    expect(v.code, transcript(v)).toBe(0);
  });

  it('the pin carries the inherited effect', async () => {
    const pinned = readFile(p.studio, '.wai/externals/geo.yaml');
    expect(pinned).toMatch(/effect: none/);
  });
});

describe('3 — surface diff names an undeclared effect (lib-and-app R5-16)', () => {
  it('declaring `effect: none` on a method that had none reads `effect undeclared → none`, never `none → none`', async () => {
    const dir = sb.project('effect-diff');
    const before = geoKit();
    (before.interfaces as { methods: { effect?: string }[] }[])[1].methods[0].effect = undefined;
    writeProject(dir, 'geo', before);
    const out = path.join(dir, 'before.yaml');
    const exp = await sb.run(['surface', 'export', '--out', out], dir);
    expect(exp.code, transcript(exp)).toBe(0);
    writeProject(dir, 'geo', geoKit());
    const diff = await sb.run(['surface', 'diff', '--against', out], dir);
    expect(diff.code, transcript(diff)).toBe(0);
    expect(diff.all).toContain('effect undeclared → none');
    expect(diff.all).not.toContain('effect none → none');
  });
});

describe('4 — field and parameter renames reach the consumer with their new names (lib-and-app R5-19)', () => {
  let p: { geo: string; studio: string };
  let snapshot: string;

  beforeAll(async () => {
    p = await pinnedPair('renames');
    snapshot = path.join(p.geo, 'before.yaml');
    const exp = await sb.run(['surface', 'export', '--out', snapshot], p.geo);
    expect(exp.code, transcript(exp)).toBe(0);
  });

  it('a parameter rename: surface diff lists it with the new name, and the consumer\'s status names it as a stale fact', async () => {
    const r = await sb.run(['method', 'rename-param', 'tile-math', 'tileFor', 'zoom', 'level'], p.geo);
    expect(r.code, transcript(r)).toBe(0);
    const diff = await sb.run(['surface', 'diff', '--against', snapshot], p.geo);
    // Round 5: not listed at all.
    expect(diff.all, transcript(diff)).toContain('parameter "zoom" renamed to "level"');
    const st = await sb.run(['externals', 'status'], p.studio);
    expect(st.all, transcript(st)).toContain('parameter "zoom" of tile-library.tileFor (renamed to "level")');
  });

  it('a field rename: surface diff and the consumer\'s findings say which field moved and to what', async () => {
    const r = await sb.run(['type', 'rename-field', 'tile-key', 'zoom', 'z'], p.geo);
    expect(r.code, transcript(r)).toBe(0);
    const diff = await sb.run(['surface', 'diff', '--against', snapshot], p.geo);
    expect(diff.all, transcript(diff)).toContain('field "zoom" renamed to "z"');
    expect(diff.all).not.toContain('type shape changed');
    const v = await sb.run(['validate'], p.studio);
    // Round 5: '"tile-key" changed at signature level' — anonymous.
    expect(v.all, transcript(v)).toContain('field "tile-key.zoom" renamed to "z" (its shape is otherwise unchanged)');
    expect(v.all).toContain('follow the rename');
    const st = await sb.run(['externals', 'status'], p.studio);
    expect(st.all, transcript(st)).toContain('field "tile-key.zoom" renamed to "z"');
  });
});

describe('4 — a use beyond the pin is named by validate, as lock and lock-check name it (lib-and-app R5-21)', () => {
  let p: { geo: string; studio: string };

  beforeAll(async () => {
    p = await pinnedPair('beyond-pin', false);
  });

  it('validate names the unrecorded use (advisory: validate --ci still passes; the approval gates refuse)', async () => {
    const v = await sb.run(['validate', '--ci'], p.studio);
    expect(v.all, transcript(v)).toContain('tile-library.tileFor');
    expect(v.all).toContain('not in the lock');
    expect(v.code, transcript(v)).toBe(0);
    const lock = await sb.run(['lock', '--yes'], p.studio);
    expect(lock.code, transcript(lock)).not.toBe(0);
    expect(lock.all).toContain('used beyond their pin');
  });
});

// ---------------------------------------------------------------------------
// The MCP side: the same answers over the built server.

/** An MCP client on the built server, bound to a sandbox project. */
async function mcpAt(dir: string): Promise<Client> {
  const client = new Client({ name: 'wairon-e2e-r5-approval', version: '0.0.1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [DIST_CLI, 'mcp', 'serve'],
    cwd: REPO_ROOT,
    env: { ...getDefaultEnvironment(), ...sb.env, WAIRON_PROJECT_DIR: dir } as Record<string, string>,
    stderr: 'ignore',
  }));
  return client;
}

/** A tool's structured answer. */
async function structuredOf(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await client.callTool({ name, arguments: args }) as { structuredContent?: Record<string, unknown>; content?: { text?: string }[]; isError?: boolean };
  if (r.structuredContent) return r.structuredContent;
  return JSON.parse((r.content ?? []).map((c) => c.text ?? '').join('\n')) as Record<string, unknown>;
}

describe('4/5 — the MCP answers: drifted agrees with the health, the rename dry run names only what breaks, a dry run says it is one', () => {
  let p: { geo: string; studio: string };

  beforeAll(async () => {
    p = await pinnedPair('mcp');
  });

  it('sdd_rename_method dry run: breaks are narrowed to the public name that publishes the method, with that one member (lib-and-app R5-30)', async () => {
    const client = await mcpAt(p.geo);
    try {
      const report = await structuredOf(client, 'sdd_rename_method', { id: 'tile-library', method: 'tileFor', newName: 'tileAt', dryRun: true, search: ['..'] });
      const breaks = report.breaks as { project: string; uses: { publicName: string; members: string[] }[] }[];
      expect(breaks.map((b) => b.project)).toEqual(['studio']);
      // Round 5: the consumer's whole use of the producer (tile-key included).
      expect(breaks[0].uses).toEqual([expect.objectContaining({ publicName: 'tile-library', members: ['tileFor'] })]);
      expect(report.dryRun).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('sdd_get_externals_status: a fact the pin carries moved — drifted is true wherever the health says drifted (lib-and-app R5-20)', async () => {
    const tree = geoKit();
    (tree.components as Record<string, unknown>[])[0].abi = 'c';
    writeProject(p.geo, 'geo', tree);
    const client = await mcpAt(p.studio);
    try {
      const answer = await structuredOf(client, 'sdd_get_externals_status', {});
      const geo = (answer.statuses as { alias: string; health: string; drifted?: boolean; staleFacts?: string[] }[]).find((s) => s.alias === 'geo')!;
      expect(geo.staleFacts).toContain('abi of tile-library');
      expect(geo.health).toBe('drifted');
      // Round 5: health "drifted" beside drifted: false.
      expect(geo.drifted).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('sdd_remove_external dry run says it is one: dryRun true, nothing removed, what the real run removes apart (platform R5)', async () => {
    const client = await mcpAt(p.studio);
    try {
      const dry = await structuredOf(client, 'sdd_remove_external', { alias: 'geo', dryRun: true });
      // Round 5: { removed: true, unpinned: true } — identical to the real run.
      expect(dry).toMatchObject({ alias: 'geo', dryRun: true, removed: false, unpinned: false, wouldRemove: { declaration: true, pin: true } });
      expect(readFile(p.studio, '.wai/project.yaml')).toContain('geo');
      const real = await structuredOf(client, 'sdd_remove_external', { alias: 'geo' });
      expect(real).toMatchObject({ alias: 'geo', removed: true, unpinned: true });
      expect(real.dryRun).toBeUndefined();
    } finally {
      await client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The OpenAPI document of a project's own HTTP API.

/** RoutePlanner: a bearer HTTP Portal under /v1, Express-style placeholders, a response typed by a pinned GeoKit type — exported to no wairon project. */
function routePlanner(): FixtureTree {
  return {
    system: { name: 'RoutePlanner', vision: 'Plans delivery routes for couriers.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'routing', description: 'Route planning.' }],
    components: [
      { id: 'route_portal', componentType: 'Portal', transport: 'HTTP', basePath: '/v1', auth: { scheme: 'bearer' }, invokedBy: { kind: 'entry', caller: 'The courier web app in a browser, over the public internet.' }, dependsOn: ['route_planner'] },
      { id: 'route_planner', componentType: 'Orchestrator' },
    ],
    interfaces: [
      { id: 'iroute_portal', component: 'route_portal', methods: [{
        name: 'getRoute', description: 'Read one planned route.',
        params: [{ name: 'bearerToken', type: 'string' }, { name: 'id', type: 'string' }, { name: 'zoom', type: 'int', optional: true }],
        returns: 'route_plan', endpoint: { transport: 'HTTP', method: 'GET', path: '/routes/:id' },
      }] },
      { id: 'iroute_planner', component: 'route_planner', methods: [{ name: 'getRoute', description: 'Read one planned route.', params: [{ name: 'id', type: 'string' }], returns: 'route_plan' }] },
    ],
    implementations: [
      { id: 'route_portal_impl', contract: 'iroute_portal', lint: { allow: [{ code: 'MISSING_SOURCE_PATH', reason: 'design-only e2e journey — the code lives outside this scratch project' }] }, methods: [{ name: 'getRoute', narrative: [{ stepNumber: 1, type: 'call', description: 'Read it.', targetComponent: 'route_planner', targetMethod: 'getRoute' }] }] },
      { id: 'route_planner_impl', contract: 'iroute_planner', lint: { allow: [{ code: 'MISSING_SOURCE_PATH', reason: 'design-only e2e journey — the code lives outside this scratch project' }] }, methods: [{ name: 'getRoute', narrative: [{ stepNumber: 1, type: 'local', description: 'Look the route up by its id.' }, { stepNumber: 2, type: 'return', description: 'Answer it.', outcome: 'the route' }] }] },
    ],
    types: [{ id: 'route_plan', kind: 'value-object', subsystem: 'routing', description: 'A planned route.', fields: [{ name: 'stops', type: 'list<geo::tile-key>' }] }],
  };
}

describe('6 — the OpenAPI document of the project\'s own HTTP Portal (solo-app top-2, lib-and-app R5-22)', () => {
  let routes: string;
  let document: Record<string, any>;

  beforeAll(async () => {
    const folder = sb.project('openapi');
    const geo = path.join(folder, 'geo');
    routes = path.join(folder, 'routes');
    fs.mkdirSync(geo, { recursive: true });
    fs.mkdirSync(routes, { recursive: true });
    writeProject(geo, 'geo', geoKit());
    writeProject(routes, 'route-planner', routePlanner(), { externals: { geo: { source: '../geo' } } });
    writeFile(routes, 'package.json', JSON.stringify({ name: 'route-planner', version: '0.1.0' }));
    const pin = await sb.run(['externals', 'pin', 'geo'], routes);
    expect(pin.code, transcript(pin)).toBe(0);
    const out = path.join(routes, 'openapi.json');
    // Round 5: refused — "it exports no interface at audience ≥ instance" — and `--portal` said "Unknown portal".
    const exp = await sb.run(['surface', 'export', '--format', 'openapi', '--portal', 'route_portal', '--out', out], routes);
    expect(exp.code, transcript(exp)).toBe(0);
    document = JSON.parse(fs.readFileSync(out, 'utf8'));
  });

  it('(d) a Portal no L0 export table names still gets its document', () => {
    expect(Object.keys(document.paths)).toEqual(['/v1/routes/{id}']);
  });

  it('(a) the bearer token is carried by the security scheme alone, never as a parameter', () => {
    const get = document.paths['/v1/routes/{id}'].get;
    expect(get.security).toEqual([{ BearerAuth: [] }]);
    expect(get.parameters.map((p: { name: string; in: string }) => `${p.name}:${p.in}`)).toEqual(['id:path', 'zoom:query']);
  });

  it('(b) `:id` is a path parameter and the basePath is in the path', () => {
    const id = document.paths['/v1/routes/{id}'].get.parameters[0];
    expect(id).toMatchObject({ name: 'id', in: 'path', required: true });
  });

  it('(c) a pinned external type resolves from the pin, never "Unresolved type"', () => {
    expect(document.components.schemas.route_plan.properties.stops.items).toEqual({ $ref: '#/components/schemas/geo.tile-key' });
    expect(document.components.schemas['geo.tile-key'].properties).toHaveProperty('zoom');
    expect(JSON.stringify(document)).not.toContain('Unresolved type');
  });

  it('(e) info.version is the project\'s declared version', () => {
    expect(document.info.version).toBe('0.1.0');
  });

  it('a wider audience narrows the document to what the export table shares — and says why a left-out Portal is left out, never "Unknown portal"', async () => {
    const exp = await sb.run(['surface', 'export', '--format', 'openapi', '--audience', 'external', '--portal', 'route_portal'], routes);
    expect(exp.code, transcript(exp)).not.toBe(0);
    expect(exp.all).toContain('Portal "route_portal" is not shared at audience ≥ external');
    expect(exp.all).not.toContain('Unknown portal');
  });

  it('control: a project with no HTTP Portal is still refused, saying so', async () => {
    const lib = sb.project('openapi-lib');
    writeProject(lib, 'geo', geoKit());
    const exp = await sb.run(['surface', 'export', '--format', 'openapi', '--out', path.join(lib, 'x.json')], lib);
    expect(exp.code, transcript(exp)).not.toBe(0);
    expect(exp.all).toContain('OpenAPI does not apply');
  });

  it('`method rename-param` respells a `:name` placeholder in its own form', async () => {
    const r = await sb.run(['method', 'rename-param', 'route_portal', 'getRoute', 'id', 'routeId'], routes);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toContain(':id -> :routeId');
    const specs = path.join(routes, '.wai', 'specs');
    const contract = (fs.readdirSync(specs, { recursive: true }) as string[])
      .filter((f) => String(f).endsWith('.yaml'))
      .map((f) => fs.readFileSync(path.join(specs, String(f)), 'utf8'))
      .find((text) => text.includes('id: iroute_portal'));
    expect(contract).toContain('/routes/:routeId');
  });
});
