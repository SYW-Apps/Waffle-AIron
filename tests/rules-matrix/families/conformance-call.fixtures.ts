/**
 * Call-step realization (code↔spec Level 3, the opener) —
 * src/core/rules/call-conformance.ts.
 *
 * Documented intent pinned here (rule description + module doc comment +
 * the narrative step-type vocabulary in src/models/specs.ts):
 *  - CALL_STEP_UNREALIZED (warning): every narrative `call` step of an
 *    exactly-analyzed method must appear among the realized function's
 *    callees — matched by the target method's contract name OR any per-method
 *    `symbol` override a target-side implementation declares, closed
 *    transitively over same-file named helpers (extract-helper refactors stay
 *    clean). Set membership only; order/arguments/conditions unverified.
 *    `register` steps are a reachability edge, "never an invocation"
 *    (step-type vocabulary), so they are exempt — only `call` steps are held
 *    to realization.
 */
import { defineRuleFixture } from '../harness.js';

export default [
  // -------------------------------------------------------------------------
  // CALL_STEP_UNREALIZED — fire 1: the narrated call was dropped in a refactor
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    severity: 'warning',
    anchoredTo: 'shipment_scheduler_impl',
    expectFire: true,
    scenario:
      'The shipment scheduler narrative says it calls the carrier quote adapter for quotes, but a refactor dropped the call — the realized function never invokes fetchQuotes.',
    tree: {
      subsystems: [{ id: 'fulfillment', description: 'Parcel scheduling and carrier hand-off.' }],
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
          sourcePath: 'src/fulfillment/shipment-scheduler.ts',
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
          sourcePath: 'src/fulfillment/carrier-quote-adapter.ts',
          methods: [
            {
              name: 'fetchQuotes',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Call each connected carrier rate API and merge the quotes.' }],
            },
          ],
        },
      ],
      files: {
        'src/fulfillment/shipment-scheduler.ts': [
          'import { fetchQuotes } from \'./carrier-quote-adapter.js\';',
          '',
          'export function scheduleShipment(parcelId: string): void {',
          '  bookCheapestCarrier(parcelId);',
          '}',
          '',
          'function bookCheapestCarrier(parcelId: string): void {',
          '  // rate-table lookup only — the quote call was dropped in a refactor',
          '}',
          '',
        ].join('\n'),
        'src/fulfillment/carrier-quote-adapter.ts': [
          'export function fetchQuotes(parcelId: string): number[] {',
          '  return [12.5, 14.0];',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    expectFire: false,
    reason: 'The realized function directly invokes the narrated target method, so the call step is realized as a callee.',
    scenario:
      'The shipment scheduler function directly calls fetchQuotes on the carrier quote adapter, exactly as the narrative says.',
    tree: {
      subsystems: [{ id: 'fulfillment', description: 'Parcel scheduling and carrier hand-off.' }],
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
          sourcePath: 'src/fulfillment/shipment-scheduler.ts',
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
          sourcePath: 'src/fulfillment/carrier-quote-adapter.ts',
          methods: [
            {
              name: 'fetchQuotes',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Call each connected carrier rate API and merge the quotes.' }],
            },
          ],
        },
      ],
      files: {
        'src/fulfillment/shipment-scheduler.ts': [
          'import { fetchQuotes } from \'./carrier-quote-adapter.js\';',
          '',
          'export function scheduleShipment(parcelId: string): void {',
          '  const quotes = fetchQuotes(parcelId);',
          '  pickCheapest(quotes);',
          '}',
          '',
          'function pickCheapest(quotes: number[]): number {',
          '  return Math.min(...quotes);',
          '}',
          '',
        ].join('\n'),
        'src/fulfillment/carrier-quote-adapter.ts': [
          'export function fetchQuotes(parcelId: string): number[] {',
          '  return [12.5, 14.0];',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    expectFire: false,
    reason:
      'The callee set is documented to close transitively over same-file named helpers, so an extract-helper refactor that moves the call into selectCarrier stays clean.',
    scenario:
      'The shipment scheduler delegates to a same-file selectCarrier helper, and the helper is what actually calls fetchQuotes on the adapter.',
    tree: {
      subsystems: [{ id: 'fulfillment', description: 'Parcel scheduling and carrier hand-off.' }],
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
          sourcePath: 'src/fulfillment/shipment-scheduler.ts',
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
          sourcePath: 'src/fulfillment/carrier-quote-adapter.ts',
          methods: [
            {
              name: 'fetchQuotes',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Call each connected carrier rate API and merge the quotes.' }],
            },
          ],
        },
      ],
      files: {
        'src/fulfillment/shipment-scheduler.ts': [
          'import { fetchQuotes } from \'./carrier-quote-adapter.js\';',
          '',
          'export function scheduleShipment(parcelId: string): void {',
          '  const booking = selectCarrier(parcelId);',
          '  confirmBooking(booking);',
          '}',
          '',
          'function selectCarrier(parcelId: string): number {',
          '  const quotes = fetchQuotes(parcelId);',
          '  return Math.min(...quotes);',
          '}',
          '',
          'function confirmBooking(quote: number): void {',
          '  // notify the carrier of the accepted quote',
          '}',
          '',
        ].join('\n'),
        'src/fulfillment/carrier-quote-adapter.ts': [
          'export function fetchQuotes(parcelId: string): number[] {',
          '  return [12.5, 14.0];',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    expectFire: false,
    reason:
      'A `register` step is documented as a runtime-callback handoff — "a reachability edge, never an invocation" — so the target name is not required among the callees; only `call` steps are held to realization.',
    scenario:
      'The shipment scheduler narrative hands its status callback to the carrier webhook observer via a register step, and the realized function never names the observer method.',
    tree: {
      subsystems: [{ id: 'fulfillment', description: 'Parcel scheduling and carrier hand-off.' }],
      components: [
        {
          id: 'shipment-scheduler',
          componentType: 'Orchestrator',
          subsystem: 'fulfillment',
          description: 'Plans each parcel pickup and books the cheapest eligible carrier.',
          dependsOn: ['carrier-webhook-observer'],
        },
        {
          id: 'carrier-webhook-observer',
          componentType: 'Observer',
          subsystem: 'fulfillment',
          description: 'Consumes asynchronous carrier status webhooks.',
        },
      ],
      interfaces: [
        {
          id: 'ishipment_scheduler',
          component: 'shipment-scheduler',
          methods: [{ name: 'scheduleShipment', description: 'Book the cheapest eligible carrier for a parcel.' }],
        },
        {
          id: 'icarrier_webhook_observer',
          component: 'carrier-webhook-observer',
          methods: [{ name: 'onCarrierStatusUpdate', description: 'Handle one carrier status webhook delivery.' }],
        },
      ],
      implementations: [
        {
          id: 'shipment_scheduler_impl',
          contract: 'ishipment_scheduler',
          sourcePath: 'src/fulfillment/shipment-scheduler.ts',
          methods: [
            {
              name: 'scheduleShipment',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'register',
                  description: 'Hand the scheduler\'s status callback to the carrier webhook observer.',
                  targetComponent: 'carrier-webhook-observer',
                  targetMethod: 'onCarrierStatusUpdate',
                },
                { stepNumber: 2, type: 'local', description: 'Book the pickup window with the chosen carrier.' },
              ],
            },
          ],
        },
        {
          id: 'carrier_webhook_observer_impl',
          contract: 'icarrier_webhook_observer',
          sourcePath: 'src/fulfillment/carrier-webhook-observer.ts',
          methods: [
            {
              name: 'onCarrierStatusUpdate',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Update the parcel state from the webhook payload.' }],
            },
          ],
        },
      ],
      files: {
        'src/fulfillment/shipment-scheduler.ts': [
          'export function scheduleShipment(parcelId: string): void {',
          '  bookPickupWindow(parcelId);',
          '}',
          '',
          'function bookPickupWindow(parcelId: string): void {',
          '  // the callback handoff happens through the runtime\'s subscription table',
          '}',
          '',
        ].join('\n'),
        'src/fulfillment/carrier-webhook-observer.ts': [
          'export function onCarrierStatusUpdate(payload: object): void {',
          '  // update the parcel state from the webhook payload',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),

  // -------------------------------------------------------------------------
  // CALL_STEP_UNREALIZED — the target-side per-method `symbol` override:
  // calling the mapped code name satisfies the step; calling neither name fires
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    severity: 'warning',
    anchoredTo: 'invoice_orchestrator_impl',
    expectFire: true,
    scenario:
      'The invoice orchestrator narrative calls the invoice store\'s persistInvoice (code name writeInvoiceRow via symbol), but the realized function calls a stale legacyPersist helper that matches neither name.',
    tree: {
      subsystems: [{ id: 'billing', description: 'Invoicing and payment collection for placed orders.' }],
      components: [
        {
          id: 'invoice-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'billing',
          description: 'Finalizes invoices and persists them.',
          dependsOn: ['invoice-store'],
        },
        {
          id: 'invoice-store',
          componentType: 'Store',
          subsystem: 'billing',
          durability: 'read-through',
          description: 'Holds issued invoices.',
        },
      ],
      interfaces: [
        {
          id: 'iinvoice_orchestrator',
          component: 'invoice-orchestrator',
          methods: [{ name: 'finalizeInvoice', description: 'Finalize and persist one invoice.' }],
        },
        {
          id: 'iinvoice_store',
          component: 'invoice-store',
          methods: [{ name: 'persistInvoice', description: 'Persist one issued invoice.' }],
        },
      ],
      implementations: [
        {
          id: 'invoice_orchestrator_impl',
          contract: 'iinvoice_orchestrator',
          sourcePath: 'src/billing/invoice-orchestrator.ts',
          methods: [
            {
              name: 'finalizeInvoice',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Persist the finalized invoice in the invoice store.',
                  targetComponent: 'invoice-store',
                  targetMethod: 'persistInvoice',
                },
              ],
            },
          ],
        },
        {
          id: 'invoice_store_impl',
          contract: 'iinvoice_store',
          sourcePath: 'src/billing/invoice-store.ts',
          methods: [
            {
              name: 'persistInvoice',
              symbol: 'writeInvoiceRow',
              intent: 'Upsert the invoice row transactionally; on conflict the newer revision wins and the caller is informed of the replacement.',
            },
          ],
        },
      ],
      files: {
        'src/billing/invoice-orchestrator.ts': [
          'export function finalizeInvoice(invoiceId: string): void {',
          '  legacyPersist(invoiceId);',
          '}',
          '',
          'function legacyPersist(invoiceId: string): void {',
          '  // stale local buffer write — neither persistInvoice nor writeInvoiceRow',
          '}',
          '',
        ].join('\n'),
        'src/billing/invoice-store.ts': [
          'export function writeInvoiceRow(invoiceId: string): void {',
          '  // upsert the invoice row',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    expectFire: false,
    reason:
      'The accepted callee names are documented to include any symbol override a target-side implementation declares — the caller invokes writeInvoiceRow, the mapped code name of persistInvoice.',
    scenario:
      'The invoice orchestrator calls writeInvoiceRow, which the invoice store implementation declares as the per-method symbol realizing persistInvoice.',
    tree: {
      subsystems: [{ id: 'billing', description: 'Invoicing and payment collection for placed orders.' }],
      components: [
        {
          id: 'invoice-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'billing',
          description: 'Finalizes invoices and persists them.',
          dependsOn: ['invoice-store'],
        },
        {
          id: 'invoice-store',
          componentType: 'Store',
          subsystem: 'billing',
          durability: 'read-through',
          description: 'Holds issued invoices.',
        },
      ],
      interfaces: [
        {
          id: 'iinvoice_orchestrator',
          component: 'invoice-orchestrator',
          methods: [{ name: 'finalizeInvoice', description: 'Finalize and persist one invoice.' }],
        },
        {
          id: 'iinvoice_store',
          component: 'invoice-store',
          methods: [{ name: 'persistInvoice', description: 'Persist one issued invoice.' }],
        },
      ],
      implementations: [
        {
          id: 'invoice_orchestrator_impl',
          contract: 'iinvoice_orchestrator',
          sourcePath: 'src/billing/invoice-orchestrator.ts',
          methods: [
            {
              name: 'finalizeInvoice',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Persist the finalized invoice in the invoice store.',
                  targetComponent: 'invoice-store',
                  targetMethod: 'persistInvoice',
                },
              ],
            },
          ],
        },
        {
          id: 'invoice_store_impl',
          contract: 'iinvoice_store',
          sourcePath: 'src/billing/invoice-store.ts',
          methods: [
            {
              name: 'persistInvoice',
              symbol: 'writeInvoiceRow',
              intent: 'Upsert the invoice row transactionally; on conflict the newer revision wins and the caller is informed of the replacement.',
            },
          ],
        },
      ],
      files: {
        'src/billing/invoice-orchestrator.ts': [
          'import { writeInvoiceRow } from \'./invoice-store.js\';',
          '',
          'export function finalizeInvoice(invoiceId: string): void {',
          '  writeInvoiceRow(invoiceId);',
          '}',
          '',
        ].join('\n'),
        'src/billing/invoice-store.ts': [
          'export function writeInvoiceRow(invoiceId: string): void {',
          '  // upsert the invoice row',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
];
