/**
 * Second v7 test round (M4, m5): a project started over MCP alone, and a delta
 * whose `methods` is not a list.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { materializeFixtureProject } from '../rules-matrix/harness.js';
import { createMcpServer } from '../../src/mcp/server.js';

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: Record<string, any> };

const roots: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

async function connectAt(dir: string): Promise<Client> {
  setProjectRoot(dir);
  invalidateSpecCache();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mcp-only-start', version: '0.0.1' });
  clients.push(client);
  await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult & { text: string }> {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { ...r, text: (r.content ?? []).map((c) => c.text ?? '').join('\n') };
}

function emptyDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-mcp-only-')));
  roots.push(dir);
  return dir;
}

const L0 = { name: 'Shop Platform', vision: 'Sells things.', targetLanguage: 'typescript' };

describe('sdd_initialize_system in a folder with no project configuration', () => {
  it('falls back to <slug>-project, as wairon init does, when the id grammar refuses the slug', async () => {
    const dir = emptyDir();
    const client = await connectAt(dir);
    const r = await call(client, 'sdd_initialize_system', { ...L0, name: 'con' });
    expect(r.isError, r.text).toBeFalsy();
    const config = yaml.load(fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8')) as Record<string, unknown>;
    expect(config.id).toBe('con-project');
    expect(r.text).toContain('"con-project"');
  });

  it('creates the default configuration (id = the name slugified), names the file in a notice, and the tree validates', async () => {
    const dir = emptyDir();
    const client = await connectAt(dir);
    const r = await call(client, 'sdd_initialize_system', L0);
    expect(r.isError, r.text).toBeFalsy();
    const file = path.join(dir, '.wai', 'project.yaml');
    expect(fs.existsSync(file)).toBe(true);
    const config = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(config.id).toBe('shop-platform');
    expect(config.name).toBe('Shop Platform');
    expect(r.structuredContent?.notices.join('\n')).toMatch(/\.wai[\/]project\.yaml/);
    // The L0 written is the one the caller stated, and it counts as new.
    expect(r.structuredContent?.replacedExisting).toBe(false);
    const sys = await call(client, 'sdd_get_spec', { kind: 'system', id: 'system' });
    expect(sys.text).toContain('Sells things.');
    const v = await call(client, 'sdd_validate_tree', {});
    expect(v.text).not.toMatch(/No wairon project found/i);
  });

  it('leaves an existing configuration exactly as it is', async () => {
    const dir = emptyDir();
    const client = await connectAt(dir);
    await call(client, 'sdd_initialize_system', L0);
    const file = path.join(dir, '.wai', 'project.yaml');
    const edited = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const custom = yaml.dump({ ...edited, id: 'mine', name: 'Mine' });
    fs.writeFileSync(file, custom);
    const r = await call(client, 'sdd_initialize_system', L0);
    expect(r.isError, r.text).toBeFalsy();
    expect(fs.readFileSync(file, 'utf8')).toBe(custom);
    expect((r.structuredContent?.notices ?? []).join('\n')).not.toMatch(/project\.yaml/);
  });

  it('a second run does not announce the configuration again', async () => {
    const dir = emptyDir();
    const client = await connectAt(dir);
    await call(client, 'sdd_initialize_system', L0);
    const again = await call(client, 'sdd_initialize_system', L0);
    expect(again.structuredContent?.replacedExisting).toBe(true);
    expect((again.structuredContent?.notices ?? []).join('\n')).not.toMatch(/project\.yaml/);
  });
});

describe('sdd_update_spec with delta.methods that is not a list', () => {
  it('refuses with the expected shape and writes nothing', async () => {
    const dir = emptyDir();
    materializeFixtureProject(dir, {
      system: { name: 'shop', vision: 'Shop.', targetLanguage: 'TypeScript' },
      subsystems: [{ id: 'core', status: 'complete' }],
      components: [{ id: 'core_store', subsystem: 'core', componentType: 'Store', status: 'complete' }],
      interfaces: [{ id: 'icore_store', component: 'core_store', methods: [{ name: 'get', description: 'Get.', params: [], returns: 'string', effect: 'none' }] }],
      implementations: [{ id: 'icore_store_impl', contract: 'icore_store', methods: [{ name: 'get' }] }],
    });
    const client = await connectAt(dir);
    const specs = path.join(dir, '.wai', 'specs');
    const snap = (): string => JSON.stringify(fs.readdirSync(specs, { recursive: true }).map((f) => String(f)).sort().map((f) => { const p = path.join(specs, f); return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : f; }));
    const before = snap();
    for (const kind of ['interface', 'implementation'] as const) {
      const id = kind === 'interface' ? 'icore_store' : 'icore_store_impl';
      const r = await call(client, 'sdd_update_spec', { kind, id, delta: { methods: { get: { description: 'x' } } } });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/methods/);
      expect(r.text).toMatch(/list/);
      expect(r.text).toMatch(/name/);
      expect(r.text).not.toMatch(/TypeError|is not a function/);
    }
    expect(snap()).toBe(before);
  });
});
