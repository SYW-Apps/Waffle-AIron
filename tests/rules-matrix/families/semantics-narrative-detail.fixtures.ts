/**
 * Narrative-detail family (src/core/rules/narrative-detail.ts): the detail
 * dial — levels are floors, not ceilings; resolution method -> spec ->
 * stereotype default.
 *
 * Documented intents pinned here:
 *  - MISSING_NARRATIVE: detail: full without a narrative — error when the
 *    level was declared explicitly, warning when it is the stereotype default.
 *  - INTENT_FLOOR: an intent-level method without a narrative must specify
 *    behavior as non-trivial prose (L4 intent or L3 description) — error when
 *    the dial was explicit, warning when defaulted.
 *  - UNNARRATED_COMPLEXITY (warning): a method below detail: full with no
 *    narrative whose realized function measures cyclomatic complexity above
 *    the configured threshold (exact AST grade only) — real branching may not
 *    hide behind a dialed-down level.
 *  - DETAIL_BELOW_STEREOTYPE (warning): explicitly dialing a LOGIC
 *    stereotype's method below its full floor, with no narrative, is a
 *    visible design choice; non-logic stereotypes may dial down freely.
 */
import { defineRuleFixture } from '../harness.js';

/**
 * A realized store method with genuine branching: 9 independent if-statements
 * put the cyclomatic complexity at 10, above the default threshold of 8.
 */
const COMPLEX_QUOTA_SOURCE = `export interface ChargeContext {
  plan: string;
  used: number;
  quota: number;
  burst: boolean;
  region: string;
}

export function applyCharge(ctx: ChargeContext, amount: number): number {
  let charge = amount;
  if (ctx.plan === 'free') { charge = amount; }
  if (ctx.plan === 'pro') { charge = amount * 0.9; }
  if (ctx.plan === 'enterprise') { charge = amount * 0.8; }
  if (ctx.used > ctx.quota) { charge = charge * 1.5; }
  if (ctx.burst) { charge = charge * 1.2; }
  if (ctx.region === 'eu-west') { charge = charge + 0.01; }
  if (ctx.region === 'us-east') { charge = charge + 0.02; }
  if (charge < 0) { charge = 0; }
  if (charge > 1000) { charge = 1000; }
  return charge;
}
`;

/** The same contract realized as a simple pass-through: complexity well under the threshold. */
const SIMPLE_QUOTA_SOURCE = `export interface ChargeContext {
  plan: string;
  used: number;
  quota: number;
}

export function applyCharge(ctx: ChargeContext, amount: number): number {
  let charge = amount;
  if (ctx.used > ctx.quota) { charge = charge * 1.5; }
  return charge;
}
`;

function quotaLedgerTree(source: string) {
  return {
    subsystems: [{ id: 'quota-billing', description: 'Usage-quota charge ledger for metered plans.' }],
    components: [
      {
        id: 'quota-ledger-store',
        componentType: 'Store',
        description: 'Ledger of usage charges per subscription.',
        durability: 'read-through',
      },
    ],
    interfaces: [
      {
        id: 'iquota_ledger_store',
        component: 'quota-ledger-store',
        methods: [
          {
            name: 'applyCharge',
            description: 'Apply one usage charge to the subscription ledger, honoring plan discounts and clamping.',
            effect: 'write',
          },
        ],
      },
    ],
    implementations: [
      {
        id: 'quota_ledger_store_impl',
        contract: 'iquota_ledger_store',
        sourcePath: 'src/quota/quota-ledger-store.ts',
        methods: [
          {
            name: 'applyCharge',
            intent:
              'Applies one usage charge to the subscription ledger, honoring plan discounts, burst multipliers, and regional levies, and clamping the result to the allowed range.',
            narrative: [],
          },
        ],
      },
    ],
    files: { 'src/quota/quota-ledger-store.ts': source },
  };
}

export default [
  // -------------------------------------------------------------------------
  // MISSING_NARRATIVE — explicit declaration (error) and stereotype default
  // (warning)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MISSING_NARRATIVE',
    severity: 'error',
    anchoredTo: 'settlement_orchestrator_impl',
    expectFire: true,
    scenario:
      'The settlement implementation explicitly declares detail: full, but its settleBatch method carries no narrative — the declared promise is unmet.',
    tree: {
      subsystems: [{ id: 'settlement', description: 'End-of-day payment settlement batches.' }],
      components: [
        {
          id: 'settlement-orchestrator',
          componentType: 'Orchestrator',
          description: 'Runs the end-of-day settlement batch.',
        },
      ],
      interfaces: [
        {
          id: 'isettlement_orchestrator',
          component: 'settlement-orchestrator',
          methods: [{ name: 'settleBatch', description: 'Settle the end-of-day batch of captured payments.' }],
        },
      ],
      implementations: [
        {
          id: 'settlement_orchestrator_impl',
          contract: 'isettlement_orchestrator',
          detail: 'full',
          methods: [{ name: 'settleBatch', narrative: [] }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MISSING_NARRATIVE',
    severity: 'warning',
    anchoredTo: 'refund_orchestrator_impl',
    expectFire: true,
    scenario:
      'The refund orchestrator inherits the full-detail floor from its Orchestrator stereotype, but issueRefund has no narrative — the defaulted floor surfaces as a warning.',
    tree: {
      subsystems: [{ id: 'refunds', description: 'Customer refund processing.' }],
      components: [
        {
          id: 'refund-orchestrator',
          componentType: 'Orchestrator',
          description: 'Processes customer refund requests.',
        },
      ],
      interfaces: [
        {
          id: 'irefund_orchestrator',
          component: 'refund-orchestrator',
          methods: [{ name: 'issueRefund', description: 'Refund the captured amount for a returned order.' }],
        },
      ],
      implementations: [
        {
          id: 'refund_orchestrator_impl',
          contract: 'irefund_orchestrator',
          methods: [{ name: 'issueRefund', narrative: [] }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MISSING_NARRATIVE',
    expectFire: false,
    reason: 'The full-detail method carries a real narrative, so the declared floor is met.',
    scenario:
      'The settlement implementation declares detail: full and settleBatch carries its step-by-step narrative.',
    tree: {
      subsystems: [{ id: 'settlement', description: 'End-of-day payment settlement batches.' }],
      components: [
        {
          id: 'settlement-orchestrator',
          componentType: 'Orchestrator',
          description: 'Runs the end-of-day settlement batch.',
        },
      ],
      interfaces: [
        {
          id: 'isettlement_orchestrator',
          component: 'settlement-orchestrator',
          methods: [{ name: 'settleBatch', description: 'Settle the end-of-day batch of captured payments.' }],
        },
      ],
      implementations: [
        {
          id: 'settlement_orchestrator_impl',
          contract: 'isettlement_orchestrator',
          detail: 'full',
          methods: [
            {
              name: 'settleBatch',
              narrative: [
                { stepNumber: 1, type: 'local', description: 'Collect the captured payments eligible for settlement.' },
                { stepNumber: 2, type: 'local', description: 'Net the batch per acquiring bank and build the transfer set.' },
                { stepNumber: 3, type: 'return', description: 'Report the batch settled.', outcome: 'success' },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // INTENT_FLOOR — stereotype default (warning) and explicit dial (error)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INTENT_FLOOR',
    severity: 'warning',
    anchoredTo: 'parcel_label_store_impl',
    expectFire: true,
    scenario:
      'The label store method has no narrative (intent is its Store stereotype default) and its only behavioral prose is the placeholder-thin contract description "Fetch one row."',
    tree: {
      subsystems: [{ id: 'labeling', description: 'Carrier label storage for outbound parcels.' }],
      components: [
        {
          id: 'parcel-label-store',
          componentType: 'Store',
          description: 'Stores generated carrier labels per parcel.',
          durability: 'read-through',
        },
      ],
      interfaces: [
        {
          id: 'iparcel_label_store',
          component: 'parcel-label-store',
          methods: [{ name: 'getLabel', description: 'Fetch one row.' }],
        },
      ],
      implementations: [
        {
          id: 'parcel_label_store_impl',
          contract: 'iparcel_label_store',
          methods: [{ name: 'getLabel', narrative: [] }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INTENT_FLOOR',
    severity: 'error',
    anchoredTo: 'chargeback_orchestrator_impl',
    expectFire: true,
    scenario:
      'The chargeback method is explicitly dialed to intent, but its stated intent is the placeholder "Refund quickly." — an explicit dial is held to its prose promise as an error.',
    tree: {
      subsystems: [{ id: 'chargebacks', description: 'Card chargeback handling.' }],
      components: [
        {
          id: 'chargeback-orchestrator',
          componentType: 'Orchestrator',
          description: 'Handles inbound card chargebacks.',
        },
      ],
      interfaces: [
        {
          id: 'ichargeback_orchestrator',
          component: 'chargeback-orchestrator',
          methods: [{ name: 'resolveChargeback', description: 'Resolve one inbound card chargeback case.' }],
        },
      ],
      implementations: [
        {
          id: 'chargeback_orchestrator_impl',
          contract: 'ichargeback_orchestrator',
          methods: [
            {
              name: 'resolveChargeback',
              detail: 'intent',
              intent: 'Refund quickly.',
              narrative: [],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INTENT_FLOOR',
    expectFire: false,
    reason: 'The intent prose states what the method does and how it fails, clearing the floor an implementer can be held to.',
    scenario:
      'The label store method specifies its behavior as substantive intent prose covering lookup, regeneration, and failure.',
    tree: {
      subsystems: [{ id: 'labeling', description: 'Carrier label storage for outbound parcels.' }],
      components: [
        {
          id: 'parcel-label-store',
          componentType: 'Store',
          description: 'Stores generated carrier labels per parcel.',
          durability: 'read-through',
        },
      ],
      interfaces: [
        {
          id: 'iparcel_label_store',
          component: 'parcel-label-store',
          methods: [{ name: 'getLabel', description: 'Fetch the stored carrier label for a parcel.' }],
        },
      ],
      implementations: [
        {
          id: 'parcel_label_store_impl',
          contract: 'iparcel_label_store',
          methods: [
            {
              name: 'getLabel',
              intent:
                'Fetches the stored carrier label PDF for a parcel by its id, returning a not-found outcome when no label was ever generated for it.',
              narrative: [],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNNARRATED_COMPLEXITY — real branching may not hide below detail: full
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNNARRATED_COMPLEXITY',
    severity: 'warning',
    anchoredTo: 'quota_ledger_store_impl',
    expectFire: true,
    scenario:
      'The quota store sits at its intent-level stereotype default with no narrative, but the realized applyCharge function measures cyclomatic complexity 10 — real branching hiding behind the dialed-down level.',
    tree: quotaLedgerTree(COMPLEX_QUOTA_SOURCE),
  }),
  defineRuleFixture({
    code: 'UNNARRATED_COMPLEXITY',
    expectFire: false,
    reason: 'The realized function is a simple clamp with complexity well under the threshold, so the intent level hides nothing.',
    scenario:
      'The quota store\'s realized applyCharge is a single-branch pass-through, comfortably below the unnarrated-complexity threshold.',
    tree: quotaLedgerTree(SIMPLE_QUOTA_SOURCE),
  }),

  // -------------------------------------------------------------------------
  // DETAIL_BELOW_STEREOTYPE — explicit dial below a logic stereotype's floor
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'DETAIL_BELOW_STEREOTYPE',
    severity: 'warning',
    anchoredTo: 'route_planner_impl',
    expectFire: true,
    scenario:
      'The route planner is an Orchestrator — a logic stereotype with a full narrative floor — yet planRoute is explicitly dialed down to calls-only with no narrative.',
    tree: {
      subsystems: [{ id: 'routing', description: 'Delivery route planning for the courier fleet.' }],
      components: [
        {
          id: 'route-planner',
          componentType: 'Orchestrator',
          description: 'Plans multi-stop delivery routes for couriers.',
        },
      ],
      interfaces: [
        {
          id: 'iroute_planner',
          component: 'route-planner',
          methods: [{ name: 'planRoute', description: 'Plan the multi-stop delivery route for one courier shift.' }],
        },
      ],
      implementations: [
        {
          id: 'route_planner_impl',
          contract: 'iroute_planner',
          methods: [
            {
              name: 'planRoute',
              detail: 'calls-only',
              intent:
                'Plans the multi-stop delivery route for one courier shift, ordering stops by delivery window and minimizing total drive time.',
              narrative: [],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'DETAIL_BELOW_STEREOTYPE',
    expectFire: false,
    reason:
      'The explicit dial sits on a Store method — a non-logic stereotype whose semantics are a contract paragraph, so dialing down is a normal choice, not a smell.',
    scenario:
      'The route cache Store explicitly dials its lookup method to intent with substantive prose, which is the normal shape for a data component.',
    tree: {
      subsystems: [{ id: 'routing', description: 'Delivery route planning for the courier fleet.' }],
      components: [
        {
          id: 'route-cache-store',
          componentType: 'Store',
          description: 'Caches planned routes per courier shift.',
          durability: 'cache',
        },
      ],
      interfaces: [
        {
          id: 'iroute_cache_store',
          component: 'route-cache-store',
          methods: [{ name: 'getPlannedRoute', description: 'Fetch the cached route plan for a courier shift.' }],
        },
      ],
      implementations: [
        {
          id: 'route_cache_store_impl',
          contract: 'iroute_cache_store',
          methods: [
            {
              name: 'getPlannedRoute',
              detail: 'intent',
              intent:
                'Fetches the cached route plan for a courier shift, returning a cache-miss outcome when the plan was evicted or never computed.',
              narrative: [],
            },
          ],
        },
      ],
    },
  }),
];
