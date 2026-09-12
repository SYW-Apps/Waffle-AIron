import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { requiredDataPlaneCapability, isExplicitlyClassifiedTool } from '../../src/server/request.js';

// ---------------------------------------------------------------------------
// Host Request Orchestrator — data-plane tool classification (step 48).
//
// The permission gate classifies a tool as a read or a write, and anything it
// does not recognize fails closed as a write. That default is a safety net, not a
// classification: `sdd_list_external_interfaces` and the topology tools fell into
// it and demanded project:write for a read. Every tool the hosted server
// advertises must be classified on purpose.
// ---------------------------------------------------------------------------

const READS_WITHOUT_A_READ_PREFIX = [
  'sdd_list_external_interfaces',
  'listAgents',
  'getAgent',
  'listDomains',
  'validateTopology',
  'getProjectConfig',
];

describe('data-plane tool classification', () => {
  let rootDir: string | undefined;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
    rootDir = undefined;
  });

  it('gates a read that carries no read prefix as a read', () => {
    for (const name of READS_WITHOUT_A_READ_PREFIX) {
      expect(requiredDataPlaneCapability(name)).toBe('project:read');
    }
  });

  it('still fails closed for a name nobody classified', () => {
    expect(requiredDataPlaneCapability('sdd_brand_new_tool')).toBe('project:write');
    expect(isExplicitlyClassifiedTool('sdd_brand_new_tool')).toBe(false);
  });

  it('classifies every tool the hosted server advertises on purpose — none leans on the fail-closed default', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-classify-'));
    fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(rootDir, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'classify', projectType: 'backend',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: {}, createdAt: now, updatedAt: now,
    }));
    setProjectRoot(rootDir);

    const server = createMcpServer({ hostedTools: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'classification-test', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.map((t) => t.name).filter((name) => !isExplicitlyClassifiedTool(name))).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
