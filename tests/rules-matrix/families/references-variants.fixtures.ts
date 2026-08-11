/**
 * Component-variant references (src/core/rules/variant-references.ts, over the
 * registry loaded from .wai/variants/ by src/core/variants.ts).
 *
 * Documented intents pinned here:
 *  - UNKNOWN_VARIANT (warning): a component's `variant` must resolve to a
 *    declared registry variant.
 *  - VARIANT_BASE_MISMATCH (error): the component's stereotype must equal the
 *    variant's declared base — a variant is always "a kind of <base
 *    stereotype>", never a cross-cutting attribute.
 */
import * as yaml from 'js-yaml';
import { defineRuleFixture } from '../harness.js';

/** The project-local variant registry file (.wai/variants/*.yaml). */
const FLAG_VARIANTS_YAML = yaml.dump(
  [
    {
      id: 'external-config-adapter',
      base: 'Adapter',
      guidance:
        'Wrap the vendor remote-configuration API behind one read-through interface, validate payload schemas at the edge, and expose typed accessors only.',
    },
  ],
  { noRefs: true, lineWidth: 200 },
);

const flagsTree = (componentType: string, variant: string, withRegistry: boolean) => ({
  subsystems: [{ id: 'feature-flags', description: 'Feature flag evaluation and vendor sync.' }],
  components: [
    {
      id: 'launchpad-flags-adapter',
      componentType,
      subsystem: 'feature-flags',
      description: 'Syncs flag definitions from the LaunchPad vendor into the local evaluator.',
      variant,
    },
  ],
  ...(withRegistry ? { files: { '.wai/variants/flag-variants.yaml': FLAG_VARIANTS_YAML } } : {}),
});

export default [
  // -------------------------------------------------------------------------
  // UNKNOWN_VARIANT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNKNOWN_VARIANT',
    severity: 'warning',
    anchoredTo: 'launchpad-flags-adapter',
    expectFire: true,
    scenario:
      'The LaunchPad flags adapter declares a regional-cache-adapter variant that neither the project nor the global variant registry defines.',
    tree: flagsTree('Adapter', 'regional-cache-adapter', true),
  }),
  defineRuleFixture({
    code: 'UNKNOWN_VARIANT',
    expectFire: false,
    reason: 'The declared variant exists in the project variant registry under .wai/variants/.',
    scenario:
      'The LaunchPad flags adapter declares the external-config-adapter variant the project variant registry defines.',
    tree: flagsTree('Adapter', 'external-config-adapter', true),
  }),

  // -------------------------------------------------------------------------
  // VARIANT_BASE_MISMATCH
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'VARIANT_BASE_MISMATCH',
    severity: 'error',
    anchoredTo: 'launchpad-flags-adapter',
    expectFire: true,
    scenario:
      'A Specialist component wears the external-config-adapter variant even though that variant specializes the Adapter base stereotype.',
    tree: flagsTree('Specialist', 'external-config-adapter', true),
  }),
  defineRuleFixture({
    code: 'VARIANT_BASE_MISMATCH',
    expectFire: false,
    reason: 'The component\'s stereotype equals the variant\'s declared base (Adapter), the only legal pairing.',
    scenario:
      'An Adapter component wears the external-config-adapter variant whose declared base is Adapter.',
    tree: flagsTree('Adapter', 'external-config-adapter', true),
  }),
];
