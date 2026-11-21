import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { projectFamilyGraph as projectFamily } from '../../src/core/project-family.js';
import { familyApprovals, validateProject } from '../../src/core/validation.js';
import { memberRevisions } from '../../src/core/external-producers.js';
import { BASE_FIXTURE_RULES, materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';

// ---------------------------------------------------------------------------
// A path external (`../x` under `externals`) is a live node of the scan judged
// for validity only: never a member approval, never a member debt, never a
// member revision. A use of it that does not hold still fails the consumer.
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const dir of roots.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
  }
});

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

function configYaml(id: string, extra: Record<string, unknown> = {}): string {
  return yaml.dump({
    schemaVersion: '1.0.0', id, name: id, targets: [], rules: BASE_FIXTURE_RULES,
    extensions: { packs: [], useGlobalPacks: false }, ...extra, createdAt: TS, updatedAt: TS,
  }, { noRefs: true, lineWidth: 200 });
}

function geoKit(): FixtureTree {
  return {
    system: {
      name: 'GeoKit', vision: 'A tiling library.', targetLanguage: 'Rust',
      publicInterfaces: [{ from: 'tiling', component: 'tile-library' }],
    },
    subsystems: [{ id: 'tiling', description: 'Tile arithmetic.', publicInterfaces: [{ component: 'tile-library', details: 'The tile API.' }] }],
    components: [{
      id: 'tile-library', componentType: 'Portal', transport: 'InProcess', abi: 'c',
      description: 'The tile API.', invokedBy: { kind: 'entry', caller: 'Applications linking the crate.' },
    }],
    interfaces: [{ id: 'itile_library', component: 'tile-library', methods: [{ name: 'tile_for', description: 'The tile for a zoom.', params: [{ name: 'zoom', type: 'int' }], returns: 'string', effect: 'none' }] }],
  };
}

function tileStudio(targetMethod: string): FixtureTree {
  return {
    system: { name: 'TileStudio', vision: 'A map editor.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'editor', description: 'The map canvas.' }],
    components: [{ id: 'map-renderer', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Works out the tiles.', dependsOn: ['geo::tile-library'] }],
    interfaces: [{ id: 'imap_renderer', component: 'map-renderer', methods: [{ name: 'visibleTile', description: 'The centre tile.', params: [{ name: 'zoom', type: 'int' }], returns: 'string' }] }],
    implementations: [{
      id: 'map_renderer_impl', contract: 'imap_renderer',
      methods: [{ name: 'visibleTile', narrative: [
        { stepNumber: 1, type: 'call', description: 'Ask GeoKit for the tile.', targetComponent: 'geo::tile-library', targetMethod },
        { stepNumber: 2, type: 'return', description: 'Answer it.', outcome: 'the tile' },
      ] }],
    }],
  };
}

/** GeoKit (never approved) at <root>/geo; TileStudio at <root>/studio declaring it under `externals` at ../geo, requiring approved members. */
function pair(targetMethod = 'tile_for'): { studio: string; geo: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-pathext-')));
  roots.push(root);
  const geo = path.join(root, 'geo');
  const studio = path.join(root, 'studio');
  fs.mkdirSync(geo, { recursive: true });
  materializeFixtureProject(geo, geoKit());
  fs.writeFileSync(path.join(geo, '.wai', 'project.yaml'), configYaml('geo'));
  fs.mkdirSync(studio, { recursive: true });
  materializeFixtureProject(studio, tileStudio(targetMethod));
  fs.writeFileSync(path.join(studio, '.wai', 'project.yaml'), configYaml('studio', {
    externals: { geo: { source: { path: '../geo' } } },
    composition: { requireApprovedMembers: true },
  }));
  return { studio, geo };
}

describe('a path external is not a member', () => {
  it('stays a node of the scan, marked as a path external', () => {
    const p = pair();
    bind(p.studio);
    const node = projectFamily().nodes.find((n) => n.mountAlias === 'geo');
    expect(node).toBeDefined();
    expect(node!.pathExternal).toBe(true);
  });

  it('an unapproved but valid one is no approval entry and no member debt of the consumer', () => {
    const p = pair();
    bind(p.studio);
    const approvals = familyApprovals(2);
    expect(approvals.map((a) => a.key)).toEqual(['']);
    expect(approvals[0].inputs.filter((d) => d.kind === 'member')).toEqual([]);
  });

  it('is never listed among the member revisions', () => {
    const p = pair();
    bind(p.studio);
    expect(memberRevisions()).toEqual([]);
  });

  it('a valid use of it leaves the consumer\'s gate clean', () => {
    const p = pair();
    bind(p.studio);
    expect(validateProject({}).issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('an invalid use of it fails the consumer\'s gate', () => {
    const p = pair('tile_missing');
    bind(p.studio);
    const errors = validateProject({}).issues.filter((i) => i.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
  });
});
