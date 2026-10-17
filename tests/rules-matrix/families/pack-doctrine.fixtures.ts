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
      'Under ledger-platform doctrine, the settlement orchestrator depends directly on the Stripe payout adapter instead of going through the payout vendor supervisor.',
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
      'The orchestrator reaches the vendor through the payout vendor supervisor, which holds the vendor connections — exactly the shape the pack doctrine mandates.',
    scenario:
      'Under ledger-platform doctrine, the settlement orchestrator reaches Stripe through the payout vendor supervisor, which supervises the vendor adapter with failover and sandboxing.',
    tree: {
      system: { name: 'LedgerOS', vision: 'Double-entry settlement platform moving merchant payouts through audited ledgers.' },
      subsystems: [{ id: 'payments', description: 'Merchant payout settlement and vendor hand-off.' }],
      components: [
        {
          id: 'settlement-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'payments',
          description: 'Batches cleared balances into payout runs and drives their settlement.',
          dependsOn: ['payout-vendor-supervisor'],
        },
        {
          id: 'payout-vendor-supervisor',
          componentType: 'Supervisor',
          subsystem: 'payments',
          description: 'Holds the payment-vendor connections, failing over between vendors and sandboxing each one.',
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

  // -------------------------------------------------------------------------
  // UNKNOWN_GUARANTEE (builtin rule, pack-extended vocabulary)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNKNOWN_GUARANTEE',
    severity: 'warning',
    anchoredTo: 'ijournal_balance_arbiter',
    expectFire: true,
    scenario:
      'The journal balance arbiter contract promises a ledger-reconciled guarantee that neither wairon builtins nor the loaded ledger-platform pack declare, so no narrative can ever match it.',
    tree: {
      system: { name: 'LedgerOS', vision: 'Double-entry settlement platform moving merchant payouts through audited ledgers.' },
      subsystems: [{ id: 'payments', description: 'Merchant payout settlement and vendor hand-off.' }],
      components: [
        {
          id: 'journal-balance-arbiter',
          componentType: 'Orchestrator',
          dependencyClass: 'pure',
          subsystem: 'payments',
          description: 'Decides whether a journal entry balances before any settlement run posts it.',
        },
      ],
      interfaces: [
        {
          id: 'ijournal_balance_arbiter',
          component: 'journal-balance-arbiter',
          methods: [
            {
              name: 'checkJournalEntry',
              description: 'Check that one journal entry balances before it reaches the settlement ledger.',
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
      'The journal balance arbiter contract promises the ledger-balanced guarantee that the loaded ledger-platform pack declares in its guarantee vocabulary.',
    tree: {
      system: { name: 'LedgerOS', vision: 'Double-entry settlement platform moving merchant payouts through audited ledgers.' },
      subsystems: [{ id: 'payments', description: 'Merchant payout settlement and vendor hand-off.' }],
      components: [
        {
          id: 'journal-balance-arbiter',
          componentType: 'Orchestrator',
          dependencyClass: 'pure',
          subsystem: 'payments',
          description: 'Decides whether a journal entry balances before any settlement run posts it.',
        },
      ],
      interfaces: [
        {
          id: 'ijournal_balance_arbiter',
          component: 'journal-balance-arbiter',
          methods: [
            {
              name: 'checkJournalEntry',
              description: 'Check that one journal entry balances before it reaches the settlement ledger.',
              guarantees: ['ledger-balanced'],
            },
          ],
        },
      ],
      packs: [FIXTURE_PACK_DIR],
    },
  }),
];
