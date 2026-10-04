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
  saveSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveTypeSpec,
  loadInterfaceSpec,
  loadTypeSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import type { ComponentSpec, InterfaceSpec, SubsystemSpec, TypeSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// sdd_rename_type (mcp_portal → mcp_orchestrator → mcp_core_adapter →
// core_portal): the tool resolves its id, renames through the chain and returns
// the TypeRename report — or the core refusal as a tool error.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

function books(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-mcp-rename-type-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: 'books', targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
  });
  setProjectRoot(root);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'books-sys', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  saveSpec('subsystem', {
    id: 'books', name: 'books', description: 'd', parentSystem: 'books-sys', publicInterfaces: [], trustedLinks: [],
    status: 'draft', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  saveComponentSpec({
    id: 'ledger', name: 'ledger', description: 'd', subsystem: 'books', componentType: 'Orchestrator', owns: [], dependsOn: [],
    createdAt: now, updatedAt: now,
  } as ComponentSpec);
  saveInterfaceSpec({
    id: 'iledger', name: 'ILedger', description: 'd', component: 'ledger', createdAt: now, updatedAt: now,
    methods: [{ name: 'post', description: 'd', params: [{ name: 'entry', type: 'Entry' }], returns: 'void' }],
  } as InterfaceSpec);
  saveTypeSpec({
    kind: 'value-object', id: 'entry', name: 'Entry', description: 'd', subsystem: 'books',
    fields: [{ name: 'id', type: 'string', optional: false }], methods: [], createdAt: now, updatedAt: now,
  } as TypeSpec);
  invalidateSpecCache();
  return root;
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'rename-type-test', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const textOf = (result: ToolResult): string => result.content?.[0]?.text ?? '';

describe('sdd_rename_type', () => {
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
    await client!.callTool({ name: 'sdd_rename_type', arguments: args }) as ToolResult;

  it('is published with the type id and its new id', async () => {
    root = books();
    client = await connect(createMcpServer());
    const tool = (await client.listTools()).tools.find((t) => t.name === 'sdd_rename_type');
    expect(tool).toBeDefined();
    expect([...(tool!.inputSchema.required ?? [])].sort()).toEqual(['id', 'newId']);
  });

  it('renames through the chain and returns the report as the tool result', async () => {
    root = books();
    client = await connect(createMcpServer());
    const result = await call({ id: 'entry', newId: 'posting' });
    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse(textOf(result))).toEqual({
      from: 'books::entry', to: 'books::posting', rewritten: ['iledger'], keptPublicNames: [], carried: [],
    });
    invalidateSpecCache();
    expect(loadTypeSpec('posting')?.previousIds).toEqual(['entry']);
    expect(loadInterfaceSpec('iledger')?.methods[0].params?.[0].type).toBe('Posting');
  });

  it('reports a refusal as a tool error', async () => {
    root = books();
    client = await connect(createMcpServer());
    const result = await call({ id: 'nope', newId: 'posting' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/type-missing/);
  });
});
