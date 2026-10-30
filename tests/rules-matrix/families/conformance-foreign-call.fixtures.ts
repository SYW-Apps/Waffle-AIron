/**
 * A claimed call into ANOTHER project's component (`alias::name`) —
 * src/core/rules/conformance/call-conformance.ts.
 *
 * Documented intent pinned here (rule description):
 *  - CALL_TARGET_UNJUDGED (notice): a narrative call step or declared call
 *    whose target is another project's component is not judged against that
 *    project's code, whether or not the code exists. It is said once per
 *    method naming the project, and never as CALL_TARGET_PLANNED (which is
 *    for a component of this project whose code is not written yet) nor as an
 *    unrealized call.
 *
 * The scenario: TileStudio, a map editor, asks the GeoKit tile library
 * (a member project) for the tile under the centre of the view.
 */
import * as yaml from 'js-yaml';
import { BASE_FIXTURE_RULES, defineRuleFixture, type FixtureTree } from '../harness.js';
import { WAIRON_MAJOR } from '../../../src/config/defaults.js';

const TS = '2026-01-01T00:00:00.000Z';

function dump(spec: Record<string, unknown>): string {
  return yaml.dump({ schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS, ...spec }, { noRefs: true, lineWidth: 200 });
}

/** GeoKit as a member project under packages/geokit: one in-process Portal with a tile verb. */
function geokitMember(): Record<string, string> {
  const base = 'packages/geokit/.wai';
  return {
    [`${base}/project.yaml`]: dump({ waironMajor: WAIRON_MAJOR, id: 'geokit', name: 'GeoKit', targets: [], extensions: { packs: [], useGlobalPacks: false } }),
    [`${base}/specs/.index.yaml`]: dump({
      name: 'GeoKit', vision: 'Tile arithmetic for map applications.', targetLanguage: 'typescript',
      publicInterfaces: [{ from: 'tiles', component: 'tile-library', as: 'tiles', audience: 'project' }],
    }),
    [`${base}/specs/subsystems/tiles.yaml`]: dump({
      id: 'tiles', name: 'Tiles', description: 'Tile arithmetic.', parentSystem: 'GeoKit',
      publicInterfaces: [{ component: 'tile-library', details: 'Pure tile arithmetic.' }],
    }),
    [`${base}/specs/components/tile-library.yaml`]: dump({
      id: 'tile-library', name: 'Tile Library', description: 'Pure tile arithmetic, linked in-process.', subsystem: 'tiles',
      componentType: 'Portal', transport: 'InProcess', owns: [], dependsOn: [],
    }),
    [`${base}/specs/interfaces/itile-library.yaml`]: dump({
      id: 'itile-library', name: 'Tile Library Interface', description: 'Tile arithmetic.', component: 'tile-library',
      methods: [{
        name: 'tileAt', description: 'The tile covering a coordinate.', returns: 'string', effect: 'none',
        params: [{ name: 'lat', type: 'float' }, { name: 'lon', type: 'float' }],
      }],
    }),
  };
}

/** TileStudio calling the pinned GeoKit tile verb, or (a control) a step that calls nothing, its function written as given. */
export function foreignCallTree(opts: { calls: boolean; language?: 'typescript' | 'python'; body?: string } = { calls: true }): FixtureTree {
  const python = opts.language === 'python';
  const file = python ? 'src/editor/map_renderer.py' : 'src/editor/map-renderer.ts';
  const verb = python ? 'centre_tile' : 'centreTile';
  return {
    system: { name: 'TileStudio', vision: 'A map editor that renders the tiles the GeoKit library computes.', targetLanguage: python ? 'python' : 'typescript' },
    subsystems: [{ id: 'editor', description: 'The map editing canvas and its rendering.' }],
    components: [{
      id: 'map-renderer', componentType: 'Orchestrator', dependencyClass: 'pure',
      description: 'Works out which tile the visible map needs.', dependsOn: ['geokit::tiles'],
    }],
    interfaces: [{
      id: 'imap_renderer', component: 'map-renderer',
      methods: [{ name: verb, description: 'The tile under the centre of the view.', params: [{ name: 'lat', type: 'float' }, { name: 'lon', type: 'float' }], returns: 'string' }],
    }],
    implementations: [{
      id: 'map_renderer_impl', contract: 'imap_renderer', sourcePath: file,
      methods: [{
        name: verb,
        narrative: [
          opts.calls
            ? { stepNumber: 1, type: 'call', description: 'Ask GeoKit for the tile covering the centre of the view.', targetComponent: 'geokit::tiles', targetMethod: 'tileAt' }
            : { stepNumber: 1, type: 'local', description: 'Work out the tile from the coordinates alone.' },
          { stepNumber: 2, type: 'return', description: 'Answer the tile as its key text.', outcome: 'the centre tile' },
        ],
      }],
    }],
    files: {
      '.wai/project.yaml': yaml.dump({
        schemaVersion: '1.0.0', waironMajor: WAIRON_MAJOR, id: 'tile-studio', name: 'tile-studio', targets: [], rules: BASE_FIXTURE_RULES,
        extensions: { packs: [], useGlobalPacks: false }, members: { geokit: 'packages/geokit' }, createdAt: TS, updatedAt: TS,
      }, { noRefs: true, lineWidth: 200 }),
      ...geokitMember(),
      [file]: opts.body ?? (python
        ? 'def centre_tile(lat: float, lon: float) -> str:\n    return f"{lat},{lon}"\n'
        : 'export function centreTile(lat: number, lon: number): string {\n  return `${lat},${lon}`;\n}\n'),
    },
  };
}

export default [
  defineRuleFixture({
    code: 'CALL_TARGET_UNJUDGED',
    expectFire: true,
    severity: 'notice',
    anchoredTo: 'map_renderer_impl',
    scenario: 'The map renderer narrates a call to GeoKit\'s tile library, another project\'s component, and its function does not make it.',
    tree: foreignCallTree({ calls: true }),
  }),
  defineRuleFixture({
    code: 'CALL_TARGET_UNJUDGED',
    expectFire: false,
    reason: 'The narrative calls no component of another project: nothing here names a project whose code this gate does not read.',
    scenario: 'The map renderer works out the centre tile from its coordinates alone.',
    tree: foreignCallTree({ calls: false }),
  }),
];
