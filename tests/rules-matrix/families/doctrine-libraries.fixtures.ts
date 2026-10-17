/**
 * Library fixtures — an InProcess Portal of another project, called directly
 * (docs/design/reachability.md §2.6, §2.7). The rules pinned here:
 *
 *  - library-calls (src/core/rules/doctrine/library-calls.ts):
 *    LIBRARY_CALL_IMPURE (pure or read logic calls a library verb whose
 *    declared effect it may not reach) and LANGUAGE_BRIDGE_MISSING (a native
 *    library, no abi, called from a project of another targetLanguage).
 *  - subsystem-boundary-dependencies: a library call needs no client Adapter,
 *    so CROSS_SUBSYSTEM_NON_ADAPTER stays quiet for it.
 *  - implements-contracts (src/core/rules/integrity/implements-contracts.ts):
 *    IMPLEMENTS_MISMATCH — a contract realizing an exported extension point
 *    declares its every method with the same signature.
 *  - portal-endpoints: an InProcess Portal binds no endpoint (its verbs are
 *    its contract methods), so MISSING_ENDPOINT stays quiet for it.
 *  - export-tables: EXPORT_UNCONSUMABLE is role-aware — an Adapter may back an
 *    extension point consumers implement, never an entry they call.
 *  - naming-conventions: method casing follows the target language.
 *
 * The scenario: TileStudio, a TypeScript map editor, uses GeoKit, a Rust
 * tiling library it declares as an external and has pinned.
 */
import * as yaml from 'js-yaml';
import { BASE_FIXTURE_RULES, defineRuleFixture, type FixtureTree } from '../harness.js';

const TS = '2026-01-01T00:00:00.000Z';

interface GeoKitOptions {
  /** The language the TileStudio project is written in. */
  studioLanguage?: string;
  /** GeoKit's tile library abi, when it declares one. */
  abi?: string;
  /** The verb the map renderer calls, and the renderer's dependencyClass. */
  calls?: string;
  dependencyClass?: 'pure' | 'read';
  /** What the map renderer is (an Orchestrator by default). */
  rendererType?: string;
  /** The tile cache contract TileStudio writes for GeoKit's tile-source extension point. */
  tileSourceLoad?: { params: { name: string; type: string }[]; returns: string };
}

/** GeoKit's pinned snapshot: a tile library (InProcess) and a tile-source extension point. */
function geoKitSnapshot(o: GeoKitOptions): string {
  return yaml.dump({
    projectName: 'GeoKit', projectId: 'geokit', origin: 'generated', generatedAt: TS, types: [], targetLanguage: 'rust',
    interfaces: [
      {
        id: 'tiles', name: 'Tile Library', component: 'tile-library', audience: 'external', type: 'Custom', componentType: 'Portal',
        transport: 'InProcess', ...(o.abi ? { abi: o.abi } : {}), details: 'Pure tile arithmetic and tile fetching.',
        methods: [
          { name: 'tileFor', description: 'The tile key covering a coordinate at a zoom level.', signature: 'tileFor(lat: float, lon: float, zoom: int): string', returns: 'string', params: [{ name: 'lat', type: 'float' }, { name: 'lon', type: 'float' }, { name: 'zoom', type: 'int' }], effect: 'none' },
          { name: 'fetchTile', description: 'Download a tile image from the tile server.', signature: 'fetchTile(key: string): bytes', returns: 'bytes', params: [{ name: 'key', type: 'string' }], effect: 'io' },
        ],
      },
      {
        id: 'tile-source', name: 'Tile Source', component: 'tile-source-port', audience: 'external', type: 'Custom', componentType: 'Adapter',
        role: 'implement', details: 'Where GeoKit loads tiles from: implemented by the application.',
        methods: [
          { name: 'loadTile', description: 'Load one tile by its key.', signature: 'loadTile(key: string): bytes', returns: 'bytes', params: [{ name: 'key', type: 'string' }] },
        ],
      },
    ],
  }, { noRefs: true, lineWidth: 200 });
}

/** TileStudio: a map renderer calling GeoKit's tile library, and a tile cache implementing GeoKit's tile source. */
function tileStudio(o: GeoKitOptions = {}): FixtureTree {
  const verb = o.calls ?? 'tileFor';
  return {
    system: {
      name: 'TileStudio',
      vision: 'A map editor that renders tiles computed and fetched by the GeoKit tiling library.',
      targetLanguage: o.studioLanguage ?? 'rust',
    },
    subsystems: [{ id: 'editor', description: 'The map editing canvas and its rendering.' }],
    components: [
      {
        id: 'map-renderer',
        componentType: o.rendererType ?? 'Orchestrator',
        ...((o.rendererType ?? 'Orchestrator') === 'Orchestrator' ? { dependencyClass: o.dependencyClass ?? 'pure' } : {}),
        description: 'Works out which tiles the visible map needs.',
        dependsOn: ['geokit::tiles'],
      },
      ...(o.tileSourceLoad ? [{ id: 'tile-cache', componentType: 'Adapter', description: 'Serves GeoKit tiles from the editor\'s local cache.' }] : []),
    ],
    interfaces: [
      {
        id: 'imap_renderer',
        component: 'map-renderer',
        methods: [{ name: 'visible_tiles', description: 'The tile keys the visible map needs.', params: [{ name: 'lat', type: 'float' }, { name: 'lon', type: 'float' }], returns: 'list<string>' }],
      },
      ...(o.tileSourceLoad ? [{
        id: 'itile_cache',
        component: 'tile-cache',
        implements: 'geokit::tile-source',
        methods: [{ name: 'loadTile', description: 'Load one tile from the local cache.', params: o.tileSourceLoad.params, returns: o.tileSourceLoad.returns }],
      }] : []),
    ],
    implementations: [{
      id: 'map_renderer_impl',
      contract: 'imap_renderer',
      methods: [{
        name: 'visible_tiles',
        narrative: [
          { stepNumber: 1, type: 'call', description: 'Ask GeoKit for the tile covering the centre of the view.', targetComponent: 'geokit::tiles', targetMethod: verb },
          { stepNumber: 2, type: 'return', description: 'Answer the tile keys.', outcome: 'the visible tile keys' },
        ],
      }],
    }],
    files: {
      '.wai/project.yaml': yaml.dump({
        schemaVersion: '1.0.0', name: 'tile-studio', targets: [], rules: BASE_FIXTURE_RULES,
        extensions: { packs: [], useGlobalPacks: false }, externals: { geokit: {} }, createdAt: TS, updatedAt: TS,
      }, { noRefs: true, lineWidth: 200 }),
      '.wai/externals.lock.yaml': yaml.dump({ externals: { geokit: { project: 'geokit', snapshot: '.wai/externals/geokit.yaml', digest: 'sha256:pinned', used: {} } } }),
      '.wai/externals/geokit.yaml': geoKitSnapshot(o),
    },
  };
}

export default [
  // -------------------------------------------------------------------------
  // LIBRARY_CALL_IMPURE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'LIBRARY_CALL_IMPURE',
    severity: 'error',
    anchoredTo: 'map_renderer_impl',
    expectFire: true,
    scenario:
      'The pure map renderer calls GeoKit\'s fetchTile, which downloads a tile from the tile server (effect io), so the pure logic would reach outside the process.',
    tree: tileStudio({ calls: 'fetchTile' }),
  }),
  defineRuleFixture({
    code: 'LIBRARY_CALL_IMPURE',
    expectFire: false,
    reason: 'tileFor declares effect none: it computes over its arguments only, the one effect pure logic may call on a library.',
    scenario: 'The pure map renderer calls GeoKit\'s tileFor, which only computes a tile key from a coordinate.',
    tree: tileStudio({ calls: 'tileFor' }),
  }),
  defineRuleFixture({
    code: 'LIBRARY_CALL_IMPURE',
    expectFire: false,
    reason: 'Only pure or read logic has a purity bound; an Adapter, like a workflow, may call a library verb that does I/O.',
    scenario: 'The tile fetcher is an Adapter that downloads tiles through GeoKit\'s fetchTile.',
    tree: tileStudio({ calls: 'fetchTile', rendererType: 'Adapter' }),
  }),

  // -------------------------------------------------------------------------
  // LANGUAGE_BRIDGE_MISSING
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'LANGUAGE_BRIDGE_MISSING',
    severity: 'error',
    anchoredTo: 'map-renderer',
    expectFire: true,
    scenario:
      'TileStudio is written in TypeScript and calls GeoKit\'s tile library directly, but GeoKit is a native Rust crate with no abi, so nothing binds the TypeScript caller to it.',
    tree: tileStudio({ studioLanguage: 'typescript' }),
  }),
  defineRuleFixture({
    code: 'LANGUAGE_BRIDGE_MISSING',
    expectFire: false,
    reason: 'GeoKit declares abi wasm, a WebAssembly component any language can link.',
    scenario: 'TileStudio, in TypeScript, calls GeoKit\'s tile library, which GeoKit ships as a WebAssembly component (abi wasm).',
    tree: tileStudio({ studioLanguage: 'typescript', abi: 'wasm' }),
  }),
  defineRuleFixture({
    code: 'LANGUAGE_BRIDGE_MISSING',
    expectFire: false,
    reason: 'Caller and library are both Rust, so the native crate links directly.',
    scenario: 'TileStudio is itself written in Rust and links GeoKit\'s tile crate natively.',
    tree: tileStudio({ studioLanguage: 'rust' }),
  }),

  // -------------------------------------------------------------------------
  // CROSS_SUBSYSTEM_NON_ADAPTER — a library call needs no client Adapter
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CROSS_SUBSYSTEM_NON_ADAPTER',
    expectFire: false,
    reason: 'GeoKit\'s tiles entry is backed by an InProcess Portal: a library call, which any component makes directly.',
    scenario: 'The map renderer, an Orchestrator, depends directly on GeoKit\'s pinned tile library.',
    tree: tileStudio(),
  }),

  // -------------------------------------------------------------------------
  // IMPLEMENTS_MISMATCH
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'IMPLEMENTS_MISMATCH',
    severity: 'error',
    anchoredTo: 'itile_cache',
    expectFire: true,
    scenario:
      'TileStudio\'s tile cache implements GeoKit\'s tile-source extension point but takes the tile key as an int, where GeoKit calls loadTile with a string key.',
    tree: tileStudio({ tileSourceLoad: { params: [{ name: 'key', type: 'int' }], returns: 'bytes' } }),
  }),
  defineRuleFixture({
    code: 'IMPLEMENTS_MISMATCH',
    expectFire: false,
    reason: 'The tile cache declares loadTile exactly as GeoKit\'s extension point does, so GeoKit can call it.',
    scenario: 'TileStudio\'s tile cache implements GeoKit\'s tile-source extension point with loadTile(key: string): bytes.',
    tree: tileStudio({ tileSourceLoad: { params: [{ name: 'key', type: 'string' }], returns: 'bytes' } }),
  }),

  // -------------------------------------------------------------------------
  // MISSING_ENDPOINT — an InProcess Portal binds none
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MISSING_ENDPOINT',
    expectFire: false,
    reason: 'An InProcess Portal\'s verbs are its contract methods: there is no wire to bind, so no endpoint is required.',
    scenario: 'GeoKit\'s own tile library is an InProcess Portal whose tileFor verb binds no endpoint.',
    tree: {
      system: { name: 'GeoKit', vision: 'A tiling library for map applications.', targetLanguage: 'rust' },
      subsystems: [{ id: 'tiling', description: 'Tile arithmetic.' }],
      components: [{ id: 'tile-library', componentType: 'Portal', transport: 'InProcess', description: 'The crate\'s public tile API.', invokedBy: { kind: 'entry', caller: 'Applications that link the GeoKit crate.' } }],
      interfaces: [{ id: 'itile_library', component: 'tile-library', methods: [{ name: 'tile_for', description: 'The tile key covering a coordinate.', params: [{ name: 'zoom', type: 'int' }], returns: 'string', effect: 'none' }] }],
    },
  }),

  // -------------------------------------------------------------------------
  // EXPORT_UNCONSUMABLE — role-aware
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EXPORT_UNCONSUMABLE',
    expectFire: false,
    reason: 'An extension point consumers implement may be backed by the Adapter holding the port the producer calls.',
    scenario: 'GeoKit exports its tile-source port, an Adapter, with role implement, for applications to supply their own tile store.',
    tree: {
      system: {
        name: 'GeoKit', vision: 'A tiling library for map applications.', targetLanguage: 'rust',
        publicInterfaces: [{ from: 'tiling', component: 'tile-source-port', as: 'tile-source', audience: 'external', role: 'implement' }],
      },
      subsystems: [{ id: 'tiling', description: 'Tile arithmetic.', publicInterfaces: [{ component: 'tile-source-port', details: 'Where tiles are loaded from.', role: 'implement' }] }],
      components: [{ id: 'tile-source-port', componentType: 'Adapter', description: 'The port GeoKit loads tiles through.' }],
    },
  }),
  defineRuleFixture({
    code: 'EXPORT_UNCONSUMABLE',
    severity: 'error',
    expectFire: true,
    scenario: 'GeoKit exports its tile-source port, an Adapter, for applications to CALL — but no caller across the boundary may reach an Adapter.',
    tree: {
      system: {
        name: 'GeoKit', vision: 'A tiling library for map applications.', targetLanguage: 'rust',
        publicInterfaces: [{ from: 'tiling', component: 'tile-source-port', as: 'tile-source', audience: 'external' }],
      },
      subsystems: [{ id: 'tiling', description: 'Tile arithmetic.', publicInterfaces: [{ component: 'tile-source-port', details: 'Where tiles are loaded from.' }] }],
      components: [{ id: 'tile-source-port', componentType: 'Adapter', description: 'The port GeoKit loads tiles through.' }],
    },
  }),

  // -------------------------------------------------------------------------
  // NAMING_CONVENTION_VIOLATION — method casing follows the target language
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'NAMING_CONVENTION_VIOLATION',
    expectFire: false,
    reason: 'GeoKit is a Rust crate: snake_case is its language\'s method convention, with nothing configured.',
    scenario: 'GeoKit\'s tile library, in Rust, names its verb tile_for.',
    tree: {
      system: { name: 'GeoKit', vision: 'A tiling library for map applications.', targetLanguage: 'rust' },
      subsystems: [{ id: 'tiling', description: 'Tile arithmetic.' }],
      components: [{ id: 'tile-planner', description: 'Plans tile coverage.' }],
      interfaces: [{ id: 'itile_planner', component: 'tile-planner', methods: [{ name: 'tile_for', description: 'The tile key covering a coordinate.' }] }],
    },
  }),
  defineRuleFixture({
    code: 'NAMING_CONVENTION_VIOLATION',
    severity: 'warning',
    anchoredTo: 'itile_planner',
    expectFire: true,
    scenario: 'GeoKit\'s TypeScript port names a planner method tile_for, against TypeScript\'s camelCase convention.',
    tree: {
      system: { name: 'GeoKit', vision: 'A tiling library for map applications.', targetLanguage: 'typescript' },
      subsystems: [{ id: 'tiling', description: 'Tile arithmetic.' }],
      components: [{ id: 'tile-planner', description: 'Plans tile coverage.' }],
      interfaces: [{ id: 'itile_planner', component: 'tile-planner', methods: [{ name: 'tile_for', description: 'The tile key covering a coordinate.' }] }],
    },
  }),
];
