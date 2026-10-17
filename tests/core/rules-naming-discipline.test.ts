import { describe, it, expect } from 'vitest';
import { buildRuleContext, type BuildContextOptions } from '../../src/core/rules/index.js';
import type { ValidationIssue } from '../../src/core/validation.js';
import { namingDisciplineRule } from '../../src/core/rules/heuristic/naming-discipline.js';

// ---------------------------------------------------------------------------
// naming-discipline: a name says what a thing is, once. The head noun must
// name the block the component actually is, a generic role word names nothing,
// a method may not repeat its component's concept, and a component with one
// method may not merely be that method's name. Adapters and Portals forward,
// so their methods legitimately mirror the command or route they expose.
// ---------------------------------------------------------------------------

const stamp = { createdAt: '2026-09-17T10:00:00Z', updatedAt: '2026-09-17T10:00:00Z' };

const sub = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: id, description: `The ${id} subsystem.`, parentSystem: 'Freightline', publicInterfaces: [], trustedLinks: [], status: 'complete', ...stamp, ...extra }) as never;

const comp = (id: string, componentType: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: id, description: `The ${id} component.`, subsystem: 'dispatch', componentType, dependsOn: [], owns: [], status: 'complete', ...stamp, ...extra }) as never;

const intf = (id: string, component: string, methodNames: string[]) =>
  ({
    id, name: id, description: `The ${id} contract.`, component,
    methods: methodNames.map(name => ({ name, description: `${name} does its one job.`, signature: `${name}(): void`, returns: 'void' })),
    status: 'complete', ...stamp,
  }) as never;

function run(tree: Partial<BuildContextOptions>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  namingDisciplineRule.check(buildRuleContext({
    system: { schemaVersion: '1.0.0', name: 'Freightline', vision: 'v', ...stamp } as never,
    subsystems: [sub('dispatch')],
    components: [],
    interfaces: [],
    implementations: [],
    types: [],
    projectType: 'backend',
    roundTripIssues: [],
    knownIssueCodes: new Set<string>(),
    issues,
    ...tree,
  } as BuildContextOptions));
  return issues;
}

const of = (issues: ValidationIssue[], code: string) => issues.filter(i => i.code === code);

describe('naming-discipline — MISLEADING_BLOCK_WORD', () => {
  it('fires when the head noun claims a block the component is not', () => {
    const issue = of(run({ components: [comp('shipment_registry', 'Store')] }), 'MISLEADING_BLOCK_WORD')[0];
    expect(issue?.severity).toBe('warning');
    expect(issue?.specId).toBe('shipment_registry');
    expect(issue?.message).toContain('names a Registry, but it is declared a Store');
  });

  it('stays quiet when the head noun names the declared block', () => {
    expect(of(run({ components: [comp('shipment_registry', 'Registry')] }), 'MISLEADING_BLOCK_WORD')).toEqual([]);
  });

  it('says nothing about a head noun that names no block at all', () => {
    expect(of(run({ components: [comp('shipment_scheduler', 'Orchestrator')] }), 'MISLEADING_BLOCK_WORD')).toEqual([]);
  });

  it('carries the component\'s draft context', () => {
    const drafted = run({ components: [comp('shipment_registry', 'Store', { status: 'draft' })] });
    expect(of(drafted, 'MISLEADING_BLOCK_WORD')[0]?.draftContext).toBe(true);
  });
});

describe('naming-discipline — GENERIC_COMPONENT_NAME', () => {
  it('fires on a generic role word in the id', () => {
    const issue = of(run({ components: [comp('shipment_manager', 'Orchestrator')] }), 'GENERIC_COMPONENT_NAME')[0];
    expect(issue?.specId).toBe('shipment_manager');
    expect(issue?.message).toContain('"manager"');
  });

  it('reads the NAME as well as the id, so a clean id does not hide the word', () => {
    const issue = of(run({ components: [comp('shipment_scheduler', 'Orchestrator', { name: 'Shipment Handler' })] }), 'GENERIC_COMPONENT_NAME')[0];
    expect(issue?.message).toContain('"handler"');
  });

  it('reports every generic word it found, once each', () => {
    const issue = of(run({ components: [comp('shipment_service_utils', 'Orchestrator', { name: 'Shipment Service Utils' })] }), 'GENERIC_COMPONENT_NAME')[0];
    expect(issue?.message).toContain('"service", "utils"');
  });

  it('stays quiet on a name that states a responsibility', () => {
    expect(of(run({ components: [comp('shipment_scheduler', 'Orchestrator', { name: 'Shipment Scheduler' })] }), 'GENERIC_COMPONENT_NAME')).toEqual([]);
  });
});

describe('naming-discipline — METHOD_REPEATS_COMPONENT', () => {
  const tree = (componentType: string, methods: string[], id = 'manifest_repository') => ({
    components: [comp(id, componentType)],
    interfaces: [intf(`i${id}`, id, methods)],
  });

  it('fires when the concept follows the verb, anchored on the declaring interface', () => {
    const issue = of(run(tree('Repository', ['getManifest'])), 'METHOD_REPEATS_COMPONENT')[0];
    expect(issue?.severity).toBe('warning');
    expect(issue?.specId).toBe('imanifest_repository');
    expect(issue?.message).toContain('repeats the component\'s concept "manifest"');
    expect(issue?.message).toContain('Name it "get"');
  });

  it('matches the plural too, and proposes the name without the concept', () => {
    expect(of(run(tree('Repository', ['listManifests'])), 'METHOD_REPEATS_COMPONENT')[0]?.message).toContain('Name it "list"');
    expect(of(run(tree('Repository', ['getManifestHeader'])), 'METHOD_REPEATS_COMPONENT')[0]?.message).toContain('Name it "getHeader"');
  });

  it('leaves a QUALIFIED compound alone — the concept is narrowed, not repeated', () => {
    expect(of(run(tree('Repository', ['getCarrierManifest'])), 'METHOD_REPEATS_COMPONENT')).toEqual([]);
  });

  it('exempts Adapter and Portal forwarders, whose methods mirror what they expose', () => {
    expect(of(run(tree('Adapter', ['getManifest'], 'manifest_adapter')), 'METHOD_REPEATS_COMPONENT')).toEqual([]);
    expect(of(run(tree('Portal', ['getManifest'], 'manifest_portal')), 'METHOD_REPEATS_COMPONENT')).toEqual([]);
  });

  it('skips a concept under four characters, too small to judge a stutter on', () => {
    expect(of(run(tree('Repository', ['getLeg'], 'leg_repository')), 'METHOD_REPEATS_COMPONENT')).toEqual([]);
  });
});

describe('naming-discipline — COMPONENT_IS_ITS_ONLY_METHOD', () => {
  it('fires on a lone method named after the component', () => {
    const issue = of(run({
      components: [comp('route_plan', 'Orchestrator')],
      interfaces: [intf('iroute_plan', 'route_plan', ['buildPlan'])],
    }), 'COMPONENT_IS_ITS_ONLY_METHOD')[0];
    expect(issue?.specId).toBe('route_plan');
    expect(issue?.message).toContain('"buildPlan"');
  });

  it('stays quiet once the component holds a second method', () => {
    expect(of(run({
      components: [comp('route_plan', 'Orchestrator')],
      interfaces: [intf('iroute_plan', 'route_plan', ['buildPlan', 'revise'])],
    }), 'COMPONENT_IS_ITS_ONLY_METHOD')).toEqual([]);
  });

  it('stays quiet when the lone method is not the component\'s own name', () => {
    expect(of(run({
      components: [comp('route_plan', 'Orchestrator')],
      interfaces: [intf('iroute_plan', 'route_plan', ['assemble'])],
    }), 'COMPONENT_IS_ITS_ONLY_METHOD')).toEqual([]);
  });

  it('exempts an Adapter, whose one method is the remote call it wraps', () => {
    expect(of(run({
      components: [comp('carrier_quote_adapter', 'Adapter')],
      interfaces: [intf('icarrier_quote_adapter', 'carrier_quote_adapter', ['fetchAdapter'])],
    }), 'COMPONENT_IS_ITS_ONLY_METHOD')).toEqual([]);
  });

  it('matches the CONCEPT noun, not the head noun — an id ending in a block word is caught too', () => {
    // skills_orchestrator's head noun is "orchestrator" (never matches a method), but its
    // concept noun is "skills" — the component is named after its one method just as plainly.
    const issue = of(run({
      components: [comp('skills_orchestrator', 'Orchestrator')],
      interfaces: [intf('iskills_orchestrator', 'skills_orchestrator', ['loadSkills'])],
    }), 'COMPONENT_IS_ITS_ONLY_METHOD')[0];
    expect(issue?.specId).toBe('skills_orchestrator');
    expect(issue?.message).toContain('"loadSkills"');
  });

  it('walks past a trailing block word to find the concept, even two deep', () => {
    // secret_write_registry: "registry" is a block word, so the concept noun is "write".
    // The method is exactly that concept — the component's one verb, not a restatement —
    // so unlike skills_orchestrator/loadSkills above, this stays quiet.
    expect(of(run({
      components: [comp('secret_write_registry', 'Registry')],
      interfaces: [intf('isecret_write_registry', 'secret_write_registry', ['write'])],
    }), 'COMPONENT_IS_ITS_ONLY_METHOD')).toEqual([]);
  });

  it('stays quiet when the lone method IS the concept noun, singular or plural', () => {
    // state_hash: concept noun is "hash"; hash() says no more than the concept alone.
    expect(of(run({
      components: [comp('state_hash', 'Store')],
      interfaces: [intf('istate_hash', 'state_hash', ['hash'])],
    }), 'COMPONENT_IS_ITS_ONLY_METHOD')).toEqual([]);

    // Plural form of the concept is still "exactly the concept".
    expect(of(run({
      components: [comp('role_index', 'Index')],
      interfaces: [intf('irole_index', 'role_index', ['roles'])],
    }), 'COMPONENT_IS_ITS_ONLY_METHOD')).toEqual([]);
  });

  it('fires once the method adds words around the concept, not just the concept alone', () => {
    // role_index: concept noun is "role"; listRoles() says more than the concept alone.
    const issue = of(run({
      components: [comp('role_index', 'Index')],
      interfaces: [intf('irole_index', 'role_index', ['listRoles'])],
    }), 'COMPONENT_IS_ITS_ONLY_METHOD')[0];
    expect(issue?.specId).toBe('role_index');
    expect(issue?.message).toContain('"listRoles"');
  });
});
