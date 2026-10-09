import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { FixtureTree } from '../rules-matrix/harness';
import { createTrialSandbox, countCode, gitInit, readFile, transcript, writeFile, type TrialSandbox } from './trials-helpers';
import { round8 } from '../rules-matrix/families/conformance-binding.fixtures';
import { projectYaml } from '../helpers/conformance-r6-trees';

// ---------------------------------------------------------------------------
// Round-8 user trials — surfaces, externals, binding modules, rename break
// reports and the OpenAPI codec, replayed against the BUILT CLI:
//   1. the OpenAPI document: `::` in component keys, each type two or three
//      times; no way to say 202 or 302 (or 201 for a workflow verb); a `T?`
//      field required; field descriptions dropped.
//   2. `surface diff` said "no change" when an endpoint's path or verb moved.
//   3. a rename's break report missed the consumers that reach the type only
//      through an exported Portal's verbs; `externals consumers` never marked
//      a call that no longer resolves.
//   4. CommonJS bindings read in one shape only; the advisory live drift never
//      named the binding a consumer must update.
// ---------------------------------------------------------------------------

let sb: TrialSandbox;
let seq = 0;

beforeAll(() => { sb = createTrialSandbox('r8surf'); });
afterAll(async () => { await sb?.cleanup(); });

/** A project written from a fixture tree into `dir`, its configuration given. */
function writeProject(dir: string, tree: FixtureTree, config: string): void {
  const at = sb.materialize(`tmp${++seq}`, { ...tree, files: { ...(tree.files ?? {}), '.wai/project.yaml': config } });
  fs.cpSync(at, dir, { recursive: true });
  fs.rmSync(at, { recursive: true, force: true });
}

/** Habitly's API: an HTTP Portal exported to other projects, its verbs answering its own (unexported) habit type. */
function habitly(): FixtureTree {
  return {
    system: {
      name: 'Habitly', vision: 'A habit-tracking API for the mobile app.', targetLanguage: 'TypeScript',
      publicInterfaces: [{ from: 'habits', component: 'habit_portal', audience: 'instance' }],
    },
    subsystems: [{ id: 'habits', description: 'Habits and check-ins.', publicInterfaces: [{ component: 'habit_portal', details: 'The habit API.' }] }],
    components: [{ id: 'habit_portal', componentType: 'Portal', transport: 'HTTP', description: 'The habit API the mobile app calls.', invokedBy: { kind: 'entry', caller: 'The Habitly mobile app, over HTTP' } }],
    interfaces: [{
      id: 'ihabit_portal', component: 'habit_portal',
      methods: [
        { name: 'listHabits', description: 'Every habit of the caller.', params: [], returns: 'list<habit>', effect: 'read', endpoint: { transport: 'HTTP', method: 'GET', path: '/habits' } },
        { name: 'acceptHit', description: 'Record a check-in later: 202 Accepted.', params: [{ name: 'habitId', type: 'string' }], returns: 'async void', effect: 'write', endpoint: { transport: 'HTTP', method: 'POST', path: '/habits/{habitId}/hits', status: 202 } },
      ],
    }],
    types: [{
      id: 'habit', kind: 'value-object', subsystem: 'habits', name: 'Habit', description: 'One habit.',
      fields: [
        { name: 'name', type: 'string', description: '1-100 characters' },
        { name: 'rhythm', type: 'string', description: 'daily or weekly' },
        { name: 'note', type: 'string?', description: 'Free text, or none' },
      ],
    }],
    implementations: [{
      id: 'habit_portal_impl', contract: 'ihabit_portal',
      methods: [
        { name: 'listHabits', narrative: [{ stepNumber: 1, description: 'Answer the caller\'s habits', type: 'return', outcome: 'success' }] },
        { name: 'acceptHit', narrative: [{ stepNumber: 1, description: 'Queue the check-in and answer at once', type: 'return', outcome: 'accepted' }] },
      ],
    }],
  };
}

/** A consumer of Habitly's API (alias `legacy`): its adapter calls listHabits, through a hand-written binding when given. */
function habitSync(binding?: string): FixtureTree {
  return {
    system: { name: 'HabitSync', vision: 'Mirrors habits from the legacy Habitly API.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'sync', description: 'The mirror.' }],
    components: [{ id: 'habit_mirror_adapter', componentType: 'Adapter', description: 'Reads the legacy habits over HTTP.', dependsOn: ['legacy::habit_portal'], invokedBy: { kind: 'runtime', caller: 'The nightly mirror job the composition root schedules' } }],
    interfaces: [{ id: 'ihabit_mirror_adapter', component: 'habit_mirror_adapter', methods: [{ name: 'mirror', description: 'Mirror every habit; answers how many.', params: [], returns: 'int', effect: 'io' }] }],
    implementations: [{
      id: 'habit_mirror_adapter_impl', contract: 'ihabit_mirror_adapter', sourcePath: 'src/habit-mirror.ts',
      ...(binding ? { bindings: ['src/legacy-binding.ts'] } : {}),
      methods: [{ name: 'mirror', detail: 'intent', intent: 'Reads every legacy habit and counts them.', calls: ['legacy::habit_portal.listHabits'] }],
    }],
    files: binding ? { 'src/legacy-binding.ts': binding } : {},
  };
}

/** Every component key valid, every $ref resolving, every key referenced. */
function componentProblems(document: string): string[] {
  const doc = JSON.parse(document) as { components?: { schemas?: Record<string, unknown> } };
  const keys = Object.keys(doc.components?.schemas ?? {});
  const refs = new Set<string>();
  JSON.stringify(doc, (k, v) => { if (k === '$ref' && typeof v === 'string') refs.add(v); return v; });
  return [
    ...keys.filter((k) => !/^[a-zA-Z0-9._-]+$/.test(k)).map((k) => `invalid key ${k}`),
    ...[...refs].filter((r) => !keys.includes(r.split('/').pop()!)).map((r) => `dangling ${r}`),
    ...keys.filter((k) => !refs.has(`#/components/schemas/${k}`)).map((k) => `unreferenced ${k}`),
  ];
}

describe('1. the OpenAPI export (platform MAJOR, tinkerer MAJOR 6, lib-and-app R8-12, solo-app)', () => {
  it('a gateway answering a member\'s types keys each once, validly, and only those it references', async () => {
    const dir = sb.project('gateway');
    writeProject(dir, {
      system: { name: 'Gateway', vision: 'The shop API gateway.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'shared', typeDef: 'order_view', audience: 'project' }] },
      subsystems: [{ id: 'edge', description: 'The public API.' }],
      components: [{ id: 'shop_portal', componentType: 'Portal', transport: 'HTTP', description: 'The shop API.', invokedBy: { kind: 'entry', caller: 'The shop web client, over HTTP' } }],
      interfaces: [{ id: 'ishop_portal', component: 'shop_portal', methods: [
        { name: 'placeOrder', description: 'Place an order.', params: [{ name: 'request', type: 'shared::order_request' }], returns: 'shared::order_view', effect: 'write', endpoint: { transport: 'HTTP', method: 'POST', path: '/orders', status: 201 } },
      ] }],
      implementations: [{ id: 'shop_portal_impl', contract: 'ishop_portal', methods: [{ name: 'placeOrder', narrative: [{ stepNumber: 1, description: 'Accept the order and answer its view', type: 'return', outcome: 'success' }] }] }],
    }, projectYaml('gateway', { members: { shared: 'libs/contracts' } }));
    writeProject(path.join(dir, 'libs', 'contracts'), {
      system: { name: 'Contracts', vision: 'The shared order contracts.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'orders', typeDef: 'order_request', audience: 'project' }, { from: 'orders', typeDef: 'order_view', audience: 'project' }] },
      subsystems: [{ id: 'orders', description: 'Order contracts.', publicInterfaces: [{ typeDef: 'order_request' }, { typeDef: 'order_view' }] }],
      types: [
        { id: 'money', kind: 'value-object', subsystem: 'orders', name: 'Money', description: 'An amount.', fields: [{ name: 'amountMinor', type: 'int' }] },
        { id: 'order_request', kind: 'value-object', subsystem: 'orders', name: 'OrderRequest', description: 'A request.', fields: [{ name: 'sku', type: 'string' }, { name: 'price', type: 'money' }] },
        { id: 'order_view', kind: 'value-object', subsystem: 'orders', name: 'OrderView', description: 'An order.', fields: [{ name: 'id', type: 'string' }, { name: 'total', type: 'money' }] },
      ],
    }, projectYaml('contracts'));
    const out = path.join(dir, 'gateway.openapi.json');
    const r = await sb.run(['surface', 'export', '--format', 'openapi', '--out', out], dir);
    expect(r.code, transcript(r)).toBe(0);
    const document = fs.readFileSync(out, 'utf8');
    expect(componentProblems(document)).toEqual([]);
    const doc = JSON.parse(document);
    expect(Object.keys(doc.components.schemas).sort()).toEqual(['shared.money', 'shared.order_request', 'shared.order_view']);
    // The stated 201 for a workflow verb (round 8 exported 200: its name says no create).
    expect(Object.keys(doc.paths['/orders'].post.responses)).toEqual(['201']);
  });

  it('answers a stated 202, leaves a `T?` field out of required, and carries field descriptions', async () => {
    const dir = sb.project('habitly-oas');
    writeProject(dir, habitly(), projectYaml('habitly-api'));
    const out = path.join(dir, 'habits.json');
    const r = await sb.run(['surface', 'export', '--format', 'openapi', '--out', out], dir);
    expect(r.code, transcript(r)).toBe(0);
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(componentProblems(JSON.stringify(doc))).toEqual([]);
    expect(Object.keys(doc.paths['/habits/{habitId}/hits'].post.responses)).toEqual(['202']);
    expect(doc.components.schemas.habit.required).toEqual(['name', 'rhythm']);
    expect(doc.components.schemas.habit.properties.rhythm.description).toBe('daily or weekly');
  });
});

describe('2. `surface diff` reports an endpoint moving (lib-and-app R8-11)', () => {
  it('a path or verb changed in the working tree is a change of the Portal verb, never "no change"', async () => {
    const dir = sb.project('habitly-diff');
    writeProject(dir, habitly(), projectYaml('habitly-api'));
    const lock = await sb.run(['lock', '--yes'], dir);
    expect(lock.code, transcript(lock)).toBe(0);
    gitInit(dir);
    const quiet = await sb.run(['surface', 'diff', '--json'], dir);
    expect((JSON.parse(quiet.stdout) as { changes: unknown[] }).changes, transcript(quiet)).toEqual([]);
    const contract = fs.readdirSync(path.join(dir, '.wai', 'specs', 'interfaces')).find((f) => f.startsWith('ihabit_portal'))!;
    const rel = `.wai/specs/interfaces/${contract}`;
    writeFile(dir, rel, readFile(dir, rel).replace('path: /habits\n', 'path: /v1/habits\n').replace('method: GET', 'method: PUT'));
    const diff = await sb.run(['surface', 'diff', '--json', '--against', 'HEAD'], dir);
    expect(diff.code, transcript(diff)).toBe(0);
    const changes = (JSON.parse(diff.stdout) as { changes: { kind: string; name: string; member?: string; detail: string }[] }).changes;
    expect(changes).toContainEqual({ kind: 'changed', name: 'habit_portal', member: 'listHabits', detail: 'endpoint GET /habits → PUT /v1/habits' });
  });
});

describe('3. rename break reports and consumers (solo-app top-2, lib-and-app R8-18)', () => {
  it('a field rename names the consumer that reaches the type only through the Portal\'s verbs', async () => {
    const folder = sb.project('consumers');
    const producer = path.join(folder, 'producer');
    writeProject(producer, habitly(), projectYaml('habitly-api'));
    writeProject(path.join(folder, 'consumer'), habitSync(), projectYaml('habit-sync', { externals: { legacy: { project: 'habitly-api', source: { path: '../producer' } } } }));
    const dry = await sb.run(['type', 'rename-field', 'habit', 'rhythm', 'tempo', '--dry-run', '--search', '..'], producer);
    expect(dry.code, transcript(dry)).toBe(0);
    expect(dry.all).toContain('Published as: habit_portal');
    // Round 8: "No consumer in reach does (the searched folders included)".
    expect(dry.all).toMatch(/1 consumer\(s\) read "habits::habit" and must follow the rename/);
    expect(dry.all).toContain('habit-sync (externals.legacy)');
  });

  it('`externals consumers` marks a verb a consumer still calls that the producer no longer holds', async () => {
    const folder = sb.project('consumers-broken');
    const producer = path.join(folder, 'producer');
    writeProject(producer, habitly(), projectYaml('habitly-api'));
    writeProject(path.join(folder, 'consumer'), habitSync(), projectYaml('habit-sync', { externals: { legacy: { project: 'habitly-api', source: { path: '../producer' } } } }));
    const rename = await sb.run(['method', 'rename', 'habit_portal', 'listHabits', 'allHabits'], producer);
    expect(rename.code, transcript(rename)).toBe(0);
    const r = await sb.run(['externals', 'consumers', '--search', '..'], producer);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toContain('habit_portal.listHabits (no longer exported)');
  });
});

describe('4. binding modules (tinkerer MAJOR 5, platform)', () => {
  it('a CommonJS client exported as `module.exports = { Client }` is compared, its private helper left alone', async () => {
    const drift = await sb.run(['validate'], sb.materialize(`b${++seq}`, round8.commonJsShorthand.tree));
    expect(drift.all, transcript(drift)).toMatch(/\[BINDING_DRIFT\][^\n]*"tileFor" was renamed to "tileAt" in geokit::tiles/);
    expect(drift.all).not.toContain('"_call"');
    const quiet = await sb.run(['validate'], sb.materialize(`b${++seq}`, round8.commonJsShorthandControl.tree));
    expect(countCode(quiet.all, 'BINDING_DRIFT'), transcript(quiet)).toBe(0);
    expect(countCode(quiet.all, 'BINDING_UNREAD')).toBe(0);
  });

  it('the advisory live drift names the binding module the consumer must update before the re-pin', async () => {
    const folder = sb.project('advisory');
    const producer = path.join(folder, 'producer');
    const consumer = path.join(folder, 'consumer');
    writeProject(producer, habitly(), projectYaml('habitly-api'));
    writeProject(consumer, habitSync('/** legacy::habit_portal */\nexport interface HabitApi {\n  listHabits(): Promise<Habit[]>;\n}\nexport interface Habit { name: string; rhythm: string; note?: string }\n'),
      projectYaml('habit-sync', { externals: { legacy: { project: 'habitly-api', source: { path: '../producer' } } } }));
    const pin = await sb.run(['externals', 'pin', 'legacy'], consumer);
    expect(pin.code, transcript(pin)).toBe(0);
    const rename = await sb.run(['method', 'rename', 'habit_portal', 'listHabits', 'allHabits'], producer);
    expect(rename.code, transcript(rename)).toBe(0);
    const r = await sb.run(['validate'], consumer);
    expect(r.all, transcript(r)).toMatch(/\[EXTERNAL_LIVE_INCOMPATIBLE\][^\n]*Binding module\(s\) declared there: "src\/legacy-binding\.ts"[^\n]*draws BINDING_DRIFT once the re-pin lands/);
  });
});
