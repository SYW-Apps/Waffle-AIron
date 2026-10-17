/**
 * Round-3 trial findings on the derived networking, each reproduced on the
 * platform family (tests/helpers/network-family.ts) or a unit model:
 *
 * - a project rename keeps the deployment side working: bindings keys and
 *   observed names written with the former id resolve through previousIds,
 *   with a note naming the key; the rename plan names those keys; an unbound
 *   workload fails `network policy`;
 * - from a member's root the network commands answer the enclosing family's
 *   view (its declaration and proofs), row for row as the root derives it;
 * - `why` knows a types-only subsystem and an `<alias>::name` external party;
 * - flows JSON names the root project; notices keep their severity; one
 *   MULTIPLE_GATEWAYS anchor; GATEWAY_BYPASSED once per Portal; a mixed-reach
 *   workload is noted in the policy; `flows` fails on a refused design;
 * - `network declare` keeps the description; sdd_get_status names the network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { materializeFixtureProject } from '../rules-matrix/harness.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { check, flows, policy, why } from '../../src/network/index.js';
import type { NetworkFlow } from '../../src/network/index.js';
import { project as projectMatrix } from '../../src/network/flow-matrix.js';
import { encodeFlows, encodePolicy } from '../../src/network/codec.js';
import { judge } from '../../src/core/rules/network-arbiter.js';
import type { ReachModel, VerbReach } from '../../src/models/reach.js';
import { plan as planMigration, apply as applyMigration } from '../../src/migrations/index.js';
import { runNetworkDeclare, runNetworkFlows, runNetworkPolicy } from '../../src/cli/runner.js';
import { declare as mcpDeclare } from '../../src/mcp/network.js';
import { statusNetworkLine } from '../../src/mcp/server.js';
import { loadProjectConfig } from '../../src/core/index.js';
import { platformFamily, PLATFORM_BINDINGS } from '../helpers/network-family.js';

let dir = '';

function bind(root: string): void {
  setProjectRoot(root);
  invalidateSpecCache();
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-network-r3-')));
  materializeFixtureProject(dir, platformFamily());
  bind(dir);
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
  setProjectRoot(null);
  invalidateSpecCache();
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
});

function write(name: string, content: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

const row = (f: NetworkFlow): string => {
  const from = f.from.scope !== undefined ? `${f.from.scope}${f.from.network ? `:${f.from.network}` : ''}` : f.from.component;
  return `${from} -> ${f.to.component}.${f.to.verb}`;
};

/** Rename the orders member's id (and so its alias) through the migration, as `wairon project rename` does. */
function renameOrders(): string[] {
  const plan = planMigration({ verb: 'rename', project: 'orders', newId: 'orders_svc' });
  expect(plan.refusals).toEqual([]);
  applyMigration(plan);
  bind(dir);
  return plan.notes;
}

describe('a project rename vs the deployment side (platform-r3 MAJOR 1)', () => {
  it('the rename plan names the bindings keys that carry the old id', () => {
    const notes = renameOrders();
    expect(notes.join('\n')).toMatch(/bindings keys "orders" and every "orders::…".*"orders_svc"/);
  });

  it('a bindings key written with the former id still binds the renamed workload, with a note naming the key — no placeholder selector', () => {
    renameOrders();
    const doc = policy({}, write('bindings.yaml', PLATFORM_BINDINGS), 'kubernetes-network-policy');
    expect(doc.unbound).toEqual([]);
    expect(doc.content).not.toContain('wairon.dev/workload');
    expect(doc.notes?.join('\n')).toContain('bindings key "orders" names the renamed project "orders_svc" by its former name');
    expect(doc.content).toContain('# NOTE: bindings key "orders"');
  });

  it('an observed flow named by the former id matches its renamed workload, noted', () => {
    renameOrders();
    write('bindings.yaml', PLATFORM_BINDINGS);
    write('observed.csv', 'source,destination,transport,method,path\nedge,orders,HTTP,POST,/orders\n');
    const report = check({}, path.join(dir, 'observed.csv'), path.join(dir, 'bindings.yaml'));
    expect(report.unexpected).toEqual([]);
    expect(report.disallowed).toEqual([]);
    expect(report.notes?.join('\n')).toContain('"orders" names the renamed project "orders_svc"');
  });

  it('network policy exits non-zero when any workload is unbound, and says why', async () => {
    write('partial.yaml', 'workloads:\n  orders: { selector: { app: orders } }\n');
    await runNetworkPolicy({ bindings: path.join(dir, 'partial.yaml') });
    expect(process.exitCode).toBe(1);
  });
});

describe('the network commands from a member\'s root (platform-r3 MAJOR 2)', () => {
  it('answer the enclosing family\'s declaration and proofs, row for row as the family root derives them', () => {
    const family = (JSON.parse(flows({}, 'json').content) as NetworkFlow[]).map(row);
    bind(path.join(dir, 'services', 'orders'));
    const doc = flows({}, 'json');
    const member = (JSON.parse(doc.content) as NetworkFlow[]).map(row);
    expect(member).toEqual([
      'orders::billing_client -> billing::billing_api.charge',
      'orders_client -> orders::orders_api.create',
      'network:platform -> orders::orders_api.get',
    ]);
    for (const r of member) expect(family).toContain(r);
    // The family proves create's network entry: no ENTRY_SCOPE_UNBOUNDED / ENTRY_UNPROVEN from the member's root.
    // (get has no modelled caller in the family either: the family flags it the same way.)
    const findings = doc.gateFindings.join('\n');
    expect(findings).not.toMatch(/ENTRY_SCOPE_UNBOUNDED/);
    expect(findings).not.toMatch(/ENTRY_UNPROVEN[^\n]*orders_api\.create/);
    bind(dir);
    const familyFindings = flows({}, 'json').gateFindings.filter((l) => l.includes('orders::'));
    expect(doc.gateFindings.filter((l) => l.includes('orders::'))).toEqual(familyFindings);
    expect(doc.notes?.[0]).toMatch(/enclosing family's network, declared and proven at the family root/);
  });

  it('why names the family\'s parties from a member\'s root', () => {
    bind(path.join(dir, 'services', 'orders'));
    expect(why({}, 'orders_client', 'orders::orders_api.create').allowed).toBe(true);
  });
});

describe('why on a types-only subsystem and an external\'s party (platform-r3, lib-and-app R3-38)', () => {
  it('answers a types-only subsystem as reached in-process, not as an unknown party', () => {
    fs.writeFileSync(path.join(dir, '.wai', 'specs', 'subsystems', 'contracts.yaml'),
      'schemaVersion: 1.0.0\nid: contracts\nname: contracts\ndescription: Shared value objects.\nparentSystem: Platform\ncreatedAt: "2026-01-01T00:00:00.000Z"\nupdatedAt: "2026-01-01T00:00:00.000Z"\n');
    bind(dir);
    const answer = why({}, 'edge', 'contracts');
    expect(answer.unknown).toBeUndefined();
    expect(answer.inProcess).toBe(true);
  });

  it('answers an <alias>::name party through a declared external as outside this design\'s network model', () => {
    bind(path.join(dir, 'services', 'orders'));
    const answer = why({ memberDepth: 0 }, 'ordering', 'geo::geo_lib');
    expect(answer.unknown).toBeUndefined();
    expect(answer.inProcess).toBe(true);
    expect(answer.chain[0]).toContain('consumed through the external "geo"');
  });
});

describe('the encoded matrix (tinkerer, solo-app)', () => {
  it('flows JSON names the root project and the root network, never ""', () => {
    const matrix = JSON.parse(flows({}, 'json').content) as NetworkFlow[];
    const gateway = matrix.find((f) => f.to.component === 'api_gateway')!;
    expect(gateway.to.project).toBe('platform');
    expect(gateway.crosses).toEqual(['platform']);
  });

  it('network flows exits non-zero on a design the gate refuses', async () => {
    const file = path.join(dir, '.wai', 'specs', 'components', 'api_gateway.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/variant: gateway\r?\n/, ''));
    bind(dir);
    await runNetworkFlows({ format: 'json', out: path.join(dir, 'flows.json') });
    expect(process.exitCode).toBe(1);
  });
});

const verb = (o: Partial<VerbReach>): VerbReach => ({ project: '', portal: 'p', verb: 'v', transport: 'HTTP', gateway: false, ...o });
const model = (o: Partial<ReachModel>): ReachModel => ({ scope: 'own', networks: [], verbs: [], calls: [], placements: [], topics: [], ...o });

describe('the network arbiter (tinkerer, solo-app)', () => {
  it('sites MULTIPLE_GATEWAYS on the declaring project\'s own gateway, so the project run and the family run agree', () => {
    const entry = { kind: 'entry' as const, caller: 'Browsers of the shop, over the public internet' };
    const family = model({
      scope: 'family',
      networks: [{ id: '', gateways: ['analytics::reporting_portal', 'link_portal'] }],
      verbs: [
        verb({ portal: 'link_portal', network: '', gateway: true, entry }),
        verb({ project: 'analytics', portal: 'analytics::reporting_portal', network: '', gateway: true, entry }),
      ],
    });
    const own = model({
      networks: [{ id: '', gateways: ['link_portal', 'reporting_portal'] }],
      verbs: [verb({ portal: 'link_portal', network: '', gateway: true, entry }), verb({ portal: 'reporting_portal', network: '', gateway: true, entry })],
    });
    const site = (m: ReachModel): string | undefined => judge(m).find((f) => f.code === 'MULTIPLE_GATEWAYS')?.specId;
    expect(site(family)).toBe('link_portal');
    expect(site(own)).toBe('link_portal');
  });

  it('reports GATEWAY_BYPASSED once per Portal, with one actionable message when the network has no gateway', () => {
    const entry = { kind: 'entry' as const, caller: 'The habit app on users\' phones' };
    const findings = judge(model({
      networks: [{ id: '', gateways: [] }],
      verbs: ['list', 'create', 'checkIn'].map((v) => verb({ portal: 'habit_portal', verb: v, network: '', entry })),
    })).filter((f) => f.code === 'GATEWAY_BYPASSED');
    expect(findings).toHaveLength(1);
    expect(findings[0].covers).toEqual(['list', 'create', 'checkIn']);
    expect(findings[0].message).toMatch(/has no gateway yet.*mark "habit_portal" variant: gateway/);
  });

  it('keeps a notice a notice in the encoded matrix', () => {
    const entry = { kind: 'entry' as const, caller: 'Browsers of the shop, over the public internet' };
    const m = model({
      networks: [{ id: '', gateways: ['a', 'b'] }],
      verbs: [verb({ portal: 'a', network: '', gateway: true, entry }), verb({ portal: 'b', network: '', gateway: true, entry })],
    });
    const doc = encodeFlows(projectMatrix({ ...m, findings: judge(m) }), 'markdown');
    expect(doc.gateFindings.some((l) => l.startsWith('MULTIPLE_GATEWAYS (notice)'))).toBe(true);
    expect(doc.gateFindings.some((l) => l.startsWith('MULTIPLE_GATEWAYS (warning)'))).toBe(false);
  });
});

describe('a policy over a workload whose verbs differ in reach (tinkerer MAJOR)', () => {
  it('notes that L4 cannot separate them and names the Portal-level binding that splits them', () => {
    const m = model({
      verbs: [
        verb({ project: 'analytics', subsystem: 'analytics::analytics', portal: 'analytics::reporting_portal', verb: 'getStats', binding: 'GET /stats/{code}', entry: { kind: 'entry', caller: 'Browsers of anyone with a short link' } }),
        verb({ project: 'analytics', subsystem: 'analytics::analytics', portal: 'analytics::ingestion_portal', verb: 'recordHit', binding: 'POST /hits' }),
      ],
      calls: [{ fromProject: '', fromComponent: 'hit_client', fromSubsystem: 'links', toPortal: 'analytics::ingestion_portal', verb: 'recordHit', evidence: 'hit_client_impl.report#1' }],
    });
    const bindings = { workloads: { analytics: { selector: { app: 'analytics' }, port: 8081 }, links: { selector: { app: 'links' } } }, outside: ['10.0.0.0/8'] };
    const doc = encodePolicy(projectMatrix(m), bindings, 'kubernetes-network-policy');
    expect(doc.notes?.join('\n')).toMatch(/workload "analytics" serves verbs that differ in who may reach them.*analytics::reporting_portal: \{ selector, port \}/);
    // Bound on its own, the Portal gets its own policy and the note goes.
    const split = encodePolicy(projectMatrix(m), { ...bindings, workloads: { ...bindings.workloads, 'analytics::reporting_portal': { selector: { app: 'analytics' }, port: 8082 } } }, 'kubernetes-network-policy');
    expect(split.notes).toBeUndefined();
  });
});

describe('the network declaration (tinkerer, solo-app)', () => {
  it('network declare run again keeps the description, on the CLI and through the tool', async () => {
    await runNetworkDeclare({});
    expect(loadProjectConfig()!.network).toEqual({ description: 'The order platform' });
    mcpDeclare(true, null);
    expect(loadProjectConfig()!.network).toEqual({ description: 'The order platform' });
  });

  it('sdd_get_status names the declared network', () => {
    expect(statusNetworkLine()).toMatch(/^Network: declared \("The order platform"\)/);
    bind(path.join(dir, 'services', 'orders'));
    expect(statusNetworkLine()).toMatch(/^Network: none declared here — a network the enclosing family declares/);
  });
});
