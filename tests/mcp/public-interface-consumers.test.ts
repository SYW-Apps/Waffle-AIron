/**
 * public_interface.consumers through every MCP door that writes a published
 * surface: the subsystems a surface is published to must survive
 * sdd_add_subsystem, sdd_set_public_interfaces and sdd_update_spec — an input
 * schema that does not name the field strips it before the handler sees it, so
 * a round-trip is the only proof the door can say it at all.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import { invalidateSpecCache, loadSubsystemSpec } from '../../src/core/specs.js';
import { createMcpServer } from '../../src/mcp/server.js';

const now = new Date().toISOString();
let roots: string[] = [];
let clients: Client[] = [];

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: any };
const textOf = (result: ToolResult): string => result.content?.[0]?.text ?? '';

async function bound(): Promise<(name: string, args: Record<string, unknown>) => Promise<ToolResult>> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-pi-consumers-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: 'pi-consumers', targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  });
  setProjectRoot(root);
  invalidateSpecCache();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pi-consumers-test', version: '0.0.1' });
  await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  const ok = (r: ToolResult): void => expect(r.isError ?? false, textOf(r)).toBe(false);
  ok(await call('sdd_initialize_system', { name: 'Clinic', vision: 'books visits' }));
  ok(await call('sdd_add_subsystem', { id: 'claims', name: 'Claims', description: 'insurance claims' }));
  return call;
}

const stored = () => {
  invalidateSpecCache();
  return loadSubsystemSpec('billing')?.publicInterfaces;
};

afterEach(async () => {
  for (const client of clients) await client.close().catch(() => undefined);
  clients = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
  invalidateSpecCache();
});

const restricted = { type: 'Custom', details: 'raw invoice writes', component: 'invoice_portal', consumers: ['claims'] };

describe('public_interface.consumers round-trips through the MCP doors', () => {
  it('sdd_add_subsystem stores the consumers an entry states', async () => {
    const call = await bound();
    const result = await call('sdd_add_subsystem', {
      id: 'billing', name: 'Billing', description: 'invoicing', publicInterfaces: [restricted],
    });
    expect(result.isError ?? false, textOf(result)).toBe(false);
    expect(stored()).toEqual([restricted]);
  });

  it('sdd_set_public_interfaces stores consumers, and a restated entry without them publishes it to anyone again', async () => {
    const call = await bound();
    await call('sdd_add_subsystem', { id: 'billing', name: 'Billing', description: 'invoicing' });

    const set = await call('sdd_set_public_interfaces', { subsystem: 'billing', publicInterfaces: [restricted] });
    expect(set.isError ?? false, textOf(set)).toBe(false);
    expect(stored()).toEqual([restricted]);

    const again = await call('sdd_set_public_interfaces', { subsystem: 'billing', publicInterfaces: [restricted] });
    expect(again.structuredContent.written).toBe(false);

    // A replacement, not a merge: the list no longer says consumers, so the
    // stored entry must not keep them.
    const { consumers: _dropped, ...open } = restricted;
    const opened = await call('sdd_set_public_interfaces', { subsystem: 'billing', publicInterfaces: [open] });
    expect(opened.isError ?? false, textOf(opened)).toBe(false);
    expect(stored()).toEqual([open]);
  });

  it('sdd_update_spec merges consumers into an entry by its identity', async () => {
    const call = await bound();
    await call('sdd_add_subsystem', {
      id: 'billing', name: 'Billing', description: 'invoicing',
      publicInterfaces: [{ type: 'Custom', details: 'raw invoice writes', component: 'invoice_portal' }],
    });
    const result = await call('sdd_update_spec', {
      kind: 'subsystem', id: 'billing',
      delta: { publicInterfaces: [{ component: 'invoice_portal', consumers: ['claims'] }] },
    });
    expect(result.isError ?? false, textOf(result)).toBe(false);
    expect(stored()).toEqual([restricted]);
  });
});

describe('re-export entries round-trip through sdd_set_public_interfaces', () => {
  const own = { type: 'REST', details: 'invoice API', component: 'invoice_portal' };
  const reexport = { from: 'claims', component: 'claim_portal', as: 'claims-api' };
  const wildcard = { from: 'claims' };

  it('stores a named re-export and a wildcard without type or details, and a replacement drops them again', async () => {
    const call = await bound();
    await call('sdd_add_subsystem', { id: 'billing', name: 'Billing', description: 'invoicing' });

    const set = await call('sdd_set_public_interfaces', { subsystem: 'billing', publicInterfaces: [own, reexport, wildcard] });
    expect(set.isError ?? false, textOf(set)).toBe(false);
    expect(stored()).toEqual([own, reexport, wildcard]);

    const replaced = await call('sdd_set_public_interfaces', { subsystem: 'billing', publicInterfaces: [own] });
    expect(replaced.isError ?? false, textOf(replaced)).toBe(false);
    expect(stored()).toEqual([own]);
  });

  it('refuses an own component entry that states no type or details', async () => {
    const call = await bound();
    await call('sdd_add_subsystem', { id: 'billing', name: 'Billing', description: 'invoicing' });
    const result = await call('sdd_set_public_interfaces', { subsystem: 'billing', publicInterfaces: [{ component: 'invoice_portal' }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/type/);
    expect(stored()).toEqual([]);
  });
});
