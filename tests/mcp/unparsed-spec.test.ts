/**
 * A spec whose file exists but fails to parse is not a missing spec, and one
 * broken file is one finding. The read and write tools say the spec exists but
 * fails to parse (quoting the loader's reason), and validation folds every
 * reference into it ("N references into it are not judged until it parses")
 * instead of reporting each one as a dangling reference.
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
import { validateProject } from '../../src/core/validation.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { materializeFixtureProject, BASE_FIXTURE_RULES, type FixtureTree } from '../rules-matrix/harness.js';

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const textOf = (r: ToolResult): string => r.content?.[0]?.text ?? '';

const roots: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const step = (n: number, method: string) => ({ stepNumber: n, type: 'call', description: `Call ${method}.`, targetComponent: 'ledger', targetMethod: method });

const TREE: FixtureTree = {
  subsystems: [{ id: 'billing', description: 'Billing.' }],
  components: [
    { id: 'invoicer', componentType: 'Orchestrator', dependsOn: ['ledger'], description: 'Issues invoices.' },
    { id: 'ledger', componentType: 'Orchestrator', description: 'Books entries.' },
  ],
  interfaces: [
    { id: 'iinvoicer', component: 'invoicer', methods: [{ name: 'issue', description: 'Issue an invoice.' }] },
    { id: 'iledger', component: 'ledger', methods: [{ name: 'book', description: 'Book an entry.' }, { name: 'reverse', description: 'Reverse an entry.' }] },
  ],
  implementations: [{
    id: 'invoicer_impl',
    contract: 'iinvoicer',
    methods: [{ name: 'issue', narrative: [step(1, 'book'), step(2, 'reverse'), step(3, 'book')] }],
  }],
};

function find(dir: string, id: string): string | undefined {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = find(p, id);
      if (hit) return hit;
    } else if (e.name.startsWith(id) || (e.name.startsWith('.') && path.basename(dir) === id)) return p;
  }
  return undefined;
}

/** Materialize the tree, then break the ledger's contract file so its schema refuses it. */
function brokenProject(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-unparsed-')));
  roots.push(root);
  materializeFixtureProject(root, TREE);
  const file = find(path.join(root, '.wai', 'specs'), 'iledger');
  expect(file, 'the ledger contract file').toBeDefined();
  const doc = yaml.load(fs.readFileSync(file!, 'utf8')) as Record<string, unknown>;
  doc.methods = 'not a list of methods';
  fs.writeFileSync(file!, yaml.dump(doc));
  setProjectRoot(root);
  invalidateSpecCache();
  return root;
}

async function connect(): Promise<(name: string, args: Record<string, unknown>) => Promise<ToolResult>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'unparsed-spec-test', version: '0.0.1' });
  await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return async (name, args) => (await client.callTool({ name, arguments: args })) as ToolResult;
}

describe('a spec that exists but fails to parse', () => {
  it('sdd_get_spec says it fails to parse, quoting the loader, not that it does not exist', async () => {
    brokenProject();
    const call = await connect();
    const text = textOf(await call('sdd_get_spec', { kind: 'interface', id: 'iledger' }));
    expect(text).toMatch(/exists but fails to parse/);
    expect(text).toMatch(/Failed to parse interface spec/);
    expect(text).toMatch(/Repair the file first/);
    expect(text).not.toMatch(/does not exist/);
  });

  it('sdd_update_spec says the same, not spec-missing, and writes nothing', async () => {
    const root = brokenProject();
    const call = await connect();
    const before = fs.readFileSync(find(path.join(root, '.wai', 'specs'), 'iledger')!, 'utf8');
    const result = await call('sdd_update_spec', { kind: 'interface', id: 'iledger', delta: { description: 'x' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/exists but fails to parse/);
    expect(textOf(result)).not.toMatch(/spec-missing/);
    expect(fs.readFileSync(find(path.join(root, '.wai', 'specs'), 'iledger')!, 'utf8')).toBe(before);
  });

  it('a spec that really is absent still reads as missing', async () => {
    brokenProject();
    const call = await connect();
    expect(textOf(await call('sdd_get_spec', { kind: 'interface', id: 'inowhere' }))).toMatch(/does not exist/);
    expect(textOf(await call('sdd_update_spec', { kind: 'interface', id: 'inowhere', delta: { description: 'x' } }))).toMatch(/spec-missing/);
  });
});

describe('references into a spec that fails to parse', () => {
  it('fold into the parse error: one parse error, a count, no dangling-reference errors', () => {
    brokenProject();
    const { issues } = validateProject({ rules: BASE_FIXTURE_RULES as never, projectType: 'backend' });
    const parse = issues.filter((i) => i.code === 'SCHEMA_VALIDATION_ERROR');
    expect(parse).toHaveLength(1);
    expect(parse[0].message).toMatch(/3 references into it are not judged until it parses\./);
    expect(issues.filter((i) => i.code === 'INVALID_TARGET_METHOD_REFERENCE')).toEqual([]);
    expect(issues.every((i) => i.target === undefined && i.unparsed === undefined)).toBe(true);
  });

  it('are reported as before once the file parses', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-unparsed-ok-')));
    roots.push(root);
    materializeFixtureProject(root, {
      ...TREE,
      interfaces: [TREE.interfaces![0], { id: 'iledger', component: 'ledger', methods: [{ name: 'book', description: 'Book an entry.' }] }],
    });
    setProjectRoot(root);
    invalidateSpecCache();
    const { issues } = validateProject({ rules: BASE_FIXTURE_RULES as never, projectType: 'backend' });
    expect(issues.filter((i) => i.code === 'INVALID_TARGET_METHOD_REFERENCE')).toHaveLength(1);
  });
});
