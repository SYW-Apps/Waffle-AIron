import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  loadInterfaceSpec,
  loadImplementationSpec,
  invalidateSpecCache,
  workspaceFor,
} from '../../src/core/specs.js';
import { createChainedSubsystem } from '../../src/core/provision.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import type { ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// sdd_rename_method (mcp_portal → mcp_orchestrator → mcp_core_adapter →
// core_portal): the tool resolves its id in the bound tree, renames through the
// chain, and returns the report as the tool result — or the core refusal as a
// tool error. Driven through the real server factory over an in-memory
// transport, as a connected agent would.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

const sub = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'books-sys',
  publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now, ...over,
});
const comp = (id: string, subsystem: string, componentType: string, over: Record<string, unknown> = {}): ComponentSpec => ({
  id, name: id, description: 'd', subsystem, componentType, owns: [], dependsOn: [], createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);
const intf = (id: string, component: string, methods: string[]): InterfaceSpec => ({
  id, name: id, description: 'd', component, createdAt: now, updatedAt: now,
  methods: methods.map((name) => ({ name, description: 'd', signature: `${name}(): void`, returns: 'void' })),
} as InterfaceSpec);
const impl = (id: string, contract: string, methods: string[]): ImplementationSpec => ({
  id, name: id, description: 'd', contract, createdAt: now, updatedAt: now,
  methods: methods.map((name) => ({ name, narrative: [{ stepNumber: 1, description: 'local step', type: 'local' }] })),
} as ImplementationSpec);

/** A `books` project whose `ledger` declares `post` and `close`, with a chained `ext` project holding `widget`. */
function books(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-mcp-method-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: 'books', targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
  });
  setProjectRoot(root);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'books-sys', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  saveSubsystemSpec(sub('books', { lifecycle: [{ phase: 'init', component: 'ledger', method: 'post' }] }));
  saveComponentSpec(comp('ledger', 'books', 'Orchestrator'));
  saveInterfaceSpec(intf('iledger', 'ledger', ['post', 'close']));
  saveImplementationSpec(impl('ledger_impl', 'iledger', ['post', 'close']));
  saveComponentSpec(comp('books_orch', 'books', 'Orchestrator', { dependsOn: ['ledger'] }));
  createChainedSubsystem(sub('ext', { projectPath: 'packages/ext' }), 'ext');
  const ext = workspaceFor(path.join(root, 'packages', 'ext'));
  ext.saveSubsystemSpec(sub('ext', { parentSystem: 'ext' }));
  ext.saveComponentSpec(comp('widget', 'ext', 'Adapter'));
  ext.saveInterfaceSpec(intf('iwidget', 'widget', ['post']));
  invalidateSpecCache();
  return root;
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'rename-method-test', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const textOf = (result: ToolResult): string => result.content?.[0]?.text ?? '';

describe('sdd_rename_method', () => {
  let root: string | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    try { await client?.close(); } catch { /* already gone */ }
    client = undefined;
    setProjectRoot(null);
    invalidateSpecCache();
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
    root = undefined;
  });

  const call = async (args: Record<string, unknown>): Promise<ToolResult> =>
    await client!.callTool({ name: 'sdd_rename_method', arguments: args }) as ToolResult;

  it('is published with the component id, the method, its new name and the optional pin', async () => {
    root = books();
    client = await connect(createMcpServer());
    const tool = (await client.listTools()).tools.find((t) => t.name === 'sdd_rename_method');
    expect(tool).toBeDefined();
    expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual(['id', 'method', 'newName', 'pinSymbol']);
    expect([...(tool!.inputSchema.required ?? [])].sort()).toEqual(['id', 'method', 'newName']);
  });

  it('renames through the chain and returns the report as the tool result', async () => {
    root = books();
    client = await connect(createMcpServer());

    const result = await call({ id: 'ledger', method: 'post', newName: 'append' });

    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse(textOf(result))).toEqual({
      component: 'ledger',
      from: 'post',
      to: 'append',
      renamed: ['iledger', 'ledger_impl'],
      rewritten: ['books'],
      mentions: [],
      pinnedSymbol: 'post',
      // The debt register names nothing this rename moved (F78).
      carried: [],
    });
    invalidateSpecCache();
    expect(loadInterfaceSpec('iledger')?.methods.map((m) => m.name)).toEqual(['append', 'close']);
    expect(loadImplementationSpec('ledger_impl')?.methods.map((m) => m.name)).toEqual(['append', 'close']);
  });

  it('carries pinSymbol through the chain', async () => {
    root = books();
    client = await connect(createMcpServer());

    const result = await call({ id: 'ledger', method: 'post', newName: 'append', pinSymbol: false });

    expect(JSON.parse(textOf(result)).pinnedSymbol).toBeUndefined();
    invalidateSpecCache();
    expect(loadImplementationSpec('ledger_impl')?.methods[0].symbol).toBeUndefined();
  });

  it('resolves a bare id naming a chained component to its qualified id, so core refuses it as chained', async () => {
    root = books();
    client = await connect(createMcpServer());

    for (const id of ['widget', 'ext::widget']) {
      const result = await call({ id, method: 'post', newName: 'append' });
      expect(result.isError, id).toBe(true);
      expect(textOf(result), id).toMatch(/chained-component/);
      expect(textOf(result), id).toContain('ext::widget');
    }
  });

  it('reports each other refusal as a tool error', async () => {
    root = books();
    client = await connect(createMcpServer());

    for (const [args, label] of [
      [{ id: 'nope', method: 'post', newName: 'append' }, /component-missing/],
      [{ id: 'ledger', method: 'post', newName: 'Append' }, /invalid-name/],
      [{ id: 'ledger', method: 'missing', newName: 'append' }, /method-missing/],
      [{ id: 'ledger', method: 'post', newName: 'close' }, /name-taken/],
    ] as const) {
      const result = await call(args);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(label);
    }
    invalidateSpecCache();
    expect(loadInterfaceSpec('iledger')?.methods.map((m) => m.name)).toEqual(['post', 'close']);
  });
});
