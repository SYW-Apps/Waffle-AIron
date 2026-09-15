import { describe, it, expect } from 'vitest';
import { buildRuleContext } from '../../src/core/rules/index.js';
import { emptyExtensions } from '../../src/core/extensions.js';
import { SubsystemSpecSchema } from '../../src/models/specs.js';
import type { ValidationIssue } from '../../src/core/validation.js';

// ---------------------------------------------------------------------------
// An empty-string subsystem profile. The schema accepts it (profile is an open
// optional string), so it needs one meaning everywhere the rule context resolves
// a profile. That meaning is "no profile": the project type's profile governs,
// exactly as for a subsystem that omits the field — the rule configs, severity
// overrides and design depth all agree.
// ---------------------------------------------------------------------------

const stamp = { createdAt: '2026-09-15T10:00:00Z', updatedAt: '2026-09-15T10:00:00Z' };

const sub = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: id, description: 'd', parentSystem: 'Warehouse', publicInterfaces: [], trustedLinks: [], status: 'complete', ...stamp, ...extra }) as never;

const comp = (id: string, subsystem: string) =>
  ({ id, name: id, description: 'd', subsystem, componentType: 'Orchestrator', dependsOn: [], owns: [], status: 'complete', ...stamp }) as never;

function context(issues: ValidationIssue[]) {
  const ext = emptyExtensions();
  ext.profiles['backend'] = {
    family: 'neutral', forbiddenStereotypes: [], discouragedStereotypes: [],
    rules: {
      sddRuleSeverity: { GOD_COMPONENT: 'error' },
      designDepth: 'components',
      complexity: { maxComponentDependencies: 3 },
      documentation: { minDescriptionLength: 40 },
      naming: { components: 'kebab-case' },
    },
  } as never;
  return buildRuleContext({
    system: { schemaVersion: '1.0.0', name: 'Warehouse', vision: 'v', ...stamp } as never,
    subsystems: [sub('fulfilment', { profile: '' }), sub('returns')],
    components: [comp('pick-orchestrator', 'fulfilment'), comp('refund-orchestrator', 'returns')],
    interfaces: [],
    implementations: [],
    types: [],
    projectType: 'backend',
    extensions: ext,
    roundTripIssues: [],
    knownIssueCodes: new Set<string>(),
    issues,
  });
}

describe('an empty subsystem profile means no profile — the project type governs', () => {
  it('is accepted by the subsystem schema', () => {
    const parsed = SubsystemSpecSchema.parse({ id: 'fulfilment', name: 'Fulfilment', description: 'd', parentSystem: 'Warehouse', profile: '', ...stamp });
    expect(parsed.profile).toBe('');
  });

  it('resolves the same rule configs as a subsystem without a profile', () => {
    const ctx = context([]);
    expect(ctx.complexityConfigFor('fulfilment')).toEqual(ctx.complexityConfigFor('returns'));
    expect(ctx.complexityConfigFor('fulfilment')?.maxComponentDependencies).toBe(3);
    expect(ctx.documentationConfigFor('fulfilment')).toEqual(ctx.documentationConfigFor('returns'));
    expect(ctx.namingConfigFor('fulfilment')).toEqual(ctx.namingConfigFor('returns'));
  });

  it("applies the project type profile's severity overrides", () => {
    const issues: ValidationIssue[] = [];
    const ctx = context(issues);
    ctx.addIssue('warning', 'GOD_COMPONENT', 'fan-out', 'pick-orchestrator');
    ctx.addIssue('warning', 'GOD_COMPONENT', 'fan-out', 'refund-orchestrator');
    expect(issues.map(i => [i.specId, i.severity])).toEqual([
      ['pick-orchestrator', 'error'],
      ['refund-orchestrator', 'error'],
    ]);
  });

  it("gates by the project type profile's design depth", () => {
    const issues: ValidationIssue[] = [];
    const ctx = context(issues);
    ctx.addIssue('warning', 'MISSING_NARRATIVE', 'no narrative', 'pick-orchestrator');
    ctx.addIssue('warning', 'MISSING_NARRATIVE', 'no narrative', 'refund-orchestrator');
    expect(issues).toEqual([]);
  });
});
