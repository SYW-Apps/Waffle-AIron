import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as upgrade from '../../src/upgrade/index.js';
import { read } from '../../src/upgrade/adapters/stamp.js';
import { runInV5Reading, setProjectRoot } from '../../src/utils/fs.js';
import { getLoaderIssues, invalidateSpecCache, loadComponentSpecs, loadInterfaceSpecs, loadSubsystemSpecs, loadSystemSpec } from '../../src/core/specs.js';
import { readLockRecord, writeLockRecord } from '../../src/core/lockfile.js';
import { currentSpecDigests } from '../../src/core/approval.js';
import { computeGateStateId } from '../../src/core/validation.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';

// ---------------------------------------------------------------------------
// `wairon upgrade` over a project written in EVERY v5 form at once, on real temp
// directories: a Gateway, a Specialist, a listener's mounts, an `external`
// invokedBy, an authored export `type` (L1 and L0), a long-form member `path`,
// and a lock record of the earlier format. Outside the v5 reading each of these
// is refused; the upgrade — which binds the v5 reading around its rehearsal —
// moves all of them, and the tree it leaves is read cleanly by the current
// major, its approval carried over without a review.
// ---------------------------------------------------------------------------

const now = '2026-10-18T00:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** The gate algorithm every format-2 lock was taken under (full content, code linkage in). */
const CONTENT_GATE_ALGORITHM = 'sha256+content+doctrine+inputs+members';

const component = (id: string, sub: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, name: id, description: `the ${id} component`, subsystem: sub, componentType: 'Orchestrator', owns: [], dependsOn: [],
  status: 'complete', createdAt: now, updatedAt: now, ...over,
});
const verb = (name: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name, description: `the ${name} verb`, signature: `${name}(): void`, returns: 'void', ...over,
});
const contract = (id: string, comp: string, methods: Record<string, unknown>[]): Record<string, unknown> => ({
  id, name: id, description: 'd', component: comp, methods, status: 'complete', createdAt: now, updatedAt: now,
});

/** The v5 project: returns its root. The member project `billing` sits beside it under services/. */
function v5Project(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-v5forms-')));
  roots.push(root);
  const put = (rel: string, doc: Record<string, unknown>): void => writeYamlFile(path.join(root, '.wai', 'specs', ...rel.split('/')), doc);
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', id: 'shop', name: 'shop', targets: [], rules: {}, extensions: { packs: [], useGlobalPacks: false },
    // The long-form member `path` of wairon 5.
    members: { billing: { path: 'services/billing', description: 'Invoices' } },
    createdAt: now, updatedAt: now,
  });
  // The L0 with an authored export `type`, and its legacy `id`/`subsystem` spelling kept as it is.
  put('.index.yaml', {
    schemaVersion: '1.0.0', name: 'Shop', vision: 'sells things', boundaries: [], globalRequirements: [],
    publicInterfaces: [{ as: 'shop-api', from: 'web', component: 'web-front', type: 'REST', details: 'the shop', audience: 'external' }],
    createdAt: now, updatedAt: now,
  });
  put('web/.index.yaml', {
    id: 'web', name: 'web', description: 'd', parentSystem: 'Shop', trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now,
    // The L1 export `type`, naming the Gateway.
    publicInterfaces: [{ type: 'REST', details: 'the shop', component: 'web-front' }],
  });
  // The Gateway, owning the Portal it fronts and a rate limiter; the Portal still spells `portalType`.
  put('web/web-front/.index.yaml', component('web-front', 'web', { componentType: 'Gateway', owns: ['web-portal', 'limiter'] }));
  put('web/web-portal/.index.yaml', component('web-portal', 'web', { componentType: 'Portal', portalType: 'HTTP_API' }));
  put('web/web-portal/.interface.yaml', contract('iweb-portal', 'web-portal', [
    verb('browse', {
      endpoint: { transport: 'HTTP', method: 'GET', path: '/shop/items' },
      invokedBy: { kind: 'external', caller: 'Shoppers in their browsers' },
    }),
  ]));
  put('web/limiter/.index.yaml', component('limiter', 'web', { componentType: 'Adapter' }));
  // A listener (portalType and mounts) that serves the Portal.
  put('web/host/.index.yaml', component('host', 'web', {
    componentType: 'Portal', portalType: 'HTTP_API', mounts: [{ portal: 'web-portal', prefixes: ['/shop'] }],
  }));
  put('web/host/.interface.yaml', contract('ihost', 'host', [verb('health', { endpoint: { transport: 'HTTP', method: 'GET', path: '/health' } })]));
  // A Specialist, a pure Orchestrator it depends on, and a consumer of the Gateway.
  put('web/rates/.index.yaml', component('rates', 'web', { dependencyClass: 'pure' }));
  put('web/pricing/.index.yaml', component('pricing', 'web', { componentType: 'Specialist', dependsOn: ['rates'] }));
  put('web/shop-orch/.index.yaml', component('shop-orch', 'web', { dependsOn: ['web-front', 'pricing'] }));

  // The member project, in its own forms.
  const billing = path.join(root, 'services', 'billing');
  writeYamlFile(path.join(billing, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', id: 'billing', name: 'billing', targets: [], rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
  });
  writeYamlFile(path.join(billing, '.wai', 'specs', '.index.yaml'), {
    schemaVersion: '1.0.0', name: 'Billing', vision: 'bills', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });

  // The earlier-format lock: format 2, the content gate, the raw-content digests.
  setProjectRoot(root);
  invalidateSpecCache();
  runInV5Reading(() => {
    writeLockRecord({
      stateId: { algorithm: CONTENT_GATE_ALGORITHM, digest: '0'.repeat(64) }, lockedAt: now, lockedBy: { id: 'approver', source: 'git' },
      validatorVersion: '5.1.0', validationResult: { valid: true, errors: 0, warnings: 0 }, status: 'ready',
    });
    const gate = computeGateStateId();
    expect(gate.asRecorded?.algorithm).toBe(CONTENT_GATE_ALGORITHM);
    writeLockRecord({
      format: 2,
      stateId: { algorithm: gate.asRecorded!.algorithm, digest: gate.asRecorded!.digest },
      lockedAt: now, lockedBy: { id: 'approver', source: 'git' }, validatorVersion: '5.1.0',
      validationResult: { valid: true, errors: 0, warnings: 0, notices: 0 }, status: 'ready',
      specs: currentSpecDigests(root, 'content'), members: {},
    });
  });
  setProjectRoot(null);
  invalidateSpecCache();
  return root;
}

const ids = (list: { id: string }[]): string[] => list.map((c) => c.id).sort();

describe('wairon upgrade over a project in every v5 form', () => {
  it('the project is refused outside the v5 reading, form by form', () => {
    const root = v5Project();
    setProjectRoot(root);
    invalidateSpecCache();
    loadComponentSpecs();
    loadInterfaceSpecs();
    loadSubsystemSpecs();
    loadSystemSpec();
    const errors = getLoaderIssues().filter((i) => i.severity === 'error').map((i) => i.message).join('\n');
    for (const form of [
      '`componentType: Gateway` is a wairon 5 form',
      '`componentType: Specialist` is a wairon 5 form',
      '`portalType` is a wairon 5 form; wairon 6 reads `transport`',
      '`mounts` (a listener\'s mounts) is a wairon 5 form',
      '`invokedBy: { kind: external }` is a wairon 5 form',
      'an export entry\'s `type` is a wairon 5 form',
    ]) expect(errors, form).toContain(form);
    expect(() => readLockRecord()).toThrow(/lock record format 2, written by wairon 5/);
  });

  it('plans each rewrite as a design change, naming the Gateway merge', () => {
    const root = v5Project();
    const plan = upgrade.plan(root);
    try {
      expect(plan.refusal).toBeUndefined();
      const top = plan.steps.find((s) => s.project === root)!;
      const described = top.changes.map((c) => c.description).join('\n');
      expect(described).toContain('web-front: Gateway merged into the Portal web-portal, which takes the gateway variant and depends on limiter');
      expect(described).toContain('shop-orch depend on the Portal');
      expect(described).toContain('pricing: Specialist becomes Orchestrator (pure)');
      expect(described).toContain('lock.json: re-express the approval');
      expect(top.changes.filter((c) => c.design).length).toBeGreaterThan(3);
    } finally {
      upgrade.discard(plan);
    }
  });

  it('moves every form, re-expresses the lock, and leaves a tree the current major reads cleanly', () => {
    const root = v5Project();
    const before = readYamlFile(path.join(root, '.wai', 'project.yaml')) as { members: Record<string, unknown> };
    expect(before.members.billing).toMatchObject({ path: 'services/billing' });

    const plan = upgrade.plan(root);
    expect(plan.refusal).toBeUndefined();
    const report = upgrade.apply(plan);
    expect(report.failure).toBeUndefined();
    expect(report.committed).toBe(true);
    expect(report.relock).toContain(root);
    expect(read(root)).toBe(6);

    // The long-form member path is `source` now.
    const after = readYamlFile(path.join(root, '.wai', 'project.yaml')) as { members: Record<string, unknown> };
    expect(after.members.billing).toMatchObject({ source: 'services/billing', description: 'Invoices' });
    expect(JSON.stringify(after.members.billing)).not.toContain('"path"');

    // Read back OUTSIDE the v5 reading: no v5 form is left to refuse.
    setProjectRoot(root);
    invalidateSpecCache();
    const components = loadComponentSpecs();
    const interfaces = loadInterfaceSpecs();
    const subsystems = loadSubsystemSpecs();
    const system = loadSystemSpec();
    expect(getLoaderIssues().filter((i) => i.severity === 'error').map((i) => i.message)).toEqual([]);

    // The Gateway is merged into its Portal; its consumers and exports name the Portal.
    expect(ids(components)).toEqual(['host', 'limiter', 'pricing', 'rates', 'shop-orch', 'web-portal']);
    const byId = new Map(components.map((c) => [c.id, c]));
    expect(byId.get('web-portal')).toMatchObject({ componentType: 'Portal', variant: 'gateway', transport: 'HTTP' });
    expect(byId.get('web-portal')!.dependsOn).toContain('limiter');
    expect(byId.get('shop-orch')!.dependsOn).toEqual(['web-portal', 'pricing']);
    expect(subsystems[0].publicInterfaces).toEqual([{ details: 'the shop', component: 'web-portal' }]);
    expect(system!.publicInterfaces).toEqual([{ as: 'shop-api', from: 'web', component: 'web-portal', details: 'the shop', audience: 'external' }]);
    // The Specialist is an Orchestrator with the class its dependencies gave it.
    expect(byId.get('pricing')).toMatchObject({ componentType: 'Orchestrator', dependencyClass: 'pure' });
    // The listener's portalType and mounts are gone, replaced by an entry.
    expect(byId.get('host')).toMatchObject({ transport: 'HTTP' });
    expect(JSON.stringify(byId.get('host'))).not.toContain('mounts');
    // The `external` invokedBy kind is an entry on the Portal's verb.
    const browse = interfaces.find((i) => i.id === 'iweb-portal')!.methods.find((m) => m.name === 'browse')!;
    expect(browse.invokedBy).toMatchObject({ kind: 'entry', caller: 'Shoppers in their browsers' });

    // The approval was carried over, not dropped: format 3, the design reading, the approver kept.
    const lock = readLockRecord()!;
    expect(lock.format).toBe(3);
    expect(lock.specsReading).toBe('design');
    expect(lock.lockedBy).toEqual({ id: 'approver', source: 'git' });
    expect(lock.reexpressed).toMatchObject({ fromReading: 'content' });

    // A second plan finds the project current.
    expect(upgrade.standing(root).state).toBe('current');
    expect(upgrade.plan(root).steps).toEqual([]);
  });

  it('refuses a Gateway it cannot merge, naming it and the hand steps, and writes nothing', () => {
    const root = v5Project();
    // A second Portal under the same Gateway: a Gateway merges into exactly one.
    writeYamlFile(path.join(root, '.wai', 'specs', 'web', 'admin-portal', '.index.yaml'), component('admin-portal', 'web', { componentType: 'Portal', portalType: 'HTTP_API' }));
    const gateway = readYamlFile(path.join(root, '.wai', 'specs', 'web', 'web-front', '.index.yaml')) as Record<string, unknown>;
    writeYamlFile(path.join(root, '.wai', 'specs', 'web', 'web-front', '.index.yaml'), { ...gateway, owns: ['web-portal', 'admin-portal', 'limiter'] });
    const plan = upgrade.plan(root);
    expect(plan.rehearsal).toBeUndefined();
    expect(plan.refusal).toContain('Gateway "web-front" cannot be merged into a Portal: it owns 2 Portals');
    expect(plan.refusal).toContain('(1) the Portal it owns becomes the front door, with variant: gateway');
    expect(upgrade.apply(plan)).toMatchObject({ committed: false });
    expect(read(root)).toBeNull();
    expect(fs.readFileSync(path.join(root, '.wai', 'specs', 'web', 'web-front', '.index.yaml'), 'utf8')).toContain('Gateway');
  });

  it('does not silently skip the lock re-expression when the lock cannot be read', () => {
    const root = v5Project();
    // A lock record that is there but unreadable is not a project with no lock: the plan fails loudly,
    // naming the file, and nothing is stamped or written.
    fs.writeFileSync(path.join(root, '.wai', 'lock.json'), '{ not json');
    expect(() => upgrade.plan(root)).toThrow(/cannot be read as an approval record/);
    expect(read(root)).toBeNull();
    expect(fs.readFileSync(path.join(root, '.wai', 'lock.json'), 'utf8')).toBe('{ not json');
  });

  it('keeps an approval nothing proves unchanged on record in the current format, so wairon 6 can read it and it reads stale', () => {
    const root = v5Project();
    // What wairon 5.1.0 wrote: no format, no per-spec digests, an identity this release cannot recompute, a bare-string approver.
    const old = { stateId: { algorithm: 'sha256', digest: 'd'.repeat(64) }, lockedAt: now, lockedBy: 'qa-fixture', validatorVersion: '5.1.0', validationResult: { valid: true, errors: 0, warnings: 3 }, status: 'ready' };
    fs.writeFileSync(path.join(root, '.wai', 'lock.json'), JSON.stringify(old, null, 2));
    const plan = upgrade.plan(root);
    const described = plan.steps.find((s) => s.project === root)!.changes.map((c) => c.description).join(' | ');
    expect(described).toContain('lock.json: keep the approval on record in the current format — nothing proves the design unchanged');
    expect(described).not.toContain('re-express the approval');
    expect(upgrade.apply(plan).committed).toBe(true);

    // Outside the v5 reading the record now reads: the approver and time kept, the certificate unchanged (so stale).
    setProjectRoot(root);
    invalidateSpecCache();
    const kept = readLockRecord()!;
    expect(kept).toMatchObject({ format: 3, lockedAt: now, lockedBy: { id: 'qa-fixture', source: 'legacy' }, stateId: old.stateId, validatorVersion: '5.1.0' });
    expect(kept.specs).toBeUndefined();
    expect(kept.reexpressed).toMatchObject({ fromAlgorithm: 'sha256', fromReading: 'content', by: 'wairon upgrade' });
    expect(computeGateStateId().digest).not.toBe(old.stateId.digest);
  });

  it('plans no lock change for a project that holds no lock record', () => {
    const root = v5Project();
    fs.rmSync(path.join(root, '.wai', 'lock.json'));
    const plan = upgrade.plan(root);
    try {
      expect(plan.refusal).toBeUndefined();
      expect(plan.steps.find((s) => s.project === root)!.changes.map((c) => c.description).join(' | ')).not.toContain('lock.json');
    } finally {
      upgrade.discard(plan);
    }
  });
});
