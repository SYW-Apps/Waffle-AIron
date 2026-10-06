/**
 * Reachability fixtures — what reaches each Portal verb, and from where
 * (docs/design/reachability.md). The rules pinned here:
 *
 *  - unused-detection (src/core/rules/wiring/unused-detection.ts): a Portal is
 *    no longer a root of its own, so a Portal verb no modelled caller reaches
 *    and nobody declared an entry for is UNUSED_METHOD / UNUSED_COMPONENT.
 *  - entry-declarations (src/core/rules/wiring/entry-declarations.ts):
 *    ENTRY_ON_NON_PORTAL (an entry belongs to a Portal verb),
 *    ENTRY_SCOPE_NOT_NETWORK (a scope only means something on a network
 *    transport), INVOKED_BY_RETIRED_KIND (external / sibling-subsystem, read
 *    compatibly for one release).
 *  - network-boundaries (src/core/rules/wiring/network-boundaries.ts), over a
 *    project that declares `network` in its project.yaml: GATEWAY_BYPASSED
 *    (only a gateway Portal is entered from outside the network),
 *    MULTIPLE_GATEWAYS (allowed, not recommended), EXPORT_BEYOND_NETWORK (an
 *    export wider than project needs the outermost gateway entered from
 *    outside).
 *  - unused-types: a type an export table names is used by definition.
 *
 * The scenario throughout is an order-processing platform: a storefront that
 * shoppers reach over HTTP, and the services behind it.
 */
import * as yaml from 'js-yaml';
import { BASE_FIXTURE_RULES, defineRuleFixture, type FixtureSpecInput, type FixtureTree } from '../harness.js';

const TS = '2026-01-01T00:00:00.000Z';

const SYSTEM = {
  name: 'OrderPlatform',
  vision: 'Order processing for a web shop: a storefront shoppers reach, and the services that settle and ship orders.',
};

const ORDERS_SUB = { id: 'orders', description: 'Order intake and settlement for the web shop.' };

/** The project.yaml the harness writes, plus a network declaration. */
function networkProject(network: boolean | { description: string }): Record<string, string> {
  return {
    '.wai/project.yaml': yaml.dump({
      schemaVersion: '1.0.0',
      name: 'order-platform',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: BASE_FIXTURE_RULES,
      extensions: { packs: [], useGlobalPacks: false },
      network,
      createdAt: TS,
      updatedAt: TS,
    }, { noRefs: true, lineWidth: 200 }),
  };
}

const SHOPPERS = 'Shoppers\' browsers and the mobile app, over the public internet.';
const SIBLINGS = 'The settlement and shipping services inside the order network.';

/** An HTTP Portal of the orders subsystem with one verb, its entry and variant as a scenario sets them. */
function httpPortal(id: string, opts: { variant?: string; entry?: Record<string, unknown> } = {}): FixtureSpecInput {
  return {
    id,
    componentType: 'Portal',
    transport: 'HTTP',
    subsystem: 'orders',
    description: `HTTP surface ${id} of the order platform.`,
    ...(opts.variant ? { variant: opts.variant } : {}),
    ...(opts.entry ? { invokedBy: opts.entry } : {}),
  };
}

function httpContract(portal: string, verb: string, path: string): FixtureSpecInput {
  return {
    id: `i${portal.replace(/-/g, '_')}`,
    component: portal,
    methods: [{ name: verb, description: `Serve ${verb} for shoppers.`, endpoint: { transport: 'HTTP', method: 'POST', path } }],
  };
}

/** A storefront project with one or two HTTP Portals, optionally inside a declared network. */
function storefront(o: {
  network?: boolean;
  portals: { id: string; verb: string; path: string; variant?: string; entry?: Record<string, unknown> }[];
  system?: Record<string, unknown>;
  publicInterfaces?: Record<string, unknown>[];
}): FixtureTree {
  return {
    system: { ...SYSTEM, ...(o.system ?? {}) },
    subsystems: [{ ...ORDERS_SUB, ...(o.publicInterfaces ? { publicInterfaces: o.publicInterfaces } : {}) }],
    components: o.portals.map((p) => httpPortal(p.id, { variant: p.variant, entry: p.entry })),
    interfaces: o.portals.map((p) => httpContract(p.id, p.verb, p.path)),
    ...(o.network ? { files: networkProject(true) } : {}),
  };
}

export default [
  // -------------------------------------------------------------------------
  // UNUSED_METHOD / UNUSED_COMPONENT — a Portal verb must be reached
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNUSED_METHOD',
    severity: 'warning',
    anchoredTo: 'icheckout_portal',
    expectFire: true,
    scenario:
      'The checkout portal declares an entry on placeOrder for shoppers, but its refundOrder verb has neither an entry nor a modelled caller, so nothing reaches it.',
    tree: {
      system: SYSTEM,
      subsystems: [ORDERS_SUB],
      components: [httpPortal('checkout-portal')],
      interfaces: [{
        id: 'icheckout_portal',
        component: 'checkout-portal',
        methods: [
          { name: 'placeOrder', description: 'Place an order from the cart.', endpoint: { transport: 'HTTP', method: 'POST', path: '/orders' }, invokedBy: { kind: 'entry', caller: SHOPPERS } },
          { name: 'refundOrder', description: 'Refund a settled order.', endpoint: { transport: 'HTTP', method: 'POST', path: '/orders/{id}/refund' } },
        ],
      }],
    },
  }),
  defineRuleFixture({
    code: 'UNUSED_METHOD',
    expectFire: false,
    reason: 'An entry declared once on the Portal is the entry every verb inherits, so both verbs are reached by the callers outside the design.',
    scenario: 'The checkout portal declares one Portal-level entry for shoppers, which both placeOrder and refundOrder inherit.',
    tree: {
      system: SYSTEM,
      subsystems: [ORDERS_SUB],
      components: [httpPortal('checkout-portal', { entry: { kind: 'entry', caller: SHOPPERS } })],
      interfaces: [{
        id: 'icheckout_portal',
        component: 'checkout-portal',
        methods: [
          { name: 'placeOrder', description: 'Place an order from the cart.', endpoint: { transport: 'HTTP', method: 'POST', path: '/orders' } },
          { name: 'refundOrder', description: 'Refund a settled order.', endpoint: { transport: 'HTTP', method: 'POST', path: '/orders/{id}/refund' } },
        ],
      }],
    },
  }),
  defineRuleFixture({
    code: 'UNUSED_COMPONENT',
    severity: 'warning',
    anchoredTo: 'checkout-portal',
    expectFire: true,
    scenario:
      'The checkout portal binds HTTP routes but declares no entry and no component calls it, so the whole surface is reached by nothing the design knows of.',
    tree: storefront({ portals: [{ id: 'checkout-portal', verb: 'placeOrder', path: '/orders' }] }),
  }),
  defineRuleFixture({
    code: 'UNUSED_COMPONENT',
    expectFire: false,
    reason: 'The Portal declares the entry its outside callers take, which roots the reachability walk at its verbs.',
    scenario: 'The checkout portal declares that shoppers enter it over HTTP.',
    tree: storefront({ portals: [{ id: 'checkout-portal', verb: 'placeOrder', path: '/orders', entry: { kind: 'entry', caller: SHOPPERS } }] }),
  }),

  // A MessageBus subscribe verb is reached by its topic when the tree emits it.
  defineRuleFixture({
    code: 'UNUSED_COMPONENT',
    expectFire: false,
    reason: 'The payments portal emits orders.paid, so the topic reaches the intake portal\'s subscribe verb the way an Observer\'s subscription is reached: no entry is needed for it.',
    scenario: 'The fulfilment intake portal subscribes to orders.paid on the message bus, and the payments portal (entered by shoppers) emits that topic.',
    tree: {
      system: SYSTEM,
      subsystems: [ORDERS_SUB],
      components: [
        { ...httpPortal('payments-portal', { entry: { kind: 'entry', caller: SHOPPERS } }), emits: [{ topic: 'orders.paid', event: 'OrderPaid' }] },
        { id: 'fulfilment-intake', componentType: 'Portal', transport: 'MessageBus', subsystem: 'orders', description: 'Takes paid orders off the message bus for fulfilment.' },
      ],
      interfaces: [
        httpContract('payments-portal', 'pay', '/payments'),
        {
          id: 'ifulfilment_intake',
          component: 'fulfilment-intake',
          methods: [{ name: 'onOrderPaid', description: 'Start fulfilment of a paid order.', endpoint: { transport: 'MessageBus', topic: 'orders.paid', event: 'OrderPaid', direction: 'subscribe' } }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNUSED_COMPONENT',
    severity: 'warning',
    anchoredTo: 'fulfilment-intake',
    expectFire: true,
    scenario:
      'The fulfilment intake portal subscribes to orders.paid, but nothing in the tree emits that topic and the Portal declares no entry for an outside publisher, so nothing reaches it.',
    tree: {
      system: SYSTEM,
      subsystems: [ORDERS_SUB],
      components: [
        { id: 'fulfilment-intake', componentType: 'Portal', transport: 'MessageBus', subsystem: 'orders', description: 'Takes paid orders off the message bus for fulfilment.' },
      ],
      interfaces: [{
        id: 'ifulfilment_intake',
        component: 'fulfilment-intake',
        methods: [{ name: 'onOrderPaid', description: 'Start fulfilment of a paid order.', endpoint: { transport: 'MessageBus', topic: 'orders.paid', event: 'OrderPaid', direction: 'subscribe' } }],
      }],
    },
  }),

  // -------------------------------------------------------------------------
  // INVOKED_BY_UNDESCRIBED on a Portal-level entry
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVOKED_BY_UNDESCRIBED',
    severity: 'warning',
    anchoredTo: 'checkout-portal',
    expectFire: true,
    scenario:
      'The checkout portal declares one Portal-level entry every verb inherits, but its caller prose is a placeholder, so nobody reviewing it can tell who reaches the Portal.',
    tree: storefront({ portals: [{ id: 'checkout-portal', verb: 'placeOrder', path: '/orders', entry: { kind: 'entry', caller: 'tbd' } }] }),
  }),
  defineRuleFixture({
    code: 'INVOKED_BY_UNDESCRIBED',
    expectFire: false,
    reason: 'The Portal-level entry names who reaches the Portal and how, which is what keeps the claim reviewable.',
    scenario: 'The checkout portal declares one Portal-level entry for shoppers\' browsers and the mobile app.',
    tree: storefront({ portals: [{ id: 'checkout-portal', verb: 'placeOrder', path: '/orders', entry: { kind: 'entry', caller: SHOPPERS } }] }),
  }),

  // -------------------------------------------------------------------------
  // ENTRY_ON_NON_PORTAL
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ENTRY_ON_NON_PORTAL',
    severity: 'error',
    anchoredTo: 'isettlement_orchestrator',
    expectFire: true,
    scenario:
      'The settlement orchestrator declares its nightly settle method an entry, as if callers outside the design reached an Orchestrator directly.',
    tree: {
      system: SYSTEM,
      subsystems: [ORDERS_SUB],
      components: [{ id: 'settlement-orchestrator', description: 'Settles the day\'s captured payments.' }],
      interfaces: [{
        id: 'isettlement_orchestrator',
        component: 'settlement-orchestrator',
        methods: [{ name: 'settleDay', description: 'Settle the day\'s payments.', invokedBy: { kind: 'entry', caller: 'The payment provider\'s settlement webhook.' } }],
      }],
    },
  }),
  defineRuleFixture({
    code: 'ENTRY_ON_NON_PORTAL',
    expectFire: false,
    reason: 'The nightly scheduler is the process\'s own runtime, so a runtime declaration is the right kind on an Orchestrator.',
    scenario: 'The settlement orchestrator declares that the nightly scheduler of its own process calls settleDay.',
    tree: {
      system: SYSTEM,
      subsystems: [ORDERS_SUB],
      components: [{ id: 'settlement-orchestrator', description: 'Settles the day\'s captured payments.' }],
      interfaces: [{
        id: 'isettlement_orchestrator',
        component: 'settlement-orchestrator',
        methods: [{ name: 'settleDay', description: 'Settle the day\'s payments.', invokedBy: { kind: 'runtime', caller: 'The process\'s nightly scheduler at 02:00.' } }],
      }],
    },
  }),

  // -------------------------------------------------------------------------
  // ENTRY_SCOPE_NOT_NETWORK
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ENTRY_SCOPE_NOT_NETWORK',
    severity: 'warning',
    anchoredTo: 'ops-cli',
    expectFire: true,
    scenario:
      'The operations command line declares its entry network-scoped, but a CLI is entered on one host and crosses no network.',
    tree: {
      system: SYSTEM,
      subsystems: [ORDERS_SUB],
      components: [{
        id: 'ops-cli', componentType: 'Portal', transport: 'CLI', description: 'Command line operators run on the order host.',
        invokedBy: { kind: 'entry', scope: 'network', caller: 'Operators on the order host.' },
      }],
      interfaces: [{ id: 'iops_cli', component: 'ops-cli', methods: [{ name: 'replayOrder', description: 'Replay one order.', endpoint: { transport: 'CLI', command: 'orders replay' } }] }],
    },
  }),
  defineRuleFixture({
    code: 'ENTRY_SCOPE_NOT_NETWORK',
    expectFire: false,
    reason: 'An HTTP Portal is entered over the network, so saying its callers come from inside the network means something.',
    scenario: 'The internal settlement API declares a network-scoped entry: only sibling services inside the order network call it over HTTP.',
    tree: storefront({ portals: [{ id: 'settlement-api', verb: 'settle', path: '/settle', entry: { kind: 'entry', scope: 'network', caller: SIBLINGS } }] }),
  }),

  // -------------------------------------------------------------------------
  // INVOKED_BY_RETIRED_KIND
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVOKED_BY_RETIRED_KIND',
    severity: 'warning',
    anchoredTo: 'isettlement_orchestrator',
    expectFire: true,
    scenario:
      'The settlement orchestrator still declares invokedBy kind external from before the reachability model, which reads it as runtime for one release.',
    tree: {
      system: SYSTEM,
      subsystems: [ORDERS_SUB],
      components: [{ id: 'settlement-orchestrator', description: 'Settles the day\'s captured payments.' }],
      interfaces: [{
        id: 'isettlement_orchestrator',
        component: 'settlement-orchestrator',
        methods: [{ name: 'settleDay', description: 'Settle the day\'s payments.', invokedBy: { kind: 'external', caller: 'The process\'s nightly scheduler at 02:00.' } }],
      }],
    },
  }),
  defineRuleFixture({
    code: 'INVOKED_BY_RETIRED_KIND',
    expectFire: false,
    reason: 'runtime is one of the two kinds the reachability model keeps, so nothing is read compatibly.',
    scenario: 'The settlement orchestrator declares invokedBy kind runtime for its nightly scheduler.',
    tree: {
      system: SYSTEM,
      subsystems: [ORDERS_SUB],
      components: [{ id: 'settlement-orchestrator', description: 'Settles the day\'s captured payments.' }],
      interfaces: [{
        id: 'isettlement_orchestrator',
        component: 'settlement-orchestrator',
        methods: [{ name: 'settleDay', description: 'Settle the day\'s payments.', invokedBy: { kind: 'runtime', caller: 'The process\'s nightly scheduler at 02:00.' } }],
      }],
    },
  }),

  // -------------------------------------------------------------------------
  // GATEWAY_BYPASSED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'GATEWAY_BYPASSED',
    severity: 'error',
    anchoredTo: 'settlement-api',
    expectFire: true,
    scenario:
      'The order platform declares a network, but its internal settlement API (no gateway) takes an entry from outside it, so shoppers would reach it without passing the storefront gateway.',
    tree: storefront({
      network: true,
      portals: [
        { id: 'storefront-gateway', verb: 'placeOrder', path: '/orders', variant: 'gateway', entry: { kind: 'entry', caller: SHOPPERS } },
        { id: 'settlement-api', verb: 'settle', path: '/settle', entry: { kind: 'entry', caller: SHOPPERS } },
      ],
    }),
  }),
  defineRuleFixture({
    code: 'GATEWAY_BYPASSED',
    expectFire: false,
    reason: 'Inside the network only the gateway takes outside entries; the settlement API is entered by sibling services from inside the network.',
    scenario: 'The storefront gateway takes the shoppers\' entries, and the settlement API declares a network-scoped entry for the sibling services.',
    tree: storefront({
      network: true,
      portals: [
        { id: 'storefront-gateway', verb: 'placeOrder', path: '/orders', variant: 'gateway', entry: { kind: 'entry', caller: SHOPPERS } },
        { id: 'settlement-api', verb: 'settle', path: '/settle', entry: { kind: 'entry', scope: 'network', caller: SIBLINGS } },
      ],
    }),
  }),
  defineRuleFixture({
    code: 'GATEWAY_BYPASSED',
    expectFire: false,
    reason: 'A project that declares no network has no boundary to bypass: any Portal may take an outside entry.',
    scenario: 'A simple shop with no declared network lets shoppers enter its settlement API directly.',
    tree: storefront({ portals: [{ id: 'settlement-api', verb: 'settle', path: '/settle', entry: { kind: 'entry', caller: SHOPPERS } }] }),
  }),

  // -------------------------------------------------------------------------
  // MULTIPLE_GATEWAYS
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MULTIPLE_GATEWAYS',
    severity: 'notice',
    expectFire: true,
    scenario: 'The order network has two gateways taking shoppers\' entries: the storefront gateway and a separate mobile gateway.',
    tree: storefront({
      network: true,
      portals: [
        { id: 'storefront-gateway', verb: 'placeOrder', path: '/orders', variant: 'gateway', entry: { kind: 'entry', caller: SHOPPERS } },
        { id: 'mobile-gateway', verb: 'placeMobileOrder', path: '/mobile/orders', variant: 'gateway', entry: { kind: 'entry', caller: SHOPPERS } },
      ],
    }),
  }),
  defineRuleFixture({
    code: 'MULTIPLE_GATEWAYS',
    expectFire: false,
    reason: 'One gateway is the recommended front door of a network.',
    scenario: 'The order network has a single storefront gateway taking every shopper entry.',
    tree: storefront({
      network: true,
      portals: [{ id: 'storefront-gateway', verb: 'placeOrder', path: '/orders', variant: 'gateway', entry: { kind: 'entry', caller: SHOPPERS } }],
    }),
  }),

  // -------------------------------------------------------------------------
  // EXPORT_BEYOND_NETWORK
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EXPORT_BEYOND_NETWORK',
    severity: 'warning',
    anchoredTo: 'settlement-api',
    expectFire: true,
    scenario:
      'The order platform exports its internal settlement API to external partners, but the API sits inside the order network and is entered only by sibling services, so no partner can reach it.',
    tree: storefront({
      network: true,
      portals: [{ id: 'settlement-api', verb: 'settle', path: '/settle', entry: { kind: 'entry', scope: 'network', caller: SIBLINGS } }],
      publicInterfaces: [{ component: 'settlement-api', details: 'Settle captured payments.' }],
      system: { publicInterfaces: [{ from: 'orders', component: 'settlement-api', as: 'settlement', audience: 'external' }] },
    }),
  }),
  defineRuleFixture({
    code: 'EXPORT_BEYOND_NETWORK',
    expectFire: false,
    reason: 'The exported Portal is the network\'s gateway entered from outside, which is exactly where callers beyond the network land.',
    scenario: 'The order platform exports its storefront gateway, entered by shoppers from outside the network, to external partners.',
    tree: storefront({
      network: true,
      portals: [{ id: 'storefront-gateway', verb: 'placeOrder', path: '/orders', variant: 'gateway', entry: { kind: 'entry', caller: SHOPPERS } }],
      publicInterfaces: [{ component: 'storefront-gateway', details: 'Place orders.' }],
      system: { publicInterfaces: [{ from: 'orders', component: 'storefront-gateway', as: 'storefront', audience: 'external' }] },
    }),
  }),
  defineRuleFixture({
    code: 'EXPORT_BEYOND_NETWORK',
    expectFire: false,
    reason: 'An export at audience project is designed against only inside the family, so the network is no obstacle to its consumers.',
    scenario: 'The order platform exports its internal settlement API to the projects of its own family only.',
    tree: storefront({
      network: true,
      portals: [{ id: 'settlement-api', verb: 'settle', path: '/settle', entry: { kind: 'entry', scope: 'network', caller: SIBLINGS } }],
      publicInterfaces: [{ component: 'settlement-api', details: 'Settle captured payments.' }],
      system: { publicInterfaces: [{ from: 'orders', component: 'settlement-api', as: 'settlement', audience: 'project' }] },
    }),
  }),

  // -------------------------------------------------------------------------
  // UNUSED_TYPE — an exported type is used by definition
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNUSED_TYPE',
    expectFire: false,
    reason: 'A type an export table names is used by its consumers, who are outside this tree: it is used by definition.',
    scenario: 'The orders subsystem exports its order receipt type for the shop\'s partners, and nothing inside the platform names it.',
    tree: {
      system: SYSTEM,
      subsystems: [{ ...ORDERS_SUB, publicInterfaces: [{ typeDef: 'order-receipt' }] }],
      types: [{ id: 'order-receipt', subsystem: 'orders', kind: 'value-object', fields: [{ name: 'orderId', type: 'string' }] }],
    },
  }),
  defineRuleFixture({
    code: 'UNUSED_TYPE',
    severity: 'warning',
    anchoredTo: 'order-receipt',
    expectFire: true,
    scenario: 'The orders subsystem defines an order receipt type that no field, signature or export table names.',
    tree: {
      system: SYSTEM,
      subsystems: [ORDERS_SUB],
      types: [{ id: 'order-receipt', subsystem: 'orders', kind: 'value-object', fields: [{ name: 'orderId', type: 'string' }] }],
    },
  }),
];
