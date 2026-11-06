/**
 * Practice selection references
 * (src/core/rules/extension/practice-references.ts).
 *
 * Documented intents pinned here:
 *  - UNKNOWN_PRACTICE (warning): every practice the project.yaml `practices`
 *    selection names, `!`-drops included, is declared by a loaded pack.
 *  - UNKNOWN_PRACTICE_SCOPE (warning): every subsystems / components / roles key
 *    names a subsystem, a component of this tree, or a built-in agent role.
 *
 * These run with the ledger-platform fixture pack loaded, which declares the
 * practice `double-entry-review`.
 */
import { defineRuleFixture, FIXTURE_PACK_DIR } from '../harness.js';

const ledgerTree = (practices: Record<string, unknown>) => ({
  subsystems: [{ id: 'ledger', description: 'Double-entry postings and balances.' }],
  components: [
    {
      id: 'posting-store',
      componentType: 'Store',
      subsystem: 'ledger',
      description: 'Holds the ledger postings, keyed by posting id.',
    },
  ],
  packs: [FIXTURE_PACK_DIR],
  practices,
});

export default [
  // -------------------------------------------------------------------------
  // UNKNOWN_PRACTICE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNKNOWN_PRACTICE',
    severity: 'warning',
    expectFire: true,
    scenario:
      'The ledger project selects a triple-entry-review practice for its ledger subsystem, which no loaded pack declares.',
    tree: ledgerTree({ subsystems: { ledger: ['triple-entry-review'] } }),
  }),
  defineRuleFixture({
    code: 'UNKNOWN_PRACTICE',
    expectFire: false,
    reason: 'The selected practice, and the one the component drops, are declared by the loaded ledger-platform pack.',
    scenario:
      'The ledger project works under double-entry-review, and the posting store drops it again.',
    tree: ledgerTree({ use: ['double-entry-review'], components: { 'posting-store': ['!double-entry-review'] } }),
  }),

  // -------------------------------------------------------------------------
  // UNKNOWN_PRACTICE_SCOPE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNKNOWN_PRACTICE_SCOPE',
    severity: 'warning',
    expectFire: true,
    scenario:
      'The ledger project selects double-entry-review for a "payouts" subsystem its tree does not have.',
    tree: ledgerTree({ subsystems: { payouts: ['double-entry-review'] } }),
  }),
  defineRuleFixture({
    code: 'UNKNOWN_PRACTICE_SCOPE',
    expectFire: false,
    reason: 'Every key names something real: the ledger subsystem, the posting store and the built-in reviewer role.',
    scenario:
      'The ledger project selects double-entry-review for its ledger subsystem, its posting store and its reviewers.',
    tree: ledgerTree({
      subsystems: { ledger: ['double-entry-review'] },
      components: { 'posting-store': ['double-entry-review'] },
      roles: { reviewer: ['double-entry-review'] },
    }),
  }),
];
