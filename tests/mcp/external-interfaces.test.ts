import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { generateChildSnapshots } from '../../src/core/surfaces.js';
import { createChainedSubsystem } from '../../src/core/provision.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { ComponentSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// sdd_list_external_interfaces (mcp_surfaces_adapter → surface_portal) and the
// chained-subproject bind-time announcement (mcp_server createMcpServer step 7).
//
// Driven through the REAL factory (createMcpServer) over an in-memory
// transport, exactly as a connected agent would — bound first to a chained
// child (entries + announcement) and then to a top root (no announcement,
// empty discovery).
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

const subsystem = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'ext-root-system',
  publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now, ...over,
});
const component = (id: string, sub: string, over: Partial<ComponentSpec> = {}): ComponentSpec => ({
  id, name: id, description: 'd', subsystem: sub, componentType: 'Orchestrator',
  owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);
const iface = (id: string, comp: string, methods: InterfaceSpec['methods']): InterfaceSpec => ({
  id, name: id, description: 'd', component: comp, methods, status: 'complete', createdAt: now, updatedAt: now,
});

/** Parent project with one published portal + a chained child, surfaces delivered. */
function buildChainedWorld(rootDir: string): string {
  fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'ext-root-system',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    createdAt: now,
    updatedAt: now,
  }));
  setProjectRoot(rootDir);

  saveSystemSpec({
    schemaVersion: '1.0.0',
    name: 'ext-root-system',
    vision: 'external discovery fixture',
    boundaries: [],
    globalRequirements: [],
    publicInterfaces: [
      { id: 'gateway', name: 'Gateway API', subsystem: 'core-sub', component: 'gateway-portal', type: 'REST', details: 'main api', audience: 'external' },
    ],
    createdAt: now,
    updatedAt: now,
  });
  saveSubsystemSpec(subsystem('core-sub', {
    publicInterfaces: [{ type: 'REST', details: 'api', component: 'gateway-portal' }],
  }));
  saveComponentSpec(component('gateway-portal', 'core-sub', {
    componentType: 'Portal', portalType: 'HTTP_API',
  } as Partial<ComponentSpec>));
  saveInterfaceSpec(iface('igateway-portal', 'gateway-portal', [
    {
      name: 'fetchRecord', description: 'Fetches a record.', signature: 'fetchRecord(id: string): json',
      returns: 'json', params: [{ name: 'id', type: 'string' }],
      endpoint: { transport: 'HTTP', method: 'GET', path: '/records/{id}' },
    },
  ]));
  createChainedSubsystem(subsystem('kid', { projectPath: 'packages/kid', status: 'draft' }), 'kid');
  invalidateSpecCache();
  setProjectRoot(rootDir);
  generateChildSnapshots();
  invalidateSpecCache();
  return path.join(rootDir, 'packages', 'kid');
}

async function connectInMemory(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'external-interfaces-test', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function unwrapText(result: { isError?: boolean; content?: { type: string; text?: string }[] }): string {
  expect(result.isError ?? false).toBe(false);
  const first = result.content?.[0];
  expect(first?.type).toBe('text');
  return first!.text as string;
}

describe('sdd_list_external_interfaces + chained-subproject announcement', () => {
  let rootDir: string;
  let childDir: string;
  let stderrLines: string[];

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-mcp-ext-'));
    childDir = buildChainedWorld(rootDir);
    stderrLines = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  it('registers the tool and returns the discovery entries for a chained child', async () => {
    setProjectRoot(childDir);
    const client = await connectInMemory(createMcpServer());
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('sdd_list_external_interfaces');

      const entries = JSON.parse(unwrapText(
        await client.callTool({ name: 'sdd_list_external_interfaces', arguments: {} }) as never,
      ));
      expect(Array.isArray(entries)).toBe(true);
      const parent = entries.find((e: { sourceKind: string }) => e.sourceKind === 'parent');
      expect(parent).toBeDefined();
      expect(parent.projectName).toBe('ext-root-system');
      expect(parent.origin).toBe('generated');
      expect(parent.freshness).toBe('fresh');
      expect(parent.interfaceIds).toContain('gateway');
    } finally {
      await client.close();
    }
  });

  it('announces the chaining context on stderr when the bound root is a chained child', () => {
    setProjectRoot(childDir);
    createMcpServer();
    const announcement = stderrLines.find((l) => l.includes('chained subproject'));
    expect(announcement).toBeDefined();
    expect(announcement).toContain('"kid"');
    expect(announcement).toContain(rootDir);
    // The child vendors the family surface + the core-sub sibling surface.
    expect(announcement).toMatch(/2 vendored external surface\(s\)/);
    expect(announcement).toContain('sdd_list_external_interfaces');
  });

  it('stays silent for a genuine top root and returns an empty discovery there', async () => {
    setProjectRoot(rootDir);
    const client = await connectInMemory(createMcpServer());
    try {
      expect(stderrLines.find((l) => l.includes('chained subproject'))).toBeUndefined();
      const entries = JSON.parse(unwrapText(
        await client.callTool({ name: 'sdd_list_external_interfaces', arguments: {} }) as never,
      ));
      expect(entries).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
