import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import {
  requiredDataPlaneCapability,
  isExplicitlyClassifiedTool,
  subprojectConfinementError,
  toolScope,
} from '../../src/server/request.js';

// ---------------------------------------------------------------------------
// Host Request Orchestrator — data-plane tool classification (step 48).
//
// The permission gate classifies a tool as a read or a write, and anything it
// does not recognize fails closed as a write. That default is a safety net, not a
// classification: `sdd_list_external_interfaces` and the topology tools fell into
// it and demanded project:write for a read. Every tool the hosted server
// advertises must be classified on purpose — including WHERE it acts, which is
// what confines a credential narrowed to a chained child (steps 10–11).
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

  it('gates a write that carries no write prefix as a tree-scoped write, on purpose', () => {
    expect(requiredDataPlaneCapability('sdd_rename_component')).toBe('project:write');
    expect(toolScope('sdd_rename_component')).toBe('tree');
    expect(isExplicitlyClassifiedTool('sdd_rename_component')).toBe(true);
    expect(subprojectConfinementError('proj', 'kid', {
      jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'sdd_rename_component', arguments: {} },
    })).toBeUndefined();
  });

  it('still fails closed for a name nobody classified', () => {
    expect(requiredDataPlaneCapability('sdd_brand_new_tool')).toBe('project:write');
    expect(isExplicitlyClassifiedTool('sdd_brand_new_tool')).toBe(false);
    expect(toolScope('sdd_brand_new_tool')).toBeUndefined();
  });

  it('classifies and scopes every tool the hosted server advertises on purpose — none leans on a fail-closed default', async () => {
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
      expect(tools.map((t) => t.name).filter((name) => toolScope(name) === undefined)).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

describe('subproject confinement by declared tool scope', () => {
  const call = (name: string): unknown => ({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: {} } });

  it('serves a tool that acts on the bound tree to a credential narrowed to a child', () => {
    for (const name of [
      'sdd_get_status',
      'sdd_update_spec',
      'sdd_validate_tree',
      'sdd_list_external_interfaces',
      'listAgents',
      'sdd_host_lock_project',
      'sdd_host_export_tree',
      'sdd_host_import_tree',
    ]) {
      expect(toolScope(name)).toBe('tree');
      expect(subprojectConfinementError('proj', 'kid', call(name))).toBeUndefined();
    }
  });

  it('refuses a tool that acts on the whole project record', () => {
    for (const name of [
      'sdd_host_initialize_project',
      'sdd_host_get_approval_status',
      'sdd_host_commit_project',
      'sdd_landscape_list_visible_surfaces',
    ]) {
      expect(toolScope(name)).toBe('record');
      const refusal = subprojectConfinementError('proj', 'kid', call(name));
      expect(refusal?.result.isError).toBe(true);
      expect(refusal?.result.content[0].text).toContain('acts on the whole project "proj"');
    }
  });

  it('refuses a tool that declares no scope — confinement fails closed', () => {
    const refusal = subprojectConfinementError('proj', 'kid', call('sdd_brand_new_tool'));
    expect(refusal?.result.isError).toBe(true);
    expect(refusal?.result.content[0].text).toContain('declares no scope');
    expect(refusal?.result.content[0].text).toContain('"proj::kid"');
  });

  it('leaves an unqualified credential untouched, whatever the tool', () => {
    expect(subprojectConfinementError('proj', undefined, call('sdd_brand_new_tool'))).toBeUndefined();
    expect(subprojectConfinementError('proj', undefined, call('sdd_host_commit_project'))).toBeUndefined();
  });
});
