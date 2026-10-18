import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import { write as writeStamp } from '../../src/upgrade/adapters/stamp.js';
import { WAIRON_MAJOR } from '../../src/config/defaults.js';

// ---------------------------------------------------------------------------
// mcp_server.create — the standing guard. A tool call whose bound tree an older
// wairon major wrote runs nothing and answers that the human must run
// `wairon upgrade`; a current tree passes; a tree upgraded while the server
// runs passes on the very next call (the guard is judged per call).
// ---------------------------------------------------------------------------

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const textOf = (result: ToolResult): string => result.content?.[0]?.text ?? '';

const clients: Client[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  setProjectRoot(null);
  invalidateSpecCache();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A project root; stamped with the running major unless `major` says otherwise (null: no stamp). */
function project(major: number | null): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-standing-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  const now = new Date().toISOString();
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', ...(major === null ? {} : { waironMajor: major }), name: 'standing',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }], rules: {}, createdAt: now, updatedAt: now,
  });
  setProjectRoot(root);
  invalidateSpecCache();
  return root;
}

async function connect(): Promise<(name: string, args: Record<string, unknown>) => Promise<ToolResult>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'standing-guard-test', version: '0.0.1' });
  await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return async (name, args) => (await client.callTool({ name, arguments: args })) as ToolResult;
}

describe('the standing guard', () => {
  it('an older tree: every tool runs nothing and names `wairon upgrade`, which the assistant never runs', async () => {
    const root = project(WAIRON_MAJOR - 1);
    const call = await connect();
    const write = await call('sdd_initialize_system', { name: 'Shop', vision: 'sells things' });
    expect(write.isError).toBe(true);
    expect(textOf(write)).toMatch(/^Error: sdd_initialize_system refused — /);
    expect(textOf(write)).toContain('older wairon major');
    expect(textOf(write)).toContain('`wairon upgrade`');
    expect(textOf(write)).toContain('never runs it');
    expect(fs.readdirSync(path.join(root, '.wai', 'specs'))).toEqual([]);
    const read = await call('sdd_get_status', {});
    expect(read.isError).toBe(true);
    expect(textOf(read)).toContain('`wairon upgrade`');
  });

  it('an unstamped tree reads as the oldest major and is refused the same way', async () => {
    project(null);
    const call = await connect();
    const status = await call('sdd_get_status', {});
    expect(status.isError).toBe(true);
    expect(textOf(status)).toContain('`wairon upgrade`');
  });

  it('a tree a newer major wrote is refused with the standing advice', async () => {
    project(WAIRON_MAJOR + 1);
    const call = await connect();
    const status = await call('sdd_get_status', {});
    expect(status.isError).toBe(true);
    expect(textOf(status)).toContain('cannot be served by this wairon');
    expect(textOf(status)).not.toContain('Ask the human to run `wairon upgrade`');
  });

  it('a current tree passes', async () => {
    project(WAIRON_MAJOR);
    const call = await connect();
    const status = await call('sdd_get_status', {});
    expect(status.isError ?? false).toBe(false);
  });

  it('a tree upgraded while the server runs passes on the next call', async () => {
    const root = project(WAIRON_MAJOR - 1);
    const call = await connect();
    expect((await call('sdd_get_status', {})).isError).toBe(true);
    writeStamp(root, WAIRON_MAJOR);
    invalidateSpecCache();
    expect((await call('sdd_get_status', {})).isError ?? false).toBe(false);
  });

  it('a bound root without a project.yaml is not refused by the guard', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-standing-bare-'));
    dirs.push(root);
    setProjectRoot(root);
    invalidateSpecCache();
    const call = await connect();
    const init = await call('sdd_initialize_system', { name: 'Shop', vision: 'sells things' });
    expect(textOf(init)).not.toContain('older wairon major');
  });
});
