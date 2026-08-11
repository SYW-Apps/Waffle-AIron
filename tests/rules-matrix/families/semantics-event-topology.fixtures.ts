/**
 * Event-topology family (src/core/rules/event-topology.ts): bipartite
 * completeness of the declared pub/sub graph. Every emitted topic (emits
 * declarations, MessageBus publish endpoints) needs at least one subscriber
 * (subscribesTo declarations, MessageBus subscribe endpoints) and vice versa;
 * pairing is by exact topic name. Trees with no event edges see nothing.
 */
import { defineRuleFixture } from '../harness.js';

export default [
  // -------------------------------------------------------------------------
  // UNCONSUMED_TOPIC
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNCONSUMED_TOPIC',
    severity: 'warning',
    anchoredTo: 'fulfillment-orchestrator',
    expectFire: true,
    scenario:
      'The fulfillment orchestrator emits shipment.dispatched, but nothing in the tree subscribes to the topic — the event goes nowhere.',
    tree: {
      subsystems: [{ id: 'fulfillment', description: 'Parcel dispatch and shipment tracking.' }],
      components: [
        {
          id: 'fulfillment-orchestrator',
          componentType: 'Orchestrator',
          description: 'Dispatches parcels and announces shipment events.',
          emits: [{ topic: 'shipment.dispatched', event: 'ShipmentDispatched', description: 'A parcel left the warehouse.' }],
        },
        {
          id: 'tracking-observer',
          componentType: 'Observer',
          description: 'Feeds shipment progress into customer tracking.',
        },
      ],
      interfaces: [
        {
          id: 'ifulfillment_orchestrator',
          component: 'fulfillment-orchestrator',
          methods: [{ name: 'dispatchParcel', description: 'Dispatch a packed parcel with the booked carrier.' }],
        },
        {
          id: 'itracking_observer',
          component: 'tracking-observer',
          methods: [{ name: 'onShipmentEvent', description: 'Fold a shipment event into the tracking timeline.' }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNCONSUMED_TOPIC',
    expectFire: false,
    reason: 'The tracking observer subscribes to the exact emitted topic, so the event has a consumer.',
    scenario:
      'The tracking observer subscribes to shipment.dispatched, pairing the fulfillment orchestrator\'s emission.',
    tree: {
      subsystems: [{ id: 'fulfillment', description: 'Parcel dispatch and shipment tracking.' }],
      components: [
        {
          id: 'fulfillment-orchestrator',
          componentType: 'Orchestrator',
          description: 'Dispatches parcels and announces shipment events.',
          emits: [{ topic: 'shipment.dispatched', event: 'ShipmentDispatched', description: 'A parcel left the warehouse.' }],
        },
        {
          id: 'tracking-observer',
          componentType: 'Observer',
          description: 'Feeds shipment progress into customer tracking.',
          subscribesTo: [{ topic: 'shipment.dispatched', event: 'ShipmentDispatched', description: 'Track dispatched parcels.' }],
        },
      ],
      interfaces: [
        {
          id: 'ifulfillment_orchestrator',
          component: 'fulfillment-orchestrator',
          methods: [{ name: 'dispatchParcel', description: 'Dispatch a packed parcel with the booked carrier.' }],
        },
        {
          id: 'itracking_observer',
          component: 'tracking-observer',
          methods: [{ name: 'onShipmentEvent', description: 'Fold a shipment event into the tracking timeline.' }],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNSOURCED_SUBSCRIPTION
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNSOURCED_SUBSCRIPTION',
    severity: 'warning',
    anchoredTo: 'revenue-analytics-observer',
    expectFire: true,
    scenario:
      'The revenue analytics observer subscribes to payment.captured, but nothing in the tree emits that topic — the handler can never fire from inside the system.',
    tree: {
      subsystems: [{ id: 'revenue-analytics', description: 'Revenue reporting from payment events.' }],
      components: [
        {
          id: 'revenue-analytics-observer',
          componentType: 'Observer',
          description: 'Folds captured payments into the revenue rollup.',
          subscribesTo: [{ topic: 'payment.captured', event: 'PaymentCaptured', description: 'Count captured revenue.' }],
        },
      ],
      interfaces: [
        {
          id: 'irevenue_analytics_observer',
          component: 'revenue-analytics-observer',
          methods: [{ name: 'onPaymentCaptured', description: 'Fold a captured payment into the revenue rollup.' }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNSOURCED_SUBSCRIPTION',
    expectFire: false,
    reason: 'The payment orchestrator emits the exact subscribed topic, so the subscription has a source.',
    scenario:
      'The payment orchestrator declares that it emits payment.captured, sourcing the analytics observer\'s subscription.',
    tree: {
      subsystems: [{ id: 'revenue-analytics', description: 'Revenue reporting from payment events.' }],
      components: [
        {
          id: 'payment-orchestrator',
          componentType: 'Orchestrator',
          description: 'Captures authorized payments and announces the outcome.',
          emits: [{ topic: 'payment.captured', event: 'PaymentCaptured', description: 'A payment was captured.' }],
        },
        {
          id: 'revenue-analytics-observer',
          componentType: 'Observer',
          description: 'Folds captured payments into the revenue rollup.',
          subscribesTo: [{ topic: 'payment.captured', event: 'PaymentCaptured', description: 'Count captured revenue.' }],
        },
      ],
      interfaces: [
        {
          id: 'ipayment_orchestrator',
          component: 'payment-orchestrator',
          methods: [{ name: 'capturePayment', description: 'Capture the authorized amount for an order.' }],
        },
        {
          id: 'irevenue_analytics_observer',
          component: 'revenue-analytics-observer',
          methods: [{ name: 'onPaymentCaptured', description: 'Fold a captured payment into the revenue rollup.' }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNSOURCED_SUBSCRIPTION',
    expectFire: false,
    reason:
      'A MessageBus publish endpoint counts into the same topic pairing as an emits declaration, so the subscription is sourced by the portal\'s wire binding.',
    scenario:
      'The payment events portal publishes payment.captured through a MessageBus endpoint, sourcing the analytics observer\'s subscription.',
    tree: {
      subsystems: [{ id: 'revenue-analytics', description: 'Revenue reporting from payment events.' }],
      components: [
        {
          id: 'payment-events-portal',
          componentType: 'Portal',
          portalType: 'MessageBus',
          description: 'Publishes payment lifecycle events onto the bus.',
        },
        {
          id: 'revenue-analytics-observer',
          componentType: 'Observer',
          description: 'Folds captured payments into the revenue rollup.',
          subscribesTo: [{ topic: 'payment.captured', event: 'PaymentCaptured', description: 'Count captured revenue.' }],
        },
      ],
      interfaces: [
        {
          id: 'ipayment_events_portal',
          component: 'payment-events-portal',
          methods: [
            {
              name: 'announcePaymentCaptured',
              description: 'Publish the captured-payment event onto the bus.',
              endpoint: {
                transport: 'MessageBus',
                topic: 'payment.captured',
                event: 'PaymentCaptured',
                direction: 'publish',
              },
            },
          ],
        },
        {
          id: 'irevenue_analytics_observer',
          component: 'revenue-analytics-observer',
          methods: [{ name: 'onPaymentCaptured', description: 'Fold a captured payment into the revenue rollup.' }],
        },
      ],
    },
  }),
];
