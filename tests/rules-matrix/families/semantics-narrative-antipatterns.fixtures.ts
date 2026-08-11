/**
 * Narrative-antipattern family (src/core/rules/narrative-antipatterns.ts):
 * provable narrative bugs, restricted to what structure alone proves.
 *
 * Documented intents pinned here:
 *  - INESCAPABLE_CYCLE (warning): a step cycle with no exit edge and no
 *    return/throw member never terminates, by construction.
 *  - MEANINGLESS_BRANCH (warning): a branch/switch whose arms all land on the
 *    same step decides nothing.
 *  - UNCONDITIONAL_CALL_CYCLE (warning): a cross-component call cycle in which
 *    every call edge is unavoidable on all entry-to-exit paths — unbounded
 *    recursion; a cycle with even one guarded edge is NOT flagged.
 */
import { defineRuleFixture } from '../harness.js';

/** Shared miniature system: one outbox-relay actor whose narrative varies per fixture. */
function outboxTree(narrative: object[]) {
  return {
    subsystems: [{ id: 'message-relay', description: 'Transactional outbox relay onto the message bus.' }],
    components: [
      {
        id: 'outbox-relay',
        componentType: 'Actor',
        description: 'Drains the transactional outbox onto the message bus.',
      },
    ],
    interfaces: [
      {
        id: 'ioutbox_relay',
        component: 'outbox-relay',
        methods: [{ name: 'drainOutbox', description: 'Deliver every unsent outbox message to the bus.' }],
      },
    ],
    implementations: [
      {
        id: 'outbox_relay_impl',
        contract: 'ioutbox_relay',
        methods: [{ name: 'drainOutbox', narrative }],
      },
    ],
  };
}

export default [
  // -------------------------------------------------------------------------
  // INESCAPABLE_CYCLE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INESCAPABLE_CYCLE',
    severity: 'warning',
    anchoredTo: 'outbox_relay_impl',
    expectFire: true,
    scenario:
      'The outbox relay polls, delivers, and jumps straight back to polling with no exit branch and no terminator — once entered the flow never completes, by construction.',
    tree: outboxTree([
      { stepNumber: 1, type: 'local', description: 'Poll the outbox for unsent messages.' },
      { stepNumber: 2, type: 'local', description: 'Deliver each unsent message to the bus.' },
      { stepNumber: 3, type: 'jump', description: 'Go back to polling for more messages.', toStep: 1 },
    ]),
  }),
  defineRuleFixture({
    code: 'INESCAPABLE_CYCLE',
    expectFire: false,
    reason: 'The drained-outbox branch is an exit edge out of the cycle, so the flow can complete.',
    scenario:
      'The outbox relay loops between polling and delivering but exits to a return once the outbox is drained.',
    tree: outboxTree([
      { stepNumber: 1, type: 'local', description: 'Poll the outbox for unsent messages.' },
      { stepNumber: 2, type: 'local', description: 'Deliver each unsent message to the bus.' },
      { stepNumber: 3, type: 'branch', description: 'Stop once the outbox is drained.', condition: 'the outbox is drained', onTrueStep: 4, onFalseStep: 1 },
      { stepNumber: 4, type: 'return', description: 'Report the outbox drained.', outcome: 'success' },
    ]),
  }),

  // -------------------------------------------------------------------------
  // MEANINGLESS_BRANCH — branch and switch variants
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MEANINGLESS_BRANCH',
    severity: 'warning',
    anchoredTo: 'outbox_relay_impl',
    expectFire: true,
    scenario:
      'The priority branch sends both its arms to the same delivery step, so the priority check decides nothing.',
    tree: outboxTree([
      { stepNumber: 1, type: 'local', description: 'Read the next unsent message from the outbox.' },
      { stepNumber: 2, type: 'branch', description: 'Check whether the message is marked priority.', condition: 'the message is marked priority', onTrueStep: 3, onFalseStep: 3 },
      { stepNumber: 3, type: 'local', description: 'Deliver the message to the bus.' },
      { stepNumber: 4, type: 'return', description: 'Report the message delivered.', outcome: 'success' },
    ]),
  }),
  defineRuleFixture({
    code: 'MEANINGLESS_BRANCH',
    severity: 'warning',
    anchoredTo: 'outbox_relay_impl',
    expectFire: true,
    scenario:
      'The channel switch routes every case and the default to the same delivery step, so the channel dispatch decides nothing.',
    tree: outboxTree([
      { stepNumber: 1, type: 'local', description: 'Parse the delivery channel of the message.' },
      {
        stepNumber: 2,
        type: 'switch',
        description: 'Dispatch on the delivery channel of the message.',
        on: 'the delivery channel',
        cases: [
          { value: 'bus', step: 3 },
          { value: 'webhook', step: 3 },
        ],
        defaultStep: 3,
      },
      { stepNumber: 3, type: 'local', description: 'Deliver the message over the resolved channel.' },
      { stepNumber: 4, type: 'return', description: 'Report the message delivered.', outcome: 'success' },
    ]),
  }),
  defineRuleFixture({
    code: 'MEANINGLESS_BRANCH',
    expectFire: false,
    reason: 'The two arms target different steps, so the condition genuinely selects a path.',
    scenario:
      'The priority branch fast-tracks priority messages to immediate delivery and batches the rest.',
    tree: outboxTree([
      { stepNumber: 1, type: 'local', description: 'Read the next unsent message from the outbox.' },
      { stepNumber: 2, type: 'branch', description: 'Fast-track messages marked priority.', condition: 'the message is marked priority', onTrueStep: 3, onFalseStep: 4 },
      { stepNumber: 3, type: 'local', description: 'Deliver the priority message immediately.' },
      { stepNumber: 4, type: 'local', description: 'Append the message to the next delivery batch.' },
      { stepNumber: 5, type: 'return', description: 'Report the message handled.', outcome: 'success' },
    ]),
  }),

  // -------------------------------------------------------------------------
  // UNCONDITIONAL_CALL_CYCLE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNCONDITIONAL_CALL_CYCLE',
    severity: 'warning',
    anchoredTo: 'balance_recalculator_impl',
    expectFire: true,
    scenario:
      'Posting a ledger entry always triggers a balance recalculation, and the recalculation always posts a correcting entry back — a cross-component call cycle with no guard and no base case.',
    tree: {
      subsystems: [{ id: 'ledger', description: 'Double-entry ledger posting and balance upkeep.' }],
      components: [
        {
          id: 'ledger-poster',
          componentType: 'Orchestrator',
          description: 'Posts entries into the ledger.',
          dependsOn: ['balance-recalculator'],
        },
        {
          id: 'balance-recalculator',
          componentType: 'Orchestrator',
          description: 'Recalculates running balances after postings.',
          dependsOn: ['ledger-poster'],
        },
      ],
      interfaces: [
        {
          id: 'iledger_poster',
          component: 'ledger-poster',
          methods: [{ name: 'postEntry', description: 'Post one entry into the ledger.' }],
        },
        {
          id: 'ibalance_recalculator',
          component: 'balance-recalculator',
          methods: [{ name: 'recalculate', description: 'Recalculate the running balance after a posting.' }],
        },
      ],
      implementations: [
        {
          id: 'ledger_poster_impl',
          contract: 'iledger_poster',
          methods: [
            {
              name: 'postEntry',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Recalculate the running balance after the posting.',
                  targetComponent: 'balance-recalculator',
                  targetMethod: 'recalculate',
                },
              ],
            },
          ],
        },
        {
          id: 'balance_recalculator_impl',
          contract: 'ibalance_recalculator',
          methods: [
            {
              name: 'recalculate',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Post a correcting entry for the recalculated balance.',
                  targetComponent: 'ledger-poster',
                  targetMethod: 'postEntry',
                },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNCONDITIONAL_CALL_CYCLE',
    expectFire: false,
    reason:
      'The recalculator only posts a correcting entry when the drift exceeds tolerance — one guarded edge with a completing path breaks the provable recursion, and prose conditions are never judged.',
    scenario:
      'The balance recalculator returns early when the drift is below tolerance, guarding the back-edge of the posting cycle.',
    tree: {
      subsystems: [{ id: 'ledger', description: 'Double-entry ledger posting and balance upkeep.' }],
      components: [
        {
          id: 'ledger-poster',
          componentType: 'Orchestrator',
          description: 'Posts entries into the ledger.',
          dependsOn: ['balance-recalculator'],
        },
        {
          id: 'balance-recalculator',
          componentType: 'Orchestrator',
          description: 'Recalculates running balances after postings.',
          dependsOn: ['ledger-poster'],
        },
      ],
      interfaces: [
        {
          id: 'iledger_poster',
          component: 'ledger-poster',
          methods: [{ name: 'postEntry', description: 'Post one entry into the ledger.' }],
        },
        {
          id: 'ibalance_recalculator',
          component: 'balance-recalculator',
          methods: [{ name: 'recalculate', description: 'Recalculate the running balance after a posting.' }],
        },
      ],
      implementations: [
        {
          id: 'ledger_poster_impl',
          contract: 'iledger_poster',
          methods: [
            {
              name: 'postEntry',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Recalculate the running balance after the posting.',
                  targetComponent: 'balance-recalculator',
                  targetMethod: 'recalculate',
                },
              ],
            },
          ],
        },
        {
          id: 'balance_recalculator_impl',
          contract: 'ibalance_recalculator',
          methods: [
            {
              name: 'recalculate',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'branch',
                  description: 'Stop when the recalculated drift is below tolerance.',
                  condition: 'the drift is below tolerance',
                  onTrueStep: 2,
                  onFalseStep: 3,
                },
                { stepNumber: 2, type: 'return', description: 'Report the balance converged.', outcome: 'converged' },
                {
                  stepNumber: 3,
                  type: 'call',
                  description: 'Post a correcting entry for the recalculated balance.',
                  targetComponent: 'ledger-poster',
                  targetMethod: 'postEntry',
                },
              ],
            },
          ],
        },
      ],
    },
  }),
];
