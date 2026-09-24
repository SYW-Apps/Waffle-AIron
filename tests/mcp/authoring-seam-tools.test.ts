/**
 * The MCP write tools, driven through the real server factory, now that every
 * one of them writes through the authoring seam.
 *
 * - The create tools answer with the seam's receipt, which carries the tests a
 *   re-authoring invalidated: sdd_define_interface dropping a method used to
 *   report none, while the same change through sdd_update_spec did.
 * - The three setters are gated deltas and answer with the change report, so a
 *   setter that changed nothing says so instead of restamping the file.
 * - sdd_delete_spec answers with the deletion, naming the tests of the methods
 *   it took away.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import { invalidateSpecCache, loadInterfaceSpec, loadSubsystemSpec } from '../../src/core/specs.js';
import { createMcpServer } from '../../src/mcp/server.js';

const now = new Date().toISOString();
let roots: string[] = [];
let clients: Client[] = [];

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: any };
const textOf = (result: ToolResult): string => result.content?.[0]?.text ?? '';

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'authoring-seam-tools-test', version: '0.0.1' });
  await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return client;
}

/** A bound project, optionally declaring test roots, with a client connected to it. */
async function bound(opts: { testRoots?: string[] } = {}): Promise<{ root: string; client: Client; call: (name: string, args: Record<string, unknown>) => Promise<ToolResult> }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-seam-tools-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: 'seam-tools', targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: opts.testRoots ? { conformance: { testRoots: opts.testRoots } } : {}, createdAt: now, updatedAt: now,
  });
  setProjectRoot(root);
  invalidateSpecCache();
  const client = await connect();
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { root, client, call };
}

/** L0 → subsystem → portal component → contract with two methods. */
async function seed(call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>): Promise<void> {
  const ok = (r: ToolResult): void => expect(r.isError ?? false, textOf(r)).toBe(false);
  ok(await call('sdd_initialize_system', { name: 'Shop', vision: 'sells things' }));
  ok(await call('sdd_add_subsystem', { id: 'shop', name: 'Shop', description: 'the shop' }));
  ok(await call('sdd_add_component', {
    id: 'shop_portal', name: 'Shop Portal', description: 'front door', subsystem: 'shop', componentType: 'Portal', portalType: 'HTTP_API',
  }));
  ok(await call('sdd_add_component', {
    id: 'shop_api', name: 'Shop API', description: 'second front door', subsystem: 'shop', componentType: 'Portal', portalType: 'HTTP_API',
  }));
  ok(await call('sdd_define_interface', {
    id: 'ishop_portal', name: 'IShopPortal', description: 'the front door contract', component: 'shop_portal',
    methods: [
      { name: 'pay', description: 'takes payment', signature: 'pay(): void', returns: 'void' },
      { name: 'refund', description: 'returns payment', signature: 'refund(): void', returns: 'void' },
    ],
  }));
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

afterEach(async () => {
  for (const client of clients) { try { await client.close(); } catch { /* already closed */ } }
  clients = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
  invalidateSpecCache();
});

describe('the create tools answer with the seam\'s receipt', () => {
  it('sdd_define_interface names the tests a restatement invalidated by dropping a method', async () => {
    const { root, call } = await bound({ testRoots: ['tests'] });
    await seed(call);
    write(root, 'tests/refund.test.ts', "import { refund } from '../src/shop.js';\nit('refunds', () => refund());");

    const result = await call('sdd_define_interface', {
      id: 'ishop_portal', name: 'IShopPortal', description: 'the front door contract', component: 'shop_portal',
      methods: [{ name: 'pay', description: 'takes payment', signature: 'pay(): void', returns: 'void' }],
    });
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent.testsToRevisit).toEqual([
      { method: 'refund', symbol: 'refund', imported: ['tests/refund.test.ts'], mentioned: [], indiscriminate: false },
    ]);
    expect(textOf(result)).toContain('\n\nTESTS TO REVISIT:\n- refund (searched as "refund")\n  imports it: tests/refund.test.ts');
    expect(textOf(result)).toContain('REMOVED by this restatement: method "refund" (endpoint bindings included)');
  });

  it('a missing parent is refused with the sentence the tool always gave', async () => {
    const { call } = await bound();
    const result = await call('sdd_add_subsystem', { id: 'shop', name: 'Shop', description: 'the shop' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: System spec must be initialized (sdd_initialize_system) first.');
  });
});

describe('sdd_set_endpoints — one gated delta, answered with the change report', () => {
  it('reports the binding it set, then that nothing changed when it is set again', async () => {
    const { call } = await bound();
    await seed(call);
    const args = { interface: 'ishop_portal', endpoints: [{ method: 'pay', transport: 'HTTP', httpMethod: 'POST', path: '/pay' }] };

    const first = await call('sdd_set_endpoints', args);
    expect(first.isError ?? false).toBe(false);
    expect(textOf(first).split('\n')[0]).toBe('Bound 1 endpoint(s) on "ishop_portal": pay→HTTP.');
    expect(first.structuredContent.written).toBe(true);
    expect(first.structuredContent.changes.map((c: { path: string }) => c.path).every((p: string) => p.startsWith('methods.pay.endpoint'))).toBe(true);
    invalidateSpecCache();
    expect(loadInterfaceSpec('ishop_portal')?.methods.find(m => m.name === 'pay')?.endpoint).toEqual({ transport: 'HTTP', method: 'POST', path: '/pay' });
    expect(loadInterfaceSpec('ishop_portal')?.methods.find(m => m.name === 'refund')?.endpoint).toBeUndefined();

    const again = await call('sdd_set_endpoints', args);
    expect(again.structuredContent.written).toBe(false);
    expect(again.structuredContent.changes).toEqual([]);
  });

  it('rebinding to another transport leaves nothing of the old address behind', async () => {
    const { call } = await bound();
    await seed(call);
    await call('sdd_set_endpoints', { interface: 'ishop_portal', endpoints: [{ method: 'pay', transport: 'HTTP', httpMethod: 'POST', path: '/pay' }] });
    const rebound = await call('sdd_set_endpoints', { interface: 'ishop_portal', endpoints: [{ method: 'pay', transport: 'CLI', command: 'shop pay' }] });
    expect(rebound.isError ?? false, textOf(rebound)).toBe(false);
    invalidateSpecCache();
    expect(loadInterfaceSpec('ishop_portal')?.methods.find(m => m.name === 'pay')?.endpoint).toEqual({ transport: 'CLI', command: 'shop pay' });
  });

  it('refuses a method the contract does not declare, before anything is written', async () => {
    const { call } = await bound();
    await seed(call);
    const result = await call('sdd_set_endpoints', { interface: 'ishop_portal', endpoints: [{ method: 'ship', transport: 'HTTP', httpMethod: 'POST', path: '/ship' }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Method "ship" not found on interface "ishop_portal"');
    invalidateSpecCache();
    expect(loadInterfaceSpec('ishop_portal')?.methods.map(m => m.name)).toEqual(['pay', 'refund']);
  });
});

describe('sdd_set_public_interfaces — a replacement through one gated delta', () => {
  const entry = (component: string, details = `/${component}`) => ({ type: 'REST', details, component });

  it('removes an entry the new list leaves out, and reports the change', async () => {
    const { call } = await bound();
    await seed(call);
    await call('sdd_set_public_interfaces', { subsystem: 'shop', publicInterfaces: [entry('shop_portal'), entry('shop_api')] });

    const result = await call('sdd_set_public_interfaces', { subsystem: 'shop', publicInterfaces: [entry('shop_api', '/v2')] });
    expect(result.isError ?? false, textOf(result)).toBe(false);
    expect(textOf(result).split('\n')[0]).toBe('Updated public interfaces for subsystem "shop" (1 entry).');
    expect(result.structuredContent.written).toBe(true);
    invalidateSpecCache();
    expect(loadSubsystemSpec('shop')?.publicInterfaces).toEqual([{ type: 'REST', details: '/v2', component: 'shop_api' }]);
  });

  it('reports no change for the list already stored', async () => {
    const { call } = await bound();
    await seed(call);
    const list = [entry('shop_portal'), entry('shop_api')];
    await call('sdd_set_public_interfaces', { subsystem: 'shop', publicInterfaces: list });
    const again = await call('sdd_set_public_interfaces', { subsystem: 'shop', publicInterfaces: list });
    expect(again.structuredContent.written).toBe(false);
    expect(again.structuredContent.changes).toEqual([]);
  });

  it('empties the list when handed none', async () => {
    const { call } = await bound();
    await seed(call);
    await call('sdd_set_public_interfaces', { subsystem: 'shop', publicInterfaces: [entry('shop_portal')] });
    const cleared = await call('sdd_set_public_interfaces', { subsystem: 'shop', publicInterfaces: [] });
    expect(cleared.isError ?? false, textOf(cleared)).toBe(false);
    invalidateSpecCache();
    expect(loadSubsystemSpec('shop')?.publicInterfaces).toEqual([]);
  });

  it('refuses a list naming one identity twice — the merge could not tell them apart', async () => {
    const { call } = await bound();
    await seed(call);
    const result = await call('sdd_set_public_interfaces', { subsystem: 'shop', publicInterfaces: [entry('shop_portal', '/a'), entry('shop_portal', '/b')] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('names "shop_portal" more than once');
  });

  it('refuses an unknown subsystem', async () => {
    const { call } = await bound();
    await seed(call);
    const result = await call('sdd_set_public_interfaces', { subsystem: 'nowhere', publicInterfaces: [] });
    expect(textOf(result)).toBe('Error: Subsystem "nowhere" does not exist.');
  });
});

describe('sdd_set_subsystem_project_path — a gated delta on the link only', () => {
  it('sets and clears the link, each answered with the change report', async () => {
    const { call } = await bound();
    await seed(call);
    const set = await call('sdd_set_subsystem_project_path', { subsystem: 'shop', projectPath: 'packages/shop' });
    expect(set.isError ?? false, textOf(set)).toBe(false);
    expect(textOf(set).split('\n')[0]).toBe('Updated projectPath for subsystem "shop" to: packages/shop');
    expect(set.structuredContent.changes).toEqual([expect.objectContaining({ path: 'projectPath', after: expect.stringContaining('packages/shop') })]);

    const cleared = await call('sdd_set_subsystem_project_path', { subsystem: 'shop' });
    expect(textOf(cleared).split('\n')[0]).toBe('Updated projectPath for subsystem "shop" to: none (cleared)');
    expect(cleared.structuredContent.written).toBe(true);
    invalidateSpecCache();
    expect(loadSubsystemSpec('shop')?.projectPath).toBeUndefined();
  });

  it('refuses an id no subsystem holds', async () => {
    const { call } = await bound();
    await seed(call);
    const result = await call('sdd_set_subsystem_project_path', { subsystem: 'nowhere', projectPath: 'x' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('"nowhere" does not exist');
  });
});

describe('sdd_delete_spec — the deletion as data', () => {
  it('names the tests of every method a deleted contract took away', async () => {
    const { root, call } = await bound({ testRoots: ['tests'] });
    await seed(call);
    write(root, 'tests/pay.test.ts', "import { pay } from '../src/shop.js';\nit('pays', () => pay());");

    const result = await call('sdd_delete_spec', { kind: 'interface', id: 'ishop_portal' });
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent).toEqual({
      kind: 'interface', id: 'ishop_portal', deleted: true,
      testsToRevisit: [{ method: 'pay', symbol: 'pay', imported: ['tests/pay.test.ts'], mentioned: [], indiscriminate: false }],
    });
    expect(textOf(result)).toBe(
      'Successfully deleted interface spec "ishop_portal".\n\nTESTS TO REVISIT:\n- pay (searched as "pay")\n  imports it: tests/pay.test.ts',
    );
  });

  it('keeps the sentence it always gave for a spec that was not there', async () => {
    const { call } = await bound();
    await seed(call);
    const result = await call('sdd_delete_spec', { kind: 'component', id: 'nowhere' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: Spec of kind "component" with ID "nowhere" could not be deleted (file may not exist).');
  });
});
