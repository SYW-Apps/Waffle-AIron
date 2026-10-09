import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, loadSubsystemSpec } from '../../src/core/specs.js';
import { validateProject, validateFamily, type ValidationIssue } from '../../src/core/validation.js';
import { pinExternals, getExternalsStatus } from '../../src/core/surfaces.js';
import { createMember, advanceMember, listDirectChainedSubprojects, findChainingSubprojectsMissingConfig, resolveAgentTopology } from '../../src/core/index.js';
import { buildCanvasModel } from '../../src/core/canvas.js';
import { getStatusReport } from '../../src/core/status.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { at, plan, migrate, waiState, dirHash } from '../helpers/family-verbs.js';
import * as migrations from '../../src/migrations/index.js';
import {
  tempDir, isolateGlobals, bareFrom, pushChange, projectYaml, system, subsystem, component, specs,
  writeLedger, renameLedgerMethod, writeShop, writeClinic,
} from '../helpers/stage8-family.js';

// ---------------------------------------------------------------------------
// Stage 8, wave B — referenced projects, the growth verbs, overview and
// topology for parts. Real temp directories throughout; a git repository is
// served by a LOCAL bare repository, so nothing needs a network, and HOME,
// USERPROFILE, APPDATA, LOCALAPPDATA and WAIRON_CACHE_DIR point at temp
// directories. Nothing on the path under test is mocked.
// ---------------------------------------------------------------------------

const cleanups: (() => void)[] = [];
beforeEach(() => {
  cleanups.push(isolateGlobals(cleanups));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  setProjectRoot(null);
  invalidateSpecCache();
  for (const c of cleanups.splice(0).reverse()) {
    try { c(); } catch { /* windows file locks */ }
  }
});

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

/** The EXTERNAL_* findings of a verdict, as `code` strings. */
const externalCodes = (issues: ValidationIssue[]): string[] => issues.filter((i) => i.code.startsWith('EXTERNAL_')).map((i) => i.code).sort();

/** A spec document with its stamps dropped: what the parent SAYS, not when it was saved. */
function stampless(file: string): unknown {
  const doc = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const { updatedAt: _u, createdAt: _c, ...rest } = doc;
  return rest;
}

// ── referenced projects and per-use comparison ─────────────────────────────

describe('stage 8 — property: referenced-break-is-incompatible', () => {
  it('a git-sourced project member renames a used method: the consumer\'s own gate stays clean against its pin; the family run reports EXTERNAL_INCOMPATIBLE', () => {
    const base = tempDir(cleanups, 'wairon-refgit-');
    const work = path.join(base, 'ledger-work');
    writeLedger(work);
    const repo = bareFrom(cleanups, work, 'ledger');
    const shop = path.join(base, 'shop');
    writeShop(shop, { members: { ledger: `${repo.url}#${repo.commit}` } });
    bind(shop);
    // Pinned as a member, at the declared commit, with the used method recorded.
    const [pin] = pinExternals();
    expect(pin).toMatchObject({ alias: 'ledger', outcome: 'pinned', usedNames: 1 });
    const lock = yaml.load(fs.readFileSync(path.join(shop, '.wai', 'externals.lock.yaml'), 'utf8')) as { externals: Record<string, Record<string, unknown>> };
    expect(lock.externals.ledger).toMatchObject({ role: 'member', commit: repo.commit, used: { 'ledger-portal': { post: expect.stringMatching(/^sha256:/) } } });
    bind(shop);
    expect(externalCodes(validateProject({}).issues)).toEqual([]);
    // The producer renames the used method; `member update` moves the pin to it.
    renameLedgerMethod(work, 'record');
    const moved = pushChange(work, repo.bare, 'rename post to record');
    bind(shop);
    const report = advanceMember('ledger', undefined, undefined, true);
    expect(report).toMatchObject({ from: repo.commit, to: moved, written: false, changed: ['.wai/specs/books/ledger-portal/.interface.yaml'] });
    const advanced = advanceMember('ledger');
    expect(advanced).toMatchObject({ from: repo.commit, to: moved, written: true });
    expect(projectConfigRepositoryAt(shop).load()?.members?.ledger).toBe(`${repo.url}#${moved}`);
    // The owner's gate judges the pin: clean.
    bind(shop);
    expect(externalCodes(validateProject({}).issues)).toEqual([]);
    // The family run fetches the pinned commit and composes per use: incompatible.
    bind(shop);
    const family = validateFamily({});
    expect(family.issues.filter((i) => i.code === 'EXTERNAL_INCOMPATIBLE').map((i) => i.message).join('\n')).toMatch(/"ledger-portal\.post"/);
    expect(family.valid).toBe(false);
    // The referenced member's own gate ran in the family run, under its key.
    expect((family.projects ?? []).map((p) => p.key)).toContain('ledger');
  }, 60_000); // real git clones and a family run: slow under a full parallel suite

  it('a git-sourced external: its ref head is the live producer the family run compares the pin against', () => {
    const base = tempDir(cleanups, 'wairon-refgitx-');
    const work = path.join(base, 'ledger-work');
    writeLedger(work);
    const repo = bareFrom(cleanups, work, 'ledger');
    const shop = path.join(base, 'shop');
    writeShop(shop, { externals: { ledger: { source: { git: repo.url } } } });
    bind(shop);
    expect(pinExternals()[0]).toMatchObject({ alias: 'ledger', outcome: 'pinned', usedNames: 1 });
    renameLedgerMethod(work, 'record');
    pushChange(work, repo.bare, 'rename post to record');
    bind(shop);
    expect(externalCodes(validateProject({}).issues)).toEqual([]);
    bind(shop);
    expect(externalCodes(validateFamily({ family: true }).issues)).toContain('EXTERNAL_INCOMPATIBLE');
  });

  // Round 8: a `../` sibling MEMBER is composed live like a contained one — no
  // pin, its specs read where they are — so a rename it makes is the
  // consumer's own finding at once. A path EXTERNAL stays judged against its pin.
  it('a sibling member renames a used method: composed live like a contained member — no pin, the consumer\'s own gate names the broken call', () => {
    const base = tempDir(cleanups, 'wairon-refsib-');
    const ledger = path.join(base, 'ledger');
    writeLedger(ledger);
    const shop = path.join(base, 'shop');
    writeShop(shop, { members: { ledger: '../ledger' } });
    bind(shop);
    expect(pinExternals()).toEqual([]);
    bind(shop);
    expect(externalCodes(validateProject({}).issues)).toEqual([]);
    bind(shop);
    expect(validateProject({}).issues.map((i) => i.code)).not.toContain('INVALID_TARGET_METHOD_REFERENCE');
    renameLedgerMethod(ledger, 'record');
    bind(shop);
    expect(validateProject({}).issues.map((i) => i.code)).toContain('INVALID_TARGET_METHOD_REFERENCE');
    bind(shop);
    const family = validateFamily({ family: true });
    expect(externalCodes(family.issues)).not.toContain('EXTERNAL_CHECK_UNAVAILABLE');
    expect((family.projects ?? []).map((p) => p.key)).toContain('ledger');
  });

  for (const shape of ['path external'] as const) {
    it(`a ${shape} renames a used method: own gate clean, family run EXTERNAL_INCOMPATIBLE`, () => {
      const base = tempDir(cleanups, 'wairon-refpath-');
      const ledger = path.join(base, 'ledger');
      writeLedger(ledger);
      const shop = path.join(base, 'shop');
      writeShop(shop, { externals: { ledger: { source: { path: '../ledger' } } } });
      bind(shop);
      expect(pinExternals()[0]).toMatchObject({ alias: 'ledger', outcome: 'pinned', usedNames: 1 });
      bind(shop);
      expect(externalCodes(validateProject({}).issues)).toEqual([]);
      renameLedgerMethod(ledger, 'record');
      bind(shop);
      expect(externalCodes(validateProject({}).issues)).toEqual([]);
      bind(shop);
      const status = getExternalsStatus()[0];
      expect(status).toMatchObject({ stale: true, uses: [{ publicName: 'ledger-portal', member: 'post', state: 'removed' }] });
      bind(shop);
      expect(externalCodes(validateFamily({ family: true }).issues)).toContain('EXTERNAL_INCOMPATIBLE');
    });
  }

  it('a git member that cannot be fetched is unavailable — never a pass', () => {
    const base = tempDir(cleanups, 'wairon-refoff-');
    const work = path.join(base, 'ledger-work');
    writeLedger(work);
    const repo = bareFrom(cleanups, work, 'ledger');
    const shop = path.join(base, 'shop');
    writeShop(shop, { members: { ledger: `${repo.url}#${repo.commit}` } });
    bind(shop);
    pinExternals();
    // A fresh cache and no remote: the pinned commit cannot be materialized.
    process.env.WAIRON_CACHE_DIR = tempDir(cleanups, 'wairon-cache-empty-');
    fs.rmSync(repo.bare, { recursive: true, force: true });
    bind(shop);
    const family = validateFamily({});
    expect(externalCodes(family.issues)).toContain('EXTERNAL_CHECK_UNAVAILABLE');
    expect(family.issues.some((i) => i.code === 'EXTERNAL_INCOMPATIBLE')).toBe(false);
  });
});

// ── member add ──────────────────────────────────────────────────────────────

describe('stage 8 — member add: a part by default, a project with --project, every source form', () => {
  function clinicRoot(): string {
    const root = path.join(tempDir(cleanups, 'wairon-add-'), 'clinic');
    projectYaml(root, { id: 'clinic', name: 'Clinic' });
    system(root, 'Clinic');
    return root;
  }

  it('a contained source makes a part: a specs folder, no configuration, declared by the shorthand', () => {
    const root = clinicRoot();
    bind(root);
    expect(createMember('scheduling', 'services/scheduling')).toMatchObject({ as: 'part', storage: 'contained', configCreated: false });
    expect(fs.existsSync(path.join(root, 'services', 'scheduling', '.wai', 'specs'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'services', 'scheduling', '.wai', 'project.yaml'))).toBe(false);
    expect(projectConfigRepositoryAt(root).load()?.members).toEqual({ scheduling: 'services/scheduling' });
    // Idempotent.
    bind(root);
    expect(createMember('scheduling', 'services/scheduling')).toMatchObject({ as: 'part' });
  });

  it('--project makes a project: its id, its L0', () => {
    const root = clinicRoot();
    bind(root);
    expect(createMember('billing', 'services/billing', 'Invoices', 'project')).toMatchObject({ as: 'project', storage: 'contained', configCreated: true });
    expect(projectConfigRepositoryAt(path.join(root, 'services', 'billing')).load()?.id).toBe('billing');
    expect(fs.existsSync(path.join(root, 'services', 'billing', '.wai', 'specs', '.index.yaml'))).toBe(true);
  });

  it('a `../` source makes a sibling part naming its parent', () => {
    const root = clinicRoot();
    bind(root);
    expect(createMember('admin', '../admin')).toMatchObject({ as: 'part', storage: 'path', configCreated: true });
    expect(projectConfigRepositoryAt(path.join(path.dirname(root), 'admin')).load()?.partOf).toEqual({ project: 'clinic', path: '../clinic' });
    expect(projectConfigRepositoryAt(root).load()?.members).toEqual({ admin: '../admin' });
  });

  it('a git source is never scaffolded: pinned at the commit given, else the default branch head; its content decides what it is', () => {
    const work = tempDir(cleanups, 'wairon-addgit-');
    subsystem(work, 'Clinic', 'reporting');
    fs.writeFileSync(path.join(work, '.wai', 'project.yaml'), yaml.dump({ schemaVersion: '1.0.0', partOf: { project: 'clinic' } }));
    const repo = bareFrom(cleanups, work, 'reporting');
    const root = clinicRoot();
    bind(root);
    expect(createMember('reporting', repo.url)).toMatchObject({ as: 'part', storage: 'git', commit: repo.commit });
    expect(projectConfigRepositoryAt(root).load()?.members?.reporting).toBe(`${repo.url}#${repo.commit}`);
    bind(root);
    expect(loadSubsystemSpec('reporting')?.id).toBe('reporting');
    // The commit given; and `as` only asserts — a contradiction refuses.
    const other = clinicRoot();
    bind(other);
    expect(createMember('reporting', `${repo.url}#${repo.commit}`)).toMatchObject({ commit: repo.commit });
    bind(other);
    expect(() => createMember('reports', repo.url, undefined, 'project')).toThrow(/makes it a part/);
  });

  it('refuses a hosted source, an escaping path, and a part on a directory that already holds a project', () => {
    const root = clinicRoot();
    bind(root);
    expect(() => createMember('x', 'hosted:x')).toThrow(/hosted project creation/);
    expect(() => createMember('y', 'packages/../../y')).toThrow();
    projectYaml(path.join(root, 'services', 'ledger'), { id: 'ledger', name: 'Ledger' });
    bind(root);
    expect(() => createMember('ledger', 'services/ledger')).toThrow(/member attach/);
  });
});

// ── promote and demote ──────────────────────────────────────────────────────

describe('stage 8 — promote and demote', () => {
  function clinic(): { root: string; part: string } {
    return writeClinic(path.join(tempDir(cleanups, 'wairon-promote-'), 'clinic'));
  }

  it('property: promote-then-demote-is-identity — the part\'s files byte-identical, the parent semantically identical', () => {
    const { root, part } = clinic();
    const partBytes = waiState(part);
    const parentConfig = projectConfigRepositoryAt(root).load();
    const parentFiles = ['.index.yaml', 'frontdesk/.index.yaml', 'frontdesk/checkin-client/.index.yaml', 'types/patient.yaml'];
    const parentSpecs = parentFiles.map((f) => stampless(specs(root, ...f.split('/'))));
    bind(root);
    const before = validateProject({}).issues.map((i) => `${i.severity} ${i.code}`).sort();

    const promoted = migrate(root, { verb: 'promote', alias: 'scheduling' });
    expect(promoted.applied).toBe(true);
    // A project now: its id, its L0 exporting what the clinic uses of it, references respelled both ways.
    expect(projectConfigRepositoryAt(part).load()).toMatchObject({ id: 'scheduling', externals: { clinic: { use: ['patient'] } } });
    expect((yaml.load(fs.readFileSync(specs(part, '.index.yaml'), 'utf8')) as { publicInterfaces: unknown[] }).publicInterfaces)
      .toEqual([{ component: 'schedule-portal', from: 'scheduling', audience: 'project' }]);
    expect((yaml.load(fs.readFileSync(specs(root, 'frontdesk', 'checkin-client', '.index.yaml'), 'utf8')) as { dependsOn: string[] }).dependsOn).toEqual(['scheduling::schedule-portal']);
    expect((yaml.load(fs.readFileSync(specs(part, 'scheduling', 'booking-client', '.index.yaml'), 'utf8')) as { dependsOn: string[] }).dependsOn).toEqual(['clinic::patient-portal']);
    bind(part);
    expect(validateProject({}).issues.filter((i) => i.severity === 'error')).toEqual([]);
    bind(root);
    expect(validateFamily({}).issues.filter((i) => i.severity === 'error')).toEqual([]);

    const demoted = migrate(root, { verb: 'demote', alias: 'scheduling' });
    expect(demoted.applied).toBe(true);
    expect(waiState(part)).toEqual(partBytes);
    expect(projectConfigRepositoryAt(root).load()).toEqual(parentConfig);
    expect(parentFiles.map((f) => stampless(specs(root, ...f.split('/'))))).toEqual(parentSpecs);
    bind(root);
    expect(validateProject({}).issues.map((i) => `${i.severity} ${i.code}`).sort()).toEqual(before);
  });

  it('promote --id names the new project; the alias stays', () => {
    const { root, part } = clinic();
    migrate(root, { verb: 'promote', alias: 'scheduling', newId: 'agenda' });
    expect(projectConfigRepositoryAt(part).load()?.id).toBe('agenda');
    expect(projectConfigRepositoryAt(root).load()?.members).toEqual({ scheduling: 'services/scheduling' });
  });

  it('promote refuses — each writing nothing: a git part, a trusted link crossing the boundary, an unpublished component used across it, an id collision', () => {
    // A git part.
    const work = tempDir(cleanups, 'wairon-promgit-');
    subsystem(work, 'Clinic', 'reporting');
    fs.writeFileSync(path.join(work, '.wai', 'project.yaml'), yaml.dump({ schemaVersion: '1.0.0', partOf: { project: 'clinic' } }));
    const repo = bareFrom(cleanups, work, 'reporting');
    const gitClinic = clinic();
    projectYaml(gitClinic.root, { id: 'clinic', name: 'Clinic', members: { scheduling: 'services/scheduling', reporting: `${repo.url}#${repo.commit}` } });
    const cases: [string, { root: string }, Parameters<typeof plan>[1], string][] = [
      ['git', gitClinic, { verb: 'promote', alias: 'reporting' }, 'read-only'],
    ];
    // A trusted link from the clinic's frontdesk into the part.
    const linked = clinic();
    subsystem(linked.root, 'Clinic', 'frontdesk', {
      publicInterfaces: [{ type: 'Custom', details: 'Patients', component: 'patient-portal' }],
      trustedLinks: [{ subsystem: 'scheduling', reason: 'in-process calls' }],
    });
    cases.push(['trusted link', linked, { verb: 'promote', alias: 'scheduling' }, 'trusted-link-crosses']);
    // A component used across the new boundary that its subsystem does not publish.
    const hidden = clinic();
    subsystem(hidden.part, 'Clinic', 'scheduling');
    cases.push(['unpublished', hidden, { verb: 'promote', alias: 'scheduling' }, 'promote-refused']);
    // An id a family project already answers to.
    cases.push(['id collision', clinic(), { verb: 'promote', alias: 'scheduling', newId: 'clinic' }, 'id-collision']);
    for (const [name, f, request, code] of cases) {
      invalidateSpecCache();
      const before = dirHash(f.root);
      const planned = plan(f.root, request);
      expect(planned.refusals.map((r) => r.code), name).toContain(code);
      expect(at(f.root, () => migrations.apply(planned)).applied, name).toBe(false);
      expect(dirHash(f.root), name).toEqual(before);
    }
    const hiddenPlan = plan(hidden.root, { verb: 'promote', alias: 'scheduling' });
    expect(hiddenPlan.refusals.map((r) => r.detail).join('\n')).toMatch(/does not publish/);
  });

  it('demote is refused while another family project consumes the member', () => {
    const top = tempDir(cleanups, 'wairon-demote-');
    projectYaml(top, { id: 'top', name: 'Top', members: { ledger: 'ledger', shop: 'shop' } });
    system(top, 'Top');
    writeLedger(path.join(top, 'ledger'));
    writeShop(path.join(top, 'shop'), { externals: { ledger: {} } });
    const before = dirHash(top);
    const planned = plan(top, { verb: 'demote', alias: 'ledger' });
    expect(planned.refusals.map((r) => r.code)).toEqual(['consumed-elsewhere']);
    expect(planned.refusals[0].detail).toMatch(/"ledger-portal"/);
    expect(dirHash(top)).toEqual(before);
  });
});

// ── externalize and internalize for parts ───────────────────────────────────

describe('stage 8 — externalize makes a part; internalize of a part is a storage move', () => {
  it('a subsystem moves into a part and back: no reference changes, the same verdict, the same bytes', () => {
    const root = path.join(tempDir(cleanups, 'wairon-ext-'), 'clinic');
    projectYaml(root, { id: 'clinic', name: 'Clinic' });
    system(root, 'Clinic');
    subsystem(root, 'Clinic', 'frontdesk', { publicInterfaces: [{ type: 'Custom', details: 'Patients', component: 'patient-portal' }] });
    component(root, 'frontdesk', 'patient-portal', 'Portal');
    subsystem(root, 'Clinic', 'scheduling');
    component(root, 'scheduling', 'booking-client', 'Adapter', ['patient-portal']);
    const specBytes = (): Record<string, string> => Object.fromEntries(Object.entries(waiState(root)).filter(([k]) => k.includes('/specs/') && !k.endsWith('/')));
    const before = specBytes();
    bind(root);
    const verdict = validateProject({}).issues.map((i) => `${i.severity} ${i.code} @${i.specId ?? ''}`).sort();

    const out = migrate(root, { verb: 'externalize', subsystem: 'scheduling', path: 'services/scheduling' });
    expect(out.applied).toBe(true);
    expect(out.plan.edits.some((e) => e.kind === 'reference' || e.kind === 'pin')).toBe(false);
    expect(projectConfigRepositoryAt(root).load()?.members).toEqual({ scheduling: 'services/scheduling' });
    expect(fs.existsSync(specs(root, 'scheduling'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'services', 'scheduling', '.wai', 'project.yaml'))).toBe(false);
    bind(root);
    expect(validateProject({}).issues.map((i) => `${i.severity} ${i.code} @${i.specId ?? ''}`).sort()).toEqual(verdict);

    const back = migrate(root, { verb: 'internalize', alias: 'scheduling' });
    expect(back.applied).toBe(true);
    expect(projectConfigRepositoryAt(root).load()?.members).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'services', 'scheduling', '.wai'))).toBe(false);
    expect(specBytes()).toEqual(before);
  });

  it('externalize --as project composes the move with a promote', () => {
    const { root } = writeClinic(path.join(tempDir(cleanups, 'wairon-extp-'), 'clinic'));
    subsystem(root, 'Clinic', 'pharmacy', { publicInterfaces: [{ type: 'Custom', details: 'Dispenses', component: 'pharmacy-portal' }] });
    component(root, 'pharmacy', 'pharmacy-portal', 'Portal');
    const report = migrate(root, { verb: 'externalize', subsystem: 'pharmacy', path: 'services/pharmacy', as: 'project' });
    expect(report.applied).toBe(true);
    expect(projectConfigRepositoryAt(path.join(root, 'services', 'pharmacy')).load()?.id).toBe('pharmacy');
  });
});

// ── overview and topology ───────────────────────────────────────────────────

describe('stage 8 — overview follows composition: parts are the parent\'s subsystems, projects are project nodes', () => {
  it('the canvas badges a part\'s subsystems with their storage and draws a referenced project as a node with its consumption edge', () => {
    const { root } = writeClinic(path.join(tempDir(cleanups, 'wairon-canvas-'), 'clinic'));
    bind(root);
    const model = buildCanvasModel();
    expect(model.subsystems.find((s) => s.id === 'scheduling')).toMatchObject({ storage: 'part scheduling · contained' });
    expect(model.subsystems.some((s) => s.project)).toBe(false);

    const base = tempDir(cleanups, 'wairon-canvas-ref-');
    writeLedger(path.join(base, 'ledger'));
    writeShop(path.join(base, 'shop'), { members: { ledger: '../ledger' } });
    bind(path.join(base, 'shop'));
    const shop = buildCanvasModel();
    // Round 8: a `../` sibling member is composed live like a contained one —
    // its badge says where it is stored, and the edge lands on its component.
    expect(shop.subsystems.find((s) => s.id === 'ledger')).toMatchObject({ project: true, storage: '../ledger' });
    expect(shop.edges).toContainEqual({ from: 'checkout', to: 'ledger::ledger-portal', cross: true, consumption: true });
  });

  it('status prints a part\'s subsystems under their parent, and at a part\'s root one line naming its parent', () => {
    const { root } = writeClinic(path.join(tempDir(cleanups, 'wairon-status-'), 'clinic'));
    bind(root);
    const report = getStatusReport();
    expect(report.failed).toBe(false);
    expect(report.text).toMatch(/\[Subsystem\] scheduling \[part scheduling · contained\]/);
    expect(report.text).not.toMatch(/\[Project\]/);

    const base = path.dirname(root);
    const sibling = path.join(base, 'admin');
    subsystem(sibling, 'Clinic', 'admin');
    fs.writeFileSync(path.join(sibling, '.wai', 'project.yaml'), yaml.dump({ schemaVersion: '1.0.0', partOf: { project: 'clinic', path: '../clinic' } }));
    bind(sibling);
    const alone = getStatusReport();
    expect(alone.failed).toBe(false);
    expect(alone.text).toMatch(/Part of: clinic \(never pinned/);
    expect(alone.text).toMatch(/\[Subsystem\] admin/);
  });

  it('agent topology: a part\'s subsystems share the parent\'s topology — no delegating owner, never a chained project, never backfilled', () => {
    const { root, part } = writeClinic(path.join(tempDir(cleanups, 'wairon-topo-'), 'clinic'));
    bind(root);
    const agents = resolveAgentTopology();
    const owner = agents.find((a) => a.id === 'scheduling-owner');
    expect(owner?.tags).toContain('domain');
    expect(owner?.ownedPaths).toContain('services/scheduling/.wai/specs/scheduling/.index.yaml');
    expect(owner?.description).toMatch(/Stored in the part "scheduling"/);
    expect(agents.some((a) => a.tags.includes('delegate'))).toBe(false);
    expect(agents.find((a) => a.id === 'system-architect')?.dependencies).toContain('scheduling-owner');
    expect(listDirectChainedSubprojects(root)).toEqual([]);
    expect(findChainingSubprojectsMissingConfig(root)).toEqual([]);
    expect(fs.existsSync(path.join(part, '.wai', 'project.yaml'))).toBe(false);
  });
});
