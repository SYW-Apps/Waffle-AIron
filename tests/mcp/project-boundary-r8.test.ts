/**
 * Round-8 platform BLOCKER: from a family root, `sdd_delete_spec` deleted a
 * MEMBER project's spec (no force), while `sdd_update_spec` on the same id was
 * refused. Every write tool now asks the same project boundary
 * (crossProjectWriteRefusal) before it writes anything — this walks every
 * authoring write tool the server advertises with a member's id and asserts
 * the refusal, and that the member's files never changed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runWithProjectRoot, setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, saveSpec, scanAllSpecs } from '../../src/core/specs.js';
import { createMember, provisionProject } from '../../src/core/provision.js';
import { createMcpServer } from '../../src/mcp/server.js';

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const now = '2026-10-09T00:00:00.000Z';
const roots: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** Every file under a project's specs folder, relative and sorted. */
function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p).split(path.sep).join('/')}:${fs.statSync(p).mtimeMs}`);
    }
  };
  walk(path.join(dir, '.wai', 'specs'));
  return out.sort();
}

/** The tools that write a project's own specs, other than the family migrations and the member and external declarations. */
const NOT_SPEC_AUTHORING = new Set([
  'sdd_add_member', 'sdd_move_member', 'sdd_rename_project', 'sdd_rename_member_alias', 'sdd_add_external',
  'sdd_update_external', 'sdd_set_network',
]);

describe('every authoring write tool refuses a member project\'s spec from the root', () => {
  it('walks each write tool with a member id: refused, naming the member, and nothing in the member changes', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r8-boundary-')));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
    setProjectRoot(root);
    provisionProject('Shop');
    saveSpec('subsystem', { id: 'orders', name: 'orders', description: 'orders', parentSystem: 'Shop', publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now } as never);
    saveSpec('component', { id: 'order_flow', name: 'Flow', description: 'f', subsystem: 'orders', componentType: 'Orchestrator', owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now } as never);
    createMember('payments', 'services/payments', 'Payments', 'project');
    const member = path.join(root, 'services', 'payments');
    runWithProjectRoot(member, () => {
      invalidateSpecCache();
      saveSpec('subsystem', { id: 'payments', name: 'payments', description: 'p', parentSystem: 'payments', publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now } as never);
      saveSpec('component', { id: 'payment_store', name: 'S', description: 's', subsystem: 'payments', componentType: 'Store', durability: 'ram-projection', owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now } as never);
      saveSpec('interface', { id: 'ipayment_store', name: 'S', description: 's', component: 'payment_store', methods: [{ name: 'put', description: 'p', params: [{ name: 'id', type: 'string' }], returns: 'void' }], status: 'complete', createdAt: now, updatedAt: now } as never);
      saveSpec('implementation', { id: 'payment_store_mem', name: 'M', description: 'm', contract: 'ipayment_store', methods: [{ name: 'put', narrative: [] }], status: 'complete', createdAt: now, updatedAt: now } as never);
      saveSpec('type', { kind: 'value-object', id: 'sku_id', name: 'SkuId', fields: [{ name: 'v', type: 'string' }], methods: [], createdAt: now, updatedAt: now } as never);
      invalidateSpecCache();
    });
    setProjectRoot(root);
    invalidateSpecCache();
    const key = scanAllSpecs().components.find((c) => c.id.endsWith('::payment_store'))!.id.split('::')[0];
    const before = files(member);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'project-boundary-r8', version: '0.0.1' });
    clients.push(client);
    await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);

    const calls: Record<string, Record<string, unknown>[]> = {
      sdd_update_spec: [{ kind: 'component', id: `${key}::payment_store`, delta: { description: 'x' } }],
      sdd_delete_spec: [
        { kind: 'component', id: `${key}::payment_store` },
        { kind: 'component', id: `${key}::payment_store`, dryRun: true },
        { kind: 'type', id: `${key}::sku_id` },
        { kind: 'interface', id: `${key}::ipayment_store`, dryRun: true },
      ],
      sdd_rename_component: [{ id: `${key}::payment_store`, newId: 'ledger_store' }],
      sdd_rename_method: [{ id: `${key}::payment_store`, method: 'put', newName: 'store' }],
      sdd_rename_type: [{ id: `${key}::sku_id`, newId: 'sku' }],
      sdd_rename_field: [{ id: `${key}::sku_id`, field: 'v', newName: 'w' }],
      sdd_rename_param: [{ id: `${key}::payment_store`, method: 'put', param: 'id', newName: 'ref' }],
      sdd_rename_spec: [{ kind: 'interface', id: `${key}::ipayment_store`, newId: 'ipay' }, { kind: 'implementation', id: `${key}::payment_store_mem`, newId: 'mem' }],
      sdd_move_spec: [{ kind: 'component', id: `${key}::payment_store`, subsystem: 'orders' }, { kind: 'type', id: `${key}::sku_id`, subsystem: 'orders', dryRun: true }],
      sdd_move_methods: [{ from: `${key}::payment_store`, to: 'order_flow', methods: ['put'] }],
      sdd_set_endpoints: [{ interface: `${key}::ipayment_store`, endpoints: [{ method: 'put', transport: 'CLI', command: 'put' }] }],
      sdd_add_type: [{ kind: 'value-object', id: 'intruder', name: 'I', subsystem: `${key}::payments`, fields: [] }],
      sdd_write_narrative: [{ id: 'intruder_impl', name: 'I', description: 'i', contract: `${key}::ipayment_store`, methods: [] }],
      sdd_define_interface: [{ id: 'iintruder', name: 'I', description: 'i', component: `${key}::payment_store`, methods: [] }],
      sdd_add_component: [{ id: 'intruder', name: 'I', description: 'i', subsystem: `${key}::payments`, componentType: 'Orchestrator' }],
      sdd_add_subsystem: [{ id: `${key}::intruders`, name: 'I', description: 'i' }],
      sdd_set_public_interfaces: [{ subsystem: `${key}::payments`, publicInterfaces: [] }],
    };

    // The walk covers every advertised tool that authors a spec.
    const advertised = (await client.listTools()).tools.map((t) => t.name)
      .filter((n) => /^sdd_(update|delete|rename|move|set|add|define|write)_/.test(n) && !NOT_SPEC_AUTHORING.has(n));
    expect(advertised.filter((n) => !(n in calls)), 'a write tool the walk does not cover').toEqual([]);

    for (const [tool, argsList] of Object.entries(calls)) {
      for (const args of argsList) {
        const result = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
        const text = result.content?.map((c) => c.text ?? '').join('\n') ?? '';
        expect(result.isError, `${tool} ${JSON.stringify(args)} answered: ${text}`).toBe(true);
        expect(text, `${tool} ${JSON.stringify(args)}`).toMatch(/lives in another project/);
        expect(text, `${tool} names the member's folder`).toMatch(/services\/payments/);
      }
    }
    invalidateSpecCache();
    expect(files(member)).toEqual(before);
  }, 120_000);
});
