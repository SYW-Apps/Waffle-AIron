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
 *    to any file — a member call through a value the module assembled, or
 *    through a name it never writes down the type of. A distinct answer from
 *    "the call is missing": the step is neither proven realized nor accused,
 *    because only what resolved may accuse. Three receivers ARE followed past
 *    the value they hold, each through a NAME the code writes down:
 *    `this.<field>` through the type the class declares the field with,
 *    `new Class(...)` through the module its class name came from, and a
 *    plain `<name>.<method>()` through the type the file ANNOTATES that name
 *    with — a parameter's, or an annotated variable's. All three may only
 *    ACCEPT a call; a landing a finding names still comes from what was
 *    proven.
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
  // -------------------------------------------------------------------------
  // CALL_ORIGIN_UNRESOLVED — the `new Class(…).<method>()` receiver, followed
  // through the module its CLASS NAME came from. The same tier as a declared
  // field type: it may ACCEPT a call, and it must never accuse one.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CALL_ORIGIN_UNRESOLVED',
    expectFire: false,
    reason:
      'The code NAMES the class it builds, so `new PayslipStore(...).append` is followed through the PayslipStore import to the store\'s own source file — the call site does say where it can land.',
    scenario:
      'The payslip repository constructs the payslip store inline for the one append it makes, rather than holding it as a field.',
    tree: payslipRepositoryTree([
      'import { PayslipStore } from \'./payslip-store.js\';',
      '',
      '/** The pay-run facade: one recorded payslip per employee, per run. */',
      'export class PayslipRepository {',
      '  constructor(private readonly dataDir: string) {}',
      '',
      '  record(payslipId: string): void {',
      '    new PayslipStore(this.dataDir).append(payslipId);',
      '  }',
      '}',
      '',
    ].join('\n')),
  }),
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    expectFire: false,
    reason:
      'Following the constructed class lands the call in the store\'s own source file, which is what realizing the step means — the step is accepted, not merely unaccused.',
    scenario:
      'The payslip repository appends through a payslip store it constructs inline, and that store is the very component the narrative names.',
    tree: payslipRepositoryTree([
      'import { PayslipStore } from \'./payslip-store.js\';',
      '',
      '/** The pay-run facade: one recorded payslip per employee, per run. */',
      'export class PayslipRepository {',
      '  constructor(private readonly dataDir: string) {}',
      '',
      '  record(payslipId: string): void {',
      '    new PayslipStore(this.dataDir).append(payslipId);',
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
      'The payslip repository narrates an append to the payslip store but constructs the cold-storage archive inline and appends to that instead.',
    tree: payslipRepositoryTree([
      'import { PayslipArchive } from \'./payslip-archive.js\';',
      '',
      '/** The pay-run facade: one recorded payslip per employee, per run. */',
      'export class PayslipRepository {',
      '  constructor(private readonly dataDir: string) {}',
      '',
      '  record(payslipId: string): void {',
      '    new PayslipArchive(this.dataDir).append(payslipId);',
      '  }',
      '}',
      '',
    ].join('\n')),
  }),
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    expectFire: false,
    reason:
      'A constructed class says where the CLASS was written, never that this call went there, so a landing read off one can accept a step but can never name where a call went instead: a miss stays "cannot say" and is reported as CALL_ORIGIN_UNRESOLVED.',
    scenario:
      'The payslip repository appends through an inline-constructed cold-storage archive while its narrative names the payslip store, so the followed class lands in a file that is not the target\'s.',
    tree: payslipRepositoryTree([
      'import { PayslipArchive } from \'./payslip-archive.js\';',
      '',
      '/** The pay-run facade: one recorded payslip per employee, per run. */',
      'export class PayslipRepository {',
      '  constructor(private readonly dataDir: string) {}',
      '',
      '  record(payslipId: string): void {',
      '    new PayslipArchive(this.dataDir).append(payslipId);',
      '  }',
      '}',
      '',
    ].join('\n')),
  }),

  // -------------------------------------------------------------------------
  // The INHERITED-METHOD limit of the constructed receiver, recorded rather
  // than discovered later. Following `new JournalWriter(…)` claims the module
  // the CLASS was written in — never the module a method it INHERITS from a
  // base was written in, which is free to live anywhere. So the reading
  // reaches the derived class's file and stops there: what it cannot see
  // stays a false NEGATIVE, and a possibility still never accuses.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CALL_ORIGIN_UNRESOLVED',
    severity: 'warning',
    anchoredTo: 'entry_recorder_impl',
    expectFire: true,
    scenario:
      'The entry recorder constructs the payroll journal writer and appends through it, but append is inherited from the general-ledger writer in another module, which is where the narrative\'s target is realized.',
    tree: ledgerJournalTree('ledger-writer'),
  }),
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    expectFire: false,
    reason:
      'The constructed class\'s own module is all the code states, so an inherited body it cannot see leaves the step unresolved — never accused of being missing, which is the whole of why this reading lives in the possible tier.',
    scenario:
      'The entry recorder appends through an inherited method of the journal writer it constructs, while its narrative names the general-ledger writer the base class lives in.',
    tree: ledgerJournalTree('ledger-writer'),
  }),
  defineRuleFixture({
    code: 'CALL_ORIGIN_UNRESOLVED',
    expectFire: false,
    reason:
      'What the widened reading DOES claim is the constructed class\'s own module: the narrative names the journal writer, `new JournalWriter(...)` lands there, and the step is accepted — on where the class was written, never on a proof that the body is in that file.',
    scenario:
      'The entry recorder constructs the payroll journal writer and appends through it, and the journal writer is the component its narrative names.',
    tree: ledgerJournalTree('journal-writer'),
  }),

  // -------------------------------------------------------------------------
  // CALL_ORIGIN_UNRESOLVED - a receiver that is a plain NAME, followed through
  // the type the file ANNOTATES it with: a parameter's annotation, or an
  // annotated variable's. A module that wires its collaborators as closures
  // (`payslipRepositoryOver(store)`) writes every call it makes this way, and
  // the name it calls through is one the file said what it is. The same tier
  // as the other two: it may ACCEPT a call, and it must never accuse one.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CALL_ORIGIN_UNRESOLVED',
    expectFire: false,
    reason:
      'The parameter\'s annotation declares what the collaborator IS, so store.append is followed through the PayslipStore binding to the store\'s own source file — the call site does say where it can land.',
    scenario:
      'The payslip repository is built as a closure over its store, taking it as a typed parameter and appending the payslip through store.append.',
    tree: payslipRepositoryTree([
      'import { PayslipStore } from \'./payslip-store.js\';',
      '',
      '/** The pay-run facade over a given store: one recorded payslip per employee, per run. */',
      'export function payslipRepositoryOver(store: PayslipStore) {',
      '  return {',
      '    record(payslipId: string): void {',
      '      store.append(payslipId);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n')),
  }),
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    expectFire: false,
    reason:
      'Following the parameter\'s declared type lands the call in the store\'s own source file, which is what realizing the step means — the step is accepted, not merely unaccused.',
    scenario:
      'The payslip repository appends through the store it was handed as a typed parameter, and that store is the very component the narrative names.',
    tree: payslipRepositoryTree([
      'import { PayslipStore } from \'./payslip-store.js\';',
      '',
      '/** The pay-run facade over a given store: one recorded payslip per employee, per run. */',
      'export function payslipRepositoryOver(store: PayslipStore) {',
      '  return {',
      '    record(payslipId: string): void {',
      '      store.append(payslipId);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n')),
  }),
  defineRuleFixture({
    code: 'CALL_ORIGIN_UNRESOLVED',
    expectFire: false,
    reason:
      'An annotated variable declares what it holds exactly as a parameter does, so the local store is followed through the PayslipStore annotation to the store\'s own source file.',
    scenario:
      'The payslip repository opens the store for the run into a local binding it annotates, and appends the payslip through that binding.',
    tree: payslipRepositoryTree([
      'import { PayslipStore } from \'./payslip-store.js\';',
      '',
      '/** The pay-run facade: one recorded payslip per employee, per run. */',
      'export function record(payslipId: string): void {',
      '  const store: PayslipStore = currentPayslipStore();',
      '  store.append(payslipId);',
      '}',
      '',
      '/** The store of the open pay run. */',
      'function currentPayslipStore(): PayslipStore {',
      '  return new PayslipStore();',
      '}',
      '',
    ].join('\n')),
  }),
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    expectFire: false,
    reason:
      'The annotated local lands the call in the store\'s own source file, so the step is realized — a variable the code says the type of is as good a name to follow as a parameter.',
    scenario:
      'The payslip repository appends through an annotated local binding holding the open run\'s store, which is the component its narrative names.',
    tree: payslipRepositoryTree([
      'import { PayslipStore } from \'./payslip-store.js\';',
      '',
      '/** The pay-run facade: one recorded payslip per employee, per run. */',
      'export function record(payslipId: string): void {',
      '  const store: PayslipStore = currentPayslipStore();',
      '  store.append(payslipId);',
      '}',
      '',
      '/** The store of the open pay run. */',
      'function currentPayslipStore(): PayslipStore {',
      '  return new PayslipStore();',
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
      'The payslip repository opens the store into an unannotated local binding, so store.append names a value the module never says the type of.',
    tree: payslipRepositoryTree([
      'import { PayslipStore } from \'./payslip-store.js\';',
      '',
      '/** The pay-run facade: one recorded payslip per employee, per run. */',
      'export function record(payslipId: string): void {',
      '  const store = currentPayslipStore();',
      '  store.append(payslipId);',
      '}',
      '',
      '/** The store of the open pay run. */',
      'function currentPayslipStore(): PayslipStore {',
      '  return new PayslipStore();',
      '}',
      '',
    ].join('\n')),
  }),

  // -------------------------------------------------------------------------
  // The no-accusation property again, for the annotated receiver: a parameter
  // whose type resolves SOMEWHERE ELSE leaves the step unresolved. Widening
  // what a call may have reached can accept a step; it may never turn "I
  // cannot say" into "it landed there".
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CALL_ORIGIN_UNRESOLVED',
    severity: 'warning',
    anchoredTo: 'payslip_repository_impl',
    expectFire: true,
    scenario:
      'The payslip repository narrates an append to the payslip store but is wired over the cold-storage archive, taking it as a parameter typed as the archive.',
    tree: payslipRepositoryTree([
      'import { PayslipArchive } from \'./payslip-archive.js\';',
      '',
      '/** The pay-run facade over a given archive: one recorded payslip per employee, per run. */',
      'export function payslipRepositoryOver(archive: PayslipArchive) {',
      '  return {',
      '    record(payslipId: string): void {',
      '      archive.append(payslipId);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n')),
  }),
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    expectFire: false,
    reason:
      'An annotation says what a collaborator IS, never which file ships the body, so a landing read off one can accept a step but can never name where a call went instead: a miss stays "cannot say" and is reported as CALL_ORIGIN_UNRESOLVED.',
    scenario:
      'The payslip repository appends through a parameter typed as the cold-storage archive while its narrative names the payslip store, so the followed type lands in a file that is not the target\'s.',
    tree: payslipRepositoryTree([
      'import { PayslipArchive } from \'./payslip-archive.js\';',
      '',
      '/** The pay-run facade over a given archive: one recorded payslip per employee, per run. */',
      'export function payslipRepositoryOver(archive: PayslipArchive) {',
      '  return {',
      '    record(payslipId: string): void {',
      '      archive.append(payslipId);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n')),
  }),

  // -------------------------------------------------------------------------
  // The CROSS-FILE limit of the annotated receiver, recorded rather than
  // discovered later. An annotation names where the TYPE was written, never
  // where the body was: a parameter typed with a contract declared in a module
  // of its own lands on that contract's module, and the implementing class's
  // file is never reached. So the call stays unresolved though it really is
  // the store's - a false NEGATIVE, and a possibility still never accuses.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CALL_ORIGIN_UNRESOLVED',
    severity: 'warning',
    anchoredTo: 'payslip_repository_impl',
    expectFire: true,
    scenario:
      'The payslip repository takes its store as the payslip-rows contract, which is declared in a module of its own, while the class implementing it lives in the store module the narrative names.',
    tree: payslipContractTree([
      'import type { PayslipRows } from \'./payslip-rows.js\';',
      '',
      '/** The pay-run facade over any payslip rows: one recorded payslip per employee, per run. */',
      'export function payslipRepositoryOver(rows: PayslipRows) {',
      '  return {',
      '    record(payslipId: string): void {',
      '      rows.append(payslipId);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n')),
  }),
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    expectFire: false,
    reason:
      'The contract module is all the annotation states, so a body it cannot see leaves the step unresolved — never accused of being missing, which is the whole of why this reading lives in the possible tier.',
    scenario:
      'The payslip repository appends through a parameter typed as the payslip-rows contract while its narrative names the store that implements it in another module.',
    tree: payslipContractTree([
      'import type { PayslipRows } from \'./payslip-rows.js\';',
      '',
      '/** The pay-run facade over any payslip rows: one recorded payslip per employee, per run. */',
      'export function payslipRepositoryOver(rows: PayslipRows) {',
      '  return {',
      '    record(payslipId: string): void {',
      '      rows.append(payslipId);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n')),
  }),
  defineRuleFixture({
    code: 'CALL_ORIGIN_UNRESOLVED',
    expectFire: false,
    reason:
      'What the widened reading DOES claim is the module the annotation names: typed with the store CLASS, the same call lands in the store\'s own file and is accepted — the limit is which module a type name leads to, never annotations as such.',
    scenario:
      'The payslip repository in the same two-module tree takes its store as the concrete store class instead of the payslip-rows contract, and appends through it.',
    tree: payslipContractTree([
      'import { PayslipStore } from \'./payslip-store.js\';',
      '',
      '/** The pay-run facade over a given store: one recorded payslip per employee, per run. */',
      'export function payslipRepositoryOver(store: PayslipStore) {',
      '  return {',
      '    record(payslipId: string): void {',
      '      store.append(payslipId);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n')),
  }),
  // -------------------------------------------------------------------------
  // A DECLARED call is a claim about the code, exactly as a `call` step is.
  // A method whose narrative shows no steps reaches its collaborators through
  // `calls`, and the reachability walk takes those edges — so until this rule
  // read them, a declaration bought reachability the code never earned. Same
  // question, same verdict; a finding says "declared call" where it would have
  // said "step 3", because that is the whole of the difference.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    severity: 'warning',
    anchoredTo: 'restock_planner_impl',
    expectFire: true,
    scenario:
      'The restock planner writes no narrative steps and declares its calls instead, naming the supplier catalogue\'s lead times — but the planner function reads a stale local lead-time table and never calls the catalogue.',
    tree: restockPlannerTree(false),
  }),
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    expectFire: false,
    reason:
      'The declared call is realized: the planner function invokes leadTimes through the import binding that resolves to the supplier catalogue\'s own source file, which is everything the declaration claims.',
    scenario:
      'The restock planner declares a call to the supplier catalogue\'s lead times, and the planner function calls leadTimes on the catalogue module.',
    tree: restockPlannerTree(true),
  }),
  defineRuleFixture({
    code: 'CALL_ORIGIN_UNRESOLVED',
    expectFire: false,
    reason:
      'A realized declaration is ACCEPTED, not merely unread: the call resolves to a file, so the honest "I could not follow this" answer must stay silent — otherwise every verified declaration would be reported as unchecked.',
    scenario:
      'The restock planner\'s declared call to the supplier catalogue is written as a bare call on an import binding, the one shape this analysis resolves outright.',
    tree: restockPlannerTree(true),
  }),
  // -------------------------------------------------------------------------
  // The converse direction asks the same question of a declaring method. A
  // method that shows no steps still SAYS what it calls, in `calls` — so a
  // colocated crossing missing from that list is exactly as undeclared as one
  // missing from a narrative, and the remedy is the list it belongs in.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_COLOCATED_CALL',
    severity: 'warning',
    anchoredTo: 'shipment_scheduler_impl',
    expectFire: true,
    scenario:
      'The dispatch desk module holds both the shipment scheduler and the carrier quote adapter; the scheduler declares its quote call but also surcharges through the adapter without listing that one.',
    tree: declaredCallDeskTree(['carrier-quote-adapter.fetchQuotes']),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_COLOCATED_CALL',
    expectFire: false,
    reason:
      'Both colocated crossings are in the method\'s declared `calls`, which is where a narrative-less method says what it calls — the converse direction asks that the hop be written down, not that it be written down as a step.',
    scenario:
      'The dispatch desk scheduler declares both of the colocated carrier quote adapter calls it makes, quotes and surcharges alike.',
    tree: declaredCallDeskTree(['carrier-quote-adapter.fetchQuotes', 'carrier-quote-adapter.fetchSurcharges']),
  }),
];

/**
 * The dispatch desk again — scheduler and carrier quote adapter in ONE module
 * — but with a scheduler that shows no steps and declares its calls instead.
 * Only the declaration varies: the module always quotes AND surcharges
 * through the colocated adapter.
 */
function declaredCallDeskTree(declaredCalls: string[]): import('../harness.js').FixtureTree {
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
        methods: [
          { name: 'fetchQuotes', description: 'Fetch current rate quotes from all connected carriers.' },
          { name: 'fetchSurcharges', description: 'Fetch the fuel and residential surcharges each carrier adds to a quote.' },
        ],
      },
    ],
    implementations: [
      {
        id: 'shipment_scheduler_impl',
        contract: 'ishipment_scheduler',
        sourcePath: 'src/fulfillment/dispatch-desk.ts',
        methods: [
          {
            name: 'scheduleShipment',
            detail: 'intent',
            intent:
              'Book a parcel with the carrier that is cheapest once surcharges are counted: take each carrier\'s base quote, add the surcharges that carrier applies to this parcel, and hand the parcel to the lowest total that still meets the promised delivery window. A carrier that quotes nothing for the parcel is skipped rather than booked at a default rate.',
            calls: declaredCalls,
          },
        ],
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
          {
            name: 'fetchSurcharges',
            narrative: [{ stepNumber: 1, type: 'local', description: 'Call each connected carrier surcharge API and merge the answers.' }],
          },
        ],
      },
    ],
    files: {
      'src/fulfillment/dispatch-desk.ts': [
        'export function scheduleShipment(parcelId: string): void {',
        '  const quotes = fetchQuotes(parcelId);',
        '  const surcharges = fetchSurcharges(parcelId);',
        '  bookCheapest(parcelId, quotes, surcharges);',
        '}',
        '',
        'export function fetchQuotes(parcelId: string): number[] {',
        '  return [12.5, 14.0];',
        '}',
        '',
        'export function fetchSurcharges(parcelId: string): number[] {',
        '  return [1.75, 0.5];',
        '}',
        '',
        'function bookCheapest(parcelId: string, quotes: number[], surcharges: number[]): void {',
        '  // hand the cheapest total to the chosen carrier',
        '}',
        '',
      ].join('\n'),
    },
  };
}

/**
 * A restock planner that declares its calls instead of narrating them — the
 * `calls` counterpart of the opening `call`-step pair. Only the planner
 * module's text varies: `callsTheCatalogue` writes the call the declaration
 * claims, or leaves it out.
 */
function restockPlannerTree(callsTheCatalogue: boolean): import('../harness.js').FixtureTree {
  return {
    subsystems: [{ id: 'warehouse', description: 'Stock levels, replenishment planning and supplier hand-off.' }],
    components: [
      {
        id: 'restock-planner',
        componentType: 'Orchestrator',
        subsystem: 'warehouse',
        description: 'Decides when each stock line is reordered and how much of it to reorder.',
        dependsOn: ['supplier-catalog'],
      },
      {
        id: 'supplier-catalog',
        componentType: 'Adapter',
        subsystem: 'warehouse',
        description: 'Wraps the supplier trading APIs behind one catalogue of prices and lead times.',
      },
    ],
    interfaces: [
      {
        id: 'irestock_planner',
        component: 'restock-planner',
        methods: [{ name: 'planRestock', description: 'Decide the reorder quantity and date for one stock line.' }],
      },
      {
        id: 'isupplier_catalog',
        component: 'supplier-catalog',
        methods: [{ name: 'leadTimes', description: 'Read each supplier\'s current lead time for one stock keeping unit.' }],
      },
    ],
    implementations: [
      {
        id: 'restock_planner_impl',
        contract: 'irestock_planner',
        sourcePath: 'src/warehouse/restock-planner.ts',
        methods: [
          {
            name: 'planRestock',
            detail: 'intent',
            intent:
              'Reorder a stock line before it runs out: read the supplier lead times for the unit, project the stock on hand across the longest of them, and order the shortfall from the cheapest supplier that can deliver inside the window. A supplier that answers with no lead time is left out of the projection rather than assumed instant.',
            calls: ['supplier-catalog.leadTimes'],
          },
        ],
      },
      {
        id: 'supplier_catalog_impl',
        contract: 'isupplier_catalog',
        sourcePath: 'src/warehouse/supplier-catalog.ts',
        methods: [
          {
            name: 'leadTimes',
            narrative: [{ stepNumber: 1, type: 'local', description: 'Ask each connected supplier API for the unit\'s current lead time and merge the answers.' }],
          },
        ],
      },
    ],
    files: {
      'src/warehouse/restock-planner.ts': (callsTheCatalogue
        ? [
          'import { leadTimes } from \'./supplier-catalog.js\';',
          '',
          'export function planRestock(sku: string, onHand: number): number {',
          '  const days = leadTimes(sku);',
          '  return Math.max(0, days.length * 10 - onHand);',
          '}',
          '',
        ]
        : [
          'const STALE_LEAD_DAYS: Record<string, number> = { \'pallet-wrap\': 14 };',
          '',
          'export function planRestock(sku: string, onHand: number): number {',
          '  // the catalogue call was dropped for a hard-coded table nobody has refreshed',
          '  return Math.max(0, (STALE_LEAD_DAYS[sku] ?? 7) * 10 - onHand);',
          '}',
          '',
        ]).join('\n'),
      'src/warehouse/supplier-catalog.ts': [
        'export function leadTimes(sku: string): number[] {',
        '  return sku.length > 0 ? [3, 9] : [];',
        '}',
        '',
      ].join('\n'),
    },
  };
}

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
/**
 * A payroll journal writer that INHERITS its append from a general-ledger
 * writer in another module, and an entry recorder that constructs it inline.
 * `target` picks which of the two the recorder's narrative names: the base
 * module the method is really written in, or the derived module the
 * constructed class is written in. The one fixture family where those are not
 * the same file — which is exactly the limit of following a `new Class(…)`.
 */
function ledgerJournalTree(target: 'ledger-writer' | 'journal-writer'): import('../harness.js').FixtureTree {
  return {
    subsystems: [{ id: 'accounting', description: 'General-ledger posting for the payroll runs.' }],
    components: [
      {
        id: 'entry-recorder',
        componentType: 'Orchestrator',
        subsystem: 'accounting',
        description: 'Records each payroll line as one journal entry on the run\'s open journal.',
        dependsOn: ['journal-writer', 'ledger-writer'],
      },
      {
        id: 'journal-writer',
        componentType: 'Adapter',
        subsystem: 'accounting',
        description: 'The payroll journal\'s writer: general-ledger appends stamped with the run\'s journal id.',
        dependsOn: ['ledger-writer'],
      },
      {
        id: 'ledger-writer',
        componentType: 'Adapter',
        subsystem: 'accounting',
        description: 'The append-only entry log of the general ledger.',
      },
    ],
    interfaces: [
      {
        id: 'ientry_recorder',
        component: 'entry-recorder',
        methods: [{ name: 'record', description: 'Record one payroll line as a journal entry.' }],
      },
      {
        id: 'ijournal_writer',
        component: 'journal-writer',
        methods: [{ name: 'append', description: 'Append one entry to the run\'s payroll journal.' }],
      },
      {
        id: 'iledger_writer',
        component: 'ledger-writer',
        methods: [{ name: 'append', description: 'Append one entry to the general ledger.' }],
      },
    ],
    implementations: [
      {
        id: 'entry_recorder_impl',
        contract: 'ientry_recorder',
        sourcePath: 'src/accounting/entry-recorder.ts',
        methods: [
          {
            name: 'record',
            narrative: [
              {
                stepNumber: 1,
                type: 'call',
                description: 'Append the payroll line as a journal entry.',
                targetComponent: target,
                targetMethod: 'append',
              },
            ],
          },
        ],
      },
      {
        id: 'journal_writer_impl',
        contract: 'ijournal_writer',
        sourcePath: 'src/accounting/journal-writer.ts',
        methods: [
          {
            name: 'append',
            narrative: [{ stepNumber: 1, type: 'local', description: 'Stamp the entry with the journal id and append it to the general ledger.' }],
          },
        ],
      },
      {
        id: 'ledger_writer_impl',
        contract: 'iledger_writer',
        sourcePath: 'src/accounting/ledger-writer.ts',
        methods: [
          {
            name: 'append',
            narrative: [{ stepNumber: 1, type: 'local', description: 'Append the entry to the general ledger\'s open period.' }],
          },
        ],
      },
    ],
    files: {
      'src/accounting/entry-recorder.ts': [
        'import { JournalWriter } from \'./journal-writer.js\';',
        '',
        '/** Records each payroll line as one journal entry on the run\'s open journal. */',
        'export class EntryRecorder {',
        '  record(entry: string): void {',
        '    new JournalWriter(\'2026-Q1\').append(entry);',
        '  }',
        '}',
        '',
      ].join('\n'),
      // The derived class declares NO append of its own: the body this call
      // reaches lives in the BASE module, which the constructed class's name
      // does not point at.
      'src/accounting/journal-writer.ts': [
        'import { LedgerWriter } from \'./ledger-writer.js\';',
        '',
        '/** The payroll journal\'s writer: general-ledger appends stamped with the run\'s journal id. */',
        'export class JournalWriter extends LedgerWriter {',
        '  constructor(private readonly journalId: string) {',
        '    super();',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/accounting/ledger-writer.ts': [
        '/** The append-only entry log of the general ledger. */',
        'export class LedgerWriter {',
        '  append(entry: string): void {',
        '    // append the entry to the general ledger\'s open period',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
  };
}

/**
 * The payslip repository wired as a CLOSURE over its store, with the store's
 * CONTRACT declared in a module of its own beside the class that implements
 * it; only the repository module's text varies. The one family where the file
 * a parameter's TYPE is written in and the file its BODY is written in are
 * different files — which is exactly the limit of following an annotated
 * receiver.
 */
function payslipContractTree(repositoryModule: string): import('../harness.js').FixtureTree {
  return {
    subsystems: [{ id: 'payroll', description: 'Pay runs, payslip records and their retention.' }],
    components: [
      {
        id: 'payslip-repository',
        componentType: 'Repository',
        subsystem: 'payroll',
        description: 'The pay-run facade over the payslip rows of the open run.',
        owns: ['payslip-store'],
      },
      {
        id: 'payslip-store',
        componentType: 'Store',
        subsystem: 'payroll',
        durability: 'read-through',
        description: 'The authoritative payslip rows of every open pay run.',
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
    ],
    types: [
      {
        id: 'payslip-rows',
        kind: 'value-object',
        name: 'PayslipRows',
        subsystem: 'payroll',
        description: 'The contract every holder of payslip rows answers: one append per recorded payslip.',
        sourcePath: 'src/payroll/payslip-rows.ts',
      },
    ],
    files: {
      'src/payroll/payslip-repository.ts': repositoryModule,
      // The CONTRACT, in a module of its own: what the parameter is annotated
      // with, and never where a body that answers it is written.
      'src/payroll/payslip-rows.ts': [
        '/** The contract every holder of payslip rows answers. */',
        'export interface PayslipRows {',
        '  append(payslipId: string): void;',
        '}',
        '',
      ].join('\n'),
      'src/payroll/payslip-store.ts': [
        'import type { PayslipRows } from \'./payslip-rows.js\';',
        '',
        '/** The authoritative payslip rows of every open pay run. */',
        'export class PayslipStore implements PayslipRows {',
        '  append(payslipId: string): void {',
        '    // persist the payslip row',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
  };
}
