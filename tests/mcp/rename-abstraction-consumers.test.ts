import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { waiState } from '../helpers/family-verbs.js';
import { tempDir, isolateGlobals, specs, system, subsystem, component, contract, implementation, projectYaml } from '../helpers/stage8-family.js';

// ---------------------------------------------------------------------------
// A consumer project reaching the renamed method through this project's export:
// by implementing an exported abstraction, or by calling an exported
// implementer the rename followed onto. sdd_rename_method never writes the
// consumer's files and names it in `breaks`, on a dry run and for real.
// ---------------------------------------------------------------------------

const cleanups: (() => void)[] = [];
beforeEach(() => { cleanups.push(isolateGlobals(cleanups)); });
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const c of cleanups.splice(0).reverse()) {
    try { c(); } catch { /* windows locks */ }
  }
});

const edit = (file: string, change: (doc: any) => void): void => {
  const doc = yaml.load(fs.readFileSync(file, 'utf-8')) as any;
  change(doc);
  fs.writeFileSync(file, yaml.dump(doc));
};

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'abstraction-consumers-test', version: '0.0.1' });
  await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** The consumer `shop`, declaring `ledger` as a path external; its sales component uses the producer as `use` says. */
function writeConsumer(dir: string): void {
  projectYaml(dir, { id: 'shop', name: 'Shop', externals: { ledger: { source: { path: '../ledger' } } } });
  system(dir, 'Shop');
  subsystem(dir, 'Shop', 'sales');
}

describe('a consumer of an exported abstraction or of a followed implementer', () => {
  const run = async (producer: string, args: Record<string, unknown>): Promise<{ result: ToolResult; json: any }> => {
    setProjectRoot(producer);
    invalidateSpecCache();
    const client = await connect();
    try {
      const result = await client.callTool({ name: 'sdd_rename_method', arguments: args }) as ToolResult;
      return { result, json: result.isError ? undefined : JSON.parse(result.content?.[0]?.text ?? '{}') };
    } finally {
      await client.close();
    }
  };

  it('a consumer implementing the exported abstraction: its files stay untouched and it is named in breaks, dry run and real', async () => {
    const base = tempDir(cleanups, 'wairon-abstraction-consumer-');
    const producer = path.join(base, 'ledger');
    const shop = path.join(base, 'shop');
    projectYaml(producer, { id: 'ledger', name: 'Ledger' });
    system(producer, 'Ledger', [{ from: 'books', component: 'slot-port', audience: 'instance' }]);
    subsystem(producer, 'Ledger', 'books', { publicInterfaces: [{ details: 'Where slots come from', component: 'slot-port', role: 'implement' }] });
    component(producer, 'books', 'slot-port', 'Adapter', [], { abstract: true });
    contract(producer, 'books', 'slot-port', [{ name: 'announce', description: 'Announce', signature: 'announce(): void', returns: 'void' }]);
    writeConsumer(shop);
    component(shop, 'sales', 'slot-client', 'Adapter');
    contract(shop, 'sales', 'slot-client', [{ name: 'announce', description: 'Announce', signature: 'announce(): void', returns: 'void' }]);
    edit(specs(shop, 'sales', 'slot-client', '.interface.yaml'), (doc) => { doc.implements = ['ledger::slot-port']; });
    const before = waiState(shop);

    const dry = await run(producer, { id: 'slot-port', method: 'announce', newName: 'notify', dryRun: true, search: [base] });
    expect(dry.result.isError ?? false, dry.result.content?.[0]?.text).toBe(false);
    expect(dry.json.breaks?.map((c: { project: string }) => c.project)).toEqual(['shop']);
    expect(waiState(shop)).toEqual(before);
    const real = await run(producer, { id: 'slot-port', method: 'announce', newName: 'notify', search: [base] });
    expect(real.json.breaks?.map((c: { project: string }) => c.project)).toEqual(['shop']);
    expect(waiState(shop)).toEqual(before);
    // The producer did rename.
    expect((yaml.load(fs.readFileSync(specs(producer, 'books', 'slot-port', '.interface.yaml'), 'utf-8')) as any).methods[0].name).toBe('notify');
  });

  it('a consumer calling an exported implementer the rename followed onto (the abstraction itself unexported): named in breaks, dry run and real', async () => {
    const base = tempDir(cleanups, 'wairon-follower-consumer-');
    const producer = path.join(base, 'ledger');
    const shop = path.join(base, 'shop');
    projectYaml(producer, { id: 'ledger', name: 'Ledger' });
    system(producer, 'Ledger', [{ from: 'books', component: 'ledger-portal', audience: 'instance' }]);
    subsystem(producer, 'Ledger', 'books', { publicInterfaces: [{ details: 'The ledger surface', component: 'ledger-portal' }] });
    component(producer, 'books', 'ledger-api', 'Portal', [], { abstract: true, transport: undefined });
    component(producer, 'books', 'ledger-portal', 'Portal');
    const post = { name: 'post', description: 'Post', signature: 'post(): void', returns: 'void' };
    contract(producer, 'books', 'ledger-api', [post]);
    contract(producer, 'books', 'ledger-portal', [post]);
    edit(specs(producer, 'books', 'ledger-portal', '.interface.yaml'), (doc) => { doc.implements = ['ledger-api']; });
    writeConsumer(shop);
    component(shop, 'sales', 'checkout', 'Adapter', ['ledger::ledger-portal']);
    contract(shop, 'sales', 'checkout', [{ name: 'pay', description: 'Pay', signature: 'pay(): void', returns: 'void' }]);
    implementation(shop, 'sales', 'checkout', 'icheckout', [{
      name: 'pay', narrative: [{ stepNumber: 1, description: 'Post it', type: 'call', targetComponent: 'ledger::ledger-portal', targetMethod: 'post' }],
    }]);
    const before = waiState(shop);

    const dry = await run(producer, { id: 'ledger-api', method: 'post', newName: 'append', dryRun: true, search: [base] });
    expect(dry.result.isError ?? false, dry.result.content?.[0]?.text).toBe(false);
    expect(dry.json.followed).toEqual(['ledger-portal.append']);
    expect(dry.json.breaks?.map((c: { project: string }) => c.project)).toEqual(['shop']);
    expect(waiState(shop)).toEqual(before);
    const real = await run(producer, { id: 'ledger-api', method: 'post', newName: 'append', search: [base] });
    expect(real.json.breaks?.map((c: { project: string }) => c.project)).toEqual(['shop']);
    expect(waiState(shop)).toEqual(before);
  });
});
