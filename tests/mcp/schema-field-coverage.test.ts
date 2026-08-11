import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  SystemSpecSchema,
  SubsystemSpecSchema,
  ComponentSpecSchema,
  InterfaceSpecSchema,
  ImplementationSpecSchema,
  TypeSpecSchema,
  MethodSignatureSchema,
  MethodImplementationSchema,
  NarrativeStepSchema,
} from '../../src/models/specs.js';

// ---------------------------------------------------------------------------
// Schema-field COVERAGE: no canonical field may be unreachable or losable.
//
// Each sdd_* write tool's input schema is a hand-maintained SUBSET of the
// canonical zod schema. Two failure modes follow from that, and this suite holds
// the line on both:
//
//   1. UNREACHABLE — a field exists in src/models/specs.ts that no tool can set.
//      An agent authoring through MCP simply cannot express it. Caught here
//      statically, against the tool schemas the server actually publishes
//      (listTools), not against a copy of them.
//
//   2. LOSABLE — a field the input cannot express is ERASED when the spec is
//      re-authored, because an upsert rebuilds the spec from the arguments.
//      That is how a lint.allow block disappeared and only announced itself
//      days later, when the suppressed warning came back. Caught here
//      dynamically: populate every unexpressed field, re-run the create tool
//      with minimal arguments, and require every one of them to survive.
//
// Adding a field to UPDATE_SPEC_ONLY is therefore a DECISION being recorded —
// "this field is edited through sdd_update_spec, not at create time" — and the
// dynamic half then forces it to be carried. A field that is neither expressed,
// nor listed here, nor store-managed fails the suite.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const now = new Date().toISOString();

function unwrapText(result: any): string {
  expect(result.isError ?? false).toBe(false);
  const first = result.content?.[0];
  expect(first?.type).toBe('text');
  return first.text as string;
}

/** Fields every store decides on write — never authored through any tool. */
const STORE_MANAGED = ['status', 'createdAt', 'updatedAt'];

type KindSpec = {
  tool: string;
  schema: z.ZodObject<z.ZodRawShape>;
  /** Fields computed by the server from other state, not authored at all. */
  derived?: string[];
  /**
   * Fields no create tool expresses: edited through sdd_update_spec, and
   * CARRIED across a re-authoring (proven by the dynamic half below).
   */
  updateSpecOnly: Record<string, string>;
  /** Nested per-method schema + the tool's method-item property source. */
  method?: { schema: z.ZodObject<z.ZodRawShape>; updateSpecOnly: Record<string, string> };
};

const KINDS: Record<string, KindSpec> = {
  system: {
    tool: 'sdd_initialize_system',
    schema: SystemSpecSchema,
    updateSpecOnly: {
      schemaVersion: 'stamped by the server; migrations own it',
      publicInterfaces: 'the project gateway surface — bound after subsystems exist',
      databases: 'declared once the data model is known',
      diagram: 'canvas presentation defaults, set from the UI',
    },
  },
  subsystem: {
    tool: 'sdd_add_subsystem',
    schema: SubsystemSpecSchema,
    derived: ['parentSystem'],
    updateSpecOnly: {
      lint: 'per-spec warning suppression — an answer to a validator finding, so it is authored after validate',
      ext: 'opaque pack/tool data, never authored by hand',
    },
  },
  component: {
    tool: 'sdd_add_component',
    schema: ComponentSpecSchema,
    updateSpecOnly: {
      auth: 'Portal auth scheme, added when the surface is designed',
      patterns: 'pack-declared pattern refs, resolved against loaded packs',
      variant: 'variant registry reference',
      externalLinks: 'documented external URLs',
      lint: 'per-spec warning suppression — an answer to a validator finding, so it is authored after validate',
      ext: 'opaque pack/tool data, never authored by hand',
    },
  },
  interface: {
    tool: 'sdd_define_interface',
    schema: InterfaceSpecSchema,
    updateSpecOnly: {
      lint: 'per-spec warning suppression — an answer to a validator finding, so it is authored after validate',
      ext: 'opaque pack/tool data, never authored by hand',
    },
    method: {
      schema: MethodSignatureSchema,
      updateSpecOnly: { endpoint: 'bound by the dedicated sdd_set_endpoints tool' },
    },
  },
  implementation: {
    tool: 'sdd_write_narrative',
    schema: ImplementationSpecSchema,
    updateSpecOnly: {
      lint: 'per-spec warning suppression — an answer to a validator finding, so it is authored after validate',
      ext: 'opaque pack/tool data, never authored by hand',
    },
    method: { schema: MethodImplementationSchema, updateSpecOnly: {} },
  },
  type: {
    tool: 'sdd_add_type',
    schema: TypeSpecSchema,
    updateSpecOnly: {
      lint: 'per-spec warning suppression — an answer to a validator finding, so it is authored after validate',
      ext: 'opaque pack/tool data, never authored by hand',
    },
  },
};

describe('MCP write-tool schema field coverage', () => {
  let projDir: string;
  let client: Client;
  let toolProps: Record<string, Record<string, any>>;

  const getSpec = async (kind: string, id: string): Promise<any> =>
    JSON.parse(unwrapText(await client.callTool({ name: 'sdd_get_spec', arguments: { kind, id } })));

  const call = async (name: string, args: Record<string, unknown>): Promise<string> =>
    unwrapText(await client.callTool({ name, arguments: args }));

  beforeAll(async () => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-mcp-cov-'));
    fs.mkdirSync(path.join(projDir, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.wai', 'project.yaml'), [
      "schemaVersion: '1.0.0'",
      'name: mcp-coverage',
      'targets:',
      '  - type: claude',
      '    outputDir: .claude/agents',
      '    enabled: true',
      `createdAt: '${now}'`,
      `updatedAt: '${now}'`,
    ].join('\n'));

    client = new Client({ name: 'wairon-cov-test', version: '0.0.1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX_CLI, WAIRON_CLI, 'mcp', 'serve'],
      cwd: projDir,
      stderr: 'ignore',
    });
    await client.connect(transport);

    const listed = await client.listTools();
    toolProps = Object.fromEntries(
      listed.tools.map((t: any) => [t.name, (t.inputSchema?.properties ?? {}) as Record<string, any>]),
    );

    await call('sdd_initialize_system', { name: 'CovSystem', vision: 'field coverage', targetLanguage: 'typescript' });
    await call('sdd_add_subsystem', { id: 'cov', name: 'Coverage', description: 'Coverage bounded context' });
  }, 60_000);

  afterAll(async () => {
    try { await client?.close(); } catch { /* already gone */ }
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  // -------------------------------------------------------------------------
  // 1. UNREACHABLE — every canonical field is expressed, declared update-only,
  //    or store-managed. This is the "is anything unmapped?" alarm.
  // -------------------------------------------------------------------------
  for (const [kind, def] of Object.entries(KINDS)) {
    it(`every ${kind} field is reachable through a tool or explicitly update_spec-only`, () => {
      const expressed = Object.keys(toolProps[def.tool] ?? {});
      expect(expressed.length, `${def.tool} publishes no input schema`).toBeGreaterThan(0);

      const classified = new Set([
        ...expressed,
        ...STORE_MANAGED,
        ...(def.derived ?? []),
        ...Object.keys(def.updateSpecOnly),
      ]);
      const unclassified = Object.keys(def.schema.shape).filter((f) => !classified.has(f));

      expect(
        unclassified,
        `${kind} fields no MCP tool can set and that are not declared update_spec-only: ${unclassified.join(', ')}. `
        + `Either add them to ${def.tool}'s inputSchema, or record them in this test's UPDATE_SPEC_ONLY with the reason `
        + `— the carry-forward test below then proves a re-authoring cannot erase them.`,
      ).toEqual([]);
    });

    it(`no stale update_spec-only entry for ${kind}`, () => {
      const schemaFields = new Set(Object.keys(def.schema.shape));
      const expressed = new Set(Object.keys(toolProps[def.tool] ?? {}));
      for (const field of Object.keys(def.updateSpecOnly)) {
        expect(schemaFields.has(field), `"${field}" is listed update_spec-only but no longer exists on the ${kind} schema`).toBe(true);
        // `ext` is expressible AND always carried — the one sanctioned overlap.
        if (field === 'ext') continue;
        expect(expressed.has(field), `"${field}" is listed update_spec-only but ${def.tool} now expresses it — drop the entry`).toBe(false);
      }
    });

    if (def.method) {
      it(`every ${kind} METHOD field is reachable through ${def.tool}`, () => {
        const methodProps = (toolProps[def.tool]?.methods?.items?.properties ?? {}) as Record<string, any>;
        expect(Object.keys(methodProps).length, `${def.tool} publishes no method item schema`).toBeGreaterThan(0);
        const classified = new Set([...Object.keys(methodProps), ...Object.keys(def.method!.updateSpecOnly)]);
        const unclassified = Object.keys(def.method!.schema.shape).filter((f) => !classified.has(f));
        expect(
          unclassified,
          `${kind} method fields no MCP tool can set: ${unclassified.join(', ')}`,
        ).toEqual([]);
      });
    }
  }

  // The L5 narrative step is the biggest hand-copied schema of all — every flow
  // form, every jump field. A step field missing from the tool input is stripped
  // by the SDK before the handler ever sees it, so the narrative silently loses
  // a branch target rather than failing.
  it('every narrative STEP field is reachable through sdd_write_narrative', () => {
    const stepProps = (toolProps['sdd_write_narrative']?.methods?.items?.properties?.narrative?.items?.properties
      ?? {}) as Record<string, any>;
    expect(Object.keys(stepProps).length, 'sdd_write_narrative publishes no narrative step schema').toBeGreaterThan(0);
    const unclassified = Object.keys(NarrativeStepSchema.shape).filter((f) => !(f in stepProps));
    expect(
      unclassified,
      `narrative step fields no MCP tool can set: ${unclassified.join(', ')}. `
      + 'Add them to narrativeStepInput in src/mcp/server.ts — the MCP SDK strips unknown input keys silently.',
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 2. LOSABLE — the same fields survive a minimal re-authoring, and the tool
  //    SAYS it carried them. One case per write surface.
  // -------------------------------------------------------------------------

  it('re-initializing the system carries databases, gateway interfaces and diagram defaults', async () => {
    await call('sdd_update_spec', {
      kind: 'system', id: 'system',
      delta: {
        databases: [{ id: 'maindb', name: 'Main', engine: 'postgresql' }],
        publicInterfaces: [{ id: 'pub1', name: 'Public API', type: 'REST', details: 'the gateway', audience: 'external' }],
        diagram: { lineStyle: 'taxi', defaultView: 'architecture' },
      },
    });

    const out = await call('sdd_initialize_system', { name: 'CovSystem', vision: 'field coverage v2' });
    expect(out).toContain('Carried forward');

    const after = await getSpec('system', 'system');
    expect(after.vision).toBe('field coverage v2');                       // expressed → replaced
    expect(after.databases).toEqual([{ id: 'maindb', name: 'Main', engine: 'postgresql' }]);
    expect(after.publicInterfaces).toHaveLength(1);
    expect(after.diagram).toEqual({ lineStyle: 'taxi', defaultView: 'architecture' });
  }, 120_000);

  it('re-adding a subsystem carries lint and ext', async () => {
    await call('sdd_update_spec', {
      kind: 'subsystem', id: 'cov',
      delta: { lint: { allow: [{ code: 'UNUSED_COMPONENT', reason: 'entrypoint owned by CI' }] }, ext: { 'mypack:tier': 1 } },
    });

    const out = await call('sdd_add_subsystem', { id: 'cov', name: 'Coverage', description: 'Coverage v2' });
    expect(out).toContain('Carried forward (not expressible through this tool)');

    const after = await getSpec('subsystem', 'cov');
    expect(after.description).toBe('Coverage v2');
    expect(after.lint).toEqual({ allow: [{ code: 'UNUSED_COMPONENT', reason: 'entrypoint owned by CI' }] });
    expect(after.ext).toEqual({ 'mypack:tier': 1 });
  }, 120_000);

  it('re-adding a component carries lint, auth, variant, patterns, externalLinks and ext', async () => {
    await call('sdd_add_component', {
      id: 'cov-portal', name: 'Coverage Portal', description: 'The published surface',
      subsystem: 'cov', componentType: 'Portal', portalType: 'HTTP_API', basePath: '/v1',
      dependsOn: ['cov-orch'],
    });
    await call('sdd_update_spec', {
      kind: 'component', id: 'cov-portal',
      delta: {
        lint: { allow: [{ code: 'UNOWNED_STORE', reason: 'deliberate standalone store' }] },
        auth: { scheme: 'bearer', bearerFormat: 'JWT' },
        variant: 'edge-portal',
        patterns: [{ id: 'gatewaypattern', version: '1.0.0' }],
        externalLinks: [{ url: 'https://example.test/spec', type: 'informative', label: 'RFC' }],
        ext: { 'mypack:priority': 'high' },
      },
    });
    const before = await getSpec('component', 'cov-portal');
    expect(before.auth).toEqual({ scheme: 'bearer', bearerFormat: 'JWT' });

    // The exact restatement that used to erase all of it: same id, no mention
    // of anything the input cannot express, and dependsOn deliberately omitted.
    const out = await call('sdd_add_component', {
      id: 'cov-portal', name: 'Coverage Portal', description: 'The published surface v2',
      subsystem: 'cov', componentType: 'Portal', portalType: 'HTTP_API', basePath: '/v1',
    });
    expect(out).toContain('Carried forward (not expressible through this tool)');
    // …and the omission of an expressed array is reported rather than silent.
    expect(out).toContain('CLEARED by omission: dependsOn (had 1)');

    const after = await getSpec('component', 'cov-portal');
    expect(after.description).toBe('The published surface v2');
    expect(after.lint).toEqual({ allow: [{ code: 'UNOWNED_STORE', reason: 'deliberate standalone store' }] });
    expect(after.auth).toEqual({ scheme: 'bearer', bearerFormat: 'JWT' });
    expect(after.variant).toBe('edge-portal');
    expect(after.patterns).toEqual([{ id: 'gatewaypattern', version: '1.0.0' }]);
    expect(after.externalLinks).toEqual([{ url: 'https://example.test/spec', type: 'informative', label: 'RFC' }]);
    expect(after.ext).toEqual({ 'mypack:priority': 'high' });
    expect(after.dependsOn).toEqual([]);                                  // expressed → replaced, but STATED
  }, 120_000);

  it('re-defining an interface carries lint/ext and NAMES the methods it removed', async () => {
    await call('sdd_define_interface', {
      id: 'icov-portal', name: 'ICovPortal', description: 'Contract', component: 'cov-portal',
      methods: [
        { name: 'charge', description: 'Charge', signature: 'charge(id: string): void', returns: 'void' },
        { name: 'legacyPing', description: 'Probe', signature: 'legacyPing(): void', returns: 'void' },
      ],
    });
    await call('sdd_update_spec', {
      kind: 'interface', id: 'icov-portal',
      delta: { lint: { allow: [{ code: 'UNUSED_METHOD', reason: 'external tenant' }] }, ext: { 'mypack:surface': 'public' } },
    });

    const out = await call('sdd_define_interface', {
      id: 'icov-portal', name: 'ICovPortal', description: 'Contract v2', component: 'cov-portal',
      methods: [{ name: 'charge', description: 'Charge', signature: 'charge(id: string): void', returns: 'void' }],
    });
    expect(out).toContain('REMOVED by this restatement: method "legacyPing"');

    const after = await getSpec('interface', 'icov-portal');
    expect(after.lint).toEqual({ allow: [{ code: 'UNUSED_METHOD', reason: 'external tenant' }] });
    expect(after.ext).toEqual({ 'mypack:surface': 'public' });
    expect(after.methods.map((m: any) => m.name)).toEqual(['charge']);
  }, 120_000);

  it('re-authoring an implementation carries lint/ext and NAMES the narratives it removed', async () => {
    await call('sdd_write_narrative', {
      id: 'cov_portal_impl', name: 'Cov Portal Impl', description: 'Impl', contract: 'icov-portal',
      methods: [{ name: 'charge', detail: 'intent', intent: 'Charges the customer; throws on a declined card.' }],
    });
    await call('sdd_update_spec', {
      kind: 'implementation', id: 'cov_portal_impl',
      delta: { lint: { allow: [{ code: 'CALL_STEP_UNREALIZED', reason: 'generated glue' }] }, ext: { 'mypack:wave': 2 } },
    });

    const out = await call('sdd_write_narrative', {
      id: 'cov_portal_impl', name: 'Cov Portal Impl', description: 'Impl v2', contract: 'icov-portal',
      methods: [],
    });
    expect(out).toContain('REMOVED by this restatement: method "charge" (L5 narratives included)');

    const after = await getSpec('implementation', 'cov_portal_impl');
    expect(after.lint).toEqual({ allow: [{ code: 'CALL_STEP_UNREALIZED', reason: 'generated glue' }] });
    expect(after.ext).toEqual({ 'mypack:wave': 2 });
  }, 120_000);

  it('re-adding a type carries lint/ext and NAMES the fields it removed', async () => {
    await call('sdd_add_type', {
      kind: 'entity', id: 'invoice', name: 'Invoice', subsystem: 'cov',
      fields: [
        { name: 'id', type: 'string', key: 'primary' },
        { name: 'legacyCode', type: 'string' },
      ],
    });
    await call('sdd_update_spec', {
      kind: 'type', id: 'invoice',
      delta: { lint: { allow: [{ code: 'UNUSED_TYPE', reason: 'projected into the API only' }] }, ext: { 'mypack:pii': true } },
    });

    const out = await call('sdd_add_type', {
      kind: 'entity', id: 'invoice', name: 'Invoice', subsystem: 'cov',
      fields: [{ name: 'id', type: 'string', key: 'primary' }],
    });
    expect(out).toContain('REMOVED by this restatement: member "field legacyCode"');

    const after = await getSpec('type', 'invoice');
    expect(after.lint).toEqual({ allow: [{ code: 'UNUSED_TYPE', reason: 'projected into the API only' }] });
    expect(after.ext).toEqual({ 'mypack:pii': true });
    expect(after.fields.map((f: any) => f.name)).toEqual(['id']);
  }, 120_000);
});
