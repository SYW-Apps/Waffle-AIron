/**
 * Every tool that declares an outputSchema, exercised once through the REAL MCP
 * SDK client — listTools FIRST.
 *
 * The SDK client compiles a validator per advertised outputSchema when listTools
 * runs, and rejects an answer whose structuredContent does not fit. A client that
 * never lists tools first (what most of this suite does) skips that check, so a
 * schema that drifted from the shape the handler sends only shows up in the field:
 * `projects[].codeReading` (sent by a family run) and `olderServer` (sent by both
 * the status and the validate answer) were such drifts.
 *
 * The sweep builds a small project with a family (a project member and a part),
 * an external whose producer is a sibling checkout, and a project newer than this
 * server (the olderServer path), then calls every tool the server advertises with
 * an outputSchema at least once. The last test fails when a tool is advertised
 * that the sweep never called, so a new structured tool cannot be forgotten.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { provisionProject } from '../../src/core/provision.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { governanceMachine, bindRoot, writeSubsystem, writeComponent } from '../helpers/governance-fixture.js';

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: any };

let parent: string;
let root: string;
let producer: string;
let client: Client;
const called = new Set<string>();

/** One call. An answer that fits no declared schema makes the SDK client throw, which fails the test. */
async function call(name: string, args: Record<string, unknown> = {}, expectError = false): Promise<ToolResult> {
  called.add(name);
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = result.content?.[0]?.text ?? '';
  expect(result.isError ?? false, `${name} ${JSON.stringify(args)}: ${text}`).toBe(expectError);
  if (!expectError) expect(result.structuredContent, `${name} answered no structuredContent`).toBeDefined();
  return result;
}

beforeAll(async () => {
  parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-sweep-')));
  root = path.join(parent, 'shop');
  producer = path.join(parent, 'producer');
  for (const dir of [root, producer]) fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  setProjectRoot(producer);
  invalidateSpecCache();
  provisionProject('Producer');
  setProjectRoot(root);
  invalidateSpecCache();
  provisionProject('Shop');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'output-schema-sweep', version: '0.0.1' });
  await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);
  // The point of the whole file: the SDK compiles its validators here, before any call.
  await client.listTools();
}, 60_000);

afterAll(async () => {
  try { await client?.close(); } catch { /* already gone */ }
  setProjectRoot(null);
  invalidateSpecCache();
  try { fs.rmSync(parent, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

describe('every structured answer fits its advertised outputSchema', () => {
  it('designs a small system through the authoring tools', async () => {
    await call('sdd_initialize_system', { name: 'Shop', vision: 'sells things', targetLanguage: 'typescript' });
    await call('sdd_add_subsystem', { id: 'orders', name: 'Orders', description: 'The orders bounded context' });
    await call('sdd_add_group', { id: 'money', name: 'Money', description: 'Money types' });
    await call('sdd_add_type', {
      kind: 'value-object', id: 'amount', name: 'Amount', description: 'An amount', group: 'money',
      fields: [{ name: 'cents', type: 'int', description: 'cents' }],
    });
    await call('sdd_add_component', {
      id: 'order_portal', name: 'OrderPortal', description: 'The orders entry', subsystem: 'orders', componentType: 'Portal', transport: 'HTTP',
    });
    await call('sdd_add_component', {
      id: 'order_flow', name: 'OrderFlow', description: 'Runs the order workflow', subsystem: 'orders', componentType: 'Orchestrator',
    });
    await call('sdd_define_interface', {
      id: 'iorder_flow', name: 'IOrderFlow', description: 'The order workflow contract', component: 'order_flow',
      methods: [{
        name: 'place', description: 'Places an order', returns: 'void',
        params: [{ name: 'customer', type: 'string', description: 'who orders' }],
      }],
    });
    await call('sdd_define_interface', {
      id: 'iorder_portal', name: 'IOrderPortal', description: 'The orders entry contract', component: 'order_portal',
      methods: [{ name: 'submit', description: 'Submits an order', returns: 'void', params: [{ name: 'customer', type: 'string', description: 'who orders' }] }],
    });
    await call('sdd_set_endpoints', {
      interface: 'iorder_portal', endpoints: [{ method: 'submit', transport: 'HTTP', httpMethod: 'POST', path: '/orders' }],
    });
    await call('sdd_write_narrative', {
      id: 'order_flow_impl', name: 'OrderFlowImpl', description: 'Implements the order workflow', contract: 'iorder_flow',
      methods: [{ name: 'place', narrative: [{ description: 'Record the order', type: 'local' }] }],
    });
    await call('sdd_update_spec', { kind: 'component', id: 'order_portal', delta: { dependsOn: ['order_flow'] } });
    await call('sdd_write_narrative', {
      id: 'order_portal_impl', name: 'OrderPortalImpl', description: 'Implements the orders entry', contract: 'iorder_portal',
      methods: [{ name: 'submit', narrative: [{ description: 'Hand the order to the workflow', type: 'call', targetComponent: 'order_flow', targetMethod: 'place' }] }],
    });
    await call('sdd_set_public_interfaces', {
      subsystem: 'orders', publicInterfaces: [{ details: 'the orders API', component: 'order_portal' }],
    });
    await call('sdd_update_spec', { kind: 'component', id: 'order_flow', delta: { description: 'Runs the order workflow, precisely' } });
    // A signature change names its callers (callersToReview rides the same schema).
    const dry = await call('sdd_update_spec', {
      kind: 'interface', id: 'iorder_flow', dryRun: true,
      delta: { methods: [{ name: 'place', params: [{ name: 'customer', type: 'string', description: 'who orders' }, { name: 'note', type: 'string', description: 'a note', optional: true }] }] },
    });
    const text = dry.content?.[0]?.text ?? '';
    expect(text).toContain('CALLERS TO REVIEW:');
    expect(text).toContain('- order_flow.place (added parameter "note" (optional)): order_portal.submit');
    expect(dry.structuredContent.callersToReview[0]).toMatchObject({ method: 'order_flow.place', callers: ['order_portal.submit'], total: 1 });
    await call('sdd_get_spec', { kind: 'component', id: 'order_flow' });
  });

  it('reads and looks things up', async () => {
    await call('sdd_get_status', {});
    await call('sdd_validate_tree', {});
    await call('sdd_search_specs', { query: 'order_flow' });
    await call('sdd_find_references', { target: 'order_flow' });
    await call('sdd_get_network_flows', {});
    await call('sdd_explain_flow', { from: 'outside', to: 'order_portal' });
    await call('sdd_set_network', { declared: true, description: 'the shop network' });
    await call('sdd_set_network', { declared: false });
  });

  it('answers a family run (a project member and a part) with codeReading on each project line', async () => {
    await call('sdd_add_member', { alias: 'payments', source: 'services/payments', description: 'Payments', as: 'project' });
    await call('sdd_add_member', { alias: 'tools', source: 'services/tools', description: 'Tools' });
    const validated = await call('sdd_validate_tree', {});
    const projects = validated.structuredContent.projects as { key: string; codeReading?: string }[] | undefined;
    expect(projects, 'a family run lists its projects').toBeDefined();
    expect(projects!.some((p) => typeof p.codeReading === 'string' && p.codeReading.length > 0)).toBe(true);
  });

  it('declares, pins, updates, lists and removes an external of a sibling producer', async () => {
    await call('sdd_add_external', { alias: 'producer', source: '../producer', pin: false });
    await call('sdd_update_external', { alias: 'producer', addUse: ['*'], dryRun: true });
    await call('sdd_update_external', { alias: 'producer', removeUse: ['*'], dryRun: true });
    await call('sdd_pin_externals', {});
    await call('sdd_get_externals_status', {});
    await call('sdd_list_consumers', {});
    await call('sdd_list_consumers', { search: [parent] });
    // The public-surface changelog reads git history: a committed work tree is its precondition.
    const git = (...args: string[]): void => { execFileSync('git', ['-C', root, '-c', 'user.name=sweep', '-c', 'user.email=sweep@example.invalid', ...args], { stdio: 'ignore' }); };
    git('init');
    git('add', '-A');
    git('commit', '-m', 'sweep', '--no-gpg-sign');
    await call('sdd_surface_diff', { against: 'HEAD' });
    await call('sdd_remove_external', { alias: 'producer' });
  });

  it('carries olderServer on the status and validate answers when the project is newer than this server', async () => {
    // A guide stamped by a newer wairon marks the project as written by one (a lock record would need a real approval).
    const guide = path.join(root, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(guide), { recursive: true });
    fs.writeFileSync(guide, '<!-- wairon-version: 99.0.0 -->');
    try {
      const status = await call('sdd_get_status', {});
      expect(status.structuredContent.olderServer).toBeTypeOf('string');
      const validated = await call('sdd_validate_tree', {});
      expect(validated.structuredContent.olderServer).toBeTypeOf('string');
    } finally {
      fs.rmSync(guide, { force: true });
    }
  });

  it('measures a pack against a project that can resolve one', async () => {
    const machine = governanceMachine();
    try {
      machine.install('1.2.0');
      const dir = machine.project('shop');
      writeSubsystem(dir, 'core');
      writeComponent(dir, 'core', 'engine');
      bindRoot(dir);
      const impact = await call('sdd_pack_impact', { pack: 'acme-base' });
      expect(impact.structuredContent.pack).toBe('acme-base');
    } finally {
      machine.cleanup();
      setProjectRoot(root);
      invalidateSpecCache();
    }
  });

  it('deletes a spec', async () => {
    await call('sdd_delete_spec', { kind: 'type', id: 'amount', dryRun: true });
    await call('sdd_delete_spec', { kind: 'type', id: 'amount' });
  });

  it('left no advertised structured tool uncalled', async () => {
    const { tools } = await client.listTools();
    const structured = tools.filter((t: any) => t.outputSchema).map((t: any) => t.name as string);
    expect(structured.length).toBeGreaterThan(20);
    const missed = structured.filter((name) => !called.has(name));
    expect(missed, `tools with an outputSchema the sweep never called: ${missed.join(', ')}`).toEqual([]);
  });
});
