/**
 * Public-surface fixtures — the family's three rules under
 * src/core/rules/integrity/: public-surface-binding.ts (UNBOUND,
 * INVALID_COMPONENT, FOREIGN_COMPONENT), public-surface-bound-contract.ts
 * (INVALID_INTERFACE), and public-surface-consumers.ts (UNKNOWN_CONSUMER).
 * The retired public-surface-declared-type rule (TYPE_MISMATCH,
 * EVENT_MISTYPED) is gone with the reachability model: an entry's export kind
 * is derived from its backing Portal's transport, never authored.
 *
 * Documented intents pinned here:
 *  - PUBLIC_INTERFACE_UNBOUND (error): every declared publicInterface names a
 *    backing component.
 *  - PUBLIC_INTERFACE_INVALID_COMPONENT (error): the backing component must
 *    exist.
 *  - PUBLIC_INTERFACE_FOREIGN_COMPONENT (error): a subsystem may only publish
 *    its own components.
 *  - PUBLIC_INTERFACE_INVALID_INTERFACE (error, two documented behaviors):
 *    the bound L3 interface must exist and must belong to the bound
 *    component.
 *  - PUBLIC_INTERFACE_UNKNOWN_CONSUMER (error): every subsystem a published
 *    surface names as its consumer must exist in the tree.
 */
import { defineRuleFixture } from '../harness.js';

const SYSTEM = {
  name: 'MediBook',
  vision: 'Clinic appointment booking platform covering scheduling, billing, and partner integrations.',
};

const INVOICE_PORTAL = {
  id: 'invoice-api-portal',
  componentType: 'Portal',
  transport: 'HTTP',
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

const DOCUMENT_STORAGE_ADAPTER = {
  id: 'document-storage-adapter',
  componentType: 'Adapter',
  subsystem: 'billing',
  description: 'Generic file I/O over the billing documents on local disk.',
};

/** billing publishes the document storage adapter as shared, optionally only to some subsystems. */
const SHARED_STORAGE_SUB = (consumers?: string[]) => ({
  id: 'billing',
  description: 'Invoicing and payment collection for booked visits.',
  publicInterfaces: [
    { details: 'Document file I/O for every subsystem.', component: 'document-storage-adapter', shared: true, ...(consumers ? { consumers } : {}) },
  ],
});

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
          publicInterfaces: [{ details: 'Invoice REST API for partner systems.' }],
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
          publicInterfaces: [{ details: 'Invoice REST API for partner systems.', component: 'invoice-api-portal' }],
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
          publicInterfaces: [{ details: 'Invoice REST API for partner systems.', component: 'invoice-api-portal' }],
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
          publicInterfaces: [{ details: 'Invoice REST API for partner systems.', component: 'invoice-api-portal' }],
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
          publicInterfaces: [{ details: 'Visit schedule feed for invoicing.', component: 'schedule-portal' }],
        },
      ],
      components: [
        { id: 'schedule-portal', componentType: 'Portal', transport: 'Custom', subsystem: 'scheduling', description: 'Inbound scheduling surface.' },
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
          publicInterfaces: [{ details: 'Visit schedule feed for sibling subsystems.', component: 'schedule-portal' }],
        },
        {
          id: 'billing',
          description: 'Invoicing and payment collection for booked visits.',
          publicInterfaces: [{ details: 'Invoice REST API for partner systems.', component: 'invoice-api-portal' }],
        },
      ],
      components: [
        { id: 'schedule-portal', componentType: 'Portal', transport: 'Custom', subsystem: 'scheduling', description: 'Inbound scheduling surface.' },
        INVOICE_PORTAL,
      ],
      interfaces: [INVOICE_API_INTERFACE],
    },
  }),

  // -------------------------------------------------------------------------
  // PUBLIC_INTERFACE_NOT_PORTAL
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_NOT_PORTAL',
    severity: 'warning',
    anchoredTo: 'billing',
    expectFire: true,
    scenario:
      'The billing subsystem publishes its invoicing orchestrator, which no other subsystem can depend on: a hop across subsystems enters through a published Portal.',
    tree: {
      system: SYSTEM,
      subsystems: [{
        id: 'billing',
        description: 'Invoicing and payment collection for booked visits.',
        publicInterfaces: [{ details: 'Invoicing workflow.', component: 'invoice-orchestrator' }],
      }],
      components: [{ id: 'invoice-orchestrator', componentType: 'Orchestrator', subsystem: 'billing', description: 'Drives the invoicing workflow.' }],
    },
  }),
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_NOT_PORTAL',
    expectFire: false,
    reason: 'The published component is the subsystem\'s Portal, its front door.',
    scenario: 'The billing subsystem publishes its invoice API portal.',
    tree: {
      system: SYSTEM,
      subsystems: [{
        id: 'billing',
        description: 'Invoicing and payment collection for booked visits.',
        publicInterfaces: [{ details: 'Invoice REST API for partner systems.', component: 'invoice-api-portal' }],
      }],
      components: [INVOICE_PORTAL],
      interfaces: [INVOICE_API_INTERFACE],
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
            { details: 'Invoice REST API for partner systems.', component: 'invoice-api-portal', interface: 'iretired_invoice_api' },
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
            { details: 'Invoice REST API for partner systems.', component: 'invoice-api-portal', interface: 'ischedule_feed' },
          ],
        },
      ],
      components: [
        { id: 'schedule-portal', componentType: 'Portal', transport: 'Custom', subsystem: 'scheduling', description: 'Inbound scheduling surface.' },
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
            { details: 'Invoice REST API for partner systems.', component: 'invoice-api-portal', interface: 'iinvoice_api' },
          ],
        },
      ],
      components: [INVOICE_PORTAL],
      interfaces: [INVOICE_API_INTERFACE],
    },
  }),

  // -------------------------------------------------------------------------
  // PUBLIC_INTERFACE_UNKNOWN_CONSUMER
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_UNKNOWN_CONSUMER',
    severity: 'error',
    anchoredTo: 'billing',
    expectFire: true,
    scenario:
      'The billing subsystem publishes its invoice API portal to a "claim" subsystem — a typo for the claims subsystem, so the surface is locked against a caller nobody can be.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { id: 'claims', description: 'Insurance claim submission for billed visits.' },
        {
          id: 'billing',
          description: 'Invoicing and payment collection for booked visits.',
          publicInterfaces: [
            { details: 'Invoice REST API for the claims pipeline.', component: 'invoice-api-portal', consumers: ['claim'] },
          ],
        },
      ],
      components: [INVOICE_PORTAL],
      interfaces: [INVOICE_API_INTERFACE],
    },
  }),
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_UNKNOWN_CONSUMER',
    expectFire: false,
    reason: 'Every consumers id names a subsystem of the tree.',
    scenario:
      'The billing subsystem publishes its invoice API portal to the claims subsystem, which exists in the tree.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { id: 'claims', description: 'Insurance claim submission for billed visits.' },
        {
          id: 'billing',
          description: 'Invoicing and payment collection for booked visits.',
          publicInterfaces: [
            { details: 'Invoice REST API for the claims pipeline.', component: 'invoice-api-portal', consumers: ['claims'] },
          ],
        },
      ],
      components: [INVOICE_PORTAL],
      interfaces: [INVOICE_API_INTERFACE],
    },
  }),

  // -------------------------------------------------------------------------
  // PUBLIC_INTERFACE_NOT_PORTAL — the shared Adapter exemption
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_NOT_PORTAL',
    expectFire: false,
    reason: 'An Adapter the subsystem publishes as shared is called directly by every subsystem; public-surface-shared judges it instead of the Portal question.',
    scenario: 'The billing subsystem publishes its document storage adapter as shared generic file I/O.',
    tree: {
      system: SYSTEM,
      subsystems: [SHARED_STORAGE_SUB()],
      components: [DOCUMENT_STORAGE_ADAPTER],
    },
  }),

  // -------------------------------------------------------------------------
  // PUBLIC_INTERFACE_SHARED_NOT_ADAPTER
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_SHARED_NOT_ADAPTER',
    severity: 'error',
    anchoredTo: 'billing',
    expectFire: true,
    scenario:
      'The billing subsystem publishes its invoicing orchestrator as shared, though only generic I/O is safe to hand every subsystem.',
    tree: {
      system: SYSTEM,
      subsystems: [{
        id: 'billing',
        description: 'Invoicing and payment collection for booked visits.',
        publicInterfaces: [{ details: 'Invoicing workflow.', component: 'invoice-drafting-orchestrator', shared: true }],
      }],
      components: [INVOICE_ORCH],
    },
  }),
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_SHARED_NOT_ADAPTER',
    expectFire: false,
    reason: 'The shared entry publishes an Adapter, the generic I/O a shared surface is for.',
    scenario: 'The billing subsystem publishes its document storage adapter as shared.',
    tree: {
      system: SYSTEM,
      subsystems: [SHARED_STORAGE_SUB()],
      components: [DOCUMENT_STORAGE_ADAPTER],
    },
  }),

  // -------------------------------------------------------------------------
  // SHARED_ADAPTER_OWNED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'SHARED_ADAPTER_OWNED',
    severity: 'error',
    anchoredTo: 'billing',
    expectFire: true,
    scenario:
      'The billing subsystem publishes its document storage adapter as shared although the document repository owns it as a private member.',
    tree: {
      system: SYSTEM,
      subsystems: [SHARED_STORAGE_SUB()],
      components: [
        DOCUMENT_STORAGE_ADAPTER,
        { id: 'document-store', componentType: 'Store', subsystem: 'billing', description: 'Holds the stored billing documents.' },
        {
          id: 'document-repository',
          componentType: 'Repository',
          subsystem: 'billing',
          description: 'Facade over the billing document data blocks.',
          owns: ['document-store', 'document-storage-adapter'],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'SHARED_ADAPTER_OWNED',
    expectFire: false,
    reason: 'No pattern or Supervisor owns the Adapter, so it is no one\'s private member and may be every subsystem\'s.',
    scenario: 'The billing subsystem publishes a standalone document storage adapter as shared.',
    tree: {
      system: SYSTEM,
      subsystems: [SHARED_STORAGE_SUB()],
      components: [DOCUMENT_STORAGE_ADAPTER],
    },
  }),

  // -------------------------------------------------------------------------
  // SHARED_ADAPTER_DEPENDENCY
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'SHARED_ADAPTER_DEPENDENCY',
    severity: 'error',
    anchoredTo: 'billing',
    expectFire: true,
    scenario:
      'The billing subsystem\'s shared document storage adapter depends on the invoice drafting workflow, which a deployable would have to share with it.',
    tree: {
      system: SYSTEM,
      subsystems: [SHARED_STORAGE_SUB()],
      components: [
        { ...DOCUMENT_STORAGE_ADAPTER, dependsOn: ['invoice-drafting-orchestrator'] },
        INVOICE_ORCH,
      ],
    },
  }),
  defineRuleFixture({
    code: 'SHARED_ADAPTER_DEPENDENCY',
    expectFire: false,
    reason: 'A shared Adapter may depend on pure logic and on other shared Adapters: neither holds state.',
    scenario:
      'The billing subsystem\'s shared document storage adapter depends on a pure path-normalizing orchestrator and on a shared compression adapter.',
    tree: {
      system: SYSTEM,
      subsystems: [{
        id: 'billing',
        description: 'Invoicing and payment collection for booked visits.',
        publicInterfaces: [
          { details: 'Document file I/O for every subsystem.', component: 'document-storage-adapter', shared: true },
          { details: 'Archive compression for every subsystem.', component: 'archive-compression-adapter', shared: true },
        ],
      }],
      components: [
        { ...DOCUMENT_STORAGE_ADAPTER, dependsOn: ['path-normalizing-arbiter', 'archive-compression-adapter'] },
        { id: 'archive-compression-adapter', componentType: 'Adapter', subsystem: 'billing', description: 'Compresses and expands document archives on disk.' },
        { id: 'path-normalizing-arbiter', componentType: 'Orchestrator', dependencyClass: 'pure', subsystem: 'billing', description: 'Pure logic normalizing document paths from the values it is handed.' },
      ],
    },
  }),
];
