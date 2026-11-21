import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WAIRON_MAJOR } from '../../src/config/defaults.js';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { execFileSync } from 'child_process';
import {
  createTrialSandbox,
  transcript,
  readFile,
  gitInit,
  countCode,
  type TrialSandbox,
} from './trials-helpers';
import { BASE_FIXTURE_RULES, materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness';

// ---------------------------------------------------------------------------
// User-trial regression journeys — the LIBRARY AUTHOR + APP persona.
//
// Three trial rounds had a Rust library (InProcess Portals, an extension point
// exported `role: implement`) consumed by a sibling TypeScript app as a path
// external: called directly (no client Adapter), its trait implemented by
// taking signatures FROM it, pinned, drifted, re-pinned, re-locked. Each
// journey below replays one of those probes against the BUILT CLI in two
// sibling projects of one sandbox, and asserts the exit code and the words the
// trial saw — so a finding fixed in rounds 2–3 cannot silently come back.
//
//   geo     the producer: GeoKit, a Rust tiling library
//   studio  the consumer: TileStudio, a TypeScript map editor
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z';

/** A project.yaml with a real id (externals resolve by it) and an enabled target (a clean validate). */
function configYaml(id: string, extra: Record<string, unknown> = {}): string {
  return yaml.dump({
    schemaVersion: '1.0.0', waironMajor: WAIRON_MAJOR, id, name: id,
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: BASE_FIXTURE_RULES,
    extensions: { packs: [], useGlobalPacks: false },
    ...extra, createdAt: TS, updatedAt: TS,
  }, { noRefs: true, lineWidth: 200 });
}

interface GeoOptions {
  /** The extension point's method (default load_tile) and its rename trace. */
  sourceMethod?: string;
  formerSource?: string[];
  /** The extension point method's return type (default bytes). */
  sourceReturns?: string;
  /** Declare `abi: c` on the library Portal (default true). */
  abi?: boolean;
  /** The library verb's effect (default none). */
  libEffect?: string;
  /** Export the tile-key type at the L0 (default true). */
  exportTileKey?: boolean;
  /** A second library verb, added by a later release (an unused drift). */
  extraVerb?: boolean;
}

/** GeoKit: an InProcess library Portal, a tile-source extension point exported role implement, an exported tile-key type. */
function geoKit(o: GeoOptions = {}): FixtureTree {
  const method = o.sourceMethod ?? 'load_tile';
  const exportTileKey = o.exportTileKey ?? true;
  return {
    system: {
      name: 'GeoKit', vision: 'A tiling library for map applications.', targetLanguage: 'Rust',
      publicInterfaces: [
        { from: 'tiling', component: 'tile-library' },
        { from: 'tiling', component: 'tile-source-port', as: 'tile-source', role: 'implement' },
        ...(exportTileKey ? [{ from: 'tiling', typeDef: 'tile-key' }] : []),
      ],
    },
    subsystems: [{
      id: 'tiling', description: 'Tile arithmetic.',
      publicInterfaces: [
        { component: 'tile-library', details: 'The crate\'s tile API.' },
        { component: 'tile-source-port', details: 'Where tiles load from.', role: 'implement', shared: true },
        { typeDef: 'tile-key', details: 'A tile key.' },
      ],
    }],
    components: [
      {
        id: 'tile-library', componentType: 'Portal', transport: 'InProcess',
        ...(o.abi === false ? {} : { abi: 'c' }),
        description: 'The crate\'s tile API.',
        invokedBy: { kind: 'entry', caller: 'Applications that link the GeoKit crate and call its tile functions directly.' },
      },
      { id: 'tile-source-port', componentType: 'Adapter', description: 'The port GeoKit loads tiles through.' },
    ],
    interfaces: [
      {
        id: 'itile_library', component: 'tile-library',
        methods: [
          { name: 'tile_for', description: 'The tile key for a zoom.', params: [{ name: 'zoom', type: 'int' }], returns: 'tile-key', effect: o.libEffect ?? 'none' },
          ...(o.extraVerb ? [{ name: 'tile_bounds', description: 'The bounds of a tile.', params: [{ name: 'zoom', type: 'int' }], returns: 'string', effect: 'none' }] : []),
        ],
      },
      {
        id: 'itile_source_port', component: 'tile-source-port',
        methods: [{
          name: method, description: 'Load a tile.', params: [{ name: 'key', type: 'tile-key' }], returns: o.sourceReturns ?? 'bytes',
          invokedBy: { kind: 'runtime', caller: 'The GeoKit renderer, each time a tile it needs is not in memory yet.' },
          ...(o.formerSource ? { previousNames: o.formerSource } : {}),
        }],
      },
    ],
    types: [{
      id: 'tile-key', kind: 'value-object', subsystem: 'tiling', description: 'A tile key.', holds: 'string',
      methods: [{ name: 'parse', description: 'The checked constructor.', signature: 'parse(text: string): tile-key', returns: 'tile-key', params: [{ name: 'text', type: 'string' }] }],
    }],
  };
}

interface StudioOptions {
  /** Implement the extension point by taking the signature from it (default true). */
  implementsSource?: boolean;
  /** The extension point method the cache implements (default load_tile). */
  sourceMethod?: string;
}

/** TileStudio: calls the GeoKit library directly from pure logic (no client Adapter) and implements its tile source. */
function tileStudio(o: StudioOptions = {}): FixtureTree {
  const method = o.sourceMethod ?? 'load_tile';
  const impl = o.implementsSource ?? true;
  return {
    system: { name: 'TileStudio', vision: 'A map editor that renders tiles computed by GeoKit.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'editor', description: 'The map editing canvas.' }],
    components: [
      { id: 'map-renderer', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Works out which tiles the map needs.', dependsOn: ['geo::tile-library'] },
      ...(impl ? [{ id: 'tile-cache', componentType: 'Adapter', description: 'Serves GeoKit tiles from a local cache.' }] : []),
    ],
    interfaces: [
      {
        id: 'imap_renderer', component: 'map-renderer',
        methods: [{
          name: 'visibleTile', description: 'The tile the map centre needs.', params: [{ name: 'zoom', type: 'int' }], returns: 'string',
          invokedBy: { kind: 'runtime', caller: 'The editor canvas, once on every pan or zoom of the map view.' },
        }],
      },
      ...(impl ? [{
        id: 'itile_cache', component: 'tile-cache', implements: 'geo::tile-source',
        methods: [{ name: method, description: 'Load one tile from the cache.', signatureFrom: `geo::tile-source.${method}` }],
      }] : []),
    ],
    implementations: [{
      id: 'map_renderer_impl', contract: 'imap_renderer',
      lint: { allow: [{ code: 'MISSING_SOURCE_PATH', reason: 'design-only e2e journey — the code lives outside this scratch project' }] },
      methods: [{ name: 'visibleTile', narrative: [
        { stepNumber: 1, type: 'call', description: 'Ask GeoKit for the tile key.', targetComponent: 'geo::tile-library', targetMethod: 'tile_for' },
        { stepNumber: 2, type: 'return', description: 'Answer it.', outcome: 'the tile key' },
      ] }],
    }],
  };
}

/** (Re)write a project's .wai from a fixture tree, keeping everything else in the folder. */
function writeProject(dir: string, id: string, tree: FixtureTree, extra: Record<string, unknown> = {}): void {
  // Keep the pin and the lock record across a producer/consumer rewrite.
  const keep = ['lock.json', 'inputs.lock.yaml', 'externals'];
  const saved = new Map<string, string>();
  const stash = path.join(dir, '.wai-keep');
  for (const name of keep) {
    const p = path.join(dir, '.wai', name);
    if (fs.existsSync(p)) {
      fs.mkdirSync(stash, { recursive: true });
      fs.renameSync(p, path.join(stash, name));
      saved.set(name, path.join(stash, name));
    }
  }
  fs.rmSync(path.join(dir, '.wai'), { recursive: true, force: true });
  materializeFixtureProject(dir, tree);
  for (const [name, from] of saved) fs.renameSync(from, path.join(dir, '.wai', name));
  fs.rmSync(stash, { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), configYaml(id, extra));
}

/** Read the consumer's project.yaml `externals` block. */
function declaredExternals(dir: string): Record<string, unknown> | undefined {
  return (yaml.load(readFile(dir, '.wai/project.yaml')) as { externals?: Record<string, unknown> }).externals;
}

let sb: TrialSandbox;

beforeAll(() => {
  sb = createTrialSandbox('lib-and-app');
});

afterAll(async () => {
  await sb?.cleanup();
});

/** A producer + consumer pair under one folder: <root>/<name>/geo and <root>/<name>/studio (the studio declares nothing yet). */
function pair(name: string, geo: GeoOptions = {}, studio: StudioOptions = {}): { geo: string; studio: string; folder: string } {
  const folder = sb.project(name);
  const geoDir = path.join(folder, 'geo');
  const studioDir = path.join(folder, 'studio');
  fs.mkdirSync(geoDir, { recursive: true });
  fs.mkdirSync(studioDir, { recursive: true });
  writeProject(geoDir, 'geo', geoKit(geo));
  writeProject(studioDir, 'studio', tileStudio(studio));
  return { geo: geoDir, studio: studioDir, folder };
}

/**
 * Serve a producer as a git external: approve it (a git producer is read at its
 * APPROVED state, so it must be locked and committed), clone it bare and return
 * the `file://` source with the commit pinned. wairon 7 pins only hosted and
 * git sources; a `../` sibling is read live and never pinned.
 */
async function gitSource(folder: string, dir: string): Promise<string> {
  const lock = await sb.run(['lock', '--yes'], dir);
  expect(lock.code, transcript(lock)).toBe(0);
  gitInit(dir);
  const bare = path.join(folder, `${path.basename(dir)}.git`);
  execFileSync('git', ['clone', '-q', '--bare', dir, bare], { stdio: 'ignore' });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  return `file:///${bare.split(path.sep).join('/')}#${commit}`;
}

// ---------------------------------------------------------------------------

describe('journey: a live producer never moves the consumer\'s approval (wairon 7)', () => {
  it('a compatible producer change followed through signatureFrom leaves the consumer approved', async () => {
    const p = pair('approval-holds');
    const add = await sb.run(['externals', 'add', 'geo', '../geo'], p.studio);
    expect(add.code, transcript(add)).toBe(0);
    const lock = await sb.run(['lock', '--yes'], p.studio);
    expect(lock.code, transcript(lock)).toBe(0);
    // Only the producer moves: the implemented method's return type, which the consumer takes through signatureFrom.
    writeProject(p.geo, 'geo', geoKit({ sourceReturns: 'string' }));
    const lc = await sb.run(['lock-check'], p.studio);
    expect(lc.code, transcript(lc)).toBe(0);
    expect(lc.all).toMatch(/is the approved design/);
  });
});

describe('journey: a library called directly — InProcess, no client Adapter, judged by abi and effect', () => {
  let p: ReturnType<typeof pair>;

  beforeAll(async () => {
    p = pair('direct-call');
    const add = await sb.run(['externals', 'add', 'geo', '../geo'], p.studio);
    expect(add.code, transcript(add)).toBe(0);
  });

  it('the producer library validates clean, and `network why` explains in-process (round-2 R2-11)', async () => {
    const v = await sb.run(['validate'], p.geo);
    expect(v.code, transcript(v)).toBe(0);
    expect(v.all).not.toMatch(/✖/);
    // Round 2 said "may NOT reach" with exit 1 for an entered library verb.
    const why = await sb.run(['network', 'why', 'outside', 'tile-library'], p.geo);
    expect(why.code, transcript(why)).toBe(0);
    expect(why.stdout).toMatch(/reached in-process: never a network flow/);
    expect(why.all).not.toMatch(/may NOT reach/);
  });

  it('the consumer calls the library from pure logic with no Adapter, implements its snake_case trait, and validates clean (round-3 R3-17, R3-41)', async () => {
    const v = await sb.run(['validate', '--ci'], p.studio);
    expect(v.code, transcript(v)).toBe(0);
    expect(v.all).not.toMatch(/LANGUAGE_BRIDGE_MISSING|LIBRARY_CALL_IMPURE|UNREALIZED_DEPENDENCY/);
    // R3-41: a method name the implemented foreign-language contract dictates
    // (load_tile, from a Rust trait) is not a casing violation in TypeScript.
    expect(v.all).not.toMatch(/NAMING_CONVENTION_VIOLATION/);
    // A library call is never a network flow: the consumer's matrix is empty.
    const flows = await sb.run(['network', 'flows'], p.studio);
    expect(flows.code, transcript(flows)).toBe(0);
    expect(JSON.parse(flows.stdout)).toEqual([]);
  });

  it('negative control: no abi across languages and an io verb from pure logic are both errors with the fix (round-1/2 R2-21)', async () => {
    const bad = pair('direct-call-bad', { abi: false, libEffect: 'io' });
    const add = await sb.run(['externals', 'add', 'geo', '../geo'], bad.studio);
    expect(add.code, transcript(add)).toBe(0);
    const v = await sb.run(['validate'], bad.studio);
    expect(v.code, transcript(v)).toBe(1);
    expect(v.all).toMatch(/\[LANGUAGE_BRIDGE_MISSING\] Component "map-renderer" \(typescript\) calls the library "geo::tile-library", a native rust API with no abi/i);
    expect(v.all).toMatch(/Declare abi on the producer's Portal/);
    expect(v.all).toMatch(/\[LIBRARY_CALL_IMPURE\] Pure logic "map-renderer" calls the library verb "geo::tile-library\.tile_for"/);
    expect(v.all).toMatch(/pure logic may call only verbs whose effect is none/);
  });
});

describe('journey: the producer adds abi after the consumer declared it — read live, nothing to re-pin (round-2 R2-26/R2-30 BLOCKER, wairon 7)', () => {
  let p: ReturnType<typeof pair>;

  beforeAll(async () => {
    p = pair('abi-later', { abi: false });
    const add = await sb.run(['externals', 'add', 'geo', '../geo'], p.studio);
    expect(add.code, transcript(add)).toBe(0);
  });

  it('before the producer acts, the bridge is missing', async () => {
    const v = await sb.run(['validate'], p.studio);
    expect(v.code, transcript(v)).toBe(1);
    expect(countCode(v.all, 'LANGUAGE_BRIDGE_MISSING')).toBe(1);
  });

  it('the producer declares abi: the sibling is read live, so status is ok at once — never a stale "ok" nor a pin to refresh (R2-26)', async () => {
    writeProject(p.geo, 'geo', geoKit({ abi: true }));
    const s = await sb.run(['externals', 'status'], p.studio);
    expect(s.code, transcript(s)).toBe(0);
    expect(s.stdout).toMatch(/geo → geo: family, not pinned, reachable, ok/);
    expect(s.stdout).not.toMatch(/drifted|stale/);
  });

  it('the bridge error goes away with no re-pin, and a pin of a path external writes nothing (R2-30)', async () => {
    const v = await sb.run(['validate', '--ci'], p.studio);
    expect(v.code, transcript(v)).toBe(0);
    expect(v.all).not.toMatch(/LANGUAGE_BRIDGE_MISSING|EXTERNAL_DRIFTED/);
    const pin = await sb.run(['externals', 'pin', 'geo'], p.studio);
    expect(pin.code, transcript(pin)).toBe(0);
    expect(pin.stdout).toMatch(/geo → geo: unchanged — read live, never pinned/);
    expect(fs.existsSync(path.join(p.studio, '.wai', 'inputs.lock.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(p.studio, '.wai', 'externals'))).toBe(false);
  });
});

describe('journey: externals add / use / status / remove by hand (round-2 R2-4/R2-23/R2-29, round-3 leftover lock file)', () => {
  let p: ReturnType<typeof pair>;
  const lockFile = (): string => path.join(p.studio, '.wai', 'inputs.lock.yaml');

  beforeAll(() => {
    p = pair('declare');
    // A second producer, so removing ONE external is the control for removing the LAST.
    const atlas = path.join(p.folder, 'atlas');
    fs.mkdirSync(atlas, { recursive: true });
    writeProject(atlas, 'atlas', geoKit());
  });

  it('--dry-run on an unreadable producer says so and exits 2, writing nothing (R2-4)', async () => {
    const r = await sb.run(['externals', 'add', 'geo-missing', '../geo-missing', '--dry-run'], p.studio);
    expect(r.code, transcript(r)).toBe(2);
    expect(r.stdout).toMatch(/its producer could not be read \(its root .* does not exist\), so nothing would be pinned\. Nothing was written\./);
    expect(declaredExternals(p.studio)).toBeUndefined();
  });

  it('a dry run really checks the producer: a wrong alias is refused (exit 1), a right one agrees (exit 0)', async () => {
    const wrong = await sb.run(['externals', 'add', 'nogeo', '../geo', '--dry-run'], p.studio);
    expect(wrong.code, transcript(wrong)).toBe(1);
    expect(wrong.all).toMatch(/the producer there answers to "geo", not "nogeo"/);
    const right = await sb.run(['externals', 'add', 'geo', '../geo', '--dry-run'], p.studio);
    expect(right.code, transcript(right)).toBe(0);
    expect(right.stdout).toMatch(/the producer was read and agrees\. Nothing was written\./);
    expect(declaredExternals(p.studio)).toBeUndefined();
  });

  it('a junk source is refused as "not a location" (R2-29)', async () => {
    const r = await sb.run(['externals', 'add', 'bad', '{ path: ../x }'], p.studio);
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/is not a location/);
    expect(declaredExternals(p.studio)).toBeUndefined();
  });

  it('a path external whose folder is missing is "not compared" — exit 2, never a pass (R2-29)', async () => {
    const add = await sb.run(['externals', 'add', 'geo', '../nowhere'], p.studio);
    expect(add.code, transcript(add)).toBe(2);
    expect(add.stdout).toMatch(/Declared geo → geo/);
    const s = await sb.run(['externals', 'status'], p.studio);
    expect(s.code, transcript(s)).toBe(2);
    expect(s.stdout).toMatch(/geo → geo: path, not pinned, unreachable, not compared/);
    expect(s.stdout).toMatch(/EXTERNAL_CHECK_UNAVAILABLE/);
    // Drop the declaration again: the journeys below declare the real sibling.
    const rm = await sb.run(['externals', 'remove', 'geo'], p.studio);
    expect(rm.code, transcript(rm)).toBe(0);
    expect(declaredExternals(p.studio)).toBeUndefined();
  });

  it('declared, a sibling is read live: status ok with exit 0 and one line per used member, and nothing is pinned', async () => {
    const add = await sb.run(['externals', 'add', 'geo', '../geo'], p.studio);
    expect(add.code, transcript(add)).toBe(0);
    expect(add.stdout).toMatch(/Declared geo → geo/);
    expect(add.stdout).toMatch(/geo → geo: unchanged — read live, never pinned/);
    const pin = await sb.run(['externals', 'pin', 'geo'], p.studio);
    expect(pin.code, transcript(pin)).toBe(0);
    expect(pin.stdout).toMatch(/geo → geo: unchanged — read live, never pinned/);
    const s = await sb.run(['externals', 'status'], p.studio);
    expect(s.code, transcript(s)).toBe(0);
    expect(s.stdout).toMatch(/geo → geo: family, not pinned, reachable, ok/);
    expect(s.stdout).toMatch(/tile-library\.tile_for: unchanged/);
    expect(s.stdout).toMatch(/tile-source\.load_tile: unchanged/);
    expect(fs.existsSync(lockFile())).toBe(false);
    expect(fs.existsSync(path.join(p.studio, '.wai', 'externals'))).toBe(false);
  });

  it('`externals use --add/--remove` edits the imports without a hand edit and writes no pin (R2-23)', async () => {
    const dry = await sb.run(['externals', 'use', 'geo', '--add', 'tile-key', '--dry-run'], p.studio);
    expect(dry.code, transcript(dry)).toBe(0);
    expect(dry.stdout).toMatch(/Dry run: geo\.use would be \[tile-key\] \(\+ tile-key\)\. Nothing was written\./);
    expect((declaredExternals(p.studio)!.geo as Record<string, unknown>).use).toBeUndefined();

    const unknown = await sb.run(['externals', 'use', 'geo', '--add', 'routing_magic'], p.studio);
    expect(unknown.code, transcript(unknown)).toBe(1);
    expect(unknown.all).toMatch(/the producer does not export "routing_magic" to this project \(closest: /);

    const add = await sb.run(['externals', 'use', 'geo', '--add', 'tile-key'], p.studio);
    expect(add.code, transcript(add)).toBe(0);
    expect(add.stdout).toMatch(/geo\.use is now \[tile-key\]/);
    expect((declaredExternals(p.studio)!.geo as Record<string, unknown>).use).toEqual(['tile-key']);

    const rm = await sb.run(['externals', 'use', 'geo', '--remove', 'tile-key'], p.studio);
    expect(rm.code, transcript(rm)).toBe(0);
    expect(rm.stdout).toMatch(/\(- tile-key\)/);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('removing a path external drops its declaration and leaves no lock file behind (round-3 leftover `externals: {}`)', async () => {
    const addAtlas = await sb.run(['externals', 'add', 'atlas', '../atlas'], p.studio);
    expect(addAtlas.code, transcript(addAtlas)).toBe(0);

    const ghost = await sb.run(['externals', 'remove', 'ghost'], p.studio);
    expect(ghost.code, transcript(ghost)).toBe(1);
    expect(ghost.all).toMatch(/neither declared nor pinned here/);

    const dry = await sb.run(['externals', 'remove', 'geo', '--dry-run'], p.studio);
    expect(dry.code, transcript(dry)).toBe(0);
    expect(dry.stdout).toMatch(/Nothing was written/);
    expect(declaredExternals(p.studio)!.geo).toBeDefined();

    const rmGeo = await sb.run(['externals', 'remove', 'geo'], p.studio);
    expect(rmGeo.code, transcript(rmGeo)).toBe(0);
    expect(rmGeo.stdout).toMatch(/Removed geo: its declaration\./);
    expect(Object.keys(declaredExternals(p.studio)!)).toEqual(['atlas']);

    const rmAtlas = await sb.run(['externals', 'remove', 'atlas'], p.studio);
    expect(rmAtlas.code, transcript(rmAtlas)).toBe(0);
    // Round 3: `.wai/inputs.lock.yaml` was left behind holding `externals: {}`.
    expect(fs.existsSync(lockFile())).toBe(false);
    const list = await sb.run(['externals', 'list'], p.studio);
    expect(list.code, transcript(list)).toBe(0);
    expect(list.all).toMatch(/declares no externals/);
  });

  it('a git external IS pinned: removing one of two keeps the inputs lock (control); removing the last deletes it', async () => {
    const g = pair('declare-git');
    const atlas = path.join(g.folder, 'atlas');
    fs.mkdirSync(atlas, { recursive: true });
    writeProject(atlas, 'atlas', geoKit());
    const geoSource = await gitSource(g.folder, g.geo);
    const atlasSource = await gitSource(g.folder, atlas);
    const lockPath = path.join(g.studio, '.wai', 'inputs.lock.yaml');

    const addGeo = await sb.run(['externals', 'add', 'geo', geoSource], g.studio);
    expect(addGeo.code, transcript(addGeo)).toBe(0);
    expect(addGeo.stdout).toMatch(/geo → geo: pinned 2 used name\(s\), sha256:/);
    const addAtlas = await sb.run(['externals', 'add', 'atlas', atlasSource], g.studio);
    expect(addAtlas.code, transcript(addAtlas)).toBe(0);
    expect(fs.existsSync(lockPath)).toBe(true);

    const s = await sb.run(['externals', 'status'], g.studio);
    expect(s.code, transcript(s)).toBe(0);
    expect(s.stdout).toMatch(/geo → geo: git, pinned, reachable, ok/);

    const rmGeo = await sb.run(['externals', 'remove', 'geo'], g.studio);
    expect(rmGeo.code, transcript(rmGeo)).toBe(0);
    expect(rmGeo.stdout).toMatch(/Removed geo: its declaration and its pin/);
    const left = yaml.load(fs.readFileSync(lockPath, 'utf8')) as { externals: Record<string, unknown> };
    expect(Object.keys(left.externals)).toEqual(['atlas']);
    expect(fs.existsSync(path.join(g.studio, '.wai', 'externals', 'geo.yaml'))).toBe(false);

    const rmAtlas = await sb.run(['externals', 'remove', 'atlas'], g.studio);
    expect(rmAtlas.code, transcript(rmAtlas)).toBe(0);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe('journey: an implemented (role implement) contract — pinned per method for a git producer, its rename followed live for a sibling (round-3 R3-20/R3-35/R3-37/R3-42 MAJOR)', () => {
  let p: ReturnType<typeof pair>;

  beforeAll(async () => {
    p = pair('implements');
    const add = await sb.run(['externals', 'add', 'geo', '../geo'], p.studio);
    expect(add.code, transcript(add)).toBe(0);
    const lock = await sb.run(['lock', '--yes'], p.studio);
    expect(lock.code, transcript(lock)).toBe(0);
  });

  it('a git pin records a digest for each implemented method — not `tile-source: {}` (R3-20)', async () => {
    const g = pair('implements-git');
    const source = await gitSource(g.folder, g.geo);
    const add = await sb.run(['externals', 'add', 'geo', source], g.studio);
    expect(add.code, transcript(add)).toBe(0);
    const lock = yaml.load(readFile(g.studio, '.wai/inputs.lock.yaml')) as {
      externals: { geo: { used: Record<string, Record<string, string>> } };
    };
    expect(Object.keys(lock.externals.geo.used['tile-source'])).toEqual(['load_tile']);
    expect(lock.externals.geo.used['tile-source'].load_tile).toMatch(/^sha256:/);
  });

  it('a traced producer rename of the implemented method reads "renamed to" live and fails the consumer, which names the new name (R3-35)', async () => {
    writeProject(p.geo, 'geo', geoKit({ sourceMethod: 'fetch_tile', formerSource: ['itile_source_port.load_tile'] }));
    const s = await sb.run(['externals', 'status'], p.studio);
    expect(s.code, transcript(s)).toBe(1);
    expect(s.stdout).toMatch(/geo → geo: family, not pinned, reachable, incompatible/);
    expect(s.stdout).toMatch(/tile-source\.load_tile: renamed to tile-source\.fetch_tile .*follow the rename/);
    expect(s.stdout).toMatch(/tile-library\.tile_for: unchanged/);

    // wairon 7: a dependency INVALID for the consumer's uses fails the consumer's build, named from the live producer.
    const v = await sb.run(['validate'], p.studio);
    expect(v.code, transcript(v)).toBe(1);
    expect(v.all).toMatch(/\[IMPLEMENTS_MISMATCH\] .*"fetch_tile".*renamed from "load_tile" \(the producer's rename trace\)/);
    expect(v.all).toMatch(/\[EXTERNAL_LIVE_INCOMPATIBLE\] .*"tile-source\.load_tile" renamed to "tile-source\.fetch_tile", per the producer's rename trace\. Used by "itile_cache"/);
    // The approval is the consumer's own design, which did not move: approved but failing on a dependency.
    const lc = await sb.run(['lock-check'], p.studio);
    expect(lc.code, transcript(lc)).toBe(0);
    const ci = await sb.run(['validate', '--ci'], p.studio);
    expect(ci.code, transcript(ci)).toBe(1);
  });

  it('there is no pin to re-pin over the rename: the pin writes nothing and validate still names the rename (R3-37, R3-42)', async () => {
    const pin = await sb.run(['externals', 'pin', 'geo'], p.studio);
    expect(pin.code, transcript(pin)).toBe(0);
    expect(pin.stdout).toMatch(/read live, never pinned/);
    expect(fs.existsSync(path.join(p.studio, '.wai', 'inputs.lock.yaml'))).toBe(false);
    const v = await sb.run(['validate'], p.studio);
    expect(v.all).toMatch(/\[EXTERNAL_LIVE_INCOMPATIBLE\] .*fetch_tile/);
  });

  it('following the rename clears the tree and the live gate', async () => {
    writeProject(p.studio, 'studio', tileStudio({ sourceMethod: 'fetch_tile' }), { externals: declaredExternals(p.studio) });
    const s = await sb.run(['externals', 'status'], p.studio);
    expect(s.code, transcript(s)).toBe(0);
    expect(s.stdout).toMatch(/tile-source\.fetch_tile: unchanged/);
    const v = await sb.run(['validate', '--ci'], p.studio);
    expect(v.code, transcript(v)).toBe(0);
  });

  it('a signature change of the implemented method is followed live through signatureFrom: nothing is stale, nothing to re-pin', async () => {
    writeProject(p.geo, 'geo', geoKit({ sourceMethod: 'fetch_tile', formerSource: ['itile_source_port.load_tile'], sourceReturns: 'string' }));
    const s = await sb.run(['externals', 'status'], p.studio);
    expect(s.code, transcript(s)).toBe(0);
    expect(s.stdout).toMatch(/geo → geo: family, not pinned, reachable, ok/);
    expect(s.stdout).toMatch(/tile-source.fetch_tile: unchanged/);
    expect(s.stdout).not.toMatch(/stale|drifted/);
    const v = await sb.run(['validate', '--ci'], p.studio);
    expect(v.code, transcript(v)).toBe(0);
  });
});

describe('journey: an unpinned git external is owed by the build, and `wairon lock` pins it from the producer\'s approved state (wairon 7)', () => {
  let p: ReturnType<typeof pair>;

  beforeAll(async () => {
    // The consumer implements the producer's extension point: the pin the lock writes
    // reshapes its design reading, so the identity it captures must read the tree after the pin.
    p = pair('unpinned');
    const source = await gitSource(p.folder, p.geo);
    const add = await sb.run(['externals', 'add', 'geo', source, '--no-pin'], p.studio);
    expect(add.code, transcript(add)).toBe(0);
  });

  it('status says "not compared" (exit 2), and the composed gate fails with EXTERNAL_UNPINNED for a used, never-pinned external', async () => {
    const s = await sb.run(['externals', 'status'], p.studio);
    expect(s.code, transcript(s)).toBe(2);
    expect(s.stdout).toMatch(/geo → geo: git, not pinned, reachable, not compared/);
    const v = await sb.run(['validate', '--family'], p.studio);
    expect(v.code, transcript(v)).toBe(1);
    expect(v.all).toMatch(/\[EXTERNAL_UNPINNED\] .*which was never pinned/);
    expect(v.all).toMatch(/Build inputs owe: external "geo" is not pinned/);
  });

  it('`wairon lock` pins the owed input from the producer\'s approved state and approves', async () => {
    const lock = await sb.run(['lock', '--yes'], p.studio);
    expect(lock.all).toMatch(/Pinned the external "geo" from its producer's approved state/);
    expect(lock.code, transcript(lock)).toBe(0);
    expect(fs.existsSync(path.join(p.studio, '.wai', 'inputs.lock.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(p.studio, '.wai', 'lock.json'))).toBe(true);
    const fam = await sb.run(['validate', '--family'], p.studio);
    expect(fam.all).not.toMatch(/EXTERNAL_UNPINNED/);
    const ok = await sb.run(['lock-check', '--strict'], p.studio);
    expect(ok.code, transcript(ok)).toBe(0);
    expect(ok.all).toMatch(/is the approved design/);
  });

  it('the lock never advances an up-to-date pin: a second lock changes nothing, and the pin is read as it was', async () => {
    const before = readFile(p.studio, '.wai/inputs.lock.yaml');
    const lock = await sb.run(['lock', '--yes'], p.studio);
    expect(lock.code, transcript(lock)).toBe(0);
    expect(lock.all).not.toMatch(/Pinned the external/);
    expect(readFile(p.studio, '.wai/inputs.lock.yaml')).toBe(before);
    const s = await sb.run(['externals', 'status'], p.studio);
    expect(s.code, transcript(s)).toBe(0);
    expect(s.stdout).toMatch(/geo → geo: git, pinned, reachable, ok/);
  });
});

describe('journey: a valid but unapproved sibling never blocks the consumer; the approval holds while it changes live (wairon 7)', () => {
  it('a producer release that changes nothing this project uses leaves status ok and the approval standing', async () => {
    const p = pair('live-sibling', {}, { implementsSource: false });
    const add = await sb.run(['externals', 'add', 'geo', '../geo'], p.studio);
    expect(add.code, transcript(add)).toBe(0);
    const lock = await sb.run(['lock', '--yes'], p.studio);
    expect(lock.code, transcript(lock)).toBe(0);
    expect((await sb.run(['lock-check', '--strict'], p.studio)).code).toBe(0);

    // The producer was never approved, and then it changes: valid, unapproved, live — never a block.
    writeProject(p.geo, 'geo', geoKit({ extraVerb: true }));
    const s = await sb.run(['externals', 'status'], p.studio);
    expect(s.code, transcript(s)).toBe(0);
    expect(s.stdout).toMatch(/geo → geo: family, not pinned, reachable, ok/);
    const lc = await sb.run(['lock-check'], p.studio);
    expect(lc.code, transcript(lc)).toBe(0);
    const v = await sb.run(['validate', '--ci'], p.studio);
    expect(v.code, transcript(v)).toBe(0);
  });
});

describe('journey: the producer sees its consumers and its own surface changelog (round-2 R2-46, round-3 R3-3/R3-34/R3-39 MAJOR)', () => {
  let p: ReturnType<typeof pair>;

  beforeAll(async () => {
    p = pair('producer-view');
    const add = await sb.run(['externals', 'add', 'geo', '../geo'], p.studio);
    expect(add.code, transcript(add)).toBe(0);
    const lock = await sb.run(['lock', '--yes'], p.geo);
    expect(lock.code, transcript(lock)).toBe(0);
    gitInit(p.geo);
  });

  it('`externals consumers` alone sees no sibling (control); `--search` finds it with the names it uses', async () => {
    const plain = await sb.run(['externals', 'consumers'], p.geo);
    expect(plain.code, transcript(plain)).toBe(0);
    expect(plain.stdout).toMatch(/No project of the family in reach consumes this project/);
    expect(plain.stdout).toMatch(/--search <dir>/);

    const found = await sb.run(['externals', 'consumers', '--search', p.folder], p.geo);
    expect(found.code, transcript(found)).toBe(0);
    expect(found.stdout).toMatch(/studio \(externals\.geo\) \[.*studio\]: tile-library, tile-source/);
  });

  it('`surface diff` lists the release against the last committed approval: rename, change, removal', async () => {
    const saved = path.join(p.folder, 'geo-v1.yaml');
    const exp = await sb.run(['surface', 'export', '--audience', 'project', '--out', saved], p.geo);
    expect(exp.code, transcript(exp)).toBe(0);

    const before = await sb.run(['surface', 'diff', '--json'], p.geo);
    expect(before.code, transcript(before)).toBe(0);
    expect((JSON.parse(before.stdout) as { changes: unknown[] }).changes).toEqual([]);

    writeProject(p.geo, 'geo', geoKit({ sourceMethod: 'fetch_tile', formerSource: ['itile_source_port.load_tile'], sourceReturns: 'string', exportTileKey: false }));
    const d = await sb.run(['surface', 'diff', '--json'], p.geo);
    expect(d.code, transcript(d)).toBe(0);
    const diff = JSON.parse(d.stdout) as { against: string; changes: { kind: string; name: string; member?: string; from?: string }[] };
    expect(diff.against).toMatch(/the last approval, committed at [0-9a-f]{12}/);
    expect(diff.changes).toContainEqual(expect.objectContaining({ kind: 'renamed', name: 'tile-source', member: 'fetch_tile', from: 'load_tile' }));
    expect(diff.changes).toContainEqual(expect.objectContaining({ kind: 'changed', name: 'tile-source', member: 'fetch_tile' }));
    expect(diff.changes).toContainEqual(expect.objectContaining({ kind: 'removed', name: 'tile-key' }));
    expect(diff.changes.some((c) => c.name === 'tile-library')).toBe(false);

    const text = await sb.run(['surface', 'diff'], p.geo);
    expect(text.code, transcript(text)).toBe(0);
    expect(text.stdout).toMatch(/tile-source/);
    expect(text.stdout).toMatch(/load_tile/);

    const vsFile = await sb.run(['surface', 'diff', '--against', saved, '--json'], p.geo);
    expect(vsFile.code, transcript(vsFile)).toBe(0);
    expect((JSON.parse(vsFile.stdout) as { changes: { kind: string }[] }).changes.map((c) => c.kind)).toContain('renamed');
  });

  it('an OpenAPI export of an in-process library is refused and writes nothing (R3-39)', async () => {
    const out = path.join(p.folder, 'geo-openapi.json');
    const r = await sb.run(['surface', 'export', '--format', 'openapi', '--out', out], p.geo);
    expect(r.code, transcript(r)).not.toBe(0);
    expect(r.all).toMatch(/OpenAPI does not apply to "GeoKit"/);
    expect(r.all).toMatch(/InProcess/);
    expect(fs.existsSync(out)).toBe(false);
  });
});
