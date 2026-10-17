/**
 * Round-10 trial findings on the MCP surface tools (solo-app, tinkerer —
 * dev.114), driven through the server in process. Every test here failed on
 * dev.114.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { pinExternals } from '../../src/core/surfaces.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';
import { projectYaml } from '../helpers/conformance-r6-trees';

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> };

const roots: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function scratch(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r10mcp-')));
  roots.push(dir);
  return dir;
}

function writeProject(dir: string, tree: FixtureTree, config: string): string {
  fs.mkdirSync(dir, { recursive: true });
  materializeFixtureProject(dir, { ...tree, files: { ...(tree.files ?? {}), '.wai/project.yaml': config } });
  return dir;
}

async function connectAt(dir: string): Promise<Client> {
  setProjectRoot(dir);
  invalidateSpecCache();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'surfaces-r10', version: '0.0.1' });
  clients.push(client);
  await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult & { text: string }> {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { ...r, text: (r.content ?? []).map((c) => c.text ?? '').join('\n') };
}

/** Linkshort's stats API: an HTTP Portal answering a record, exported to other projects with the record. */
function statsApi(): FixtureTree {
  return {
    system: { name: 'Linkshort', vision: 'Short links and their statistics.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'stats', component: 'stats_portal', as: 'stats_api', audience: 'instance' }] },
    subsystems: [{ id: 'stats', description: 'Statistics.', publicInterfaces: [{ component: 'stats_portal', details: 'The stats API.' }] }],
    components: [{ id: 'stats_portal', componentType: 'Portal', transport: 'HTTP', description: 'The stats API.', invokedBy: { kind: 'entry', caller: 'The dashboard, over HTTP' } }],
    interfaces: [{ id: 'istats_portal', component: 'stats_portal', methods: [
      { name: 'getStats', description: 'Stats of one code.', params: [{ name: 'shortCode', type: 'string' }], returns: 'code_stats', effect: 'read', endpoint: { transport: 'HTTP', method: 'GET', path: '/stats/{shortCode}' } },
      { name: 'getTop', description: 'The top codes.', params: [], returns: 'int', effect: 'read', endpoint: { transport: 'HTTP', method: 'GET', path: '/stats/top' } },
    ] }],
    implementations: [{ id: 'stats_portal_impl', contract: 'istats_portal', methods: ['getStats', 'getTop'].map((name) => ({ name, narrative: [{ stepNumber: 1, description: 'Answer', type: 'return', outcome: 'success' }] })) }],
    types: [{ id: 'code_stats', kind: 'value-object', subsystem: 'stats', name: 'CodeStats', description: 'Stats of a code.', fields: [{ name: 'hits', type: 'int' }] }],
  };
}

/** The dashboard: its client Adapter calls getStats over HTTP. */
function dashboard(): FixtureTree {
  return {
    system: { name: 'Dashboard', vision: 'Shows link statistics.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'board', description: 'The board.' }],
    components: [{ id: 'stats_client', componentType: 'Adapter', description: 'Reads the stats over HTTP.', dependsOn: ['linkshort::stats_api'], invokedBy: { kind: 'runtime', caller: 'The board refresh timer the composition root registers' } }],
    interfaces: [{ id: 'istats_client', component: 'stats_client', methods: [{ name: 'refresh', description: 'Refresh one code.', params: [{ name: 'code', type: 'string' }], returns: 'int', effect: 'io' }] }],
    implementations: [{ id: 'stats_client_impl', contract: 'istats_client', methods: [{ name: 'refresh', detail: 'intent', intent: 'Reads the stats of one code.', calls: ['linkshort::stats_api.getStats'] }] }],
  };
}

function pinnedPair(): { producer: string; consumer: string } {
  const folder = scratch();
  const producer = writeProject(path.join(folder, 'linkshort'), statsApi(), projectYaml('linkshort'));
  const consumer = writeProject(path.join(folder, 'dashboard'), dashboard(), projectYaml('dashboard', { externals: { linkshort: { project: 'linkshort', source: { path: '../linkshort' } } } }));
  setProjectRoot(consumer);
  invalidateSpecCache();
  expect(pinExternals().map((p) => p.outcome)).toEqual(['pinned']);
  return { producer, consumer };
}

describe('3b. an endpoint move names the consumers it breaks, as a rename does (tinkerer)', () => {
  it('the dry run names the public name and the consumer calling the moved verb', async () => {
    const { producer } = pinnedPair();
    const client = await connectAt(producer);
    const r = await call(client, 'sdd_set_endpoints', { interface: 'istats_portal', endpoints: [{ method: 'getStats', transport: 'HTTP', httpMethod: 'GET', path: '/v2/stats/{shortCode}' }], dryRun: true, search: ['..'] });
    expect(r.isError, r.text).toBeFalsy();
    // Round 10: no breaks section — "none of the tools names the dashboard as broken by the path move".
    expect(r.text).toMatch(/PUBLISHED as: stats_api \(getStats\)[^\n]* — the route of each would move/);
    expect(r.text).toMatch(/BREAKS 1 consumer\(s\)[^\n]*\n- dashboard \(externals\.linkshort\)[^\n]*stats_api\.getStats in stats_client/);
    expect(r.structuredContent).toMatchObject({ rerouted: true, published: expect.arrayContaining([expect.objectContaining({ publicName: 'stats_api', members: ['getStats'] })]), breaks: [expect.objectContaining({ project: 'dashboard' })] });
  });

  it('a route nobody calls moves with the public name named and no consumer broken; a first binding names none', async () => {
    const { producer } = pinnedPair();
    const client = await connectAt(producer);
    const r = await call(client, 'sdd_set_endpoints', { interface: 'istats_portal', endpoints: [{ method: 'getTop', transport: 'HTTP', httpMethod: 'GET', path: '/v2/stats/top' }], dryRun: true, search: ['..'] });
    expect(r.text).toContain('PUBLISHED as: stats_api (getTop)');
    expect(r.text).toContain('No consumer in reach uses it');
    const same = await call(client, 'sdd_set_endpoints', { interface: 'istats_portal', endpoints: [{ method: 'getTop', transport: 'HTTP', httpMethod: 'GET', path: '/stats/top' }], dryRun: true, search: ['..'] });
    expect(same.text).not.toContain('PUBLISHED as');
  });
});

describe('4. sdd_get_spec reads an external\'s pinned contract and types by alias::name (solo-app, tinkerer)', () => {
  it('no kind, with methods: the pinned contract entry, narrowed — never "No spec of any kind"', async () => {
    const { consumer } = pinnedPair();
    const client = await connectAt(consumer);
    const r = await call(client, 'sdd_get_spec', { id: 'linkshort::stats_api', methods: ['getStats'] });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ kind: 'interface', spec: { id: 'stats_api', methods: [{ name: 'getStats' }] }, partialResult: { shown: ['getStats'], omitted: 1 }, pinnedSnapshot: { alias: 'linkshort', readOnly: true } });
    const asInterface = await call(client, 'sdd_get_spec', { kind: 'interface', id: 'linkshort::stats_api', methods: ['getStats'] });
    expect(asInterface.isError, asInterface.text).toBeFalsy();
    const unknown = await call(client, 'sdd_get_spec', { kind: 'interface', id: 'linkshort::stats_api', methods: ['nope'] });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('does not declare "nope". It declares: getStats, getTop');
  });

  it('a type the pinned contract carries but does not export reads from the pin, saying what carries it', async () => {
    const { consumer } = pinnedPair();
    const client = await connectAt(consumer);
    const r = await call(client, 'sdd_get_spec', { kind: 'type', id: 'linkshort::code_stats' });
    // Round 10: `Spec of kind "type" with ID "linkshort::code_stats" does not exist.`
    expect(r.isError, r.text).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ kind: 'type', spec: { id: 'code_stats', fields: [{ name: 'hits', type: 'int' }] } });
    expect((r.structuredContent as { pinnedSnapshot: { note: string } }).pinnedSnapshot.note).toContain('carried by "stats_api"');
    const inferred = await call(client, 'sdd_get_spec', { id: 'linkshort::code_stats' });
    expect(inferred.structuredContent).toMatchObject({ kind: 'type' });
  });
});
