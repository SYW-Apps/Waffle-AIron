import { describe, it, expect } from 'vitest';
import supervision from '../rules-matrix/families/boundaries-supervision.fixtures.js';
import crossSubsystem from '../rules-matrix/families/boundaries-cross-subsystem.fixtures.js';
import { defineRuleFixture, runRuleFixture, type FixtureTree, type RuleFixture } from '../rules-matrix/harness.js';

// ---------------------------------------------------------------------------
// Declared `calls` are a statement, exactly as narrative call steps are: every
// rule that judges what a method calls reads both. Each rule's own firing
// fixture is rewritten so its calls are DECLARED instead of narrated, and the
// same finding must fire, pointing at "a declared call".
// ---------------------------------------------------------------------------

/** The tree with every narrative call step of every method moved into the method's declared calls. */
function declared(tree: FixtureTree): FixtureTree {
  const copy = JSON.parse(JSON.stringify(tree)) as FixtureTree;
  for (const impl of copy.implementations ?? []) {
    for (const method of (impl.methods ?? []) as Array<{ narrative?: Array<Record<string, unknown>>; calls?: string[] }>) {
      const steps = method.narrative ?? [];
      const calls = steps.filter((s) => s.type === 'call' && s.targetComponent && s.targetMethod).map((s) => `${s.targetComponent}.${s.targetMethod}`);
      if (calls.length === 0) continue;
      method.calls = calls;
      method.narrative = [];
    }
  }
  return copy;
}

const firing = (family: RuleFixture[], code: string): RuleFixture => {
  const found = family.find((f) => f.code === code && f.expectFire);
  if (!found) throw new Error(`no firing fixture for ${code}`);
  return found;
};

describe('declared calls are judged like narrative call steps', () => {
  for (const [code, family] of [
    ['PORTAL_WRITE_SHORTCUT', crossSubsystem],
    ['SUPERVISOR_WRITE_SHORTCUT', supervision],
    ['LIFECYCLE_CALLS_WRITE', supervision],
  ] as const) {
    it(`${code} fires on the same call made through a declared call`, () => {
      const original = firing(family as RuleFixture[], code);
      const { matching } = runRuleFixture(defineRuleFixture({
        code,
        expectFire: false,
        reason: 'Read directly by the assertions below.',
        scenario: `${original.scenario} The method declares its calls rather than narrating them.`,
        tree: declared(original.tree),
      }));
      expect(matching.length).toBeGreaterThan(0);
      expect(matching[0].message).toContain('a declared call');
    });
  }
});
