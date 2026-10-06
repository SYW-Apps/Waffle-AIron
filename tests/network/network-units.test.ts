/**
 * The pure blocks of sdd_network over hand-built values: the flow matrix
 * projector, the codec, the diagram projector and the flow check arbiter.
 */
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { explain, project } from '../../src/network/flow-matrix.js';
import { encodeFlows, encodePolicy } from '../../src/network/codec.js';
import { mermaid, view } from '../../src/network/diagram.js';
import { check } from '../../src/network/flow-check.js';
import { isNamed, key, workload } from '../../src/network/types.js';
import type { ReachModel, VerbReach } from '../../src/models/reach.js';

const verb = (o: Partial<VerbReach> & { portal: string; verb: string }): VerbReach => ({
  project: '', transport: 'HTTP', gateway: false, ...o,
});

describe('flow_matrix_projector.project', () => {
  it('produces no flow for in-process or local verbs', () => {
    const model: ReachModel = {
      scope: 'own', networks: [], calls: [],
      verbs: [
        verb({ portal: 'lib', verb: 'f', transport: 'InProcess', entry: { kind: 'entry', caller: 'Apps' } }),
        verb({ portal: 'cli', verb: 'run', transport: 'CLI', entry: { kind: 'entry', caller: 'Users' } }),
        verb({ portal: 'api', verb: 'get', binding: 'GET /x', entry: { kind: 'entry', caller: 'Browsers' } }),
      ],
    };
    expect(project(model).map((f) => key(f.to))).toEqual(['api.get']);
  });

  it('narrows a network entry to its modelled callers only in a family-scoped model', () => {
    const base: ReachModel = {
      scope: 'own', networks: [{ id: '', gateways: [] }],
      verbs: [verb({ portal: 'api', verb: 'get', network: '', entry: { kind: 'entry', scope: 'network', caller: 'Siblings' } })],
      calls: [{ fromProject: '', fromComponent: 'client', fromNetwork: '', toPortal: 'api', verb: 'get', evidence: 'client_impl.go#1' }],
    };
    expect(project(base).map((f) => key(f.from))).toEqual(['client', 'network']);
    expect(project({ ...base, scope: 'family' }).map((f) => key(f.from))).toEqual(['client']);
  });

  it('merges the evidence of one caller reaching one verb from several steps', () => {
    const model: ReachModel = {
      scope: 'family', networks: [],
      verbs: [verb({ portal: 'api', verb: 'get' })],
      calls: [1, 2].map((n) => ({ fromProject: '', fromComponent: 'client', toPortal: 'api', verb: 'get', evidence: `client_impl.go#${n}` })),
    };
    expect(project(model)).toEqual([expect.objectContaining({ evidence: ['call client_impl.go#1', 'call client_impl.go#2'] })]);
  });
});

describe('flow_party', () => {
  it('names a party by its scope, project, subsystem, component or key', () => {
    expect(workload({ scope: 'network', network: 'billing' })).toBe('network:billing');
    expect(workload({ project: '', subsystem: 'edge', component: 'gw' })).toBe('edge');
    expect(workload({ project: 'orders', component: 'orders::api' })).toBe('orders');
    const callee = { project: 'orders', subsystem: 'orders::ordering', component: 'orders::api', verb: 'get' };
    expect(['orders', 'orders::ordering', 'orders::api', 'orders::api.get'].every((n) => isNamed(callee, n))).toBe(true);
    expect(isNamed(callee, 'outside')).toBe(false);
    expect(isNamed({ scope: 'network', network: 'billing' }, 'network:billing')).toBe(true);
  });
});

describe('flow_matrix_projector.explain', () => {
  it('answers not allowed with an empty flow list when nothing reaches the callee', () => {
    expect(explain([], 'outside', 'api')).toEqual({ allowed: false, flows: [], chain: ['nothing in the design allows outside to reach api', 'no flow reaches api at all'] });
  });
});

describe('network_codec', () => {
  const flows = project({
    scope: 'family', networks: [],
    verbs: [verb({ portal: 'api', verb: 'get', binding: 'GET /a|b', entry: { kind: 'entry', caller: 'Says "hi", twice' } })],
    calls: [],
  });

  it('quotes CSV cells and escapes Markdown pipes', () => {
    expect(encodeFlows(flows, 'csv').content.split('\n')[1]).toBe('"outside","api.get","HTTP","GET /a|b","","","entry (outside): Says ""hi"", twice"');
    expect(encodeFlows(flows, 'markdown').content).toContain('GET /a\\|b');
    expect(encodeFlows([], 'markdown').content).toContain('No network-transport flows');
  });

  it('writes valid label values and object names from design names, and refuses a non-policy target', () => {
    const doc = encodePolicy(project({
      scope: 'family', networks: [],
      verbs: [verb({ project: 'pay', portal: 'pay::Pay_API', verb: 'charge', entry: { kind: 'entry', scope: 'network' } })],
      calls: [],
    }), { workloads: {} }, 'kubernetes-network-policy');
    const [policy] = parseAllDocuments(doc.content).map((d) => d.toJS()).filter(Boolean) as Record<string, any>[];
    expect(policy.metadata.name).toBe('wairon-allow-pay');
    expect(policy.spec.ingress[0].from[0].podSelector.matchLabels).toEqual({ 'wairon.dev/workload': 'network' });
    expect(() => encodePolicy([], { workloads: {} }, 'json')).toThrow(/not a policy target/);
  });

  it('lists MessageBus flows as not expressed instead of opening pod ingress for them', () => {
    const doc = encodePolicy(project({
      scope: 'family', networks: [],
      verbs: [verb({ portal: 'bus', verb: 'onPaid', transport: 'MessageBus', entry: { kind: 'entry', caller: 'Publishers' } })],
      calls: [],
    }), { workloads: {} }, 'kubernetes-network-policy');
    expect(doc.content).toContain('# NOT EXPRESSED (MessageBus, reached through the broker): outside -> bus.onPaid');
    expect(parseAllDocuments(doc.content).map((d) => d.toJS()).filter(Boolean)).toEqual([]);
  });
});

describe('network_diagram_projector', () => {
  it('draws a design with no network as workloads and edges only', () => {
    const model: ReachModel = {
      scope: 'own', networks: [],
      verbs: [verb({ portal: 'api', verb: 'get', subsystem: 'web', entry: { kind: 'entry', caller: 'Browsers' } })],
      calls: [],
    };
    expect(mermaid(view(model, project(model))).content).toBe('flowchart LR\n  w0(["outside"])\n  w1["web"]\n  w0 -->|"HTTP, 1 verb"| w1\n');
  });
});

describe('flow_check_arbiter.check', () => {
  const flows = project({
    scope: 'family', networks: [],
    verbs: [
      verb({ project: 'orders', portal: 'orders::api', verb: 'get', binding: 'GET /orders/{id}' }),
      verb({ project: 'orders', portal: 'orders::rpc', verb: 'Create', transport: 'gRPC', binding: 'orders.v1.Orders/Create' }),
    ],
    calls: [
      { fromProject: 'shop', fromComponent: 'shop::client', toPortal: 'orders::api', verb: 'get', evidence: 'a#1' },
      { fromProject: 'shop', fromComponent: 'shop::client', toPortal: 'orders::rpc', verb: 'Create', evidence: 'b#1' },
    ],
  });

  it('matches path templates and gRPC paths at L7', () => {
    const report = check(flows, [
      { source: 'shop', destination: 'orders', method: 'GET', path: '/orders/42?x=1' },
      { source: 'shop', destination: 'orders', method: 'POST', path: '/orders.v1.Orders/Create' },
      { source: 'shop', destination: 'orders', method: 'PUT', path: '/orders/42' },
    ], null);
    expect(report.unexercised).toEqual([]);
    expect(report.unknownVerbs.map((o) => o.method)).toEqual(['PUT']);
    expect(report.unexpected).toEqual([]);
  });

  it('marks every flow of a pair exercised from an L4 observation', () => {
    const report = check(flows, [{ source: 'shop::client', destination: 'orders' }], null);
    expect(report.unexercised).toEqual([]);
    expect(check(flows, [{ source: 'outside', destination: 'orders' }], null).unexpected).toHaveLength(1);
  });
});
