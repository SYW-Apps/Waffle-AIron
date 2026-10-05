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
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
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
    // A transport follows the Portal's portalType: retype the Portal, then rebind.
    await call('sdd_update_spec', { kind: 'component', id: 'shop_portal', delta: { portalType: 'CLI' } });
    const rebound = await call('sdd_set_endpoints', { interface: 'ishop_portal', endpoints: [{ method: 'pay', transport: 'CLI', command: 'shop pay' }] });
    expect(rebound.isError ?? false, textOf(rebound)).toBe(false);
    invalidateSpecCache();
    expect(loadInterfaceSpec('ishop_portal')?.methods.find(m => m.name === 'pay')?.endpoint).toEqual({ transport: 'CLI', command: 'shop pay' });
  });

  it('takes the portalType spelling of a transport and stores the endpoint\'s (HTTP_API is HTTP)', async () => {
    const { call } = await bound();
    await seed(call);
    const result = await call('sdd_set_endpoints', { interface: 'ishop_portal', endpoints: [{ method: 'pay', transport: 'HTTP_API', httpMethod: 'POST', path: '/pay' }] });
    expect(result.isError ?? false, textOf(result)).toBe(false);
    expect(textOf(result)).toContain('pay→HTTP');
    invalidateSpecCache();
    expect(loadInterfaceSpec('ishop_portal')?.methods.find(m => m.name === 'pay')?.endpoint).toEqual({ transport: 'HTTP', method: 'POST', path: '/pay' });
  });

  it('refuses a transport the Portal\'s portalType does not imply, naming the one it does, before anything is written', async () => {
    const { call } = await bound();
    await seed(call);
    const result = await call('sdd_set_endpoints', { interface: 'ishop_portal', endpoints: [{ method: 'pay', transport: 'CLI', command: 'shop pay' }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('transport "CLI" does not match shop_portal\'s portalType HTTP_API, which implies transport "HTTP"');
    invalidateSpecCache();
    expect(loadInterfaceSpec('ishop_portal')?.methods.find(m => m.name === 'pay')?.endpoint).toBeUndefined();
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

  it('refuses a list naming one identity twice — a genuine duplicate the merge would fold into one', async () => {
    const { call } = await bound();
    await seed(call);
    const bound2 = await call('sdd_set_public_interfaces', { subsystem: 'shop', publicInterfaces: [entry('shop_portal', '/a'), entry('shop_portal', '/b')] });
    expect(bound2.isError).toBe(true);
    expect(textOf(bound2)).toContain('names "shop_portal" more than once');
    const unbound2 = await call('sdd_set_public_interfaces', { subsystem: 'shop', publicInterfaces: [{ type: 'REST', details: '/a' }, { type: 'REST', details: '/a' }] });
    expect(unbound2.isError).toBe(true);
    expect(textOf(unbound2)).toContain('names "REST /a" more than once');
  });

  it('accepts two unbound surfaces and round-trips them — the design-first state before components exist', async () => {
    const { call } = await bound();
    await seed(call);
    const unbound = [{ type: 'REST', details: '/api' }, { type: 'MessageBus', details: 'orders.created' }];
    const set = await call('sdd_set_public_interfaces', { subsystem: 'shop', publicInterfaces: unbound });
    expect(set.isError ?? false, textOf(set)).toBe(false);
    invalidateSpecCache();
    expect(loadSubsystemSpec('shop')?.publicInterfaces).toEqual(unbound);

    const again = await call('sdd_set_public_interfaces', { subsystem: 'shop', publicInterfaces: unbound });
    expect(again.structuredContent.written).toBe(false);

    // Binding one of them replaces it: the unbound REST entry is gone, the bound one is added.
    const boundNow = [{ type: 'REST', details: '/api', component: 'shop_portal' }, unbound[1]];
    const binding = await call('sdd_set_public_interfaces', { subsystem: 'shop', publicInterfaces: boundNow });
    expect(binding.isError ?? false, textOf(binding)).toBe(false);
    expect(binding.structuredContent.changes.map((c: { path: string; change: string }) => `${c.change} ${c.path}`).sort()).toEqual([
      'added publicInterfaces.shop_portal',
      'removed publicInterfaces.REST /api',
    ]);
    invalidateSpecCache();
    expect(loadSubsystemSpec('shop')?.publicInterfaces).toEqual([unbound[1], boundNow[0]]);
  });

  it('refuses an unknown subsystem', async () => {
    const { call } = await bound();
    await seed(call);
    const result = await call('sdd_set_public_interfaces', { subsystem: 'nowhere', publicInterfaces: [] });
    expect(textOf(result)).toBe('Error: Subsystem "nowhere" does not exist.');
  });
});

describe('sdd_add_subsystem — a subsystem is never a mount', () => {
  it('refuses a projectPath, naming sdd_add_member, and writes nothing', async () => {
    const { root, call } = await bound();
    await seed(call);
    const result = await call('sdd_add_subsystem', { id: 'billing', name: 'Billing', description: 'd', projectPath: 'packages/billing' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Error: mount form refused: subsystem "billing".*sdd_add_member/);
    invalidateSpecCache();
    expect(loadSubsystemSpec('billing')).toBeNull();
    expect(fs.existsSync(path.join(root, 'packages', 'billing'))).toBe(false);
  });
});

describe('the member tools — sdd_add_member, sdd_move_member, sdd_internalize_member', () => {
  /** The bound project's `members`, as project.yaml holds them. */
  const members = (root: string): unknown => (readYamlFile(path.join(root, '.wai', 'project.yaml')) as { members?: unknown }).members;

  it('adds a member (project scaffolded, declared in `members`), moves it, and refuses what they must', async () => {
    const { root, call } = await bound();
    await seed(call);

    const added = await call('sdd_add_member', { alias: 'billing', source: 'packages/billing', description: 'Invoices', as: 'project' });
    expect(added.isError ?? false, textOf(added)).toBe(false);
    expect(textOf(added)).toContain('Added the project "billing" at packages/billing');
    expect(members(root)).toEqual({ billing: { source: 'packages/billing', description: 'Invoices' } });
    expect(fs.existsSync(path.join(root, 'packages', 'billing', '.wai', 'project.yaml'))).toBe(true);
    invalidateSpecCache();
    expect(loadSubsystemSpec('billing')).toBeNull();

    const moved = await call('sdd_move_member', { alias: 'billing', newPath: 'services/billing' });
    expect(moved.isError ?? false, textOf(moved)).toBe(false);
    expect(members(root)).toEqual({ billing: { source: 'services/billing', description: 'Invoices' } });
    expect(fs.existsSync(path.join(root, 'services', 'billing', '.wai', 'project.yaml'))).toBe(true);

    const bad = await call('sdd_add_member', { alias: 'Bad Alias', source: 'x' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/^Error: .*an alias and a path are required/);
    const ghost = await call('sdd_move_member', { alias: 'ghost', newPath: 'x' });
    expect(ghost.isError).toBe(true);
    expect(textOf(ghost)).toMatch(/^Error: .*no member is declared under that alias/);
  });

  it('internalizes a member (a dry run first writes nothing), and refuses one whose pack has no adopt-or-drop answer', async () => {
    const { root, call } = await bound();
    await seed(call);
    // The subsystem out and back in: externalize writes a `members` member.
    const out = await call('sdd_externalize_subsystem', { subsystem: 'shop', path: 'packages/shop', as: 'project' });
    expect(out.isError ?? false, textOf(out)).toBe(false);
    expect(members(root)).toEqual({ shop: 'packages/shop' });

    const dry = await call('sdd_internalize_member', { alias: 'shop', dryRun: true });
    expect(dry.isError ?? false, textOf(dry)).toBe(false);
    expect(JSON.parse(textOf(dry))).toMatchObject({ dryRun: true, applied: false, plan: { verb: 'internalize', refusals: [] } });
    expect(members(root)).toEqual({ shop: 'packages/shop' });
    const back = await call('sdd_internalize_member', { alias: 'shop' });
    expect(back.isError ?? false, textOf(back)).toBe(false);
    expect(JSON.parse(textOf(back))).toMatchObject({ dryRun: false, applied: true });
    expect(members(root)).toBeUndefined();
    invalidateSpecCache();
    expect(loadSubsystemSpec('shop')?.id).toBe('shop');
    expect(fs.existsSync(path.join(root, 'packages', 'shop', '.wai'))).toBe(false);

    // A member selecting a pack this project does not, with no adopt-or-drop answer, is refused as a tool error.
    expect((await call('sdd_add_member', { alias: 'ledger', source: 'packages/ledger', as: 'project' })).isError ?? false).toBe(false);
    const ledgerConfig = path.join(root, 'packages', 'ledger', '.wai', 'project.yaml');
    writeYamlFile(ledgerConfig, { ...(readYamlFile(ledgerConfig) as object), extensions: { packs: [{ name: 'acme-rules', version: '1.0.0' }], useGlobalPacks: false } });
    const refused = await call('sdd_internalize_member', { alias: 'ledger' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^Error: the internalize migration is refused; nothing was written\./);
    expect(textOf(refused)).toMatch(/internalize-refused[\s\S]*selects the pack acme-rules@1\.0\.0/);
    expect(members(root)).toEqual({ ledger: 'packages/ledger' });
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

describe('sdd_get_spec — the kind inferred from the id when it is omitted', () => {
  it('reads the one spec an id names, answering with the kind it inferred', async () => {
    const { call } = await bound();
    await seed(call);
    const result = await call('sdd_get_spec', { id: 'ishop_portal' });
    expect(result.isError ?? false, textOf(result)).toBe(false);
    expect(result.structuredContent.kind).toBe('interface');
    expect(result.structuredContent.spec.component).toBe('shop_portal');
    const system = await call('sdd_get_spec', { id: 'system' });
    expect(system.structuredContent.kind).toBe('system');
  });

  it('refuses an id that names specs of more than one kind, naming the candidates', async () => {
    const { call } = await bound();
    await seed(call);
    const ok = await call('sdd_add_component', { id: 'shop', name: 'Shop Desk', description: 'a component named like its subsystem', subsystem: 'shop', componentType: 'Orchestrator' });
    expect(ok.isError ?? false, textOf(ok)).toBe(false);
    const result = await call('sdd_get_spec', { id: 'shop' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('The ID "shop" names specs of more than one kind (subsystem, component). Pass "kind" to choose one.');
    const chosen = await call('sdd_get_spec', { kind: 'component', id: 'shop' });
    expect(chosen.structuredContent.spec.name).toBe('Shop Desk');
  });

  it('refuses an id no spec has', async () => {
    const { call } = await bound();
    await seed(call);
    const result = await call('sdd_get_spec', { id: 'nowhere' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No spec of any kind has the ID "nowhere".');
  });
});
