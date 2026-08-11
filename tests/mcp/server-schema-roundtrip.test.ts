import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ---------------------------------------------------------------------------
// End-to-end MCP schema round-trip: the tool input schemas in src/mcp/server.ts
// are a HAND-MAINTAINED copy of the canonical zod schemas (src/models/specs.ts)
// — a field missing there is silently stripped at the tool boundary by the
// MCP-SDK's zod validation. This suite authors, through a real stdio client,
// specs exercising every newer input surface (labels + *Label jump twins,
// parallel fan-out + detach, durability, emits/subscribesTo, simPath, ext maps,
// lint.allow, invariants + assertsInvariants) and DEEP-EQUALs each field on
// read-back — so a schema-copy gap fails loudly instead of dropping data.
// It also pins the redefine carry-forward semantics of sdd_define_interface /
// sdd_write_narrative: what the input cannot express (spec-level lint/ext,
// endpoint bindings, omitted method ext, createdAt) survives a re-authoring,
// surfaced via a NOTICE, while expressed fields keep replace semantics.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const now = new Date().toISOString();

function unwrapText(result: any): string {
  expect(result.isError ?? false).toBe(false);
  const first = result.content?.[0];
  expect(first?.type).toBe('text');
  return first.text as string;
}

describe('MCP stdio server integration (newer input-surface round-trip)', () => {
  let projDir: string;
  let client: Client;

  const getSpec = async (kind: string, id: string): Promise<any> =>
    JSON.parse(unwrapText(await client.callTool({ name: 'sdd_get_spec', arguments: { kind, id } })));

  beforeAll(async () => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-mcp-rt-'));
    fs.mkdirSync(path.join(projDir, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.wai', 'project.yaml'), [
      "schemaVersion: '1.0.0'",
      'name: mcp-roundtrip',
      'targets:',
      '  - type: claude',
      '    outputDir: .claude/agents',
      '    enabled: true',
      `createdAt: '${now}'`,
      `updatedAt: '${now}'`,
    ].join('\n'));

    client = new Client({ name: 'wairon-rt-test', version: '0.0.1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX_CLI, WAIRON_CLI, 'mcp', 'serve'],
      cwd: projDir,
      stderr: 'ignore',
    });
    await client.connect(transport);

    unwrapText(await client.callTool({
      name: 'sdd_initialize_system',
      arguments: { name: 'RTSystem', vision: 'schema round-trip e2e', targetLanguage: 'typescript' },
    }));
    unwrapText(await client.callTool({
      name: 'sdd_add_subsystem',
      arguments: { id: 'ord', name: 'Ordering', description: 'Ordering bounded context' },
    }));
  }, 60_000);

  afterAll(async () => {
    try { await client?.close(); } catch { /* already gone */ }
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  it('round-trips component durability, emits/subscribesTo, ext, and update-set lint', async () => {
    unwrapText(await client.callTool({ name: 'sdd_add_component', arguments: {
      id: 'ord-store', name: 'Order Store', description: 'Holds orders',
      subsystem: 'ord', componentType: 'Store', durability: 'read-through',
    } }));
    unwrapText(await client.callTool({ name: 'sdd_add_component', arguments: {
      id: 'ord-orch', name: 'Order Orchestrator', description: 'Owns the fulfillment workflow',
      subsystem: 'ord', componentType: 'Orchestrator', dependsOn: ['ord-store'],
      emits: [{ topic: 'order.events', event: 'placed', description: 'Order placed fan-out' }],
    } }));
    unwrapText(await client.callTool({ name: 'sdd_add_component', arguments: {
      id: 'ord-events', name: 'Order Events Observer', description: 'Consumes order events',
      subsystem: 'ord', componentType: 'Observer',
      subscribesTo: [{ topic: 'order.events', event: 'placed' }],
      ext: { 'mypack:priority': 3, 'mypack:tags': ['audit', 'async'] },
    } }));

    const store = await getSpec('component', 'ord-store');
    expect(store.durability).toBe('read-through');

    const orch = await getSpec('component', 'ord-orch');
    expect(orch.emits).toEqual([{ topic: 'order.events', event: 'placed', description: 'Order placed fan-out' }]);

    const events = await getSpec('component', 'ord-events');
    expect(events.subscribesTo).toEqual([{ topic: 'order.events', event: 'placed' }]);
    expect(events.ext).toEqual({ 'mypack:priority': 3, 'mypack:tags': ['audit', 'async'] });

    // lint has no creation-time input by design — the documented authoring
    // path is sdd_update_spec; prove that path round-trips (and does not
    // clobber the creation-time ext).
    unwrapText(await client.callTool({ name: 'sdd_update_spec', arguments: {
      kind: 'component', id: 'ord-events',
      delta: { lint: { allow: [{ code: 'UNSOURCED_SUBSCRIPTION', reason: 'paired emitter lives in a sibling tree' }] } },
    } }));
    const relinted = await getSpec('component', 'ord-events');
    expect(relinted.lint).toEqual({ allow: [{ code: 'UNSOURCED_SUBSCRIPTION', reason: 'paired emitter lives in a sibling tree' }] });
    expect(relinted.ext).toEqual({ 'mypack:priority': 3, 'mypack:tags': ['audit', 'async'] });
  }, 120_000);

  it('round-trips interface method params, guarantees, effect, and method-level ext', async () => {
    unwrapText(await client.callTool({ name: 'sdd_define_interface', arguments: {
      id: 'iord-store', name: 'IOrderStore', description: 'Order store contract', component: 'ord-store',
      methods: [
        {
          name: 'put', description: 'Persist an order', signature: 'put(order: order): Promise<void>', returns: 'Promise<void>',
          params: [{ name: 'order', type: 'order', description: 'The order to persist' }],
          guarantees: ['idempotent'],
          effect: 'write',
          ext: { 'mypack:op': 'upsert' },
        },
        { name: 'get', description: 'Load an order', signature: 'get(id: string): Promise<order>', returns: 'Promise<order>', effect: 'read' },
      ],
    } }));

    const intf = await getSpec('interface', 'iord-store');
    expect(intf.methods).toEqual([
      {
        name: 'put', description: 'Persist an order', signature: 'put(order: order): Promise<void>', returns: 'Promise<void>',
        params: [{ name: 'order', type: 'order', description: 'The order to persist' }],
        guarantees: ['idempotent'],
        effect: 'write',
        ext: { 'mypack:op': 'upsert' },
      },
      { name: 'get', description: 'Load an order', signature: 'get(id: string): Promise<order>', returns: 'Promise<order>', effect: 'read' },
    ]);
  }, 120_000);

  it('round-trips type invariants and field identity markers', async () => {
    unwrapText(await client.callTool({ name: 'sdd_add_type', arguments: {
      kind: 'entity', id: 'order', name: 'Order', description: 'A placed order',
      subsystem: 'ord', componentClass: 'ord-store',
      fields: [
        { name: 'id', type: 'string', key: 'primary' },
        { name: 'customerId', type: 'string', key: 'foreign', references: 'customer.id' },
        { name: 'total', type: 'number' },
      ],
      invariants: [{ id: 'total-non-negative', description: 'total must be >= 0' }],
    } }));

    const t = await getSpec('type', 'order');
    expect(t.componentClass).toBe('ord-store');
    expect(t.invariants).toEqual([{ id: 'total-non-negative', description: 'total must be >= 0' }]);
    expect(t.fields).toEqual([
      { name: 'id', type: 'string', optional: false, key: 'primary' },
      { name: 'customerId', type: 'string', optional: false, key: 'foreign', references: 'customer.id' },
      { name: 'total', type: 'number', optional: false },
    ]);
  }, 120_000);

  it('round-trips L5 labels, *Label jump twins, parallel fan-out, detach, simPath, and method ext', async () => {
    unwrapText(await client.callTool({ name: 'sdd_define_interface', arguments: {
      id: 'iord-orch', name: 'IOrderOrchestrator', description: 'Fulfillment contract', component: 'ord-orch',
      methods: [{ name: 'fulfill', description: 'Fulfill an order', signature: 'fulfill(orderId: string): Promise<void>', returns: 'Promise<void>' }],
    } }));

    unwrapText(await client.callTool({ name: 'sdd_write_narrative', arguments: {
      id: 'ord-orch-impl', name: 'Order Orchestrator Impl', description: 'Fulfillment workflow', contract: 'iord-orch',
      sourcePath: 'src/ord/orchestrator.ts', simPath: 'tests/sim/ord.sim.ts',
      methods: [{
        name: 'fulfill',
        ext: { 'mypack:cost': 'low' },
        // stepNumbers omitted throughout: positions must default them; every
        // jump is expressed through its *Label twin, never a hand-counted number.
        narrative: [
          { label: 'start', description: 'Validate the order', type: 'local' },
          { description: 'Customer known?', type: 'branch', condition: 'customer is known', onTrueLabel: 'fanout', onFalseLabel: 'reject' },
          { label: 'fanout', description: 'Fan out side effects concurrently', type: 'parallel', endLabel: 'arm-audit', branches: [{ label: 'arm-notify', name: 'notify' }, { label: 'arm-audit', name: 'audit' }] },
          { label: 'arm-notify', description: 'Persist the order snapshot (fire-and-forget)', type: 'call', targetComponent: 'ord-store', targetMethod: 'put', detach: true, assertsGuarantees: ['idempotent'], assertsInvariants: ['order.total-non-negative'] },
          { label: 'arm-audit', description: 'Read the order back for the audit trail', type: 'call', targetComponent: 'ord-store', targetMethod: 'get' },
          { label: 'done', description: 'Fulfilled', type: 'return', outcome: 'success' },
          { label: 'reject', description: 'Log the rejection', type: 'local' },
          { description: 'Rejoin the success exit', type: 'jump', toLabel: 'done' },
        ],
      }],
    } }));

    const impl = await getSpec('implementation', 'ord-orch-impl');
    expect(impl.sourcePath).toBe('src/ord/orchestrator.ts');
    expect(impl.simPath).toBe('tests/sim/ord.sim.ts');
    // Stored narrative: numeric jump fields resolved from the labels, the
    // *Label twins gone, label anchors persisted, detach/asserts verbatim.
    expect(impl.methods).toEqual([{
      name: 'fulfill',
      ext: { 'mypack:cost': 'low' },
      narrative: [
        { stepNumber: 1, label: 'start', description: 'Validate the order', type: 'local' },
        { stepNumber: 2, description: 'Customer known?', type: 'branch', condition: 'customer is known', onTrueStep: 3, onFalseStep: 7 },
        { stepNumber: 3, label: 'fanout', description: 'Fan out side effects concurrently', type: 'parallel', endStep: 5, branches: [{ step: 4, name: 'notify' }, { step: 5, name: 'audit' }] },
        { stepNumber: 4, label: 'arm-notify', description: 'Persist the order snapshot (fire-and-forget)', type: 'call', targetComponent: 'ord-store', targetMethod: 'put', detach: true, assertsGuarantees: ['idempotent'], assertsInvariants: ['order.total-non-negative'] },
        { stepNumber: 5, label: 'arm-audit', description: 'Read the order back for the audit trail', type: 'call', targetComponent: 'ord-store', targetMethod: 'get' },
        { stepNumber: 6, label: 'done', description: 'Fulfilled', type: 'return', outcome: 'success' },
        { stepNumber: 7, label: 'reject', description: 'Log the rejection', type: 'local' },
        { stepNumber: 8, description: 'Rejoin the success exit', type: 'jump', toStep: 6 },
      ],
    }]);
  }, 120_000);

  it('rejects an unresolvable *Label reference without creating the spec', async () => {
    const res = await client.callTool({ name: 'sdd_write_narrative', arguments: {
      id: 'ord-bad-impl', name: 'Bad Impl', description: 'Never lands', contract: 'iord-orch',
      methods: [{ name: 'fulfill', narrative: [
        { description: 'Jump to nowhere', type: 'jump', toLabel: 'nowhere' },
      ] }],
    } });
    expect(res.isError).toBe(true);
    expect((res.content as any)[0].text).toContain('Unresolved narrative label references');

    const missing = await client.callTool({ name: 'sdd_get_spec', arguments: { kind: 'implementation', id: 'ord-bad-impl' } });
    expect(missing.isError).toBe(true);
  }, 120_000);

  it('round-trips an invokedBy method declaration and a register narrative step', async () => {
    unwrapText(await client.callTool({ name: 'sdd_add_component', arguments: {
      id: 'ord-worker', name: 'Order Worker', description: 'Periodic queue drain',
      subsystem: 'ord', componentType: 'Specialist', dependsOn: ['ord-store'],
    } }));
    unwrapText(await client.callTool({ name: 'sdd_define_interface', arguments: {
      id: 'iord-worker', name: 'IOrderWorker', description: 'Worker contract', component: 'ord-worker',
      methods: [{
        name: 'tick', description: 'Drain the pending order queue once', signature: 'tick(): Promise<void>', returns: 'Promise<void>',
        invokedBy: { kind: 'runtime', caller: 'The host scheduler fires this every 30 seconds once the service enters the running state.' },
      }],
    } }));

    const intf = await getSpec('interface', 'iord-worker');
    expect(intf.methods).toEqual([{
      name: 'tick', description: 'Drain the pending order queue once', signature: 'tick(): Promise<void>', returns: 'Promise<void>',
      invokedBy: { kind: 'runtime', caller: 'The host scheduler fires this every 30 seconds once the service enters the running state.' },
    }]);

    unwrapText(await client.callTool({ name: 'sdd_write_narrative', arguments: {
      id: 'ord-worker-impl', name: 'Order Worker Impl', description: 'Queue drain flow', contract: 'iord-worker',
      methods: [{ name: 'tick', narrative: [
        { description: 'Hand the persistence callback to the runtime timer', type: 'register', targetComponent: 'ord-store', targetMethod: 'put' },
        { description: 'Done', type: 'return', outcome: 'success' },
      ] }],
    } }));

    const impl = await getSpec('implementation', 'ord-worker-impl');
    expect(impl.methods[0].narrative).toEqual([
      { stepNumber: 1, description: 'Hand the persistence callback to the runtime timer', type: 'register', targetComponent: 'ord-store', targetMethod: 'put' },
      { stepNumber: 2, description: 'Done', type: 'return', outcome: 'success' },
    ]);
  }, 120_000);

  it('redefining an interface preserves lint, ext, endpoints, and method ext with a notice', async () => {
    unwrapText(await client.callTool({ name: 'sdd_add_component', arguments: {
      id: 'ord-portal', name: 'Order Portal', description: 'Inbound front door',
      subsystem: 'ord', componentType: 'Portal', portalType: 'HTTP_API', dependsOn: ['ord-orch'],
    } }));
    unwrapText(await client.callTool({ name: 'sdd_define_interface', arguments: {
      id: 'iord-portal', name: 'IOrderPortal', description: 'Portal contract', component: 'ord-portal',
      methods: [
        { name: 'charge', description: 'Charge a customer', signature: 'charge(customerId: string): Promise<void>', returns: 'Promise<void>' },
        { name: 'legacyPing', description: 'Health probe', signature: 'legacyPing(): Promise<void>', returns: 'Promise<void>' },
      ],
    } }));
    unwrapText(await client.callTool({ name: 'sdd_set_endpoints', arguments: {
      interface: 'iord-portal',
      endpoints: [
        { method: 'charge', transport: 'HTTP', httpMethod: 'POST', path: '/v1/charge' },
        { method: 'legacyPing', transport: 'HTTP', httpMethod: 'GET', path: '/v1/ping' },
      ],
    } }));
    // lint/ext arrive through the documented post-authoring path.
    unwrapText(await client.callTool({ name: 'sdd_update_spec', arguments: {
      kind: 'interface', id: 'iord-portal',
      delta: {
        lint: { allow: [{ code: 'UNUSED_METHOD', reason: 'consumed by an external tenant' }] },
        ext: { 'mypack:surface': 'public' },
        methods: [{ name: 'charge', ext: { 'mypack:rate-limit': 10 } }],
      },
    } }));
    const before = await getSpec('interface', 'iord-portal');
    expect(before.methods.find((m: any) => m.name === 'charge').ext).toEqual({ 'mypack:rate-limit': 10 });

    // The REDEFINE: charge persists (new description), refund is new, legacyPing is dropped.
    const out = unwrapText(await client.callTool({ name: 'sdd_define_interface', arguments: {
      id: 'iord-portal', name: 'IOrderPortal', description: 'Portal contract v2', component: 'ord-portal',
      methods: [
        { name: 'charge', description: 'Charge a customer v2', signature: 'charge(customerId: string): Promise<void>', returns: 'Promise<void>' },
        { name: 'refund', description: 'Refund a charge', signature: 'refund(chargeId: string): Promise<void>', returns: 'Promise<void>' },
      ],
    } }));
    expect(out).toContain('NOTICE');
    expect(out).toContain('Interface "iord-portal" already existed — re-authored in place; this input REPLACES what it expresses.');
    expect(out).toContain('Carried forward (not expressible through this tool): createdAt, endpoint (charge), ext (charge), lint, ext.');
    // The removal is STATED, not left for a validator warning to reveal later.
    expect(out).toContain('REMOVED by this restatement: method "legacyPing" (endpoint bindings included)');

    const after = await getSpec('interface', 'iord-portal');
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.description).toBe('Portal contract v2');                       // expressed fields keep replace semantics
    expect(after.lint).toEqual({ allow: [{ code: 'UNUSED_METHOD', reason: 'consumed by an external tenant' }] });
    expect(after.ext).toEqual({ 'mypack:surface': 'public' });
    expect(after.methods.map((m: any) => m.name)).toEqual(['charge', 'refund']); // dropped methods stay dropped
    const charge = after.methods[0];
    expect(charge.description).toBe('Charge a customer v2');
    expect(charge.endpoint).toEqual({ transport: 'HTTP', method: 'POST', path: '/v1/charge' });
    expect(charge.ext).toEqual({ 'mypack:rate-limit': 10 });
    const refund = after.methods[1];
    expect(refund.endpoint).toBeUndefined();                                     // carry-forward never invents bindings
    expect(refund.ext).toBeUndefined();
  }, 120_000);

  it('an explicitly supplied method ext replaces the carried-forward value', async () => {
    const out = unwrapText(await client.callTool({ name: 'sdd_define_interface', arguments: {
      id: 'iord-portal', name: 'IOrderPortal', description: 'Portal contract v3', component: 'ord-portal',
      methods: [
        { name: 'charge', description: 'Charge a customer v3', signature: 'charge(customerId: string): Promise<void>', returns: 'Promise<void>', ext: { 'mypack:rate-limit': 99 } },
      ],
    } }));
    expect(out).toContain('endpoint (charge)');
    expect(out).not.toContain('ext (charge)'); // the input expressed it — nothing was carried

    const after = await getSpec('interface', 'iord-portal');
    const charge = after.methods[0];
    expect(charge.ext).toEqual({ 'mypack:rate-limit': 99 });                     // replaced, not merged
    expect(charge.endpoint).toEqual({ transport: 'HTTP', method: 'POST', path: '/v1/charge' });
  }, 120_000);

  it('re-authoring a narrative preserves impl lint, ext, and method ext with a notice', async () => {
    unwrapText(await client.callTool({ name: 'sdd_update_spec', arguments: {
      kind: 'implementation', id: 'ord-orch-impl',
      delta: {
        lint: { allow: [{ code: 'CALL_STEP_UNREALIZED', reason: 'realized by generated glue' }] },
        ext: { 'mypack:wave': 1 },
      },
    } }));
    const before = await getSpec('implementation', 'ord-orch-impl');

    const out = unwrapText(await client.callTool({ name: 'sdd_write_narrative', arguments: {
      id: 'ord-orch-impl', name: 'Order Orchestrator Impl', description: 'Fulfillment workflow v2', contract: 'iord-orch',
      sourcePath: 'src/ord/orchestrator.ts', simPath: 'tests/sim/ord.sim.ts',
      methods: [{ name: 'fulfill', narrative: [
        { description: 'Validate the order', type: 'local' },
        { description: 'Done', type: 'return', outcome: 'success' },
      ] }],
    } }));
    expect(out).toContain('Implementation "ord-orch-impl" already existed — re-authored in place; this input REPLACES what it expresses.');
    expect(out).toContain('Carried forward (not expressible through this tool): createdAt, ext (fulfill), lint, ext.');

    const after = await getSpec('implementation', 'ord-orch-impl');
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.description).toBe('Fulfillment workflow v2');
    expect(after.lint).toEqual({ allow: [{ code: 'CALL_STEP_UNREALIZED', reason: 'realized by generated glue' }] });
    expect(after.ext).toEqual({ 'mypack:wave': 1 });
    expect(after.methods[0].ext).toEqual({ 'mypack:cost': 'low' });
    expect(after.methods[0].narrative).toEqual([                                 // the narrative itself is replace semantics
      { stepNumber: 1, description: 'Validate the order', type: 'local' },
      { stepNumber: 2, description: 'Done', type: 'return', outcome: 'success' },
    ]);
  }, 120_000);
});
