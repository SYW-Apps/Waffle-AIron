import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'path';
import {
  countCode,
  createTrialSandbox,
  readFile,
  transcript,
  writeFile,
  type TrialSandbox,
} from './trials-helpers';
import type { FixtureTree } from '../rules-matrix/harness';
import { platformFamily, PLATFORM_BINDINGS } from '../helpers/network-family';

// ---------------------------------------------------------------------------
// Platform-team trial journeys (platform, platform-r2, platform-r3 and the
// network half of tinkerer-r3): a team that declares a network, puts gateways
// in front of services, generates NetworkPolicy from the design, checks live
// traffic against it, and grows / renames projects. Each journey replays a
// probe the trial ran by hand on the BUILT CLI and asserts what the trial
// observed after the fix — exit code and the words a person reads.
// ---------------------------------------------------------------------------

const OUTSIDE_CALLER = 'Browsers of anyone holding a short link, over the public internet';

/** Give a materialized project an explicit id (the harness writes none). */
function setProjectId(dir: string, id: string): void {
  writeFile(dir, '.wai/project.yaml', `id: ${id}\n${readFile(dir, '.wai/project.yaml')}`);
}

/**
 * The tinkerer's linkshort, as one project: an analytics subsystem with a
 * public stats Portal (entered from outside) and an ingestion Portal only the
 * links subsystem's client calls over HTTP.
 */
function linkshort(): FixtureTree {
  return {
    system: { name: 'Linkshort', vision: 'A link shortener with an analytics service behind it.' },
    subsystems: [
      {
        id: 'analytics',
        publicInterfaces: [
          { component: 'reporting_portal', details: 'The public stats API.' },
          { component: 'ingestion_portal', details: 'The hit ingestion API.' },
        ],
      },
      { id: 'links' },
    ],
    components: [
      { id: 'reporting_portal', subsystem: 'analytics', componentType: 'Portal', transport: 'HTTP', invokedBy: { kind: 'entry', caller: OUTSIDE_CALLER } },
      { id: 'ingestion_portal', subsystem: 'analytics', componentType: 'Portal', transport: 'HTTP' },
      { id: 'hit_client', subsystem: 'links', componentType: 'Adapter', dependsOn: ['ingestion_portal'] },
    ],
    interfaces: [
      {
        id: 'ireporting_portal', component: 'reporting_portal', methods: [
          { name: 'getStats', endpoint: { transport: 'HTTP', method: 'GET', path: '/stats/{code}' } },
          { name: 'getTop', endpoint: { transport: 'HTTP', method: 'GET', path: '/stats' } },
        ],
      },
      { id: 'iingestion_portal', component: 'ingestion_portal', methods: [{ name: 'recordHit', endpoint: { transport: 'HTTP', method: 'POST', path: '/hits' } }] },
      { id: 'ihit_client', component: 'hit_client', methods: [{ name: 'reportHit', invokedBy: { kind: 'runtime', caller: 'The redirect handler, once per redirect it answers.' } }] },
    ],
    implementations: [{
      id: 'hit_client_impl', contract: 'ihit_client',
      lint: { allow: [{ code: 'MISSING_SOURCE_PATH', reason: 'design-only trial journey: no code is realized here' }] },
      methods: [{ name: 'reportHit', narrative: [{ stepNumber: 1, type: 'call', description: 'Record the hit.', targetComponent: 'ingestion_portal', targetMethod: 'recordHit' }] }],
    }],
  };
}

const LINKSHORT_BINDINGS = [
  'workloads:',
  '  analytics: { selector: { app: analytics }, port: 8081 }',
  '  links: { selector: { app: links } }',
  'outside:',
  '  - 10.0.0.0/8',
  '',
].join('\n');

describe('platform: the network lifecycle on a one-process project (declare → bypass → gateway → undeclare)', () => {
  let sb: TrialSandbox;
  let dir: string;
  const portalFile = '.wai/specs/components/reporting_portal.yaml';

  beforeAll(() => {
    sb = createTrialSandbox('platform-net');
    dir = sb.materialize('linkshort', linkshort());
    setProjectId(dir, 'linkshort');
    writeFile(dir, 'bindings.yaml', LINKSHORT_BINDINGS);
  });
  afterAll(async () => { await sb?.cleanup(); });

  it('the design validates clean before any network is declared (control)', async () => {
    const r = await sb.run(['validate', '--ci'], dir);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).not.toContain('GATEWAY_BYPASSED');
  });

  it('`network declare` writes the declaration itself and says the gate identity moves', async () => {
    const r = await sb.run(['network', 'declare', '--description', 'The linkshort cluster'], dir);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toContain('Declared this project\'s network');
    expect(r.all).toMatch(/part of the gate identity — re-lock/);
    expect(readFile(dir, '.wai/project.yaml')).toMatch(/network:[\s\S]*The linkshort cluster/);
  });

  it('validate: GATEWAY_BYPASSED once per Portal (not once per verb), with the one-process hint', async () => {
    const r = await sb.run(['validate'], dir);
    expect(r.code, transcript(r)).toBe(1);
    // solo-app-r3 MINOR: ten identical findings for two Portals — one per verb.
    expect(countCode(r.all, 'GATEWAY_BYPASSED'), transcript(r)).toBe(1);
    expect(r.all).toContain('Portal "reporting_portal" (2 verbs: "getStats", "getTop")');
    expect(r.all).toContain('mark "reporting_portal" variant: gateway');
  });

  it('`network flows` marks the refused rows REFUSED and exits non-zero on a design the gate refuses', async () => {
    const r = await sb.run(['network', 'flows', '--format', 'markdown'], dir);
    // platform-r3 MINOR: flows exited 0 while policy/why/check exited 1.
    expect(r.code, transcript(r)).toBe(1);
    expect(r.stdout).toContain('**The design fails the gate:** 2 row(s) marked REFUSED');
    expect(r.stdout.split('REFUSED: GATEWAY_BYPASSED').length - 1).toBe(2);
    // The modelled in-network call is still allowed — only the bypass is refused.
    expect(r.stdout).toMatch(/\| hit_client \| ingestion_portal\.recordHit \| HTTP \| POST \/hits \|[^\n]*\|\s+\|$/m);
  });

  it('`network why` answers a bypassing flow with exit 1: the design names it, the gate refuses it', async () => {
    const r = await sb.run(['network', 'why', 'outside', 'reporting_portal.getStats'], dir);
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toContain('outside may NOT reach reporting_portal.getStats: the design names the flow, but the gate refuses it');
  });

  it('`network policy` leaves the refused flows out (never admits the internet) and exits 1', async () => {
    const r = await sb.run(['network', 'policy', '--bindings', 'bindings.yaml'], dir);
    expect(r.code, transcript(r)).toBe(1);
    expect(r.stdout).toContain('# THE DESIGN FAILS THE GATE');
    expect(r.stdout).toContain('# REFUSED: outside -> reporting_portal.getStats (GET /stats/{code})');
    // platform-r2 MAJOR: the refused design wrote the outside block into the policy.
    expect(r.stdout).not.toContain('10.0.0.0/8');
    expect(r.stderr).toContain('The design fails the gate: the flows it refuses were left out of the policy');
  });

  it('`network check` files observed outside traffic to the bypassing Portal as disallowed', async () => {
    writeFile(dir, 'observed.csv', 'source,destination,transport,method,path\noutside,analytics,HTTP,GET,/stats/abc\nlinks,analytics,HTTP,POST,/hits\n');
    const r = await sb.run(['network', 'check', '--observed', 'observed.csv', '--bindings', 'bindings.yaml'], dir);
    expect(r.code, transcript(r)).toBe(1);
    expect(r.stdout).toMatch(/Disallowed flows \(1\)[^\n]*\n[^\n]*\n\s+outside -> analytics/);
    expect(r.stdout).toContain('Unexpected flows (0)');
    expect(r.stdout).toContain('Unknown verbs (0)');
  });

  it('marking the Portal a gateway clears the gate; why then answers through the gateway, exit 0', async () => {
    writeFile(dir, portalFile, `${readFile(dir, portalFile)}variant: gateway\n`);
    const v = await sb.run(['validate', '--ci'], dir);
    expect(v.code, transcript(v)).toBe(0);
    expect(v.all).not.toContain('GATEWAY_BYPASSED');

    const why = await sb.run(['network', 'why', 'outside', 'reporting_portal.getStats'], dir);
    expect(why.code, transcript(why)).toBe(0);
    expect(why.all).toContain('outside may reach reporting_portal.getStats');

    const flows = await sb.run(['network', 'flows', '--format', 'markdown'], dir);
    expect(flows.code, transcript(flows)).toBe(0);
    expect(flows.stdout).not.toContain('REFUSED');
  });

  it('`network declare` run again keeps the description', async () => {
    const r = await sb.run(['network', 'declare'], dir);
    expect(r.code, transcript(r)).toBe(0);
    expect(readFile(dir, '.wai/project.yaml')).toContain('The linkshort cluster');
  });

  it('`network undeclare` removes the declaration without a hand edit', async () => {
    const r = await sb.run(['network', 'undeclare'], dir);
    expect(r.code, transcript(r)).toBe(0);
    expect(readFile(dir, '.wai/project.yaml')).not.toMatch(/^network:/m);
    const v = await sb.run(['validate', '--ci'], dir);
    expect(v.code, transcript(v)).toBe(0);
  });
});

describe('platform: a policy over a workload whose verbs differ in reach (tinkerer-r3 MAJOR, L4 vs L7)', () => {
  let sb: TrialSandbox;
  let dir: string;

  beforeAll(() => {
    sb = createTrialSandbox('platform-mixed');
    dir = sb.materialize('linkshort', linkshort());
    setProjectId(dir, 'linkshort');
    writeFile(dir, 'bindings.yaml', LINKSHORT_BINDINGS);
  });
  afterAll(async () => { await sb?.cleanup(); });

  it('notes that the pod-level policy cannot separate the public verb from the in-network one, and names the Portal-level binding', async () => {
    const r = await sb.run(['network', 'policy', '--bindings', 'bindings.yaml'], dir);
    expect(r.code, transcript(r)).toBe(0);
    const note = 'workload "analytics" serves verbs that differ in who may reach them';
    expect(r.stdout).toContain(`# NOTE: ${note}`);
    expect(r.stdout).toContain('ingestion_portal.recordHit (from links)');
    expect(r.stdout).toContain('reporting_portal.getStats (from outside)');
    expect(r.stdout).toContain('workloads: { reporting_portal: { selector, port } }');
    expect(r.stderr).toContain(`NOTE: ${note}`);
  });

  it('control: binding the public Portal on its own gives it its own policy, and the note goes', async () => {
    writeFile(dir, 'split.yaml', `${LINKSHORT_BINDINGS}`.replace(
      'workloads:\n',
      'workloads:\n  reporting_portal: { selector: { app: analytics }, port: 8082 }\n',
    ));
    const r = await sb.run(['network', 'policy', '--bindings', 'split.yaml'], dir);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).not.toContain('serves verbs that differ in who may reach them');
    expect(r.stdout).toContain('wairon.dev/design-name: "reporting_portal"');
    // The ingestion pod no longer admits the internet; the public Portal's own policy does.
    const analytics = r.stdout.split('---').find((doc) => doc.includes('wairon.dev/design-name: "analytics"'))!;
    expect(analytics).toBeDefined();
    expect(analytics).not.toContain('10.0.0.0/8');
    const reporting = r.stdout.split('---').find((doc) => doc.includes('wairon.dev/design-name: "reporting_portal"'))!;
    expect(reporting).toContain('10.0.0.0/8');
  });
});

describe('platform: a family with a declared network — unbound names, member roots, a project rename', () => {
  let sb: TrialSandbox;
  let family: string;
  let renamed: string;

  beforeAll(() => {
    sb = createTrialSandbox('platform-family');
    family = sb.materialize('platform', platformFamily());
    writeFile(family, 'bindings.yaml', PLATFORM_BINDINGS);
    renamed = sb.materialize('platform-renamed', platformFamily());
    writeFile(renamed, 'bindings.yaml', PLATFORM_BINDINGS);
  });
  afterAll(async () => { await sb?.cleanup(); });

  it('`network policy` exits non-zero when names are unbound, naming each one (platform-r3 MAJOR)', async () => {
    writeFile(family, 'partial.yaml', 'workloads:\n  orders: { selector: { app: orders } }\n');
    const r = await sb.run(['network', 'policy', '--bindings', 'partial.yaml'], family);
    // Before: exit 0 with a policy that default-denies the unbound workloads in production.
    expect(r.code, transcript(r)).toBe(1);
    expect(r.stdout).toContain('# UNBOUND: billing, edge, network, outside');
    for (const name of ['billing', 'edge', 'network']) {
      expect(r.stderr).toContain(`unbound: ${name} — selected by the placeholder label wairon.dev/workload`);
    }
    expect(r.stderr).toContain('4 name(s) unbound: applied as-is, this policy denies their ingress by default');
  });

  it('control: the complete bindings file binds every name and exits 0', async () => {
    const r = await sb.run(['network', 'policy', '--bindings', 'bindings.yaml'], family);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).not.toMatch(/unbound/i);
    expect(r.stdout).not.toContain('wairon.dev/workload');
  });

  it('flows JSON names the root project, never "" (solo-app-r2/r3 MINOR)', async () => {
    const r = await sb.run(['network', 'flows'], family);
    expect(r.code, transcript(r)).toBe(0);
    const rows = JSON.parse(r.stdout) as { to: { component: string; project: string } }[];
    expect(rows.find((f) => f.to.component === 'api_gateway')!.to.project).toBe('platform');
    expect(rows.every((f) => f.to.project !== '')).toBe(true);
  });

  it('from a member\'s root, `network flows` answers the family\'s network — no ENTRY_SCOPE_UNBOUNDED (platform-r3 MINOR)', async () => {
    const member = path.join(family, 'services', 'orders');
    const r = await sb.run(['network', 'flows', '--format', 'markdown'], member);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toContain('project orders at');
    expect(r.all).toContain('"orders" is a member: this is its enclosing family\'s network, declared and proven at the family root');
    // Before: "no declared network encloses the root" + ENTRY_UNPROVEN on the verbs the family proves.
    expect(r.all).not.toContain('ENTRY_SCOPE_UNBOUNDED');
    expect(r.all).not.toMatch(/ENTRY_UNPROVEN[^\n]*orders_api\.create/);
    expect(r.stdout).toContain('| orders_client | orders::orders_api.create | HTTP | POST /orders |');
  });

  it('from a member\'s root, `network why` knows the family\'s parties (platform-r3 MINOR: "unknown party")', async () => {
    const member = path.join(family, 'services', 'orders');
    const r = await sb.run(['network', 'why', 'orders_client', 'orders::orders_api.create'], member);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toContain('orders_client may reach orders::orders_api.create');
    expect(r.all).not.toContain('unknown party');
  });

  it('`network why` answers a types-only subsystem as in-process, not as an unknown party (platform-r3 MINOR)', async () => {
    writeFile(family, '.wai/specs/subsystems/contracts.yaml', [
      'schemaVersion: 1.0.0', 'id: contracts', 'name: contracts', 'description: Shared value objects.', 'parentSystem: Platform',
      'createdAt: "2026-01-01T00:00:00.000Z"', 'updatedAt: "2026-01-01T00:00:00.000Z"', '',
    ].join('\n'));
    const r = await sb.run(['network', 'why', 'edge', 'contracts'], family);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).not.toContain('unknown party');
    expect(r.all).toMatch(/in-process/);
    // Negative control: a real typo is still an unknown party, exit 1.
    const typo = await sb.run(['network', 'why', 'edge', 'contractz'], family);
    expect(typo.code, transcript(typo)).toBe(1);
    expect(typo.all).toContain('unknown party');
  });

  it('`project rename --report` names the bindings keys the rename leaves behind, and writes nothing', async () => {
    const before = readFile(renamed, 'services/orders/.wai/project.yaml');
    const r = await sb.run(['project', 'rename', 'orders_svc', '--project', 'orders', '--report'], renamed);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toContain('id: orders → orders_svc (orders kept in previousIds)');
    // platform-r3 MAJOR: the plan said nothing about bindings / observed names.
    expect(r.all).toContain('rename the bindings keys "orders" and every "orders::…"');
    expect(r.all).toContain('resolve them through previousIds and print a NOTE naming each key');
    expect(r.all).toContain('Report only (--report): nothing was written.');
    expect(readFile(renamed, 'services/orders/.wai/project.yaml')).toBe(before);
  });

  it('after the rename, `network policy` still binds the workload by its former key, with a NOTE — never the placeholder', async () => {
    const apply = await sb.run(['project', 'rename', 'orders_svc', '--project', 'orders', '--yes'], renamed);
    expect(apply.code, transcript(apply)).toBe(0);
    expect(apply.all).toContain('Applied the rename migration');

    const r = await sb.run(['network', 'policy', '--bindings', 'bindings.yaml'], renamed);
    // Before: exit 0, `# UNBOUND: orders_svc`, the policy selecting wairon.dev/workload: orders_svc (default deny in prod).
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).not.toMatch(/unbound/i);
    expect(r.stdout).not.toContain('wairon.dev/workload');
    expect(r.stdout).toContain('# NOTE: bindings key "orders" names the renamed project "orders_svc" by its former name (kept in its previousIds): it still binds "orders_svc"');
    const ordersPolicy = r.stdout.split('---').find((doc) => doc.includes('wairon.dev/design-name: "orders_svc"'))!;
    expect(ordersPolicy).toContain('app.kubernetes.io/name: "orders"');
  });

  it('after the rename, `network check` matches telemetry still labelled with the former id, with a NOTE', async () => {
    writeFile(renamed, 'observed.csv', 'source,destination,transport,method,path\nedge,orders,HTTP,POST,/orders\n');
    const r = await sb.run(['network', 'check', '--observed', 'observed.csv', '--bindings', 'bindings.yaml'], renamed);
    // Before: the legitimate edge -> orders traffic was "unexpected".
    expect(r.code, transcript(r)).toBe(0);
    expect(r.stdout).toContain('Unexpected flows (0)');
    expect(r.stdout).toContain('Disallowed flows (0)');
    expect(r.all).toContain('"orders" names the renamed project "orders_svc" by its former name (kept in its previousIds): it was matched as "orders_svc"');
  });

  it('control: a flow from a source the design does not allow is still disallowed after the rename', async () => {
    writeFile(renamed, 'observed-bad.csv', 'source,destination,transport,method,path\nbilling,orders,HTTP,POST,/orders\n');
    const r = await sb.run(['network', 'check', '--observed', 'observed-bad.csv', '--bindings', 'bindings.yaml'], renamed);
    expect(r.code, transcript(r)).toBe(1);
    expect(r.stdout).toMatch(/Disallowed flows \(1\)[^\n]*\n[^\n]*\n\s+billing -> orders \[HTTP\] POST \/orders/);
  });
});

// ---------------------------------------------------------------------------
// Code conformance on a modelled cross-service hop (tinkerer-r3 MAJOR): an
// Adapter's dependsOn to a Portal with a network transport is realized by the
// wire, not by an import — the trial's assistant added a cross-service
// `import type` to silence UNREALIZED_DEPENDENCY.
// ---------------------------------------------------------------------------

const intent = (name: string): Record<string, unknown> => ({
  name, detail: 'intent', intent: 'Performs its one thing against held state; failures surface as thrown errors.',
});

function remoteHop(transport: 'HTTP' | 'InProcess'): FixtureTree {
  return {
    subsystems: [
      { id: 'analytics', publicInterfaces: [{ component: 'ingest_api', details: 'The hit ingestion API.' }] },
      { id: 'links' },
    ],
    components: [
      { id: 'ingest_api', subsystem: 'analytics', componentType: 'Portal', transport, invokedBy: { kind: 'entry', caller: 'Every service of the platform that reports hits, over its transport' } },
      { id: 'ingest_client', subsystem: 'links', componentType: 'Adapter', dependsOn: ['ingest_api'] },
    ],
    interfaces: [
      {
        id: 'iingest_api', component: 'ingest_api', methods: [{
          name: 'recordHit', signature: 'recordHit(id: string): string', returns: 'string',
          params: [{ name: 'id', type: 'string', description: 'The short code that was hit' }],
          ...(transport === 'HTTP' ? { endpoint: { transport: 'HTTP', method: 'POST', path: '/hits' } } : {}),
        }],
      },
      {
        id: 'iingest_client', component: 'ingest_client', methods: [{
          name: 'send', signature: 'send(id: string): async string', returns: 'async string',
          params: [{ name: 'id', type: 'string', description: 'The short code that was hit' }],
          invokedBy: { kind: 'runtime', caller: 'The redirect handler, once per redirect it answers.' },
        }],
      },
    ],
    implementations: [
      { id: 'ingest_api_impl', contract: 'iingest_api', sourcePath: 'src/analytics/ingest.ts', methods: [intent('recordHit')] },
      {
        id: 'ingest_client_impl', contract: 'iingest_client', sourcePath: 'src/links/client.ts',
        methods: [{ name: 'send', narrative: [{ stepNumber: 1, type: 'call', description: 'Record the hit.', targetComponent: 'ingest_api', targetMethod: 'recordHit' }] }],
      },
    ],
    files: {
      'src/analytics/ingest.ts': 'export function recordHit(id: string): string { return id; }\n',
      // The plain HTTP client: nothing imports the remote service's code.
      'src/links/client.ts': "export async function send(id: string): Promise<string> {\n  const r = await fetch('/hits', { method: 'POST', body: id });\n  return r.statusText;\n}\n",
    },
  };
}

describe('platform: an Adapter calling a remote Portal is realized by the wire, never UNREALIZED_DEPENDENCY', () => {
  let sb: TrialSandbox;
  beforeAll(() => { sb = createTrialSandbox('platform-hop'); });
  afterAll(async () => { await sb?.cleanup(); });

  it('an HTTP Portal: `validate --ci` passes with no cross-service import asked for', async () => {
    const dir = sb.materialize('http-hop', remoteHop('HTTP'));
    const r = await sb.run(['validate', '--ci'], dir);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).not.toContain('UNREALIZED_DEPENDENCY');
    expect(r.all).not.toContain('CALL_ORIGIN_UNRESOLVED');
    expect(r.all).toContain('All checks passed (CI mode');
  });

  it('control: the same edge to an in-process library is still owed an import', async () => {
    const dir = sb.materialize('inprocess-hop', remoteHop('InProcess'));
    const r = await sb.run(['validate', '--ci'], dir);
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toContain('[UNREALIZED_DEPENDENCY] Component "ingest_client" declares dependsOn "ingest_api", but no import');
  });
});

// ---------------------------------------------------------------------------
// UNCONSUMED_TOPIC sited at the topic (platform-r3 MINOR): after a promote the
// member's own gate reports the topics its family subscribes to; a lint.allow
// could only blanket the publisher, so a fourth topic was silently covered.
// ---------------------------------------------------------------------------

function publisher(allowAt: string[]): FixtureTree {
  return {
    subsystems: [{ id: 'payments' }],
    components: [{
      id: 'payment_publisher', componentType: 'Orchestrator',
      emits: [{ topic: 'payments.captured', event: 'captured' }, { topic: 'payments.refunded', event: 'refunded' }],
      ...(allowAt.length > 0 ? {
        lint: { allow: allowAt.map((at) => ({ code: 'UNCONSUMED_TOPIC', at, reason: 'consumed by the orders service of the platform family, paired by the family run' })) },
      } : {}),
    }],
    interfaces: [{
      id: 'ipayment_publisher', component: 'payment_publisher',
      methods: [{ name: 'publishCaptured', invokedBy: { kind: 'runtime', caller: 'The payment worker, once per captured payment.' } }],
    }],
    implementations: [{
      id: 'payment_publisher_impl', contract: 'ipayment_publisher',
      lint: { allow: [{ code: 'MISSING_SOURCE_PATH', reason: 'design-only trial journey: no code is realized here' }] },
      methods: [{ name: 'publishCaptured', narrative: [{ stepNumber: 1, type: 'local', description: 'Publish the captured event.' }] }],
    }],
  };
}

describe('platform: topic findings are sited at the topic, so a lint.allow covers one topic only', () => {
  let sb: TrialSandbox;
  beforeAll(() => { sb = createTrialSandbox('platform-topics'); });
  afterAll(async () => { await sb?.cleanup(); });

  it('control: with no allow, both topics are reported', async () => {
    const r = await sb.run(['validate'], sb.materialize('none', publisher([])));
    expect(r.code, transcript(r)).toBe(0);
    expect(countCode(r.all, 'UNCONSUMED_TOPIC'), transcript(r)).toBe(2);
  });

  it('an allow at one topic silences that topic only — a second topic still fires, and the allow is not unused', async () => {
    const r = await sb.run(['validate'], sb.materialize('one', publisher(['payments.captured'])));
    expect(r.code, transcript(r)).toBe(0);
    expect(countCode(r.all, 'UNCONSUMED_TOPIC'), transcript(r)).toBe(1);
    expect(r.all).toContain('emits topic "payments.refunded"');
    expect(r.all).not.toContain('emits topic "payments.captured"');
    expect(r.all).not.toContain('UNUSED_LINT_ALLOW');
  });

  it('one allow per topic leaves `validate --ci` green', async () => {
    const r = await sb.run(['validate', '--ci'], sb.materialize('both', publisher(['payments.captured', 'payments.refunded'])));
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).not.toContain('UNCONSUMED_TOPIC');
    expect(r.all).not.toContain('UNUSED_LINT_ALLOW');
  });
});

// ---------------------------------------------------------------------------
// Growing a networked design (platform-r2 MAJOR, re-checked platform-r3): a
// subsystem a client Adapter calls across the network becomes its own
// project. The callers left across the new boundary get a declared network
// entry — in the plan AND on disk — so the new project's own gate is not red
// on reachability, and the family still derives the same flow.
// ---------------------------------------------------------------------------

const DESIGN_ONLY = { lint: { allow: [{ code: 'MISSING_SOURCE_PATH', reason: 'design-only trial journey: no code is realized here' }] } };

function shop(): FixtureTree {
  return {
    system: { name: 'Shop', vision: 'An online shop: a gateway in front of checkout, payments behind it.' },
    subsystems: [
      { id: 'edge' },
      { id: 'payments', publicInterfaces: [{ component: 'psp_api', details: 'The payments API.' }] },
    ],
    components: [
      { id: 'shop_gateway', subsystem: 'edge', componentType: 'Portal', transport: 'HTTP', variant: 'gateway', dependsOn: ['checkout'], invokedBy: { kind: 'entry', caller: 'Browsers of the shop\'s customers, over the public internet' } },
      { id: 'checkout', subsystem: 'edge', componentType: 'Orchestrator', dependsOn: ['payments_client'] },
      { id: 'payments_client', subsystem: 'edge', componentType: 'Adapter', dependsOn: ['psp_api'] },
      { id: 'psp_api', subsystem: 'payments', componentType: 'Portal', transport: 'HTTP' },
    ],
    interfaces: [
      { id: 'ishop_gateway', component: 'shop_gateway', methods: [{ name: 'placeOrder', endpoint: { transport: 'HTTP', method: 'POST', path: '/orders' } }] },
      { id: 'icheckout', component: 'checkout', methods: [{ name: 'place' }] },
      { id: 'ipayments_client', component: 'payments_client', methods: [{ name: 'charge' }] },
      { id: 'ipsp_api', component: 'psp_api', methods: [{ name: 'createPayment', endpoint: { transport: 'HTTP', method: 'POST', path: '/payments' } }] },
    ],
    implementations: [
      { id: 'shop_gateway_impl', contract: 'ishop_gateway', ...DESIGN_ONLY, methods: [{ name: 'placeOrder', narrative: [{ stepNumber: 1, type: 'call', description: 'Place it.', targetComponent: 'checkout', targetMethod: 'place' }] }] },
      { id: 'checkout_impl', contract: 'icheckout', ...DESIGN_ONLY, methods: [{ name: 'place', narrative: [{ stepNumber: 1, type: 'call', description: 'Charge it.', targetComponent: 'payments_client', targetMethod: 'charge' }] }] },
      { id: 'payments_client_impl', contract: 'ipayments_client', ...DESIGN_ONLY, methods: [{ name: 'charge', narrative: [{ stepNumber: 1, type: 'call', description: 'Create the payment.', targetComponent: 'psp_api', targetMethod: 'createPayment' }] }] },
      { id: 'psp_api_impl', contract: 'ipsp_api', ...DESIGN_ONLY, methods: [{ name: 'createPayment', narrative: [{ stepNumber: 1, type: 'local', description: 'Record the payment.' }] }] },
    ],
  };
}

describe('platform: externalize --as project in a declared network declares the entries the new boundary needs', () => {
  let sb: TrialSandbox;
  let dir: string;
  let member: string;

  beforeAll(() => {
    sb = createTrialSandbox('platform-promote');
    dir = sb.materialize('shop', shop());
    writeFile(dir, '.wai/project.yaml', `id: shop\nnetwork:\n  description: The shop cluster\n${readFile(dir, '.wai/project.yaml')}`);
    member = path.join(dir, 'services', 'payments');
  });
  afterAll(async () => { await sb?.cleanup(); });

  it('control: the networked design validates clean before the move', async () => {
    const r = await sb.run(['validate', '--ci'], dir);
    expect(r.code, transcript(r)).toBe(0);
  });

  it('the plan names the entry it declares for the caller left across the boundary', async () => {
    const r = await sb.run(['subsystem', 'externalize', 'payments', '--path', 'services/payments', '--as', 'project', '--yes'], dir);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toContain('reference: payments_client (component): psp_api → payments::psp_api');
    expect(r.all).toContain('entry declared for the callers left across the boundary — psp_api.createPayment: entry (network) — called by payments_client of shop');
    expect(r.all).toContain('Applied the externalize migration');
    const contract = readFile(member, '.wai/specs/interfaces/ipsp_api.yaml');
    expect(contract).toMatch(/kind: entry/);
    expect(contract).toMatch(/scope: network/);
  });

  it('the new project\'s own gate is green, and says its network proofs are judged at the family root', async () => {
    const r = await sb.run(['validate', '--ci'], member);
    // platform-r2: 8 × UNUSED_COMPONENT + ENTRY findings in the new project's own --ci.
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toContain('project payments at');
    expect(r.all).toContain('its network proofs are judged at the family root');
    expect(r.all).not.toMatch(/UNUSED_COMPONENT|UNUSED_METHOD|ENTRY_UNPROVEN|ENTRY_SCOPE_UNBOUNDED/);
  });

  it('the family run is error-free and still derives the same cross-network call', async () => {
    const v = await sb.run(['validate'], dir);
    expect(v.code, transcript(v)).toBe(0);
    expect(v.all).toContain('payments — ok: 0 error(s)');
    const flows = await sb.run(['network', 'flows', '--format', 'markdown'], dir);
    expect(flows.code, transcript(flows)).toBe(0);
    expect(flows.stdout).toContain('| payments_client | payments::psp_api.createPayment | HTTP | POST /payments |');
    expect(flows.stdout).not.toContain('REFUSED');
  });
});
