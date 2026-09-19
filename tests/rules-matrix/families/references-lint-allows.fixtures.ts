/**
 * The lint-allow audit (src/core/rules/integrity/lint-allows.ts) — wairon's
 * #[allow(...)], which must name real issue codes and actually suppress a
 * finding.
 *
 * Documented intents pinned here (the rule's two failure modes):
 *  - UNKNOWN_LINT_ALLOW_CODE (warning): a lint.allow naming a code no
 *    registered rule can emit (typo / removed rule).
 *  - UNUSED_LINT_ALLOW (warning): an allow that matched nothing this run —
 *    stale suppressions rot into invisible risk exactly like commented-out
 *    tests. The control shows a USED allow (it suppresses a live
 *    warning-severity finding) staying quiet.
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';

// ---------------------------------------------------------------------------
// The two trees the site-precision fixtures below vary only the lint block of.
// ---------------------------------------------------------------------------

const LABEL_EDGE = 'src/dispatch/order-router.ts -> src/dispatch/carrier-label-adapter.ts';
const LEDGER_EDGE = 'src/dispatch/order-router.ts -> src/dispatch/inventory-ledger-adapter.ts';
const WHY_LABEL = 'The carrier label API is called inline while the label adapter is carved out — declared next sprint.';
const WHY_LEDGER = 'The ledger write stays inline until the warehouse subsystem publishes its surface.';
const WHY_BATCH = 'Both carrier calls are made by the nightly batch runner, which the call graph does not reach from this method.';

/**
 * A dispatch desk whose order router imports TWO adapters beside it and
 * declares neither edge, so exactly two crossings are reported — one per
 * import, each its own site.
 */
function parcelDeskTree(allow: unknown): FixtureTree {
  return {
    subsystems: [{ id: 'dispatch', description: 'Outbound parcel dispatch and carrier hand-off.' }],
    components: [
      { id: 'order-router', componentType: 'Orchestrator', subsystem: 'dispatch', description: 'Routes each placed order to a carrier and books the stock movement.' },
      { id: 'carrier-label-adapter', componentType: 'Adapter', subsystem: 'dispatch', description: 'Wraps the carrier label-printing API.' },
      { id: 'inventory-ledger-adapter', componentType: 'Adapter', subsystem: 'dispatch', description: 'Wraps the warehouse stock-movement ledger.' },
    ],
    interfaces: [
      { id: 'iorder_router', component: 'order-router', methods: [{ name: 'routeOrder', description: 'Route one placed order to a carrier.' }] },
      { id: 'icarrier_label_adapter', component: 'carrier-label-adapter', methods: [{ name: 'printLabel', description: 'Print a carrier label for a parcel.' }] },
      { id: 'iinventory_ledger_adapter', component: 'inventory-ledger-adapter', methods: [{ name: 'recordPick', description: 'Record the stock pick for a parcel.' }] },
    ],
    implementations: [
      {
        id: 'order_router_impl',
        contract: 'iorder_router',
        sourcePath: 'src/dispatch/order-router.ts',
        lint: { allow },
        methods: [{ name: 'routeOrder', narrative: [{ stepNumber: 1, type: 'local', description: 'Pick the carrier for the order and book the stock movement.' }] }],
      },
      {
        id: 'carrier_label_adapter_impl',
        contract: 'icarrier_label_adapter',
        sourcePath: 'src/dispatch/carrier-label-adapter.ts',
        methods: [{ name: 'printLabel', narrative: [{ stepNumber: 1, type: 'local', description: 'POST the label request to the carrier API.' }] }],
      },
      {
        id: 'inventory_ledger_adapter_impl',
        contract: 'iinventory_ledger_adapter',
        sourcePath: 'src/dispatch/inventory-ledger-adapter.ts',
        methods: [{ name: 'recordPick', narrative: [{ stepNumber: 1, type: 'local', description: 'Append the pick to the warehouse ledger.' }] }],
      },
    ],
    files: {
      'src/dispatch/order-router.ts': [
        "import { printLabel } from './carrier-label-adapter.js';",
        "import { recordPick } from './inventory-ledger-adapter.js';",
        '',
        'export function routeOrder(orderId: string): void {',
        '  printLabel(orderId);',
        '  recordPick(orderId);',
        '}',
        '',
      ].join('\n'),
      'src/dispatch/carrier-label-adapter.ts': ['export function printLabel(orderId: string): void {', '  void orderId;', '}', ''].join('\n'),
      'src/dispatch/inventory-ledger-adapter.ts': ['export function recordPick(orderId: string): void {', '  void orderId;', '}', ''].join('\n'),
    },
  };
}

/**
 * A label desk whose scheduler narrates TWO calls into the label adapter and
 * makes neither — one aggregating finding wearing two units at one site.
 */
function labelDeskTree(allow: unknown): FixtureTree {
  return {
    subsystems: [{ id: 'labelling', description: 'Carrier label issue and void for outbound parcels.' }],
    components: [
      { id: 'label-scheduler', componentType: 'Orchestrator', subsystem: 'labelling', description: 'Issues and voids carrier labels as parcels move.', dependsOn: ['label-print-adapter'] },
      { id: 'label-print-adapter', componentType: 'Adapter', subsystem: 'labelling', description: 'Wraps the carrier label issue and void API.' },
    ],
    interfaces: [
      { id: 'ilabel_scheduler', component: 'label-scheduler', methods: [{ name: 'reissueLabel', description: 'Void the label a parcel carries today and issue a replacement.' }] },
      {
        id: 'ilabel_print_adapter',
        component: 'label-print-adapter',
        methods: [
          { name: 'voidLabel', description: 'Void a previously issued carrier label.' },
          { name: 'issueLabel', description: 'Issue a new carrier label.' },
        ],
      },
    ],
    implementations: [
      {
        id: 'label_scheduler_impl',
        contract: 'ilabel_scheduler',
        sourcePath: 'src/labelling/label-scheduler.ts',
        lint: { allow },
        methods: [{
          name: 'reissueLabel',
          narrative: [
            { stepNumber: 1, type: 'call', description: 'Void the label the parcel carries today.', targetComponent: 'label-print-adapter', targetMethod: 'voidLabel' },
            { stepNumber: 2, type: 'call', description: 'Issue the replacement label.', targetComponent: 'label-print-adapter', targetMethod: 'issueLabel' },
          ],
        }],
      },
      {
        id: 'label_print_adapter_impl',
        contract: 'ilabel_print_adapter',
        sourcePath: 'src/labelling/label-print-adapter.ts',
        methods: [
          { name: 'voidLabel', narrative: [{ stepNumber: 1, type: 'local', description: 'POST the void to the carrier API.' }] },
          { name: 'issueLabel', narrative: [{ stepNumber: 1, type: 'local', description: 'POST the issue request to the carrier API.' }] },
        ],
      },
    ],
    files: {
      'src/labelling/label-scheduler.ts': [
        'export function reissueLabel(parcelId: string): void {',
        '  // Both carrier calls are made by the nightly batch, never from here.',
        '  void parcelId;',
        '}',
        '',
      ].join('\n'),
      'src/labelling/label-print-adapter.ts': [
        'export function voidLabel(parcelId: string): void {', '  void parcelId;', '}', '',
        'export function issueLabel(parcelId: string): void {', '  void parcelId;', '}', '',
      ].join('\n'),
    },
  };
}

export default [
  // -------------------------------------------------------------------------
  // UNKNOWN_LINT_ALLOW_CODE — the unknown-code path
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNKNOWN_LINT_ALLOW_CODE',
    severity: 'warning',
    anchoredTo: 'notification-fanout-hub',
    expectFire: true,
    scenario:
      'The notification fan-out hub allows the misspelled code EXCESS_DEPENDENCIES, which no registered rule can ever emit.',
    tree: {
      subsystems: [{ id: 'notifications', description: 'Customer notification fan-out across channels.' }],
      components: [
        {
          id: 'notification-fanout-hub',
          componentType: 'Orchestrator',
          subsystem: 'notifications',
          description: 'Fans one customer event out to every subscribed channel sender.',
          // The defect: the allowed code is a typo of EXCESSIVE_DEPENDENCIES.
          lint: { allow: [{ code: 'EXCESS_DEPENDENCIES', reason: 'Fan-out hub — a wide dependency list is the point.' }] },
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNKNOWN_LINT_ALLOW_CODE',
    expectFire: false,
    reason: 'The allow names EXCESSIVE_DEPENDENCIES, a code the registered complexity rule really emits.',
    scenario:
      'The notification fan-out hub allows the correctly spelled EXCESSIVE_DEPENDENCIES code for its deliberate wide fan-out.',
    tree: {
      subsystems: [{ id: 'notifications', description: 'Customer notification fan-out across channels.' }],
      components: [
        {
          id: 'notification-fanout-hub',
          componentType: 'Orchestrator',
          subsystem: 'notifications',
          description: 'Fans one customer event out to every subscribed channel sender.',
          lint: { allow: [{ code: 'EXCESSIVE_DEPENDENCIES', reason: 'Fan-out hub — a wide dependency list is the point.' }] },
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNUSED_LINT_ALLOW — the stale-allow path
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNUSED_LINT_ALLOW',
    severity: 'warning',
    anchoredTo: 'shipment-manifest',
    expectFire: true,
    scenario:
      'The shipment manifest entity still allows HOLLOW_TYPE from its placeholder days, but the type has long since gained fields so the allow matches nothing.',
    tree: {
      subsystems: [{ id: 'manifesting', description: 'Shipment manifest assembly for outbound loads.' }],
      types: [
        {
          id: 'shipment-manifest',
          kind: 'entity',
          subsystem: 'manifesting',
          fields: [
            { name: 'manifestId', type: 'string', description: 'Stable manifest identifier.' },
            { name: 'sealNumber', type: 'string', description: 'Trailer seal applied at close-out.' },
          ],
          // The defect: a stale allow — HOLLOW_TYPE cannot fire on a type with fields.
          lint: { allow: [{ code: 'HOLLOW_TYPE', reason: 'Placeholder during the manifest domain carve-out.' }] },
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNUSED_LINT_ALLOW',
    expectFire: false,
    reason: 'The allow is USED this run: it suppresses the live HOLLOW_TYPE warning on the still-empty placeholder, so it is not stale.',
    scenario:
      'The shipment manifest entity is still an acknowledged placeholder whose HOLLOW_TYPE warning the allow actively suppresses.',
    tree: {
      subsystems: [{ id: 'manifesting', description: 'Shipment manifest assembly for outbound loads.' }],
      types: [
        {
          id: 'shipment-manifest',
          kind: 'entity',
          subsystem: 'manifesting',
          // Still hollow on purpose — the allow matches the live finding.
          lint: { allow: [{ code: 'HOLLOW_TYPE', reason: 'Placeholder during the manifest domain carve-out.' }] },
        },
      ],
    },
  }),
  // -------------------------------------------------------------------------
  // SITE PRECISION — an allow covers exactly the occurrence it names
  //
  // These pin the allow's SCOPE, which is why they live here rather than with
  // the dependency and call rules whose codes they assert: what a two-crossing
  // tree measures is not the crossing, it is how much of one an allow may
  // silence. Keyed by code and spec alone, one allow covered every occurrence
  // a rule reported there — measured on wairon's own tree, 32 allows
  // suppressed 46 findings, so 14 occurrences were invisible even to the allow
  // that named them.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_DEPENDENCY',
    severity: 'warning',
    anchoredTo: 'order_router_impl',
    expectFire: true,
    scenario:
      'The order router crosses to two adapters beside it while its allow names only the label crossing, so the ledger crossing nobody decided on is still reported.',
    tree: parcelDeskTree([{ code: 'UNDECLARED_DEPENDENCY', at: LABEL_EDGE, reason: WHY_LABEL }]),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_DEPENDENCY',
    expectFire: false,
    reason: 'Both crossings are named, each by its own allow with its own reason — every occurrence has been decided on, so nothing is left to report.',
    scenario:
      'The order router crosses to two adapters beside it and carries one allow per crossing, each naming its own import edge.',
    tree: parcelDeskTree([
      { code: 'UNDECLARED_DEPENDENCY', at: LABEL_EDGE, reason: WHY_LABEL },
      { code: 'UNDECLARED_DEPENDENCY', at: LEDGER_EDGE, reason: WHY_LEDGER },
    ]),
  }),
  defineRuleFixture({
    code: 'UNUSED_LINT_ALLOW',
    severity: 'warning',
    anchoredTo: 'order_router_impl',
    expectFire: true,
    scenario:
      'The order router still carries the old spec-wide allow for undeclared dependencies, which names no crossing at all while the run reports two.',
    tree: parcelDeskTree([{ code: 'UNDECLARED_DEPENDENCY', reason: WHY_LABEL }]),
  }),
  defineRuleFixture({
    code: 'UNUSED_LINT_ALLOW',
    severity: 'warning',
    anchoredTo: 'order_router_impl',
    expectFire: true,
    scenario:
      'The order router allows a crossing to a surcharge pricing module it no longer imports, so that allow names a site this run never reported.',
    tree: parcelDeskTree([
      { code: 'UNDECLARED_DEPENDENCY', at: 'src/dispatch/order-router.ts -> src/dispatch/surcharge-pricing-adapter.ts', reason: WHY_LABEL },
      { code: 'UNDECLARED_DEPENDENCY', at: LABEL_EDGE, reason: WHY_LABEL },
      { code: 'UNDECLARED_DEPENDENCY', at: LEDGER_EDGE, reason: WHY_LEDGER },
    ]),
  }),
  defineRuleFixture({
    code: 'UNUSED_LINT_ALLOW',
    expectFire: false,
    reason: 'Each allow names a crossing the run really reported, so each suppressed its own finding and none is stale.',
    scenario:
      'The order router carries one allow per crossing, each naming an import edge this run reports.',
    tree: parcelDeskTree([
      { code: 'UNDECLARED_DEPENDENCY', at: LABEL_EDGE, reason: WHY_LABEL },
      { code: 'UNDECLARED_DEPENDENCY', at: LEDGER_EDGE, reason: WHY_LEDGER },
    ]),
  }),

  // -------------------------------------------------------------------------
  // …and exactly the UNITS it lists, where the finding aggregates.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    severity: 'warning',
    anchoredTo: 'label_scheduler_impl',
    expectFire: true,
    scenario:
      'The label scheduler narrates a void and an issue call it never makes, and its allow lists only the void step, so the issue step nobody decided on is still reported.',
    tree: labelDeskTree([{ code: 'CALL_STEP_UNREALIZED', at: 'reissueLabel', covers: ['1:label-print-adapter.voidLabel'], reason: WHY_BATCH }]),
  }),
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    expectFire: false,
    reason: 'The allow names the method AND lists every step the finding reports, so the whole occurrence has been decided on.',
    scenario:
      'The label scheduler narrates a void and an issue call it never makes, and its allow names the method and lists both steps.',
    tree: labelDeskTree([{
      code: 'CALL_STEP_UNREALIZED',
      at: 'reissueLabel',
      covers: ['1:label-print-adapter.voidLabel', '2:label-print-adapter.issueLabel'],
      reason: WHY_BATCH,
    }]),
  }),
];
