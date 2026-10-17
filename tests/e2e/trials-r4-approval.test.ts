import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  countCode,
  createTrialSandbox,
  gitInit,
  readFile,
  transcript,
  writeFile,
  type TrialSandbox,
} from './trials-helpers';
import { BASE_FIXTURE_RULES, materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness';
import { platformFamily } from '../helpers/network-family';

// ---------------------------------------------------------------------------
// Round-4 trial regression journeys — approval, migrations, externals and
// surfaces, MCP-vs-CLI parity. Each journey replays a probe the round-4
// trials (solo-app, platform, lib-and-app, tinkerer) ran by hand on the BUILT
// CLI and asserts what the fix promises: exit codes and the words a person
// reads.
//
//   1  status agrees with lock-check after `project rename`
//   2  a storage move (externalize / internalize) leaves the tree valid and
//      asks for no re-lock
//   3  `lock` refuses uses its pin does not record; lock-check agrees
//   4  `surface diff` reports every pin-drifting fact and never crashes
//   5  a renamed method's callers hear "renamed to"; the rename's dry run
//      names the consumers it breaks; consumers are listed method by method
//   6  a member's family run judges its network from the enclosing family
//   7  `network why` reads a former id and a member's bare names
//   8  implements of a call-role export, undeclared alias forms, dry runs
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

/** Habitly: one subsystem with a Portal, its orchestrator and two types whose code paths are planned. */
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
      { id: 'habit_portal_impl', contract: 'ihabit_portal', sourcePath: 'src/habit-portal.ts', methods: [{ name: 'checkIn', narrative: [{ stepNumber: 1, type: 'call', description: 'Record it.', targetComponent: 'habit_orchestrator', targetMethod: 'checkIn' }] }] },
      { id: 'habit_orchestrator_impl', contract: 'ihabit_orchestrator', sourcePath: 'src/habit-orchestrator.ts', methods: [{ name: 'checkIn', detail: 'intent', intent: 'Records one check-in for today on the habit it names, and fails when that habit is unknown or archived.' }] },
    ],
    types: [
      { id: 'habit', kind: 'value-object', subsystem: 'habits', description: 'A habit someone builds.', sourcePath: 'src/domain/habit.ts', fields: [{ name: 'title', type: 'string' }] },
      { id: 'check_in', kind: 'value-object', subsystem: 'habits', description: 'One day a habit was kept.', sourcePath: 'src/domain/habit.ts', fields: [{ name: 'day', type: 'date' }] },
    ],
  };
}

interface GeoOptions {
  /** Declare `abi: c` on the library Portal (default true). */
  abi?: boolean;
  /** The library verb's return type (default tile-key). */
  returns?: string;
  /** The tile-key's fields (default one). */
  keyFields?: number;
}

/** GeoKit: a Rust library — an InProcess Portal exported for calling, and an extension point exported role implement. */
function geoKit(o: GeoOptions = {}): FixtureTree {
  return {
    system: {
      name: 'GeoKit', vision: 'A tiling library for map applications.', targetLanguage: 'Rust',
      publicInterfaces: [
        { from: 'tiling', component: 'tile-library' },
        { from: 'tiling', component: 'tile-source-port', as: 'tile-source', role: 'implement' },
      ],
    },
    subsystems: [{
      id: 'tiling', description: 'Tile arithmetic.',
      publicInterfaces: [
        { component: 'tile-library', details: 'The crate\'s tile API.' },
        { component: 'tile-source-port', details: 'Where tiles load from.', role: 'implement' },
      ],
    }],
    components: [
      {
        id: 'tile-library', componentType: 'Portal', transport: 'InProcess', ...(o.abi === false ? {} : { abi: 'c' }),
        description: 'The crate\'s tile API.', invokedBy: { kind: 'entry', caller: 'Applications that link the GeoKit crate and call it directly.' },
      },
      { id: 'tile-source-port', componentType: 'Adapter', description: 'The port GeoKit loads tiles through.' },
    ],
    interfaces: [
      { id: 'itile_library', component: 'tile-library', methods: [{ name: 'tile_for', description: 'The tile key for a zoom.', params: [{ name: 'zoom', type: 'int' }], returns: o.returns ?? 'tile-key', effect: 'none' }] },
      { id: 'itile_source_port', component: 'tile-source-port', methods: [{ name: 'load_tile', description: 'Load a tile.', params: [{ name: 'zoom', type: 'int' }], returns: 'bytes', invokedBy: { kind: 'runtime', caller: 'The GeoKit renderer, each time a tile it needs is not in memory yet.' } }] },
    ],
    types: [{
      id: 'tile-key', kind: 'value-object', subsystem: 'tiling', description: 'A tile key.',
      fields: [{ name: 'x', type: 'int' }, ...((o.keyFields ?? 1) > 1 ? [{ name: 'y', type: 'int' }] : [])],
    }],
  };
}

interface StudioOptions {
  /** Reference the library at all (default true). */
  usesGeo?: boolean;
  /** What a contract implements (default none). */
  implementsRef?: string;
}

/** TileStudio: calls GeoKit directly from pure logic. */
function tileStudio(o: StudioOptions = {}): FixtureTree {
  const uses = o.usesGeo ?? true;
  return {
    system: { name: 'TileStudio', vision: 'A map editor that renders tiles computed by GeoKit.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'editor', description: 'The map editing canvas.' }],
    components: [
      { id: 'map-renderer', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Works out which tiles the map needs.', ...(uses ? { dependsOn: ['geo::tile-library'] } : {}) },
      ...(o.implementsRef ? [{ id: 'tile-cache', componentType: 'Adapter', description: 'Serves tiles from a local cache.' }] : []),
    ],
    interfaces: [
      { id: 'imap_renderer', component: 'map-renderer', methods: [{ name: 'visibleTile', description: 'The tile the map centre needs.', params: [{ name: 'zoom', type: 'int' }], returns: 'string', invokedBy: { kind: 'runtime', caller: 'The editor canvas, once on every pan or zoom of the map view.' } }] },
      ...(o.implementsRef ? [{
        id: 'itile_cache', component: 'tile-cache', implements: o.implementsRef,
        methods: [{ name: 'tile_for', description: 'Serve one tile.', params: [{ name: 'zoom', type: 'int' }], returns: 'string', invokedBy: { kind: 'runtime', caller: 'The renderer, for each tile it draws.' } }],
      }] : []),
    ],
    implementations: [{
      id: 'map_renderer_impl', contract: 'imap_renderer',
      lint: { allow: [{ code: 'MISSING_SOURCE_PATH', reason: 'design-only e2e journey — the code lives outside this scratch project' }] },
      methods: [{
        name: 'visibleTile', narrative: uses
          ? [
            { stepNumber: 1, type: 'call', description: 'Ask GeoKit for the tile key.', targetComponent: 'geo::tile-library', targetMethod: 'tile_for' },
            { stepNumber: 2, type: 'return', description: 'Answer it.', outcome: 'the tile key' },
          ]
          : [{ stepNumber: 1, type: 'return', description: 'Answer the centre tile.', outcome: 'the tile key' }],
      }],
    }],
  };
}

let sb: TrialSandbox;

beforeAll(() => {
  sb = createTrialSandbox('r4-approval');
});

afterAll(async () => {
  await sb?.cleanup();
});

/** A producer + consumer pair under one folder. */
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

/** The consumer's project.yaml `externals` block, to carry across a rewrite. */
function declaredExternals(dir: string): Record<string, unknown> | undefined {
  return (yaml.load(readFile(dir, '.wai/project.yaml')) as { externals?: Record<string, unknown> }).externals;
}

// ---------------------------------------------------------------------------

describe('1 — status, lock-check and lock agree after `wairon project rename` (solo-app / lib-and-app R4-28 MAJOR)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = sb.project('rename-id');
    writeProject(dir, 'route-planner', habitly());
    const lock = await sb.run(['lock', '--yes'], dir);
    expect(lock.code, transcript(lock)).toBe(0);
  });

  it('control: approved on every surface before the rename', async () => {
    const s = await sb.run(['status'], dir);
    expect(s.all).toContain('no spec has changed since.');
    expect(s.all).not.toMatch(/drifted/);
    expect((await sb.run(['lock-check', '--strict'], dir)).code).toBe(0);
  });

  it('after the rename, status says the approval is owed and why — never "approved"', async () => {
    const rename = await sb.run(['project', 'rename', 'route-planner-v2', '--yes'], dir);
    expect(rename.code, transcript(rename)).toBe(0);
    const s = await sb.run(['status'], dir);
    expect(s.code, transcript(s)).toBe(0);
    // Round 4: "this project is approved … no spec has changed since." while lock-check failed.
    expect(s.all).toMatch(/drifted/);
    expect(s.all).not.toMatch(/Approval: this project is approved/);
    expect(s.all).toContain('the project was renamed since the approval (route-planner → route-planner-v2)');
    expect(s.all).toContain('`wairon lock-check` fails until it is cleared');
    const lc = await sb.run(['lock-check', '--strict'], dir);
    expect(lc.code, transcript(lc)).toBe(1);
    expect(lc.all).toContain('PROJECT_ID_RENAMED');
  });

  it('the PROJECT_ID_RENAMED notice names the new id where the new id belongs', async () => {
    const v = await sb.run(['validate'], dir);
    expect(v.all).toContain('[PROJECT_ID_RENAMED] Project "route-planner-v2" was renamed from "route-planner"');
    // Round 4 printed the display name: Project "route-planner" was renamed from "route-planner".
    expect(v.all).not.toContain('Project "route-planner" was renamed from "route-planner"');
  });

  it('one lock clears it on all three surfaces', async () => {
    const lock = await sb.run(['lock', '--yes'], dir);
    expect(lock.code, transcript(lock)).toBe(0);
    expect(lock.all).toContain('the project id (route-planner → route-planner-v2)');
    expect((await sb.run(['lock-check', '--strict'], dir)).code).toBe(0);
    const s = await sb.run(['status'], dir);
    expect(s.all).not.toMatch(/drifted/);
  });
});

describe('2 — a storage move is no design change (solo-app R4 top-2 MAJOR)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = sb.project('storage-move');
    writeProject(dir, 'habitly', habitly());
    writeFile(dir, 'src/domain/habit.ts', 'export interface Habit { title: string }\nexport interface CheckIn { day: string }\n');
    gitInit(dir);
    const lock = await sb.run(['lock', '--yes'], dir);
    expect(lock.code, transcript(lock)).toBe(0);
  });

  it('control: the tree validates without SOURCE_PATH_ESCAPES_ROOT before the move', async () => {
    const v = await sb.run(['validate'], dir);
    expect(v.all).not.toContain('SOURCE_PATH_ESCAPES_ROOT');
  });

  it('externalize into a part: the types\' paths are stored part-relative and read back inside the root — validate stays clean, no re-lock', async () => {
    const r = await sb.run(['subsystem', 'externalize', 'habits', '--path', 'services/habits', '--yes'], dir);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).not.toMatch(/Re-lock/);
    const typeFile = fs.readdirSync(path.join(dir, 'services', 'habits', '.wai', 'specs'), { recursive: true })
      .map(String).find((f) => f.endsWith('check_in.yaml'));
    expect(typeFile).toBeDefined();
    expect(readFile(path.join(dir, 'services', 'habits'), `.wai/specs/${typeFile!.split(path.sep).join('/')}`)).toContain('../../src/domain/habit.ts');
    const v = await sb.run(['validate'], dir);
    // Round 4: SOURCE_PATH_ESCAPES_ROOT ×2 on the moved types, validate red.
    expect(v.all, transcript(v)).not.toContain('SOURCE_PATH_ESCAPES_ROOT');
    expect(v.code, transcript(v)).toBe(0);
    expect((await sb.run(['lock-check', '--strict'], dir)).code).toBe(0);
  });

  it('internalize the part back: a byte-for-byte round trip that asks for no re-lock', async () => {
    const r = await sb.run(['member', 'internalize', 'habits', '--yes'], dir);
    expect(r.code, transcript(r)).toBe(0);
    // Round 4: "To re-lock once applied" / "Re-lock this project (.)" over a storage move.
    expect(r.all).not.toMatch(/re-lock/i);
    expect((await sb.run(['lock-check', '--strict'], dir)).code).toBe(0);
    const v = await sb.run(['validate'], dir);
    expect(v.all).not.toContain('SOURCE_PATH_ESCAPES_ROOT');
  });
});

describe('3 — `lock` refuses uses its pin does not record, and lock-check agrees (tinkerer R4 MAJOR, solo-app R4 MINOR)', () => {
  let p: ReturnType<typeof pair>;

  beforeAll(async () => {
    // Pinned while no spec referenced the producer: the pin records 0 uses.
    p = pair('unrecorded', {}, { usesGeo: false });
    const add = await sb.run(['externals', 'add', 'geo', '../geo'], p.studio);
    expect(add.code, transcript(add)).toBe(0);
    expect(add.all).toContain('pinned 0 used name(s)');
    writeProject(p.studio, 'studio', tileStudio(), { externals: declaredExternals(p.studio) });
  });

  it('`lock` refuses the design whose uses the pin does not record, names them, and writes nothing', async () => {
    const lock = await sb.run(['lock', '--yes'], p.studio);
    expect(lock.code, transcript(lock)).not.toBe(0);
    expect(lock.all).toContain('external(s) used beyond their pin — "geo": tile-library.tile_for');
    expect(lock.all).toContain('Re-pin first (`wairon externals pin geo`), then lock. Nothing was written.');
    expect(fs.existsSync(path.join(p.studio, '.wai', 'lock.json'))).toBe(false);
  });

  it('after the re-pin it locks, and lock-check is green', async () => {
    const pin = await sb.run(['externals', 'pin', 'geo'], p.studio);
    expect(pin.code, transcript(pin)).toBe(0);
    const lock = await sb.run(['lock', '--yes'], p.studio);
    expect(lock.code, transcript(lock)).toBe(0);
    expect((await sb.run(['lock-check', '--strict'], p.studio)).code).toBe(0);
  });

  it('a declared external never pinned: lock-check fails with the lock\'s own reason, and status says the approval is owed', async () => {
    const add = await sb.run(['externals', 'add', 'ghost', '../does-not-exist'], p.studio);
    expect(add.code, transcript(add)).toBe(2);
    const lc = await sb.run(['lock-check'], p.studio);
    // Round 4: "✔ The design in this tree is the approved design" while `lock` refused.
    expect(lc.code, transcript(lc)).toBe(1);
    expect(lc.all).toContain('declared external(s) never pinned — "ghost"');
    expect(lc.all).toContain('pin first (`wairon externals pin`), then run `wairon lock`');
    const s = await sb.run(['status'], p.studio);
    expect(s.all).toMatch(/drifted/);
    expect(s.all).toContain('declared external(s) never pinned — "ghost"');
    const lock = await sb.run(['lock', '--yes'], p.studio);
    expect(lock.code, transcript(lock)).not.toBe(0);
    expect(lock.all).toContain('declared external(s) never pinned — "ghost"');
  });

  it('removing it restores agreement: green everywhere', async () => {
    const rm = await sb.run(['externals', 'remove', 'ghost'], p.studio);
    expect(rm.code, transcript(rm)).toBe(0);
    expect((await sb.run(['lock-check', '--strict'], p.studio)).code).toBe(0);
    const s = await sb.run(['status'], p.studio);
    expect(s.all).not.toMatch(/drifted/);
  });
});

describe('4 — `surface diff` reports every fact a pin drifts by, and never crashes (lib-and-app R4-1/21/23, platform, tinkerer)', () => {
  it('a project with no committed approval (no git at all, then no commit of lock.json): one ✖ line, exit 1, no stack trace', async () => {
    const dir = sb.project('diff-fresh');
    writeProject(dir, 'geo', geoKit());
    const noGit = await sb.run(['surface', 'diff'], dir);
    expect(noGit.code, transcript(noGit)).toBe(1);
    expect(noGit.all).toMatch(/is in no git work tree/);
    expect(noGit.all).not.toMatch(/\n\s+at \w/);
    gitInit(dir);
    const noLock = await sb.run(['surface', 'diff'], dir);
    expect(noLock.code, transcript(noLock)).toBe(1);
    expect(noLock.all).toContain('no approval of this project was ever committed');
    expect(noLock.all).not.toMatch(/\n\s+at \w/);
  });

  it('an abi change — what a consumer\'s pin drifts by — is in the changelog; a return type that only changed shape is no "signature A → A" row', async () => {
    const dir = sb.project('diff-abi');
    writeProject(dir, 'geo', geoKit({ abi: false }));
    const lock = await sb.run(['lock', '--yes'], dir);
    expect(lock.code, transcript(lock)).toBe(0);
    gitInit(dir);
    const before = await sb.run(['surface', 'diff', '--json'], dir);
    expect(before.code, transcript(before)).toBe(0);
    expect((JSON.parse(before.stdout) as { changes: unknown[] }).changes).toEqual([]);

    writeProject(dir, 'geo', geoKit({ abi: true, keyFields: 2 }));
    const d = await sb.run(['surface', 'diff', '--json'], dir);
    expect(d.code, transcript(d)).toBe(0);
    const changes = (JSON.parse(d.stdout) as { changes: { kind: string; name: string; member?: string; detail: string }[] }).changes;
    // Round 4: "no change" against the approval although the consumer's pin was drifted by abi.
    expect(changes).toContainEqual(expect.objectContaining({ kind: 'changed', name: 'tile-library', detail: 'abi none → c' }));
    // Tinkerer R4: "signature tile_for(zoom: int): tile-key → tile_for(zoom: int): tile-key".
    for (const c of changes) {
      const m = /^signature (.*) → (.*)$/.exec(c.detail);
      if (m) expect(m[1]).not.toBe(m[2]);
    }
    const tile = changes.find((c) => c.name === 'tile-library' && c.member === 'tile_for');
    expect(tile?.detail).toContain('signature reads the same, but a type it names changed shape: "tile-key"');
  });
});

describe('5 — a renamed verb across projects: dry run names who breaks, callers hear "renamed to" (platform R4 top-2 MAJORs)', () => {
  let root: string;
  let orders: string;

  beforeAll(() => {
    root = sb.materialize('verb-rename', platformFamily());
    orders = path.join(root, 'services', 'orders');
  });

  it('`externals consumers` at the producer lists who calls what, method by method', async () => {
    const r = await sb.run(['externals', 'consumers'], orders);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.stdout).toContain('calls: orders.create');
  });

  it('`method rename --dry-run` names the consumer the rename breaks and writes nothing', async () => {
    const spec = '.wai/specs/interfaces/iorders_api.yaml';
    const before = readFile(orders, spec);
    const r = await sb.run(['method', 'rename', 'orders_api', 'create', 'placeOrder', '--dry-run'], orders);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toContain('Dry run: renaming "orders_api.create" to "placeOrder"');
    expect(r.all).toContain('1 consumer(s) call "create" and break until they follow the rename');
    expect(r.all).toContain('platform (members.orders)');
    expect(r.all).toContain('Nothing was written.');
    expect(readFile(orders, spec)).toBe(before);
  });

  it('applied, the caller\'s gate says "renamed to placeOrder" from the producer\'s trace', async () => {
    const r = await sb.run(['method', 'rename', 'orders_api', 'create', 'placeOrder'], orders);
    expect(r.code, transcript(r)).toBe(0);
    expect(readFile(orders, '.wai/specs/interfaces/iorders_api.yaml')).toContain('iorders_api.create');
    const v = await sb.run(['validate', '--family'], root);
    expect(v.code, transcript(v)).toBe(1);
    // Round 4: INVALID_TARGET_METHOD_REFERENCE … "create" is not defined — no new name.
    expect(v.all).toMatch(/It was renamed to "placeOrder" \(the rename trace of "orders::orders_api" records "create"\) — did you mean "placeOrder"\?/);
  });
});

describe('6/7 — a member\'s root: the family view on the CLI, network why with bare and former names (platform R4 MAJOR, tinkerer, platform MINOR)', () => {
  let root: string;
  let orders: string;

  beforeAll(() => {
    root = sb.materialize('member-root', platformFamily());
    orders = path.join(root, 'services', 'orders');
  });

  it('`validate --family` at the member judges its network from the enclosing family: no "no declared network encloses", and counts match the list', async () => {
    const atRoot = await sb.run(['validate', '--family'], root);
    const atMember = await sb.run(['validate', '--family'], orders);
    // Round 4 (MCP twin): ENTRY_SCOPE_UNBOUNDED "no declared network encloses the root" + ENTRY_UNPROVEN on every verb.
    expect(atMember.all, transcript(atMember)).not.toContain('ENTRY_SCOPE_UNBOUNDED');
    expect(atMember.all).not.toMatch(/ENTRY_UNPROVEN[^\n]*orders_api\.create/);
    // What the family root says of the member's verbs, the member's family run says too.
    expect(countCode(atMember.all, 'ENTRY_UNPROVEN')).toBe(countCode(atRoot.all.split('\n').filter((l) => l.includes('orders_api')).join('\n'), 'ENTRY_UNPROVEN'));
    // Per-project counts are counted from the listed findings.
    const line = /orders \(bound\) — \w+: (\d+) error\(s\), (\d+) warning\(s\)/.exec(atMember.all);
    expect(line, transcript(atMember)).not.toBeNull();
    const listedWarnings = atMember.all.split('\n').filter((l) => l.startsWith('⚠') && l.includes('[orders (bound)]')).length;
    expect(Number(line![2])).toBe(listedWarnings);
  });

  it('`network why` at the member root reads a bare name of its own as the member\'s (tinkerer R4)', async () => {
    const r = await sb.run(['network', 'why', 'orders_client', 'orders_api.create'], orders);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toContain('may reach');
    expect(r.all).not.toContain('unknown party');
  });

  it('`network why` reads a renamed project\'s former id, with a note, as policy and check do (platform R4)', async () => {
    const renamed = sb.materialize('member-renamed', platformFamily());
    const apply = await sb.run(['project', 'rename', 'orders_svc', '--project', 'orders', '--yes'], renamed);
    expect(apply.code, transcript(apply)).toBe(0);
    const r = await sb.run(['network', 'why', 'orders_client', 'orders'], renamed);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toContain('"orders" names the renamed project "orders_svc" by its former name');
    expect(r.all).not.toContain('unknown party');
    const typo = await sb.run(['network', 'why', 'orders_client', 'ordrs'], renamed);
    expect(typo.code, transcript(typo)).toBe(1);
    expect(typo.all).toContain('unknown party');
  });
});

describe('8 — implements, undeclared aliases, remove dry run, the externals hint (lib-and-app R4-13/15/16/27, platform)', () => {
  it('`implements:` of an export consumers CALL is refused (EXTERNAL_NOT_EXPORTED); of the extension point it is not', async () => {
    const bad = pair('implements-call', {}, { implementsRef: 'geo::tile-library' });
    expect((await sb.run(['externals', 'add', 'geo', '../geo'], bad.studio)).code).toBe(0);
    const v = await sb.run(['validate'], bad.studio);
    expect(v.code, transcript(v)).toBe(1);
    expect(v.all).toMatch(/\[EXTERNAL_NOT_EXPORTED\] "itile_cache" writes "geo::tile-library" \(implements\), which the producer exports for consumers to call \(role call\), not as an extension point/);
  });

  it('removing the last external: EXTERNAL_UNDECLARED alone, never a "member path" DEPRECATED_REFERENCE_FORM beside it', async () => {
    const p = pair('remove-last');
    expect((await sb.run(['externals', 'add', 'geo', '../geo'], p.studio)).code).toBe(0);
    const dry = await sb.run(['externals', 'remove', 'geo', '--dry-run'], p.studio);
    expect(dry.code, transcript(dry)).toBe(0);
    expect(dry.stdout).toContain('would remove geo — its declaration and its pin');
    const rm = await sb.run(['externals', 'remove', 'geo'], p.studio);
    expect(rm.code, transcript(rm)).toBe(0);
    const v = await sb.run(['validate'], p.studio);
    expect(v.code, transcript(v)).toBe(1);
    expect(v.all).toContain('[EXTERNAL_UNDECLARED]');
    // Round 4: 17× "a member path is read from the bound root" beside the 15 errors.
    expect(v.all).not.toContain('DEPRECATED_REFERENCE_FORM');
  });

  it('a project with externals and no members is not sent to `validate --family` (R4-15/16)', async () => {
    const p = pair('hint');
    expect((await sb.run(['externals', 'add', 'geo', '../geo'], p.studio)).code).toBe(0);
    const v = await sb.run(['validate'], p.studio);
    expect(v.all).toContain('1 external was judged against its pin alone; the advisory live comparison reads its live producer');
    expect(v.all).not.toContain('wairon validate --family` composes');
  });
});
