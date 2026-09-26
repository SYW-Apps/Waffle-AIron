import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { runExternals, UnknownExternalsActionError } from '../../src/commands/externals.js';
import { runSurface } from '../../src/commands/surface.js';
import { createMcpServer } from '../../src/mcp/server.js';

// ---------------------------------------------------------------------------
// `wairon externals` and the sdd_pin_externals / sdd_get_externals_status
// tools, over a small real family: a root that mounts a billing member and
// declares it as an external it re-exports nothing from.
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z';
const dump = (spec: Record<string, unknown>): string =>
  yaml.dump({ schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS, ...spec }, { noRefs: true, lineWidth: 200 });

function write(root: string, rel: string, text: string): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function family(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-ext-cli-'));
  const project = (id: string, name: string, externals?: Record<string, unknown>): string => dump({
    id, name, targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }], rules: {},
    extensions: { packs: [], useGlobalPacks: false }, ...(externals ? { externals } : {}),
  });
  write(root, '.wai/project.yaml', project('fleetworks', 'FleetWorks', { billing: {}, ledger: {} }));
  write(root, '.wai/specs/.index.yaml', dump({ name: 'FleetWorks', vision: 'v' }));
  write(root, '.wai/specs/subsystems/billing.yaml', dump({ id: 'billing', name: 'Billing', description: 'd', parentSystem: 'FleetWorks', projectPath: 'packages/billing' }));
  write(root, 'packages/billing/.wai/project.yaml', project('billing', 'Billing Service'));
  write(root, 'packages/billing/.wai/specs/.index.yaml', dump({ name: 'BillingService', vision: 'v', publicInterfaces: [{ from: 'billing', component: 'invoice-portal', as: 'invoicing', audience: 'project', type: 'REST' }] }));
  write(root, 'packages/billing/.wai/specs/subsystems/billing.yaml', dump({ id: 'billing', name: 'Billing', description: 'd', parentSystem: 'BillingService', publicInterfaces: [{ component: 'invoice-portal', type: 'REST', details: 'd' }] }));
  write(root, 'packages/billing/.wai/specs/components/invoice-portal.yaml', dump({ id: 'invoice-portal', name: 'Invoice Portal', description: 'd', subsystem: 'billing', componentType: 'Portal', portalType: 'HTTP_API', owns: [], dependsOn: [] }));
  invalidateSpecCache();
  setProjectRoot(root);
  return root;
}

describe('wairon externals and the externals MCP tools', () => {
  let root: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
    root = undefined;
  });

  it('pin, list and status answer as JSON; an unknown action is refused', async () => {
    root = family();
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { out.push(String(chunk)); return true; });

    await runExternals('pin', [], { json: true });
    const pins = JSON.parse(out.pop()!);
    expect(pins.map((p: any) => [p.alias, p.outcome])).toEqual([['billing', 'pinned'], ['ledger', 'unresolved']]);
    expect(fs.existsSync(path.join(root, '.wai', 'externals', 'billing.yaml'))).toBe(true);

    await runExternals('list', [], { json: true });
    const rows = JSON.parse(out.pop()!);
    expect(rows[0]).toMatchObject({ alias: 'billing', sourceKind: 'family', relation: 'member', audience: 'project' });

    await runExternals('status', [], { json: true });
    const statuses = JSON.parse(out.pop()!);
    expect(statuses[0]).toMatchObject({ alias: 'billing', pinned: true, reachable: true, stale: false });
    expect(statuses[1]).toMatchObject({ alias: 'ledger', sourceKind: 'unresolved', reachable: false });

    await expect(runExternals('sync', [])).rejects.toThrow(UnknownExternalsActionError);
  });

  it('wairon surface pin and surface externals print a deprecation line first', async () => {
    root = family();
    const warned: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args.join(' ')); });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSurface('externals');
    await runSurface('pin');
    expect(warned.some((w) => w.includes('`wairon surface externals` is deprecated'))).toBe(true);
    expect(warned.some((w) => w.includes('`wairon surface pin` is deprecated'))).toBe(true);
  });

  it('sdd_pin_externals and sdd_get_externals_status answer with structured content; the old discovery tool says it is deprecated', async () => {
    root = family();
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'externals-test', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.find((t) => t.name === 'sdd_list_external_interfaces')?.description).toMatch(/^DEPRECATED — .*sdd_pin_externals \/ sdd_get_externals_status/);
      const pinned: any = await client.callTool({ name: 'sdd_pin_externals', arguments: { aliases: ['billing'] } });
      expect(pinned.isError ?? false).toBe(false);
      expect(pinned.structuredContent.pins).toEqual([expect.objectContaining({ alias: 'billing', outcome: 'pinned' })]);
      const status: any = await client.callTool({ name: 'sdd_get_externals_status', arguments: {} });
      expect(status.structuredContent.statuses.map((s: any) => [s.alias, s.pinned])).toEqual([['billing', true], ['ledger', false]]);
      const refused: any = await client.callTool({ name: 'sdd_pin_externals', arguments: { aliases: ['crm'] } });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain('Unknown external alias "crm"');
    } finally {
      await client.close();
    }
  });
});
