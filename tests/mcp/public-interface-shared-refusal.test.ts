/**
 * sdd_set_public_interfaces refuses what public-surface-shared would refuse at
 * validate: a shared entry whose component is not an Adapter is never written.
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
import { WAIRON_MAJOR } from '../../src/config/defaults.js';

const now = new Date().toISOString();
let roots: string[] = [];
let clients: Client[] = [];

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: any };
const textOf = (result: ToolResult): string => result.content?.[0]?.text ?? '';

async function bound(): Promise<(name: string, args: Record<string, unknown>) => Promise<ToolResult>> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-pi-shared-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', waironMajor: WAIRON_MAJOR, name: 'pi-shared', targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  });
  setProjectRoot(root);
  invalidateSpecCache();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pi-shared-test', version: '0.0.1' });
  await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  const ok = (r: ToolResult): void => expect(r.isError ?? false, textOf(r)).toBe(false);
  ok(await call('sdd_initialize_system', { name: 'Telemetry', vision: 'ingests readings' }));
  ok(await call('sdd_add_subsystem', { id: 'platform', name: 'Platform', description: 'shared I/O' }));
  ok(await call('sdd_add_component', { id: 'blob_files', name: 'Blob Files', description: 'reads and writes files', subsystem: 'platform', componentType: 'Adapter' }));
  ok(await call('sdd_add_component', { id: 'reading_store', name: 'Reading Store', description: 'holds readings', subsystem: 'platform', componentType: 'Store' }));
  return call;
}

afterEach(async () => {
  for (const client of clients) await client.close().catch(() => undefined);
  clients = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
  invalidateSpecCache();
});

const stored = () => {
  invalidateSpecCache();
  return loadSubsystemSpec('platform')?.publicInterfaces ?? [];
};

describe('sdd_set_public_interfaces: only an Adapter is published as shared', () => {
  it('refuses a Store published as shared, naming the code, and writes nothing', async () => {
    const call = await bound();
    const result = await call('sdd_set_public_interfaces', {
      subsystem: 'platform',
      publicInterfaces: [{ details: 'readings', component: 'reading_store', shared: true }],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/"reading_store" \(a Store\) as shared/);
    expect(textOf(result)).toContain('PUBLIC_INTERFACE_SHARED_NOT_ADAPTER');
    expect(stored()).toEqual([]);
  });

  it('stores an Adapter published as shared', async () => {
    const call = await bound();
    const result = await call('sdd_set_public_interfaces', {
      subsystem: 'platform',
      publicInterfaces: [{ details: 'file I/O', component: 'blob_files', shared: true }],
    });
    expect(result.isError ?? false, textOf(result)).toBe(false);
    expect(stored()).toEqual([expect.objectContaining({ component: 'blob_files', shared: true })]);
  });
});
