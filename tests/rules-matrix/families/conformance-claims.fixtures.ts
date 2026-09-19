/**
 * Claiming code, in both directions — src/core/rules/conformance/
 * type-realization.ts and unclaimed-source.ts.
 *
 * Documented intents pinned here (each rule's description + doc comment, and
 * the TypeSpec/ConformanceRuleConfig docs in src/models/):
 *
 *  - UNREALIZED_TYPE (warning): a type names a sourcePath but its file does
 *    not PUBLISH the declaration. At exact grade that means the exported
 *    names, under the type's `symbol` when the code-level name legitimately
 *    differs; a pure re-export barrel publishes nothing of its own, so a claim
 *    on one is never realized. A type that names no sourcePath claims nothing
 *    and is never reported.
 *  - UNREALIZED_TYPE_METHOD (warning): a pure method of a claimed type is not
 *    a declaration-tier anchor in its own file — the method's sourcePath, else
 *    the type's — under its `symbol`, else its name. The declaration tier (not
 *    the export tier) because a pure method is an interface member, a class
 *    method or a free function, at any nesting depth.
 *  - UNCLAIMED_SOURCE_FILE (warning): a file under a declared source root that
 *    no spec names (no implementation sourcePath, no method sourcePath, no
 *    simPath, no type sourcePath) and that the frozen
 *    `rules.conformance.unclaimed` list does not carry. Declaring no source
 *    root walks nothing and the check stays silent; a proven pure re-export
 *    barrel has nothing to claim and is exempt; an `exclude` path is never
 *    walked at all.
 *  - STALE_UNCLAIMED_ENTRY (warning): an entry of that frozen list that is now
 *    claimed, is a proven barrel, or that the walk no longer finds. The list
 *    is exactly the set that would otherwise fire, so it can only shrink.
 */
import { defineRuleFixture } from '../harness.js';

/** The warehouse implementation module every scenario below links its contract to. */
const PICKING_MODULE = `
export interface PickList { id: string; }
export function schedulePicking(list: PickList): void { void list; }
`;

/** The one spec'd component each tree needs so its implementation has a contract. */
const pickingSpecs = {
  subsystems: [{ id: 'warehouse', description: 'Order picking and dispatch for the regional warehouse.' }],
  components: [{
    id: 'picking-scheduler',
    componentType: 'Orchestrator',
    subsystem: 'warehouse',
    description: 'Schedules pick lists onto the warehouse floor for the next dispatch wave.',
  }],
  interfaces: [{
    id: 'ipicking_scheduler',
    component: 'picking-scheduler',
    methods: [{ name: 'schedulePicking', description: 'Schedule a pick list onto the floor.' }],
  }],
  implementations: [{
    id: 'picking_scheduler_impl',
    contract: 'ipicking_scheduler',
    sourcePath: 'src/warehouse/picking.ts',
    methods: [{
      name: 'schedulePicking',
      narrative: [{ stepNumber: 1, type: 'local', description: 'Place the pick list in the next dispatch wave.' }],
    }],
  }],
};

export default [
  // -------------------------------------------------------------------------
  // UNREALIZED_TYPE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREALIZED_TYPE',
    severity: 'warning',
    anchoredTo: 'shipment-manifest',
    expectFire: true,
    scenario:
      'The shipment manifest entity claims the logistics manifest module, but that module was refactored and now declares a ShipmentDocket instead — the spec still points at code that does not hold the declaration.',
    tree: {
      ...pickingSpecs,
      types: [{
        id: 'shipment-manifest',
        name: 'ShipmentManifest',
        subsystem: 'warehouse',
        sourcePath: 'src/warehouse/manifest.ts',
        fields: [{ name: 'id', type: 'string', key: 'primary' }],
      }],
      files: {
        'src/warehouse/picking.ts': PICKING_MODULE,
        'src/warehouse/manifest.ts': 'export interface ShipmentDocket { id: string; }\n',
      },
    },
  }),
  defineRuleFixture({
    code: 'UNREALIZED_TYPE',
    expectFire: false,
    reason: 'The file exports the declaration under the type\'s own name — the plain sanctioned shape of a claim.',
    scenario:
      'The shipment manifest entity claims the logistics manifest module, which exports the ShipmentManifest interface it describes.',
    tree: {
      ...pickingSpecs,
      types: [{
        id: 'shipment-manifest',
        name: 'ShipmentManifest',
        subsystem: 'warehouse',
        sourcePath: 'src/warehouse/manifest.ts',
        fields: [{ name: 'id', type: 'string', key: 'primary' }],
      }],
      files: {
        'src/warehouse/picking.ts': PICKING_MODULE,
        'src/warehouse/manifest.ts': 'export interface ShipmentManifest { id: string; }\n',
      },
    },
  }),
  defineRuleFixture({
    code: 'UNREALIZED_TYPE',
    expectFire: false,
    reason:
      '`symbol` binds the code-level name when it legitimately differs from the modelled one — the documented way to keep an intent-language type name over a house-style code name.',
    scenario:
      'The shipment manifest entity keeps its domain name in the spec while the code calls the interface ShipmentDocket, bound through the type\'s symbol.',
    tree: {
      ...pickingSpecs,
      types: [{
        id: 'shipment-manifest',
        name: 'ShipmentManifest',
        subsystem: 'warehouse',
        sourcePath: 'src/warehouse/manifest.ts',
        symbol: 'ShipmentDocket',
        fields: [{ name: 'id', type: 'string', key: 'primary' }],
      }],
      files: {
        'src/warehouse/picking.ts': PICKING_MODULE,
        'src/warehouse/manifest.ts': 'export interface ShipmentDocket { id: string; }\n',
      },
    },
  }),
  defineRuleFixture({
    code: 'UNREALIZED_TYPE',
    severity: 'warning',
    anchoredTo: 'shipment-manifest',
    expectFire: true,
    scenario:
      'The shipment manifest entity is pointed at the warehouse barrel, which re-exports the real manifest module — a file that publishes the name without declaring anything of its own.',
    tree: {
      ...pickingSpecs,
      types: [{
        id: 'shipment-manifest',
        name: 'ShipmentManifest',
        subsystem: 'warehouse',
        sourcePath: 'src/warehouse/index.ts',
        fields: [{ name: 'id', type: 'string', key: 'primary' }],
      }],
      files: {
        'src/warehouse/picking.ts': PICKING_MODULE,
        'src/warehouse/manifest.ts': 'export interface ShipmentManifest { id: string; }\n',
        'src/warehouse/index.ts': "export * from './manifest.js';\n",
      },
    },
  }),

  // -------------------------------------------------------------------------
  // UNREALIZED_TYPE_METHOD
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREALIZED_TYPE_METHOD',
    severity: 'warning',
    anchoredTo: 'shipment-manifest',
    expectFire: true,
    scenario:
      'The shipment manifest declares a pure totalWeight method, but the manifest module holds only the interface — the arithmetic was never written.',
    tree: {
      ...pickingSpecs,
      types: [{
        id: 'shipment-manifest',
        name: 'ShipmentManifest',
        subsystem: 'warehouse',
        sourcePath: 'src/warehouse/manifest.ts',
        fields: [{ name: 'id', type: 'string', key: 'primary' }],
        methods: [{ name: 'totalWeight', signature: 'totalWeight(): number', returns: 'number', description: 'The manifest\'s total weight in kilograms.' }],
      }],
      files: {
        'src/warehouse/picking.ts': PICKING_MODULE,
        'src/warehouse/manifest.ts': 'export interface ShipmentManifest { id: string; }\n',
      },
    },
  }),
  defineRuleFixture({
    code: 'UNREALIZED_TYPE_METHOD',
    expectFire: false,
    reason:
      'A pure type method is a free function in a language whose data carries no methods: the method names its own file with `sourcePath` and the code-level name with `symbol`, which is the documented shape.',
    scenario:
      'The shipment manifest\'s totalWeight is realized as the free function manifestTotalWeight in a weighing module, bound by the method\'s own sourcePath and symbol.',
    tree: {
      ...pickingSpecs,
      types: [{
        id: 'shipment-manifest',
        name: 'ShipmentManifest',
        subsystem: 'warehouse',
        sourcePath: 'src/warehouse/manifest.ts',
        fields: [{ name: 'id', type: 'string', key: 'primary' }],
        methods: [{
          name: 'totalWeight',
          signature: 'totalWeight(): number',
          returns: 'number',
          description: 'The manifest\'s total weight in kilograms.',
          sourcePath: 'src/warehouse/weighing.ts',
          symbol: 'manifestTotalWeight',
        }],
      }],
      files: {
        'src/warehouse/picking.ts': PICKING_MODULE,
        'src/warehouse/manifest.ts': 'export interface ShipmentManifest { id: string; }\n',
        'src/warehouse/weighing.ts': 'export function manifestTotalWeight(): number { return 0; }\n',
      },
    },
  }),

  // -------------------------------------------------------------------------
  // UNCLAIMED_SOURCE_FILE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNCLAIMED_SOURCE_FILE',
    severity: 'warning',
    anchoredTo: null,
    expectFire: true,
    scenario:
      'A carrier rate module was added to the warehouse source tree without any spec naming it, and the project has declared src as a source root.',
    tree: {
      ...pickingSpecs,
      rules: { conformance: { sourceRoots: ['src'] } },
      files: {
        'src/warehouse/picking.ts': PICKING_MODULE,
        'src/warehouse/carrier-rates.ts': 'export function quoteCarrierRate(): number { return 0; }\n',
      },
    },
  }),
  defineRuleFixture({
    code: 'UNCLAIMED_SOURCE_FILE',
    expectFire: false,
    reason:
      'Declaring no source root walks no files, which is what keeps the check opt-in: upgrading wairon never floods a project that has not adopted it.',
    scenario:
      'The same undesigned carrier rate module sits in a project that has declared no source roots at all.',
    tree: {
      ...pickingSpecs,
      files: {
        'src/warehouse/picking.ts': PICKING_MODULE,
        'src/warehouse/carrier-rates.ts': 'export function quoteCarrierRate(): number { return 0; }\n',
      },
    },
  }),
  defineRuleFixture({
    code: 'UNCLAIMED_SOURCE_FILE',
    expectFire: false,
    reason:
      'A pure re-export barrel declares nothing of its own, so there is nothing in it for a spec to claim — the exemption is the rule, not a special case.',
    scenario:
      'The only file no spec names is the warehouse barrel, whose every statement re-exports the picking module.',
    tree: {
      ...pickingSpecs,
      rules: { conformance: { sourceRoots: ['src'] } },
      files: {
        'src/warehouse/picking.ts': PICKING_MODULE,
        'src/warehouse/index.ts': "export * from './picking.js';\n",
      },
    },
  }),
  defineRuleFixture({
    code: 'UNCLAIMED_SOURCE_FILE',
    expectFire: false,
    reason:
      'The file is carried in the frozen unclaimed list — debt written down where a reviewer sees the whole list, which is what the register is for.',
    scenario:
      'The undesigned carrier rate module is recorded in rules.conformance.unclaimed while the team works through the backlog.',
    tree: {
      ...pickingSpecs,
      rules: { conformance: { sourceRoots: ['src'], unclaimed: ['src/warehouse/carrier-rates.ts'] } },
      files: {
        'src/warehouse/picking.ts': PICKING_MODULE,
        'src/warehouse/carrier-rates.ts': 'export function quoteCarrierRate(): number { return 0; }\n',
      },
    },
  }),
  defineRuleFixture({
    code: 'UNCLAIMED_SOURCE_FILE',
    expectFire: false,
    reason:
      'An excluded path is never walked, so vendored code is neither reported nor carried as debt it could never pay off.',
    scenario:
      'The warehouse ships a vendored barcode library under src/vendor, excluded from the source-root walk.',
    tree: {
      ...pickingSpecs,
      rules: { conformance: { sourceRoots: ['src'], exclude: ['src/vendor'] } },
      files: {
        'src/warehouse/picking.ts': PICKING_MODULE,
        'src/vendor/barcode.js': 'export function decodeBarcode(){ return null; }\n',
      },
    },
  }),

  // -------------------------------------------------------------------------
  // STALE_UNCLAIMED_ENTRY
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'STALE_UNCLAIMED_ENTRY',
    severity: 'warning',
    anchoredTo: null,
    expectFire: true,
    scenario:
      'The picking module was designed and given a sourcePath, but its line was left behind in the frozen unclaimed list, so the register no longer matches the debt.',
    tree: {
      ...pickingSpecs,
      rules: { conformance: { sourceRoots: ['src'], unclaimed: ['src/warehouse/picking.ts'] } },
      files: { 'src/warehouse/picking.ts': PICKING_MODULE },
    },
  }),
  defineRuleFixture({
    code: 'STALE_UNCLAIMED_ENTRY',
    severity: 'warning',
    anchoredTo: null,
    expectFire: true,
    scenario:
      'A carrier rate module named in the frozen unclaimed list was deleted in a cleanup, leaving an entry the source-root walk no longer finds.',
    tree: {
      ...pickingSpecs,
      rules: { conformance: { sourceRoots: ['src'], unclaimed: ['src/warehouse/carrier-rates.ts'] } },
      files: { 'src/warehouse/picking.ts': PICKING_MODULE },
    },
  }),
  defineRuleFixture({
    code: 'STALE_UNCLAIMED_ENTRY',
    expectFire: false,
    reason:
      'Opting out means silence: auditing a frozen list against a walk that found nothing would call every entry stale for a reason the reader never chose.',
    scenario:
      'The warehouse project still carries an unclaimed list from an earlier experiment but has withdrawn its source roots, so nothing is walked.',
    tree: {
      ...pickingSpecs,
      rules: { conformance: { unclaimed: ['src/warehouse/carrier-rates.ts'] } },
      files: { 'src/warehouse/picking.ts': PICKING_MODULE },
    },
  }),
  defineRuleFixture({
    code: 'STALE_UNCLAIMED_ENTRY',
    expectFire: false,
    reason:
      'The entry names a walked file that no spec claims and that is no barrel — live debt, which is exactly what the list is for.',
    scenario:
      'The frozen unclaimed list carries the one warehouse module nobody has designed yet, and the source-root walk still finds it.',
    tree: {
      ...pickingSpecs,
      rules: { conformance: { sourceRoots: ['src'], unclaimed: ['src/warehouse/carrier-rates.ts'] } },
      files: {
        'src/warehouse/picking.ts': PICKING_MODULE,
        'src/warehouse/carrier-rates.ts': 'export function quoteCarrierRate(): number { return 0; }\n',
      },
    },
  }),
];
