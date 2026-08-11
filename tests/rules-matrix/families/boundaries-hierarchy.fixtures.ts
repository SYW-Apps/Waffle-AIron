/**
 * Tree-integrity fixtures (src/core/rules/hierarchy.ts). ORPHANED_SUBSYSTEM
 * is deliberately NOT covered here — the exemplars family owns it.
 *
 * Documented intents pinned here:
 *  - DRAFT_SUBSYSTEM_WARNING / DRAFT_COMPONENT_WARNING (warning): draft/design
 *    specs are surfaced informationally.
 *  - INVALID_SUBSYSTEM_REFERENCE (error): every component references an
 *    existing subsystem.
 *  - INVALID_COMPONENT_REFERENCE (error): every interface references an
 *    existing component.
 *  - INVALID_INTERFACE_REFERENCE (error): every implementation references an
 *    existing interface contract.
 */
import { defineRuleFixture } from '../harness.js';

const SYSTEM = {
  name: 'MediBook',
  vision: 'Clinic appointment booking platform covering scheduling, patient records, and partner integrations.',
};

export default [
  // -------------------------------------------------------------------------
  // DRAFT_SUBSYSTEM_WARNING
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'DRAFT_SUBSYSTEM_WARNING',
    severity: 'warning',
    anchoredTo: 'claims-intake',
    expectFire: true,
    scenario:
      'The claims intake subsystem is still in draft status while the rest of the platform is complete.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'claims-intake', description: 'Insurance claim intake and triage.', status: 'draft' }],
    },
  }),
  defineRuleFixture({
    code: 'DRAFT_SUBSYSTEM_WARNING',
    expectFire: false,
    reason: 'The subsystem is complete; the informational draft warning only reports draft/design status.',
    scenario:
      'The claims intake subsystem has been designed to completion.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'claims-intake', description: 'Insurance claim intake and triage.', status: 'complete' }],
    },
  }),

  // -------------------------------------------------------------------------
  // DRAFT_COMPONENT_WARNING
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'DRAFT_COMPONENT_WARNING',
    severity: 'warning',
    anchoredTo: 'claims-triage-orchestrator',
    expectFire: true,
    scenario:
      'The claims triage orchestrator is still a draft component inside the otherwise complete claims subsystem.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'claims', description: 'Insurance claim intake and adjudication.' }],
      components: [
        { id: 'claims-triage-orchestrator', componentType: 'Orchestrator', description: 'Routes incoming claims to the right adjudication lane.', status: 'draft' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'DRAFT_COMPONENT_WARNING',
    expectFire: false,
    reason: 'The component is complete; the informational draft warning only reports draft/design status.',
    scenario:
      'The claims triage orchestrator has been designed to completion.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'claims', description: 'Insurance claim intake and adjudication.' }],
      components: [
        { id: 'claims-triage-orchestrator', componentType: 'Orchestrator', description: 'Routes incoming claims to the right adjudication lane.', status: 'complete' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // INVALID_SUBSYSTEM_REFERENCE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVALID_SUBSYSTEM_REFERENCE',
    severity: 'error',
    anchoredTo: 'archival-orchestrator',
    expectFire: true,
    scenario:
      'The archival orchestrator still references the retired-archiving subsystem that was dissolved into records.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'records', description: 'Patient record retention and archival.' }],
      components: [
        { id: 'archival-orchestrator', componentType: 'Orchestrator', subsystem: 'retired-archiving', description: 'Drives the yearly record archival run.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INVALID_SUBSYSTEM_REFERENCE',
    expectFire: false,
    reason: 'The component references the records subsystem, which exists.',
    scenario:
      'The archival orchestrator lives in the records subsystem it references.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'records', description: 'Patient record retention and archival.' }],
      components: [
        { id: 'archival-orchestrator', componentType: 'Orchestrator', subsystem: 'records', description: 'Drives the yearly record archival run.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // INVALID_COMPONENT_REFERENCE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVALID_COMPONENT_REFERENCE',
    severity: 'error',
    anchoredTo: 'ibilling_engine',
    expectFire: true,
    scenario:
      'The billing engine contract still points at the decommissioned billing engine component after the invoice orchestrator replaced it.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'billing', description: 'Invoicing and payment collection for booked visits.' }],
      components: [
        { id: 'invoice-orchestrator', componentType: 'Orchestrator', description: 'Drafts and posts invoices for completed visits.' },
      ],
      interfaces: [
        {
          id: 'ibilling_engine',
          component: 'decommissioned-billing-engine',
          methods: [{ name: 'draftInvoice', description: 'Draft an invoice for a completed visit.' }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INVALID_COMPONENT_REFERENCE',
    expectFire: false,
    reason: 'The interface references the invoice orchestrator, which exists.',
    scenario:
      'The billing engine contract belongs to the invoice orchestrator that exists in the billing subsystem.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'billing', description: 'Invoicing and payment collection for booked visits.' }],
      components: [
        { id: 'invoice-orchestrator', componentType: 'Orchestrator', description: 'Drafts and posts invoices for completed visits.' },
      ],
      interfaces: [
        {
          id: 'ibilling_engine',
          component: 'invoice-orchestrator',
          methods: [{ name: 'draftInvoice', description: 'Draft an invoice for a completed visit.' }],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // INVALID_INTERFACE_REFERENCE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVALID_INTERFACE_REFERENCE',
    severity: 'error',
    anchoredTo: 'invoice_engine_impl',
    expectFire: true,
    scenario:
      'The invoice engine implementation still claims the retired billing contract that was deleted in the API consolidation.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'billing', description: 'Invoicing and payment collection for booked visits.' }],
      components: [
        { id: 'invoice-orchestrator', componentType: 'Orchestrator', description: 'Drafts and posts invoices for completed visits.' },
      ],
      interfaces: [
        {
          id: 'iinvoice_engine',
          component: 'invoice-orchestrator',
          methods: [{ name: 'draftInvoice', description: 'Draft an invoice for a completed visit.' }],
        },
      ],
      implementations: [
        {
          id: 'invoice_engine_impl',
          contract: 'iretired_billing_contract',
          methods: [
            {
              name: 'draftInvoice',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Assemble the invoice line items from the visit record.' }],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INVALID_INTERFACE_REFERENCE',
    expectFire: false,
    reason: 'The implementation realizes the invoice engine contract, which exists.',
    scenario:
      'The invoice engine implementation realizes the invoice engine contract that exists in the billing subsystem.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'billing', description: 'Invoicing and payment collection for booked visits.' }],
      components: [
        { id: 'invoice-orchestrator', componentType: 'Orchestrator', description: 'Drafts and posts invoices for completed visits.' },
      ],
      interfaces: [
        {
          id: 'iinvoice_engine',
          component: 'invoice-orchestrator',
          methods: [{ name: 'draftInvoice', description: 'Draft an invoice for a completed visit.' }],
        },
      ],
      implementations: [
        {
          id: 'invoice_engine_impl',
          contract: 'iinvoice_engine',
          methods: [
            {
              name: 'draftInvoice',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Assemble the invoice line items from the visit record.' }],
            },
          ],
        },
      ],
    },
  }),
];
