import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// docs/cli.md's MCP tool table is the local server's tool list.
//
// The table said "38 tools", listed 40, and the server served 44: four tools
// that other docs describe were missing from the one table that claims to be
// the list. Both sides are derived here — the server's from the tools the
// LOCAL stdio server registers (listed over MCP, from source), the doc's from
// the table and its count sentence — so a tool added to the server without a
// row, or a row naming a tool that is gone, fails this test. Never hard-code
// the count: other work adds tools.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_MD = path.join(REPO_ROOT, 'docs', 'cli.md');
const now = '2026-10-07T10:00:00Z';

/** The tool names the table lists, and the count its lead sentence states. */
function documentedTools(): { names: string[]; stated: number } {
  const lines = fs.readFileSync(CLI_MD, 'utf8').split(/\r?\n/);
  const lead = lines.findIndex((l) => /^The local server offers \d+ tools:/.test(l));
  expect(lead, 'docs/cli.md: the "The local server offers N tools:" sentence').toBeGreaterThan(-1);
  const stated = Number(/offers (\d+) tools/.exec(lines[lead])![1]);
  const names: string[] = [];
  let i = lead + 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  for (; i < lines.length && lines[i].startsWith('|'); i++) {
    const cells = lines[i].split('|').map((c) => c.trim());
    // | Group | Tools | — the second cell holds the backticked names.
    const tools = cells[2] ?? '';
    for (const m of tools.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) names.push(m[1]);
  }
  return { names, stated };
}

async function servedTools(): Promise<{ names: string[]; client: Client }> {
  const server = createMcpServer({});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cli-tool-table-test', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  return { names: tools.map((t) => t.name), client };
}

describe('docs/cli.md MCP tool table', () => {
  let root: string | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    if (client) await client.close();
    client = undefined;
    setProjectRoot(null);
    invalidateSpecCache();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('lists exactly the tools the local server registers, and counts them right', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-tool-table-'));
    fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'tool-table', projectType: 'backend',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: {}, createdAt: now, updatedAt: now,
    }));
    setProjectRoot(root);

    const served = await servedTools();
    client = served.client;
    const doc = documentedTools();

    const servedSet = [...new Set(served.names)].sort();
    const documented = [...doc.names].sort();
    // No row twice.
    expect(documented.filter((n, i) => documented.indexOf(n) !== i), 'tools listed twice in the table').toEqual([]);
    expect({
      missingFromTable: servedSet.filter((n) => !documented.includes(n)),
      notServed: documented.filter((n) => !servedSet.includes(n)),
    }).toEqual({ missingFromTable: [], notServed: [] });
    expect(doc.stated, 'the "offers N tools" count').toBe(servedSet.length);
  });
});
