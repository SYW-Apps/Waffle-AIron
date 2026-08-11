/**
 * Untyped-seam family (src/core/rules/semantic-edges.ts, untypedSeamRule):
 * methods on a subsystem's PUBLISHED components should not take or return
 * bare Json/any/unknown — cross-subsystem contracts are the swap seam and
 * must be typed. Generic-dispatch portals carry per-capability types via
 * their dispatch table instead (the documented exemption).
 */
import { defineRuleFixture } from '../harness.js';

export default [
  defineRuleFixture({
    code: 'UNTYPED_SEAM',
    severity: 'warning',
    anchoredTo: 'iorder_intake_portal',
    expectFire: true,
    scenario:
      'The published order-intake portal accepts a bare Json payload on submitOrder, crossing the storefront\'s public surface untyped.',
    tree: {
      subsystems: [
        {
          id: 'storefront',
          description: 'Customer-facing shop: order intake.',
          publicInterfaces: [
            { type: 'REST', details: 'Public order intake API for the storefront.', component: 'order-intake-portal' },
          ],
        },
      ],
      components: [
        {
          id: 'order-intake-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Public HTTP entry for order submission.',
        },
      ],
      interfaces: [
        {
          id: 'iorder_intake_portal',
          component: 'order-intake-portal',
          methods: [
            {
              name: 'submitOrder',
              description: 'Accept a new order submission from a storefront client.',
              params: [{ name: 'payload', type: 'Json' }],
              returns: 'Promise<string>',
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNTYPED_SEAM',
    expectFire: false,
    reason: 'The published method takes a defined OrderRequest value object, so the boundary contract is typed.',
    scenario:
      'The published order-intake portal accepts a typed OrderRequest on submitOrder, keeping the public seam checkable.',
    tree: {
      subsystems: [
        {
          id: 'storefront',
          description: 'Customer-facing shop: order intake.',
          publicInterfaces: [
            { type: 'REST', details: 'Public order intake API for the storefront.', component: 'order-intake-portal' },
          ],
        },
      ],
      components: [
        {
          id: 'order-intake-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Public HTTP entry for order submission.',
        },
      ],
      interfaces: [
        {
          id: 'iorder_intake_portal',
          component: 'order-intake-portal',
          methods: [
            {
              name: 'submitOrder',
              description: 'Accept a new order submission from a storefront client.',
              params: [{ name: 'order', type: 'OrderRequest' }],
              returns: 'Promise<string>',
            },
          ],
        },
      ],
      types: [
        {
          id: 'order-request',
          name: 'OrderRequest',
          kind: 'value-object',
          description: 'A customer\'s order submission: cart lines and delivery preferences.',
          fields: [
            { name: 'cartId', type: 'string', description: 'The cart being ordered.' },
            { name: 'deliveryWindow', type: 'string', description: 'Requested delivery window.' },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNTYPED_SEAM',
    expectFire: false,
    reason:
      'A generic-dispatch portal\'s untyped envelope is the sanctioned pattern once it carries a dispatch table — the per-capability typing lives in the table.',
    scenario:
      'The published order-intake portal keeps a generic Json envelope but carries a dispatch table binding the order.submit capability, which is where the typing lives.',
    tree: {
      subsystems: [
        {
          id: 'storefront',
          description: 'Customer-facing shop: order intake.',
          publicInterfaces: [
            { type: 'REST', details: 'Public order intake API for the storefront.', component: 'order-intake-portal' },
          ],
        },
      ],
      components: [
        {
          id: 'order-intake-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Generic public portal dispatching order capabilities inward.',
          dependsOn: ['order-workflow'],
          dispatch: [
            { capability: 'order.submit', component: 'order-workflow', method: 'startOrder', description: 'Start the order placement workflow.' },
          ],
        },
        {
          id: 'order-workflow',
          componentType: 'Orchestrator',
          description: 'Drives order placement from a validated submission.',
        },
      ],
      interfaces: [
        {
          id: 'iorder_intake_portal',
          component: 'order-intake-portal',
          methods: [
            {
              name: 'submitOrder',
              description: 'Accept a capability envelope from a storefront client.',
              params: [{ name: 'payload', type: 'Json' }],
              returns: 'Promise<string>',
            },
          ],
        },
        {
          id: 'iorder_workflow',
          component: 'order-workflow',
          methods: [{ name: 'startOrder', description: 'Start the order placement workflow for a validated submission.' }],
        },
      ],
    },
  }),
];
