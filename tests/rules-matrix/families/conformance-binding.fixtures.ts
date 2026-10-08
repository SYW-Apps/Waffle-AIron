/**
 * Code↔pin for a consumer's hand-written binding module —
 * src/core/rules/conformance/binding-modules.ts.
 *
 * Documented intents pinned here (rule description):
 *  - BINDING_DRIFT (warning): a binding module an implementation names
 *    (implementation_spec.bindings) declares a producer name its pin renamed
 *    (with the rename to follow) or no longer exports, a parameter list that
 *    differs from the pinned method's, or fields that differ from the pinned
 *    type's.
 *  - BINDING_UNREAD (notice): a named binding module cannot be compared with a
 *    pin — here it is not on disk yet (planned).
 *  - A member project is compared live: its L0 export table as it stands, a
 *    parameter's and a field's rename traces giving the rename to follow.
 *
 * The scenario: TileStudio, a TypeScript map editor, calls GeoKit's tile
 * library through a hand-written binding. GeoKit renamed `tileFor` to `tileAt`
 * and the tile key's `zoom` field to `z`; TileStudio re-pinned.
 */
import * as yaml from 'js-yaml';
import { BASE_FIXTURE_RULES, defineRuleFixture, type FixtureTree } from '../harness.js';

const TS = '2026-01-01T00:00:00.000Z';

/** GeoKit's pinned snapshot after its rename release. */
const GEOKIT_PIN = yaml.dump({
  projectName: 'GeoKit', projectId: 'geokit', origin: 'generated', generatedAt: TS, targetLanguage: 'rust',
  interfaces: [{
    id: 'tiles', name: 'Tile Library', component: 'tile-library', audience: 'external', type: 'Custom', componentType: 'Portal',
    transport: 'InProcess', abi: 'c', details: 'Pure tile arithmetic.',
    methods: [{
      name: 'tileAt', description: 'The tile covering a coordinate at a zoom level.', signature: 'tileAt(lat: float, lon: float, zoom: int): tile_key',
      returns: 'tile_key', params: [{ name: 'lat', type: 'float' }, { name: 'lon', type: 'float' }, { name: 'zoom', type: 'int' }], effect: 'none',
      formerly: ['tileFor'],
    }],
  }],
  types: [{
    id: 'tile_key', name: 'TileKey', kind: 'value-object',
    fields: [{ name: 'x', type: 'int' }, { name: 'y', type: 'int' }, { name: 'z', type: 'int', formerly: ['zoom'] }],
  }],
}, { noRefs: true, lineWidth: 200 });

/** The binding module as TileStudio's developer wrote it, with the verb and the zoom field named as given. */
function binding(verb: string, zoomField: string): string {
  return [
    '// Typed binding for the GeoKit native addon; names are GeoKit\'s own.',
    'export interface TileKey {',
    '  x: number;',
    '  y: number;',
    `  ${zoomField}: number;`,
    '}',
    '',
    '/** geokit::tiles */',
    'export interface TileLibrary {',
    `  ${verb}(lat: number, lon: number, zoom: number): TileKey;`,
    '}',
    '',
  ].join('\n');
}

function tileStudio(bindingSource: string | null): FixtureTree {
  return {
    system: { name: 'TileStudio', vision: 'A map editor that renders the tiles the GeoKit library computes.', targetLanguage: 'typescript' },
    subsystems: [{ id: 'editor', description: 'The map editing canvas and its rendering.' }],
    components: [{
      id: 'map-renderer', componentType: 'Orchestrator', dependencyClass: 'pure',
      description: 'Works out which tile the visible map needs.', dependsOn: ['geokit::tiles'],
    }],
    interfaces: [{
      id: 'imap_renderer', component: 'map-renderer',
      methods: [{ name: 'centreTile', description: 'The tile under the centre of the view.', params: [{ name: 'lat', type: 'float' }, { name: 'lon', type: 'float' }], returns: 'string' }],
    }],
    implementations: [{
      id: 'map_renderer_impl', contract: 'imap_renderer', sourcePath: 'src/editor/map-renderer.ts',
      bindings: ['src/editor/geokit-binding.ts'],
      methods: [{
        name: 'centreTile',
        narrative: [
          { stepNumber: 1, type: 'call', description: 'Ask GeoKit for the tile covering the centre of the view.', targetComponent: 'geokit::tiles', targetMethod: 'tileAt' },
          { stepNumber: 2, type: 'return', description: 'Answer the tile as its key text.', outcome: 'the centre tile' },
        ],
      }],
    }],
    files: {
      '.wai/project.yaml': yaml.dump({
        schemaVersion: '1.0.0', name: 'tile-studio', targets: [], rules: BASE_FIXTURE_RULES,
        extensions: { packs: [], useGlobalPacks: false }, externals: { geokit: {} }, createdAt: TS, updatedAt: TS,
      }, { noRefs: true, lineWidth: 200 }),
      '.wai/externals.lock.yaml': yaml.dump({ externals: { geokit: { project: 'geokit', snapshot: '.wai/externals/geokit.yaml', digest: 'sha256:pinned', used: {} } } }),
      '.wai/externals/geokit.yaml': GEOKIT_PIN,
      ...(bindingSource !== null ? { 'src/editor/geokit-binding.ts': bindingSource } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// The same binding into a MEMBER project: GeoKit is TileStudio's member, read
// live and never pinned. GeoKit renamed the tile verb's `zoom` parameter and
// the tile key's `zoom` field to `z` (rename-param / rename-field, so both
// carry the trace). TileStudio's binding is compared with what GeoKit's L0
// exports now.
// ---------------------------------------------------------------------------

function memberDump(spec: Record<string, unknown>): string {
  return yaml.dump({ schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS, ...spec }, { noRefs: true, lineWidth: 200 });
}

/** GeoKit as a member project under packages/geokit, after its renames. */
function geokitMember(): Record<string, string> {
  const base = 'packages/geokit/.wai';
  return {
    [`${base}/project.yaml`]: memberDump({ id: 'geokit', name: 'GeoKit', targets: [], extensions: { packs: [], useGlobalPacks: false } }),
    [`${base}/specs/.index.yaml`]: memberDump({
      name: 'GeoKit', vision: 'Tile arithmetic for map applications.', targetLanguage: 'typescript',
      publicInterfaces: [
        { from: 'tiles', component: 'tile-library', as: 'tiles', audience: 'project' },
        { from: 'tiles', typeDef: 'tile_key', as: 'tile_key', audience: 'project' },
      ],
    }),
    [`${base}/specs/subsystems/tiles.yaml`]: memberDump({
      id: 'tiles', name: 'Tiles', description: 'Tile arithmetic.', parentSystem: 'GeoKit',
      publicInterfaces: [{ component: 'tile-library', details: 'Pure tile arithmetic.' }, { typeDef: 'tile_key' }],
    }),
    [`${base}/specs/components/tile-library.yaml`]: memberDump({
      id: 'tile-library', name: 'Tile Library', description: 'Pure tile arithmetic, linked in-process.', subsystem: 'tiles',
      componentType: 'Portal', transport: 'InProcess', owns: [], dependsOn: [],
    }),
    [`${base}/specs/interfaces/itile-library.yaml`]: memberDump({
      id: 'itile-library', name: 'Tile Library Interface', description: 'Tile arithmetic.', component: 'tile-library',
      methods: [{
        name: 'tileAt', description: 'The tile covering a coordinate at a zoom level.', returns: 'tile_key', effect: 'none',
        params: [{ name: 'lat', type: 'float' }, { name: 'lon', type: 'float' }, { name: 'z', type: 'int', previousNames: ['zoom'] }],
      }],
    }),
    [`${base}/specs/types/tile_key.yaml`]: memberDump({
      id: 'tile_key', name: 'TileKey', kind: 'value-object', subsystem: 'tiles', description: 'One tile.', methods: [],
      fields: [{ name: 'x', type: 'int' }, { name: 'y', type: 'int' }, { name: 'z', type: 'int', previousNames: ['zoom'] }],
    }),
  };
}

/** TileStudio's binding into its GeoKit member, the zoom parameter and field named as given. */
function memberBinding(zoom: string): string {
  return [
    '// Typed binding for the GeoKit library; names are GeoKit\'s own.',
    'export interface TileKey {',
    '  x: number;',
    '  y: number;',
    `  ${zoom}: number;`,
    '}',
    '',
    '/** geokit::tiles */',
    'export interface TileLibrary {',
    `  tileAt(lat: number, lon: number, ${zoom}: number): TileKey;`,
    '}',
    '',
  ].join('\n');
}

function tileStudioWithMember(bindingSource: string): FixtureTree {
  const tree = tileStudio(bindingSource);
  const files = { ...tree.files! };
  delete files['.wai/externals.lock.yaml'];
  delete files['.wai/externals/geokit.yaml'];
  files['.wai/project.yaml'] = yaml.dump({
    schemaVersion: '1.0.0', id: 'tile-studio', name: 'tile-studio', targets: [], rules: BASE_FIXTURE_RULES,
    extensions: { packs: [], useGlobalPacks: false }, members: { geokit: 'packages/geokit' }, createdAt: TS, updatedAt: TS,
  }, { noRefs: true, lineWidth: 200 });
  return { ...tree, files: { ...files, ...geokitMember() } };
}


export default [
  defineRuleFixture({
    code: 'BINDING_DRIFT',
    severity: 'warning',
    anchoredTo: 'map_renderer_impl',
    expectFire: true,
    scenario: 'After re-pinning GeoKit\'s rename release, TileStudio\'s hand-written binding still declares `tileFor` and a tile key with `zoom`, so the renderer keeps compiling against names the library no longer has.',
    tree: tileStudio(binding('tileFor', 'zoom')),
  }),
  defineRuleFixture({
    code: 'BINDING_DRIFT',
    expectFire: false,
    reason: 'The binding spells GeoKit\'s pinned names — `tileAt` and the tile key\'s `z` — so it agrees with the pin.',
    scenario: 'TileStudio followed GeoKit\'s renames in its binding module after re-pinning.',
    tree: tileStudio(binding('tileAt', 'z')),
  }),
  defineRuleFixture({
    code: 'BINDING_UNREAD',
    severity: 'notice',
    anchoredTo: 'map_renderer_impl',
    expectFire: true,
    scenario: 'The renderer\'s implementation names its GeoKit binding module at design time, before anyone has written it.',
    tree: tileStudio(null),
  }),
  defineRuleFixture({
    code: 'BINDING_UNREAD',
    expectFire: false,
    reason: 'The binding module exists and the renderer reaches the pinned GeoKit, so it is compared rather than reported unread.',
    scenario: 'TileStudio\'s binding module is written and GeoKit is pinned.',
    tree: tileStudio(binding('tileAt', 'z')),
  }),
  defineRuleFixture({
    code: 'BINDING_DRIFT',
    severity: 'warning',
    anchoredTo: 'map_renderer_impl',
    expectFire: true,
    scenario: 'GeoKit, a member of TileStudio, renamed its tile verb\'s `zoom` parameter and the tile key\'s `zoom` field to `z`; nothing is pinned for a member, and TileStudio\'s binding still spells `zoom` in both.',
    tree: tileStudioWithMember(memberBinding('zoom')),
  }),
  defineRuleFixture({
    code: 'BINDING_DRIFT',
    expectFire: false,
    reason: 'The binding spells GeoKit\'s current names — the verb\'s `z` parameter and the tile key\'s `z` field — as its member exports them now.',
    scenario: 'TileStudio followed its GeoKit member\'s renames in its binding module.',
    tree: tileStudioWithMember(memberBinding('z')),
  }),
];
