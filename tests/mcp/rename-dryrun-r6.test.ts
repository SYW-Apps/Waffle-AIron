import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';

// ---------------------------------------------------------------------------
// Round-6 trial findings: sdd_rename_param and sdd_rename_field had no dry run
// and named no consumer; sdd_rename_component and sdd_rename_type had no dry
// run either. Each now takes `dryRun`, and the param and field renames take
// `search` to name the consumer checkouts outside the family they break.
// ---------------------------------------------------------------------------

describe('rename tools publish a dry run', () => {
  it('sdd_rename_component/type take dryRun; sdd_rename_param/field take dryRun and search', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer().connect(serverSide);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    const tools = (await client.listTools()).tools;
    const props = (name: string): string[] => Object.keys(tools.find((t) => t.name === name)?.inputSchema.properties ?? {}).sort();
    expect(props('sdd_rename_component')).toEqual(['dryRun', 'id', 'newId']);
    expect(props('sdd_rename_type')).toEqual(['dryRun', 'id', 'newId']);
    expect(props('sdd_rename_field')).toEqual(['dryRun', 'field', 'id', 'newName', 'search']);
    expect(props('sdd_rename_param')).toEqual(['dryRun', 'id', 'method', 'newName', 'param', 'search']);
    await client.close();
  });
});
