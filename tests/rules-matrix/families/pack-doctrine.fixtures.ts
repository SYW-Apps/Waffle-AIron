/**
 * Pack-composition fixtures: rule enforcement must compose with DECLARATIVE
 * extension packs. These run with the ledger-platform test pack
 * (tests/rules-matrix/fixture-pack/) loaded through the real project-extension
 * loader, and pin:
 *  - the pack's forbid-edge assertion, surfaced under its NAMESPACED code
 *    LEDGER_PLATFORM_DIRECT_VENDOR_CALL (fire + control),
 *  - UNKNOWN_GUARANTEE around the pack-declared token: a declared token is
 *    accepted (control), an undeclared one still fires WITH the pack loaded.
 */
import { defineRuleFixture, FIXTURE_PACK_DIR } from '../harness.js';

export default [
  // -------------------------------------------------------------------------
  // LEDGER_PLATFORM_DIRECT_VENDOR_CALL (pack forbid-edge, namespaced)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'LEDGER_PLATFORM_DIRECT_VENDOR_CALL',
    severity: 'error',
    anchoredTo: 'settlement-orchestrator',
    expectFire: true,
    scenario:
      'Under ledger-platform doctrine, the settlement orchestrator depends directly on the Stripe payout adapter instead of going through the payout gateway.',
    tree: {
      system: { name: 'LedgerOS', vision: 'Double-entry settlement platform moving merchant payouts through audited ledgers.' },
      subsystems: [{ id: 'payments', description: 'Merchant payout settlement and vendor hand-off.' }],
      components: [
        {
          id: 'settlement-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'payments',
          description: 'Batches cleared balances into payout runs and drives their settlement.',
          dependsOn: ['stripe-payout-adapter'],
        },
        {
          id: 'stripe-payout-adapter',
          componentType: 'Adapter',
          subsystem: 'payments',
          description: 'Wraps the Stripe payout API behind the platform payout interface.',
        },
      ],
      packs: [FIXTURE_PACK_DIR],
    },
  }),
  defineRuleFixture({
    code: 'LEDGER_PLATFORM_DIRECT_VENDOR_CALL',
    expectFire: false,
    reason:
      'The orchestrator reaches the vendor through the payout Gateway facade that privately owns the adapter — exactly the shape the pack doctrine mandates.',
    scenario:
      'Under ledger-platform doctrine, the settlement orchestrator reaches Stripe through the payout gateway, which privately owns the vendor adapter.',
    tree: {
      system: { name: 'LedgerOS', vision: 'Double-entry settlement platform moving merchant payouts through audited ledgers.' },
      subsystems: [{ id: 'payments', description: 'Merchant payout settlement and vendor hand-off.' }],
      components: [
        {
          id: 'settlement-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'payments',
          description: 'Batches cleared balances into payout runs and drives their settlement.',
          dependsOn: ['payout-gateway'],
        },
        {
          id: 'payout-gateway',
          componentType: 'Gateway',
          subsystem: 'payments',
          description: 'Vendor-neutral payout facade owning the concrete payment-vendor adapters.',
          owns: ['stripe-payout-adapter'],
        },
        {
          id: 'stripe-payout-adapter',
          componentType: 'Adapter',
          subsystem: 'payments',
          description: 'Wraps the Stripe payout API behind the platform payout interface.',
        },
      ],
      packs: [FIXTURE_PACK_DIR],
    },
  }),

  // -------------------------------------------------------------------------
  // UNKNOWN_GUARANTEE (builtin rule, pack-extended vocabulary)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNKNOWN_GUARANTEE',
    severity: 'warning',
    anchoredTo: 'ijournal_poster',
    expectFire: true,
    scenario:
      'The journal poster contract promises a ledger-reconciled guarantee that neither wairon builtins nor the loaded ledger-platform pack declare, so no narrative can ever match it.',
    tree: {
      system: { name: 'LedgerOS', vision: 'Double-entry settlement platform moving merchant payouts through audited ledgers.' },
      subsystems: [{ id: 'payments', description: 'Merchant payout settlement and vendor hand-off.' }],
      components: [
        {
          id: 'journal-poster',
          componentType: 'Specialist',
          subsystem: 'payments',
          description: 'Validates and posts balanced journal entries for every settlement run.',
        },
      ],
      interfaces: [
        {
          id: 'ijournal_poster',
          component: 'journal-poster',
          methods: [
            {
              name: 'postJournalEntry',
              description: 'Post one balanced journal entry to the settlement ledger.',
              guarantees: ['ledger-reconciled'],
            },
          ],
        },
      ],
      packs: [FIXTURE_PACK_DIR],
    },
  }),
  defineRuleFixture({
    code: 'UNKNOWN_GUARANTEE',
    expectFire: false,
    reason:
      'ledger-balanced is declared in the loaded ledger-platform pack\'s guarantees list, so the token is part of the recognized vocabulary.',
    scenario:
      'The journal poster contract promises the ledger-balanced guarantee that the loaded ledger-platform pack declares in its guarantee vocabulary.',
    tree: {
      system: { name: 'LedgerOS', vision: 'Double-entry settlement platform moving merchant payouts through audited ledgers.' },
      subsystems: [{ id: 'payments', description: 'Merchant payout settlement and vendor hand-off.' }],
      components: [
        {
          id: 'journal-poster',
          componentType: 'Specialist',
          subsystem: 'payments',
          description: 'Validates and posts balanced journal entries for every settlement run.',
        },
      ],
      interfaces: [
        {
          id: 'ijournal_poster',
          component: 'journal-poster',
          methods: [
            {
              name: 'postJournalEntry',
              description: 'Post one balanced journal entry to the settlement ledger.',
              guarantees: ['ledger-balanced'],
            },
          ],
        },
      ],
      packs: [FIXTURE_PACK_DIR],
    },
  }),
];
