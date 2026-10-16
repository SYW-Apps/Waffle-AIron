import { describe, it, expect } from 'vitest';
import { buildRuleContext, type BuildContextOptions } from '../../src/core/rules/index.js';
import { emptyExtensions } from '../../src/core/extensions.js';
import type { ValidationIssue } from '../../src/core/validation.js';
import type { SddRule } from '../../src/core/rules/types.js';
import { directEdgeRefusals } from '../../src/core/rules/doctrine/direct-edge.js';
import { entrypointDepsRule } from '../../src/core/rules/doctrine/entrypoint-dependencies.js';
import { dataBlockDepsRule } from '../../src/core/rules/doctrine/data-block-dependencies.js';
import { logicDependencyClassRule } from '../../src/core/rules/doctrine/logic-dependency-class.js';
import { subsystemBoundaryDepsRule } from '../../src/core/rules/doctrine/subsystem-boundary-dependencies.js';
import { memberVisibilityRule } from '../../src/core/rules/doctrine/member-visibility.js';
import { portalWriteShortcutRule } from '../../src/core/rules/doctrine/portal-write-shortcut.js';
import { supervisorSharedDataRule } from '../../src/core/rules/doctrine/supervisor-shared-data.js';
import { assertionForbiddenEdgesRule } from '../../src/core/rules/extension/assertion-forbidden-edges.js';
import { removableForwarderRule } from '../../src/core/rules/heuristic/removable-forwarder.js';

// ---------------------------------------------------------------------------
// removable-forwarder: a forwarding Orchestrator is reported only when every
// caller could legally call the target itself — and "legally" is the doctrine
// rules' own verdict (directEdgeRefusals), never a table of its own. The
// consistency block proves that: for every stereotype pair, the predicate
// refuses an edge exactly when the edge rules report one.
// ---------------------------------------------------------------------------

const stamp = { createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z' };

type Extra = Record<string, unknown>;

const sub = (id: string, extra: Extra = {}) =>
  ({ id, name: id, description: `The ${id} subsystem.`, parentSystem: 'Harborline', publicInterfaces: [], trustedLinks: [], status: 'complete', ...stamp, ...extra }) as never;

const comp = (id: string, componentType: string, extra: Extra = {}) =>
  ({ id, name: id, description: `The ${id} component.`, subsystem: 'tracking', componentType, dependsOn: [], owns: [], status: 'complete', ...stamp, ...extra }) as never;

const intf = (id: string, component: string, methods: Extra[]) =>
  ({
    id, name: id, description: `The ${id} contract.`, component,
    methods: methods.map(m => ({ description: `${m.name} does its one job.`, signature: `${m.name}(): void`, returns: 'void', ...m })),
    status: 'complete', ...stamp,
  }) as never;

const impl = (id: string, contract: string, methods: Extra[]) =>
  ({ id, name: id, description: `The ${id} realization.`, contract, methods, status: 'complete', ...stamp }) as never;

/** A method that hands its call to one collaborator and returns its answer. */
const handsOff = (name: string, targetComponent: string, targetMethod: string, type: 'call' | 'register' = 'call') => ({
  name,
  narrative: [
    { stepNumber: 1, type, description: `Pass ${name} on to ${targetComponent}.`, targetComponent, targetMethod },
    { stepNumber: 2, type: 'return', description: 'Return its answer.', outcome: 'answer' },
  ],
});

interface Tree {
  subsystems?: unknown[];
  components: unknown[];
  interfaces?: unknown[];
  implementations?: unknown[];
  extensions?: Extra;
}

function context(tree: Tree, issues: ValidationIssue[] = []) {
  return buildRuleContext({
    system: { schemaVersion: '1.0.0', name: 'Harborline', vision: 'v', ...stamp } as never,
    subsystems: tree.subsystems ?? [sub('tracking')],
    components: tree.components,
    interfaces: tree.interfaces ?? [],
    implementations: tree.implementations ?? [],
    types: [],
    projectType: 'backend',
    ...(tree.extensions ? { extensions: { ...emptyExtensions(), ...tree.extensions } } : {}),
    roundTripIssues: [],
    knownIssueCodes: new Set<string>(),
    issues,
  } as BuildContextOptions);
}

function run(rules: SddRule[], tree: Tree): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ctx = context(tree, issues);
  for (const rule of rules) rule.check(ctx);
  return issues;
}

// ---------------------------------------------------------------------------
// The predicate agrees with the rules
// ---------------------------------------------------------------------------

const EDGE_RULES = [entrypointDepsRule, dataBlockDepsRule, logicDependencyClassRule, subsystemBoundaryDepsRule, memberVisibilityRule, assertionForbiddenEdgesRule];

/** Every live stereotype, logic in its three classes. */
const STEREOTYPES: [string, Extra][] = [
  ['Portal', {}], ['Orchestrator', {}], ['Orchestrator', { dependencyClass: 'pure' }], ['Orchestrator', { dependencyClass: 'read' }],
  ['Supervisor', {}], ['Actor', {}], ['Store', {}], ['Index', {}], ['Query', {}], ['Registry', {}], ['Adapter', {}],
  ['Observer', {}], ['View', {}], ['Repository', {}], ['FeatureComponent', {}], ['RouterComponent', {}],
  ['Specialist', {}],
];

const label = ([type, extra]: [string, Extra]) => (extra.dependencyClass ? `${type}(${extra.dependencyClass})` : type);

/**
 * The codes the edge rules report on `caller` for a declared edge to `target`,
 * against the codes the predicate gives for the same edge left undeclared.
 */
function compare(caller: Extra, target: Extra, setting: Omit<Tree, 'components'> & { others?: unknown[] } = {}) {
  const others = setting.others ?? [];
  const declared = run(EDGE_RULES, { ...setting, components: [{ ...caller, dependsOn: [...(caller.dependsOn as string[] ?? []), target.id] }, target, ...others] })
    .filter(i => i.specId === caller.id)
    .map(i => i.code)
    .sort();
  const ctx = context({ ...setting, components: [caller, target, ...others] });
  const predicted = directEdgeRefusals(ctx, ctx.componentMap.get(caller.id as string)!, ctx.componentMap.get(target.id as string)!).sort();
  return { declared, predicted };
}

describe('directEdgeRefusals agrees with the edge rules', () => {
  it('for every stereotype pair inside one subsystem', () => {
    const disagreements: string[] = [];
    for (const from of STEREOTYPES) {
      for (const to of STEREOTYPES) {
        const caller = comp('harbor-caller', from[0], from[1]) as unknown as Extra;
        const target = comp('harbor-target', to[0], to[1]) as unknown as Extra;
        const { declared, predicted } = compare(caller, target);
        // A retired end is retired-stereotypes' finding, never a legal shortcut:
        // the edge rules stay silent on it, and the predicate refuses it.
        if (from[0] === 'Specialist' || to[0] === 'Specialist') {
          if (declared.length !== 0 || predicted.join() !== 'RETIRED_STEREOTYPE') disagreements.push(`${label(from)} → ${label(to)}: retired edge`);
          continue;
        }
        if (declared.join() !== predicted.join()) disagreements.push(`${label(from)} → ${label(to)}: rules [${declared}] predicate [${predicted}]`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('for every stereotype pair across subsystems, published or not, with and without a trustedLink', () => {
    const disagreements: string[] = [];
    for (const published of [false, true]) {
      for (const trusted of [false, true]) {
        const subsystems = [
          sub('tracking', trusted ? { trustedLinks: [{ subsystem: 'rates', reason: 'In-process rate lookups.' }] } : {}),
          sub('rates', published ? { publicInterfaces: [{ component: 'harbor-target', interface: 'iharbor_target' }] } : {}),
        ];
        for (const from of STEREOTYPES.filter(s => s[0] !== 'Specialist')) {
          for (const to of STEREOTYPES.filter(s => s[0] !== 'Specialist')) {
            const caller = comp('harbor-caller', from[0], from[1]) as unknown as Extra;
            const target = comp('harbor-target', to[0], { ...to[1], subsystem: 'rates' }) as unknown as Extra;
            const { declared, predicted } = compare(caller, target, { subsystems });
            if (declared.join() !== predicted.join()) disagreements.push(`${label(from)} → ${label(to)} (published ${published}, trusted ${trusted}): rules [${declared}] predicate [${predicted}]`);
          }
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('for a member another pattern or a Supervisor owns, and for an own sibling', () => {
    const disagreements: string[] = [];
    const owners: [string, unknown[], Extra][] = [
      ['another Repository', [comp('cargo-repository', 'Repository', { owns: ['harbor-target'] })], {}],
      ['a Supervisor', [comp('voyage-supervisor', 'Supervisor', { owns: ['harbor-target'] })], {}],
      ['its own Repository', [comp('cargo-repository', 'Repository', { owns: ['harbor-target', 'harbor-caller'] })], {}],
    ];
    for (const [what, others] of owners) {
      for (const from of STEREOTYPES.filter(s => s[0] !== 'Specialist')) {
        for (const toType of ['Store', 'Registry', 'Index']) {
          const caller = comp('harbor-caller', from[0], from[1]) as unknown as Extra;
          const target = comp('harbor-target', toType) as unknown as Extra;
          const { declared, predicted } = compare(caller, target, { others });
          if (declared.join() !== predicted.join()) disagreements.push(`${label(from)} → ${toType} owned by ${what}: rules [${declared}] predicate [${predicted}]`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('for a pack profile that licenses a pair, and a forbid-edge assertion', () => {
    const licensed = { extensions: { profiles: { backend: { family: 'backend-like', allowedEdges: [{ from: ['Portal'], to: ['Adapter'], reason: 'The platform idiom.' }] } } } };
    const portal = comp('harbor-caller', 'Portal') as unknown as Extra;
    const adapter = comp('harbor-target', 'Adapter') as unknown as Extra;
    expect(compare(portal, adapter)).toEqual({ declared: ['ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP'], predicted: ['ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP'] });
    expect(compare(portal, adapter, licensed)).toEqual({ declared: [], predicted: [] });

    const forbidden = {
      extensions: {
        assertions: [{
          kind: 'forbid-edge', code: 'DIRECT_VENDOR_CALL', fullCode: 'HARBOR_DIRECT_VENDOR_CALL', pack: 'harbor', severity: 'error',
          reason: 'Vendor calls go through the rates workflow.', from: { componentType: ['Orchestrator'] }, to: { componentType: ['Adapter'] }, relation: ['dependsOn'],
        }],
      },
    };
    const orchestrator = comp('harbor-caller', 'Orchestrator') as unknown as Extra;
    expect(compare(orchestrator, adapter, forbidden)).toEqual({ declared: ['HARBOR_DIRECT_VENDOR_CALL'], predicted: ['HARBOR_DIRECT_VENDOR_CALL'] });
  });

  it('on the call: the Portal write shortcut and the Supervisor shared-data bound, each with its own reading of an untagged method', () => {
    const disagreements: string[] = [];
    for (const [callerType, targetType, rule] of [
      ['Portal', 'Repository', portalWriteShortcutRule],
      ['Portal', 'Index', portalWriteShortcutRule],
      ['Supervisor', 'Repository', supervisorSharedDataRule],
      ['Supervisor', 'Store', supervisorSharedDataRule],
    ] as [string, string, SddRule][]) {
      for (const effect of ['read', 'write', 'lifecycle', 'io', undefined]) {
        const components = [comp('harbor-caller', callerType, { dependsOn: ['harbor-target'] }), comp('harbor-target', targetType)];
        const interfaces = [
          intf('iharbor_caller', 'harbor-caller', [{ name: 'handle' }]),
          intf('iharbor_target', 'harbor-target', [{ name: 'touch', ...(effect ? { effect } : {}) }]),
        ];
        const implementations = [impl('harbor_caller_impl', 'iharbor_caller', [handsOff('handle', 'harbor-target', 'touch')])];
        const declared = run([rule], { components, interfaces, implementations }).map(i => i.code);
        const ctx = context({ components, interfaces, implementations });
        const predicted = directEdgeRefusals(ctx, ctx.componentMap.get('harbor-caller')!, ctx.componentMap.get('harbor-target')!, 'touch')
          .filter(c => c === 'PORTAL_WRITE_SHORTCUT' || c === 'SUPERVISOR_WRITE_SHORTCUT');
        if (declared.join() !== predicted.join()) disagreements.push(`${callerType} → ${targetType}.touch (${effect ?? 'untagged'}): rule [${declared}] predicate [${predicted}]`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('refuses an edge to the caller itself', () => {
    const ctx = context({ components: [comp('shipment-desk', 'Orchestrator')] });
    const desk = ctx.componentMap.get('shipment-desk')!;
    expect(directEdgeRefusals(ctx, desk, desk)).toEqual(['SELF_EDGE']);
  });
});

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/** tracking-portal → shipment-lookup (forwarder) → the given target and method, plus whatever else the case adds. */
function forwarderTree(target: unknown, targetContract: unknown, targetMethod: string, extra: Partial<Tree> & { lookup?: Extra; callerMethods?: Extra[] } = {}): Tree {
  const targetId = (target as { id: string }).id;
  return {
    subsystems: extra.subsystems,
    extensions: extra.extensions,
    components: [
      comp('tracking-portal', 'Portal', { dependsOn: ['shipment-lookup'] }),
      comp('shipment-lookup', 'Orchestrator', { dependsOn: [targetId], ...(extra.lookup ?? {}) }),
      target,
      ...(extra.components ?? []),
    ],
    interfaces: [
      intf('itracking_portal', 'tracking-portal', [{ name: 'trackShipment' }]),
      intf('ishipment_lookup', 'shipment-lookup', [{ name: 'findShipment' }]),
      targetContract,
      ...(extra.interfaces ?? []),
    ],
    implementations: [
      impl('tracking_portal_impl', 'itracking_portal', extra.callerMethods ?? [handsOff('trackShipment', 'shipment-lookup', 'findShipment')]),
      impl('shipment_lookup_impl', 'ishipment_lookup', [handsOff('findShipment', targetId, targetMethod)]),
      ...(extra.implementations ?? []),
    ],
  };
}

const repository = comp('shipment-repository', 'Repository');
const repositoryContract = intf('ishipment_repository', 'shipment-repository', [
  { name: 'loadShipment', effect: 'read' },
  { name: 'recordScan', effect: 'write' },
  { name: 'describeShipment' },
]);
const adapter = comp('carrier-adapter', 'Adapter');
const adapterContract = intf('icarrier_adapter', 'carrier-adapter', [{ name: 'fetchPosition', effect: 'io' }]);

const findings = (tree: Tree) => run([removableForwarderRule], tree).filter(i => i.code === 'REMOVABLE_FORWARDER');

describe('removable-forwarder — REMOVABLE_FORWARDER', () => {
  it('fires when the portal could read the repository itself, naming the forwarder, the caller and the target', () => {
    const issues = findings(forwarderTree(repository, repositoryContract, 'loadShipment'));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].specId).toBe('shipment-lookup');
    expect(issues[0].message).toContain('"tracking-portal" may call "shipment-repository" directly');
    expect(issues[0].message).toContain('shipment-lookup.findShipment passes the call to shipment-repository.loadShipment');
    expect(issues[0].message).toContain('lint.allow for REMOVABLE_FORWARDER');
  });

  it('stays silent when the portal would reach an Adapter: the forwarder is required', () => {
    expect(findings(forwarderTree(adapter, adapterContract, 'fetchPosition'))).toEqual([]);
  });

  it('fires on the same Adapter forwarder once a pack profile licenses Portal → Adapter', () => {
    const extensions = { profiles: { backend: { family: 'backend-like', allowedEdges: [{ from: ['Portal'], to: ['Adapter'], reason: 'The platform idiom.' }] } } };
    expect(findings(forwarderTree(adapter, adapterContract, 'fetchPosition', { extensions }))).toHaveLength(1);
  });

  it('stays silent in front of a write- or lifecycle-effect facade method, and fires in front of an untagged one, as the write-shortcut rule reads them', () => {
    expect(findings(forwarderTree(repository, repositoryContract, 'recordScan'))).toEqual([]);
    expect(findings(forwarderTree(repository, intf('ishipment_repository', 'shipment-repository', [{ name: 'closeShipment', effect: 'lifecycle' }]), 'closeShipment'))).toEqual([]);
    expect(findings(forwarderTree(repository, repositoryContract, 'describeShipment'))).toHaveLength(1);
  });

  it('stays silent when one caller could not make the call itself', () => {
    const tree = forwarderTree(repository, repositoryContract, 'loadShipment', {
      components: [comp('delay-observer', 'Observer', { dependsOn: ['shipment-lookup'] })],
      interfaces: [intf('idelay_observer', 'delay-observer', [{ name: 'onDelay' }])],
      implementations: [impl('delay_observer_impl', 'idelay_observer', [handsOff('onDelay', 'shipment-lookup', 'findShipment')])],
    });
    expect(findings(tree)).toEqual([]);
  });

  it('judges a boundary crossing as the boundary rule does: a published Portal of a trusted peer may be called directly', () => {
    const tree = forwarderTree(comp('rate-portal', 'Portal', { subsystem: 'rates' }), intf('irate_portal', 'rate-portal', [{ name: 'quote' }]), 'quote', {
      subsystems: [sub('tracking', { trustedLinks: [{ subsystem: 'rates', reason: 'In-process rate quotes.' }] }), sub('rates', { publicInterfaces: [{ component: 'rate-portal', interface: 'irate_portal' }] })],
    });
    // The trustedLink licenses the crossing for every component of the
    // tracking subsystem, the portal as much as the forwarder.
    expect(findings(tree)).toHaveLength(1);
  });

  it('stays silent when a caller in another subsystem could not reach the target past its boundary', () => {
    const tree = forwarderTree(repository, repositoryContract, 'loadShipment', {
      subsystems: [sub('tracking', { publicInterfaces: [{ component: 'shipment-lookup', interface: 'ishipment_lookup' }] }), sub('billing', { trustedLinks: [{ subsystem: 'tracking', reason: 'In-process shipment lookups.' }] })],
      components: [comp('invoice-workflow', 'Orchestrator', { subsystem: 'billing', dependsOn: ['shipment-lookup'] })],
      interfaces: [intf('iinvoice_workflow', 'invoice-workflow', [{ name: 'invoiceShipment' }])],
      implementations: [impl('invoice_workflow_impl', 'iinvoice_workflow', [handsOff('invoiceShipment', 'shipment-lookup', 'findShipment')])],
    });
    // The repository is not on the tracking subsystem's published surface,
    // so the billing workflow could not depend on it: the hop is required.
    expect(findings(tree)).toEqual([]);
  });

  it('reads a Portal dispatch binding as a caller', () => {
    const tree = forwarderTree(repository, repositoryContract, 'loadShipment', {
      callerMethods: [{ name: 'trackShipment', narrative: [{ stepNumber: 1, type: 'local', description: 'Route through the dispatch table.' }] }],
    });
    (tree.components[0] as Extra).dispatch = [{ capability: 'track', component: 'shipment-lookup', method: 'findShipment' }];
    expect(findings(tree)).toHaveLength(1);
  });

  it('stays silent with no modelled caller, a register step, an invokedBy, or an unnarrated forwarder', () => {
    const noCaller = forwarderTree(repository, repositoryContract, 'loadShipment', { callerMethods: [{ name: 'trackShipment' }] });
    expect(findings(noCaller)).toEqual([]);

    const registered = forwarderTree(repository, repositoryContract, 'loadShipment', { callerMethods: [handsOff('trackShipment', 'shipment-lookup', 'findShipment', 'register')] });
    expect(findings(registered)).toEqual([]);

    const invoked = forwarderTree(repository, repositoryContract, 'loadShipment');
    (invoked.interfaces![1] as { methods: Extra[] }).methods[0].invokedBy = { kind: 'runtime', caller: 'The nightly reconciliation job calls it.' };
    expect(findings(invoked)).toEqual([]);

    const unnarrated = forwarderTree(repository, repositoryContract, 'loadShipment');
    (unnarrated.implementations![1] as { methods: Extra[] }).methods = [{ name: 'findShipment' }];
    expect(findings(unnarrated)).toEqual([]);
  });

  it('stays silent on an Orchestrator that does work of its own', () => {
    const tree = forwarderTree(repository, repositoryContract, 'loadShipment');
    (tree.implementations![1] as { methods: Extra[] }).methods = [{
      name: 'findShipment',
      narrative: [
        { stepNumber: 1, type: 'call', description: 'Load the shipment.', targetComponent: 'shipment-repository', targetMethod: 'loadShipment' },
        { stepNumber: 2, type: 'local', description: 'Redact the consignee for the public view.' },
        { stepNumber: 3, type: 'return', description: 'Return the redacted shipment.', outcome: 'shipment' },
      ],
    }];
    expect(findings(tree)).toEqual([]);
  });
});
