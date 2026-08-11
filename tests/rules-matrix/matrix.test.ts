/**
 * The rule-matrix runner: one it() per collected fixture, named
 * "[CODE] fires|quiet: <scenario>". Fixture families live in
 * tests/rules-matrix/families/*.fixtures.ts and are auto-collected — adding a
 * family file requires no edit here. See tests/rules-matrix/README.md.
 */
import { describe, it } from 'vitest';
import { collectRuleFixtures, type CollectedFixture } from './collect.js';
import { checkRuleFixture } from './harness.js';

const byFamily = new Map<string, CollectedFixture[]>();
for (const entry of collectRuleFixtures()) {
  const list = byFamily.get(entry.family);
  if (list) list.push(entry);
  else byFamily.set(entry.family, [entry]);
}

describe('rule matrix', () => {
  for (const [family, entries] of byFamily) {
    describe(family, () => {
      for (const { fixture } of entries) {
        it(`[${fixture.code}] ${fixture.expectFire ? 'fires' : 'quiet'}: ${fixture.scenario}`, () => {
          checkRuleFixture(fixture);
        });
      }
    });
  }
});
