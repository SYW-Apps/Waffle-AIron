import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { declare, update } from '../../src/core/external-declarations.js';
import { BASE_FIXTURE_RULES, materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Round 12: a bare external is filled in from the family, and `update` also
// gives an external a new location.

const TS = '2026-01-01T00:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const dir of roots.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
  }
});

function configYaml(id: string, extra: Record<string, unknown> = {}): string {
  return yaml.dump({
    schemaVersion: '1.0.0', id, name: id, targets: [], rules: BASE_FIXTURE_RULES,
    extensions: { packs: [], useGlobalPacks: false }, ...extra, createdAt: TS, updatedAt: TS,
  }, { noRefs: true, lineWidth: 200 });
}

function library(name: string): FixtureTree {
  return {
    system: {
      name, vision: `The ${name} library.`, targetLanguage: 'Rust',
      publicInterfaces: [{ from: 'core', component: 'lib-portal' }],
    },
    subsystems: [{ id: 'core', description: 'The core.', publicInterfaces: [{ component: 'lib-portal', details: 'The API.' }] }],
    components: [{ id: 'lib-portal', componentType: 'Portal', transport: 'InProcess', description: 'The API.', invokedBy: { kind: 'entry', caller: 'Applications linking the crate.' } }],
    interfaces: [{ id: 'ilib_portal', component: 'lib-portal', methods: [{ name: 'ping', description: 'Ping.', params: [], returns: 'string', effect: 'none' }] }],
  };
}

/** A parent with three project members: studio (the consumer), geo and maps (two producers). */
function family(): { root: string; studio: string; geo: string; maps: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r12-')));
  roots.push(root);
  const dirs: Record<string, string> = {};
  for (const id of ['studio', 'geo', 'maps']) {
    const dir = path.join(root, 'projects', id);
    fs.mkdirSync(dir, { recursive: true });
    materializeFixtureProject(dir, library(id));
    fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), configYaml(id));
    dirs[id] = dir;
  }
  fs.mkdirSync(path.join(root, '.wai'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), configYaml('parent', {
    members: { studio: { source: 'projects/studio' }, geo: { source: 'projects/geo' }, maps: { source: 'projects/maps' } },
  }));
  return { root, studio: dirs.studio, geo: dirs.geo, maps: dirs.maps };
}

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

function studioConfig(dir: string): Record<string, any> {
  return yaml.load(fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8')) as Record<string, any>;
}

describe('declare with no source', () => {
  it('writes the relative path of the family project that answers to the id, and pins nothing', () => {
    const f = family();
    bind(f.studio);
    const added = declare({ alias: 'geo' });
    expect(added.refusal).toBeUndefined();
    expect(added.written).toBe(true);
    const written = studioConfig(f.studio).externals.geo;
    const source = typeof written.source === 'string' ? written.source : written.source.path;
    expect(source).toBe('../geo');
    expect(fs.existsSync(path.join(f.studio, '.wai', 'externals', 'geo'))).toBe(false);
  });

  it('is refused, writing nothing, when no family project answers to the id, naming the ids that do', () => {
    const f = family();
    bind(f.studio);
    const added = declare({ alias: 'nowhere' });
    expect(added.written).toBe(false);
    expect(added.refusal).toMatch(/no family project on disk answers to "nowhere"/);
    expect(added.refusal).toMatch(/"geo"/);
    expect(studioConfig(f.studio).externals).toBeUndefined();
  });
});

describe('update with a new location', () => {
  it('changes only the location, keeping `use`, and refuses a producer that answers to another id', () => {
    const f = family();
    bind(f.studio);
    expect(declare({ alias: 'geo', source: '../geo', use: ['lib-portal'] }).written).toBe(true);

    // A location that answers to another id is refused, writing nothing.
    const wrong = update({ alias: 'geo', source: '../maps' });
    expect(wrong.written).toBe(false);
    expect(wrong.refusal).toMatch(/answers to "maps", not "geo"/);
    expect(studioConfig(f.studio).externals.geo.source).toMatchObject({ path: '../geo' });

    // A dry run writes nothing.
    const dry = update({ alias: 'geo', source: '../../projects/geo', dryRun: true });
    expect(dry.written).toBe(false);
    expect(studioConfig(f.studio).externals.geo.source).toMatchObject({ path: '../geo' });

    // The same producer through another path: only the location changes.
    const moved = update({ alias: 'geo', source: '../../projects/geo' });
    expect(moved.refusal).toBeUndefined();
    expect(moved.written).toBe(true);
    expect(moved.source).toBe('../../projects/geo');
    expect(moved.pin).toBe('dropped');
    const after = studioConfig(f.studio).externals.geo;
    expect(after.source).toMatchObject({ path: '../../projects/geo' });
    expect(after.use).toEqual(['lib-portal']);
  });
});
