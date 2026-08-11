/**
 * Public-surface binding fixtures (src/core/rules/public-surface.ts).
 *
 * Documented intents pinned here:
 *  - PUBLIC_INTERFACE_UNBOUND (error): every declared publicInterface names a
 *    backing component.
 *  - PUBLIC_INTERFACE_INVALID_COMPONENT (error): the backing component must
 *    exist.
 *  - PUBLIC_INTERFACE_FOREIGN_COMPONENT (error): a subsystem may only publish
 *    its own components.
 *  - PUBLIC_INTERFACE_TYPE_MISMATCH (error): the backing component's
 *    stereotype must be able to realize the declared type. Two documented
 *    behaviors exercised: REST demands a Portal/HTTP_API; MessageBus demands
 *    a Portal/MessageBus or an Observer.
 *  - PUBLIC_INTERFACE_INVALID_INTERFACE (error, two documented behaviors):
 *    the bound L3 interface must exist and must belong to the bound
 *    component.
 *  - PUBLIC_INTERFACE_EVENT_MISTYPED (warning): a Custom entry whose prose
 *    implies eventing must be backed by an event-capable component (Observer
 *    or Portal/MessageBus).
 */
import { defineRuleFixture } from '../harness.js';

const SYSTEM = {
  name: 'MediBook',
  vision: 'Clinic appointment booking platform covering scheduling, billing, and partner integrations.',
};

const INVOICE_PORTAL = {
  id: 'invoice-api-portal',
  componentType: 'Portal',
  portalType: 'HTTP_API',
  subsystem: 'billing',
  description: 'Inbound REST surface for invoice retrieval and submission.',
};

const INVOICE_ORCH = {
  id: 'invoice-drafting-orchestrator',
  componentType: 'Orchestrator',
  subsystem: 'billing',
  description: 'Drafts invoices for completed visits.',
};

const INVOICE_API_INTERFACE = {
  id: 'iinvoice_api',
  component: 'invoice-api-portal',
  methods: [
    {
      name: 'getInvoice',
      description: 'Fetch one invoice by id.',
      endpoint: { transport: 'HTTP', method: 'GET', path: '/invoices/{invoiceId}' },
    },
  ],
};

export default [
  // -------------------------------------------------------------------------
  // PUBLIC_INTERFACE_UNBOUND
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_UNBOUND',
    severity: 'error',
    anchoredTo: 'billing',
    expectFire: true,
    scenario:
      'The billing subsystem declares a REST public interface without naming the component that realizes it.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          id: 'billing',
          description: 'Invoicing and payment collection for booked visits.',
          publicInterfaces: [{ type: 'REST', details: 'Invoice REST API for partner systems.' }],
        },
      ],
      components: [INVOICE_PORTAL],
      interfaces: [INVOICE_API_INTERFACE],
    },
  }),
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_UNBOUND',
    expectFire: false,
    reason: 'The public interface is bound to the invoice API portal that realizes it.',
    scenario:
      'The billing subsystem binds its REST public interface to the invoice API portal.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          id: 'billing',
          description: 'Invoicing and payment collection for booked visits.',
          publicInterfaces: [{ type: 'REST', details: 'Invoice REST API for partner systems.', component: 'invoice-api-portal' }],
        },
      ],
      components: [INVOICE_PORTAL],
      interfaces: [INVOICE_API_INTERFACE],
    },
  }),

  // -------------------------------------------------------------------------
  // PUBLIC_INTERFACE_INVALID_COMPONENT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_INVALID_COMPONENT',
    severity: 'error',
    anchoredTo: 'billing',
    expectFire: true,
    scenario:
      'The billing subsystem publishes a REST surface backed by an invoice API portal component that no longer exists in the tree.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          id: 'billing',
          description: 'Invoicing and payment collection for booked visits.',
          publicInterfaces: [{ type: 'REST', details: 'Invoice REST API for partner systems.', component: 'invoice-api-portal' }],
        },
      ],
      components: [INVOICE_ORCH],
    },
  }),
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_INVALID_COMPONENT',
    expectFire: false,
    reason: 'The referenced backing component exists in the billing subsystem.',
    scenario:
      'The billing subsystem publishes a REST surface backed by the invoice API portal that exists in the tree.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          id: 'billing',
          description: 'Invoicing and payment collection for booked visits.',
          publicInterfaces: [{ type: 'REST', details: 'Invoice REST API for partner systems.', component: 'invoice-api-portal' }],
        },
      ],
      components: [INVOICE_PORTAL, INVOICE_ORCH],
      interfaces: [INVOICE_API_INTERFACE],
    },
  }),

  // -------------------------------------------------------------------------
  // PUBLIC_INTERFACE_FOREIGN_COMPONENT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_FOREIGN_COMPONENT',
    severity: 'error',
    anchoredTo: 'billing',
    expectFire: true,
    scenario:
      'The billing subsystem publishes the schedule portal although that component belongs to the scheduling subsystem.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { id: 'scheduling', description: 'Appointment booking and slot management.' },
        {
          id: 'billing',
          description: 'Invoicing and payment collection for booked visits.',
          publicInterfaces: [{ type: 'Custom', details: 'Visit schedule feed for invoicing.', component: 'schedule-portal' }],
        },
      ],
      components: [
        { id: 'schedule-portal', componentType: 'Portal', portalType: 'Custom', subsystem: 'scheduling', description: 'Inbound scheduling surface.' },
        INVOICE_PORTAL,
      ],
      interfaces: [INVOICE_API_INTERFACE],
    },
  }),
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_FOREIGN_COMPONENT',
    expectFire: false,
    reason: 'The published component belongs to the publishing subsystem itself.',
    scenario:
      'The billing subsystem publishes its own invoice API portal while scheduling publishes its own schedule portal.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          id: 'scheduling',
          description: 'Appointment booking and slot management.',
          publicInterfaces: [{ type: 'Custom', details: 'Visit schedule feed for sibling subsystems.', component: 'schedule-portal' }],
        },
        {
          id: 'billing',
          description: 'Invoicing and payment collection for booked visits.',
          publicInterfaces: [{ type: 'REST', details: 'Invoice REST API for partner systems.', component: 'invoice-api-portal' }],
        },
      ],
      components: [
        { id: 'schedule-portal', componentType: 'Portal', portalType: 'Custom', subsystem: 'scheduling', description: 'Inbound scheduling surface.' },
        INVOICE_PORTAL,
      ],
      interfaces: [INVOICE_API_INTERFACE],
    },
  }),

  // -------------------------------------------------------------------------
  // PUBLIC_INTERFACE_TYPE_MISMATCH — REST behavior
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_TYPE_MISMATCH',
    severity: 'error',
    anchoredTo: 'billing',
    expectFire: true,
    scenario:
      'The billing subsystem declares a REST public interface backed by the invoice drafting orchestrator, which cannot realize a REST surface.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          id: 'billing',
          description: 'Invoicing and payment collection for booked visits.',
          publicInterfaces: [{ type: 'REST', details: 'Invoice REST API for partner systems.', component: 'invoice-drafting-orchestrator' }],
        },
      ],
      components: [INVOICE_ORCH],
    },
  }),
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_TYPE_MISMATCH',
    expectFire: false,
    reason: 'A REST public interface demands a Portal with portalType HTTP_API (documented), which is exactly what backs this entry.',
    scenario:
      'The billing subsystem\'s REST public interface is backed by the HTTP invoice API portal.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          id: 'billing',
          description: 'Invoicing and payment collection for booked visits.',
          publicInterfaces: [{ type: 'REST', details: 'Invoice REST API for partner systems.', component: 'invoice-api-portal' }],
        },
      ],
      components: [INVOICE_PORTAL],
      interfaces: [INVOICE_API_INTERFACE],
    },
  }),

  // -------------------------------------------------------------------------
  // PUBLIC_INTERFACE_TYPE_MISMATCH — MessageBus behavior
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_TYPE_MISMATCH',
    severity: 'error',
    anchoredTo: 'billing',
    expectFire: true,
    scenario:
      'The billing subsystem declares a MessageBus public interface backed by its HTTP invoice portal, which cannot realize a bus surface.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          id: 'billing',
          description: 'Invoicing and payment collection for booked visits.',
          publicInterfaces: [{ type: 'MessageBus', details: 'Invoice settled events on the clinic bus.', component: 'invoice-api-portal' }],
        },
      ],
      components: [INVOICE_PORTAL],
      interfaces: [INVOICE_API_INTERFACE],
    },
  }),
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_TYPE_MISMATCH',
    expectFire: false,
    reason: 'A MessageBus public interface may be backed by an Observer (documented alternative to a Portal/MessageBus).',
    scenario:
      'The billing subsystem\'s MessageBus public interface is backed by the invoice event observer.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          id: 'billing',
          description: 'Invoicing and payment collection for booked visits.',
          publicInterfaces: [{ type: 'MessageBus', details: 'Invoice settled events on the clinic bus.', component: 'invoice-event-observer' }],
        },
      ],
      components: [
        { id: 'invoice-event-observer', componentType: 'Observer', subsystem: 'billing', description: 'Subscribes to and republishes invoice events on the clinic bus.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // PUBLIC_INTERFACE_INVALID_INTERFACE — missing interface behavior
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_INVALID_INTERFACE',
    severity: 'error',
    anchoredTo: 'billing',
    expectFire: true,
    scenario:
      'The billing subsystem binds its REST public interface to a retired invoice API contract that no longer exists as an L3 interface.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          id: 'billing',
          description: 'Invoicing and payment collection for booked visits.',
          publicInterfaces: [
            { type: 'REST', details: 'Invoice REST API for partner systems.', component: 'invoice-api-portal', interface: 'iretired_invoice_api' },
          ],
        },
      ],
      components: [INVOICE_PORTAL],
      interfaces: [INVOICE_API_INTERFACE],
    },
  }),

  // -------------------------------------------------------------------------
  // PUBLIC_INTERFACE_INVALID_INTERFACE — foreign-owner behavior
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_INVALID_INTERFACE',
    severity: 'error',
    anchoredTo: 'billing',
    expectFire: true,
    scenario:
      'The billing subsystem binds the schedule feed contract to its invoice API portal, but that L3 interface belongs to the schedule portal.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { id: 'scheduling', description: 'Appointment booking and slot management.' },
        {
          id: 'billing',
          description: 'Invoicing and payment collection for booked visits.',
          publicInterfaces: [
            { type: 'REST', details: 'Invoice REST API for partner systems.', component: 'invoice-api-portal', interface: 'ischedule_feed' },
          ],
        },
      ],
      components: [
        { id: 'schedule-portal', componentType: 'Portal', portalType: 'Custom', subsystem: 'scheduling', description: 'Inbound scheduling surface.' },
        INVOICE_PORTAL,
      ],
      interfaces: [
        {
          id: 'ischedule_feed',
          component: 'schedule-portal',
          methods: [{ name: 'streamSchedule', description: 'Stream the visit schedule to consumers.' }],
        },
        INVOICE_API_INTERFACE,
      ],
    },
  }),
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_INVALID_INTERFACE',
    expectFire: false,
    reason: 'The bound L3 interface exists and belongs to the bound backing component.',
    scenario:
      'The billing subsystem binds its REST public interface to the invoice API contract that its invoice API portal owns.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          id: 'billing',
          description: 'Invoicing and payment collection for booked visits.',
          publicInterfaces: [
            { type: 'REST', details: 'Invoice REST API for partner systems.', component: 'invoice-api-portal', interface: 'iinvoice_api' },
          ],
        },
      ],
      components: [INVOICE_PORTAL],
      interfaces: [INVOICE_API_INTERFACE],
    },
  }),

  // -------------------------------------------------------------------------
  // PUBLIC_INTERFACE_EVENT_MISTYPED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_EVENT_MISTYPED',
    severity: 'warning',
    anchoredTo: 'billing',
    expectFire: true,
    scenario:
      'The billing subsystem declares a Custom public interface whose prose promises invoice-settled events on the clinic message bus, but backs it with the synchronous invoice drafting orchestrator.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          id: 'billing',
          description: 'Invoicing and payment collection for booked visits.',
          publicInterfaces: [
            {
              type: 'Custom',
              details: 'Streams invoice-settled events to downstream consumers over the clinic message bus.',
              component: 'invoice-drafting-orchestrator',
            },
          ],
        },
      ],
      components: [INVOICE_ORCH],
    },
  }),
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_EVENT_MISTYPED',
    expectFire: false,
    reason: 'The event-flavored Custom entry is backed by an Observer, which CAN realize eventing (documented event-capable backing).',
    scenario:
      'The billing subsystem\'s Custom entry promising invoice-settled events is backed by the invoice event observer.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          id: 'billing',
          description: 'Invoicing and payment collection for booked visits.',
          publicInterfaces: [
            {
              type: 'Custom',
              details: 'Streams invoice-settled events to downstream consumers over the clinic message bus.',
              component: 'invoice-event-observer',
            },
          ],
        },
      ],
      components: [
        { id: 'invoice-event-observer', componentType: 'Observer', subsystem: 'billing', description: 'Subscribes to and republishes invoice events on the clinic bus.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_EVENT_MISTYPED',
    expectFire: false,
    reason: 'The prose describes a synchronous contract with no event/async vocabulary, so nothing contradicts the orchestrator backing.',
    scenario:
      'The billing subsystem\'s Custom entry describes synchronous invoice drafting calls and is backed by the invoice drafting orchestrator.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          id: 'billing',
          description: 'Invoicing and payment collection for booked visits.',
          publicInterfaces: [
            {
              type: 'Custom',
              details: 'Synchronous invoice drafting calls for internal back-office tools.',
              component: 'invoice-drafting-orchestrator',
            },
          ],
        },
      ],
      components: [INVOICE_ORCH],
    },
  }),
];
