/**
 * Technology-boundary fixtures (src/core/rules/technology.ts).
 *
 * Documented intents pinned here (all warnings):
 *  - TECH_ON_LOGIC_COMPONENT: only data-layer stereotypes (Adapter/Store/
 *    Registry/Index) should bind a technology directly.
 *  - VENDOR_NAME_IN_CONTRACT: L3 contract IDENTIFIERS must stay
 *    intent-language — even on the owning component's own interface (the
 *    contract is the swap seam). Two documented identifier surfaces
 *    exercised: the method name and a param type.
 *  - TECH_LEAKAGE: references outside the declaring component's ownership
 *    tree are leakage. One pair per documented reference site: component
 *    surfaces, the shared type space (no owning exemption), interface prose,
 *    and implementation narrative. Prose INSIDE the owning scope may name the
 *    tech (honest documentation) — the component-site control pins that too.
 *
 * Only declared tokens are policed (no hardcoded vendor lists), so each tree
 * opts in by declaring `technologies: [postgresql]` on the stock ledger
 * store's implementation.
 */
import { defineRuleFixture, type FixtureSpecInput } from '../harness.js';

const SYSTEM = {
  name: 'MediBook',
  vision: 'Clinic appointment booking platform covering scheduling, inventory, and partner integrations.',
};

const INVENTORY_SUB = { id: 'inventory', description: 'Medical supply stock tracking for the clinic.' };

const STOCK_STORE = (description: string): FixtureSpecInput => ({
  id: 'stock-ledger-store',
  componentType: 'Store',
  subsystem: 'inventory',
  description,
});

const STOCK_STORE_NEUTRAL = STOCK_STORE('Holds the stock movement ledger.');

/** The declaring L4: binds postgresql on the stock ledger store (the tech's home). */
const STOCK_LEDGER_IMPL = {
  id: 'stock_ledger_impl',
  contract: 'istock_ledger',
  technologies: ['postgresql'],
  methods: [{ name: 'recordMovement', narrative: [{ stepNumber: 1, type: 'local', description: 'Append the stock movement to the ledger.' }] }],
};

const STOCK_LEDGER_INTERFACE = {
  id: 'istock_ledger',
  component: 'stock-ledger-store',
  methods: [{ name: 'recordMovement', description: 'Append one stock movement to the ledger.' }],
};

const REPLENISH_ORCH = (description: string): FixtureSpecInput => ({
  id: 'replenishment-orchestrator',
  componentType: 'Orchestrator',
  subsystem: 'inventory',
  description,
  dependsOn: ['stock-ledger-store'],
});

export default [
  // -------------------------------------------------------------------------
  // TECH_ON_LOGIC_COMPONENT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'TECH_ON_LOGIC_COMPONENT',
    severity: 'warning',
    anchoredTo: 'replenishment_impl',
    expectFire: true,
    scenario:
      'The replenishment orchestrator\'s implementation binds postgresql directly, although technology belongs behind a data-layer seam.',
    tree: {
      system: SYSTEM,
      subsystems: [INVENTORY_SUB],
      components: [REPLENISH_ORCH('Plans nightly stock reorders from current levels.'), STOCK_STORE_NEUTRAL],
      interfaces: [
        {
          id: 'ireplenishment',
          component: 'replenishment-orchestrator',
          methods: [{ name: 'planReorders', description: 'Plan the nightly reorder batch.' }],
        },
      ],
      implementations: [
        {
          id: 'replenishment_impl',
          contract: 'ireplenishment',
          technologies: ['postgresql'],
          methods: [{ name: 'planReorders', narrative: [{ stepNumber: 1, type: 'local', description: 'Compute the reorder quantities from current stock levels.' }] }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'TECH_ON_LOGIC_COMPONENT',
    expectFire: false,
    reason: 'The technology is bound by a Store implementation — a data-layer stereotype, the documented legitimate home.',
    scenario:
      'Postgresql is bound by the stock ledger store\'s implementation while the replenishment orchestrator stays technology-free.',
    tree: {
      system: SYSTEM,
      subsystems: [INVENTORY_SUB],
      components: [REPLENISH_ORCH('Plans nightly stock reorders from current levels.'), STOCK_STORE_NEUTRAL],
      interfaces: [
        STOCK_LEDGER_INTERFACE,
        {
          id: 'ireplenishment',
          component: 'replenishment-orchestrator',
          methods: [{ name: 'planReorders', description: 'Plan the nightly reorder batch.' }],
        },
      ],
      implementations: [
        STOCK_LEDGER_IMPL,
        {
          id: 'replenishment_impl',
          contract: 'ireplenishment',
          methods: [{ name: 'planReorders', narrative: [{ stepNumber: 1, type: 'local', description: 'Compute the reorder quantities from current stock levels.' }] }],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // VENDOR_NAME_IN_CONTRACT — method-name surface
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'VENDOR_NAME_IN_CONTRACT',
    severity: 'warning',
    anchoredTo: 'istock_ledger',
    expectFire: true,
    scenario:
      'The stock ledger contract names its write method writePostgresqlRow, leaking the vendor into the swap seam of the very component that owns the technology.',
    tree: {
      system: SYSTEM,
      subsystems: [INVENTORY_SUB],
      components: [STOCK_STORE_NEUTRAL],
      interfaces: [
        {
          id: 'istock_ledger',
          component: 'stock-ledger-store',
          methods: [{ name: 'writePostgresqlRow', description: 'Append one stock movement to the ledger.' }],
        },
      ],
      implementations: [
        {
          id: 'stock_ledger_impl',
          contract: 'istock_ledger',
          technologies: ['postgresql'],
          methods: [{ name: 'writePostgresqlRow', narrative: [{ stepNumber: 1, type: 'local', description: 'Append the stock movement to the ledger.' }] }],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // VENDOR_NAME_IN_CONTRACT — param-type surface
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'VENDOR_NAME_IN_CONTRACT',
    severity: 'warning',
    anchoredTo: 'istock_ledger',
    expectFire: true,
    scenario:
      'The stock ledger contract\'s recordMovement method takes a PostgresqlPool parameter, exposing the vendor in a contract identifier.',
    tree: {
      system: SYSTEM,
      subsystems: [INVENTORY_SUB],
      components: [STOCK_STORE_NEUTRAL],
      interfaces: [
        {
          id: 'istock_ledger',
          component: 'stock-ledger-store',
          methods: [
            {
              name: 'recordMovement',
              description: 'Append one stock movement to the ledger.',
              signature: 'recordMovement(pool: PostgresqlPool, movement: string): void',
              params: [
                { name: 'pool', type: 'PostgresqlPool' },
                { name: 'movement', type: 'string' },
              ],
            },
          ],
        },
      ],
      implementations: [STOCK_LEDGER_IMPL],
    },
  }),
  defineRuleFixture({
    code: 'VENDOR_NAME_IN_CONTRACT',
    expectFire: false,
    reason: 'The contract identifiers speak intent language (recordMovement, string params) — the vendor stays swappable behind the seam.',
    scenario:
      'The stock ledger contract names its methods and parameters after the intent while postgresql stays bound only in the implementation.',
    tree: {
      system: SYSTEM,
      subsystems: [INVENTORY_SUB],
      components: [STOCK_STORE_NEUTRAL],
      interfaces: [
        {
          id: 'istock_ledger',
          component: 'stock-ledger-store',
          methods: [
            {
              name: 'recordMovement',
              description: 'Append one stock movement to the ledger.',
              signature: 'recordMovement(movement: string): void',
              params: [{ name: 'movement', type: 'string' }],
            },
          ],
        },
      ],
      implementations: [STOCK_LEDGER_IMPL],
    },
  }),

  // -------------------------------------------------------------------------
  // TECH_LEAKAGE — component-surface site (and the in-scope prose exemption)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'TECH_LEAKAGE',
    severity: 'warning',
    anchoredTo: 'replenishment-orchestrator',
    expectFire: true,
    scenario:
      'The replenishment orchestrator\'s description says it reads the PostgreSQL stock tables directly, referencing the technology outside its owning boundary.',
    tree: {
      system: SYSTEM,
      subsystems: [INVENTORY_SUB],
      components: [
        REPLENISH_ORCH('Plans reorders by reading the PostgreSQL stock tables directly each night.'),
        STOCK_STORE_NEUTRAL,
      ],
      interfaces: [STOCK_LEDGER_INTERFACE],
      implementations: [STOCK_LEDGER_IMPL],
    },
  }),
  defineRuleFixture({
    code: 'TECH_LEAKAGE',
    expectFire: false,
    reason:
      'Outside components speak intent language; the owning store\'s own description naming PostgreSQL is inside the owning scope — honest documentation, not coupling (documented).',
    scenario:
      'Only the stock ledger store\'s own description mentions PostgreSQL while the replenishment orchestrator talks about stock levels.',
    tree: {
      system: SYSTEM,
      subsystems: [INVENTORY_SUB],
      components: [
        REPLENISH_ORCH('Plans nightly stock reorders from current levels.'),
        STOCK_STORE('Persists stock movements in PostgreSQL.'),
      ],
      interfaces: [STOCK_LEDGER_INTERFACE],
      implementations: [STOCK_LEDGER_IMPL],
    },
  }),

  // -------------------------------------------------------------------------
  // TECH_LEAKAGE — shared type space site (no owning exemption, documented)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'TECH_LEAKAGE',
    severity: 'warning',
    anchoredTo: 'stock-movement',
    expectFire: true,
    scenario:
      'The shared stock movement type carries a postgresqlRowId field, dragging a vendor-specific shape into the shared type space.',
    tree: {
      system: SYSTEM,
      subsystems: [INVENTORY_SUB],
      components: [STOCK_STORE_NEUTRAL],
      interfaces: [STOCK_LEDGER_INTERFACE],
      implementations: [STOCK_LEDGER_IMPL],
      types: [
        {
          id: 'stock-movement',
          subsystem: 'inventory',
          description: 'One stock movement in or out of the clinic supply room.',
          fields: [
            { name: 'postgresqlRowId', type: 'string', description: 'Vendor row id of the persisted movement.' },
            { name: 'quantity', type: 'number', description: 'Units moved.' },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'TECH_LEAKAGE',
    expectFire: false,
    reason: 'The shared type names its fields after the intent (ledgerRowId), keeping vendor shapes inside the owning boundary.',
    scenario:
      'The shared stock movement type identifies persisted movements by a vendor-neutral ledgerRowId field.',
    tree: {
      system: SYSTEM,
      subsystems: [INVENTORY_SUB],
      components: [STOCK_STORE_NEUTRAL],
      interfaces: [STOCK_LEDGER_INTERFACE],
      implementations: [STOCK_LEDGER_IMPL],
      types: [
        {
          id: 'stock-movement',
          subsystem: 'inventory',
          description: 'One stock movement in or out of the clinic supply room.',
          fields: [
            { name: 'ledgerRowId', type: 'string', description: 'Ledger id of the persisted movement.' },
            { name: 'quantity', type: 'number', description: 'Units moved.' },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // TECH_LEAKAGE — interface prose site (outside the owning boundary)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'TECH_LEAKAGE',
    severity: 'warning',
    anchoredTo: 'ireplenishment',
    expectFire: true,
    scenario:
      'The replenishment contract\'s method prose tells consumers the thresholds come from the postgresql replica, describing backend specifics outside the owning boundary.',
    tree: {
      system: SYSTEM,
      subsystems: [INVENTORY_SUB],
      components: [REPLENISH_ORCH('Plans nightly stock reorders from current levels.'), STOCK_STORE_NEUTRAL],
      interfaces: [
        STOCK_LEDGER_INTERFACE,
        {
          id: 'ireplenishment',
          component: 'replenishment-orchestrator',
          methods: [{ name: 'planReorders', description: 'Loads reorder thresholds from the postgresql replica before planning.' }],
        },
      ],
      implementations: [STOCK_LEDGER_IMPL],
    },
  }),
  defineRuleFixture({
    code: 'TECH_LEAKAGE',
    expectFire: false,
    reason: 'The outside contract\'s prose describes the intent (the stock ledger), not the vendor behind it.',
    scenario:
      'The replenishment contract\'s method prose says thresholds come from the stock ledger, keeping consumers vendor-blind.',
    tree: {
      system: SYSTEM,
      subsystems: [INVENTORY_SUB],
      components: [REPLENISH_ORCH('Plans nightly stock reorders from current levels.'), STOCK_STORE_NEUTRAL],
      interfaces: [
        STOCK_LEDGER_INTERFACE,
        {
          id: 'ireplenishment',
          component: 'replenishment-orchestrator',
          methods: [{ name: 'planReorders', description: 'Loads reorder thresholds from the stock ledger before planning.' }],
        },
      ],
      implementations: [STOCK_LEDGER_IMPL],
    },
  }),

  // -------------------------------------------------------------------------
  // TECH_LEAKAGE — implementation narrative site (outside the owning boundary)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'TECH_LEAKAGE',
    severity: 'warning',
    anchoredTo: 'replenishment_impl',
    expectFire: true,
    scenario:
      'The replenishment implementation\'s narrative step queries the postgresql stock table by name instead of calling the owning boundary\'s intent interface.',
    tree: {
      system: SYSTEM,
      subsystems: [INVENTORY_SUB],
      components: [REPLENISH_ORCH('Plans nightly stock reorders from current levels.'), STOCK_STORE_NEUTRAL],
      interfaces: [
        STOCK_LEDGER_INTERFACE,
        {
          id: 'ireplenishment',
          component: 'replenishment-orchestrator',
          methods: [{ name: 'planReorders', description: 'Plan the nightly reorder batch.' }],
        },
      ],
      implementations: [
        STOCK_LEDGER_IMPL,
        {
          id: 'replenishment_impl',
          contract: 'ireplenishment',
          methods: [
            {
              name: 'planReorders',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Query the postgresql stock table for current levels.' }],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'TECH_LEAKAGE',
    expectFire: false,
    reason: 'The outside narrative speaks in terms of the stock ledger\'s intent interface, so no technology reference leaves the boundary.',
    scenario:
      'The replenishment implementation\'s narrative fetches current levels from the stock ledger without naming the database behind it.',
    tree: {
      system: SYSTEM,
      subsystems: [INVENTORY_SUB],
      components: [REPLENISH_ORCH('Plans nightly stock reorders from current levels.'), STOCK_STORE_NEUTRAL],
      interfaces: [
        STOCK_LEDGER_INTERFACE,
        {
          id: 'ireplenishment',
          component: 'replenishment-orchestrator',
          methods: [{ name: 'planReorders', description: 'Plan the nightly reorder batch.' }],
        },
      ],
      implementations: [
        STOCK_LEDGER_IMPL,
        {
          id: 'replenishment_impl',
          contract: 'ireplenishment',
          methods: [
            {
              name: 'planReorders',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Fetch current stock levels from the stock ledger.' }],
            },
          ],
        },
      ],
    },
  }),
];
