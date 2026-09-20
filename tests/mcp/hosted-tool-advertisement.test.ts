import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// mcp_portal.advertiseHostedTools.
//
// The hosted data plane's sixteen tools are ADVERTISED by this server and
// executed by nobody in it: the hosting request orchestrator intercepts them
// upstream and owns their contracts. The registrations exist so an MCP client
// can find them, which makes "which ones, and only when hosted" the whole
// behaviour — and it had no test. A stray entry on the LOCAL stdio server
// offers an agent a tool that can only ever answer that it is unavailable.
// ---------------------------------------------------------------------------

const HOSTED_TOOLS = [
  'sdd_host_await_approval',
  'sdd_host_commit_project',
  'sdd_host_export_tree',
  'sdd_host_get_approval_status',
  'sdd_host_import_tree',
  'sdd_host_initialize_project',
  'sdd_host_lock_project',
  'sdd_host_pack_install',
  'sdd_host_pack_list',
  'sdd_host_policy_evaluate',
  'sdd_host_policy_reconcile',
  'sdd_host_produce',
  'sdd_landscape_get_project_surface',
  'sdd_landscape_list_reachable_project_interfaces',
  'sdd_landscape_list_reachable_projects',
  'sdd_landscape_list_visible_surfaces',
];

const ARGUMENTS_REQUIRED = new Set([
  'sdd_host_await_approval',
  'sdd_host_get_approval_status',
  'sdd_host_import_tree',
  'sdd_host_initialize_project',
  'sdd_host_pack_install',
  'sdd_host_produce',
  'sdd_landscape_get_project_surface',
  'sdd_landscape_list_reachable_project_interfaces',
]);

const now = '2026-09-20T10:00:00Z';

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-hosted-ads-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'hosted-ads', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  return root;
}

async function connect(hostedTools: boolean): Promise<Client> {
  const server = createMcpServer(hostedTools ? { hostedTools: true } : {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-advertisement-test', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const hostedNames = (names: string[]): string[] =>
  names.filter((n) => n.startsWith('sdd_host_') || n.startsWith('sdd_landscape_')).sort();

describe('advertiseHostedTools', () => {
  let root: string;
  let client: Client | null = null;

  afterEach(async () => {
    if (client) await client.close();
    client = null;
    setProjectRoot(null);
    invalidateSpecCache();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('advertises the sixteen hosted and landscape entries when hosted tools are on', async () => {
    root = project();
    client = await connect(true);
    const { tools } = await client.listTools();
    expect(hostedNames(tools.map((t) => t.name))).toEqual([...HOSTED_TOOLS].sort());
  });

  it('advertises none of them on the local stdio server', async () => {
    root = project();
    client = await connect(false);
    const { tools } = await client.listTools();
    expect(hostedNames(tools.map((t) => t.name))).toEqual([]);
    // The rest of the surface is untouched by the switch.
    expect(tools.map((t) => t.name)).toContain('sdd_get_status');
  });

  // Only the entries whose whole input is optional reach a handler at all: the
  // SDK validates arguments first, so a tool with a required field answers a
  // schema refusal instead. These eight are enough to prove what the binding IS.
  it('binds an advertised entry to a handler that only says it is dispatched upstream', async () => {
    root = project();
    client = await connect(true);
    for (const name of HOSTED_TOOLS.filter((n) => !ARGUMENTS_REQUIRED.has(n))) {
      const result = await client.callTool({ name, arguments: {} }) as {
        isError?: boolean; content?: { type: string; text: string }[];
      };
      expect(result.isError, name).toBe(true);
      expect(result.content?.[0]?.text, name).toContain('unavailable outside a hosted request');
    }
  });
});
