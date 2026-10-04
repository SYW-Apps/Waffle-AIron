/**
 * The rename trace — src/core/rules/integrity/rename-traces.ts.
 *
 * Documented intent pinned here (rule description):
 *  - RENAME_TRACE_CONFLICT (warning): a rename trace entry (a spec's
 *    previousIds, a contract method's previousNames) equals a live key of the
 *    same kind, or one former key is claimed by two elements of the same kind.
 *    The rename tools refuse both, so a finding means a hand edit.
 *
 * Each control is the same tree with the trace naming a key nothing holds.
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';

const LEDGER_SUB = { id: 'general-ledger', description: 'Double-entry bookkeeping for the finance back office.' };

/** A journal Orchestrator renamed from `posting-engine`, beside a live component whose id the trace may collide with. */
function journalTree(trace: string[], liveId = 'period-closer'): FixtureTree {
  return {
    subsystems: [LEDGER_SUB],
    components: [
      { id: 'journal-writer', description: 'Writes balanced journal entries for each business event.', previousIds: trace },
      { id: liveId, description: 'Closes an accounting period once every entry in it balances.' },
    ],
  };
}

/** A contract whose `recordEntry` method was renamed from the name in its trace, beside a live `closePeriod`. */
function contractTree(trace: string[]): FixtureTree {
  return {
    subsystems: [LEDGER_SUB],
    components: [{ id: 'journal-writer', description: 'Writes balanced journal entries for each business event.' }],
    interfaces: [{
      id: 'ijournal_writer',
      methods: [
        { name: 'recordEntry', description: 'Record one balanced journal entry.', previousNames: trace },
        { name: 'closePeriod', description: 'Close the current accounting period.' },
      ],
    }],
  };
}

export default [
  defineRuleFixture({
    code: 'RENAME_TRACE_CONFLICT',
    severity: 'warning',
    anchoredTo: 'journal-writer',
    expectFire: true,
    scenario: 'The journal writer lists `period-closer` as a former id by hand, while the period closer still holds that id.',
    tree: journalTree(['period-closer']),
  }),
  defineRuleFixture({
    code: 'RENAME_TRACE_CONFLICT',
    expectFire: false,
    reason: 'A trace naming an id no live component holds is exactly what a rename leaves behind.',
    scenario: 'The journal writer was renamed from the posting engine, and nothing holds that id any more.',
    tree: journalTree(['posting-engine']),
  }),
  defineRuleFixture({
    code: 'RENAME_TRACE_CONFLICT',
    severity: 'warning',
    anchoredTo: 'ijournal_writer',
    expectFire: true,
    scenario: 'The record-entry method lists `ijournal_writer.closePeriod` as a former name, but the contract still declares closePeriod.',
    tree: contractTree(['ijournal_writer.closePeriod']),
  }),
  defineRuleFixture({
    code: 'RENAME_TRACE_CONFLICT',
    expectFire: false,
    reason: 'A former method key no live method holds is a rename, nothing else.',
    scenario: 'The record-entry method was renamed from postEntry, which the contract no longer declares.',
    tree: contractTree(['ijournal_writer.postEntry']),
  }),
  defineRuleFixture({
    code: 'RENAME_TRACE_CONFLICT',
    severity: 'warning',
    expectFire: true,
    scenario: 'Two components both claim to have been renamed from the posting engine, so a consumer holding that key cannot tell which it became.',
    tree: {
      subsystems: [LEDGER_SUB],
      components: [
        { id: 'journal-writer', description: 'Writes balanced journal entries for each business event.', previousIds: ['posting-engine'] },
        { id: 'period-closer', description: 'Closes an accounting period once every entry in it balances.', previousIds: ['posting-engine'] },
      ],
    },
  }),
];
