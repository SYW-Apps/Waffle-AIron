/**
 * Deprecated pack fields — src/core/rules/extension/pack-deprecations.ts.
 *
 * Documented intent pinned here (rule description):
 *  - PACK_FIELD_DEPRECATED (notice): a loaded pack still declaring a field
 *    wairon has deprecated — today a language's foreignBuiltins, whose
 *    foreign-builtin check is retired because contracts are written in the
 *    neutral type grammar — is told so. The field is accepted and ignored for
 *    one release, so the pack still loads; a notice never fails the gate.
 *
 * The control is the same pack without the field: its language table still
 * gates narrative flow (unsupportedFlow), which is not deprecated.
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';

/** A plant-floor PLC pack whose language table is the subject. */
function plcTree(languageLines: string[]): FixtureTree {
  return {
    subsystems: [{ id: 'conveyor-control', description: 'Line conveyor control on the packing hall PLCs.' }],
    components: [{
      id: 'conveyor-speed-orchestrator',
      componentType: 'Orchestrator',
      subsystem: 'conveyor-control',
      description: 'Sets the conveyor belt speed from the packing rate.',
    }],
    packs: ['./packs/plant-floor-doctrine'],
    files: {
      'packs/plant-floor-doctrine/pack.yaml': [
        'name: plant-floor-doctrine',
        'version: 1.0.0',
        'languages:',
        '  structured-text:',
        '    unsupportedFlow:',
        '      try: Structured Text has no exceptions; return a status word instead.',
        ...languageLines,
        '',
      ].join('\n'),
    },
  };
}

export default [
  defineRuleFixture({
    code: 'PACK_FIELD_DEPRECATED',
    severity: 'notice',
    anchoredTo: null,
    expectFire: true,
    scenario:
      'The plant-floor doctrine pack still lists foreignBuiltins for Structured Text, a field whose foreign-builtin check is retired now that contracts use the neutral type grammar.',
    tree: plcTree(['    foreignBuiltins: [TIME, DINT]']),
  }),
  defineRuleFixture({
    code: 'PACK_FIELD_DEPRECATED',
    expectFire: false,
    reason: 'The pack declares only unsupportedFlow, which still governs narratives and is not deprecated.',
    scenario: 'The plant-floor doctrine pack gates exceptions for Structured Text narratives and declares nothing deprecated.',
    tree: plcTree([]),
  }),
];
