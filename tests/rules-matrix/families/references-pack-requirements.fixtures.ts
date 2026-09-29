/**
 * Rule family: pack requirements (rule pack-requirements, governance stage).
 *
 *  - POLICY_REQUIREMENT_INVALID (error): a requirement in the bound project's
 *    OWN composition.requirePolicies names no pack or a semver range that does
 *    not parse. It is judged on the requiring project's own gate, because the
 *    requirement is its own configuration and the family run cannot judge any
 *    member against it. Only the syntax is judged here — adoption is the
 *    family run's question — so a readable requirement nobody adopts is quiet.
 *
 * Requirements live in .wai/project.yaml, so these fixtures OVERWRITE the
 * harness-written project config through tree.files, mirroring every harness
 * field and adding only the `composition` block.
 */
import * as yaml from 'js-yaml';
import { defineRuleFixture } from '../harness.js';

const TS = '2026-01-01T00:00:00.000Z';

/** Replacement .wai/project.yaml: the harness boilerplate plus the requirements under test. */
function projectYaml(requirePolicies: Record<string, unknown>[]): string {
  return yaml.dump(
    {
      schemaVersion: '1.0.0',
      name: 'rule-matrix-fixture',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: {
        noOverlappingOwnership: true,
        requireOwnedPaths: true,
        metaAgentTags: ['meta', 'guardian', 'architect'],
        enforceReproducibility: true,
      },
      extensions: { packs: [], useGlobalPacks: false },
      composition: { requirePolicies },
      createdAt: TS,
      updatedAt: TS,
    },
    { noRefs: true, lineWidth: 200 },
  );
}

/** A small platform tree whose members the requirements govern. */
const platformSpecs = {
  subsystems: [{ id: 'ledger', description: 'The platform ledger every member project books against.' }],
  components: [
    {
      id: 'ledger-booking',
      componentType: 'Orchestrator',
      subsystem: 'ledger',
      description: 'Books settlement entries into the platform ledger.',
    },
  ],
};

export default [
  defineRuleFixture({
    code: 'POLICY_REQUIREMENT_INVALID',
    severity: 'error',
    expectFire: true,
    scenario:
      'The platform requires every member to select acme-baseline at range "latest", which is neither a version, an x-range nor a comparator, so no member could ever be judged against it.',
    tree: {
      ...platformSpecs,
      files: {
        '.wai/project.yaml': projectYaml([{ pack: 'acme-baseline', version: 'latest' }]),
      },
    },
  }),
  defineRuleFixture({
    code: 'POLICY_REQUIREMENT_INVALID',
    severity: 'error',
    expectFire: true,
    scenario:
      'The platform writes a requirement with a range but no pack name, so nothing says which pack members must select.',
    tree: {
      ...platformSpecs,
      files: {
        '.wai/project.yaml': projectYaml([{ pack: '', version: '^1.2' }]),
      },
    },
  }),
  defineRuleFixture({
    code: 'POLICY_REQUIREMENT_INVALID',
    expectFire: false,
    reason: 'Every requirement names a pack and a range that parses (a caret range, a comparator set and an alternative), so the family run can judge members against them; whether members adopt them is not this gate\'s question.',
    scenario:
      'The platform requires acme-baseline ^1.2 with its service profile and audit-trail ">=2.0.0 <3.0.0 || 3.1.x"; no member has adopted either yet.',
    tree: {
      ...platformSpecs,
      files: {
        '.wai/project.yaml': projectYaml([
          { pack: 'acme-baseline', version: '^1.2', profile: 'service' },
          { pack: 'audit-trail', version: '>=2.0.0 <3.0.0 || 3.1.x' },
        ]),
      },
    },
  }),
];
