import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { lookupProject } from '../helpers/lookup-fixture.js';

// ---------------------------------------------------------------------------
// sdd_search_specs and sdd_find_references over MCP: the text is the small,
// agent-facing answer; the structured content carries the whole typed result.
// ---------------------------------------------------------------------------

interface Answer { text: string; structured: Record<string, any> }

async function ask(client: Client, name: string, args: Record<string, unknown>): Promise<Answer> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
  return { text, structured: (res.structuredContent ?? {}) as Record<string, any> };
}

describe('lookup tools', () => {
  let fixture: ReturnType<typeof lookupProject>;
  let client: Client;

  async function start(): Promise<void> {
    fixture = lookupProject();
    fixture.lock();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'lookup-test', version: '0.0.1' });
    await Promise.all([createMcpServer().connect(st), client.connect(ct)]);
  }

  afterEach(() => { fixture?.cleanup(); });

  it('advertises both tools as reads with output schemas', async () => {
    await start();
    const tools = (await client.listTools()).tools;
    for (const name of ['sdd_search_specs', 'sdd_find_references']) {
      const t = tools.find((x) => x.name === name);
      expect(t, name).toBeDefined();
      expect(t!.outputSchema).toBeDefined();
    }
  });

  it('search answers one line per match, and the whole result as structured content', async () => {
    await start();
    const a = await ask(client, 'sdd_search_specs', { query: 'src/ledger.ts' });
    expect(a.text).toContain('ledger');
    expect(a.text).toMatch(/Snapshot: searched/);
    expect(a.text.length).toBeLessThan(4096);
    expect(a.structured.result.matches.length).toBeGreaterThan(0);
    expect(a.structured.result.snapshot.searched.length).toBeGreaterThan(0);
    expect(a.structured.report).toBe(a.text);
  });

  it('search says how many more matches a limit cut', async () => {
    await start();
    const a = await ask(client, 'sdd_search_specs', { query: 'sync', limit: 1 });
    expect(a.structured.result.total).toBeGreaterThan(1);
    expect(a.structured.result.matches).toHaveLength(1);
    expect(a.text).toMatch(/\d+ more; raise limit or narrow the query/);
  });

  it('references writes groups cut to five, and expand widens a group', async () => {
    await start();
    for (let i = 0; i < 8; i++) {
      fixture.edit(`src/user${i}.ts`, `import { record } from './ledger.js';\nexport function u${i}(): void {\n  record('${i}');\n}\n`);
    }
    const target = 'ledger.record';
    const plain = await ask(client, 'sdd_find_references', { target });
    expect(plain.structured.result.target).not.toBeNull();
    const all = plain.structured.result.references.length;
    expect(all).toBeGreaterThan(5);
    expect(plain.text).toMatch(/impact:/);
    expect(plain.text).toMatch(/expand: \["[a-z-]+"\] for all \d+/);
    expect(plain.text.length).toBeLessThan(4096);
    const cut = /expand: \["([a-z-]+)"\] for all (\d+)/.exec(plain.text)!;
    const wide = await ask(client, 'sdd_find_references', { target, expand: [cut[1]] });
    expect(wide.text.length).toBeGreaterThan(plain.text.length);
    expect(wide.text).not.toContain(`expand: ["${cut[1]}"]`);
    // The structured result is whole either way.
    expect(wide.structured.result.references).toHaveLength(all);
  });

  it('an ambiguous target lists candidates and asks for one exact id', async () => {
    await start();
    const a = await ask(client, 'sdd_find_references', { target: 'sync' });
    expect(a.structured.result.target).toBeNull();
    expect(a.structured.result.candidates.length).toBeGreaterThan(1);
    expect(a.text).toMatch(/ambiguous/);
    expect(a.text).toMatch(/one exact id/);
  });

  it('references leaves prose mentions out unless includeText asks for them', async () => {
    await start();
    const prose = (a: Answer) => a.structured.result.references.filter((r: { kind: string; inTest: boolean }) => r.kind === 'mention' && !r.inTest);
    expect(prose(await ask(client, 'sdd_find_references', { target: 'ledger' }))).toEqual([]);
    expect(prose(await ask(client, 'sdd_find_references', { target: 'ledger', includeText: true })).length).toBeGreaterThan(0);
  });
});
