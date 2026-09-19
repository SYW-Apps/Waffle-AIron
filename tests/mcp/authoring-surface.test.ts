import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ---------------------------------------------------------------------------
// What the authoring TOOLS accept, and what they say about it.
//
// Three silences lived on this surface, each one letting a call read as an edit
// it never made:
//
//   1. No create tool took a `status`, so every spec was born draft and needed a
//      follow-up update nobody remembers — and re-authoring a SUBSYSTEM wrote
//      that draft straight over a frozen one, because saveSubsystemSpec was the
//      one saver without the no-demotion guard its four siblings have.
//   2. sdd_get_spec took kind and id only, so reading one method of a 45-method
//      implementation meant fetching all 45.
//   3. Only the TOP level of a tool's input was strict. A nested `descriptoin`
//      merged, was stripped at write time, and was never mentioned: the same
//      silent drop the top-level fix closed, one depth lower.
//
// Driven through the real stdio server, because the silence was in what the
// protocol boundary accepted — a unit test of the handler would not have it.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const now = new Date().toISOString();

function unwrapText(result: any): string {
  expect(result.isError ?? false, `tool failed: ${JSON.stringify(result.content)}`).toBe(false);
  return result.content?.[0]?.text as string;
}

/** Where a spec's file actually landed — the layout is the store's business, not this test's. */
function findSpecFile(dir: string, stem: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === stem) {
        const nested = path.join(full, '.index.yaml');
        if (fs.existsSync(nested)) return nested;
      }
      const deeper = findSpecFile(full, stem);
      if (deeper) return deeper;
    } else if (entry.name === `${stem}.yaml`) {
      return full;
    }
  }
  return null;
}

function errorText(result: any): string {
  expect(result.isError, `expected a refusal, got: ${JSON.stringify(result.content)}`).toBe(true);
  return result.content?.[0]?.text as string;
}

describe('the authoring tools say what they accepted', () => {
  let projDir: string;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown>): Promise<string> =>
    unwrapText(await client.callTool({ name, arguments: args }));
  const refuse = async (name: string, args: Record<string, unknown>): Promise<string> =>
    errorText(await client.callTool({ name, arguments: args }));
  const specFileFor = (stem: string): string => {
    const found = findSpecFile(path.join(projDir, '.wai', 'specs'), stem);
    expect(found, `no spec file on disk for "${stem}"`).not.toBeNull();
    return found as string;
  };
  const getSpec = async (kind: string, id: string, extra: Record<string, unknown> = {}): Promise<any> =>
    JSON.parse(unwrapText(await client.callTool({ name: 'sdd_get_spec', arguments: { kind, id, ...extra } })));

  beforeAll(async () => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-authoring-'));
    fs.mkdirSync(path.join(projDir, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.wai', 'project.yaml'), [
      "schemaVersion: '1.0.0'",
      'name: authoring-surface',
      'targets:',
      '  - type: claude',
      '    outputDir: .claude/agents',
      '    enabled: true',
      `createdAt: '${now}'`,
      `updatedAt: '${now}'`,
    ].join('\n'));

    client = new Client({ name: 'wairon-authoring-test', version: '0.0.1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX_CLI, WAIRON_CLI, 'mcp', 'serve'],
      cwd: projDir,
      stderr: 'ignore',
    });
    await client.connect(transport);

    await call('sdd_initialize_system', { name: 'AuthoringSystem', vision: 'truthful authoring', targetLanguage: 'typescript' });
    await call('sdd_add_subsystem', { id: 'shop', name: 'Shop', description: 'The shop bounded context' });
    for (const [id, name] of [
      ['shop-orch', 'Shop Orchestrator'],
      ['frozen-comp', 'Frozen Component'],
      ['step-comp', 'Step Component'],
      ['typo-comp', 'Typo Component'],
    ] as const) {
      // One component per contract: the nested layout gives a component exactly
      // one interface file, so two contracts on one component collide.
      await call('sdd_add_component', {
        id, name, description: 'Runs the checkout workflow',
        subsystem: 'shop', componentType: 'Orchestrator',
      });
    }
  }, 90_000);

  afterAll(async () => {
    try { await client?.close(); } catch { /* already gone */ }
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  // -------------------------------------------------------------------------
  // A9 — status at create, and no silent demotion
  // -------------------------------------------------------------------------

  it('a create writes the status it is given instead of always draft', async () => {
    await call('sdd_add_component', {
      id: 'born-complete', name: 'Born Complete', description: 'Authored at a settled level',
      subsystem: 'shop', componentType: 'Orchestrator', status: 'complete',
    });
    expect((await getSpec('component', 'born-complete')).status).toBe('complete');

    await call('sdd_add_subsystem', { id: 'warehouse', name: 'Warehouse', description: 'Stock', status: 'design' });
    expect((await getSpec('subsystem', 'warehouse')).status).toBe('design');
  }, 60_000);

  it('a create with no status still births a spec draft', async () => {
    await call('sdd_add_component', {
      id: 'born-draft', name: 'Born Draft', description: 'No status stated',
      subsystem: 'shop', componentType: 'Orchestrator',
    });
    expect((await getSpec('component', 'born-draft')).status).toBe('draft');
  }, 60_000);

  it('re-authoring a complete SUBSYSTEM does not quietly reopen it', async () => {
    await call('sdd_add_subsystem', { id: 'frozen', name: 'Frozen', description: 'Settled', status: 'complete' });
    expect((await getSpec('subsystem', 'frozen')).status).toBe('complete');

    // The restatement that used to write 'draft' straight over it: same id, no
    // status stated. saveSubsystemSpec was the one saver without the guard.
    await call('sdd_add_subsystem', { id: 'frozen', name: 'Frozen', description: 'Settled, reworded' });
    const after = await getSpec('subsystem', 'frozen');
    expect(after.description).toBe('Settled, reworded');
    expect(after.status).toBe('complete');
  }, 60_000);

  it('a create refuses to LOWER a stored status, and writes nothing', async () => {
    await call('sdd_define_interface', {
      id: 'ifrozen', name: 'IFrozen', description: 'Settled contract', component: 'frozen-comp',
      methods: [{ name: 'run', description: 'Runs', signature: 'run(): void', returns: 'void' }],
      status: 'complete',
    });

    const refusal = await refuse('sdd_define_interface', {
      id: 'ifrozen', name: 'IFrozen', description: 'Reopened behind your back', component: 'frozen-comp',
      methods: [{ name: 'run', description: 'Runs', signature: 'run(): void', returns: 'void' }],
      status: 'draft',
    });
    expect(refusal).toContain('never lowers');
    expect(refusal).toContain('sdd_update_spec');

    const after = await getSpec('interface', 'ifrozen');
    expect(after.status).toBe('complete');
    expect(after.description).toBe('Settled contract');       // nothing was written
  }, 60_000);

  it('sdd_update_spec still reopens a spec deliberately', async () => {
    await call('sdd_update_spec', { kind: 'subsystem', id: 'frozen', delta: { status: 'draft' } });
    expect((await getSpec('subsystem', 'frozen')).status).toBe('draft');
  }, 60_000);

  // -------------------------------------------------------------------------
  // A10 — reading one method instead of forty-five
  // -------------------------------------------------------------------------

  it('sdd_get_spec returns only the methods asked for, and says what it left out', async () => {
    await call('sdd_define_interface', {
      id: 'iwide', name: 'IWide', description: 'A wide contract', component: 'shop-orch',
      methods: [
        { name: 'alpha', description: 'A', signature: 'alpha(): void', returns: 'void' },
        { name: 'beta', description: 'B', signature: 'beta(): void', returns: 'void' },
        { name: 'gamma', description: 'C', signature: 'gamma(): void', returns: 'void' },
      ],
    });

    const one = await getSpec('interface', 'iwide', { methods: ['beta'] });
    expect(one.methods.map((m: any) => m.name)).toEqual(['beta']);
    expect(one.partialResult.omitted).toBe(2);
    expect(one.partialResult.warning).toContain('Never re-author from it');
    expect(one.description).toBe('A wide contract');          // the rest of the spec is untouched
  }, 60_000);

  it('a full fetch is unchanged by the filter existing', async () => {
    const whole = await getSpec('interface', 'iwide');
    expect(whole.methods.map((m: any) => m.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(whole.partialResult).toBeUndefined();
  }, 60_000);

  it('a method name the spec does not declare is refused, with the names it does', async () => {
    const refusal = await refuse('sdd_get_spec', { kind: 'interface', id: 'iwide', methods: ['beta', 'bteta'] });
    expect(refusal).toContain('"bteta"');
    expect(refusal).toContain('alpha, beta, gamma');
  }, 60_000);

  it('filtering a spec that declares no methods is refused rather than ignored', async () => {
    const refusal = await refuse('sdd_get_spec', { kind: 'component', id: 'shop-orch', methods: ['run'] });
    expect(refusal).toContain('declares no methods');
  }, 60_000);

  // -------------------------------------------------------------------------
  // A11a — a nested unknown key is refused, not stripped
  // -------------------------------------------------------------------------

  it('an unknown key inside a method is refused by name', async () => {
    const refusal = await refuse('sdd_define_interface', {
      id: 'itypo', name: 'ITypo', description: 'Contract', component: 'typo-comp',
      methods: [{ name: 'charge', descriptoin: 'Charges', signature: 'charge(): void', returns: 'void' }],
    });
    expect(refusal.toLowerCase()).toContain('descriptoin');

    // …and nothing was written under the typo.
    const missing = await client.callTool({ name: 'sdd_get_spec', arguments: { kind: 'interface', id: 'itypo' } });
    expect(missing.isError).toBe(true);
  }, 60_000);

  it('an unknown key inside a narrative step is refused by name', async () => {
    await call('sdd_define_interface', {
      id: 'istep', name: 'IStep', description: 'Contract', component: 'step-comp',
      methods: [{ name: 'run', description: 'Runs', signature: 'run(): void', returns: 'void' }],
    });
    const refusal = await refuse('sdd_write_narrative', {
      id: 'step_impl', name: 'Step Impl', description: 'Impl', contract: 'istep',
      methods: [{
        name: 'run',
        narrative: [{ stepNumber: 1, description: 'Does the thing', type: 'local', targetMehod: 'oops' }],
      }],
    });
    expect(refusal.toLowerCase()).toContain('targetmehod');
  }, 60_000);

  it('an unknown key inside a component dispatch entry is refused by name', async () => {
    const refusal = await refuse('sdd_add_component', {
      id: 'shop-portal', name: 'Shop Portal', description: 'The surface',
      subsystem: 'shop', componentType: 'Portal', portalType: 'HTTP_API',
      dispatch: [{ capability: 'shop.run', component: 'shop-orch', method: 'run', descriptio: 'typo' }],
    });
    expect(refusal.toLowerCase()).toContain('descriptio');
  }, 60_000);

  // -------------------------------------------------------------------------
  // A11b — the delta stays open, so it NAMES what had no effect
  // -------------------------------------------------------------------------

  it('a delta key that is not a field one level down comes back named', async () => {
    const out = await call('sdd_update_spec', {
      kind: 'interface', id: 'iwide',
      delta: { methods: [{ name: 'beta', descriptoin: 'a typo that used to vanish', returns: 'string' }] },
    });
    expect(out).toContain('NO EFFECT');
    expect(out).toContain('methods.beta.descriptoin');
    expect(out).toContain('methods.beta.returns set');       // the real edit still landed
  }, 60_000);

  it('a delta restating a value the spec already held comes back named', async () => {
    const out = await call('sdd_update_spec', {
      kind: 'interface', id: 'iwide',
      delta: { description: 'A wide contract', name: 'IWide v2' },
    });
    expect(out).toContain('description — the stored spec already held this value');
  }, 60_000);

  it('an unset that removed nothing comes back named', async () => {
    const out = await call('sdd_update_spec', {
      kind: 'component', id: 'shop-orch',
      delta: { description: 'Runs the checkout workflow, restated', unset: ['basePath'] },
    });
    expect(out).toContain('basePath — unset named a field the stored spec did not have');
  }, 60_000);

  // -------------------------------------------------------------------------
  // The dry run
  // -------------------------------------------------------------------------

  it('a dry run reports what the delta would do and leaves the file byte for byte', async () => {
    const file = specFileFor('born-draft');
    const before = fs.readFileSync(file);

    const out = await call('sdd_update_spec', {
      kind: 'component', id: 'born-draft',
      delta: { description: 'A description the dry run must not write', dependsOn: ['shop-orch'] },
      dryRun: true,
    });
    expect(out).toContain('DRY RUN');
    expect(out).toContain('would be');
    expect(out).toContain('description');

    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect((await getSpec('component', 'born-draft')).description).toBe('No status stated');
  }, 60_000);

  it('the same delta without dryRun does write it', async () => {
    const out = await call('sdd_update_spec', {
      kind: 'component', id: 'born-draft',
      delta: { description: 'A description the dry run must not write', dependsOn: ['shop-orch'] },
    });
    expect(out).not.toContain('DRY RUN');
    expect((await getSpec('component', 'born-draft')).description).toBe('A description the dry run must not write');
  }, 60_000);
});
