import { describe, it, expect } from 'vitest';
import { buildRuleContext, type BuildContextOptions } from '../../src/core/rules/index.js';
import { RulesConfigSchema } from '../../src/models/project.js';
import type { ValidationIssue } from '../../src/core/validation.js';
import { narrativeComplexityRule } from '../../src/core/rules/heuristic/narrative-complexity.js';

// ---------------------------------------------------------------------------
// narrative-complexity: the two narrative axes. The cognitive band comes from
// SHAPE (branching, nesting, jumps) and the step count from LENGTH, so a long
// flat list and a short nested guard are judged separately. Each axis warns on
// its own dial — the step axis with a default of 25, the band axis above
// moderate — and errors only where a maximum is deliberately configured.
// ---------------------------------------------------------------------------

const stamp = { createdAt: '2026-09-17T10:00:00Z', updatedAt: '2026-09-17T10:00:00Z' };

const sub = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: id, description: `The ${id} subsystem.`, parentSystem: 'Freightline', publicInterfaces: [], trustedLinks: [], status: 'complete', ...stamp, ...extra }) as never;

const comp = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: id, description: `The ${id} component.`, subsystem: 'dispatch', componentType: 'Orchestrator', dependsOn: [], owns: [], status: 'complete', ...stamp, ...extra }) as never;

const intf = (id: string, component: string, methodNames: string[]) =>
  ({
    id, name: id, description: `The ${id} contract.`, component,
    methods: methodNames.map(name => ({ name, description: `${name} does its one job.`, signature: `${name}(): void`, returns: 'void' })),
    status: 'complete', ...stamp,
  }) as never;

const impl = (id: string, contract: string, methods: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  ({ id, name: id, description: `The ${id} realization.`, contract, methods: methods.map(m => ({ narrative: [], ...m })), status: 'complete', ...stamp, ...extra }) as never;

/** A flat narrative of `flat` local steps followed by `branches` un-nested branch steps (cognitive score = branches). */
const narrative = (flat: number, branches = 0) => [
  ...Array.from({ length: flat }, (_, i) => ({ stepNumber: i + 1, description: `Local step ${i + 1} of the flow.`, type: 'local' })),
  ...Array.from({ length: branches }, (_, i) => ({
    stepNumber: flat + i + 1,
    description: `Guard ${i + 1}: is the shipment still routable?`,
    type: 'branch',
    condition: 'shipment.isRoutable()',
    onTrueStep: flat + i + 2,
    onFalseStep: flat + i + 2,
  })),
];

/** One dispatch orchestrator realizing one method, whose narrative and complexity dial the caller chooses. */
function run(
  steps: Record<string, unknown>[],
  complexity: Record<string, unknown> = {},
  compExtra: Record<string, unknown> = {},
  implExtra: Record<string, unknown> = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const opts: BuildContextOptions = {
    system: { schemaVersion: '1.0.0', name: 'Freightline', vision: 'v', ...stamp } as never,
    subsystems: [sub('dispatch')],
    components: [comp('shipment-orchestrator', compExtra)],
    interfaces: [intf('ishipment_orchestrator', 'shipment-orchestrator', ['routeShipment'])],
    implementations: [impl('shipment_orchestrator_impl', 'ishipment_orchestrator', [{ name: 'routeShipment', narrative: steps }], implExtra)],
    types: [],
    projectType: 'backend',
    roundTripIssues: [],
    knownIssueCodes: new Set<string>(),
    issues,
    rules: RulesConfigSchema.parse({ complexity }),
  } as BuildContextOptions;
  narrativeComplexityRule.check(buildRuleContext(opts));
  return issues;
}

const codes = (issues: ValidationIssue[]): string[] => issues.map(i => i.code);

describe('narrative-complexity — the cognitive axis', () => {
  it('warns above the default "moderate" band and stays quiet at it', () => {
    // 10 branches = score 10 = complex; 5 = moderate, the band that may be reached.
    expect(codes(run(narrative(0, 10)))).toContain('NARRATIVE_COMPLEXITY');
    expect(codes(run(narrative(0, 5)))).not.toContain('NARRATIVE_COMPLEXITY');
  });

  it('names the band, the score and the dial, and anchors on the implementation', () => {
    const issue = run(narrative(0, 10)).find(i => i.code === 'NARRATIVE_COMPLEXITY');
    expect(issue?.severity).toBe('warning');
    expect(issue?.specId).toBe('shipment_orchestrator_impl');
    expect(issue?.message).toContain('complex narrative (cognitive score 10)');
    expect(issue?.message).toContain('"moderate"');
  });

  it('follows cognitiveWarnAbove when the project moves the dial', () => {
    expect(codes(run(narrative(0, 5), { cognitiveWarnAbove: 'simple' }))).toContain('NARRATIVE_COMPLEXITY');
    expect(codes(run(narrative(0, 10), { cognitiveWarnAbove: 'complex' }))).not.toContain('NARRATIVE_COMPLEXITY');
  });

  it('errors over maxCognitiveLevel, and only where one is configured', () => {
    const over = run(narrative(0, 20), { maxCognitiveLevel: 'complex' }).find(i => i.code === 'NARRATIVE_COMPLEXITY_OVER_MAX');
    expect(over?.severity).toBe('error');
    expect(over?.message).toContain('maximum band "complex"');
    expect(codes(run(narrative(0, 20)))).not.toContain('NARRATIVE_COMPLEXITY_OVER_MAX');
    expect(codes(run(narrative(0, 10), { maxCognitiveLevel: 'complex' }))).not.toContain('NARRATIVE_COMPLEXITY_OVER_MAX');
  });
});

describe('narrative-complexity — the step axis', () => {
  it('warns above 25 steps with nothing configured — the default is the rule\'s own', () => {
    expect(codes(run(narrative(26)))).toContain('EXCESSIVE_NARRATIVE_STEPS');
    expect(codes(run(narrative(25)))).not.toContain('EXCESSIVE_NARRATIVE_STEPS');
  });

  it('a configured maxNarrativeSteps replaces the default in both directions', () => {
    expect(codes(run(narrative(3), { maxNarrativeSteps: 2 }))).toContain('EXCESSIVE_NARRATIVE_STEPS');
    expect(codes(run(narrative(30), { maxNarrativeSteps: 40 }))).not.toContain('EXCESSIVE_NARRATIVE_STEPS');
  });

  it('errors over narrativeStepsHardMax, and only where one is configured', () => {
    const over = run(narrative(30), { narrativeStepsHardMax: 28 }).find(i => i.code === 'NARRATIVE_STEPS_OVER_MAX');
    expect(over?.severity).toBe('error');
    expect(over?.specId).toBe('shipment_orchestrator_impl');
    expect(over?.message).toContain('hard maximum of 28');
    expect(codes(run(narrative(30)))).not.toContain('NARRATIVE_STEPS_OVER_MAX');
    expect(codes(run(narrative(28), { narrativeStepsHardMax: 28 }))).not.toContain('NARRATIVE_STEPS_OVER_MAX');
  });

  it('a long flat list is long, not complex — the two axes are independent', () => {
    expect(codes(run(narrative(30)))).toEqual(['EXCESSIVE_NARRATIVE_STEPS']);
    expect(codes(run(narrative(0, 10)))).toEqual(['NARRATIVE_COMPLEXITY']);
  });
});

describe('narrative-complexity — context', () => {
  it('takes its draft context from the realized component', () => {
    expect(run(narrative(0, 10), {}, { status: 'draft' }).find(i => i.code === 'NARRATIVE_COMPLEXITY')?.draftContext).toBe(true);
    expect(run(narrative(0, 10)).find(i => i.code === 'NARRATIVE_COMPLEXITY')?.draftContext).toBeFalsy();
  });

  it('also downgrades from a draft IMPLEMENTATION alone, even under a complete component', () => {
    expect(run(narrative(0, 10), {}, {}, { status: 'draft' }).find(i => i.code === 'NARRATIVE_COMPLEXITY')?.draftContext).toBe(true);
  });

  it('says nothing about a method with no narrative at all', () => {
    expect(codes(run([]))).toEqual([]);
  });
});
