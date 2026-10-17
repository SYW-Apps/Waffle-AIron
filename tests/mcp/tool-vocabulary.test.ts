import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';

// ---------------------------------------------------------------------------
// The published MCP tool surface speaks the block vocabulary: Query is
// authorable, the retired Specialist and Gateway are not, logic declares its
// dependencyClass, and a declared finding code is anchored in the method's
// source file as a string literal or a property-access name.
// ---------------------------------------------------------------------------

type PublishedTool = { name: string; description?: string; inputSchema: { properties?: Record<string, any>; required?: string[] } };

describe('MCP tool vocabulary', () => {
  let client: Client;
  let tools: PublishedTool[];

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'tool-vocabulary-test', version: '0.0.1' });
    await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);
    tools = (await client.listTools()).tools as PublishedTool[];
  });

  afterAll(async () => {
    try { await client?.close(); } catch { /* already gone */ }
  });

  const tool = (name: string): PublishedTool => {
    const found = tools.find((t) => t.name === name);
    expect(found, `${name} is not published`).toBeDefined();
    return found!;
  };

  it('sdd_add_component authors Query and never a retired stereotype', () => {
    const componentTypes: string[] = tool('sdd_add_component').inputSchema.properties!.componentType.enum;
    expect(componentTypes).toContain('Query');
    expect(componentTypes).toContain('Repository');
    expect(componentTypes).not.toContain('Specialist');
    expect(componentTypes).not.toContain('Gateway');
  });

  it('sdd_add_component says what replaces the retired stereotypes', () => {
    const description = tool('sdd_add_component').description ?? '';
    expect(description).toMatch(/Specialist and Gateway are retired/);
    expect(description).toMatch(/an Orchestrator with a dependencyClass/);
    expect(description).toMatch(/a Portal with the gateway variant/);
  });

  it('sdd_add_component takes an optional, Orchestrator-only dependencyClass of pure or read', () => {
    const { properties, required } = tool('sdd_add_component').inputSchema;
    expect(properties!.dependencyClass.enum).toEqual(['pure', 'read']);
    expect(properties!.dependencyClass.description).toMatch(/Orchestrator-only/);
    expect(properties!.dependencyClass.description).toMatch(/unset = a workflow/);
    expect(required ?? []).not.toContain('dependencyClass');
  });

  it('says a declared finding code is anchored as a string literal or a property-access name', () => {
    const anchored = /anchored in the method's source file, as a string literal or a property-access name \(UNREALIZED_FINDING\)/;
    const define = tool('sdd_define_interface');
    expect(define.description).toMatch(anchored);
    expect(define.inputSchema.properties!.methods.items.properties.findings.description).toMatch(anchored);
    expect(JSON.stringify(tools)).not.toMatch(/must appear as a string literal/);
  });
});
