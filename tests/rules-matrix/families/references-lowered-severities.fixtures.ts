/**
 * Lowered-severities fixtures (src/core/rules/integrity/lowered-severities.ts).
 *
 * Documented intents pinned here: a rule code the project sets below its
 * default severity (rules.sddRuleSeverity) is never silent.
 *  - RULE_LOWERED (notice): the lowering is reported on every run with the
 *    project's reason from rules.severityReasons. A code set at or above its
 *    default is no lowering.
 *  - RULE_LOWERED_WITHOUT_REASON (warning): a lowering with no reason asks
 *    for the reason or for the default back.
 *  - STALE_SEVERITY_REASON (warning): a reason kept for a code the project
 *    does not set below its default.
 *
 * EXCESSIVE_DEPENDENCIES is a warning by default, so `notice` is a lowering and
 * `error` is not.
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';

/** A one-component notification hub, whatever its severity tuning says. */
function notificationHubTree(rules: FixtureTree['rules']): FixtureTree {
  return {
    subsystems: [{ id: 'notifications', description: 'Customer notification fan-out across channels.' }],
    components: [
      { id: 'notification-fanout-hub', componentType: 'Orchestrator', subsystem: 'notifications', description: 'Fans one customer event out to every subscribed channel sender.' },
    ],
    rules,
  };
}

export default [
  // RULE_LOWERED
  defineRuleFixture({
    code: 'RULE_LOWERED',
    severity: 'notice',
    anchoredTo: null,
    expectFire: true,
    scenario: 'The notification team lowers EXCESSIVE_DEPENDENCIES to a notice and states why its fan-out hub keeps a wide dependency list.',
    tree: notificationHubTree({
      sddRuleSeverity: { EXCESSIVE_DEPENDENCIES: 'notice' },
      severityReasons: { EXCESSIVE_DEPENDENCIES: 'The fan-out hub talks to every channel sender by design.' },
    }),
  }),
  defineRuleFixture({
    code: 'RULE_LOWERED',
    expectFire: false,
    reason: 'EXCESSIVE_DEPENDENCIES is raised to an error, above its warning default: a stricter project is no lowering.',
    scenario: 'The notification team raises EXCESSIVE_DEPENDENCIES to an error for its fan-out hub.',
    tree: notificationHubTree({ sddRuleSeverity: { EXCESSIVE_DEPENDENCIES: 'error' } }),
  }),

  // RULE_LOWERED_WITHOUT_REASON
  defineRuleFixture({
    code: 'RULE_LOWERED_WITHOUT_REASON',
    severity: 'warning',
    anchoredTo: null,
    expectFire: true,
    scenario: 'The notification team switches EXCESSIVE_DEPENDENCIES off and gives no reason anywhere.',
    tree: notificationHubTree({ sddRuleSeverity: { EXCESSIVE_DEPENDENCIES: 'off' } }),
  }),
  defineRuleFixture({
    code: 'RULE_LOWERED_WITHOUT_REASON',
    expectFire: false,
    reason: 'The lowering carries its reason in rules.severityReasons, so it is reported as RULE_LOWERED instead.',
    scenario: 'The notification team switches EXCESSIVE_DEPENDENCIES off and says why its fan-out hub needs that.',
    tree: notificationHubTree({
      sddRuleSeverity: { EXCESSIVE_DEPENDENCIES: 'off' },
      severityReasons: { EXCESSIVE_DEPENDENCIES: 'The fan-out hub talks to every channel sender by design.' },
    }),
  }),

  // STALE_SEVERITY_REASON
  defineRuleFixture({
    code: 'STALE_SEVERITY_REASON',
    severity: 'warning',
    anchoredTo: null,
    expectFire: true,
    scenario: 'The notification team put EXCESSIVE_DEPENDENCIES back to its default but left the reason for its old lowering behind.',
    tree: notificationHubTree({
      severityReasons: { EXCESSIVE_DEPENDENCIES: 'The fan-out hub talks to every channel sender by design.' },
    }),
  }),
  defineRuleFixture({
    code: 'STALE_SEVERITY_REASON',
    expectFire: false,
    reason: 'The reason belongs to a code the project really sets below its default.',
    scenario: 'The notification team keeps EXCESSIVE_DEPENDENCIES lowered to a notice, with its reason beside it.',
    tree: notificationHubTree({
      sddRuleSeverity: { EXCESSIVE_DEPENDENCIES: 'notice' },
      severityReasons: { EXCESSIVE_DEPENDENCIES: 'The fan-out hub talks to every channel sender by design.' },
    }),
  }),
];
