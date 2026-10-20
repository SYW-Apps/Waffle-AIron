/**
 * Member names (src/core/rules/integrity/member-names.ts) and HTTP path
 * placeholders (portalsRule in src/core/rules/doctrine/portal-endpoints.ts),
 * round 5.
 *
 * Documented intents pinned here:
 *  - DUPLICATE_MEMBER_NAME (error): two methods of one contract, two
 *    parameters of one method or two fields of one type share a name; a lookup
 *    by name would bind one of them at random.
 *  - RESERVED_IDENTIFIER (error): a method, parameter or field name the spec's
 *    target language reserves for that kind of identifier and cannot escape —
 *    Rust refuses crate, self, Self and super, TypeScript a keyword as a
 *    parameter.
 *  - RESERVED_IDENTIFIER_ESCAPED (notice): the same, in a language that spells
 *    the word as an ordinary identifier (Rust r#type, C# @class).
 *  - ENDPOINT_PATH_PLACEHOLDER (error): an HTTP path's `{name}` placeholders
 *    bind the method's parameters: each closed, once, naming a parameter.
 */
import { defineRuleFixture } from '../harness.js';

const RUST = { name: 'GeoSdk', vision: 'A geospatial library: distances, tiles and geocoding for Rust applications.', targetLanguage: 'rust' };
const TS = { name: 'RouteApp', vision: 'A route planner that plans and stores delivery routes.', targetLanguage: 'typescript' };

export default [
  // -------------------------------------------------------------------------
  // DUPLICATE_MEMBER_NAME
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'DUPLICATE_MEMBER_NAME',
    severity: 'error',
    anchoredTo: 'idistance_calculator',
    expectFire: true,
    scenario: 'A hand edit pasted the haversine method twice into the distance calculator contract, so a call to it could bind either one.',
    tree: {
      system: RUST,
      subsystems: [{ id: 'distance', description: 'Great-circle distances.' }],
      components: [{ id: 'distance_calculator', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Computes distances.' }],
      interfaces: [{
        id: 'idistance_calculator', component: 'distance_calculator', methods: [
          { name: 'haversine', description: 'Great-circle distance.', params: [{ name: 'from_point', type: 'string' }], returns: 'float' },
          { name: 'haversine', description: 'Great-circle distance, pasted again.', params: [{ name: 'from_point', type: 'string' }], returns: 'float' },
        ],
      }],
    },
  }),
  defineRuleFixture({
    code: 'DUPLICATE_MEMBER_NAME',
    expectFire: false,
    reason: 'Every method of the contract, and every parameter of each method, has its own name.',
    scenario: 'The distance calculator contract declares haversine and vincenty, each taking a start and an end point.',
    tree: {
      system: RUST,
      subsystems: [{ id: 'distance', description: 'Great-circle distances.' }],
      components: [{ id: 'distance_calculator', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Computes distances.' }],
      interfaces: [{
        id: 'idistance_calculator', component: 'distance_calculator', methods: [
          { name: 'haversine', description: 'Great-circle distance.', params: [{ name: 'from_point', type: 'string' }, { name: 'to_point', type: 'string' }], returns: 'float' },
          { name: 'vincenty', description: 'Ellipsoidal distance.', params: [{ name: 'from_point', type: 'string' }, { name: 'to_point', type: 'string' }], returns: 'float' },
        ],
      }],
    },
  }),

  // -------------------------------------------------------------------------
  // RESERVED_IDENTIFIER
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'RESERVED_IDENTIFIER',
    severity: 'error',
    anchoredTo: 'itile_calculator',
    expectFire: true,
    scenario: 'In the Rust SDK the tile calculator takes a parameter named `self` — a Rust keyword that no raw identifier can spell, so the brief would ask for `fn tile_at(self: ...)`, which means something else entirely.',
    tree: {
      system: RUST,
      subsystems: [{ id: 'tiles', description: 'Map tiles.' }],
      components: [{ id: 'tile_calculator', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Computes tile coordinates.' }],
      interfaces: [{
        id: 'itile_calculator', component: 'tile_calculator', methods: [
          { name: 'tile_at', description: 'The tile holding a point.', params: [{ name: 'self', type: 'string' }], returns: 'string' },
        ],
      }],
    },
  }),
  defineRuleFixture({
    code: 'RESERVED_IDENTIFIER',
    expectFire: false,
    reason: 'A Rust `type` parameter is spelled r#type in code: RESERVED_IDENTIFIER_ESCAPED notices it instead.',
    scenario: 'The Rust tile calculator takes a parameter named `type`, which the code spells r#type.',
    tree: {
      system: RUST,
      subsystems: [{ id: 'tiles', description: 'Map tiles.' }],
      components: [{ id: 'tile_calculator', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Computes tile coordinates.' }],
      interfaces: [{
        id: 'itile_calculator', component: 'tile_calculator', methods: [
          { name: 'tile_at', description: 'The tile holding a point.', params: [{ name: 'type', type: 'string' }], returns: 'string' },
        ],
      }],
    },
  }),
  defineRuleFixture({
    code: 'RESERVED_IDENTIFIER',
    expectFire: false,
    reason: 'TypeScript allows a keyword as a method name (`router.delete()`); only a parameter, or a method named constructor, is refused.',
    scenario: 'The TypeScript route store exposes a method named `delete`, which a TypeScript class method may be called.',
    tree: {
      system: TS,
      subsystems: [{ id: 'routing', description: 'Route planning.' }],
      components: [{ id: 'route_store', componentType: 'Store', durability: 'ram-projection', description: 'Holds planned routes.' }],
      interfaces: [{
        id: 'iroute_store', component: 'route_store', methods: [
          { name: 'delete', description: 'Remove a route.', params: [{ name: 'routeId', type: 'string' }], returns: 'void', effect: 'lifecycle' },
        ],
      }],
    },
  }),

  // -------------------------------------------------------------------------
  // RESERVED_IDENTIFIER_ESCAPED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'RESERVED_IDENTIFIER_ESCAPED',
    severity: 'notice',
    anchoredTo: 'itile_calculator',
    expectFire: true,
    scenario: 'In the Rust SDK the tile calculator takes a parameter named `type`, a wire name the code spells r#type.',
    tree: {
      system: RUST,
      subsystems: [{ id: 'tiles', description: 'Map tiles.' }],
      components: [{ id: 'tile_calculator', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Computes tile coordinates.' }],
      interfaces: [{
        id: 'itile_calculator', component: 'tile_calculator', methods: [
          { name: 'tile_at', description: 'The tile holding a point.', params: [{ name: 'type', type: 'string' }], returns: 'string' },
        ],
      }],
    },
  }),
  defineRuleFixture({
    code: 'RESERVED_IDENTIFIER_ESCAPED',
    expectFire: false,
    reason: 'Rust cannot escape self, so it is the RESERVED_IDENTIFIER error, not a notice.',
    scenario: 'The Rust tile calculator takes a parameter named `self`.',
    tree: {
      system: RUST,
      subsystems: [{ id: 'tiles', description: 'Map tiles.' }],
      components: [{ id: 'tile_calculator', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Computes tile coordinates.' }],
      interfaces: [{
        id: 'itile_calculator', component: 'tile_calculator', methods: [
          { name: 'tile_at', description: 'The tile holding a point.', params: [{ name: 'self', type: 'string' }], returns: 'string' },
        ],
      }],
    },
  }),

  // -------------------------------------------------------------------------
  // ENDPOINT_PATH_PLACEHOLDER
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ENDPOINT_PATH_PLACEHOLDER',
    severity: 'error',
    anchoredTo: 'iroute_portal',
    expectFire: true,
    scenario: 'The route portal binds GET /routes/{routeId}/{routeId} — the same placeholder twice — and GET /routes/:id/legs/:id — the Express spelling, the same placeholders — whose :id names no parameter of getLegs, twice.',
    tree: {
      system: TS,
      subsystems: [{ id: 'routing', description: 'Route planning.' }],
      components: [{ id: 'route_portal', componentType: 'Portal', transport: 'HTTP', invokedBy: { kind: 'entry', caller: 'Browsers of the dispatch office, over HTTP' }, description: 'The route API.' }],
      interfaces: [{
        id: 'iroute_portal', component: 'route_portal', methods: [
          { name: 'getRoute', description: 'Read a route.', params: [{ name: 'routeId', type: 'string' }], returns: 'string', endpoint: { transport: 'HTTP', method: 'GET', path: '/routes/{routeId}/{routeId}' } },
          { name: 'getLegs', description: 'Read its legs.', params: [{ name: 'routeId', type: 'string' }], returns: 'string', endpoint: { transport: 'HTTP', method: 'GET', path: '/routes/:id/legs/:id' } },
        ],
      }],
    },
  }),
  defineRuleFixture({
    code: 'ENDPOINT_PATH_PLACEHOLDER',
    severity: 'error',
    anchoredTo: 'iroute_portal',
    expectFire: true,
    scenario: 'The route portal binds GET /routes/:id in the Express spelling, but getRoute takes routeId: the :id segment binds nothing.',
    tree: {
      system: TS,
      subsystems: [{ id: 'routing', description: 'Route planning.' }],
      components: [{ id: 'route_portal', componentType: 'Portal', transport: 'HTTP', invokedBy: { kind: 'entry', caller: 'Browsers of the dispatch office, over HTTP' }, description: 'The route API.' }],
      interfaces: [{
        id: 'iroute_portal', component: 'route_portal', methods: [
          { name: 'getRoute', description: 'Read a route.', params: [{ name: 'routeId', type: 'string' }], returns: 'string', endpoint: { transport: 'HTTP', method: 'GET', path: '/routes/:id' } },
        ],
      }],
    },
  }),
  defineRuleFixture({
    code: 'ENDPOINT_PATH_PLACEHOLDER',
    expectFire: false,
    reason: 'Each placeholder is closed, appears once and names a parameter of its method.',
    scenario: 'The route portal binds GET /routes/{routeId} and GET /routes/:routeId/legs/:leg (either spelling).',
    tree: {
      system: TS,
      subsystems: [{ id: 'routing', description: 'Route planning.' }],
      components: [{ id: 'route_portal', componentType: 'Portal', transport: 'HTTP', invokedBy: { kind: 'entry', caller: 'Browsers of the dispatch office, over HTTP' }, description: 'The route API.' }],
      interfaces: [{
        id: 'iroute_portal', component: 'route_portal', methods: [
          { name: 'getRoute', description: 'Read a route.', params: [{ name: 'routeId', type: 'string' }], returns: 'string', endpoint: { transport: 'HTTP', method: 'GET', path: '/routes/{routeId}' } },
          { name: 'getLeg', description: 'Read one leg.', params: [{ name: 'routeId', type: 'string' }, { name: 'leg', type: 'int' }], returns: 'string', endpoint: { transport: 'HTTP', method: 'GET', path: '/routes/:routeId/legs/:leg' } },
        ],
      }],
    },
  }),
];
