/**
 * Method-cohesion family (src/core/rules/heuristic/method-cohesion.ts).
 *
 * Documented intent pinned here:
 *  - INCOHESIVE_METHODS (warning): an Orchestrator's methods fall into two or
 *    more groups of two or more that call no component in common, which is the
 *    "and" in a responsibility made visible. Judged from the narratives' own
 *    call/dispatch edges, and deliberately conservative — one specialized
 *    method beside a cohesive set is never a finding, and a PURE FORWARDER
 *    (every narrated method a single hand-off) is exempt outright, because the
 *    responsibility lives in whatever it forwards to.
 */
import { defineRuleFixture } from '../harness.js';

const SYSTEM = {
  name: 'Freightline',
  vision: 'Freight brokerage platform covering shipment booking, carrier dispatch, and settlement billing.',
};

const DISPATCH_SUB = { id: 'dispatch', description: 'Shipment booking, slot reservation, and settlement billing for dispatched loads.' };

/** The pure checks the workflow drives — each one a real decision, none of them holding state. */
const CHECKS = [
  { id: 'slot-availability', method: 'check', description: 'Decides whether a dock slot is still free for a requested window.' },
  { id: 'booking-ledger', method: 'record', description: 'Records the booking movements a reserved slot produces.' },
  { id: 'invoice-ledger', method: 'post', description: 'Posts the invoice movements a settled load produces.' },
  { id: 'tax-rate-table', method: 'lookup', description: 'Resolves the tax rate that applies to a settled load.' },
];

const checkComponents = CHECKS.map(c => ({
  id: c.id,
  componentType: 'Orchestrator',
  dependencyClass: 'pure',
  description: c.description,
}));

const checkInterfaces = CHECKS.map(c => ({
  id: `i${c.id.replace(/-/g, '_')}`,
  component: c.id,
  methods: [{ name: c.method, description: `${c.description}` }],
}));

/** A workflow method whose narrative drives each named check once, in order. */
function drives(name: string, targets: string[]) {
  return {
    name,
    narrative: targets.map((targetComponent, i) => {
      const check = CHECKS.find(c => c.id === targetComponent)!;
      return {
        stepNumber: i + 1,
        type: 'call',
        description: `Ask ${targetComponent} to ${check.method} for the ${name} flow.`,
        targetComponent,
        targetMethod: check.method,
      };
    }),
  };
}

const BOOKING = [drives('reserveSlot', ['slot-availability', 'booking-ledger']), drives('releaseSlot', ['slot-availability'])];
const BILLING = [drives('issueInvoice', ['invoice-ledger', 'tax-rate-table']), drives('voidInvoice', ['invoice-ledger'])];

/** A console method that hands the call straight to the workflow that owns it. */
function handsOff(name: string, targetComponent: string) {
  return {
    name,
    narrative: [
      {
        stepNumber: 1,
        type: 'call',
        description: `Hand ${name} to ${targetComponent} with the dispatcher's credential unchanged.`,
        targetComponent,
        targetMethod: name,
      },
      { stepNumber: 2, type: 'return', description: `Return what ${targetComponent} answered.`, outcome: `${name} result` },
    ],
  };
}

const CONSOLE_METHODS = [
  ...BOOKING.map(m => handsOff(m.name, 'dispatch-orchestrator')),
  ...BILLING.map(m => handsOff(m.name, 'billing-orchestrator')),
];

export default [
  defineRuleFixture({
    code: 'INCOHESIVE_METHODS',
    severity: 'warning',
    anchoredTo: 'dispatch-orchestrator',
    expectFire: true,
    scenario:
      'The dispatch orchestrator both reserves dock slots and settles invoices: its slot methods drive slot-availability, its invoice methods drive invoice-ledger, and the two halves share nothing.',
    tree: {
      system: SYSTEM,
      subsystems: [DISPATCH_SUB],
      components: [
        {
          id: 'dispatch-orchestrator',
          componentType: 'Orchestrator',
          description: 'Reserves dock slots for booked loads and settles their invoices.',
          dependsOn: CHECKS.map(c => c.id),
        },
        ...checkComponents,
      ],
      interfaces: [
        {
          id: 'idispatch_orchestrator',
          component: 'dispatch-orchestrator',
          methods: [...BOOKING, ...BILLING].map(m => ({ name: m.name, description: `Run the ${m.name} step of the dispatch workflow.` })),
        },
        ...checkInterfaces,
      ],
      implementations: [
        { id: 'dispatch_orchestrator_impl', contract: 'idispatch_orchestrator', methods: [...BOOKING, ...BILLING] },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INCOHESIVE_METHODS',
    expectFire: false,
    reason: 'Each orchestrator now holds one responsibility, so every method in it shares a collaborator with the rest — exactly the split the finding asks for.',
    scenario:
      'The slot methods stay on the dispatch orchestrator and the invoice methods move to a billing orchestrator of their own.',
    tree: {
      system: SYSTEM,
      subsystems: [DISPATCH_SUB],
      components: [
        {
          id: 'dispatch-orchestrator',
          componentType: 'Orchestrator',
          description: 'Reserves and releases dock slots for booked loads.',
          dependsOn: ['slot-availability', 'booking-ledger'],
        },
        {
          id: 'billing-orchestrator',
          componentType: 'Orchestrator',
          description: 'Issues and voids the invoices a settled load produces.',
          dependsOn: ['invoice-ledger', 'tax-rate-table'],
        },
        ...checkComponents,
      ],
      interfaces: [
        {
          id: 'idispatch_orchestrator',
          component: 'dispatch-orchestrator',
          methods: BOOKING.map(m => ({ name: m.name, description: `Run the ${m.name} step of the dispatch workflow.` })),
        },
        {
          id: 'ibilling_orchestrator',
          component: 'billing-orchestrator',
          methods: BILLING.map(m => ({ name: m.name, description: `Run the ${m.name} step of the billing workflow.` })),
        },
        ...checkInterfaces,
      ],
      implementations: [
        { id: 'dispatch_orchestrator_impl', contract: 'idispatch_orchestrator', methods: BOOKING },
        { id: 'billing_orchestrator_impl', contract: 'ibilling_orchestrator', methods: BILLING },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INCOHESIVE_METHODS',
    expectFire: false,
    reason:
      'The console is a pure forwarder: every method is one hand-off and nothing else, so it holds no responsibility of its own to be split — the booking and billing workflows each hold theirs. Its methods reach different components BECAUSE it is a switchboard, which is exactly the shape the exemption spares; without it the two halves would read as the "and" in a responsibility.',
    scenario:
      'A dispatch console forwards each terminal command to the workflow that owns it — slot commands to the dispatch orchestrator, invoice commands to the billing orchestrator — and does nothing else in any method.',
    tree: {
      system: SYSTEM,
      subsystems: [DISPATCH_SUB],
      components: [
        {
          id: 'dispatch-console',
          componentType: 'Orchestrator',
          description: 'Single entry point for the dispatcher terminal: hands each command to the workflow that owns it.',
          dependsOn: ['dispatch-orchestrator', 'billing-orchestrator'],
        },
        {
          id: 'dispatch-orchestrator',
          componentType: 'Orchestrator',
          description: 'Reserves and releases dock slots for booked loads.',
          dependsOn: ['slot-availability', 'booking-ledger'],
        },
        {
          id: 'billing-orchestrator',
          componentType: 'Orchestrator',
          description: 'Issues and voids the invoices a settled load produces.',
          dependsOn: ['invoice-ledger', 'tax-rate-table'],
        },
        ...checkComponents,
      ],
      interfaces: [
        {
          id: 'idispatch_console',
          component: 'dispatch-console',
          methods: CONSOLE_METHODS.map(m => ({ name: m.name, description: `Hand the ${m.name} command to the workflow that owns it.` })),
        },
        {
          id: 'idispatch_orchestrator',
          component: 'dispatch-orchestrator',
          methods: BOOKING.map(m => ({ name: m.name, description: `Run the ${m.name} step of the dispatch workflow.` })),
        },
        {
          id: 'ibilling_orchestrator',
          component: 'billing-orchestrator',
          methods: BILLING.map(m => ({ name: m.name, description: `Run the ${m.name} step of the billing workflow.` })),
        },
        ...checkInterfaces,
      ],
      implementations: [
        { id: 'dispatch_console_impl', contract: 'idispatch_console', methods: CONSOLE_METHODS },
        { id: 'dispatch_orchestrator_impl', contract: 'idispatch_orchestrator', methods: BOOKING },
        { id: 'billing_orchestrator_impl', contract: 'ibilling_orchestrator', methods: BILLING },
      ],
    },
  }),
];
