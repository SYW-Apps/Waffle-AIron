import { describe, it, expect } from 'vitest';
import { buildRuleContext, type BuildContextOptions } from '../../src/core/rules/index.js';
import type { ValidationIssue } from '../../src/core/validation.js';
import { methodCohesionRule } from '../../src/core/rules/heuristic/method-cohesion.js';

// ---------------------------------------------------------------------------
// method-cohesion: an Orchestrator's methods drive the same collaborators. When
// they fall into groups that call nothing in common, the component holds two
// responsibilities. Deliberately conservative — a single specialized method
// beside a cohesive set is normal, so only groups of two or more count.
// ---------------------------------------------------------------------------

const stamp = { createdAt: '2026-09-17T10:00:00Z', updatedAt: '2026-09-17T10:00:00Z' };

const sub = (id: string) =>
  ({ id, name: id, description: `The ${id} subsystem.`, parentSystem: 'Freightline', publicInterfaces: [], trustedLinks: [], status: 'complete', ...stamp }) as never;

const comp = (id: string, componentType = 'Orchestrator', extra: Record<string, unknown> = {}) =>
  ({ id, name: id, description: `The ${id} component.`, subsystem: 'dispatch', componentType, dependsOn: [], owns: [], status: 'complete', ...stamp, ...extra }) as never;

const intf = (id: string, component: string, methodNames: string[]) =>
  ({
    id, name: id, description: `The ${id} contract.`, component,
    methods: methodNames.map(name => ({ name, description: `${name} does its one job.`, signature: `${name}(): void`, returns: 'void' })),
    status: 'complete', ...stamp,
  }) as never;

/** A method whose narrative calls each named collaborator once, in order. */
const calls = (name: string, targets: string[], type: 'call' | 'dispatch' | 'register' = 'call') => ({
  name,
  narrative: targets.map((targetComponent, i) => ({
    stepNumber: i + 1,
    description: `Reach ${targetComponent} for the ${name} flow.`,
    type,
    targetComponent,
    targetMethod: 'handle',
  })),
});

const impl = (id: string, contract: string, methods: Record<string, unknown>[]) =>
  ({ id, name: id, description: `The ${id} realization.`, contract, methods, status: 'complete', ...stamp }) as never;

/** One orchestrator under test, plus the collaborators its narratives reach. */
function run(methods: Record<string, unknown>[], componentType = 'Orchestrator'): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const collaborators = ['slot-index', 'booking-repository', 'invoice-repository', 'tax-rate-index', 'audit-observer'];
  const names = methods.map(m => m.name as string);
  methodCohesionRule.check(buildRuleContext({
    system: { schemaVersion: '1.0.0', name: 'Freightline', vision: 'v', ...stamp } as never,
    subsystems: [sub('dispatch')],
    components: [comp('dispatch-orchestrator', componentType), ...collaborators.map(c => comp(c, 'Store'))],
    interfaces: [intf('idispatch_orchestrator', 'dispatch-orchestrator', names)],
    implementations: [impl('dispatch_orchestrator_impl', 'idispatch_orchestrator', methods)],
    types: [],
    projectType: 'backend',
    roundTripIssues: [],
    knownIssueCodes: new Set<string>(),
    issues,
  } as BuildContextOptions));
  return issues.filter(i => i.code === 'INCOHESIVE_METHODS');
}

describe('method-cohesion — INCOHESIVE_METHODS', () => {
  const booking = [calls('reserveSlot', ['slot-index', 'booking-repository']), calls('releaseSlot', ['slot-index'])];
  const billing = [calls('issueInvoice', ['invoice-repository', 'tax-rate-index']), calls('voidInvoice', ['invoice-repository'])];

  it('fires on two groups of two that share no called component', () => {
    const issue = run([...booking, ...billing])[0];
    expect(issue?.severity).toBe('warning');
    expect(issue?.specId).toBe('dispatch-orchestrator');
    expect(issue?.message).toContain('reserveSlot, releaseSlot (calling booking-repository, slot-index)');
    expect(issue?.message).toContain('issueInvoice, voidInvoice (calling invoice-repository, tax-rate-index)');
    expect(issue?.message).toContain('lint.allow');
  });

  it('stays quiet once one shared collaborator joins the two halves', () => {
    expect(run([
      ...booking,
      calls('issueInvoice', ['invoice-repository', 'booking-repository']),
      calls('voidInvoice', ['invoice-repository']),
    ])).toEqual([]);
  });

  it('stays quiet when the second group holds only one method', () => {
    expect(run([...booking, calls('issueInvoice', ['invoice-repository'])])).toEqual([]);
  });

  it('judges only Orchestrators — a Repository facade groups by design', () => {
    expect(run([...booking, ...billing], 'Repository')).toEqual([]);
  });

  it('ignores register steps: a callback handoff is not driving a collaborator', () => {
    expect(run([
      ...booking,
      calls('onInvoiceIssued', ['invoice-repository'], 'register'),
      calls('onInvoiceVoided', ['tax-rate-index'], 'register'),
    ])).toEqual([]);
  });

  it('counts dispatch edges alongside call edges', () => {
    expect(run([
      calls('reserveSlot', ['slot-index'], 'dispatch'),
      calls('releaseSlot', ['slot-index'], 'dispatch'),
      ...billing,
    ])).toHaveLength(1);
  });

  it('says nothing when fewer than two methods reach anybody', () => {
    expect(run([calls('reserveSlot', ['slot-index']), { name: 'describe', narrative: [] }])).toEqual([]);
  });

  it('carries the component\'s draft context', () => {
    const issues: ValidationIssue[] = [];
    methodCohesionRule.check(buildRuleContext({
      system: { schemaVersion: '1.0.0', name: 'Freightline', vision: 'v', ...stamp } as never,
      subsystems: [sub('dispatch')],
      components: [
        comp('dispatch-orchestrator', 'Orchestrator', { status: 'draft' }),
        ...['slot-index', 'booking-repository', 'invoice-repository', 'tax-rate-index'].map(c => comp(c, 'Store')),
      ],
      interfaces: [intf('idispatch_orchestrator', 'dispatch-orchestrator', ['reserveSlot', 'releaseSlot', 'issueInvoice', 'voidInvoice'])],
      implementations: [impl('dispatch_orchestrator_impl', 'idispatch_orchestrator', [...booking, ...billing])],
      types: [],
      projectType: 'backend',
      roundTripIssues: [],
      knownIssueCodes: new Set<string>(),
      issues,
    } as BuildContextOptions));
    expect(issues.find(i => i.code === 'INCOHESIVE_METHODS')?.draftContext).toBe(true);
  });
});
