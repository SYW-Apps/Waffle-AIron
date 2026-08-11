/**
 * Exemplar fixture pairs proving the harness end to end — the reference for
 * every family file. Each code gets a TRIGGERING fixture and a near-identical
 * CONTROL that must stay quiet for that code.
 *
 * Documented intents (the thing these fixtures pin — see README):
 *  - ORPHANED_SUBSYSTEM (hierarchy.ts, warning): "Subsystem does not reference
 *    the L0 system" — parentSystem is missing or names something other than
 *    the system's name (namespaced subproject subsystems are exempt).
 *  - MISSING_TARGET_COMPONENT (contracts.ts, error): a narrative call /
 *    dispatch / register step carries no `targetComponent`.
 */
import { defineRuleFixture } from '../harness.js';

export default [
  // -------------------------------------------------------------------------
  // ORPHANED_SUBSYSTEM
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ORPHANED_SUBSYSTEM',
    severity: 'warning',
    anchoredTo: 'billing',
    expectFire: true,
    scenario:
      'The billing subsystem still names the retired MerchantSuite platform as its parent, after the L0 system was renamed to CommerceOS.',
    tree: {
      system: { name: 'CommerceOS', vision: 'Order-to-cash commerce platform: catalog, checkout, billing, and settlement.' },
      subsystems: [
        {
          id: 'billing',
          description: 'Invoicing and payment collection for placed orders.',
          parentSystem: 'MerchantSuite',
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'ORPHANED_SUBSYSTEM',
    expectFire: false,
    reason: 'The subsystem references the L0 system by its current name, so it is properly parented.',
    scenario:
      'The billing subsystem correctly names CommerceOS, the current L0 system, as its parent.',
    tree: {
      system: { name: 'CommerceOS', vision: 'Order-to-cash commerce platform: catalog, checkout, billing, and settlement.' },
      subsystems: [
        {
          id: 'billing',
          description: 'Invoicing and payment collection for placed orders.',
          parentSystem: 'CommerceOS',
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // MISSING_TARGET_COMPONENT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MISSING_TARGET_COMPONENT',
    severity: 'error',
    anchoredTo: 'shipment_scheduler_impl',
    expectFire: true,
    scenario:
      'The shipment scheduler narrative calls out for carrier quotes but its call step names no targetComponent, leaving the collaborator edge unmodeled.',
    tree: {
      subsystems: [{ id: 'fulfillment', description: 'Parcel scheduling and carrier hand-off for placed orders.' }],
      components: [
        {
          id: 'shipment-scheduler',
          componentType: 'Orchestrator',
          subsystem: 'fulfillment',
          description: 'Plans each parcel pickup and books the cheapest eligible carrier.',
          dependsOn: ['carrier-quote-adapter'],
        },
        {
          id: 'carrier-quote-adapter',
          componentType: 'Adapter',
          subsystem: 'fulfillment',
          description: 'Wraps the external carrier rate APIs behind one quote interface.',
        },
      ],
      interfaces: [
        {
          id: 'ishipment_scheduler',
          component: 'shipment-scheduler',
          methods: [{ name: 'scheduleShipment', description: 'Book the cheapest eligible carrier for a parcel.' }],
        },
        {
          id: 'icarrier_quote_adapter',
          component: 'carrier-quote-adapter',
          methods: [{ name: 'fetchQuotes', description: 'Fetch current rate quotes from all connected carriers.' }],
        },
      ],
      implementations: [
        {
          id: 'shipment_scheduler_impl',
          contract: 'ishipment_scheduler',
          methods: [
            {
              name: 'scheduleShipment',
              narrative: [
                // The defect under test: a `call` step with no targetComponent.
                { stepNumber: 1, type: 'call', description: 'Fetch carrier quotes for the parcel.', targetMethod: 'fetchQuotes' },
                { stepNumber: 2, type: 'local', description: 'Pick the cheapest quote that meets the delivery window.' },
              ],
            },
          ],
        },
        {
          id: 'carrier_quote_adapter_impl',
          contract: 'icarrier_quote_adapter',
          methods: [
            {
              name: 'fetchQuotes',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Call each connected carrier rate API and merge the quotes.' }],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MISSING_TARGET_COMPONENT',
    expectFire: false,
    reason: 'The call step names its target component (a declared dependency), so the collaborator edge is fully modeled.',
    scenario:
      'The shipment scheduler narrative calls the carrier quote adapter with an explicit targetComponent on the call step.',
    tree: {
      subsystems: [{ id: 'fulfillment', description: 'Parcel scheduling and carrier hand-off for placed orders.' }],
      components: [
        {
          id: 'shipment-scheduler',
          componentType: 'Orchestrator',
          subsystem: 'fulfillment',
          description: 'Plans each parcel pickup and books the cheapest eligible carrier.',
          dependsOn: ['carrier-quote-adapter'],
        },
        {
          id: 'carrier-quote-adapter',
          componentType: 'Adapter',
          subsystem: 'fulfillment',
          description: 'Wraps the external carrier rate APIs behind one quote interface.',
        },
      ],
      interfaces: [
        {
          id: 'ishipment_scheduler',
          component: 'shipment-scheduler',
          methods: [{ name: 'scheduleShipment', description: 'Book the cheapest eligible carrier for a parcel.' }],
        },
        {
          id: 'icarrier_quote_adapter',
          component: 'carrier-quote-adapter',
          methods: [{ name: 'fetchQuotes', description: 'Fetch current rate quotes from all connected carriers.' }],
        },
      ],
      implementations: [
        {
          id: 'shipment_scheduler_impl',
          contract: 'ishipment_scheduler',
          methods: [
            {
              name: 'scheduleShipment',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Fetch carrier quotes for the parcel.',
                  targetComponent: 'carrier-quote-adapter',
                  targetMethod: 'fetchQuotes',
                },
                { stepNumber: 2, type: 'local', description: 'Pick the cheapest quote that meets the delivery window.' },
              ],
            },
          ],
        },
        {
          id: 'carrier_quote_adapter_impl',
          contract: 'icarrier_quote_adapter',
          methods: [
            {
              name: 'fetchQuotes',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Call each connected carrier rate API and merge the quotes.' }],
            },
          ],
        },
      ],
    },
  }),
];
