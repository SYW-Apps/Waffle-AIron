import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setProjectRoot, runWithProjectBinding } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  invalidateSpecCache,
  resolveChainingParent,
} from '../../src/core/specs.js';
import { createMcpServer, statusFamilyContext } from '../../src/mcp/server.js';
import type { ComponentSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The member bind-time announcement (mcp_server createMcpServer step 7) and the
// family context sdd_get_status opens with. sdd_list_external_interfaces is
// gone (stage 3): a member consumes what it declares under `externals`.
//
// Driven through the REAL factory (createMcpServer) over an in-memory
// transport, exactly as a connected agent would — bound first to a member
// (announcement) and then to a top root (no announcement).
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

/** A project.yaml, written as JSON (a YAML subset). */
function writeConfig(dir: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    createdAt: now,
    updatedAt: now,
    ...config,
  }));
}

/** Parent project with one published portal, declaring the member `kid`. */
function buildChainedWorld(rootDir: string): string {
  writeConfig(rootDir, { name: 'ext-root-system', members: { kid: 'packages/kid' } });
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
  saveSpec('subsystem', subsystem('core-sub', {
    publicInterfaces: [{ type: 'REST', details: 'api', component: 'gateway-portal' }],
  }));
  saveComponentSpec(component('gateway-portal', 'core-sub', {
    componentType: 'Portal', transport: 'HTTP',
  } as Partial<ComponentSpec>));
  saveInterfaceSpec(iface('igateway-portal', 'gateway-portal', [
    {
      name: 'fetchRecord', description: 'Fetches a record.', signature: 'fetchRecord(id: string): json',
      returns: 'json', params: [{ name: 'id', type: 'string' }],
      endpoint: { transport: 'HTTP', method: 'GET', path: '/records/{id}' },
    },
  ]));
  const kidDir = path.join(rootDir, 'packages', 'kid');
  writeConfig(kidDir, { id: 'kid', name: 'kid' });
  setProjectRoot(kidDir);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'kid', vision: 'a member', boundaries: [], globalRequirements: [],
    createdAt: now, updatedAt: now,
  });
  invalidateSpecCache();
  setProjectRoot(rootDir);
  return kidDir;
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

describe('member announcement + family context', () => {
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

  it('no longer registers sdd_list_external_interfaces', async () => {
    setProjectRoot(childDir);
    const client = await connectInMemory(createMcpServer());
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).not.toContain('sdd_list_external_interfaces');
    } finally {
      await client.close();
    }
  });

  it('announces the membership on stderr when the bound root is a member', () => {
    setProjectRoot(childDir);
    createMcpServer();
    const announcement = stderrLines.find((l) => l.includes('member project'));
    expect(announcement).toBeDefined();
    expect(announcement).toContain('"kid"');
    expect(announcement).toContain(rootDir);
    expect(announcement).toContain('sdd_get_externals_status');
  });

  it('stays silent for a genuine top root', () => {
    setProjectRoot(rootDir);
    createMcpServer();
    expect(stderrLines.find((l) => l.includes('member project'))).toBeUndefined();
  });

  // Reach: a hosted request binds the child's root together with whether its
  // credential reaches the top project. Reading above the bound root — the
  // parent's current state hash behind freshness, or the parent's location in the
  // announcement — is exactly what a child-narrowed credential must not do.

  it('a credential narrowed to the child reads nothing above it: no parent', () => {
    runWithProjectBinding(childDir, { topRoot: rootDir, parentReach: false }, () => {
      expect(resolveChainingParent()).toBeNull();
    });
  });

  it('a credential that reaches the top project still sees the parent, by the alias it declares', () => {
    runWithProjectBinding(childDir, { topRoot: rootDir, parentReach: true }, () => {
      expect(resolveChainingParent()).toMatchObject({ alias: 'kid', form: 'members' });
    });
  });

  it("never reads above the request's top project root, whatever the credential reaches", () => {
    runWithProjectBinding(childDir, { topRoot: childDir, parentReach: true }, () => {
      expect(resolveChainingParent()).toBeNull();
    });
  });

  it('does not announce the parent from a server bound for a child-scoped credential', () => {
    runWithProjectBinding(childDir, { topRoot: rootDir, parentReach: false }, () => createMcpServer());
    expect(stderrLines.find((l) => l.includes('member project'))).toBeUndefined();
  });

  // sdd_get_status tells a connected agent where its root sits among chained
  // projects, in-band — the agent never sees the startup log above.

  it('opens sdd_get_status with the family context when the bound root is a chained child', async () => {
    setProjectRoot(childDir);
    const client = await connectInMemory(createMcpServer());
    try {
      const status = unwrapText(await client.callTool({ name: 'sdd_get_status', arguments: {} }) as never);
      expect(status).toContain('a member of the parent project "ext-root-system", declared as "kid"');
      expect(status).toContain('sdd_get_externals_status');
    } finally {
      await client.close();
    }
  });

  it('lists the members a parent root declares, and names no parent for a top root', async () => {
    setProjectRoot(rootDir);
    const client = await connectInMemory(createMcpServer());
    try {
      const status = unwrapText(await client.callTool({ name: 'sdd_get_status', arguments: {} }) as never);
      expect(status).toContain('member projects declared here — kid (packages/kid)');
      expect(status).not.toContain('a member of the parent project');
    } finally {
      await client.close();
    }
  });

  it('keeps the parent out of the family context for a credential narrowed to the child', () => {
    runWithProjectBinding(childDir, { topRoot: rootDir, parentReach: false }, () => {
      expect(statusFamilyContext()).not.toContain('a member of the parent project');
    });
  });
});
