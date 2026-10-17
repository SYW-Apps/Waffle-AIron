import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ---------------------------------------------------------------------------
// The network declaration as a tool, not a hand edit (round-2 trials: the
// assistant had to ask the human to edit project.yaml), and an Adapter's
// transport taken from the Portal it calls. Driven through the real stdio
// server and the real CLI.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
const now = new Date().toISOString();

const networkOf = (dir: string): unknown => (yaml.load(fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf-8')) as Record<string, unknown>).network;

describe('sdd_set_network and the Adapter transport inference', () => {
  let projDir: string;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const result: any = await client.callTool({ name, arguments: args });
    expect(result.isError ?? false, `tool failed: ${JSON.stringify(result.content)}`).toBe(false);
    return result;
  };

  beforeAll(async () => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-network-tools-'));
    fs.mkdirSync(path.join(projDir, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.wai', 'project.yaml'), [
      "schemaVersion: '1.0.0'",
      'name: network-tools',
      'targets: []',
      `createdAt: '${now}'`,
      `updatedAt: '${now}'`,
    ].join('\n'));
    client = new Client({ name: 'wairon-network-tools-test', version: '0.0.1' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [TSX_CLI, WAIRON_CLI, 'mcp', 'serve'],
      cwd: projDir,
      stderr: 'ignore',
    }));
    await call('sdd_initialize_system', { name: 'Couriers', vision: 'parcel tracking', targetLanguage: 'typescript' });
    await call('sdd_add_subsystem', { id: 'tracking', name: 'Tracking', description: 'The tracking service' });
    await call('sdd_add_subsystem', { id: 'depot', name: 'Depot', description: 'The depot workers' });
  }, 90_000);

  afterAll(async () => {
    try { await client?.close(); } catch { /* already gone */ }
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  it('declares, re-declares (nothing written) and removes the network in project.yaml', async () => {
    const declared = await call('sdd_set_network', { declared: true, description: 'The courier cluster' });
    expect(declared.structuredContent).toMatchObject({ written: true, declared: true });
    expect(networkOf(projDir)).toEqual({ description: 'The courier cluster' });
    const again = await call('sdd_set_network', { declared: true, description: 'The courier cluster' });
    expect(again.structuredContent).toMatchObject({ written: false });
    const removed = await call('sdd_set_network', { declared: false });
    expect(removed.structuredContent).toMatchObject({ written: true, declared: false });
    expect(networkOf(projDir)).toBeUndefined();
    const plain = await call('sdd_set_network', { declared: true });
    expect(plain.structuredContent).toMatchObject({ written: true });
    expect(networkOf(projDir)).toBe(true);
    await call('sdd_set_network', { declared: false });
  }, 60_000);

  it('fills an Adapter\'s transport in from the Portal it calls, and says so', async () => {
    await call('sdd_add_component', {
      id: 'tracking_api', name: 'Tracking API', description: 'The tracking service API', subsystem: 'tracking',
      componentType: 'Portal', transport: 'HTTP',
    });
    const added = await call('sdd_add_component', {
      id: 'tracking_client', name: 'Tracking client', description: 'Reports scans to the tracking service', subsystem: 'depot',
      componentType: 'Adapter', dependsOn: ['tracking_api'],
    });
    expect(added.content[0].text).toMatch(/Its transport, HTTP, was taken from the Portal it calls/);
    const spec = await call('sdd_get_spec', { kind: 'component', id: 'tracking_client' });
    expect(spec.structuredContent.spec.transport).toBe('HTTP');
  }, 60_000);
});

describe('wairon network declare | undeclare', () => {
  it('writes and removes the declaration without a hand edit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-network-declare-'));
    try {
      fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), ["schemaVersion: '1.0.0'", 'name: declare-cli', 'targets: []', `createdAt: '${now}'`, `updatedAt: '${now}'`].join('\n'));
      const run = (...args: string[]): string => execFileSync(process.execPath, [TSX_CLI, WAIRON_CLI, ...args], { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(run('network', 'declare', '--description', 'The shop cluster')).toMatch(/Declared this project's network/);
      expect(networkOf(dir)).toEqual({ description: 'The shop cluster' });
      expect(run('network', 'undeclare')).toMatch(/Removed this project's network declaration/);
      expect(networkOf(dir)).toBeUndefined();
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows file locks */ }
    }
  }, 120_000);
});
