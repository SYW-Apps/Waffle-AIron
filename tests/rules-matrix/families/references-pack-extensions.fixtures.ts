/**
 * Pack-declared reusable pattern references
 * (src/core/rules/pattern-references.ts).
 *
 * Documented intents pinned here:
 *  - UNKNOWN_PATTERN_REF (warning): a component's `patterns` entry must name a
 *    pattern id some loaded extension pack declares.
 *  - PATTERN_VERSION_MISMATCH (warning): a pinned pattern version must match a
 *    version the declaring pack provides.
 *
 * These run with the carrier-doctrine fixture pack loaded as a direct path
 * ref (tests/rules-matrix/references-pack-store/carrier-doctrine/2.0.0), which
 * declares pattern `rate-shopping-adapter` at version 2.0.0.
 */
import * as path from 'node:path';
import { defineRuleFixture } from '../harness.js';

const CARRIER_PACK_DIR = path.resolve(__dirname, '..', 'references-pack-store', 'carrier-doctrine', '2.0.0');

const quotingTree = (patternRefs: Record<string, unknown>[]) => ({
  subsystems: [{ id: 'carrier-quoting', description: 'Carrier rate shopping and quote normalization.' }],
  components: [
    {
      id: 'ups-rates-adapter',
      componentType: 'Adapter',
      subsystem: 'carrier-quoting',
      description: 'Wraps the UPS rating API behind the platform quote seam.',
      patterns: patternRefs,
    },
  ],
  packs: [CARRIER_PACK_DIR],
});

export default [
  // -------------------------------------------------------------------------
  // UNKNOWN_PATTERN_REF
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNKNOWN_PATTERN_REF',
    severity: 'warning',
    anchoredTo: 'ups-rates-adapter',
    expectFire: true,
    scenario:
      'The UPS rates adapter claims to realize a chilled-freight-lane pattern that no loaded extension pack declares.',
    tree: quotingTree([{ id: 'chilled-freight-lane' }]),
  }),
  defineRuleFixture({
    code: 'UNKNOWN_PATTERN_REF',
    expectFire: false,
    reason: 'The referenced pattern id is declared by the loaded carrier-doctrine pack.',
    scenario:
      'The UPS rates adapter realizes the rate-shopping-adapter pattern the loaded carrier-doctrine pack declares.',
    tree: quotingTree([{ id: 'rate-shopping-adapter' }]),
  }),

  // -------------------------------------------------------------------------
  // PATTERN_VERSION_MISMATCH
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PATTERN_VERSION_MISMATCH',
    severity: 'warning',
    anchoredTo: 'ups-rates-adapter',
    expectFire: true,
    scenario:
      'The UPS rates adapter pins the rate-shopping-adapter pattern at 9.1.0, but the loaded carrier-doctrine pack only provides version 2.0.0.',
    tree: quotingTree([{ id: 'rate-shopping-adapter', version: '9.1.0' }]),
  }),
  defineRuleFixture({
    code: 'PATTERN_VERSION_MISMATCH',
    expectFire: false,
    reason: 'The pinned version matches the version the declaring pack provides.',
    scenario:
      'The UPS rates adapter pins the rate-shopping-adapter pattern at the 2.0.0 version the carrier-doctrine pack provides.',
    tree: quotingTree([{ id: 'rate-shopping-adapter', version: '2.0.0' }]),
  }),
];
