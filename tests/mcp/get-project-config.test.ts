import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// mcp_core_adapter's getProjectConfig and sdd_validate_tree tools — stage
// 2a-0, wave 2.
//
// Both tools now read through the core surface's null-safe loadProjectConfig
// (rather than the loader's throwing one), but a missing project configuration
// must still surface as the SAME tool-level error each always has — never a
// bare `json(null)` response, and never a validate run at silent defaults.
// ---------------------------------------------------------------------------

async function connectInMemory(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'get-project-config-test', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const created: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  invalidateSpecCache();
  for (const dir of created.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
  }
});

describe('getProjectConfig (mcp_core_adapter)', () => {
  it('errors on an uninitialized project — no .wai/project.yaml at all', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-getcfg-noconfig-'));
    created.push(tempDir);
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    invalidateSpecCache();

    const client = await connectInMemory(createMcpServer());
    try {
      const result: any = await client.callTool({ name: 'getProjectConfig', arguments: {} });
      expect(result.isError).toBe(true);
      const first = result.content?.[0];
      expect(first?.type).toBe('text');
      expect(first.text as string).toContain('No wairon project found');
    } finally {
      await client.close();
    }
  });

  it('returns the parsed config when the project is initialized', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-getcfg-ok-'));
    created.push(tempDir);
    fs.mkdirSync(path.join(tempDir, '.wai', 'specs'), { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(tempDir, '.wai', 'project.yaml'), [
      "schemaVersion: '1.0.0'",
      'name: getcfg-ok',
      'targets:',
      '  - type: claude',
      '    outputDir: .claude/agents',
      '    enabled: true',
      `createdAt: '${now}'`,
      `updatedAt: '${now}'`,
    ].join('\n'));
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    invalidateSpecCache();

    const client = await connectInMemory(createMcpServer());
    try {
      const result: any = await client.callTool({ name: 'getProjectConfig', arguments: {} });
      expect(result.isError ?? false).toBe(false);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.name).toBe('getcfg-ok');
    } finally {
      await client.close();
    }
  });
});

describe('sdd_validate_tree (mcp_orchestrator)', () => {
  it('errors on an uninitialized project — no .wai/project.yaml at all', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-validatetree-noconfig-'));
    created.push(tempDir);
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    invalidateSpecCache();

    const client = await connectInMemory(createMcpServer());
    try {
      const result: any = await client.callTool({ name: 'sdd_validate_tree', arguments: {} });
      expect(result.isError).toBe(true);
      const first = result.content?.[0];
      expect(first?.type).toBe('text');
      expect(first.text as string).toContain('No wairon project found');
    } finally {
      await client.close();
    }
  });
});
