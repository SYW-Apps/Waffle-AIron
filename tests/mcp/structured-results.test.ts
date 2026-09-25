import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ---------------------------------------------------------------------------
// What a tool answers WITH, as data rather than as a sentence.
//
// Every tool used to answer through one text block, so an agent that wanted to
// know what a write did had to parse English — and several waves went into
// making those sentences trustworthy precisely because prose was the only
// channel. The tools whose answer is already a structure now DECLARE an
// outputSchema and return `structuredContent` beside the text.
//
// Two obligations this suite exists to hold:
//
//   1. The text block is UNCHANGED. A client that understands no structured
//      content must see exactly what it saw before — so the sentences are
//      pinned here byte for byte, not asserted about in prose.
//   2. A refusal still answers coherently. Per the MCP specification a tool
//      declaring an outputSchema must return structuredContent on every
//      non-error result; an `isError` result is exempt, and both the SDK's
//      server-side check and its client-side one honour that. A refusal that
//      lost its isError flag would be demanded to carry a report it does not
//      have, and the call would fail as a protocol error instead of as the
//      refusal it is.
//
// Driven through the real stdio server: the whole point is what crosses the
// protocol boundary, which a unit test of a handler never sees. The SDK client
// validates every structuredContent against the tool's declared schema on the
// way in, so each call below is also an assertion that the schema fits.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const now = new Date().toISOString();

/** The tools that declare an outputSchema, and therefore owe structured content. */
const STRUCTURED_TOOLS = [
  'sdd_initialize_system',
  'sdd_add_subsystem',
  'sdd_add_component',
  'sdd_define_interface',
  'sdd_write_narrative',
  'sdd_add_type',
  'sdd_update_spec',
  'sdd_set_endpoints',
  'sdd_set_public_interfaces',
  'sdd_set_subsystem_project_path',
  'sdd_delete_spec',
  'sdd_get_spec',
  'sdd_validate_tree',
];

describe('the tools answer with data, and still with the same sentence', () => {
  let projDir: string;
  let client: Client;

  /** The whole result — both channels — for a call that must succeed. */
  const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const result: any = await client.callTool({ name, arguments: args });
    expect(result.isError ?? false, `tool failed: ${JSON.stringify(result.content)}`).toBe(false);
    return result;
  };
  /** The single text block, as a client with no structured support reads it. */
  const textOf = (result: any): string => result.content?.[0]?.text as string;

  beforeAll(async () => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-structured-'));
    fs.mkdirSync(path.join(projDir, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.wai', 'project.yaml'), [
      "schemaVersion: '1.0.0'",
      'name: structured-results',
      'targets:',
      '  - type: claude',
      '    outputDir: .claude/agents',
      '    enabled: true',
      `createdAt: '${now}'`,
      `updatedAt: '${now}'`,
    ].join('\n'));

    client = new Client({ name: 'wairon-structured-test', version: '0.0.1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX_CLI, WAIRON_CLI, 'mcp', 'serve'],
      cwd: projDir,
      stderr: 'ignore',
    });
    await client.connect(transport);

    await call('sdd_initialize_system', { name: 'StructuredSystem', vision: 'answers as data', targetLanguage: 'typescript' });
    await call('sdd_add_subsystem', { id: 'shop', name: 'Shop', description: 'The shop bounded context' });
    await call('sdd_add_component', {
      id: 'checkout', name: 'Checkout', description: 'Runs the checkout workflow',
      subsystem: 'shop', componentType: 'Orchestrator',
    });
  }, 90_000);

  afterAll(async () => {
    try { await client?.close(); } catch { /* already gone */ }
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  // -------------------------------------------------------------------------
  // The declaration itself
  // -------------------------------------------------------------------------

  it('advertises an outputSchema for every tool that answers with a structure', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t: any) => [t.name, t]));
    for (const name of STRUCTURED_TOOLS) {
      const tool = byName.get(name);
      expect(tool, `${name} is not advertised at all`).toBeDefined();
      expect((tool as any).outputSchema, `${name} declares no outputSchema`).toBeDefined();
      expect((tool as any).outputSchema.type).toBe('object');
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // A create: what was written, at what status, and whether it replaced one
  // -------------------------------------------------------------------------

  it('a create answers with the receipt for what it wrote', async () => {
    const created = await call('sdd_add_component', {
      id: 'ledger', name: 'Ledger', description: 'Holds the posted entries',
      subsystem: 'shop', componentType: 'Orchestrator', status: 'design',
    });
    expect(created.structuredContent).toEqual({
      kind: 'component',
      id: 'ledger',
      name: 'Ledger',
      replacedExisting: false,
      status: 'design',
      notices: [],
      // A new spec changed no stored method, so it invalidated no test.
      testsToRevisit: [],
    });
  }, 60_000);

  it('a gate notice comes back as its own entry, not as a sentence to be split', async () => {
    const created = await call('sdd_add_component', {
      id: 'entries', name: 'Entries', description: 'Holds the posted entries',
      subsystem: 'shop', componentType: 'Store', durability: 'durable',
    });
    expect(created.structuredContent.notices).toHaveLength(1);
    expect(created.structuredContent.notices[0]).toContain('has no owning pattern yet');
  }, 60_000);

  it('a re-author reports the status the spec ACTUALLY holds, not the one asked for', async () => {
    // The restatement states no status, so the spec keeps the one it is stored
    // at. Reporting the status asked for would call a complete spec a draft on
    // exactly the call where it matters.
    const again = await call('sdd_add_component', {
      id: 'ledger', name: 'Ledger', description: 'Holds the posted entries, reworded',
      subsystem: 'shop', componentType: 'Orchestrator',
    });
    expect(again.structuredContent.replacedExisting).toBe(true);
    expect(again.structuredContent.status).toBe('design');
    expect(again.structuredContent.notices.length).toBeGreaterThan(0);
    expect(again.structuredContent.notices[0]).toContain('already existed');
    // …and the spec on disk agrees, which is the claim the receipt is making.
    const read = await call('sdd_get_spec', { kind: 'component', id: 'ledger' });
    expect(read.structuredContent.spec.status).toBe('design');
  }, 60_000);

  it('the sentence a create answers with is exactly the one it always gave', async () => {
    const result = await call('sdd_add_component', {
      id: 'pricing', name: 'Pricing', description: 'Computes a line price',
      subsystem: 'shop', componentType: 'Orchestrator', dependencyClass: 'pure',
    });
    // Pinned, not described: this is what a client with no structured support reads.
    expect(textOf(result)).toBe('Successfully added L2 Component Spec "Pricing" (pricing, Orchestrator).');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  }, 60_000);

  it('a create with notices still renders them into the same NOTICE block', async () => {
    const result = await call('sdd_add_component', {
      id: 'pricing', name: 'Pricing', description: 'Computes a line price, reworded',
      subsystem: 'shop', componentType: 'Orchestrator', dependencyClass: 'pure',
    });
    const notices = result.structuredContent.notices as string[];
    // The prose block is composed FROM the same list the structure carries, so
    // the two can never disagree about what the write reported.
    expect(textOf(result)).toBe(
      `Successfully re-authored L2 Component Spec "Pricing" (pricing, Orchestrator).\n\nNOTICE:\n- ${notices.join('\n- ')}`,
    );
  }, 60_000);

  // -------------------------------------------------------------------------
  // A delta: the change report was already a structure; now it travels as one
  // -------------------------------------------------------------------------

  it('sdd_update_spec answers with the change report as data', async () => {
    const result = await call('sdd_update_spec', {
      kind: 'component', id: 'checkout', delta: { description: 'Runs the checkout workflow, precisely' },
    });
    const report = result.structuredContent;
    expect(report.kind).toBe('component');
    expect(report.id).toBe('checkout');
    expect(report.written).toBe(true);
    expect(report.dryRun).toBe(false);
    expect(report.changes).toEqual([{
      path: 'description',
      change: 'set',
      before: 'Runs the checkout workflow',
      after: 'Runs the checkout workflow, precisely',
    }]);
    expect(report.ineffective).toEqual([]);
    expect(typeof report.summary).toBe('string');
  }, 60_000);

  it('a delta that lands nowhere says so in a field as well as in the NO EFFECT block', async () => {
    // Restating a value the spec already holds: the write is a no-op, and the
    // path that landed nowhere is named rather than dropped.
    const result = await call('sdd_update_spec', {
      kind: 'component', id: 'checkout', delta: { description: 'Runs the checkout workflow, precisely' },
    });
    expect(result.structuredContent.written).toBe(false);
    expect(result.structuredContent.changes).toEqual([]);
    expect(result.structuredContent.ineffective.join(' ')).toContain('description');
    // And the prose is untouched: the same NO EFFECT listing as before.
    expect(textOf(result)).toContain('NO EFFECT:');
    expect(textOf(result)).toContain('description');
  }, 60_000);

  it('a dry run is told apart from a no-op by the field that exists for it', async () => {
    const result = await call('sdd_update_spec', {
      kind: 'component', id: 'checkout', delta: { description: 'A description never written' }, dryRun: true,
    });
    expect(result.structuredContent.dryRun).toBe(true);
    expect(result.structuredContent.written).toBe(false);
    expect(result.structuredContent.changes).toHaveLength(1);
    expect(textOf(result)).toContain('DRY RUN — nothing was written.');
  }, 60_000);

  // -------------------------------------------------------------------------
  // A read: the spec, and the two derived markers kept apart from it
  // -------------------------------------------------------------------------

  it('sdd_get_spec answers with the spec under its own key', async () => {
    const result = await call('sdd_get_spec', { kind: 'component', id: 'checkout' });
    expect(result.structuredContent.kind).toBe('component');
    expect(result.structuredContent.id).toBe('checkout');
    expect(result.structuredContent.spec.id).toBe('checkout');
    expect(result.structuredContent.spec.componentType).toBe('Orchestrator');
    expect(result.structuredContent.partialResult).toBeUndefined();
    // The text block is the spec's JSON, exactly as it always was.
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent.spec);
  }, 60_000);

  it('a filtered read carries the partial marker beside the spec, and folded into the text', async () => {
    await call('sdd_define_interface', {
      id: 'icheckout', name: 'ICheckout', description: 'The checkout contract', component: 'checkout',
      methods: [
        { name: 'alpha', description: 'A', signature: 'alpha(): void', returns: 'void' },
        { name: 'beta', description: 'B', signature: 'beta(): void', returns: 'void' },
        { name: 'gamma', description: 'C', signature: 'gamma(): void', returns: 'void' },
      ],
    });
    const result = await call('sdd_get_spec', { kind: 'interface', id: 'icheckout', methods: ['beta'] });

    // Structured: the STORED spec, and the derived marker beside it — nothing
    // derived can be mistaken for something the spec holds.
    expect(result.structuredContent.spec.methods.map((m: any) => m.name)).toEqual(['beta']);
    expect(result.structuredContent.spec.partialResult).toBeUndefined();
    expect(result.structuredContent.partialResult.shown).toEqual(['beta']);
    expect(result.structuredContent.partialResult.omitted).toBe(2);

    // Text: the marker folded in, exactly as before.
    const folded = JSON.parse(textOf(result));
    expect(folded.methods.map((m: any) => m.name)).toEqual(['beta']);
    expect(folded.partialResult.omitted).toBe(2);
    expect(folded.partialResult.warning).toContain('Never re-author from it');
  }, 60_000);

  // -------------------------------------------------------------------------
  // The gate: findings as objects, not as a payload to be parsed
  // -------------------------------------------------------------------------

  it('sdd_validate_tree answers with findings as objects, split by severity', async () => {
    const result = await call('sdd_validate_tree', {});
    const report = result.structuredContent;
    expect(typeof report.valid).toBe('boolean');
    expect(Array.isArray(report.errors)).toBe(true);
    expect(Array.isArray(report.warnings)).toBe(true);
    for (const finding of [...report.errors, ...report.warnings]) {
      expect(typeof finding.code).toBe('string');
      expect(finding.severity === 'error' || finding.severity === 'warning').toBe(true);
      expect(typeof finding.message).toBe('string');
    }
    // A tree with a Store nobody owns and contracts nobody realizes has findings
    // to report — this test would be empty otherwise.
    expect(report.errors.length + report.warnings.length).toBeGreaterThan(0);
    // The text block is still the same JSON payload.
    expect(JSON.parse(textOf(result))).toEqual(report);
  }, 60_000);

  // -------------------------------------------------------------------------
  // The refusal path
  // -------------------------------------------------------------------------

  it('a refusal answers as a refusal — no structured content demanded, and none invented', async () => {
    // The SDK client REFUSES a non-error result that carries no structured
    // content for a tool declaring an outputSchema; an isError result is exempt.
    // So this call reaching us at all is half the proof.
    const result: any = await client.callTool({
      name: 'sdd_get_spec', arguments: { kind: 'component', id: 'no-such-component' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain('does not exist');
  }, 60_000);

  it('a refused create is refused, not reported as a receipt for a write that never happened', async () => {
    // Its own component: the nested layout gives a component exactly one
    // interface file, so two contracts on one component collide.
    await call('sdd_add_component', {
      id: 'frozen-comp', name: 'Frozen Component', description: 'Holds a settled contract',
      subsystem: 'shop', componentType: 'Orchestrator',
    });
    await call('sdd_define_interface', {
      id: 'ifrozen', name: 'IFrozen', description: 'Settled contract', component: 'frozen-comp',
      methods: [{ name: 'run', description: 'Runs', signature: 'run(): void', returns: 'void' }],
      status: 'complete',
    });
    const result: any = await client.callTool({
      name: 'sdd_define_interface',
      arguments: {
        id: 'ifrozen', name: 'IFrozen', description: 'Reopened behind your back', component: 'frozen-comp',
        methods: [{ name: 'run', description: 'Runs', signature: 'run(): void', returns: 'void' }],
        status: 'draft',
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain('never lowers');
  }, 60_000);
});
