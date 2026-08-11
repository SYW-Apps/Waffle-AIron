/**
 * Prose-claim family (src/core/rules/semantic-edges.ts, proseClaimRule):
 * durability/side-effect claims that exist only in prose. A local step or an
 * intent paragraph claiming persistence ("persisted", "survives restart",
 * "registered into") on a LOGIC component whose narrative has no
 * call/dispatch edge to any data-layer component (Store/Registry/Index/
 * Adapter/Repository) is UNREALIZED_CLAIM. Data-layer components are exempt —
 * they ARE the persistence.
 */
import { defineRuleFixture } from '../harness.js';

export default [
  // -------------------------------------------------------------------------
  // Step-prose claim
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREALIZED_CLAIM',
    severity: 'warning',
    anchoredTo: 'billing_orchestrator_impl',
    expectFire: true,
    scenario:
      'A local step of the billing orchestrator claims the closed invoice snapshot is persisted to disk, but no call or dispatch edge in the narrative reaches any data-layer component.',
    tree: {
      subsystems: [{ id: 'billing', description: 'Invoice lifecycle and archival.' }],
      components: [
        {
          id: 'billing-orchestrator',
          componentType: 'Orchestrator',
          description: 'Drives invoice closing and archival.',
        },
      ],
      interfaces: [
        {
          id: 'ibilling_orchestrator',
          component: 'billing-orchestrator',
          methods: [{ name: 'closeInvoice', description: 'Close an open invoice and archive its final snapshot.' }],
        },
      ],
      implementations: [
        {
          id: 'billing_orchestrator_impl',
          contract: 'ibilling_orchestrator',
          methods: [
            {
              name: 'closeInvoice',
              narrative: [
                { stepNumber: 1, type: 'local', description: 'Compute the final total from the invoice line items.' },
                { stepNumber: 2, type: 'local', description: 'Persist the closed invoice snapshot to disk for the audit trail.' },
                { stepNumber: 3, type: 'return', description: 'Report the invoice closed.', outcome: 'success' },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNREALIZED_CLAIM',
    expectFire: false,
    reason:
      'The narrative carries a real call edge to the invoice-archive Store, so the persistence claim is realized structurally (call steps carry their own edge).',
    scenario:
      'The billing orchestrator persists the closed invoice snapshot through an explicit call to the invoice-archive Store.',
    tree: {
      subsystems: [{ id: 'billing', description: 'Invoice lifecycle and archival.' }],
      components: [
        {
          id: 'billing-orchestrator',
          componentType: 'Orchestrator',
          description: 'Drives invoice closing and archival.',
          dependsOn: ['invoice-archive-store'],
        },
        {
          id: 'invoice-archive-store',
          componentType: 'Store',
          description: 'Archive of closed invoice snapshots.',
          durability: 'read-through',
        },
      ],
      interfaces: [
        {
          id: 'ibilling_orchestrator',
          component: 'billing-orchestrator',
          methods: [{ name: 'closeInvoice', description: 'Close an open invoice and archive its final snapshot.' }],
        },
        {
          id: 'iinvoice_archive_store',
          component: 'invoice-archive-store',
          methods: [{ name: 'saveSnapshot', description: 'Persist one closed invoice snapshot to the archive.', effect: 'write' }],
        },
      ],
      implementations: [
        {
          id: 'billing_orchestrator_impl',
          contract: 'ibilling_orchestrator',
          methods: [
            {
              name: 'closeInvoice',
              narrative: [
                { stepNumber: 1, type: 'local', description: 'Compute the final total from the invoice line items.' },
                {
                  stepNumber: 2,
                  type: 'call',
                  description: 'Persist the closed invoice snapshot to the archive for the audit trail.',
                  targetComponent: 'invoice-archive-store',
                  targetMethod: 'saveSnapshot',
                },
                { stepNumber: 3, type: 'return', description: 'Report the invoice closed.', outcome: 'success' },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // Intent-prose claim
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREALIZED_CLAIM',
    severity: 'warning',
    anchoredTo: 'receipt_formatter_impl',
    expectFire: true,
    scenario:
      'The receipt formatter\'s intent claims an archival copy is persisted for audit retention, but the specialist neither depends on nor owns any data-layer component.',
    tree: {
      subsystems: [{ id: 'receipts', description: 'Printable receipt rendering and archival.' }],
      components: [
        {
          id: 'receipt-formatter',
          componentType: 'Specialist',
          description: 'Renders printable receipts from order data.',
        },
      ],
      interfaces: [
        {
          id: 'ireceipt_formatter',
          component: 'receipt-formatter',
          methods: [{ name: 'formatReceipt', description: 'Render the printable receipt for a completed order.' }],
        },
      ],
      implementations: [
        {
          id: 'receipt_formatter_impl',
          contract: 'ireceipt_formatter',
          methods: [
            {
              name: 'formatReceipt',
              intent:
                'Renders the printable receipt and persists an archival copy for the seven-year audit retention window.',
              narrative: [
                { stepNumber: 1, type: 'local', description: 'Lay out the receipt lines, taxes, and totals.' },
                { stepNumber: 2, type: 'return', description: 'Hand back the rendered receipt document.', outcome: 'success' },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNREALIZED_CLAIM',
    expectFire: false,
    reason:
      'The formatter declares the receipt-archive Store as a dependency, so the intent\'s persistence claim has a structural realization.',
    scenario:
      'The receipt formatter depends on the receipt-archive Store, grounding its intent claim of an archived copy.',
    tree: {
      subsystems: [{ id: 'receipts', description: 'Printable receipt rendering and archival.' }],
      components: [
        {
          id: 'receipt-formatter',
          componentType: 'Specialist',
          description: 'Renders printable receipts from order data.',
          dependsOn: ['receipt-archive-store'],
        },
        {
          id: 'receipt-archive-store',
          componentType: 'Store',
          description: 'Archive of rendered receipts for audit retention.',
          durability: 'read-through',
        },
      ],
      interfaces: [
        {
          id: 'ireceipt_formatter',
          component: 'receipt-formatter',
          methods: [{ name: 'formatReceipt', description: 'Render the printable receipt for a completed order.' }],
        },
        {
          id: 'ireceipt_archive_store',
          component: 'receipt-archive-store',
          methods: [{ name: 'savePdf', description: 'Persist one rendered receipt to the archive.', effect: 'write' }],
        },
      ],
      implementations: [
        {
          id: 'receipt_formatter_impl',
          contract: 'ireceipt_formatter',
          methods: [
            {
              name: 'formatReceipt',
              intent:
                'Renders the printable receipt and persists an archival copy for the seven-year audit retention window.',
              narrative: [
                { stepNumber: 1, type: 'local', description: 'Lay out the receipt lines, taxes, and totals.' },
                { stepNumber: 2, type: 'return', description: 'Hand back the rendered receipt document.', outcome: 'success' },
              ],
            },
          ],
        },
      ],
    },
  }),
];
