import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { pinExternals } from '../../src/core/surfaces.js';
import { validateProject, type ValidationIssue } from '../../src/core/validation.js';
import { BASE_FIXTURE_RULES, materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';

// ---------------------------------------------------------------------------
// Round 7 (lib-and-app R7-10): one design, two verdicts. A consumer that
// implements a library's exported extension point and takes the method's
// signature from it (`signatureFrom: geo::tile-source.load_tile`) validated
// clean while the library was a declared EXTERNAL, and raised
// SIGNATURE_SOURCE_OFF_EDGE once the same library became a MEMBER — demanding
// a dependsOn on the library's Adapter.
//
// Decided: the external side was right. Another project's export
// (`alias::name.method`) is licensed by the declared relation to that project
// — an external's or a member's alike — never by a dependsOn edge; for an
// extension point the edge would even point the wrong way (the producer calls
// the implementer). Only a source inside the method's own project needs the
// edge.
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

function configYaml(id: string, extra: Record<string, unknown> = {}): string {
  return yaml.dump({
    schemaVersion: '1.0.0', id, name: id, targets: [], rules: BASE_FIXTURE_RULES,
    extensions: { packs: [], useGlobalPacks: false }, ...extra, createdAt: TS, updatedAt: TS,
  }, { noRefs: true, lineWidth: 200 });
}

interface GeoOptions {
  abi?: string;
  audience?: string;
  /** previousIds of the tile library component (a rename trace). */
  formerTiles?: string[];
}

/** GeoKit: a Rust tiling library — an InProcess Portal, a tile-source extension point, an exported tile-key type. */
function geoKit(o: GeoOptions = {}): FixtureTree {
  return {
    system: {
      name: 'GeoKit', vision: 'A tiling library for map applications.', targetLanguage: 'Rust',
      publicInterfaces: [
        { from: 'tiling', component: 'tile-library', ...(o.audience ? { audience: o.audience } : {}) },
        { from: 'tiling', component: 'tile-source-port', as: 'tile-source', role: 'implement' },
        { from: 'tiling', typeDef: 'tile-key' },
      ],
    },
    subsystems: [{
      id: 'tiling', description: 'Tile arithmetic.',
      publicInterfaces: [
        { component: 'tile-library', details: 'The crate\'s tile API.' },
        { component: 'tile-source-port', details: 'Where tiles load from.', role: 'implement' },
        { typeDef: 'tile-key', details: 'A tile key.' },
      ],
    }],
    components: [
      {
        id: 'tile-library', componentType: 'Portal', transport: 'InProcess', ...(o.abi ? { abi: o.abi } : {}),
        description: 'The crate\'s tile API.', invokedBy: { kind: 'entry', caller: 'Applications linking the crate.' },
        ...(o.formerTiles ? { previousIds: o.formerTiles } : {}),
      },
      { id: 'tile-source-port', componentType: 'Adapter', description: 'The port GeoKit loads tiles through.' },
    ],
    interfaces: [
      { id: 'itile_library', component: 'tile-library', methods: [{ name: 'tile_for', description: 'The tile key for a zoom.', params: [{ name: 'zoom', type: 'int' }], returns: 'tile-key', effect: 'none' }] },
      { id: 'itile_source_port', component: 'tile-source-port', methods: [{ name: 'load_tile', description: 'Load a tile.', params: [{ name: 'key', type: 'tile-key' }], returns: 'bytes' }] },
    ],
    types: [{ id: 'tile-key', kind: 'value-object', subsystem: 'tiling', description: 'A tile key.', holds: 'string' }],
  };
}

interface StudioOptions {
  /** How the tile cache's load_tile names the key type. */
  keyType?: string;
  /** The tile cache takes load_tile's signature from GeoKit's extension point instead of stating it. */
  signatureFrom?: boolean;
  /** The external declaration (default: geo at ../geo). */
  externals?: Record<string, unknown>;
  /** What the renderer depends on (default geo::tile-library). */
  rendererTarget?: string;
}

/** TileStudio: a TypeScript map editor calling GeoKit and implementing its tile source. */
function tileStudio(o: StudioOptions = {}): FixtureTree {
  const target = o.rendererTarget ?? 'geo::tile-library';
  return {
    system: { name: 'TileStudio', vision: 'A map editor that renders tiles computed by GeoKit.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'editor', description: 'The map editing canvas.' }],
    components: [
      { id: 'map-renderer', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Works out which tiles the map needs.', dependsOn: [target] },
      { id: 'tile-cache', componentType: 'Adapter', description: 'Serves GeoKit tiles from a local cache.' },
    ],
    interfaces: [
      { id: 'imap_renderer', component: 'map-renderer', methods: [{ name: 'visibleTile', description: 'The tile the map centre needs.', params: [{ name: 'zoom', type: 'int' }], returns: 'string' }] },
      {
        id: 'itile_cache', component: 'tile-cache', implements: 'geo::tile-source',
        methods: [o.signatureFrom
          ? { name: 'load_tile', description: 'Load one tile from the cache.', signatureFrom: 'geo::tile-source.load_tile' }
          : { name: 'load_tile', description: 'Load one tile from the cache.', params: [{ name: 'key', type: o.keyType ?? 'geo::tile-key' }], returns: 'bytes' }],
        lint: { allow: [{ code: 'NAMING_CONVENTION_VIOLATION', reason: 'The extension point dictates the snake_case name.' }] },
      },
    ],
    implementations: [{
      id: 'map_renderer_impl', contract: 'imap_renderer',
      methods: [{ name: 'visibleTile', narrative: [
        { stepNumber: 1, type: 'call', description: 'Ask GeoKit for the tile key.', targetComponent: target, targetMethod: 'tile_for' },
        { stepNumber: 2, type: 'return', description: 'Answer it.', outcome: 'the tile key' },
      ] }],
    }],
  };
}


/** TileStudio with GeoKit as an external at ../geo (pinned), or as a contained member at libs/geo. */
function studioWith(relation: 'external' | 'member'): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r7sig-')));
  roots.push(root);
  const studio = path.join(root, 'studio');
  const geo = relation === 'external' ? path.join(root, 'geo') : path.join(studio, 'libs', 'geo');
  fs.mkdirSync(geo, { recursive: true });
  materializeFixtureProject(geo, geoKit());
  fs.writeFileSync(path.join(geo, '.wai', 'project.yaml'), configYaml('geo'));
  fs.mkdirSync(studio, { recursive: true });
  materializeFixtureProject(studio, tileStudio({ signatureFrom: true }));
  fs.writeFileSync(path.join(studio, '.wai', 'project.yaml'), configYaml('studio', relation === 'external'
    ? { externals: { geo: { source: { path: '../geo' } } } }
    : { members: { geo: 'libs/geo' } }));
  setProjectRoot(studio);
  invalidateSpecCache();
  if (relation === 'external') {
    pinExternals();
    setProjectRoot(studio);
    invalidateSpecCache();
  }
  return studio;
}

const codes = (issues: ValidationIssue[], code: string): ValidationIssue[] => issues.filter((i) => i.code === code);

describe("a signature taken from another project's extension point needs no dependsOn, whatever the relation (round 7, R7-10)", () => {
  for (const relation of ['external', 'member'] as const) {
    it(`as ${relation === 'external' ? 'a declared external' : 'a contained member'}: no SIGNATURE_SOURCE_OFF_EDGE`, () => {
      studioWith(relation);
      const issues = validateProject({}).issues;
      expect(codes(issues, 'SIGNATURE_SOURCE_OFF_EDGE'), JSON.stringify(codes(issues, 'SIGNATURE_SOURCE_OFF_EDGE'))).toEqual([]);
      expect(codes(issues, 'SIGNATURE_SOURCE_UNRESOLVED')).toEqual([]);
    });
  }
});
