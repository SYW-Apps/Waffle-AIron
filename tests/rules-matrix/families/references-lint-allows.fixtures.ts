/**
 * The lint-allow audit (src/core/rules/lint-allows.ts) — wairon's
 * #[allow(...)], which must name real issue codes and actually suppress a
 * finding.
 *
 * Documented intents pinned here (the rule's two failure modes):
 *  - UNKNOWN_LINT_ALLOW_CODE (warning): a lint.allow naming a code no
 *    registered rule can emit (typo / removed rule).
 *  - UNUSED_LINT_ALLOW (warning): an allow that matched nothing this run —
 *    stale suppressions rot into invisible risk exactly like commented-out
 *    tests. The control shows a USED allow (it suppresses a live
 *    warning-severity finding) staying quiet.
 */
import { defineRuleFixture } from '../harness.js';

export default [
  // -------------------------------------------------------------------------
  // UNKNOWN_LINT_ALLOW_CODE — the unknown-code path
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNKNOWN_LINT_ALLOW_CODE',
    severity: 'warning',
    anchoredTo: 'notification-fanout-hub',
    expectFire: true,
    scenario:
      'The notification fan-out hub allows the misspelled code EXCESS_DEPENDENCIES, which no registered rule can ever emit.',
    tree: {
      subsystems: [{ id: 'notifications', description: 'Customer notification fan-out across channels.' }],
      components: [
        {
          id: 'notification-fanout-hub',
          componentType: 'Orchestrator',
          subsystem: 'notifications',
          description: 'Fans one customer event out to every subscribed channel sender.',
          // The defect: the allowed code is a typo of EXCESSIVE_DEPENDENCIES.
          lint: { allow: [{ code: 'EXCESS_DEPENDENCIES', reason: 'Fan-out hub — a wide dependency list is the point.' }] },
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNKNOWN_LINT_ALLOW_CODE',
    expectFire: false,
    reason: 'The allow names EXCESSIVE_DEPENDENCIES, a code the registered complexity rule really emits.',
    scenario:
      'The notification fan-out hub allows the correctly spelled EXCESSIVE_DEPENDENCIES code for its deliberate wide fan-out.',
    tree: {
      subsystems: [{ id: 'notifications', description: 'Customer notification fan-out across channels.' }],
      components: [
        {
          id: 'notification-fanout-hub',
          componentType: 'Orchestrator',
          subsystem: 'notifications',
          description: 'Fans one customer event out to every subscribed channel sender.',
          lint: { allow: [{ code: 'EXCESSIVE_DEPENDENCIES', reason: 'Fan-out hub — a wide dependency list is the point.' }] },
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNUSED_LINT_ALLOW — the stale-allow path
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNUSED_LINT_ALLOW',
    severity: 'warning',
    anchoredTo: 'shipment-manifest',
    expectFire: true,
    scenario:
      'The shipment manifest entity still allows HOLLOW_TYPE from its placeholder days, but the type has long since gained fields so the allow matches nothing.',
    tree: {
      subsystems: [{ id: 'manifesting', description: 'Shipment manifest assembly for outbound loads.' }],
      types: [
        {
          id: 'shipment-manifest',
          kind: 'entity',
          subsystem: 'manifesting',
          fields: [
            { name: 'manifestId', type: 'string', description: 'Stable manifest identifier.' },
            { name: 'sealNumber', type: 'string', description: 'Trailer seal applied at close-out.' },
          ],
          // The defect: a stale allow — HOLLOW_TYPE cannot fire on a type with fields.
          lint: { allow: [{ code: 'HOLLOW_TYPE', reason: 'Placeholder during the manifest domain carve-out.' }] },
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNUSED_LINT_ALLOW',
    expectFire: false,
    reason: 'The allow is USED this run: it suppresses the live HOLLOW_TYPE warning on the still-empty placeholder, so it is not stale.',
    scenario:
      'The shipment manifest entity is still an acknowledged placeholder whose HOLLOW_TYPE warning the allow actively suppresses.',
    tree: {
      subsystems: [{ id: 'manifesting', description: 'Shipment manifest assembly for outbound loads.' }],
      types: [
        {
          id: 'shipment-manifest',
          kind: 'entity',
          subsystem: 'manifesting',
          // Still hollow on purpose — the allow matches the live finding.
          lint: { allow: [{ code: 'HOLLOW_TYPE', reason: 'Placeholder during the manifest domain carve-out.' }] },
        },
      ],
    },
  }),
];
