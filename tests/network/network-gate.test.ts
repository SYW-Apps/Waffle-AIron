/**
 * The derived networking never trusts a design that fails the gate, and
 * matches what a cluster actually sees — the round-2 platform trial's probes,
 * reproduced over the platform family (tests/helpers/network-family.ts):
 *
 * - the bypass probe: an `outside` entry on a non-gateway Portal inside the
 *   network (GATEWAY_BYPASSED) is marked REFUSED in the matrix, never admitted
 *   by a policy (no 0.0.0.0/0 into the service), refused by `why`, and an
 *   observed outside call to it is a disallowed flow, not "unexpected (0)";
 * - the observed L7 file: bindings carry the Portal's basePath, so
 *   `POST /internal/v1/orders` matches the verb, and a declared verb called
 *   from a source the design does not allow is disallowed, not "unknown";
 * - a caller recorded only by a cross-project reference is named by its
 *   workload (its subsystem), not by its Adapter alone;
 * - `why` answers an in-process collaborator and an unknown party as what
 *   they are.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { parseAllDocuments } from 'yaml';
import { materializeFixtureProject } from '../rules-matrix/harness.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { check, flows, policy, why } from '../../src/network/index.js';
import type { NetworkFlow } from '../../src/network/index.js';
import { platformFamily, PLATFORM_BINDINGS } from '../helpers/network-family.js';

let dir = '';

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-network-gate-')));
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

/** Patch one stored spec of the family in place. */
function patch(rel: string, mutate: (spec: Record<string, any>) => void): void {
  const file = path.join(dir, rel);
  const spec = yaml.load(fs.readFileSync(file, 'utf-8')) as Record<string, any>;
  mutate(spec);
  fs.writeFileSync(file, yaml.dump(spec, { noRefs: true, lineWidth: 200 }));
  invalidateSpecCache();
}

const ORDERS_API = 'services/orders/.wai/specs/components/orders_api.yaml';

/** The platform trial's bypass probe: a second ingress pointed straight at the orders service. */
function bypassTheGateway(): void {
  patch(ORDERS_API, (c) => { c.invokedBy = { kind: 'entry', caller: 'A second ingress someone pointed straight at orders' }; });
}

describe('the network commands judge the gate first (the bypass probe)', () => {
  it('marks the refused rows in the matrix and says the design fails the gate', () => {
    bypassTheGateway();
    const doc = flows({}, 'json');
    const rows = JSON.parse(doc.content) as NetworkFlow[];
    const refused = rows.filter((f) => f.from.scope === 'outside' && f.to.component === 'orders::orders_api');
    expect(refused.map((f) => f.to.verb)).toEqual(['create', 'get']);
    for (const f of refused) expect(f.refusedBy?.[0]).toMatch(/^GATEWAY_BYPASSED: /);
    expect(doc.refused).toBe(true);
    expect(doc.gateFindings.some((l) => l.startsWith('GATEWAY_BYPASSED (error): '))).toBe(true);
    const md = flows({}, 'markdown');
    expect(md.content).toMatch(/^> \*\*The design fails the gate:\*\*/);
    expect(md.content).toMatch(/\| REFUSED: GATEWAY_BYPASSED \|/);
  });

  it('never admits a refused flow in a policy: no 0.0.0.0/0 into the service, the head names it, the document says refused', () => {
    bypassTheGateway();
    const doc = policy({}, write('bindings.yaml', PLATFORM_BINDINGS), 'kubernetes-network-policy');
    expect(doc.refused).toBe(true);
    expect(doc.content).toContain('# THE DESIGN FAILS THE GATE');
    expect(doc.content).toMatch(/# REFUSED: outside -> orders::orders_api\.create/);
    const objects = parseAllDocuments(doc.content).map((d) => d.toJS()).filter(Boolean) as Record<string, any>[];
    const orders = objects.find((o) => o.metadata.name === 'wairon-allow-orders')!;
    const blocks = JSON.stringify(orders.spec.ingress);
    expect(blocks).not.toContain('0.0.0.0/0');
    // The gateway, legally entered from outside, still is.
    expect(JSON.stringify(objects.find((o) => o.metadata.name === 'wairon-allow-api-gateway')!.spec.ingress)).toContain('0.0.0.0/0');
  });

  it('answers why with the refusal and its findings, never "may reach"', () => {
    bypassTheGateway();
    const answer = why({}, 'outside', 'orders');
    expect(answer.allowed).toBe(false);
    expect(answer.refusedBy?.[0]).toMatch(/^GATEWAY_BYPASSED: /);
    expect(answer.chain[0]).toMatch(/the gate refuses/);
  });

  it('files an observed outside call into the refused entry as disallowed, with the gate findings', () => {
    bypassTheGateway();
    const report = check({}, write('observed.csv', 'source,destination,transport\noutside,orders,HTTP\n'), write('bindings.yaml', PLATFORM_BINDINGS));
    expect(report.disallowed.map((o) => `${o.source}->${o.destination}`)).toEqual(['outside->orders']);
    expect(report.unexpected).toEqual([]);
    expect(report.gateFindings.some((l) => l.startsWith('GATEWAY_BYPASSED'))).toBe(true);
  });

  it('a design that passes the gate refuses nothing; a warning only marks its row', () => {
    const doc = flows({}, 'json');
    expect(doc.refused).toBe(false);
    // orders_api.get's network entry has no modelled caller: allowed, but flagged.
    expect(doc.gateFindings.map((l) => l.slice(0, l.indexOf(':')))).toEqual(['ENTRY_UNPROVEN (warning)']);
    const rows = JSON.parse(doc.content) as NetworkFlow[];
    expect(rows.filter((f) => f.flaggedBy?.length).map((f) => f.to.verb)).toEqual(['get']);
    expect(rows.some((f) => f.refusedBy?.length)).toBe(false);
  });
});

describe('the matrix matches what a cluster sees (the observed L7 file)', () => {
  beforeEach(() => {
    // The service base path; and only create is an entry for the platform's services (get is reached by nobody).
    patch(ORDERS_API, (c) => { c.basePath = '/internal/v1'; delete c.invokedBy; });
    patch('services/orders/.wai/specs/interfaces/iorders_api.yaml', (i) => {
      i.methods[0].invokedBy = { kind: 'entry', scope: 'network', caller: "The platform's own services" };
    });
  });

  it('carries the Portal basePath in the binding', () => {
    const rows = JSON.parse(flows({}, 'json').content) as NetworkFlow[];
    expect(rows.find((f) => f.to.verb === 'create')!.binding).toBe('POST /internal/v1/orders');
  });

  it('matches real paths, and files a declared verb from a source the design does not allow as disallowed', () => {
    const observed = write('observed-l7.csv', [
      'source,destination,transport,method,path,count',
      'edge,orders,HTTP,POST,/internal/v1/orders,40',
      'edge,orders,HTTP,GET,/internal/v1/orders/42,3',
      'edge,orders,HTTP,DELETE,/internal/v1/orders/42,1',
    ].join('\n'));
    const report = check({}, observed, write('bindings.yaml', PLATFORM_BINDINGS));
    // create is matched under its basePath: exercised, not an unknown verb.
    expect(report.unexercised.some((f) => f.to.verb === 'create')).toBe(false);
    // get is declared, but the design allows the edge only create: a boundary violation.
    expect(report.disallowed.map((o) => `${o.method} ${o.path}`)).toEqual(['GET /internal/v1/orders/42']);
    // DELETE matches no declared verb at all: that one is unknown.
    expect(report.unknownVerbs.map((o) => o.method)).toEqual(['DELETE']);
  });
});

describe('a caller is named by its workload', () => {
  it('names the root\'s calling Adapter by its subsystem across a project boundary', () => {
    const rows = JSON.parse(flows({}, 'json').content) as NetworkFlow[];
    expect(rows.find((f) => f.to.verb === 'create')!.from.subsystem).toBe('edge');
    const answer = why({}, 'edge', 'orders');
    expect(answer.allowed).toBe(true);
    expect(answer.flows.map((f) => f.from.component)).toEqual(['orders_client']);
  });

  it('binds the caller\'s pods through its subsystem when the bindings name workloads per service', () => {
    const bindings = write('per-service.yaml', [
      'workloads:',
      '  edge: { selector: { app: edge }, namespace: platform }',
      '  orders: { selector: { app: orders }, namespace: platform }',
      '  billing: { selector: { app: billing }, namespace: payments }',
      '  network: { selector: { platform.example/member: "true" } }',
      'outside: [0.0.0.0/0]',
    ].join('\n'));
    const doc = policy({}, bindings, 'kubernetes-network-policy');
    expect(doc.unbound).toEqual([]);
    const orders = (parseAllDocuments(doc.content).map((d) => d.toJS()).filter(Boolean) as Record<string, any>[])
      .find((o) => o.metadata.name === 'wairon-allow-orders')!;
    expect(JSON.stringify(orders.spec.ingress)).toContain('"app":"edge"');
  });
});

describe('why says what an answer is', () => {
  it('answers an in-process collaborator as in-process, not as a refusal', () => {
    const answer = why({}, 'orders::billing_client', 'orders::order_pricing');
    expect(answer.allowed).toBe(false);
    expect(answer.inProcess).toBe(true);
    expect(answer.chain[0]).toMatch(/reached in-process/);
  });

  it('answers a mis-spelled party as unknown, not as "nothing allows"', () => {
    const answer = why({}, 'outside', 'edgee::api_gateway.placeOrder');
    expect(answer.allowed).toBe(false);
    expect(answer.unknown).toEqual(['edgee::api_gateway.placeOrder']);
    expect(answer.chain.join('\n')).not.toMatch(/nothing in the design allows/);
  });
});
