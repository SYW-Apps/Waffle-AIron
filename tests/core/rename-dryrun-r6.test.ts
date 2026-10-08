import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSpec, saveComponentSpec, saveInterfaceSpec, invalidateSpecCache, loadInterfaceSpec, loadComponentSpec, loadTypeSpec,
} from '../../src/core/specs.js';
import { renameComponent, renameField, renameParam, renameType } from '../../src/core/provision.js';
import { narrowedToMember, narrowedToUses, surfaceChanges, SurfaceSnapshotSchema } from '../../src/models/index.js';
import type { ComponentSpec, ExternalConsumer, SubsystemSpec, SurfaceSnapshot, TypeSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Round-6 trial findings on renames: rename-param / rename-field had no dry
// run and named no consumer; a parameter renamed on the source of a
// signatureFrom left the follower Portal's placeholder behind; the method
// rename dry run listed every spec reaching the public name; and the surface
// changelog double-counted a renamed method, counted an alias respelling as a
// signature change and a type + field rename as a shape change of every type
// embedding them. component and type renames gained a dry run too.
// ---------------------------------------------------------------------------

const now = '2026-10-07T10:00:00.000Z';
let root: string;

function project(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-rename-r6-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'habits', targets: [], rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'habits', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  saveSpec('subsystem', {
    id: 'core', name: 'core', description: 'd', parentSystem: 'habits', trustedLinks: [], createdAt: now, updatedAt: now,
    publicInterfaces: [{ component: 'habit-api', details: 'The habit API' }, { typeDef: 'habit' }],
  } as unknown as SubsystemSpec);
  saveSpec('type', { id: 'cadence', name: 'cadence', kind: 'value-object', subsystem: 'core', fields: [{ name: 'every', type: 'int' }], createdAt: now, updatedAt: now } as unknown as TypeSpec);
  saveSpec('type', { id: 'habit', name: 'habit', kind: 'value-object', subsystem: 'core', fields: [{ name: 'rhythm', type: 'cadence' }], createdAt: now, updatedAt: now } as unknown as TypeSpec);
  saveComponentSpec({
    id: 'habit-flow', name: 'habit-flow', description: 'd', subsystem: 'core', componentType: 'Orchestrator',
    owns: [], dependsOn: [], createdAt: now, updatedAt: now,
  } as ComponentSpec);
  saveComponentSpec({
    id: 'habit-api', name: 'habit-api', description: 'd', subsystem: 'core', componentType: 'Portal', transport: 'HTTP',
    owns: [], dependsOn: ['habit-flow'], createdAt: now, updatedAt: now,
  } as ComponentSpec);
  saveInterfaceSpec({
    id: 'ihabit-flow', name: 'ihabit-flow', description: 'contract', component: 'habit-flow', createdAt: now, updatedAt: now,
    methods: [{
      name: 'show', description: 'Show a habit.', signature: 'show(habitId: string): habit', returns: 'habit',
      params: [{ name: 'habitId', type: 'string' }],
    }],
  });
  saveInterfaceSpec({
    id: 'ihabit-api', name: 'ihabit-api', description: 'contract', component: 'habit-api', createdAt: now, updatedAt: now,
    methods: [
      { name: 'show', description: 'Show a habit.', signatureFrom: 'habit-flow.show', endpoint: { transport: 'HTTP', method: 'GET', path: '/habits/{habitId}' } },
      { name: 'peek', description: 'Peek.', signatureFrom: 'habit-flow.show', endpoint: { transport: 'HTTP', method: 'GET', path: '/peek/:habitId' } },
    ],
  } as never);
  invalidateSpecCache();
  setProjectRoot(root);
}

/** Every spec file's bytes, to prove a dry run wrote nothing. */
function tree(): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${p}\n${fs.readFileSync(p, 'utf8')}`);
    }
  };
  walk(path.join(root, '.wai'));
  return out.sort().join('\n');
}

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
});

describe('renameParam through signatureFrom, and its dry run', () => {
  it('respells the follower Portal placeholder in both spellings when the source parameter is renamed', () => {
    project();
    const result = renameParam('habit-flow', 'show', 'habitId', 'id');
    expect(result.rewritten).toEqual(['ihabit-api.show: {habitId} -> {id}', 'ihabit-api.peek: :habitId -> :id']);
    invalidateSpecCache();
    const methods = loadInterfaceSpec('ihabit-api')!.methods;
    expect((methods[0].endpoint as { path: string }).path).toBe('/habits/{id}');
    expect((methods[1].endpoint as { path: string }).path).toBe('/peek/:id');
    expect(methods[0].signatureFrom).toBe('habit-flow.show');
  });

  it('answers the same report as a dry run and writes nothing', () => {
    project();
    const before = tree();
    const dry = renameParam('habit-flow', 'show', 'habitId', 'id', true);
    expect(dry.dryRun).toBe(true);
    expect(dry.movedIn).toEqual(['ihabit-flow']);
    expect(dry.rewritten).toEqual(['ihabit-api.show: {habitId} -> {id}', 'ihabit-api.peek: :habitId -> :id']);
    expect(tree()).toBe(before);
  });

  it('names the export entries publishing the method', () => {
    project();
    expect(renameParam('habit-flow', 'show', 'habitId', 'id', true).publishedIn).toEqual([]);
    // habit-api publishes `show`, but its params come from habit-flow: renamed there.
    expect(() => renameParam('habit-api', 'show', 'habitId', 'id', true)).toThrow(/param-missing/);
  });
});

describe('renameField dry run and publishedIn', () => {
  it('names every export carrying the field — the type itself, a type embedding it, a contract naming one — and writes nothing', () => {
    project();
    const before = tree();
    const dry = renameField('cadence', 'every', 'each', true);
    expect(dry.dryRun).toBe(true);
    expect(dry.publishedIn).toEqual([
      { publicName: 'habit', kind: 'type', members: ['type'] },
      { publicName: 'habit-api', kind: 'component', members: ['peek', 'show'] },
    ]);
    expect(tree()).toBe(before);
    const real = renameField('cadence', 'every', 'each');
    expect(real.dryRun).toBeUndefined();
    invalidateSpecCache();
    expect(loadTypeSpec('cadence')!.fields!.map((f) => f.name)).toEqual(['each']);
  });
});

describe('component and type renames gained a dry run', () => {
  it('renameComponent dryRun reports the move and writes nothing', () => {
    project();
    const before = tree();
    const dry = renameComponent('habit-flow', 'habit-workflow', true);
    expect(dry.dryRun).toBe(true);
    expect(dry.renamed.map((r) => `${r.kind}:${r.from}->${r.to}`)).toEqual(['component:habit-flow->habit-workflow', 'interface:ihabit-flow->ihabit-workflow']);
    expect(dry.rewritten).toEqual(expect.arrayContaining(['habit-api', 'ihabit-api']));
    expect(tree()).toBe(before);
    expect(loadComponentSpec('habit-flow')).not.toBeNull();
  });

  it('renameType dryRun reports the respellings and writes nothing', () => {
    project();
    const before = tree();
    const dry = renameType('cadence', 'rhythm_spec', true);
    expect(dry.dryRun).toBe(true);
    expect(dry.rewritten).toContain('habit');
    expect(tree()).toBe(before);
  });
});

describe('external_consumer narrowing', () => {
  const consumer: ExternalConsumer = {
    project: 'platform', key: '', directory: '/x', alias: 'payments', section: 'members',
    names: ['payments_portal'],
    uses: [{
      publicName: 'payments_portal', kind: 'component', members: ['accept', 'status'],
      specs: ['payments_client', 'payments_client_http', 'payments_upstream_http'],
      memberSpecs: { accept: ['payments_upstream_http'], status: ['payments_client_http'] },
    }],
  };

  it('a method rename names only the specs that reach that member', () => {
    expect(narrowedToMember(consumer, ['payments_portal'], 'accept').uses).toEqual([
      { publicName: 'payments_portal', kind: 'component', members: ['accept'], specs: ['payments_upstream_http'] },
    ]);
  });

  it('a field rename reaches a member consumer through every carrying member, or not at all', () => {
    const hit = narrowedToUses(consumer, [{ publicName: 'payments_portal', kind: 'component', members: ['status'] }]);
    expect(hit?.uses).toEqual([{ publicName: 'payments_portal', kind: 'component', members: ['status'], specs: ['payments_client_http'] }]);
    expect(narrowedToUses(consumer, [{ publicName: 'payments_portal', kind: 'component', members: ['refund'] }])).toBeNull();
  });
});

describe('surfaceChanges counts each rename once', () => {
  const snap = (over: Partial<SurfaceSnapshot>): SurfaceSnapshot => SurfaceSnapshotSchema.parse({ projectName: 'p', origin: 'generated', generatedAt: now, ...over });

  it('a renamed method whose closure only saw a traced field rename is one row, not a rename plus a signature change', () => {
    const older = snap({
      interfaces: [{ id: 'tiles', name: 'tiles', component: 'tiles', methods: [{ name: 'tile_for', description: 'd', signature: 'tile_for(c: coordinate): tile_coord', returns: 'tile_coord', params: [{ name: 'c', type: 'coordinate' }] }] }],
      types: [
        { id: 'coordinate', name: 'coordinate', kind: 'value-object', fields: [{ name: 'lat', type: 'float' }] },
        { id: 'tile_coord', name: 'tile_coord', kind: 'value-object', fields: [{ name: 'zoom', type: 'int' }] },
      ],
      exportedTypes: [{ id: 'tile_coord', type: 'tile_coord', audience: 'instance' }],
    });
    const newer = snap({
      interfaces: [{ id: 'tiles', name: 'tiles', component: 'tiles', methods: [{ name: 'tile_at', formerly: ['tile_for'], description: 'd', signature: 'tile_at(c: coordinate): tile_coord', returns: 'tile_coord', params: [{ name: 'c', type: 'coordinate' }] }] }],
      types: [
        { id: 'coordinate', name: 'coordinate', kind: 'value-object', fields: [{ name: 'lat', type: 'float' }] },
        { id: 'tile_coord', name: 'tile_coord', kind: 'value-object', fields: [{ name: 'z', type: 'int', formerly: ['zoom'] }] },
      ],
      exportedTypes: [{ id: 'tile_coord', type: 'tile_coord', audience: 'instance' }],
    });
    const changes = surfaceChanges(newer, older).map((c) => `${c.kind} ${c.name}${c.member ? `.${c.member}` : ''}`);
    expect(changes).toEqual(['renamed tile_coord.z', 'renamed tiles.tile_at']);
  });

  it('an alias respelling of an external type is no change', () => {
    const entry = (alias: string) => ({ id: 'pay', name: 'pay', component: 'pay', methods: [{ name: 'create', description: 'd', signature: `create(caller: ${alias}::caller_identity): void`, returns: 'void', params: [{ name: 'caller', type: `${alias}::caller_identity` }] }] });
    expect(surfaceChanges(snap({ interfaces: [entry('contracts')] }), snap({ interfaces: [entry('platform')] }))).toEqual([]);
  });

  it('a type rename and a field rename are two rows, never a shape change of each type embedding them', () => {
    const types = (renamed: boolean) => [
      renamed
        ? { id: 'customer_ref', name: 'customer_ref', kind: 'value-object', holds: 'string', fields: [], formerly: ['customer_id'] }
        : { id: 'customer_id', name: 'customer_id', kind: 'value-object', holds: 'string', fields: [] },
      { id: 'money', name: 'money', kind: 'value-object', fields: [renamed ? { name: 'amount', type: 'int', formerly: ['amountMinor'] } : { name: 'amountMinor', type: 'int' }] },
      { id: 'order', name: 'order', kind: 'value-object', fields: [{ name: 'customer', type: renamed ? 'customer_ref' : 'customer_id' }, { name: 'total', type: 'money' }] },
      { id: 'refund', name: 'refund', kind: 'value-object', fields: [{ name: 'amount', type: 'money' }] },
    ];
    const exported = (renamed: boolean) => [
      { id: renamed ? 'customer_ref' : 'customer_id', type: renamed ? 'customer_ref' : 'customer_id', audience: 'instance' },
      { id: 'money', type: 'money', audience: 'instance' },
      { id: 'order', type: 'order', audience: 'instance' },
      { id: 'refund', type: 'refund', audience: 'instance' },
    ];
    const changes = surfaceChanges(snap({ types: types(true), exportedTypes: exported(true) }), snap({ types: types(false), exportedTypes: exported(false) }))
      .map((c) => `${c.kind} ${c.name}${c.member ? `.${c.member}` : ''}`);
    expect(changes).toEqual(['renamed customer_ref', 'renamed money.amount']);
  });
});
