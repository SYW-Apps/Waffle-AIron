/**
 * The derived networking, end to end over a real family (the integration sim
 * of sdd_network): the network portal, its workflows, the real validator's
 * reach model, the real file adapter — nothing mocked. The family declares a
 * network with a gateway, two services (one behind its own nested network's
 * gateway) and a library; see tests/helpers/network-family.ts.
 *
 * Anchors: "sim:network_portal.flows", "sim:network_portal.policy",
 * "sim:network_portal.diagram", "sim:network_portal.view",
 * "sim:network_portal.check", "sim:network_portal.why".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { materializeFixtureProject } from '../rules-matrix/harness.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { check, diagram, flows, policy, view, why } from '../../src/network/index.js';
import type { NetworkFlow } from '../../src/network/index.js';
import { platformFamily, PLATFORM_BINDINGS } from '../helpers/network-family.js';

let dir = '';

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-network-')));
  materializeFixtureProject(dir, platformFamily());
  setProjectRoot(dir);
  invalidateSpecCache();
});

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
});

/** A file beside the family, outside .wai/. */
function write(name: string, content: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

const row = (f: NetworkFlow): string => {
  const from = f.from.scope !== undefined ? `${f.from.scope}${f.from.network ? `:${f.from.network}` : ''}` : f.from.component;
  return `${from} -> ${f.to.component}.${f.to.verb} [${f.crosses.join('>')}]${f.via ? ` via ${f.via}` : ''}`;
};

describe('network_portal.flows (sim:network_portal.flows)', () => {
  it('derives the least-privilege matrix of the family: entries, modelled calls, nested networks, no library flows', () => {
    const matrix = JSON.parse(flows({}, 'json').content) as NetworkFlow[];
    expect(matrix.map(row)).toEqual([
      // JSON names the root's network by the root project's id, never "".
      'outside -> api_gateway.listOrders [platform] via api_gateway',
      'outside -> api_gateway.placeOrder [platform] via api_gateway',
      // billing's gateway: entered from the platform network (outside billing is the next network out) and by the orders service.
      'network:platform -> billing::billing_api.charge [billing] via billing::billing_api',
      'orders::billing_client -> billing::billing_api.charge [billing] via billing::billing_api',
      'network:platform -> billing::billing_api.refund [billing] via billing::billing_api',
      // create's network entry is proven by the root's modelled caller: narrowed to it (no blanket network row).
      'orders_client -> orders::orders_api.create []',
      // get's network entry has no modelled caller: the whole network may reach it.
      'network:platform -> orders::orders_api.get []',
    ]);
    // The outside flows enter the root network through its gateway, named by the root project's id in JSON.
    expect(matrix[0].crosses).toEqual(['platform']);
    expect(matrix.some((f) => f.to.component === 'geo::geo_lib')).toBe(false);
    expect(matrix.find((f) => f.to.verb === 'create')!.evidence).toEqual(['call orders_client_impl (call orders::orders)']);
  });

  it('answers CSV and Markdown with every fact of every flow', () => {
    const csv = flows({}, 'csv').content.trim().split('\n');
    expect(csv[0]).toBe('"from","to","transport","binding","crosses","via","evidence","gate"');
    expect(csv).toHaveLength(8);
    expect(csv).toContain('"orders::billing_client","billing::billing_api.charge","HTTP","POST /charges","billing","billing::billing_api","call orders::billing_client_impl (call billing::billing)",""');
    const md = flows({}, 'markdown').content;
    expect(md).toContain('| orders_client | orders::orders_api.create | HTTP | POST /orders |');
  });

  it('is the bound project\'s own matrix with --no-recursive: network entries unnarrowed', () => {
    setProjectRoot(path.join(dir, 'services', 'orders'));
    invalidateSpecCache();
    const own = JSON.parse(flows({ memberDepth: 0 }, 'json').content) as NetworkFlow[];
    expect(own.map(row)).toEqual(['network -> orders_api.create []', 'network -> orders_api.get []']);
  });
});

describe('network_portal.policy (sim:network_portal.policy)', () => {
  it('generates well-formed Kubernetes NetworkPolicy from the matrix and the bindings, saying what it could not bind', () => {
    const doc = policy({}, write('bindings.yaml', PLATFORM_BINDINGS), 'kubernetes-network-policy');
    const docs = parseAllDocuments(doc.content);
    expect(docs.every((d) => d.errors.length === 0)).toBe(true);
    const objects = docs.map((d) => d.toJS()).filter(Boolean) as Record<string, any>[];
    expect(objects.map((o) => [o.apiVersion, o.kind, o.metadata.name, o.metadata.namespace])).toEqual([
      ['networking.k8s.io/v1', 'NetworkPolicy', 'wairon-allow-api-gateway', 'platform'],
      ['networking.k8s.io/v1', 'NetworkPolicy', 'wairon-allow-billing', 'payments'],
      ['networking.k8s.io/v1', 'NetworkPolicy', 'wairon-allow-orders', 'platform'],
    ]);
    const [gateway, billing, orders] = objects;
    expect(gateway.spec).toEqual({
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'edge' } },
      policyTypes: ['Ingress'],
      ingress: [{ from: [{ ipBlock: { cidr: '0.0.0.0/0' } }], ports: [{ protocol: 'TCP', port: 8443 }] }],
    });
    // billing runs in another namespace: the orders peer carries its namespace; the network-wide peer any namespace.
    expect(billing.spec.ingress).toEqual([
      { from: [{ podSelector: { matchLabels: { 'platform.example/member': 'true' } }, namespaceSelector: {} }], ports: [{ protocol: 'TCP', port: 9090 }] },
      { from: [{ podSelector: { matchLabels: { 'app.kubernetes.io/name': 'orders' } }, namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'platform' } } }], ports: [{ protocol: 'TCP', port: 9090 }] },
    ]);
    expect(orders.spec.ingress[1].from[0].podSelector.matchLabels).toEqual({ 'app.kubernetes.io/name': 'edge' });
    expect(doc.unbound).toEqual([]);
    // Deterministic: byte-identical on a second run.
    expect(policy({}, path.join(dir, 'bindings.yaml'), 'kubernetes-network-policy').content).toBe(doc.content);
  });

  it('never guesses a selector: an unbound name gets the placeholder label and is listed in the document and its head', () => {
    const doc = policy({}, write('partial.yaml', 'workloads:\n  orders: { selector: { app: orders } }\n'), 'kubernetes-network-policy');
    // An unbound callee falls back to its default workload: the root's gateway to its subsystem, edge.
    // A caller is named by its workload: orders_client runs in the bound orders subsystem.
    expect(doc.unbound).toEqual(['billing', 'edge', 'network', 'outside']);
    expect(doc.content).toContain('# UNBOUND: billing, edge, network, outside');
    const objects = parseAllDocuments(doc.content).map((d) => d.toJS()).filter(Boolean) as Record<string, any>[];
    const gateway = objects.find((o) => o.metadata.name === 'wairon-allow-edge')!;
    expect(gateway.spec.podSelector.matchLabels).toEqual({ 'wairon.dev/workload': 'edge' });
    // No outside blocks: nothing from outside is admitted.
    expect(gateway.spec.ingress).toEqual([]);
  });

  it('refuses a malformed bindings file naming the line, before any derivation', () => {
    expect(() => policy({}, write('bad.yaml', 'workloads:\n  orders:\n    selector: { app: orders }\n    port: eighty\n'), 'kubernetes-network-policy'))
      .toThrow(/bad\.yaml:4: workloads\.orders: port must be an integer/);
    expect(() => policy({}, write('worse.yaml', 'workloads: [\n'), 'kubernetes-network-policy')).toThrow(/worse\.yaml:\d+:/);
  });
});

describe('network_portal.diagram and view (sim:network_portal.diagram, sim:network_portal.view)', () => {
  it('draws the networks as nested trust boundaries, gateways on them, outside and the aggregated flows', () => {
    const vm = view({});
    expect(vm.networks.map((n) => [n.id, n.parent ?? null, n.gateways])).toEqual([['', null, ['api_gateway']], ['billing', '', ['billing::billing_api']]]);
    const edge = vm.edges.find((e) => e.from.scope === 'outside')!;
    expect(edge.verbs).toEqual(['api_gateway.listOrders (GET /api/orders)', 'api_gateway.placeOrder (POST /api/orders)']);
    const mermaid = diagram({}).content;
    expect(mermaid.split('\n')[0]).toBe('flowchart LR');
    expect(mermaid).toMatch(/subgraph net0\["root network: The order platform"\]/);
    expect(mermaid).toMatch(/subgraph net1\["network billing"\]/);
    expect(mermaid).toMatch(/\{\{"gateway billing::billing_api"\}\}/);
    expect(mermaid).toMatch(/\(\["outside"\]\) *\n/);
    expect(mermaid).toContain('-->|"HTTP, 2 verbs"|');
    // Billing's subgraph is nested inside the root network's.
    expect(mermaid.indexOf('subgraph net1')).toBeLessThan(mermaid.lastIndexOf('  end'));
  });
});

describe('network_portal.check (sim:network_portal.check)', () => {
  it('reports unexpected flows, unknown verbs and unexercised flows from an observed CSV named by the bindings', () => {
    const bindings = write('bindings.yaml', PLATFORM_BINDINGS);
    const observed = write('observed.csv', [
      'source,destination,transport,method,path,count',
      'outside,edge,HTTP,GET,/api/orders,120',
      'edge,orders,HTTP,POST,/orders,40',
      'orders,billing,HTTP,POST,/charges,38',
      'orders,billing,HTTP,DELETE,/charges/7,1',
      'orders,edge,TCP,,,3',
    ].join('\n'));
    const report = check({}, observed, bindings);
    // orders may not call the edge gateway: only outside may.
    expect(report.unexpected).toEqual([{ source: 'orders', destination: 'edge', transport: 'TCP', count: 3 }]);
    expect(report.unknownVerbs).toEqual([{ source: 'orders', destination: 'billing', transport: 'HTTP', method: 'DELETE', path: '/charges/7', count: 1 }]);
    expect(report.unexercised.map(row)).toEqual([
      'outside -> api_gateway.placeOrder [] via api_gateway',
      'network -> billing::billing_api.refund [billing] via billing::billing_api',
      'network -> orders::orders_api.get []',
    ]);
  });

  it('reads a JSON export of design names without bindings', () => {
    const observed = write('observed.json', JSON.stringify({ flows: [{ source: 'orders_client', destination: 'orders::orders_api', count: 5 }] }));
    const report = check({}, observed, null);
    expect(report.unexpected).toEqual([]);
    expect(report.unexercised.some((f) => f.to.verb === 'create')).toBe(false);
  });

  it('refuses a malformed row naming it', () => {
    expect(() => check({}, write('bad.csv', 'source,destination,count\norders,billing,many\n'), null)).toThrow(/bad\.csv:2: count must be a non-negative integer/);
    expect(() => check({}, write('nohead.csv', 'from,to\n'), null)).toThrow(/the header row must name source and destination/);
  });
});

describe('network_portal.why (sim:network_portal.why)', () => {
  it('explains a flow from the design, through the gateway it crosses', () => {
    const answer = why({}, 'orders', 'billing::billing_api.charge');
    expect(answer.allowed).toBe(true);
    expect(answer.chain).toEqual([
      'orders::billing_client: call orders::billing_client_impl (call billing::billing)',
      'enters network billing',
      'through gateway billing::billing_api',
      'reaches billing::billing_api.charge over HTTP (POST /charges)',
    ]);
  });

  it('says nothing allows a flow, naming what reaches the callee instead', () => {
    const answer = why({}, 'outside', 'orders::orders_api');
    expect(answer.allowed).toBe(false);
    expect(answer.flows).toEqual([]);
    expect(answer.chain[0]).toBe('nothing in the design allows outside to reach orders::orders_api');
    expect(answer.chain).toContain('allowed instead: orders_client -> orders::orders_api.create over HTTP');
  });
});
