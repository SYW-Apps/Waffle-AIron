import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DIST_CLI, REPO_ROOT, callTool } from './helpers';
import {
  createTrialSandbox, transcript, writeFile, readFile,
  type TrialSandbox, type CliResult,
} from './trials-helpers';
import type { FixtureTree } from '../rules-matrix/harness';

// ---------------------------------------------------------------------------
// Round-5 user trials (dev.109) — identifiers, silent accepts and robustness.
//
// The tinkerer, platform, lib-and-app and solo-app personas fed the BUILT CLI
// and MCP server ids that are JavaScript prototype names, Windows device names,
// 300-character and digit-leading names and language keywords, and found
// inputs accepted without a word. Each journey replays the probe and asserts
// what a fixed build answers.
// ---------------------------------------------------------------------------

const OUTSIDE_CALLER = 'Dispatch office browsers and partner scripts, over HTTP';

function hasStackTrace(r: CliResult): boolean {
  return /^\s+at .+:\d+:\d+\)?$/m.test(r.all) || /Node\.js v\d+/.test(r.all);
}

function expectOneLineRefusal(r: CliResult, pattern: RegExp): void {
  expect(r.code, transcript(r)).not.toBe(0);
  expect(hasStackTrace(r), transcript(r)).toBe(false);
  expect(r.all, transcript(r)).toMatch(/✖/);
  expect(r.all, transcript(r)).toMatch(pattern);
}

function setProjectId(dir: string, id: string): void {
  writeFile(dir, '.wai/project.yaml', `id: ${id}\n${readFile(dir, '.wai/project.yaml')}`);
}

/** A route planner: an HTTP Portal entered from outside, an Orchestrator, and a NATS-subscribing Observer. */
function routeTree(targetLanguage = 'typescript'): FixtureTree {
  return {
    system: { name: 'RouteApp', vision: 'A route planner that plans and stores delivery routes.', targetLanguage },
    subsystems: [{ id: 'routing', description: 'Route planning.' }],
    components: [
      { id: 'route_portal', subsystem: 'routing', componentType: 'Portal', transport: 'HTTP', invokedBy: { kind: 'entry', caller: OUTSIDE_CALLER }, dependsOn: ['route_planner'] },
      { id: 'route_planner', subsystem: 'routing', componentType: 'Orchestrator' },
      { id: 'route_events', subsystem: 'routing', componentType: 'Observer', description: 'Subscribes to the route.planned subject on NATS and logs each planned route.' },
    ],
    interfaces: [
      { id: 'iroute_portal', component: 'route_portal', methods: [
        { name: 'getRoute', params: [{ name: 'routeId', type: 'string' }], returns: 'string', endpoint: { transport: 'HTTP', method: 'GET', path: '/routes/{routeId}' } },
      ] },
      { id: 'iroute_planner', component: 'route_planner', methods: [
        { name: 'plan', params: [{ name: 'routeId', type: 'string' }], returns: 'string' },
      ] },
    ],
  };
}

/** An MCP client on the built server, bound to an existing sandbox project. */
async function mcpAt(dir: string): Promise<Client> {
  const client = new Client({ name: 'wairon-e2e-r5', version: '0.0.1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [DIST_CLI, 'mcp', 'serve'],
    cwd: REPO_ROOT,
    env: { ...getDefaultEnvironment(), WAIRON_PROJECT_DIR: dir },
    stderr: 'ignore',
  }));
  return client;
}

/** What a raw JavaScript error leaking through a tool looks like. */
const RAW = /Received function|Received an instance|function Object\(\)|\[object Object\]|ERR_INVALID_ARG_TYPE|already declared as \{\}/;

// ── 1. ids that are JavaScript prototype names ───────────────────────────────

describe('journey: constructor and __proto__ as ids — a spec like any other, or one refusal (tinkerer-r5 NEW-3, platform-r5 MAJOR)', () => {
  let sb: TrialSandbox;
  let dir: string;
  let client: Client;
  beforeAll(async () => {
    sb = createTrialSandbox('r5-proto');
    dir = sb.materialize('edgelab', routeTree());
    setProjectId(dir, 'edgelab');
    client = await mcpAt(dir);
  }, 120_000);
  afterAll(async () => { try { await client?.close(); } catch { /* gone */ } await sb?.cleanup(); });

  it('sdd_add_component / sdd_add_type / sdd_delete_spec on "constructor" work; "__proto__" is refused by the id grammar', async () => {
    const comp = await callTool(client, 'sdd_add_component', { id: 'constructor', name: 'Constructor', description: 'A Store named like a prototype property.', subsystem: 'routing', componentType: 'Store', durability: 'ram-projection' });
    expect(comp.ok, comp.text).toBe(true);
    const type = await callTool(client, 'sdd_add_type', { id: 'constructor', name: 'Ctor', kind: 'value-object', fields: [{ name: 'value', type: 'string' }] });
    expect(type.ok, type.text).toBe(true);
    const proto = await callTool(client, 'sdd_add_component', { id: '__proto__', name: 'Proto', description: 'x', subsystem: 'routing', componentType: 'Store' });
    expect(proto.ok).toBe(false);
    expect(proto.text).toMatch(/__proto__.*prototype/);
    for (const r of [comp, type, proto]) expect(r.text).not.toMatch(RAW);
    const v = await callTool(client, 'sdd_validate_tree', {});
    expect(v.text).not.toMatch(/DUPLICATE_SPEC_ID/);
    expect(v.text).not.toMatch(RAW);
    for (const kind of ['type', 'component']) {
      const del = await callTool(client, 'sdd_delete_spec', { kind, id: 'constructor' });
      expect(del.ok, del.text).toBe(true);
    }
    const delProto = await callTool(client, 'sdd_delete_spec', { kind: 'component', id: '__proto__' });
    expect(delProto.text).not.toMatch(RAW);
  });

  it('a hand-written component "constructor" validates without a DUPLICATE_SPEC_ID against a built-in', async () => {
    writeFile(dir, '.wai/specs/components/constructor.yaml', [
      'schemaVersion: 1.0.0', 'id: constructor', 'name: Constructor', 'description: Written by hand.',
      'subsystem: routing', 'componentType: Store', 'durability: ram-projection', "createdAt: '2026-01-01T00:00:00.000Z'", "updatedAt: '2026-01-01T00:00:00.000Z'", '',
    ].join('\n'));
    const r = await sb.run(['validate'], dir);
    expect(r.all, transcript(r)).not.toMatch(/DUPLICATE_SPEC_ID|function Object/);
    expect(hasStackTrace(r)).toBe(false);
    fs.rmSync(path.join(dir, '.wai/specs/components/constructor.yaml'));
  });

  it('`member add __proto__` is refused for what it is — never "already declared as {}"; constructor is a member like any other', async () => {
    const proto = await sb.run(['member', 'add', '__proto__', 'services/proto'], dir);
    expectOneLineRefusal(proto, /__proto__/);
    expect(proto.all).not.toMatch(/already declared as \{\}/);
    const ctor = await sb.run(['member', 'add', 'constructor', 'services/ctor'], dir);
    expect(ctor.code, transcript(ctor)).toBe(0);
    expect(readFile(dir, '.wai/project.yaml')).toMatch(/constructor: services\/ctor/);
  });
});

// ── 2. one id grammar for every kind of id ───────────────────────────────────

describe('journey: one id grammar — project ids, aliases and member names (tinkerer-r5 NEW-6, lib-and-app R5-23, solo-app)', () => {
  let sb: TrialSandbox;
  let dir: string;
  let rust: string;
  let client: Client;
  beforeAll(async () => {
    sb = createTrialSandbox('r5-grammar');
    dir = sb.materialize('idlab', routeTree());
    setProjectId(dir, 'idlab');
    rust = sb.materialize('sdklab', {
      system: { name: 'GeoSdk', vision: 'A geospatial library for Rust applications.', targetLanguage: 'rust' },
      subsystems: [{ id: 'distance', description: 'Distances.' }],
      components: [{ id: 'distance_portal', componentType: 'Portal', transport: 'InProcess', invokedBy: { kind: 'entry', caller: 'Rust applications that add the SDK as a Cargo dependency' } }],
      interfaces: [{ id: 'idistance_portal', component: 'distance_portal', methods: [{ name: 'initial_bearing', params: [{ name: 'unit', type: 'string' }], returns: 'float' }] }],
    });
    setProjectId(rust, 'geo-sdk');
    client = await mcpAt(dir);
  }, 120_000);
  afterAll(async () => { try { await client?.close(); } catch { /* gone */ } await sb?.cleanup(); });

  it('`project rename con` and a 300-character id are refused, with the reason, by the CLI and the sdd_rename_project dry run', async () => {
    for (const id of ['con', 'a'.repeat(300), 'super']) {
      const r = await sb.run(['project', 'rename', id, '-y'], dir);
      expectOneLineRefusal(r, /device|longer than 64|namespace hop/);
      const mcp = await callTool(client, 'sdd_rename_project', { newId: id, dryRun: true });
      expect(mcp.text, mcp.text).toMatch(/device|longer than 64|namespace hop/);
    }
    expect(readFile(dir, '.wai/project.yaml')).toMatch(/^id: idlab/m);
  });

  it('`member add aux` is refused for the right reason: a Windows device name', async () => {
    const r = await sb.run(['member', 'add', 'aux', 'services/aux'], dir);
    expectOneLineRefusal(r, /reserves for a device/);
    expect(r.all).not.toMatch(/must fit \[a-z0-9-_\]\+ \(got "aux"\)/);
  });

  it('`member add x .wai` is refused: the spec directory is never a member', async () => {
    const r = await sb.run(['member', 'add', 'x', '.wai'], dir);
    expectOneLineRefusal(r, /\.wai directory/);
    expect(readFile(dir, '.wai/project.yaml')).not.toMatch(/^\s+x:/m);
  });

  it('a component id with a leading "-" is refused at the write, so no CLI command ever has to name one', async () => {
    const r = await callTool(client, 'sdd_add_component', { id: '-leading-dash', name: 'Dash', description: 'x', subsystem: 'routing', componentType: 'Orchestrator' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/starts with "-"/);
  });

  it('empty, NUL and zero-width display names are refused', async () => {
    for (const name of ['', 'nul\u0000byte', 'zero\u200bwidth']) {
      const r = await callTool(client, 'sdd_add_component', { id: 'named_one', name, description: 'x', subsystem: 'routing', componentType: 'Orchestrator' });
      expect(r.ok, JSON.stringify(name)).toBe(false);
      expect(r.text).toMatch(/Name is empty|invisible character/);
    }
  });

  it('a Rust tree refuses fn, self, type, a digit-leading and a 120-character method name, each with its reason', async () => {
    for (const [name, why] of [['fn', /Rust/], ['self', /Rust/], ['type', /Rust/], ['match', /Rust/], ['9starts_with_digit', /digit/], ['m'.repeat(120), /longer than 64/]] as const) {
      const r = await sb.run(['method', 'rename', 'distance_portal', 'initial_bearing', name, '--dry-run'], rust);
      expectOneLineRefusal(r, why);
    }
    const param = await sb.run(['method', 'rename-param', 'distance_portal', 'initial_bearing', 'unit', 'type'], rust);
    expectOneLineRefusal(param, /Rust/);
    const ok = await sb.run(['method', 'rename', 'distance_portal', 'initial_bearing', 'bearing', '--dry-run'], rust);
    expect(ok.code, transcript(ok)).toBe(0);
  });

  it('a TypeScript tree refuses constructor as a method and a keyword as a parameter — sdd_define_interface agrees with sdd_rename_method', async () => {
    const ctor = await sb.run(['method', 'rename', 'route_planner', 'plan', 'constructor', '--dry-run'], dir);
    expectOneLineRefusal(ctor, /constructor/);
    const define = await callTool(client, 'sdd_define_interface', { id: 'iroute_planner', name: 'Planner', description: 'Plans.', component: 'route_planner', methods: [
      { name: 'plan', description: 'Plans.', params: [{ name: 'routeId', type: 'string' }], returns: 'string' },
      { name: 'get_by_code', description: 'Snake case in a camelCase tree.', params: [{ name: 'class', type: 'string' }], returns: 'string' },
    ] });
    expect(define.ok).toBe(false);
    expect(define.text).toMatch(/invalid-name/);
    expect(define.text).toMatch(/camelCase/);
    expect(define.text).toMatch(/TypeScript/);
  });
});

// ── 3. silent accepts ────────────────────────────────────────────────────────

describe('journey: inputs that were accepted without a word now refuse or report (tinkerer-r5, platform-r5)', () => {
  let sb: TrialSandbox;
  let dir: string;
  let client: Client;
  beforeAll(async () => {
    sb = createTrialSandbox('r5-silent');
    dir = sb.materialize('platform', routeTree());
    setProjectId(dir, 'platform-r5');
    client = await mcpAt(dir);
  }, 120_000);
  afterAll(async () => { try { await client?.close(); } catch { /* gone */ } await sb?.cleanup(); });

  it('`status --subsystem nope` refuses, naming the subsystems the tree holds', async () => {
    const r = await sb.run(['status', '--subsystem', 'nope'], dir);
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/No subsystem "nope" in this tree — it holds routing/);
  });

  it('`diagram --depth -1`, `--depth abc` and `--subsystem nope` refuse before anything is written', async () => {
    for (const args of [['--sequence', 'route_portal:getRoute', '--depth', '-1'], ['--sequence', 'route_portal:getRoute', '--depth', 'abc']]) {
      expectOneLineRefusal(await sb.run(['diagram', ...args], dir), /--depth takes a whole number of at least 1/);
    }
    expectOneLineRefusal(await sb.run(['diagram', '--subsystem', 'nope'], dir), /No subsystem "nope"/);
  });

  it('sdd_get_network_flows resolves `project::component` and refuses a party that names nothing', async () => {
    const bare = await callTool(client, 'sdd_get_network_flows', { to: 'route_portal' });
    expect(bare.ok, bare.text).toBe(true);
    expect(bare.text).toMatch(/route_portal\.getRoute over HTTP/);
    const qualified = await callTool(client, 'sdd_get_network_flows', { to: 'platform-r5::route_portal' });
    expect(qualified.ok, qualified.text).toBe(true);
    expect(qualified.text).toBe(bare.text);
    const unknown = await callTool(client, 'sdd_get_network_flows', { to: 'platform-r5::no_such_portal' });
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toMatch(/unknown party/);
  });

  it('sdd_update_spec with `publicInterfaces: []` clears the table instead of being silently ignored', async () => {
    const set = await callTool(client, 'sdd_set_public_interfaces', { subsystem: 'routing', publicInterfaces: [{ component: 'route_portal', details: 'The route API.' }] });
    expect(set.ok, set.text).toBe(true);
    const clear = await callTool(client, 'sdd_update_spec', { kind: 'subsystem', id: 'routing', delta: { publicInterfaces: [] } });
    expect(clear.ok, clear.text).toBe(true);
    expect(clear.text).not.toMatch(/No change/);
    const read = await callTool(client, 'sdd_get_spec', { kind: 'subsystem', id: 'routing' });
    expect(read.text).toMatch(/"publicInterfaces": \[\]/);
  });

  it('duplicate, unknown and unclosed path placeholders, duplicate method and param names and a self-naming previousNames are reported', async () => {
    const intf = readFile(dir, '.wai/specs/interfaces/iroute_portal.yaml');
    expect(intf).toMatch(/path: \/routes\/\{routeId\}/);
    writeFile(dir, '.wai/specs/interfaces/iroute_portal.yaml', intf
      .replace('path: /routes/{routeId}', 'path: /routes/{routeId}/{routeId}/{b}/{open'));
    const planner = readFile(dir, '.wai/specs/interfaces/iroute_planner.yaml');
    const doc = yaml.load(planner) as { methods: { name: string; previousNames?: string[]; params?: { name: string; type: string }[] }[] };
    const twin = { ...doc.methods[0], params: [{ name: 'routeId', type: 'string' }, { name: 'routeId', type: 'string' }] };
    doc.methods[0].previousNames = ['plan'];
    doc.methods.push(twin);
    writeFile(dir, '.wai/specs/interfaces/iroute_planner.yaml', yaml.dump(doc));
    const r = await sb.run(['validate'], dir);
    expect(r.all, transcript(r)).toMatch(/\[ENDPOINT_PATH_PLACEHOLDER\][^\n]*twice/);
    expect(r.all).toMatch(/\[ENDPOINT_PATH_PLACEHOLDER\][^\n]*"\{b\}" names no parameter/);
    expect(r.all).toMatch(/\[ENDPOINT_PATH_PLACEHOLDER\][^\n]*never closed/);
    expect(r.all).toMatch(/\[RENAME_TRACE_CONFLICT\][^\n]*its own key/);
    expect(r.all).toMatch(/\[DUPLICATE_MEMBER_NAME\][^\n]*declares the method "plan" twice/);
    expect(r.all).toMatch(/\[DUPLICATE_MEMBER_NAME\][^\n]*declares the parameter "routeId" twice/);
    writeFile(dir, '.wai/specs/interfaces/iroute_portal.yaml', intf);
    writeFile(dir, '.wai/specs/interfaces/iroute_planner.yaml', planner);
  });

  it('an Observer naming its messaging technology in its own description is no TECH_LEAKAGE (platform-r5)', async () => {
    const add = await callTool(client, 'sdd_add_component', { id: 'nats_publisher', name: 'NATS Publisher', description: 'Publishes route.planned.', subsystem: 'routing', componentType: 'Adapter' });
    expect(add.ok, add.text).toBe(true);
    const contract = await callTool(client, 'sdd_define_interface', { id: 'inats_publisher', name: 'Publisher', description: 'Publishes events.', component: 'nats_publisher', methods: [{ name: 'publish', description: 'Publish one event.', params: [{ name: 'routeId', type: 'string' }], returns: 'void', effect: 'io' }] });
    expect(contract.ok, contract.text).toBe(true);
    const impl = await callTool(client, 'sdd_write_narrative', { id: 'nats_publisher_impl', name: 'NATS publisher', description: 'Publishes over NATS.', contract: 'inats_publisher', technologies: ['nats'], detail: 'intent', methods: [{ name: 'publish', intent: 'Publishes the event.' }] });
    expect(impl.ok, impl.text).toBe(true);
    const r = await sb.run(['validate'], dir);
    expect(r.all, transcript(r)).not.toMatch(/\[route_events\] \[TECH_LEAKAGE\]/);
  });
});

// ── 4. validate names the compiler; lock counts drafts and keeps lockedAt ────

describe('journey: validate names how it read the code; lock counts every draft and keeps lockedAt (tinkerer-r5, lib-and-app R5-26)', () => {
  let sb: TrialSandbox;
  let dir: string;
  beforeAll(() => {
    sb = createTrialSandbox('r5-lock');
    dir = sb.materialize('linkshort', routeTree());
    setProjectId(dir, 'linkshort');
  });
  afterAll(async () => { await sb?.cleanup(); });

  it('validate prints one code-reading line', async () => {
    const r = await sb.run(['validate'], dir);
    expect(r.all, transcript(r)).toMatch(/Code: none read yet|Code read at grade/);
  });

  it('a re-run of `lock -y` with nothing changed leaves .wai/lock.json untouched', async () => {
    const first = await sb.run(['lock', '-y'], dir);
    expect(first.code, transcript(first)).toBe(0);
    const before = readFile(dir, '.wai/lock.json');
    const again = await sb.run(['lock', '-y'], dir);
    expect(again.code, transcript(again)).toBe(0);
    expect(readFile(dir, '.wai/lock.json')).toBe(before);
  });
});
