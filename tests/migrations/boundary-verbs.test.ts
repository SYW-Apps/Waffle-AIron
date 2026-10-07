import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { runWithProjectBinding, setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, loadSubsystemSpec, loadSystemSpec } from '../../src/core/specs.js';
import { internalizeMember, moveMember } from '../../src/core/provision.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { validateProject } from '../../src/core/validation.js';
import { projectFamilyGraph } from '../../src/core/project-family.js';
import { readYamlFile } from '../../src/utils/yaml.js';
import * as migrations from '../../src/migrations/index.js';
import { runLock } from '../../src/commands/lock.js';
import { computeGateStateId } from '../../src/core/validation.js';
import { readLockState } from '../../src/core/specs.js';
import { diffAgainstApproval } from '../../src/core/approval.js';
import { buildContractFamily, buildReferenceFamily, type ContractFamily, type ReferenceFamily } from '../helpers/reference-family.js';
import { at, dirHash, familyFindings, familyLines, migrate, newFindings, pinAt, plan, put, waiState } from '../helpers/family-verbs.js';

// ---------------------------------------------------------------------------
// Stage 6 wave B — the boundary verbs (internalize, externalize) through the
// migration portal. Real temp directories; nothing mocked on the path under
// test.
//
// internalize folds a member — every subsystem of it — into the bound project
// and sends each piece of the member's own metadata to a home (one assertion
// per row of the stage-6 design table), re-pointing every other family
// project that consumed it. externalize turns a subsystem into a member and
// leaves every other family project's references resolving without writing
// them (externalize-updates-siblings). move-is-free: `member move` changes no
// reference. Every refusal writes nothing.
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z';
const dump = (spec: Record<string, unknown>): string => yaml.dump({ schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS, ...spec }, { noRefs: true, lineWidth: 200 });
const write = (root: string, rel: string, value: Record<string, unknown> | string): void => put(path.join(root, ...rel.split('/')), typeof value === 'string' ? value : dump(value));
const configOf = (dir: string): Record<string, unknown> => readYamlFile(path.join(dir, '.wai', 'project.yaml')) as Record<string, unknown>;
const pinsOf = (dir: string): string[] => {
  const file = path.join(dir, '.wai', 'externals.lock.yaml');
  return fs.existsSync(file) ? Object.keys((readYamlFile(file) as { externals?: Record<string, unknown> }).externals ?? {}) : [];
};

// ── the metadata family ─────────────────────────────────────────────────────
//
//   hub (top, id hub)                   L0: boundary `edge`, a requirement; targetLanguage typescript
//   ├── svc  `members:` entry           id svc — two subsystems (pay publishing pay-portal, settle); its
//   │   │                               L0 vision, boundaries (`edge` again, `pci`), a requirement and a
//   │   │                               database; targetLanguage rust; projectType lowlevel-os; designDepth
//   │   │                               interfaces; a pack; externals `hub` (its parent) and `crm` (by path,
//   │   │                               importing crm-record); a lock, pins and derived outputs
//   │   └── sub  `members:` entry of svc id sub
//   └── crm  NOT a member: svc's external by path

interface MetaFamily { top: string; svc: string; sub: string; crm: string }

function metaFamily(): MetaFamily {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-meta-'));
  const svc = path.join(top, 'svc');
  const sub = path.join(svc, 'sub');
  const crm = path.join(top, 'crm');
  const config = (dir: string, fields: Record<string, unknown>): void => write(dir, '.wai/project.yaml', dump({ targets: [], extensions: { packs: [], useGlobalPacks: false }, ...fields }));

  config(top, { id: 'hub', name: 'Hub', members: { svc: 'svc' } });
  write(top, '.wai/specs/.index.yaml', { name: 'Hub', vision: 'The hub.', boundaries: [{ name: 'edge', description: 'The network edge' }], globalRequirements: [{ description: 'Audit every write' }], targetLanguage: 'typescript' });
  write(top, '.wai/specs/front/.index.yaml', { id: 'front', name: 'front', description: 'The front door.', parentSystem: 'Hub', publicInterfaces: [], trustedLinks: [] });

  config(svc, {
    id: 'svc', name: 'Svc', projectType: 'lowlevel-os', rules: { designDepth: 'interfaces' }, members: { sub: 'sub' },
    externals: { hub: {}, crm: { source: { path: '../crm' }, use: ['crm-record'] } },
    extensions: { packs: [{ name: 'acme-rules', version: '1.0.0' }], useGlobalPacks: false },
  });
  write(svc, '.wai/specs/.index.yaml', {
    name: 'Svc', vision: 'Settles payments for the hub.', boundaries: [{ name: 'edge', description: 'The network edge' }, { name: 'pci', description: 'PCI scope' }],
    globalRequirements: ['Idempotent settlement'], databases: [{ id: 'ledgerdb', name: 'LedgerDB', engine: 'postgresql' }], targetLanguage: 'rust',
    publicInterfaces: [{ from: 'pay', component: 'pay-portal', audience: 'project' }],
  });
  write(svc, '.wai/specs/pay/.index.yaml', { id: 'pay', name: 'pay', description: 'Takes payments.', parentSystem: 'Svc', publicInterfaces: [{ type: 'Custom', details: 'Payments', component: 'pay-portal' }], trustedLinks: [] });
  write(svc, '.wai/specs/pay/pay-portal/.index.yaml', { id: 'pay-portal', name: 'pay-portal', description: 'Takes payments.', subsystem: 'pay', componentType: 'Portal', portalType: 'Custom', owns: [], dependsOn: [] });
  write(svc, '.wai/specs/settle/.index.yaml', { id: 'settle', name: 'settle', description: 'Settles.', parentSystem: 'Svc', publicInterfaces: [], trustedLinks: [] });
  write(svc, '.wai/lock.json', JSON.stringify({ stateId: { algorithm: 'sha256', digest: '0' }, lockedAt: TS, lockedBy: { id: 't', source: 'git' }, validatorVersion: '0', validationResult: { valid: true, errors: 0, warnings: 0, notices: 0 }, status: 'ready', projectId: 'svc' }));
  write(svc, '.wai/context/wairon-guide.md', '# derived\n');

  config(sub, { id: 'sub', name: 'Sub' });
  write(sub, '.wai/specs/.index.yaml', { name: 'Sub', vision: 'A member of svc.' });

  config(crm, { id: 'crm', name: 'Crm' });
  write(crm, '.wai/specs/.index.yaml', { name: 'Crm', vision: 'Customers.', publicInterfaces: [{ typeDef: 'crm-record', audience: 'instance' }] });
  write(crm, '.wai/specs/records/.index.yaml', { id: 'records', name: 'records', description: 'Records.', parentSystem: 'Crm', publicInterfaces: [{ typeDef: 'crm-record' }], trustedLinks: [] });
  write(crm, '.wai/specs/types/crm-record.yaml', { kind: 'value-object', id: 'crm-record', name: 'crm-record', description: 'A customer.', subsystem: 'records', fields: [{ name: 'id', type: 'string' }] });
  pinAt(svc);
  invalidateSpecCache();
  return { top, svc, sub, crm };
}

describe('stage 6 — internalize: where each piece of the member goes (the design table, one row each)', () => {
  const roots: string[] = [];
  const family = (): MetaFamily => {
    const f = metaFamily();
    roots.push(f.top);
    return f;
  };
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  it('the core write answers where every piece went', () => {
    const f = family();
    const result = at(f.top, () => internalizeMember('svc', { home: 'pay', packs: 'adopt', exports: ['pay-portal'] }));
    invalidateSpecCache();
    setProjectRoot(f.top);
    // Every subsystem moved in, under its own id.
    expect(result.subsystems.sort()).toEqual(['pay', 'settle']);
    expect(loadSubsystemSpec('settle')?.parentSystem).toBe('Hub');
    // Row: its L0 vision → the home subsystem's description, as a paragraph naming the member.
    expect(loadSubsystemSpec('pay')?.description).toBe('Takes payments.\n\nFrom the member project "svc" (Svc): Settles payments for the hub.');
    expect(result.placed).toContain('L0 vision → pay description');
    // Row: its boundaries, requirements and databases → the parent's L0, merged by identity (`edge` once).
    const l0 = loadSystemSpec()!;
    expect(l0.boundaries).toEqual([{ name: 'edge', description: 'The network edge' }, { name: 'pci', description: 'PCI scope' }]);
    expect(l0.globalRequirements).toEqual([{ description: 'Audit every write' }, 'Idempotent settlement']);
    expect(l0.databases).toEqual([{ id: 'ledgerdb', name: 'LedgerDB', engine: 'postgresql' }]);
    // Row: its language, profile and depth → each moved subsystem that states none, where they differ from the parent's.
    for (const id of ['pay', 'settle']) expect(loadSubsystemSpec(id)).toMatchObject({ targetLanguage: 'rust', profile: 'lowlevel-os', designDepth: 'interfaces' });
    // Row: its members → the parent's members, the path re-expressed from the parent.
    expect(configOf(f.top).members).toEqual({ sub: 'svc/sub' });
    // Row: its externals other than the parent → the parent's (a source path re-expressed, `use` imported); the parent's own is dropped.
    expect(configOf(f.top).externals).toEqual({ crm: { source: { path: 'crm' }, use: ['crm-record'] } });
    expect(result.externals).toEqual(['crm']);
    // Row: its packs, adopted as the destination says (pinned at the member's version).
    expect(configOf(f.top).extensions).toMatchObject({ packs: [{ name: 'acme-rules', version: '1.0.0' }] });
    expect(result.placed).toContain('pack acme-rules@1.0.0 adopted');
    // lowlevel-os is a subsystem profile and interfaces a design depth: nothing was held back.
    expect(result.notCarried).toEqual([]);
    // Row: the destination's exports → the parent's L0, re-exported from the moved subsystem.
    expect(l0.publicInterfaces).toEqual([{ from: 'pay', component: 'pay-portal', audience: 'project' }]);
    // Row: what has no home — its project.yaml, lock, pins and derived outputs — is deleted, every file listed.
    expect(result.deleted).toEqual([
      'L0 (its pieces placed): .wai/specs/.index.yaml',
      'derived outputs: .wai/context/wairon-guide.md',
      'lock: .wai/lock.json',
      'pins and snapshots: .wai/externals.lock.yaml',
      'pins and snapshots: .wai/externals/crm.yaml',
      'pins and snapshots: .wai/externals/hub.yaml',
      'project.yaml: .wai/project.yaml',
    ]);
    expect(fs.existsSync(path.join(f.svc, '.wai'))).toBe(false);
  });

  it('a projectType that is no subsystem profile (fullstack, a project kind) is not stamped but listed as not carried — no UNKNOWN_PROFILE; a valid depth still is', () => {
    const f = family();
    const file = path.join(f.svc, '.wai', 'project.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('projectType: lowlevel-os', 'projectType: fullstack'));
    const result = at(f.top, () => internalizeMember('svc', { home: 'pay', packs: 'drop' }));
    expect(result.notCarried).toEqual(['projectType fullstack not stamped on pay, settle: not a subsystem profile (a project kind, or no built-in profile or loaded pack registers it)']);
    invalidateSpecCache();
    setProjectRoot(f.top);
    for (const id of ['pay', 'settle']) {
      expect(loadSubsystemSpec(id)?.profile).toBeUndefined();
      expect(loadSubsystemSpec(id)?.designDepth).toBe('interfaces');
    }
    expect(at(f.top, () => validateProject()).issues.filter((i) => i.code === 'UNKNOWN_PROFILE')).toEqual([]);
  });

  it('packs drop: the parent selects nothing new, and the drop is placed', () => {
    const f = family();
    const result = at(f.top, () => internalizeMember('svc', { home: 'pay', packs: 'drop' }));
    expect(configOf(f.top).extensions).toMatchObject({ packs: [] });
    expect(result.placed).toContain('pack acme-rules@1.0.0 dropped');
  });

  it('through the family migration: the files each row writes, the carried external pinned in the parent, every deleted file a delete — family-consistent', () => {
    const f = family();
    const before = familyFindings(f.top);
    const report = migrate(f.top, { verb: 'internalize', alias: 'svc', destination: { home: 'pay', packs: 'adopt' } });
    expect(report.applied).toBe(true);
    const deletes = report.plan.changes.filter((c) => c.action === 'delete' && path.resolve(c.project) === path.resolve(f.svc)).map((c) => c.path);
    expect(deletes).toEqual(expect.arrayContaining(['.wai/project.yaml', '.wai/lock.json', '.wai/externals.lock.yaml', '.wai/externals/crm.yaml', '.wai/context/wairon-guide.md']));
    expect(pinsOf(f.top)).toEqual(['crm']);
    expect(fs.existsSync(path.join(f.svc, '.wai'))).toBe(false);
    // The member's approval ends with it: not listed to re-lock; the parent has no lock.
    expect(report.relock).toEqual([]);
    expect(report.plan.notes.some((n) => /approval ends with it/.test(n))).toBe(true);
    expect(newFindings(before, familyFindings(f.top)), familyLines(f.top).join('\n')).toEqual([]);
  });

  it('internalize-refused — each writing nothing: conformance debt, a severity override, an unknown .wai file, a pack with no answer, no home, a spec landing on one, an alias declared for another project', () => {
    const cases: [string, (f: MetaFamily) => void, Record<string, unknown>, RegExp][] = [
      ['conformance debt', (f) => write(f.svc,'.wai/project.yaml', fs.readFileSync(path.join(f.svc, '.wai', 'project.yaml'), 'utf8').replace('rules:\n', "rules:\n  conformance:\n    carried:\n      - kind: drift\n        why: owed\n        findings:\n          - code: X\n            spec: pay\n            at: ''\n")), { home: 'pay', packs: 'adopt' }, /conformance debt/],
      ['severity override', (f) => write(f.svc, '.wai/project.yaml', fs.readFileSync(path.join(f.svc, '.wai', 'project.yaml'), 'utf8').replace('rules:\n', 'rules:\n  sddRuleSeverity:\n    UNUSED_COMPONENT: off\n')), { home: 'pay', packs: 'adopt' }, /overrides UNUSED_COMPONENT to off/],
      ['unknown .wai file', (f) => write(f.svc, '.wai/phased_design.md', '# notes\n'), { home: 'pay', packs: 'adopt' }, /\.wai holds "phased_design\.md"/],
      ['pack with no answer', () => undefined, { home: 'pay' }, /selects the pack acme-rules@1\.0\.0/],
      ['no home', () => undefined, { home: '', packs: 'adopt' }, /needs a home subsystem \(--into\)/],
      ['a spec landing on one', (f) => write(f.top, '.wai/specs/settle/.index.yaml', { id: 'settle', name: 'settle', description: 'Ours.', parentSystem: 'Hub', publicInterfaces: [], trustedLinks: [] }), { home: 'pay', packs: 'adopt' }, /would land on this project's settle\/\.index\.yaml/],
      ['an alias declared for another project', (f) => projectConfigRepositoryAt(f.top).declareExternal('crm', { project: 'other-crm' }), { home: 'pay', packs: 'adopt' }, /its external "crm" names "crm", which this project declares as "other-crm"/],
    ];
    for (const [name, arrange, destination, why] of cases) {
      const f = family();
      arrange(f);
      invalidateSpecCache();
      const before = dirHash(f.top);
      const planned = plan(f.top, { verb: 'internalize', alias: 'svc', destination: destination as never });
      expect(planned.refusals.map((r) => r.code), name).toEqual(['internalize-refused']);
      expect(planned.refusals[0].detail, name).toMatch(why);
      expect(at(f.top, () => migrations.apply(planned)).applied, name).toBe(false);
      expect(dirHash(f.top), name).toEqual(before);
    }
  });
});

// ── internalize across the family ───────────────────────────────────────────

describe('stage 6 — internalize re-points every family consumer of the member', () => {
  const made: ContractFamily[] = [];
  const family = (): ContractFamily => {
    const f = buildContractFamily();
    made.push(f);
    pinAt(f.billing);
    return f;
  };
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    for (const f of made.splice(0)) {
      try { f.cleanup(); } catch { /* windows locks */ }
    }
  });

  it('a consumer with no alias for the parent: its external repointed at the parent, re-pinned; the parent exports what it used; family-consistent', () => {
    const f = family();
    const before = familyFindings(f.top);
    const report = migrate(f.top, { verb: 'internalize', alias: 'ledger', destination: { home: '' } });
    expect(report.applied).toBe(true);
    expect(configOf(f.top).members).toEqual({ billing: 'billing' });
    expect(configOf(f.billing).externals).toEqual({ ledger: { project: 'house' } });
    expect(pinsOf(f.billing)).toEqual(['ledger']);
    const l0 = at(f.top, () => loadSystemSpec())!;
    expect(l0.publicInterfaces).toEqual([{ from: 'books', component: 'ledger-portal', audience: 'project' }]);
    expect(at(f.billing, () => validateProject()).issues.filter((i) => i.code.startsWith('EXTERNAL_')).map((i) => i.code)).toEqual([]);
    expect(newFindings(before, familyFindings(f.top)), familyLines(f.top).join('\n')).toEqual([]);
  });

  it('a consumer that already names the parent: its references respelled to that alias, the member external and pin removed', () => {
    const f = family();
    projectConfigRepositoryAt(f.billing).declareExternal('house', {});
    const report = migrate(f.top, { verb: 'internalize', alias: 'ledger', destination: { home: '' } });
    expect(report.applied).toBe(true);
    expect(configOf(f.billing).externals).toEqual({ house: {} });
    expect(pinsOf(f.billing)).toEqual([]);
    const component = fs.readFileSync(path.join(f.billing, '.wai', 'specs', 'invoicing', 'invoice-poster', '.index.yaml'), 'utf8');
    expect(component).toContain('house::ledger-portal');
    expect(component).not.toContain('ledger::ledger-portal');
  });

  it('refuses — each writing nothing: not-a-member, member-absent, family-partial, name-collision', () => {
    const f = family();
    const check = (planned: ReturnType<typeof plan>, code: string, before: Record<string, string>): void => {
      expect(planned.refusals.map((r) => r.code), code).toContain(code);
      expect(dirHash(f.top), code).toEqual(before);
    };
    let before = dirHash(f.top);
    check(plan(f.top, { verb: 'internalize', alias: 'ghost', destination: { home: '' } }), 'not-a-member', before);
    fs.renameSync(f.ledger, `${f.ledger}-away`);
    before = dirHash(f.top);
    check(plan(f.top, { verb: 'internalize', alias: 'ledger', destination: { home: '' } }), 'member-absent', before);
    fs.renameSync(`${f.ledger}-away`, f.ledger);
    before = dirHash(f.top);
    check(runWithProjectBinding(f.top, { topRoot: f.top, parentReach: false }, () => { invalidateSpecCache(); return migrations.plan({ verb: 'internalize', alias: 'ledger', destination: { home: '' } }); }), 'family-partial', before);
    // The parent already exports `ledger-portal` for a target of its own, and billing uses ledger's.
    write(f.top, '.wai/specs/front/front-portal/.index.yaml', { id: 'front-portal', name: 'front-portal', description: 'Ours.', subsystem: 'front', componentType: 'Portal', portalType: 'Custom', owns: [], dependsOn: [] });
    write(f.top, '.wai/specs/front/.index.yaml', { id: 'front', name: 'front', description: 'The front.', parentSystem: 'House', publicInterfaces: [{ type: 'Custom', details: 'Front', component: 'front-portal' }], trustedLinks: [], status: 'complete' });
    write(f.top, '.wai/specs/.index.yaml', { name: 'House', vision: 'House in miniature', publicInterfaces: [{ from: 'front', component: 'front-portal', as: 'ledger-portal', audience: 'project' }] });
    invalidateSpecCache();
    before = dirHash(f.top);
    check(plan(f.top, { verb: 'internalize', alias: 'ledger', destination: { home: '' } }), 'name-collision', before);
  });
});

describe('stage 6 — internalize on the reference family (Waffler in miniature, canonicalized by the chaining migration)', () => {
  let r: ReferenceFamily | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    r?.cleanup();
    r = undefined;
  });

  it('core — two subsystems, a member of its own, a sibling consumer and a consumer below it — folds into the top: family-consistent', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    r = buildReferenceFamily();
    migrate(r.top, { verb: 'chaining' });
    const before = familyFindings(r.top);
    const report = migrate(r.top, { verb: 'internalize', alias: 'core', destination: { home: 'engine', packs: 'drop' } });
    expect(report.applied).toBe(true);
    // Its own member transpiler is the top's now, and neither it nor shared names a project that is gone.
    expect(configOf(r.top).members).toMatchObject({ transpiler: 'core/transpiler' });
    const graph = at(r.top, () => projectFamilyGraph());
    expect(graph.nodes.map((n) => n.namespace).sort()).toEqual(['', 'shared', 'transpiler']);
    expect(newFindings(before, familyFindings(r.top)), familyLines(r.top).join('\n')).toEqual([]);
  });
});

// ── externalize ─────────────────────────────────────────────────────────────

/** house (top) with subsystems orders (publishing orders-portal) and web (whose web-portal calls it), and member shop consuming house's `orders-portal`. */
function shopFamily(): { top: string; shop: string } {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-extz-'));
  const shop = path.join(top, 'shop');
  write(top, '.wai/project.yaml', dump({ id: 'house', name: 'House', targets: [], members: { shop: 'shop' }, extensions: { packs: [], useGlobalPacks: false } }));
  write(top, '.wai/specs/.index.yaml', { name: 'House', vision: 'Orders.', publicInterfaces: [{ from: 'orders', component: 'orders-portal', audience: 'project' }] });
  write(top, '.wai/specs/orders/.index.yaml', { id: 'orders', name: 'orders', description: 'Orders.', parentSystem: 'House', publicInterfaces: [{ type: 'Custom', details: 'Orders', component: 'orders-portal' }], trustedLinks: [] });
  write(top, '.wai/specs/orders/orders-portal/.index.yaml', { id: 'orders-portal', name: 'orders-portal', description: 'Takes orders.', subsystem: 'orders', componentType: 'Portal', portalType: 'Custom', owns: [], dependsOn: [] });
  write(top, '.wai/specs/web/.index.yaml', { id: 'web', name: 'web', description: 'Web.', parentSystem: 'House', publicInterfaces: [{ type: 'Custom', details: 'Web', component: 'web-portal' }], trustedLinks: [] });
  write(top, '.wai/specs/web/web-portal/.index.yaml', { id: 'web-portal', name: 'web-portal', description: 'The web.', subsystem: 'web', componentType: 'Portal', portalType: 'Custom', owns: [], dependsOn: ['orders-portal'] });
  write(top, '.wai/specs/web/web-store/.index.yaml', { id: 'web-store', name: 'web-store', description: 'Unpublished.', subsystem: 'web', componentType: 'Store', owns: [], dependsOn: [] });
  write(shop, '.wai/project.yaml', dump({ id: 'shop', name: 'Shop', targets: [], externals: { house: {} }, extensions: { packs: [], useGlobalPacks: false } }));
  write(shop, '.wai/specs/.index.yaml', { name: 'Shop', vision: 'Shop.' });
  write(shop, '.wai/specs/till/.index.yaml', { id: 'till', name: 'till', description: 'Till.', parentSystem: 'Shop', publicInterfaces: [], trustedLinks: [] });
  write(shop, '.wai/specs/till/till-adapter/.index.yaml', { id: 'till-adapter', name: 'till-adapter', description: 'Orders through the house.', subsystem: 'till', componentType: 'Adapter', owns: [], dependsOn: ['house::orders-portal'] });
  pinAt(shop);
  invalidateSpecCache();
  return { top, shop };
}

describe('stage 6 — externalize, family-wide', () => {
  const roots: string[] = [];
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  // Stage 8: externalize defaults to a part; these are the externalize AS PROJECT properties (the move composed with a promote).
  it('property: externalize-updates-siblings — a sibling using a name the moved subsystem realizes keeps resolving, and nothing of it is written; family-consistent', () => {
    const f = shopFamily();
    roots.push(f.top);
    const before = familyFindings(f.top);
    const shopBytes = waiState(f.shop);
    const report = migrate(f.top, { verb: 'externalize', subsystem: 'orders', path: 'services/orders', as: 'project' });
    expect(report.applied).toBe(true);
    expect(configOf(f.top).members).toEqual({ shop: 'shop', orders: 'services/orders' });
    expect(fs.existsSync(path.join(f.top, 'services', 'orders', '.wai', 'specs', 'orders', 'orders-portal', '.index.yaml'))).toBe(true);
    // The parent's L0 re-export now re-exports the member, so shop's `house::orders-portal` still resolves …
    expect(at(f.top, () => loadSystemSpec())!.publicInterfaces).toEqual([expect.objectContaining({ from: 'orders', audience: 'project' })]);
    expect(fs.readFileSync(path.join(f.top, '.wai', 'specs', 'web', 'web-portal', '.index.yaml'), 'utf8')).toContain('orders::orders-portal');
    // … and not one byte of shop moved.
    expect(waiState(f.shop)).toEqual(shopBytes);
    expect(at(f.shop, () => validateProject()).issues.filter((i) => i.code.startsWith('EXTERNAL_')).map((i) => i.code)).toEqual([]);
    expect(report.relock).toEqual([]);
    // The new member comes with its own state (never locked: MEMBER_UNAPPROVED names it); nothing else is new.
    const itsOwn = (i: { project?: string; message: string }): boolean => i.project === 'orders' || /"orders"/.test(i.message);
    expect(newFindings(before, familyFindings(f.top, itsOwn)), familyLines(f.top).join('\n')).toEqual([]);
    const again = plan(f.top, { verb: 'externalize', subsystem: 'orders', path: 'services/orders', as: 'project' });
    expect([again.refusals, again.changes], JSON.stringify(again.refusals)).toEqual([[], []]);
  });

  it('refuses — each writing nothing: externalize-refused (missing, a reference back into an unpublished component, a sibling name left unresolved), not-contained, alias-taken, id-collision', () => {
    const cases: [string, (f: { top: string; shop: string }) => void, Record<string, string>, string, RegExp?][] = [
      ['missing', () => undefined, { subsystem: 'ghost', path: 'services/ghost' }, 'externalize-refused'],
      ['crossing', (f) => write(f.top, '.wai/specs/orders/orders-portal/.index.yaml', { id: 'orders-portal', name: 'orders-portal', description: 'Takes orders.', subsystem: 'orders', componentType: 'Portal', portalType: 'Custom', owns: [], dependsOn: ['web-store'] }), { subsystem: 'orders', path: 'services/orders' }, 'externalize-refused', /names web-store, which its subsystem web does not publish/],
      ['sibling', (f) => write(f.top, '.wai/specs/.index.yaml', { name: 'House', vision: 'Orders.', publicInterfaces: [{ component: 'orders-portal', audience: 'project' }] }), { subsystem: 'orders', path: 'services/orders' }, 'externalize-refused', /uses "orders-portal"/],
      ['outside', () => undefined, { subsystem: 'orders', path: '../elsewhere' }, 'not-contained'],
      ['holds a project', (f) => write(f.top, 'services/orders/.wai/project.yaml', dump({ id: 'x', name: 'X', targets: [] })), { subsystem: 'orders', path: 'services/orders' }, 'not-contained'],
      ['alias-taken', (f) => projectConfigRepositoryAt(f.top).declareExternal('orders', { project: 'somewhere' }), { subsystem: 'orders', path: 'services/orders' }, 'alias-taken'],
      ['id-collision', (f) => write(f.shop, '.wai/project.yaml', dump({ id: 'orders', name: 'Shop', targets: [], externals: { house: {} } })), { subsystem: 'orders', path: 'services/orders' }, 'id-collision'],
    ];
    for (const [name, arrange, args, code, why] of cases) {
      const f = shopFamily();
      roots.push(f.top);
      arrange(f);
      invalidateSpecCache();
      const before = dirHash(f.top);
      const planned = plan(f.top, { verb: 'externalize', subsystem: args.subsystem, path: args.path, as: 'project' });
      expect(planned.refusals.map((r) => r.code), name).toContain(code);
      if (why) expect(planned.refusals.map((r) => r.detail).join('\n'), name).toMatch(why);
      expect(at(f.top, () => migrations.apply(planned)).applied, name).toBe(false);
      expect(dirHash(f.top), name).toEqual(before);
    }
  });
});

// ── move-is-free ────────────────────────────────────────────────────────────

describe('stage 6 — move-is-free', () => {
  let f: ReferenceFamily | undefined;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    f?.cleanup();
    f = undefined;
  });

  it('`member move` changes no reference: every authored reference reads the same, and the family run is unchanged', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    f = buildReferenceFamily();
    migrate(f.top, { verb: 'chaining' });
    const refs = (): string[] => at(f!.top, () => projectFamilyGraph()).authoredReferences.map((r) => `${r.specId}|${r.position}|${r.authored}`).sort();
    const beforeRefs = refs();
    const before = familyFindings(f.top);
    at(f.top, () => moveMember('core', 'packages/core'));
    expect(refs()).toEqual(beforeRefs);
    expect(familyFindings(f.top)).toEqual(before);
    vi.restoreAllMocks();
  });
});

// ── a storage move owes no re-lock ──────────────────────────────────────────

describe('externalize into a part — a storage move — agrees with lock and lock-check', () => {
  const roots: string[] = [];
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  const lockTop = async (top: string): Promise<void> => {
    await at(top, async () => {
      invalidateSpecCache();
      await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
    });
    invalidateSpecCache();
  };

  it('an approved project whose specs only move storage is no project to re-lock, and its approval still holds', async () => {
    const f = shopFamily();
    roots.push(f.top);
    await lockTop(f.top);
    const planned = plan(f.top, { verb: 'externalize', subsystem: 'orders', path: 'services/orders' });
    expect(planned.refusals).toEqual([]);
    // Before: "To re-lock once applied: this project (.)" for a move nothing in the approval covers.
    expect(planned.relock).toEqual([]);
    const report = at(f.top, () => migrations.apply(planned));
    expect(report.applied).toBe(true);
    expect(report.relock).toEqual([]);
    invalidateSpecCache();
    // lock-check's reading and lock's reading agree: approved, no spec changed — only moved.
    expect(at(f.top, () => readLockState(computeGateStateId()).state)).toBe('locked');
    const diff = at(f.top, () => diffAgainstApproval())!;
    expect(diff.added.length + diff.changed.length + diff.removed.length).toBe(0);
    expect(diff.moved.length).toBeGreaterThan(0);
  });

  it('control: a project with an unapproved change still owes its re-lock', async () => {
    const f = shopFamily();
    roots.push(f.top);
    await lockTop(f.top);
    write(f.top, '.wai/specs/orders/orders-portal/.index.yaml', { id: 'orders-portal', name: 'orders-portal', description: 'Takes orders, and refunds.', subsystem: 'orders', componentType: 'Portal', portalType: 'Custom', owns: [], dependsOn: [] });
    invalidateSpecCache();
    const planned = plan(f.top, { verb: 'externalize', subsystem: 'orders', path: 'services/orders' });
    expect(planned.relock.map((d) => path.resolve(d))).toEqual([path.resolve(f.top)]);
    at(f.top, () => migrations.discard(planned));
  });
});
