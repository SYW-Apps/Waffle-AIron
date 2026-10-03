import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { upsertPackSelection } from '../../src/core/index.js';
import {
  governanceMachine, bindRoot, editConfig, readConfig, writeSubsystem, writeComponent, type GovernanceMachine,
} from '../helpers/governance-fixture.js';

// ---------------------------------------------------------------------------
// The MCP surface of the governance stage: the read-only sdd_pack_impact tool
// (an agent proposes a pack with its report; the human applies it with
// `wairon pack use`), and sdd_add_member answering what scaffolding applied.
// Driven through a real MCP client over an in-memory transport.
// ---------------------------------------------------------------------------

let machine: GovernanceMachine | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  machine?.cleanup();
  machine = undefined;
});

async function connect(hostedTools = false): Promise<Client> {
  const server = createMcpServer({ buildStamp: null, hostedTools });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pack-impact-test', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return client;
}

function shop(): string {
  const m = (machine = governanceMachine());
  m.install('1.2.0');
  const dir = m.project('shop');
  writeSubsystem(dir, 'core');
  writeComponent(dir, 'core', 'engine');
  bindRoot(dir);
  return dir;
}

type Structured = Record<string, unknown> & { findings: { introduced: unknown[] }; doctrine: { change: string; subject: string; profile?: string }[] };

describe('sdd_pack_impact', () => {
  it('measures selecting an installed pack, writing nothing, with a structured PackImpact and a text rendering', async () => {
    const dir = shop();
    const before = fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8');
    const client = await connect();
    const result = await client.callTool({ name: 'sdd_pack_impact', arguments: { pack: 'acme-base' } });
    expect(result.isError).toBeFalsy();
    const impact = result.structuredContent as Structured;
    expect(impact).toMatchObject({ pack: 'acme-base', version: '1.2.0', direction: 'apply', governing: ['backend'] });
    expect(impact.doctrine.some((c) => c.change === 'loosened' && c.subject === 'UNUSED_COMPONENT' && c.profile === 'lenient')).toBe(true);
    expect(impact.findings.introduced.length).toBeGreaterThan(0);
    const textBlock = (result.content as { type: string; text: string }[])[0].text;
    expect(textBlock).toMatch(/Pack impact: acme-base v1\.2\.0 — measured as applied\. Nothing was written\./);
    expect(fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8')).toBe(before);
  });

  it('measures a pack the project applies exactly as asked as removed', async () => {
    const dir = shop();
    bindRoot(dir);
    upsertPackSelection({ name: 'acme-base', version: '1.2.0' });
    const client = await connect();
    const result = await client.callTool({ name: 'sdd_pack_impact', arguments: { pack: 'acme-base', version: '1.2.0' } });
    expect((result.structuredContent as Structured).direction).toBe('remove');
  });

  it('answers the resolver\'s reason as the tool error for a pack that does not resolve', async () => {
    shop();
    const client = await connect();
    const result = await client.callTool({ name: 'sdd_pack_impact', arguments: { pack: 'acme-base', version: '9.9.9' } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/PACK_VERSION_UNSATISFIED/);
  });

  it('is local only: the hosted data plane does not advertise it', async () => {
    shop();
    const local = (await (await connect()).listTools()).tools.map((t) => t.name);
    const hosted = (await (await connect(true)).listTools()).tools.map((t) => t.name);
    expect(local).toContain('sdd_pack_impact');
    expect(hosted).not.toContain('sdd_pack_impact');
  });
});

describe('sdd_add_member answers what scaffolding applied', () => {
  it('states the applied packs and the unsatisfiable requirements, as text and structured content', async () => {
    const dir = shop();
    editConfig(dir, (doc) => { doc.composition = { requirePolicies: [{ pack: 'acme-base', version: '^1.2' }, { pack: 'audit-trail', version: '^3' }] }; });
    bindRoot(dir);
    const client = await connect();
    const result = await client.callTool({ name: 'sdd_add_member', arguments: { alias: 'svc', source: 'services/svc', as: 'project' } });
    expect(result.isError).toBeFalsy();
    const creation = result.structuredContent as { configCreated: boolean; adopted: { name: string; version: string }[]; unadopted: { pack: string }[] };
    expect(creation.configCreated).toBe(true);
    expect(creation.adopted.map((s) => `${s.name}@${s.version}`)).toEqual(['acme-base@1.2.0']);
    expect(creation.unadopted.map((r) => r.pack)).toEqual(['audit-trail']);
    const textBlock = (result.content as { text: string }[])[0].text;
    expect(textBlock).toMatch(/Applied the required pack\(s\) acme-base@1\.2\.0/);
    expect(textBlock).toMatch(/No installed version satisfies "audit-trail" \^3/);
    expect((readConfig(path.join(dir, 'services', 'svc')).extensions as { packs: unknown[] }).packs).toHaveLength(1);
  });
});
