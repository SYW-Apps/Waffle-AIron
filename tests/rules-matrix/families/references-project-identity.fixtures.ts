/**
 * The project's own identity (src/core/rules/integrity/project-identity.ts):
 * a project is keyed on its id, so the id must be declared, well-formed and
 * the one its lock approved.
 *
 * Documented intents pinned here:
 *  - PROJECT_ID_DEFAULTED (notice): a project that declares no `id` answers to
 *    one derived from its display name — renaming it would move the id.
 *  - PROJECT_ID_AMBIGUOUS (warning): the name yields no id, or the declared id
 *    breaks the grammar (lower-case letters, digits, "-", "_", ".", starting
 *    and ending with a letter or a digit).
 *  - PROJECT_ID_CHANGED (error): the effective id differs from the projectId
 *    the lock recorded. A lock written before project ids existed records none
 *    and approves nothing to compare against.
 *
 * The identity lives in .wai/project.yaml, which is configuration, not a spec,
 * so every finding here names no spec (anchoredTo: null). Each fixture
 * overrides the harness's project.yaml through `files` (written after it).
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';

const TS = '2026-01-01T00:00:00.000Z';

/** A project.yaml for the billing platform, with the identity fields a scenario sets. */
function projectYaml(identity: { id?: string; name: string }): string {
  return [
    'schemaVersion: 1.0.0',
    ...(identity.id !== undefined ? [`id: '${identity.id}'`] : []),
    `name: '${identity.name}'`,
    'targets: []',
    'extensions:',
    '  packs: []',
    '  useGlobalPacks: false',
    `createdAt: '${TS}'`,
    `updatedAt: '${TS}'`,
    '',
  ].join('\n');
}

/** A lock record that approved the tree under `projectId` (none: a lock from before project ids). */
function lockJson(projectId?: string): string {
  return JSON.stringify({
    stateId: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    lockedAt: TS,
    lockedBy: { id: 'finance-architect', source: 'git' },
    validatorVersion: '0.0.0-test',
    validationResult: { valid: true, errors: 0, warnings: 0, notices: 0 },
    status: 'ready',
    ...(projectId !== undefined ? { projectId } : {}),
  }, null, 2);
}

/**
 * The billing platform: one invoicing subsystem, the project identity as the
 * scenario sets it, and — when given — the lock it was approved under
 * (`{}` is a lock written before project ids existed).
 */
function billingPlatform(identity: { id?: string; name: string }, lock?: { projectId?: string }): FixtureTree {
  return {
    subsystems: [{ id: 'invoicing', description: 'Issues invoices and tracks what customers owe.' }],
    files: {
      '.wai/project.yaml': projectYaml(identity),
      ...(lock ? { '.wai/lock.json': lockJson(lock.projectId) } : {}),
    },
  };
}

export default [
  // -------------------------------------------------------------------------
  // PROJECT_ID_DEFAULTED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PROJECT_ID_DEFAULTED',
    severity: 'notice',
    anchoredTo: null,
    expectFire: true,
    scenario: 'The billing platform was initialized before project ids existed: project.yaml names it "Billing Platform" and declares no id, so it answers to "billing-platform" only for as long as nobody renames it.',
    tree: billingPlatform({ name: 'Billing Platform' }),
  }),
  defineRuleFixture({
    code: 'PROJECT_ID_DEFAULTED',
    expectFire: false,
    reason: 'The id is declared, so renaming the display name can never move it.',
    scenario: 'The billing platform declares `id: billing-platform` beside its display name "Billing Platform".',
    tree: billingPlatform({ id: 'billing-platform', name: 'Billing Platform' }),
  }),

  // -------------------------------------------------------------------------
  // PROJECT_ID_AMBIGUOUS
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PROJECT_ID_AMBIGUOUS',
    severity: 'warning',
    anchoredTo: null,
    expectFire: true,
    scenario: 'The billing platform declares `id: Billing_Platform` — upper-case letters the project-id grammar does not allow, so nothing can key on it reliably.',
    tree: billingPlatform({ id: 'Billing_Platform', name: 'Billing Platform' }),
  }),
  defineRuleFixture({
    code: 'PROJECT_ID_AMBIGUOUS',
    severity: 'warning',
    anchoredTo: null,
    expectFire: true,
    scenario: 'The billing platform is named only in Japanese ("請求") and declares no id, so no id can be derived from its name and none is invented.',
    tree: billingPlatform({ name: '請求' }),
  }),
  defineRuleFixture({
    code: 'PROJECT_ID_AMBIGUOUS',
    expectFire: false,
    reason: 'A declared id in the grammar is exactly what the project keys on.',
    scenario: 'The billing platform declares the well-formed `id: billing.platform-eu_1`.',
    tree: billingPlatform({ id: 'billing.platform-eu_1', name: 'Billing Platform' }),
  }),

  // -------------------------------------------------------------------------
  // PROJECT_ID_CHANGED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PROJECT_ID_CHANGED',
    severity: 'error',
    anchoredTo: null,
    expectFire: true,
    scenario: 'The billing platform was locked as "billing-platform", and someone later edited project.yaml to `id: billing-core` without the rename migration.',
    tree: billingPlatform({ id: 'billing-core', name: 'Billing Platform' }, { projectId: 'billing-platform' }),
  }),
  defineRuleFixture({
    code: 'PROJECT_ID_CHANGED',
    severity: 'error',
    anchoredTo: null,
    expectFire: true,
    scenario: 'The billing platform was locked under its defaulted id "billing-platform", then renamed to "Invoicing Hub" before anyone declared the id, so the defaulted id moved with the name.',
    tree: billingPlatform({ name: 'Invoicing Hub' }, { projectId: 'billing-platform' }),
  }),
  defineRuleFixture({
    code: 'PROJECT_ID_CHANGED',
    expectFire: false,
    reason: 'The id project.yaml declares is the one the lock approved.',
    scenario: 'The billing platform declares `id: billing-platform`, and its lock approved "billing-platform".',
    tree: billingPlatform({ id: 'billing-platform', name: 'Billing Platform' }, { projectId: 'billing-platform' }),
  }),
  defineRuleFixture({
    code: 'PROJECT_ID_CHANGED',
    expectFire: false,
    reason: 'A lock written before project ids existed records none, so it approved no id to compare against.',
    scenario: 'The billing platform declares `id: billing-core`, and its lock predates project ids.',
    tree: billingPlatform({ id: 'billing-core', name: 'Billing Platform' }, {}),
  }),
];
