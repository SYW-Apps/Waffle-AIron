/**
 * The conformance debt register — `rules.conformance.carried`, the one-way
 * register that lets a tree carry measured code↔spec debt honestly instead of
 * suppressing it.
 *
 *  - UNCARRYABLE_FINDING (error): the register names a code no rule emits, or
 *    one no rule declares CARRYABLE. The register holds measured code↔spec
 *    debt; a doctrine, soundness or configuration finding says the design is
 *    illegal rather than unfinished, and may never be carried. An error, so no
 *    lint allow and no --ci waiver can reach it.
 *  - STALE_CARRIED_FINDING (warning): an entry that carries a finding which no
 *    longer fires, or that lists a unit the live finding no longer reports.
 *    The register is exactly the set that would otherwise fire, so it can only
 *    shrink.
 *
 * The two UNDECLARED_COLOCATED_CALL fixtures here belong to this family rather
 * than to the call rule's: what they pin is the CARRYING, not the crossing.
 * An aggregating finding is many facts wearing one message, so an entry
 * carries it only when it lists every unit it reports — a crossing nobody
 * carried fires on the day it appears, which is what keeps the register from
 * growing behind its own entries.
 */
import { defineRuleFixture } from '../harness.js';

/** The narrative step that declares the quote call, for the trees where it is declared. */
const QUOTE_STEP = {
  stepNumber: 1,
  type: 'call',
  description: 'Fetch carrier quotes for the parcel.',
  targetComponent: 'carrier-quote-adapter',
  targetMethod: 'fetchQuotes',
};

/** The narrative step that declares the booking call. */
const BOOKING_STEP = {
  stepNumber: 2,
  type: 'call',
  description: 'Record the booking against the chosen carrier.',
  targetComponent: 'carrier-quote-adapter',
  targetMethod: 'recordBooking',
};

const PICK_STEP = { stepNumber: 1, type: 'local', description: 'Pick the cheapest quote that meets the delivery window.' };

/** The dispatch desk module: the scheduler calls BOTH adapter functions beside it. */
const DISPATCH_DESK_MODULE = [
  'export function fetchQuotes(parcelId: string): number[] {',
  '  return [parcelId.length];',
  '}',
  '',
  'export function recordBooking(parcelId: string, price: number): void {',
  '  void parcelId; void price;',
  '}',
  '',
  'export function scheduleShipment(parcelId: string): void {',
  '  const quotes = fetchQuotes(parcelId);',
  '  recordBooking(parcelId, Math.min(...quotes));',
  '}',
  '',
].join('\n');

/**
 * A dispatch desk where the shipment scheduler and the carrier quote adapter
 * share ONE module, so both of the scheduler's calls cross a component
 * boundary that nothing imports. Only the scheduler's narrative and the
 * project's debt register vary.
 */
function dispatchDeskTree(opts: {
  schedulerNarrative: Record<string, unknown>[];
  carried: unknown;
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
        description: 'Wraps the external carrier rate APIs behind one quote and booking interface.',
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
          { name: 'recordBooking', description: 'Record an accepted booking with the winning carrier.' },
        ],
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
          { name: 'fetchQuotes', narrative: [{ stepNumber: 1, type: 'local', description: 'Call each connected carrier rate API and merge the quotes.' }] },
          { name: 'recordBooking', narrative: [{ stepNumber: 1, type: 'local', description: 'Write the accepted booking to the carrier booking log.' }] },
        ],
      },
    ],
    rules: { conformance: { carried: opts.carried } },
    files: { 'src/fulfillment/dispatch-desk.ts': DISPATCH_DESK_MODULE },
  };
}

/** The debt register the fulfillment team actually wrote down, with the units it carries. */
const carryingCrossings = (covers: string[]) => [{
  kind: 'undecided',
  why: 'The dispatch desk is one module modelled as a scheduler and an adapter, so every hop between them looks local. Splitting the module is a real change nobody has scheduled yet.',
  findings: [{
    code: 'UNDECLARED_COLOCATED_CALL',
    spec: 'shipment_scheduler_impl',
    at: 'scheduleShipment',
    covers,
  }],
}];

export default [
  // -------------------------------------------------------------------------
  // UNDECLARED_COLOCATED_CALL under the register: an entry carries a finding
  // only when it lists EVERY unit that finding reports
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_COLOCATED_CALL',
    severity: 'warning',
    anchoredTo: 'shipment_scheduler_impl',
    expectFire: true,
    scenario:
      'The dispatch desk\'s debt register was written when the scheduler only quoted through the adapter; the booking call was added afterwards, and nobody carried it — so the crossing the register never named still fires.',
    tree: dispatchDeskTree({
      schedulerNarrative: [PICK_STEP],
      carried: carryingCrossings(['carrier-quote-adapter.fetchQuotes']),
    }),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_COLOCATED_CALL',
    expectFire: false,
    reason:
      'The register names both crossings the finding reports, so the whole finding is carried as declared debt — which is what the register is for.',
    scenario:
      'The dispatch desk carries both of its colocated crossings in the debt register, under one reason that says why the module has not been split.',
    tree: dispatchDeskTree({
      schedulerNarrative: [PICK_STEP],
      carried: carryingCrossings(['carrier-quote-adapter.fetchQuotes', 'carrier-quote-adapter.recordBooking']),
    }),
  }),

  // -------------------------------------------------------------------------
  // STALE_CARRIED_FINDING — the register only shrinks
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'STALE_CARRIED_FINDING',
    severity: 'warning',
    anchoredTo: null,
    expectFire: true,
    scenario:
      'The scheduler narrative now declares both of its calls to the carrier quote adapter, so the colocated-call finding is gone — but the debt register still carries it.',
    tree: dispatchDeskTree({
      schedulerNarrative: [QUOTE_STEP, BOOKING_STEP],
      carried: carryingCrossings(['carrier-quote-adapter.fetchQuotes', 'carrier-quote-adapter.recordBooking']),
    }),
  }),
  defineRuleFixture({
    code: 'STALE_CARRIED_FINDING',
    severity: 'warning',
    anchoredTo: null,
    expectFire: true,
    scenario:
      'Half the dispatch desk debt was paid: the scheduler now narrates its booking call, so the register carries a unit the finding no longer reports.',
    tree: dispatchDeskTree({
      schedulerNarrative: [{ ...BOOKING_STEP, stepNumber: 1 }],
      carried: carryingCrossings(['carrier-quote-adapter.fetchQuotes', 'carrier-quote-adapter.recordBooking']),
    }),
  }),
  defineRuleFixture({
    code: 'STALE_CARRIED_FINDING',
    expectFire: false,
    reason:
      'The entry names exactly the finding that fires and exactly the units it reports, which is the register in its only stable state.',
    scenario:
      'The dispatch desk register lists precisely the two crossings the scheduler still makes without narrating them.',
    tree: dispatchDeskTree({
      schedulerNarrative: [PICK_STEP],
      carried: carryingCrossings(['carrier-quote-adapter.fetchQuotes', 'carrier-quote-adapter.recordBooking']),
    }),
  }),

  // -------------------------------------------------------------------------
  // UNCARRYABLE_FINDING — the closed code set that keeps the register from
  // becoming a second, general-purpose lint.allow
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNCARRYABLE_FINDING',
    severity: 'error',
    anchoredTo: null,
    expectFire: true,
    scenario:
      'Someone tried to quiet a doctrine finding by writing it into the debt register, where only measured code-versus-spec debt belongs.',
    tree: dispatchDeskTree({
      schedulerNarrative: [PICK_STEP],
      carried: [{
        kind: 'undecided',
        why: 'The scheduler writes through the repository facade and we have not reworked it yet.',
        findings: [{ code: 'PORTAL_WRITE_SHORTCUT', spec: 'shipment_scheduler_impl', at: 'scheduleShipment' }],
      }],
    }),
  }),
  defineRuleFixture({
    code: 'UNCARRYABLE_FINDING',
    expectFire: false,
    reason:
      'UNDECLARED_COLOCATED_CALL measures this project\'s own code against its own spec at a site the finding names, which is exactly what a carryable code is.',
    scenario:
      'The dispatch desk register names only the colocated-call finding its own module produces.',
    tree: dispatchDeskTree({
      schedulerNarrative: [PICK_STEP],
      carried: carryingCrossings(['carrier-quote-adapter.fetchQuotes', 'carrier-quote-adapter.recordBooking']),
    }),
  }),
];
