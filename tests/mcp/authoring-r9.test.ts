/**
 * Round-9 trial findings on the MCP authoring tools (solo-app, platform,
 * tinkerer — dev.113), driven through the server in process. Every test here
 * failed on dev.113.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, saveSpec } from '../../src/core/specs.js';
import { provisionProject } from '../../src/core/provision.js';
import { pinExternals } from '../../src/core/surfaces.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> };

const roots: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wairon-r9mcp-${prefix}-`)));
  roots.push(dir);
  return dir;
}

function project(dir: string, tree: FixtureTree, id?: string, extra: Record<string, unknown> = {}): string {
  materializeFixtureProject(dir, tree);
  const file = path.join(dir, '.wai', 'project.yaml');
  const config = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(file, yaml.dump({ ...config, ...(id ? { id, name: id } : {}), ...extra }));
  return dir;
}

async function connectAt(dir: string): Promise<Client> {
  setProjectRoot(dir);
  invalidateSpecCache();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'authoring-r9', version: '0.0.1' });
  clients.push(client);
  await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult & { text: string }> {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { ...r, text: (r.content ?? []).map((c) => c.text ?? '').join('\n') };
}

/** cal: an independent project exporting a contract entry and a type. */
function calProject(dir: string): string {
  return project(dir, {
    system: {
      name: 'cal-lib', vision: 'A calendar library.', targetLanguage: 'TypeScript',
      publicInterfaces: [
        { from: 'cal', component: 'cal_portal', as: 'calendar', audience: 'external' },
        { from: 'cal', typeDef: 'cadence', audience: 'external' },
      ],
    },
    subsystems: [{ id: 'cal', status: 'complete', publicInterfaces: [{ component: 'cal_portal', details: 'Calendars.' }, { typeDef: 'cadence', details: 'A cadence.' }] }],
    components: [{ id: 'cal_portal', subsystem: 'cal', componentType: 'Portal', transport: 'InProcess', invokedBy: { kind: 'entry', caller: 'Applications linking it.' }, status: 'complete' }],
    interfaces: [{ id: 'ical_portal', component: 'cal_portal', methods: [{ name: 'next', description: 'The next date.', params: [{ name: 'c', type: 'cadence' }], returns: 'string', effect: 'none' }] }],
    types: [{ id: 'cadence', kind: 'value-object', subsystem: 'cal', fields: [{ name: 'every', type: 'int' }] }],
  }, 'cal-lib');
}

/** habits: consumes cal as the external `ext`, and holds a member `legacy` (a project) under vendor/legacy. */
function habits(base: string): string {
  calProject(path.join(base, 'cal'));
  const app = project(path.join(base, 'habits'), {
    system: { name: 'habits', vision: 'Habits.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'habit', status: 'complete' }],
    components: [{ id: 'habit_flow', subsystem: 'habit', componentType: 'Orchestrator', status: 'complete' }],
  }, 'habits', { externals: { ext: { project: 'cal-lib', source: { path: '../cal' } } }, members: { legacy: 'vendor/legacy' } });
  project(path.join(app, 'vendor', 'legacy'), {
    system: { name: 'legacy-api', vision: 'The old API.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'old', component: 'habit_portal', audience: 'project' }] },
    subsystems: [{ id: 'old', status: 'complete', publicInterfaces: [{ component: 'habit_portal', details: 'Habits.' }] }],
    components: [
      { id: 'habit_portal', subsystem: 'old', componentType: 'Portal', transport: 'HTTP', invokedBy: { kind: 'entry', caller: 'Old clients.' }, status: 'complete' },
      { id: 'habit_store', subsystem: 'old', componentType: 'Store', durability: 'ram-projection', status: 'complete' },
    ],
    interfaces: [{ id: 'ihabit_portal', component: 'habit_portal', methods: [{ name: 'list', description: 'List habits.', params: [{ name: 'user', type: 'string' }], returns: 'list<string>', endpoint: { transport: 'HTTP', method: 'GET', path: '/habits' } }] }],
  }, 'legacy-api');
  setProjectRoot(app);
  invalidateSpecCache();
  pinExternals(['ext']);
  invalidateSpecCache();
  return app;
}

describe('item 9 (solo-app): sdd_get_spec resolves alias::name as the writes do, and reads an external from its pin', () => {
  it('a member spec reads by its alias; an external\'s type and contract entry read from the pin, marked read-only', async () => {
    const app = habits(scratch('getspec'));
    const client = await connectAt(app);
    const member = await call(client, 'sdd_get_spec', { kind: 'component', id: 'legacy::habit_store' });
    expect(member.isError, member.text).toBeFalsy();
    expect(member.text).toContain('habit_store');

    const type = await call(client, 'sdd_get_spec', { kind: 'type', id: 'ext::cadence' });
    expect(type.isError, type.text).toBeFalsy();
    expect(type.structuredContent?.pinnedSnapshot).toMatchObject({ alias: 'ext', project: 'cal-lib', file: '.wai/externals/ext.yaml', readOnly: true });
    expect(JSON.stringify(type.structuredContent?.spec)).toContain('every');

    const entry = await call(client, 'sdd_get_spec', { id: 'ext::calendar' });
    expect(entry.isError, entry.text).toBeFalsy();
    expect(entry.structuredContent?.kind).toBe('interface');
    expect(JSON.stringify(entry.structuredContent?.spec)).toContain('next');

    const missing = await call(client, 'sdd_get_spec', { kind: 'type', id: 'ext::nothing' });
    expect(missing.isError).toBe(true);
  });
});

describe('item 10: refusal wording names the tool and the project', () => {
  it('sdd_set_endpoints and sdd_set_public_interfaces on a member name themselves, never sdd_update_spec', async () => {
    const app = habits(scratch('wording'));
    const client = await connectAt(app);
    const endpoints = await call(client, 'sdd_set_endpoints', { interfaceId: 'legacy::ihabit_portal', bindings: [{ method: 'list', transport: 'HTTP', httpMethod: 'GET', path: '/v2/habits' }] });
    expect(endpoints.isError).toBe(true);
    expect(endpoints.text).toMatch(/sdd_set_endpoints/);
    expect(endpoints.text).not.toMatch(/sdd_update_spec/);
    const exports = await call(client, 'sdd_set_public_interfaces', { subsystem: 'legacy::old', publicInterfaces: [] });
    expect(exports.isError).toBe(true);
    expect(exports.text).toMatch(/sdd_set_public_interfaces/);
    expect(exports.text).not.toMatch(/sdd_update_spec/);
  });

  it('a rename through an external\'s alias is the boundary refusal, never component-missing', async () => {
    const app = habits(scratch('renameext'));
    const client = await connectAt(app);
    const r = await call(client, 'sdd_rename_method', { id: 'ext::cal_portal', method: 'next', newName: 'following' });
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/component-missing/);
    expect(r.text).toMatch(/external "cal-lib".*only reads through its pin/s);
  });

  it('sdd_add_member says so when it creates a folder outside the project', async () => {
    const base = scratch('addmember');
    const app = project(path.join(base, 'app'), { system: { name: 'app', vision: 'An app.' }, subsystems: [{ id: 'core', status: 'complete' }] }, 'app');
    const client = await connectAt(app);
    const r = await call(client, 'sdd_add_member', { alias: 'sib', source: '../sib' });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toMatch(/Created a new folder OUTSIDE this project/);
    const again = await call(client, 'sdd_add_member', { alias: 'inner', source: 'libs/inner' });
    expect(again.text).not.toMatch(/OUTSIDE/);
  });
});

describe('item 2 (solo-app): sdd_move_spec takes `together`', () => {
  it('moves a connected cluster through the tool in one call', async () => {
    const dir = project(scratch('together'), {
      subsystems: [{ id: 'app', status: 'complete' }, { id: 'accounts', status: 'complete' }],
      components: [
        { id: 'account_flow', subsystem: 'app', componentType: 'Orchestrator', dependsOn: ['user_store'], status: 'complete' },
        { id: 'user_store', subsystem: 'app', componentType: 'Store', durability: 'ram-projection', status: 'complete' },
      ],
    });
    const client = await connectAt(dir);
    const single = await call(client, 'sdd_move_spec', { kind: 'component', id: 'user_store', subsystem: 'accounts', dryRun: true });
    expect(single.isError).toBe(true);
    expect(single.text).toMatch(/together: \["account_flow"\]/);
    const both = await call(client, 'sdd_move_spec', { kind: 'component', id: 'user_store', subsystem: 'accounts', together: ['account_flow'] });
    expect(both.isError, both.text).toBeFalsy();
    expect(both.text).toContain('account_flow');
  });
});

// ---------------------------------------------------------------------------
// Item 3 (tinkerer, EDGE) — the property: no write tool, fed a path-shaped
// name in any argument it turns into a path, writes anything outside the
// project's tree. Every write tool the server advertises is walked with every
// name argument replaced by each path-shaped value, and the whole folder
// around the project — a sibling project included — is hashed before and
// after.
// ---------------------------------------------------------------------------

/** Every file under a folder by digest, a project's .wai/specs left out: what no write may change. */
function outsideTree(base: string, own: string): Record<string, string> {
  const out: Record<string, string> = {};
  const ownSpecs = path.join(own, '.wai', 'specs');
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (full === ownSpecs) continue;
      // The tree's own write lock exists only while a write runs.
      if (e.name === '.spec-write.lock') continue;
      if (e.isDirectory()) {
        out[`${path.relative(base, full)}/`] = 'dir';
        walk(full);
      } else out[path.relative(base, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(base);
  return out;
}

/** The arguments a write tool turns into a path: ids, subsystems, components, contracts, aliases. */
const NAME_ARGS = new Set(['id', 'newId', 'subsystem', 'component', 'contract', 'interfaceId', 'from', 'to', 'type', 'typeId', 'group', 'alias', 'newAlias', 'home', 'newName', 'method', 'field', 'param']);
/** A member's or a part's source is a path by design (its own containment guard judges it), never a name. */
const PATH_ARGS = new Set(['source', 'path']);
const PATH_SHAPED = ['../../../sib/.wai/specs/sib', '../../sib/.wai/specs/subsystems/sib', 'links/../analytics', '..\\..\\sib', 'Links', '/tmp/x'];

/** A project in the NESTED layout (a folder per subsystem and component), as `wairon init` makes it — the layout a subsystem id becomes a folder in. */
function nested(dir: string, name: string, subsystems: string[], extra: () => void = () => {}): string {
  const now = '2026-10-09T00:00:00.000Z';
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  setProjectRoot(dir);
  invalidateSpecCache();
  provisionProject(name);
  for (const id of subsystems) {
    saveSpec('subsystem', { id, name: id, description: `${id} subsystem`, parentSystem: name, publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now } as never);
  }
  extra();
  invalidateSpecCache();
  setProjectRoot(null);
  return dir;
}

describe('item 3 (tinkerer, EDGE): property — no write tool writes outside the tree for a path-shaped name', () => {
  it('walks every advertised write tool with each path-shaped value in each name argument', async () => {
    const base = scratch('property');
    const now = '2026-10-09T00:00:00.000Z';
    const own = nested(path.join(base, 'proj'), 'proj', ['links', 'analytics'], () => {
      saveSpec('component', { id: 'link_store', name: 'S', description: 's', subsystem: 'links', componentType: 'Store', durability: 'ram-projection', owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now } as never);
      saveSpec('interface', { id: 'ilink_store', name: 'S', description: 's', component: 'link_store', methods: [{ name: 'get', description: 'g', params: [{ name: 'code', type: 'string' }], returns: 'string', effect: 'read' }], status: 'complete', createdAt: now, updatedAt: now } as never);
      saveSpec('implementation', { id: 'link_store_impl', name: 'I', description: 'i', contract: 'ilink_store', methods: [{ name: 'get', narrative: [] }], status: 'complete', createdAt: now, updatedAt: now } as never);
      saveSpec('type', { kind: 'value-object', id: 'link_stats', name: 'LinkStats', subsystem: 'analytics', fields: [{ name: 'hits', type: 'int' }], methods: [], createdAt: now, updatedAt: now } as never);
    });
    nested(path.join(base, 'sib'), 'sib', ['sib']);
    expect(fs.existsSync(path.join(own, '.wai', 'specs', 'links', '.index.yaml')), 'the nested layout').toBe(true);
    const before = outsideTree(base, own);
    const client = await connectAt(own);
    const tools = (await client.listTools()).tools;
    // Plausible arguments per tool, so each call reaches the code that builds a path.
    const baseArgs: Record<string, Record<string, unknown>> = {
      sdd_add_subsystem: { id: 'probe', name: 'Probe', description: 'probe' },
      sdd_set_public_interfaces: { subsystem: 'links', publicInterfaces: [] },
      sdd_add_component: { id: 'probe', name: 'Probe', description: 'probe', subsystem: 'links', componentType: 'Orchestrator' },
      sdd_define_interface: { id: 'iprobe', name: 'Probe', description: 'probe', component: 'link_store', methods: [{ name: 'get', description: 'g', params: [{ name: 'code', type: 'string' }], returns: 'string', effect: 'read' }] },
      sdd_write_narrative: { id: 'probe_impl', name: 'Probe', description: 'probe', contract: 'ilink_store', methods: [{ name: 'get', narrative: [] }] },
      sdd_add_type: { id: 'probe_type', name: 'Probe', description: 'probe', kind: 'value-object', subsystem: 'analytics', fields: [{ name: 'v', type: 'string' }] },
      sdd_update_spec: { kind: 'component', id: 'link_store', delta: { description: 'x' } },
      sdd_delete_spec: { kind: 'type', id: 'link_stats', dryRun: true },
      sdd_move_spec: { kind: 'type', id: 'link_stats', subsystem: 'links', dryRun: true },
      sdd_move_methods: { from: 'link_store', to: 'link_store', methods: ['get'], dryRun: true },
      sdd_rename_component: { id: 'link_store', newId: 'link_store2', dryRun: true },
      sdd_rename_method: { id: 'link_store', method: 'get', newName: 'fetch', dryRun: true },
      sdd_rename_param: { id: 'link_store', method: 'get', param: 'code', newName: 'key', dryRun: true },
      sdd_rename_type: { id: 'link_stats', newId: 'stats', dryRun: true },
      sdd_rename_field: { type: 'link_stats', field: 'hits', newName: 'count', dryRun: true },
      sdd_rename_spec: { kind: 'interface', id: 'ilink_store', newId: 'ilinks', dryRun: true },
      sdd_set_endpoints: { interfaceId: 'ilink_store', bindings: [] },
      sdd_add_member: { alias: 'probe', source: 'libs/probe' },
      sdd_rename_member_alias: { alias: 'probe', newAlias: 'probe2', dryRun: true },
    };
    let calls = 0;
    for (const tool of tools) {
      const args = baseArgs[tool.name];
      if (!args) continue;
      const names = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})
        .filter((k) => NAME_ARGS.has(k) && !PATH_ARGS.has(k) && typeof args[k] === 'string');
      for (const name of names) {
        for (const bad of PATH_SHAPED) {
          await call(client, tool.name, { ...args, [name]: bad });
          calls++;
          expect(outsideTree(base, own), `${tool.name} ${name}=${bad}`).toEqual(before);
        }
      }
    }
    expect(calls).toBeGreaterThan(80);
  }, 300_000);
});
