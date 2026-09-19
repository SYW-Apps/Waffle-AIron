/**
 * Call-step realization (code↔spec Level 3, the opener) —
 * src/core/rules/conformance/call-conformance.ts.
 *
 * Documented intent pinned here (rule description + module doc comment +
 * the narrative step-type vocabulary in src/models/specs.ts):
 *  - CALL_STEP_UNREALIZED (warning): every narrative `call` step of an
 *    exactly-analyzed method must be realized by a call of the realized
 *    function in the method's own source file (its sourcePath, else the
 *    implementation's) that RESOLVES TO one of the target method's own source
 *    files — matched by the target method's contract name OR any per-method
 *    `symbol` override a target-side implementation declares, closed
 *    transitively over the named helpers the function calls (extract-helper
 *    refactors stay clean). A target naming no file of its own falls back to
 *    name membership. Order/arguments/conditions stay unverified.
 *    `register` steps are a reachability edge, "never an invocation"
 *    (step-type vocabulary), so they are exempt — only `call` steps are held
 *    to realization.
 *  - CALL_ORIGIN_UNRESOLVED (warning): the target's name IS called inside the
 *    realized function, but only from call sites a pure model cannot resolve
 *    to any file — a member call through a value (`this.store.save()`). A
 *    distinct answer from "the call is missing": the step is neither proven
 *    realized nor accused, because only what resolved may accuse.
 *  - UNDECLARED_COLOCATED_CALL (warning): the realized function calls a
 *    modelled method of ANOTHER component living in the same source file, and
 *    no narrative step declares that call — a boundary crossing that nothing
 *    imports, which the file-level checks structurally cannot see. A call to a
 *    same-file PRIVATE helper is no modelled method and is never reported.
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

  // -------------------------------------------------------------------------
  // CALL_STEP_UNREALIZED — a method naming its own source file is read there
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    severity: 'warning',
    anchoredTo: 'shipment_scheduler_impl',
    expectFire: true,
    scenario:
      'The shipment scheduler moved scheduleShipment into its own command module, but the moved function dropped the carrier quote call, while the stale copy left in the scheduler module still makes it.',
    tree: shipmentCommandTree({
      schedulerModule: [
        'import { fetchQuotes } from \'./carrier-quote-adapter.js\';',
        '',
        '// stale copy kept for old call sites; the command module is the real body',
        'export function scheduleShipment(parcelId: string): void {',
        '  fetchQuotes(parcelId);',
        '}',
        '',
      ].join('\n'),
      commandModule: [
        'export function scheduleShipment(parcelId: string): void {',
        '  bookFromRateTable(parcelId);',
        '}',
        '',
        'function bookFromRateTable(parcelId: string): void {',
        '  // static rate table lookup; the quote call was dropped in the move',
        '}',
        '',
      ].join('\n'),
    }),
  }),
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    expectFire: false,
    reason:
      'The method names its own source file, and the realized function there calls the narrated target; the scheduler module is not where the method lives.',
    scenario:
      'The shipment scheduler\'s command module calls fetchQuotes on the carrier quote adapter, while the scheduler module itself keeps only the shipping policy.',
    tree: shipmentCommandTree({
      schedulerModule: [
        'export function describeShipmentPolicy(): string {',
        '  return \'cheapest-eligible-carrier\';',
        '}',
        '',
      ].join('\n'),
      commandModule: [
        'import { fetchQuotes } from \'../carrier-quote-adapter.js\';',
        '',
        'export function scheduleShipment(parcelId: string): void {',
        '  fetchQuotes(parcelId);',
        '}',
        '',
      ].join('\n'),
    }),
  }),
  // -------------------------------------------------------------------------
  // CALL_ORIGIN_UNRESOLVED — the name IS called, from a site with no readable
  // origin: a different answer from "the call is missing", and never an
  // accusation
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CALL_ORIGIN_UNRESOLVED',
    severity: 'warning',
    anchoredTo: 'shipment_scheduler_impl',
    expectFire: true,
    scenario:
      'The shipment scheduler holds its carrier adapter as a constructor-injected field and quotes through this.carrier.fetchQuotes, so nothing in the module says which file that function was written in.',
    tree: injectedSchedulerTree([
      'export class ShipmentScheduler {',
      '  private readonly carrier: { fetchQuotes(parcelId: string): number[] };',
      '',
      '  constructor(carrier: { fetchQuotes(parcelId: string): number[] }) {',
      '    this.carrier = carrier;',
      '  }',
      '',
      '  scheduleShipment(parcelId: string): void {',
      '    const quotes = this.carrier.fetchQuotes(parcelId);',
      '    this.pickCheapest(quotes);',
      '  }',
      '',
      '  private pickCheapest(quotes: number[]): number {',
      '    return Math.min(...quotes);',
      '  }',
      '}',
      '',
    ].join('\n')),
  }),
  defineRuleFixture({
    code: 'CALL_ORIGIN_UNRESOLVED',
    expectFire: false,
    reason:
      'A namespace import binding\'s properties ARE that module\'s own exports, so carrierQuotes.fetchQuotes resolves to the adapter\'s source file and the step is proven realized instead of left unreadable.',
    scenario:
      'The shipment scheduler imports the carrier quote adapter as a namespace and quotes through carrierQuotes.fetchQuotes.',
    tree: injectedSchedulerTree([
      'import * as carrierQuotes from \'./carrier-quote-adapter.js\';',
      '',
      'export class ShipmentScheduler {',
      '  scheduleShipment(parcelId: string): void {',
      '    const quotes = carrierQuotes.fetchQuotes(parcelId);',
      '    this.pickCheapest(quotes);',
      '  }',
      '',
      '  private pickCheapest(quotes: number[]): number {',
      '    return Math.min(...quotes);',
      '  }',
      '}',
      '',
    ].join('\n')),
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_COLOCATED_CALL — the converse direction: a call that crosses a
  // component boundary inside one file, which no file-level check can see
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_COLOCATED_CALL',
    severity: 'warning',
    anchoredTo: 'shipment_scheduler_impl',
    expectFire: true,
    scenario:
      'The dispatch desk module holds both the shipment scheduler and the carrier quote adapter, and the scheduler quotes through the adapter\'s function without a narrative step saying so.',
    tree: dispatchDeskTree({
      schedulerNarrative: [
        { stepNumber: 1, type: 'local', description: 'Pick the cheapest quote that meets the delivery window.' },
      ],
      module: [
        'export function scheduleShipment(parcelId: string): void {',
        '  const quotes = fetchQuotes(parcelId);',
        '  bookCheapest(parcelId, quotes);',
        '}',
        '',
        'export function fetchQuotes(parcelId: string): number[] {',
        '  return [12.5, 14.0];',
        '}',
        '',
        'function bookCheapest(parcelId: string, quotes: number[]): void {',
        '  // hand the cheapest quote to the chosen carrier',
        '}',
        '',
      ].join('\n'),
    }),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_COLOCATED_CALL',
    expectFire: false,
    reason: 'The narrative declares the call to the colocated adapter method, which is the whole of what the converse direction asks for.',
    scenario:
      'The dispatch desk scheduler quotes through the colocated carrier quote adapter and narrates that call as a call step.',
    tree: dispatchDeskTree({
      schedulerNarrative: [
        {
          stepNumber: 1,
          type: 'call',
          description: 'Fetch carrier quotes for the parcel.',
          targetComponent: 'carrier-quote-adapter',
          targetMethod: 'fetchQuotes',
        },
        { stepNumber: 2, type: 'local', description: 'Pick the cheapest quote that meets the delivery window.' },
      ],
      module: [
        'export function scheduleShipment(parcelId: string): void {',
        '  const quotes = fetchQuotes(parcelId);',
        '  bookCheapest(parcelId, quotes);',
        '}',
        '',
        'export function fetchQuotes(parcelId: string): number[] {',
        '  return [12.5, 14.0];',
        '}',
        '',
        'function bookCheapest(parcelId: string, quotes: number[]): void {',
        '  // hand the cheapest quote to the chosen carrier',
        '}',
        '',
      ].join('\n'),
    }),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_COLOCATED_CALL',
    expectFire: false,
    reason:
      'A same-file PRIVATE helper is no modelled method of any component, so reporting it would turn every rule\'s internal factoring into a finding — only a call to a colocated MODELLED method crosses a boundary.',
    scenario:
      'The dispatch desk scheduler calls only its own private rate-table helpers, leaving the colocated carrier quote adapter alone.',
    tree: dispatchDeskTree({
      schedulerNarrative: [
        { stepNumber: 1, type: 'local', description: 'Book the parcel against the standing rate table.' },
      ],
      module: [
        'export function scheduleShipment(parcelId: string): void {',
        '  const rate = standingRate(parcelId);',
        '  bookCheapest(parcelId, [rate]);',
        '}',
        '',
        'function standingRate(parcelId: string): number {',
        '  return 13.25;',
        '}',
        '',
        'export function fetchQuotes(parcelId: string): number[] {',
        '  return [12.5, 14.0];',
        '}',
        '',
        'function bookCheapest(parcelId: string, quotes: number[]): void {',
        '  // hand the cheapest quote to the chosen carrier',
        '}',
        '',
      ].join('\n'),
    }),
  }),

  // -------------------------------------------------------------------------
  // CALL_STEP_UNREALIZED — the call resolves, but into another module: the
  // same-named function the name-only check used to accept
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    severity: 'warning',
    anchoredTo: 'shipment_scheduler_impl',
    expectFire: true,
    scenario:
      'The shipment scheduler imports fetchQuotes from the archived rate-table module instead of the carrier quote adapter its narrative names, so the call lands in a different file altogether.',
    tree: sameNameTree([
      'import { fetchQuotes } from \'./rate-table-archive.js\';',
      '',
      'export function scheduleShipment(parcelId: string): void {',
      '  fetchQuotes(parcelId);',
      '}',
      '',
    ].join('\n')),
  }),
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    expectFire: false,
    reason:
      'The call resolves to the carrier quote adapter\'s own source file, which is what realizing the step means — the identically named archive function beside it never enters into it.',
    scenario:
      'The shipment scheduler imports fetchQuotes from the carrier quote adapter, while an identically named function also sits in the archived rate-table module.',
    tree: sameNameTree([
      'import { fetchQuotes } from \'./carrier-quote-adapter.js\';',
      '',
      'export function scheduleShipment(parcelId: string): void {',
      '  fetchQuotes(parcelId);',
      '}',
      '',
    ].join('\n')),
  }),

  // -------------------------------------------------------------------------
  // CALL_ORIGIN_UNRESOLVED — the `this.<field>.<method>()` receiver, followed
  // through the TYPE the class declares the field with. A possibility, not a
  // proof: it may ACCEPT a call, and it must never accuse one.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CALL_ORIGIN_UNRESOLVED',
    expectFire: false,
    reason:
      'The constructor parameter property declares what the collaborator IS, so this.store.append is followed through the PayslipStore binding to the store\'s own source file — the call site does say where it can land.',
    scenario:
      'The payslip repository takes its store as a typed constructor parameter property and appends the payslip through this.store.append.',
    tree: payslipRepositoryTree([
      'import { PayslipStore } from \'./payslip-store.js\';',
      '',
      '/** The pay-run facade: one recorded payslip per employee, per run. */',
      'export class PayslipRepository {',
      '  constructor(private readonly store: PayslipStore) {}',
      '',
      '  record(payslipId: string): void {',
      '    this.store.append(payslipId);',
      '  }',
      '}',
      '',
    ].join('\n')),
  }),
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    expectFire: false,
    reason:
      'Following the field\'s declared type lands the call in the store\'s own source file, which is what realizing the step means — the step is proven, not merely unaccused.',
    scenario:
      'The payslip repository appends through this.store.append, and the store it declares that field with is the very component the narrative names.',
    tree: payslipRepositoryTree([
      'import { PayslipStore } from \'./payslip-store.js\';',
      '',
      '/** The pay-run facade: one recorded payslip per employee, per run. */',
      'export class PayslipRepository {',
      '  constructor(private readonly store: PayslipStore) {}',
      '',
      '  record(payslipId: string): void {',
      '    this.store.append(payslipId);',
      '  }',
      '}',
      '',
    ].join('\n')),
  }),
  defineRuleFixture({
    code: 'CALL_ORIGIN_UNRESOLVED',
    severity: 'warning',
    anchoredTo: 'payslip_repository_impl',
    expectFire: true,
    scenario:
      'The payslip repository assigns its store to an unannotated field in the constructor body, so this.store.append names a value the module never says the type of.',
    tree: payslipRepositoryTree([
      'import { PayslipStore } from \'./payslip-store.js\';',
      '',
      '/** The pay-run facade: one recorded payslip per employee, per run. */',
      'export class PayslipRepository {',
      '  private readonly store;',
      '',
      '  constructor(store: PayslipStore) {',
      '    this.store = store;',
      '  }',
      '',
      '  record(payslipId: string): void {',
      '    this.store.append(payslipId);',
      '  }',
      '}',
      '',
    ].join('\n')),
  }),

  // -------------------------------------------------------------------------
  // The no-accusation property: a field type that resolves SOMEWHERE ELSE
  // leaves the step unresolved. Widening what a call may have reached can
  // accept a step; it may never turn "I cannot say" into "it landed there".
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CALL_ORIGIN_UNRESOLVED',
    severity: 'warning',
    anchoredTo: 'payslip_repository_impl',
    expectFire: true,
    scenario:
      'The payslip repository narrates an append to the payslip store but appends to the cold-storage archive instead, through a field declared as the archive.',
    tree: payslipRepositoryTree([
      'import { PayslipArchive } from \'./payslip-archive.js\';',
      '',
      '/** The pay-run facade: one recorded payslip per employee, per run. */',
      'export class PayslipRepository {',
      '  constructor(private readonly archive: PayslipArchive) {}',
      '',
      '  record(payslipId: string): void {',
      '    this.archive.append(payslipId);',
      '  }',
      '}',
      '',
    ].join('\n')),
  }),
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    expectFire: false,
    reason:
      'A declared type says what a collaborator IS, never which class ships the body, so a landing read off one can accept a step but can never name where a call went instead: a miss stays "cannot say" and is reported as CALL_ORIGIN_UNRESOLVED.',
    scenario:
      'The payslip repository appends through a field declared as the cold-storage archive while its narrative names the payslip store, so the followed type lands in a file that is not the target\'s.',
    tree: payslipRepositoryTree([
      'import { PayslipArchive } from \'./payslip-archive.js\';',
      '',
      '/** The pay-run facade: one recorded payslip per employee, per run. */',
      'export class PayslipRepository {',
      '  constructor(private readonly archive: PayslipArchive) {}',
      '',
      '  record(payslipId: string): void {',
      '    this.archive.append(payslipId);',
      '  }',
      '}',
      '',
    ].join('\n')),
  }),
];

/**
 * A payroll repository facade over its own store, with a cold-storage archive
 * beside it; only the repository module's text varies. Used for the
 * `this.<field>.<method>()` cases, where the question is what the class says
 * the field IS — and what may be concluded from an answer that is a
 * possibility rather than a proof.
 */
function payslipRepositoryTree(repositoryModule: string): import('../harness.js').FixtureTree {
  return {
    subsystems: [{ id: 'payroll', description: 'Pay runs, payslip records and their retention.' }],
    components: [
      {
        id: 'payslip-repository',
        componentType: 'Repository',
        subsystem: 'payroll',
        description: 'The pay-run facade over the payslip rows and their cold-storage archive.',
        owns: ['payslip-store', 'payslip-archive'],
      },
      {
        id: 'payslip-store',
        componentType: 'Store',
        subsystem: 'payroll',
        durability: 'read-through',
        description: 'The authoritative payslip rows of every open pay run.',
      },
      {
        id: 'payslip-archive',
        componentType: 'Adapter',
        subsystem: 'payroll',
        description: 'Cold storage for the pay runs closed past the retention window.',
      },
    ],
    interfaces: [
      {
        id: 'ipayslip_repository',
        component: 'payslip-repository',
        methods: [{ name: 'record', description: 'Record one employee\'s payslip for the open pay run.' }],
      },
      {
        id: 'ipayslip_store',
        component: 'payslip-store',
        methods: [{ name: 'append', description: 'Append one payslip row to the open pay run.' }],
      },
      {
        id: 'ipayslip_archive',
        component: 'payslip-archive',
        methods: [{ name: 'append', description: 'Append one payslip row to the cold-storage archive.' }],
      },
    ],
    implementations: [
      {
        id: 'payslip_repository_impl',
        contract: 'ipayslip_repository',
        sourcePath: 'src/payroll/payslip-repository.ts',
        methods: [
          {
            name: 'record',
            narrative: [
              {
                stepNumber: 1,
                type: 'call',
                description: 'Append the payslip row to the open pay run.',
                targetComponent: 'payslip-store',
                targetMethod: 'append',
              },
            ],
          },
        ],
      },
      {
        id: 'payslip_store_impl',
        contract: 'ipayslip_store',
        sourcePath: 'src/payroll/payslip-store.ts',
        methods: [
          {
            name: 'append',
            narrative: [{ stepNumber: 1, type: 'local', description: 'Write the payslip row into the open pay run.' }],
          },
        ],
      },
      {
        id: 'payslip_archive_impl',
        contract: 'ipayslip_archive',
        sourcePath: 'src/payroll/payslip-archive.ts',
        methods: [
          {
            name: 'append',
            narrative: [{ stepNumber: 1, type: 'local', description: 'Write the payslip row into the cold-storage archive.' }],
          },
        ],
      },
    ],
    files: {
      'src/payroll/payslip-repository.ts': repositoryModule,
      'src/payroll/payslip-store.ts': [
        '/** The authoritative payslip rows of every open pay run. */',
        'export class PayslipStore {',
        '  append(payslipId: string): void {',
        '    // persist the payslip row',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/payroll/payslip-archive.ts': [
        '/** Cold storage for the pay runs closed past the retention window. */',
        'export class PayslipArchive {',
        '  append(payslipId: string): void {',
        '    // append the payslip row to cold storage',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
  };
}

/**
 * The shipment scheduler whose scheduleShipment names its own command module
 * (src/fulfillment/commands/schedule-shipment.ts) beside the scheduler module;
 * only the two modules' text varies.
 */
function shipmentCommandTree(modules: { schedulerModule: string; commandModule: string }): import('../harness.js').FixtureTree {
  return {
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
            sourcePath: 'src/fulfillment/commands/schedule-shipment.ts',
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
      'src/fulfillment/shipment-scheduler.ts': modules.schedulerModule,
      'src/fulfillment/commands/schedule-shipment.ts': modules.commandModule,
      'src/fulfillment/carrier-quote-adapter.ts': [
        'export function fetchQuotes(parcelId: string): number[] {',
        '  return [12.5, 14.0];',
        '}',
        '',
      ].join('\n'),
    },
  };
}

/**
 * A shipment scheduler whose narrative quotes through the carrier quote
 * adapter beside it; only the scheduler module's text varies. Used for the
 * call-ORIGIN cases, where the question is not whether the name is called but
 * whether the call site says where it lands.
 */
function injectedSchedulerTree(schedulerModule: string): import('../harness.js').FixtureTree {
  return {
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
      'src/fulfillment/shipment-scheduler.ts': schedulerModule,
      'src/fulfillment/carrier-quote-adapter.ts': [
        'export function fetchQuotes(parcelId: string): number[] {',
        '  return [12.5, 14.0];',
        '}',
        '',
      ].join('\n'),
    },
  };
}

/**
 * A dispatch desk where the shipment scheduler and the carrier quote adapter
 * are realized in ONE module — the colocation the converse direction exists
 * for. The scheduler's narrative and the shared module's text vary.
 */
function dispatchDeskTree(opts: {
  schedulerNarrative: Record<string, unknown>[];
  module: string;
}): import('../harness.js').FixtureTree {
  return {
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
        sourcePath: 'src/fulfillment/dispatch-desk.ts',
        methods: [{ name: 'scheduleShipment', narrative: opts.schedulerNarrative }],
      },
      {
        id: 'carrier_quote_adapter_impl',
        contract: 'icarrier_quote_adapter',
        sourcePath: 'src/fulfillment/dispatch-desk.ts',
        methods: [
          {
            name: 'fetchQuotes',
            narrative: [{ stepNumber: 1, type: 'local', description: 'Call each connected carrier rate API and merge the quotes.' }],
          },
        ],
      },
    ],
    files: { 'src/fulfillment/dispatch-desk.ts': opts.module },
  };
}

/**
 * A shipment scheduler beside TWO modules exporting a function called
 * fetchQuotes: the carrier quote adapter its narrative names, and an archived
 * rate-table module no spec claims. Only the scheduler module's text varies —
 * which of the two it imports is the whole question.
 */
function sameNameTree(schedulerModule: string): import('../harness.js').FixtureTree {
  const tree = injectedSchedulerTree(schedulerModule);
  tree.files!['src/fulfillment/rate-table-archive.ts'] = [
    '// Last year\'s frozen rate table, kept for reconciliation only.',
    'export function fetchQuotes(parcelId: string): number[] {',
    '  return [19.9];',
    '}',
    '',
  ].join('\n');
  tree.rules = { conformance: { sourceRoots: ['src'] } };
  return tree;
}
