import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ---------------------------------------------------------------------------
// End-to-end MCP integration: spawn the REAL stdio server (via tsx, so no
// build step is required) scoped to a temp project, and drive the sdd_*
// authoring pipeline the way a host AI tool does:
//   initialize → subsystem → components → interface → endpoints → narrative
//   → validate → status
// asserting both the tool responses and the resulting on-disk spec tree.
// This covers the biggest previously-untested seam: the MCP protocol surface.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const now = new Date().toISOString();

function unwrapText(result: any): string {
  expect(result.isError ?? false).toBe(false);
  const first = result.content?.[0];
  expect(first?.type).toBe('text');
  return first.text as string;
}

describe('MCP stdio server integration (sdd_* pipeline)', () => {
  let projDir: string;
  let client: Client;

  beforeAll(async () => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-mcp-e2e-'));
    fs.mkdirSync(path.join(projDir, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.wai', 'project.yaml'), [
      "schemaVersion: '1.0.0'",
      'name: mcp-e2e',
      'targets:',
      '  - type: claude',
      '    outputDir: .claude/agents',
      '    enabled: true',
      `createdAt: '${now}'`,
      `updatedAt: '${now}'`,
    ].join('\n'));

    client = new Client({ name: 'wairon-e2e-test', version: '0.0.1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX_CLI, WAIRON_CLI, 'mcp', 'serve'],
      cwd: projDir,
      stderr: 'ignore',
    });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    try { await client?.close(); } catch { /* already gone */ }
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  it('exposes the sdd_* tool surface', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map(t => t.name);
    for (const expected of [
      'sdd_initialize_system', 'sdd_add_subsystem', 'sdd_add_component',
      'sdd_define_interface', 'sdd_set_endpoints', 'sdd_write_narrative',
      'sdd_add_type', 'sdd_update_spec', 'sdd_delete_spec', 'sdd_get_spec',
      'sdd_validate_tree', 'sdd_get_status', 'sdd_list_external_interfaces',
      'sdd_move_subsystem_project', 'sdd_externalize_subsystem', 'sdd_internalize_subsystem',
    ]) {
      expect(names).toContain(expected);
    }
  }, 30_000);

  it('authors a full spec tree through the tools and validates clean', async () => {
    unwrapText(await client.callTool({
      name: 'sdd_initialize_system',
      arguments: { name: 'E2ESystem', vision: 'End-to-end authored system', targetLanguage: 'typescript' },
    }));

    unwrapText(await client.callTool({
      name: 'sdd_add_subsystem',
      arguments: {
        id: 'billing',
        name: 'Billing',
        description: 'Billing bounded context',
        publicInterfaces: [{ type: 'REST', details: '/api/v1/billing', component: 'billing-portal' }],
      },
    }));

    unwrapText(await client.callTool({
      name: 'sdd_add_component',
      arguments: {
        id: 'billing-portal', name: 'Billing Portal', description: 'Inbound HTTP front door',
        subsystem: 'billing', componentType: 'Portal', portalType: 'HTTP_API',
        dependsOn: ['billing-orchestrator'],
      },
    }));

    unwrapText(await client.callTool({
      name: 'sdd_add_component',
      arguments: {
        id: 'billing-orchestrator', name: 'Billing Orchestrator', description: 'Owns the charge workflow',
        subsystem: 'billing', componentType: 'Orchestrator',
      },
    }));

    unwrapText(await client.callTool({
      name: 'sdd_define_interface',
      arguments: {
        id: 'ibilling-portal', name: 'IBillingPortal', description: 'Portal contract', component: 'billing-portal',
        methods: [{ name: 'charge', description: 'Charge a customer', signature: 'charge(customerId: string): Promise<void>', returns: 'Promise<void>' }],
      },
    }));

    unwrapText(await client.callTool({
      name: 'sdd_set_endpoints',
      arguments: {
        interface: 'ibilling-portal',
        endpoints: [{ method: 'charge', transport: 'HTTP', httpMethod: 'POST', path: '/v1/charge' }],
      },
    }));

    unwrapText(await client.callTool({
      name: 'sdd_define_interface',
      arguments: {
        id: 'ibilling-orchestrator', name: 'IBillingOrchestrator', description: 'Workflow contract', component: 'billing-orchestrator',
        methods: [{ name: 'processCharge', description: 'Process a charge', signature: 'processCharge(customerId: string): Promise<void>', returns: 'Promise<void>' }],
      },
    }));

    unwrapText(await client.callTool({
      name: 'sdd_write_narrative',
      arguments: {
        id: 'billing-portal-impl', name: 'Billing Portal Impl', description: 'Dispatches inward', contract: 'ibilling-portal',
        methods: [{
          name: 'charge',
          narrative: [{ stepNumber: 1, description: 'Dispatch to the charge workflow', type: 'call', targetComponent: 'billing-orchestrator', targetMethod: 'processCharge' }],
        }],
      },
    }));

    // The gate over what we just authored
    const validateOut = JSON.parse(unwrapText(await client.callTool({ name: 'sdd_validate_tree', arguments: {} })));
    expect(validateOut.errors).toEqual([]);
    expect(validateOut.valid).toBe(true);

    const status = unwrapText(await client.callTool({ name: 'sdd_get_status', arguments: {} }));
    expect(status).toContain('billing');

    // The nested dot-prefixed layout materialized on disk
    expect(fs.existsSync(path.join(projDir, '.wai', 'specs', '.index.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(projDir, '.wai', 'specs', 'billing', '.index.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(projDir, '.wai', 'specs', 'billing', 'billing-portal', '.index.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(projDir, '.wai', 'specs', 'billing', 'billing-portal', '.interface.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(projDir, '.wai', 'specs', 'billing', 'billing-portal', '.implementation.yaml'))).toBe(true);

    // The endpoint binding round-tripped
    const intf = JSON.parse(unwrapText(await client.callTool({ name: 'sdd_get_spec', arguments: { kind: 'interface', id: 'ibilling-portal' } })));
    expect(intf.methods[0].endpoint).toEqual({ transport: 'HTTP', method: 'POST', path: '/v1/charge' });
  }, 120_000);

  it('rejects an invalid update delta without corrupting the spec', async () => {
    const res = await client.callTool({
      name: 'sdd_update_spec',
      arguments: { kind: 'interface', id: 'ibilling-portal', delta: { methods: [{ name: 'broken' }] } },
    });
    expect(res.isError).toBe(true);
    expect((res.content as any)[0].text).toContain('Refusing to write invalid interface spec');

    // The file is intact and still validates
    const intf = JSON.parse(unwrapText(await client.callTool({ name: 'sdd_get_spec', arguments: { kind: 'interface', id: 'ibilling-portal' } })));
    expect(intf.methods).toHaveLength(1);
    expect(intf.methods[0].name).toBe('charge');
  }, 60_000);

  it('supports explicit status demotion through sdd_update_spec', async () => {
    unwrapText(await client.callTool({
      name: 'sdd_update_spec',
      arguments: { kind: 'component', id: 'billing-orchestrator', delta: { status: 'design' } },
    }));
    const comp = JSON.parse(unwrapText(await client.callTool({ name: 'sdd_get_spec', arguments: { kind: 'component', id: 'billing-orchestrator' } })));
    expect(comp.status).toBe('design');
  }, 60_000);
});

describe('MCP stdio server integration (subsystem migration tools)', () => {
  let projDir: string;
  let client: Client;

  const errorsOf = (v: any): any[] => v.errors ?? [];

  beforeAll(async () => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-mcp-mig-'));
    fs.mkdirSync(path.join(projDir, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.wai', 'project.yaml'), [
      "schemaVersion: '1.0.0'",
      'name: mcp-mig',
      'targets:',
      '  - type: claude',
      '    outputDir: .claude/agents',
      '    enabled: true',
      `createdAt: '${now}'`,
      `updatedAt: '${now}'`,
    ].join('\n'));

    client = new Client({ name: 'wairon-mig-test', version: '0.0.1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX_CLI, WAIRON_CLI, 'mcp', 'serve'],
      cwd: projDir,
      stderr: 'ignore',
    });
    await client.connect(transport);

    // A small internal tree: core (published portal + orchestrator) and cli
    // (an adapter that crosses into core's published portal).
    unwrapText(await client.callTool({ name: 'sdd_initialize_system', arguments: { name: 'MigSystem', vision: 'migration e2e' } }));
    unwrapText(await client.callTool({ name: 'sdd_add_subsystem', arguments: {
      id: 'core', name: 'Core', description: 'the core',
      publicInterfaces: [{ type: 'REST', details: '/api/core', component: 'core-portal' }],
    } }));
    unwrapText(await client.callTool({ name: 'sdd_add_component', arguments: {
      id: 'core-portal', name: 'Core Portal', description: 'front door',
      subsystem: 'core', componentType: 'Portal', portalType: 'HTTP_API', dependsOn: ['core-orch'],
    } }));
    unwrapText(await client.callTool({ name: 'sdd_add_component', arguments: {
      id: 'core-orch', name: 'Core Orchestrator', description: 'workflow', subsystem: 'core', componentType: 'Orchestrator',
    } }));
    unwrapText(await client.callTool({ name: 'sdd_add_subsystem', arguments: { id: 'cli', name: 'CLI', description: 'the cli' } }));
    unwrapText(await client.callTool({ name: 'sdd_add_component', arguments: {
      id: 'cli-core-adapter', name: 'CLI Core Adapter', description: 'hop into core',
      subsystem: 'cli', componentType: 'Adapter', dependsOn: ['core-portal'],
    } }));
  }, 60_000);

  afterAll(async () => {
    try { await client?.close(); } catch { /* already gone */ }
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  it('externalizes then internalizes a subsystem, rewriting the cross-ref, with no new errors', async () => {
    const before = JSON.parse(unwrapText(await client.callTool({ name: 'sdd_validate_tree', arguments: {} })));
    expect(errorsOf(before)).toEqual([]);

    // --- externalize ---
    unwrapText(await client.callTool({ name: 'sdd_externalize_subsystem', arguments: { subsystem: 'core', projectPath: 'packages/core' } }));

    const mount = JSON.parse(unwrapText(await client.callTool({ name: 'sdd_get_spec', arguments: { kind: 'subsystem', id: 'core' } })));
    expect(mount.projectPath).toBe('packages/core');
    expect(fs.existsSync(path.join(projDir, 'packages', 'core', '.wai', 'project.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(projDir, 'packages', 'core', '.wai', 'specs', 'core', 'core-portal', '.index.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(projDir, '.wai', 'specs', 'core', 'core-portal'))).toBe(false);

    const adapterExt = JSON.parse(unwrapText(await client.callTool({ name: 'sdd_get_spec', arguments: { kind: 'component', id: 'cli-core-adapter' } })));
    expect(adapterExt.dependsOn).toEqual(['core::core-portal']);

    const afterExt = JSON.parse(unwrapText(await client.callTool({ name: 'sdd_validate_tree', arguments: {} })));
    expect(errorsOf(afterExt)).toEqual([]); // ref rewrite kept it error-free

    // --- internalize ---
    unwrapText(await client.callTool({ name: 'sdd_internalize_subsystem', arguments: { subsystem: 'core' } }));

    const restored = JSON.parse(unwrapText(await client.callTool({ name: 'sdd_get_spec', arguments: { kind: 'subsystem', id: 'core' } })));
    expect(restored.projectPath ?? null).toBeNull();
    expect(fs.existsSync(path.join(projDir, 'packages', 'core', '.wai'))).toBe(false);
    expect(fs.existsSync(path.join(projDir, '.wai', 'specs', 'core', 'core-portal', '.index.yaml'))).toBe(true);

    const adapterInt = JSON.parse(unwrapText(await client.callTool({ name: 'sdd_get_spec', arguments: { kind: 'component', id: 'cli-core-adapter' } })));
    expect(adapterInt.dependsOn).toEqual(['core-portal']);

    const afterInt = JSON.parse(unwrapText(await client.callTool({ name: 'sdd_validate_tree', arguments: {} })));
    expect(errorsOf(afterInt)).toEqual([]);
  }, 120_000);

  it('creates a chained subsystem at a path and relocates it', async () => {
    // sdd_add_subsystem with projectPath scaffolds the child project.
    unwrapText(await client.callTool({ name: 'sdd_add_subsystem', arguments: {
      id: 'ext', name: 'Ext', description: 'external from birth', projectPath: 'packages/ext',
    } }));
    expect(fs.existsSync(path.join(projDir, 'packages', 'ext', '.wai', 'specs', '.index.yaml'))).toBe(true);
    const ext = JSON.parse(unwrapText(await client.callTool({ name: 'sdd_get_spec', arguments: { kind: 'subsystem', id: 'ext' } })));
    expect(ext.projectPath).toBe('packages/ext');

    // sdd_move_subsystem_project relocates it.
    unwrapText(await client.callTool({ name: 'sdd_move_subsystem_project', arguments: { subsystem: 'ext', newProjectPath: 'services/ext' } }));
    expect(fs.existsSync(path.join(projDir, 'packages', 'ext'))).toBe(false);
    expect(fs.existsSync(path.join(projDir, 'services', 'ext', '.wai', 'specs', '.index.yaml'))).toBe(true);
    const moved = JSON.parse(unwrapText(await client.callTool({ name: 'sdd_get_spec', arguments: { kind: 'subsystem', id: 'ext' } })));
    expect(moved.projectPath).toBe('services/ext');
  }, 120_000);
});
