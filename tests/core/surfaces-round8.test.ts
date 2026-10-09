import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, saveSystemSpec, saveSpec, saveComponentSpec, saveInterfaceSpec } from '../../src/core/specs.js';
import { withForeignTypes } from '../../src/core/surfaces.js';
import { renameField, renameType } from '../../src/core/provision.js';
import { fromOpenApi, toOpenApiSet } from '../../src/core/openapi.js';
import { readDeclarations, readUnreadForms } from '../../src/core/binding-modules.js';
import { narrowedToUses, surfaceChanges, SurfaceSnapshotSchema, type SurfaceSnapshot } from '../../src/models/index.js';
import type { ComponentSpec, ExternalConsumer, SubsystemSpec, TypeSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Round-8 sandbox trials — surfaces, externals, binding modules, rename break
// reports and the OpenAPI codec. Each block replays one finding on a
// miniature project or snapshot.
// ---------------------------------------------------------------------------

const NOW = '2026-10-09T10:00:00.000Z';
const roots: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const dir of roots.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
  }
});

const snap = (over: Partial<SurfaceSnapshot>): SurfaceSnapshot => SurfaceSnapshotSchema.parse({ projectName: 'p', origin: 'generated', generatedAt: NOW, interfaces: [], types: [], ...over });

/**
 * Every component key a document holds matches OpenAPI's key pattern, every
 * $ref names a key it holds, and every key is referenced: what makes the
 * document valid, and free of the dead duplicates round 8 found.
 */
export function componentProblems(document: string): string[] {
  const doc = JSON.parse(document) as { components?: { schemas?: Record<string, unknown> } };
  const keys = Object.keys(doc.components?.schemas ?? {});
  const refs = new Set<string>();
  JSON.stringify(doc, (k, v) => { if (k === '$ref' && typeof v === 'string') refs.add(v); return v; });
  return [
    ...keys.filter((k) => !/^[a-zA-Z0-9._-]+$/.test(k)).map((k) => `invalid key ${k}`),
    ...[...refs].filter((r) => !r.startsWith('#/components/schemas/') || !keys.includes(r.slice('#/components/schemas/'.length))).map((r) => `dangling ${r}`),
    ...keys.filter((k) => !refs.has(`#/components/schemas/${k}`)).map((k) => `unreferenced ${k}`),
  ];
}

// ---------------------------------------------------------------------------
// 1. OpenAPI (platform MAJOR): `::` in component keys, each type rendered two
//    or three times (under the member's alias, its project id and the
//    producer's own qualified id), and types no operation names.
// ---------------------------------------------------------------------------

describe('1. OpenAPI component keys: valid, one per type, none unreferenced', () => {
  // The contracts library, a member of the root under the alias `shared` (project id `contracts`).
  const contracts = snap({
    projectName: 'contracts', projectId: 'contracts',
    types: [
      { id: 'money', name: 'Money', kind: 'value-object', fields: [{ name: 'amountMinor', type: 'int' }, { name: 'currency', type: 'currency_code' }] },
      { id: 'currency_code', name: 'CurrencyCode', kind: 'value-object', fields: [], holds: 'string' },
      { id: 'payment_view', name: 'PaymentView', kind: 'value-object', fields: [{ name: 'amount', type: 'money' }] },
    ],
    exportedTypes: [{ id: 'money', type: 'money', audience: 'project' }, { id: 'payment_view', type: 'payment_view', audience: 'project' }],
  });
  // The payments member, which takes contracts' types through its own external `contracts`.
  const payments = snap({
    projectName: 'payments', projectId: 'payments_svc',
    types: [{ id: 'payment', name: 'Payment', kind: 'value-object', fields: [{ name: 'total', type: 'contracts::money' }] }],
    exportedTypes: [{ id: 'payment', type: 'payment', audience: 'project' }],
  });
  const gateway = snap({
    projectName: 'shop-platform',
    interfaces: [{
      id: 'gateway', name: 'Gateway', audience: 'project', type: 'REST', component: 'gateway',
      methods: [
        { name: 'getPayment', description: 'A payment.', signature: 'getPayment(id: string): payments_svc::payment', returns: 'payments_svc::payment', params: [{ name: 'id', type: 'string' }], endpoint: { transport: 'HTTP', method: 'GET', path: '/payments/{id}' } },
        { name: 'quote', description: 'A quote.', signature: 'quote(): shared::payment_view', returns: 'shared::payment_view', params: [], endpoint: { transport: 'HTTP', method: 'GET', path: '/quote' } },
        { name: 'price', description: 'A price.', signature: 'price(): contracts::money', returns: 'contracts::money', params: [], endpoint: { transport: 'HTTP', method: 'GET', path: '/price' } },
      ],
    } as never],
    // The root's own closure holds the member's re-exported types under their qualified ids, and a type no operation names.
    types: [
      { id: 'contracts::money', name: 'Money', kind: 'value-object', fields: [{ name: 'amountMinor', type: 'int' }, { name: 'currency', type: 'contracts::currency_code' }] },
      { id: 'contracts::currency_code', name: 'CurrencyCode', kind: 'value-object', fields: [], holds: 'string' },
      { id: 'audit_entry', name: 'AuditEntry', kind: 'value-object', fields: [{ name: 'at', type: 'datetime' }] },
    ],
  });
  // As foreignSurfaces holds them: each member under its alias, and under its project id besides.
  const externals = new Map([['shared', contracts], ['payments_svc', payments], ['contracts', contracts]]);

  it('keys every type once, under its owner\'s alias, only when an operation reaches it, and every $ref resolves', () => {
    const [spec] = toOpenApiSet(gateway, { externals });
    expect(componentProblems(spec.document)).toEqual([]);
    const keys = Object.keys(JSON.parse(spec.document).components.schemas).sort();
    expect(keys).toEqual(['payments_svc.payment', 'shared.currency_code', 'shared.money', 'shared.payment_view']);
  });

  it('a type two subsystems own is keyed by its qualified id with a dot, never `::`', () => {
    const own = snap({
      projectName: 'shop',
      interfaces: [{ id: 'api', name: 'API', audience: 'project', type: 'REST', component: 'api', methods: [
        { name: 'audit', description: 'd', signature: 'audit(): billing::entry', returns: 'billing::entry', params: [], endpoint: { transport: 'HTTP', method: 'GET', path: '/audit' } },
      ] } as never],
      types: [
        { id: 'entry', name: 'Entry', kind: 'value-object', fields: [{ name: 'a', type: 'string' }] },
        { id: 'billing::entry', name: 'Entry', kind: 'value-object', fields: [{ name: 'b', type: 'string' }] },
      ],
    });
    const [spec] = toOpenApiSet(own);
    expect(componentProblems(spec.document)).toEqual([]);
    expect(Object.keys(JSON.parse(spec.document).components.schemas)).toEqual(['billing.entry']);
  });
});

// ---------------------------------------------------------------------------
// 1b-c. The endpoint's own success status (tinkerer MAJOR 6, lib-and-app
//       R8-12): 202 and 302 were not expressible, and a workflow POST that
//       files something answered 200.
// ---------------------------------------------------------------------------

describe('1b. an endpoint states its success status, and the export uses it', () => {
  const links = (methods: Record<string, unknown>[]): SurfaceSnapshot => snap({
    projectName: 'linkshort',
    interfaces: [{ id: 'links', name: 'Links', audience: 'project', type: 'REST', component: 'links', methods } as never],
    types: [{ id: 'plan', name: 'Plan', kind: 'value-object', fields: [{ name: 'id', type: 'string' }] }],
  });
  const verb = (name: string, method: string, p: string, returns: string, status?: number) => ({
    name, description: name, signature: `${name}()`, returns, params: [], endpoint: { transport: 'HTTP', method, path: p, ...(status !== undefined ? { status } : {}) },
  });

  it('answers 202 for accepted work, a 302 redirect with a Location header and no body, and 201 for a workflow verb', () => {
    const [spec] = toOpenApiSet(links([
      verb('acceptHit', 'POST', '/hits', 'async void', 202),
      verb('follow', 'GET', '/{code}', 'string', 302),
      verb('planRoute', 'POST', '/routes/plan', 'plan', 201),
      verb('plain', 'POST', '/plain', 'plan'),
    ]));
    const doc = JSON.parse(spec.document);
    expect(Object.keys(doc.paths['/hits'].post.responses)).toEqual(['202']);
    expect(doc.paths['/hits'].post.responses['202'].content).toBeUndefined();
    const redirect = doc.paths['/{code}'].get.responses['302'];
    expect(redirect.headers.Location.schema).toEqual({ type: 'string' });
    expect(redirect.content).toBeUndefined();
    expect(Object.keys(doc.paths['/routes/plan'].post.responses)).toEqual(['201']);
    // No status stated: the convention, as before.
    expect(Object.keys(doc.paths['/plain'].post.responses)).toEqual(['200']);
  });

  it('reads a stated status back, and leaves the convention unstated', () => {
    const [spec] = toOpenApiSet(links([verb('acceptHit', 'POST', '/hits', 'async void', 202), verb('plain', 'POST', '/plain', 'plan')]));
    const back = fromOpenApi(spec.document, 'linkshort');
    const by = new Map(back.interfaces[0].methods.map((m) => [m.name, m.endpoint]));
    expect(by.get('acceptHit')).toEqual({ transport: 'HTTP', method: 'POST', path: '/hits', status: 202 });
    expect(by.get('plain')).toEqual({ transport: 'HTTP', method: 'POST', path: '/plain' });
  });
});

describe('1d. a `T?` field may be left out, and field descriptions reach the document', () => {
  it('lists a `T?` field and parameter as not required, nullable, with its description', () => {
    const s = snap({
      projectName: 'habitly',
      interfaces: [{ id: 'habits', name: 'Habits', audience: 'project', type: 'REST', component: 'habits', methods: [
        { name: 'createHabit', description: 'd', signature: 'createHabit(input: new_habit): string', returns: 'string', params: [{ name: 'input', type: 'new_habit' }], endpoint: { transport: 'HTTP', method: 'POST', path: '/habits' } },
        { name: 'listHabits', description: 'd', signature: 'listHabits(since: datetime?): list<new_habit>', returns: 'list<new_habit>', params: [{ name: 'since', type: 'datetime?' }], endpoint: { transport: 'HTTP', method: 'GET', path: '/habits' } },
      ] } as never],
      types: [{ id: 'new_habit', name: 'NewHabit', kind: 'value-object', fields: [
        { name: 'name', type: 'string', description: '1-100 characters' },
        { name: 'description', type: 'string?', description: 'Free text, or none' },
      ] }],
    });
    const doc = JSON.parse(toOpenApiSet(s)[0].document);
    const habit = doc.components.schemas.new_habit;
    expect(habit.required).toEqual(['name']);
    expect(habit.properties.description).toEqual({ type: ['string', 'null'], description: 'Free text, or none' });
    expect(habit.properties.name.description).toBe('1-100 characters');
    expect(doc.paths['/habits'].get.parameters[0]).toMatchObject({ name: 'since', in: 'query', required: false });
    // Read back: the `?` says it may be left out; the description returns to the field.
    const back = fromOpenApi(toOpenApiSet(s)[0].document, 'habitly');
    expect(back.types[0].fields).toEqual([
      { name: 'name', type: 'string', description: '1-100 characters' },
      { name: 'description', type: 'string?', description: 'Free text, or none' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. surface diff: an endpoint's path or verb moving was "no change"; the
//    alias respelling of every payments verb came back; one field rename
//    wrote six identical rows.
// ---------------------------------------------------------------------------

describe('2. surface diff', () => {
  const portal = (endpoint: Record<string, unknown>, extra: Record<string, unknown>[] = []) => snap({
    projectName: 'route-planner',
    interfaces: [{ id: 'route_portal', name: 'Routes', audience: 'project', type: 'REST', component: 'route_portal', methods: [
      { name: 'planRoute', description: 'Plan.', signature: 'planRoute(stops: string): string', returns: 'string', params: [{ name: 'stops', type: 'string' }], endpoint },
      ...extra,
    ] } as never],
  });

  it('reports an endpoint\'s path, verb or stated status moving', () => {
    const before = portal({ transport: 'HTTP', method: 'POST', path: '/routes/plan' });
    expect(surfaceChanges(portal({ transport: 'HTTP', method: 'POST', path: '/routes/plans' }), before).map((c) => `${c.kind} ${c.name}.${c.member}: ${c.detail}`))
      .toEqual(['changed route_portal.planRoute: endpoint POST /routes/plan → POST /routes/plans']);
    expect(surfaceChanges(portal({ transport: 'HTTP', method: 'PUT', path: '/routes/plan' }), before)[0].detail).toBe('endpoint POST /routes/plan → PUT /routes/plan');
    expect(surfaceChanges(portal({ transport: 'HTTP', method: 'POST', path: '/routes/plan', status: 201 }), before)[0].detail).toBe('endpoint POST /routes/plan → POST /routes/plan (answers 201)');
    expect(surfaceChanges(before, before)).toEqual([]);
  });

  it('REGRESSION: a type another project supplies, moving from one alias to another, is no change — the producer\'s own qualified ids respelled', () => {
    // payments' verbs named the platform's re-exports (`shop-platform::money`), whose pin keeps the
    // contracts member's types under their qualified ids; then payments depends on contracts directly.
    const verbs = (alias: string) => [
      { name: 'getPayment', description: 'd', signature: `getPayment(id: string): async ${alias}::payment_view`, returns: `async ${alias}::payment_view`, params: [{ name: 'id', type: 'string' }] },
      { name: 'charge', description: 'd', signature: `charge(amount: ${alias}::money): async void`, returns: 'async void', params: [{ name: 'amount', type: `${alias}::money` }] },
    ];
    const payments = (alias: string) => snap({ projectName: 'payments', projectId: 'payments_svc', interfaces: [{ id: 'payments_portal', name: 'Payments', audience: 'project', type: 'REST', component: 'payments_portal', methods: verbs(alias) } as never] });
    const platformPin = snap({
      projectName: 'shop-platform', projectId: 'shop-platform',
      types: [
        { id: 'contracts::money', name: 'Money', kind: 'value-object', fields: [{ name: 'amountMinor', type: 'int' }, { name: 'currency', type: 'contracts::currency_code' }] },
        { id: 'contracts::currency_code', name: 'CurrencyCode', kind: 'value-object', fields: [], holds: 'string' },
        { id: 'contracts::payment_view', name: 'PaymentView', kind: 'value-object', fields: [{ name: 'amount', type: 'contracts::money' }, { name: 'status', type: 'contracts::payment_status' }] },
        { id: 'contracts::payment_status', name: 'PaymentStatus', kind: 'enum', fields: [], values: [{ name: 'open' }, { name: 'paid' }] },
      ],
      exportedTypes: [
        { id: 'money', type: 'contracts::money', audience: 'project' },
        { id: 'payment_view', type: 'contracts::payment_view', audience: 'project' },
      ],
    });
    const contractsPin = snap({
      projectName: 'contracts', projectId: 'contracts',
      types: [
        { id: 'money', name: 'Money', kind: 'value-object', fields: [{ name: 'amountMinor', type: 'int' }, { name: 'currency', type: 'currency_code' }] },
        { id: 'currency_code', name: 'CurrencyCode', kind: 'value-object', fields: [], holds: 'string' },
        { id: 'payment_view', name: 'PaymentView', kind: 'value-object', fields: [{ name: 'amount', type: 'money' }, { name: 'status', type: 'payment_status' }] },
        { id: 'payment_status', name: 'PaymentStatus', kind: 'enum', fields: [], values: [{ name: 'open' }, { name: 'paid' }] },
      ],
      exportedTypes: [{ id: 'money', type: 'money', audience: 'project' }, { id: 'payment_view', type: 'payment_view', audience: 'project' }],
    });
    const before = withForeignTypes(payments('shop-platform'), new Map([['shop-platform', platformPin]]));
    const after = withForeignTypes(payments('contracts'), new Map([['contracts', contractsPin]]));
    // Every closure type of the pin respelled under the alias: no producer-internal `contracts::` left in the older side.
    expect(before.types.map((t) => t.id).sort()).toEqual(['shop-platform::currency_code', 'shop-platform::money', 'shop-platform::payment_status', 'shop-platform::payment_view']);
    expect(surfaceChanges(after, before)).toEqual([]);
  });

  it('one field rename reaching several verbs through the same unexported type is ONE row naming them', () => {
    const habit = (field: string, formerly?: string[]) => ({ id: 'habit', name: 'Habit', kind: 'value-object', fields: [{ name: field, type: 'string', ...(formerly ? { formerly } : {}) }] });
    const verbsOf = ['listHabits', 'getHabit', 'archive'].map((name) => ({ name, description: 'd', signature: `${name}(): habit`, returns: 'habit', params: [] }));
    const of = (type: Record<string, unknown>) => snap({ projectName: 'habitly', interfaces: [{ id: 'habit_portal', name: 'Habits', audience: 'project', type: 'REST', component: 'habit_portal', methods: verbsOf } as never], types: [type as never] });
    const rows = surfaceChanges(of(habit('rhythm', ['cadence'])), of(habit('cadence')));
    expect(rows).toEqual([{ kind: 'changed', name: 'habit_portal', detail: '3 methods (listHabits, getHabit, archive): signatures read the same, but they name renamed types: renamed field "habit.cadence" → "rhythm"' }]);
  });
});

// ---------------------------------------------------------------------------
// 3. Rename break reports (solo-app top-2, MAJOR): consumers that reach a type
//    only through an exported contract's verbs — a bare `dependsOn` on the
//    Portal — were "No consumer in reach".
// ---------------------------------------------------------------------------

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-round8-')));
  roots.push(dir);
  return dir;
}

/** Habitly's producer: it exports habit_portal, whose verbs answer its own (unexported) habit type. */
function habitProducer(): string {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({ schemaVersion: '1.0.0', id: 'habitly-api', name: 'habitly-api', targets: [], rules: {}, createdAt: NOW, updatedAt: NOW }));
  setProjectRoot(dir);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'habitly-api', vision: 'v', boundaries: [], globalRequirements: [], createdAt: NOW, updatedAt: NOW, publicInterfaces: [{ from: 'habits', component: 'habit_portal' }] } as never);
  saveSpec('subsystem', { id: 'habits', name: 'habits', description: 'd', parentSystem: 'habitly-api', trustedLinks: [], createdAt: NOW, updatedAt: NOW, publicInterfaces: [{ component: 'habit_portal', details: 'Habits' }] } as unknown as SubsystemSpec);
  saveSpec('type', { id: 'habit', name: 'Habit', kind: 'value-object', subsystem: 'habits', fields: [{ name: 'name', type: 'string' }, { name: 'rhythm', type: 'string' }], createdAt: NOW, updatedAt: NOW } as unknown as TypeSpec);
  saveComponentSpec({ id: 'habit_portal', name: 'habits', description: 'd', subsystem: 'habits', componentType: 'Portal', transport: 'HTTP', owns: [], dependsOn: [], createdAt: NOW, updatedAt: NOW } as ComponentSpec);
  saveInterfaceSpec({
    id: 'ihabit_portal', name: 'ihabits', description: 'c', component: 'habit_portal', createdAt: NOW, updatedAt: NOW,
    methods: [
      { name: 'listHabits', description: 'All habits.', signature: 'listHabits(): list<habit>', returns: 'list<habit>', params: [], endpoint: { transport: 'HTTP', method: 'GET', path: '/habits' } },
      { name: 'ping', description: 'Alive.', signature: 'ping(): string', returns: 'string', params: [], endpoint: { transport: 'HTTP', method: 'GET', path: '/ping' } },
    ],
  } as never);
  invalidateSpecCache();
  return dir;
}

/** A consumer whose spec depends on habit_portal as a whole (a bare dependsOn): it uses the name, no member. */
const bareConsumer: ExternalConsumer = {
  project: 'habitly-api', key: 'consumer', directory: '/consumer', alias: 'legacy', section: 'externals', found: 'search',
  names: ['habit_portal'], uses: [{ publicName: 'habit_portal', kind: 'component', members: [], specs: ['email_adapter'] }],
};

describe('3. rename break reports follow a type through the signature closure of exported verbs', () => {
  it('a field rename breaks a consumer that depends on the publishing Portal as a whole', () => {
    habitProducer();
    const dry = renameField('habit', 'rhythm', 'tempo', true);
    expect(dry.publishedIn).toEqual([{ publicName: 'habit_portal', kind: 'component', members: ['listHabits'] }]);
    expect(narrowedToUses(bareConsumer, dry.publishedIn)?.uses).toEqual([{ publicName: 'habit_portal', kind: 'component', members: ['listHabits'], specs: ['email_adapter'] }]);
  });

  it('a type rename names where consumers reach it (publishedIn), dry run and write alike', () => {
    habitProducer();
    const dry = renameType('habit', 'routine', true);
    expect(dry.publishedIn).toEqual([{ publicName: 'habit_portal', kind: 'component', members: ['listHabits'] }]);
    expect(narrowedToUses(bareConsumer, dry.publishedIn)).not.toBeNull();
    const done = renameType('habit', 'routine');
    expect(done.publishedIn).toEqual(dry.publishedIn);
  });

  it('a consumer that calls only other verbs is not one the rename breaks', () => {
    const pinged: ExternalConsumer = { ...bareConsumer, uses: [{ publicName: 'habit_portal', kind: 'component', members: ['ping'] }] };
    expect(narrowedToUses(pinged, [{ publicName: 'habit_portal', kind: 'component', members: ['listHabits'] }])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Binding modules (tinkerer MAJOR 5): CommonJS read in one shape only, and
//    the private `_get` helper flagged as not exported.
// ---------------------------------------------------------------------------

describe('4. the binding reader reads every CommonJS and declaration-file shape', () => {
  const client = 'class LegacyStatsClient {\n  getStats(code) { return this._get(code); }\n  getTopCodes(limit) { return []; }\n  _get(path) { return fetch(path); }\n}\n';
  const shapes: Record<string, string> = {
    'module.exports = { X }': `'use strict';\n${client}module.exports = { LegacyStatsClient };\n`,
    'module.exports.X = X': `${client}module.exports.LegacyStatsClient = LegacyStatsClient;\n`,
    'module.exports = class': 'module.exports = class LegacyStatsClient {\n  getStats(code) {}\n  getTopCodes(limit) {}\n  _get(path) {}\n};\n',
    '.d.ts export = { X }': 'declare class LegacyStatsClient {\n  getStats(code: string): Promise<unknown>;\n  getTopCodes(limit: number): Promise<unknown>;\n}\nexport = { LegacyStatsClient };\n',
    'TS export = X': 'class LegacyStatsClient {\n  getStats(code: string) { return code; }\n  getTopCodes(limit: number) { return limit; }\n}\nexport = LegacyStatsClient;\n',
    'exports.X = class (private helper)': 'exports.LegacyStatsClient = class {\n  getStats(code) {}\n  getTopCodes(limit) {}\n  _get(path) {}\n};\n',
  };
  for (const [shape, text] of Object.entries(shapes)) {
    it(`reads ${shape} as the class, its underscore helper left out`, () => {
      const [decl] = readDeclarations(text);
      expect(decl).toMatchObject({ name: 'LegacyStatsClient', kind: 'class', members: [{ name: 'getStats', params: ['code'] }, { name: 'getTopCodes', params: ['limit'] }] });
      expect(readUnreadForms(text)).toEqual([]);
    });
  }

  it('reads a JSDoc typedef as an object type with its properties', () => {
    const [decl] = readDeclarations('/**\n * @typedef {Object} CodeStats\n * @property {string} code\n * @property {number} hits\n */\nmodule.exports = {};\n');
    expect(decl).toMatchObject({ name: 'CodeStats', kind: 'type', members: [{ name: 'code', type: 'string' }, { name: 'hits', type: 'number' }] });
  });

  it('gives each property of a tagged module.exports object the object\'s tag, unless it names its own', () => {
    const decls = readDeclarations('/** payments::payment_portal */\nmodule.exports = {\n  getPayment(id) {},\n  /** payments::refunds */\n  refund(id) {},\n};\n');
    expect(decls.map((d) => `${d.name}:${d.tag}`)).toEqual(['getPayment:payments::payment_portal', 'refund:payments::refunds']);
  });

  it('still names an export it cannot see into', () => {
    expect(readUnreadForms('module.exports = require(\'./build/Release/x.node\');\n')).toEqual(['module.exports = require(…)']);
    expect(readUnreadForms('module.exports = makeClient();\n')).toEqual(['module.exports = makeClient(…)']);
  });
});
