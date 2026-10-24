import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DIST_CLI, callTool } from './helpers';
import { createTrialSandbox, gitInit, readFile, runCliIn, transcript, type TrialSandbox } from './trials-helpers';
import type { FixtureTree } from '../rules-matrix/harness';

// ---------------------------------------------------------------------------
// Round-10 user trials (dev.114) — authoring, the spec write lock and the
// member verbs, replayed against the BUILT server and CLI.
//
//  - lib-and-app: a `together` type move dry-ran to nothing and the real move
//    broke the L0 export table (EXPORT_INVALID ×3); the move back left an
//    empty types/ folder and updatedAt-only diffs. Two CLI writers of one
//    spec both printed "✔ Renamed" while one rename was not on disk.
//  - tinkerer: a .spec-write.lock wairon cannot read blocked every write for
//    30 s and was never broken; doctor said nothing. An init refusal in a
//    subfolder; init never mentioned the lock file.
//  - platform: `member add ../../../x` scaffolded a .wai outside the family.
// ---------------------------------------------------------------------------

let sb: TrialSandbox;
beforeAll(() => { sb = createTrialSandbox('r10authoring'); });
afterAll(async () => { await sb?.cleanup(); });

/** A materialized project with an id and extra configuration. */
function project(name: string, tree: FixtureTree, id?: string, extra: Record<string, unknown> = {}): string {
  const dir = sb.materialize(name, tree);
  const file = path.join(dir, '.wai', 'project.yaml');
  const config = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(file, yaml.dump({ ...config, ...(id ? { id, name: id } : {}), ...extra }));
  return dir;
}

const open: Client[] = [];
afterAll(async () => { for (const c of open) { try { await c.close(); } catch { /* gone */ } } });

async function serve(dir: string): Promise<Client> {
  const env: Record<string, string> = Object.fromEntries(Object.entries(sb.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
  env.WAIRON_PROJECT_DIR = dir;
  const client = new Client({ name: 'wairon-e2e-r10-authoring', version: '0.0.1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [DIST_CLI, 'mcp', 'serve'], cwd: dir, env, stderr: 'ignore' }));
  open.push(client);
  return client;
}

/** Every file under the tree's .wai/specs with its bytes, and every folder. */
function specTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, rel: string): void => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out[`${r}/`] = 'dir'; walk(path.join(at, e.name), r); } else out[r] = fs.readFileSync(path.join(at, e.name), 'utf8');
    }
  };
  walk(path.join(dir, '.wai', 'specs'), '');
  return out;
}

describe('journey: a type cluster moves into a subsystem and back (lib-and-app-r10 top-3)', () => {
  it('the dry run names files, references and findings; the move keeps the export table valid; moving back is byte-identical', async () => {
    const dir = project('geo', {
      system: { name: 'geo', vision: 'Geo maths.', publicInterfaces: [{ typeDef: 'tile_coord', as: 'tile_coord' }, { typeDef: 'zoom', as: 'zoom' }] },
      subsystems: [{ id: 'tiles', status: 'complete' }],
      components: [{ id: 'tile_math', subsystem: 'tiles', componentType: 'Orchestrator', dependencyClass: 'pure', status: 'complete' }],
      types: [
        { id: 'tile_coord', kind: 'value-object', fields: [{ name: 'x', type: 'int' }, { name: 'z', type: 'zoom' }] },
        { id: 'zoom', kind: 'value-object', fields: [{ name: 'level', type: 'int' }] },
      ],
    }, 'geo');
    const before = specTree(dir);
    const c = await serve(dir);
    const dry = await callTool(c, 'sdd_move_spec', { kind: 'type', id: 'tile_coord', subsystem: 'tiles', together: ['zoom'], dryRun: true });
    expect(dry.ok, dry.text).toBe(true);
    const plan = JSON.parse(dry.text);
    expect(plan.dryRun).toBe(true);
    expect(plan.files).toEqual(expect.arrayContaining([expect.stringMatching(/types\/tile_coord\.yaml/), '.wai/specs/.index.yaml']));
    expect(plan.references).toEqual(expect.arrayContaining(['system: L0 export tile_coord from (none) → tiles', 'tiles: L1 export of type tile_coord added']));
    expect(plan.findings).toEqual([]);
    expect(specTree(dir)).toEqual(before);

    const moved = await callTool(c, 'sdd_move_spec', { kind: 'type', id: 'tile_coord', subsystem: 'tiles', together: ['zoom'] });
    expect(moved.ok, moved.text).toBe(true);
    const v = await sb.run(['validate'], dir);
    expect(v.all, transcript(v)).not.toMatch(/EXPORT_INVALID/);

    const back = await callTool(c, 'sdd_move_spec', { kind: 'type', id: 'tile_coord', together: ['zoom'] });
    expect(back.ok, back.text).toBe(true);
    expect(fs.existsSync(path.join(dir, '.wai', 'specs', 'tiles', 'types'))).toBe(false);
    void before; // the fixture's hand-written files are not in the stored form; a round trip from wairon's own is:
    const settled = specTree(dir);
    expect((await callTool(c, 'sdd_move_spec', { kind: 'type', id: 'tile_coord', subsystem: 'tiles', together: ['zoom'] })).ok).toBe(true);
    expect((await callTool(c, 'sdd_move_spec', { kind: 'type', id: 'tile_coord', together: ['zoom'] })).ok).toBe(true);
    expect(specTree(dir)).toEqual(settled);
  }, 240_000);
});

describe('journey: two CLI writers of one spec in the same instant (lib-and-app-r10 R10-5, BLOCKER EDGE)', () => {
  it('a rename that printed ✔ is on disk; one that lost the race says so, writes nothing, and lands when run again', async () => {
    for (let round = 0; round < 4; round++) {
      const dir = project(`race${round}`, {
        subsystems: [{ id: 'geo', status: 'complete' }],
        types: [{ id: 'coordinate', kind: 'value-object', subsystem: 'geo', fields: [{ name: 'lat', type: 'float' }, { name: 'lon', type: 'float' }] }],
      }, `race${round}`);
      const [a, b] = await Promise.all([
        runCliIn(['type', 'rename-field', 'coordinate', 'lat', 'latitude_deg'], dir, sb.env),
        runCliIn(['type', 'rename-field', 'coordinate', 'lon', 'longitude_deg'], dir, sb.env),
      ]);
      const file = Object.keys(specTree(dir)).find((k) => k.endsWith('coordinate.yaml'))!;
      const names = (): string[] => ((yaml.load(readFile(dir, `.wai/specs/${file}`)) as { fields: { name: string }[] }).fields.map((f) => f.name));
      for (const [r, field] of [[a, 'latitude_deg'], [b, 'longitude_deg']] as const) {
        if (r.code === 0) expect(names(), `round ${round}: ${transcript(r)}`).toContain(field);
        else expect(r.all, transcript(r)).toMatch(/spec-write-conflict|spec-tree-locked/);
      }
      // A refused one, run again, lands: nothing is ever lost in silence.
      if (a.code !== 0) expect((await runCliIn(['type', 'rename-field', 'coordinate', 'lat', 'latitude_deg'], dir, sb.env)).code).toBe(0);
      if (b.code !== 0) expect((await runCliIn(['type', 'rename-field', 'coordinate', 'lon', 'longitude_deg'], dir, sb.env)).code).toBe(0);
      expect(names()).toEqual(['latitude_deg', 'longitude_deg']);
      expect(fs.readdirSync(path.join(dir, '.wai')).filter((n) => /^\.spec-write\.lock\.\d+$/.test(n) && !fs.existsSync(path.join(dir, '.wai', n + '.end')))).toEqual([]);
    }
  }, 600_000);
});

describe('journey: a write lock wairon cannot read (tinkerer-r10, EDGE)', () => {
  it('doctor names it; the next write breaks it once it is past the grace, instead of waiting 30 s and refusing', async () => {
    const dir = project('stale', {
      subsystems: [{ id: 'geo', status: 'complete' }],
      types: [{ id: 'coordinate', kind: 'value-object', subsystem: 'geo', fields: [{ name: 'lat', type: 'float' }] }],
    }, 'stale');
    const ended = fs.readdirSync(path.join(dir, '.wai')).map((n) => /^\.spec-write\.lock\.(\d+)\.end$/.exec(n)).filter((m) => m !== null).map((m) => Number(m![1]));
    const lock = path.join(dir, '.wai', `.spec-write.lock.${Math.max(0, ...ended) + 1}`);
    fs.writeFileSync(lock, '{"pid": 99999, "at": "2026-10-01T00:00:00Z"}');
    const old = new Date(Date.now() - 15_000);
    fs.utimesSync(lock, old, old);
    const doctor = await sb.run(['doctor'], dir);
    expect(doctor.all, transcript(doctor)).toMatch(/\.wai\/\.spec-write\.lock\.\d+ is present .*no holder can be read from it.*the next spec write breaks it/);
    const started = Date.now();
    const r = await sb.run(['type', 'rename-field', 'coordinate', 'lat', 'latitude'], dir);
    expect(r.code, transcript(r)).toBe(0);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(fs.existsSync(lock)).toBe(false);
  }, 120_000);
});

describe('journey: member add only where a member belongs (platform-r10 MAJOR EDGE)', () => {
  it('a path climbing past a sibling is refused, writing nothing; --report plans a sibling and writes nothing', async () => {
    const dir = project('fam', { subsystems: [{ id: 'core', status: 'complete' }] }, 'fam');
    const configBefore = readFile(dir, '.wai/project.yaml');
    const deep = await sb.run(['member', 'add', 'evil', '../../../toolchain-r10'], dir);
    expect(deep.code, transcript(deep)).toBe(1);
    expect(deep.all).toMatch(/climbs 3 folders out of the project/);
    expect(deep.all).toMatch(/Nothing was written/);
    expect(fs.existsSync(path.resolve(dir, '../../../toolchain-r10'))).toBe(false);
    expect(readFile(dir, '.wai/project.yaml')).toBe(configBefore);

    const report = await sb.run(['member', 'add', 'sib', '../sib-r10', '--report'], dir);
    expect(report.code, transcript(report)).toBe(0);
    expect(report.all).toMatch(/Report only/);
    expect(report.all).toMatch(/\.\.\/sib-r10\/\.wai\/specs\/ — the part's specs folder/);
    expect(report.all).toMatch(/members: sib: \.\.\/sib-r10/);
    expect(report.all).toMatch(/Nothing was written/);
    expect(fs.existsSync(path.resolve(dir, '../sib-r10'))).toBe(false);
    expect(readFile(dir, '.wai/project.yaml')).toBe(configBefore);

    const real = await sb.run(['member', 'add', 'sib', '../sib-r10'], dir);
    expect(real.code, transcript(real)).toBe(0);
    expect(fs.existsSync(path.resolve(dir, '../sib-r10/.wai/specs'))).toBe(true);
  }, 120_000);
});

describe('journey: init (tinkerer-r10 MINORs)', () => {
  it('a fresh init keeps the write lock out of git; a refusal in a subfolder exits 1', async () => {
    const dir = sb.project('initlock');
    gitInit(dir);
    const init = await sb.run(['init', '-y'], dir);
    expect(init.code, transcript(init)).toBe(0);
    expect(readFile(dir, '.wai/.gitignore').split(/\r?\n/)).toContain('.spec-write.lock*');
    const sub = path.join(dir, 'packages', 'contracts');
    fs.mkdirSync(sub, { recursive: true });
    const refused = await sb.run(['init', '-y'], sub);
    expect(refused.code, transcript(refused)).toBe(1);
    expect(refused.all).toMatch(/Nothing was written/);
    expect(fs.existsSync(path.join(sub, '.wai'))).toBe(false);
  }, 120_000);
});
