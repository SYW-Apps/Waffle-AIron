import { describe, it, expect } from 'vitest';
import { ComplexityRuleConfigSchema } from '../../src/models/project.js';

// ---------------------------------------------------------------------------
// complexity_rule_config — the three D2 fields alongside the existing soft
// caps: narrativeStepsHardMax (an error-level ceiling on step count),
// cognitiveWarnAbove and maxCognitiveLevel (the band thresholds the
// narrative-complexity rule warns/errors against). Their defaults belong to
// the rule that reads them, not this schema — all three stay unset unless
// authored.
// ---------------------------------------------------------------------------

describe('complexity_rule_config.narrativeStepsHardMax', () => {
  it('accepts a non-negative integer', () => {
    expect(ComplexityRuleConfigSchema.parse({ narrativeStepsHardMax: 40 }).narrativeStepsHardMax).toBe(40);
    expect(ComplexityRuleConfigSchema.parse({ narrativeStepsHardMax: 0 }).narrativeStepsHardMax).toBe(0);
  });

  it('refuses a negative value or a non-integer', () => {
    expect(ComplexityRuleConfigSchema.safeParse({ narrativeStepsHardMax: -1 }).success).toBe(false);
    expect(ComplexityRuleConfigSchema.safeParse({ narrativeStepsHardMax: 1.5 }).success).toBe(false);
  });

  it('is unset when not authored', () => {
    expect(ComplexityRuleConfigSchema.parse({}).narrativeStepsHardMax).toBeUndefined();
  });
});

describe('complexity_rule_config.cognitiveWarnAbove / maxCognitiveLevel', () => {
  it('accepts a cognitive band string for each', () => {
    const parsed = ComplexityRuleConfigSchema.parse({ cognitiveWarnAbove: 'moderate', maxCognitiveLevel: 'severe' });
    expect(parsed.cognitiveWarnAbove).toBe('moderate');
    expect(parsed.maxCognitiveLevel).toBe('severe');
  });

  it('is unset when not authored', () => {
    const parsed = ComplexityRuleConfigSchema.parse({});
    expect(parsed.cognitiveWarnAbove).toBeUndefined();
    expect(parsed.maxCognitiveLevel).toBeUndefined();
  });
});
