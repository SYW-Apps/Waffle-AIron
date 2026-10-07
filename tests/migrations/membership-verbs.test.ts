import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runWithProjectBinding, setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { writeSpecFile } from '../../src/core/spec-files.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { validateProject } from '../../src/core/validation.js';
import { readYamlFile } from '../../src/utils/yaml.js';
import { SubsystemSpecSchema, SystemSpecSchema } from '../../src/models/index.js';
import * as migrations from '../../src/migrations/index.js';
import { buildContractFamily, buildReferenceFamily, type ContractFamily } from '../helpers/reference-family.js';
import { at, dirHash, familyFindings, familyLines, migrate, newFindings, pinAt, plan, put, waiState, widen } from '../helpers/family-verbs.js';

// ---------------------------------------------------------------------------
// Stage 6 wave B — the membership verbs (attach, detach, adopt) through the
// migration portal, on the contract family (house ⊃ ledger, billing; billing
// consumes ledger's portal through an `externals` entry, pinned). Real temp
// directories; nothing mocked on the path under test.
//
// Properties: family-consistent (after each verb the family run carries no
// finding it did not carry before), detach-then-adopt-is-identity (the member
// byte-identical, the parent and every other project semantically
// identical), idempotence (a completed verb re-plans empty), and every
// refusal writing nothing (the whole directory hashed).
// ---------------------------------------------------------------------------

const STAMP = '2026-09-30T00:00:00.000Z';

/** A standalone project at a directory: its config (id optional), an L0 and one subsystem. */
function standalone(dir: string, name: string, id?: string): void {
  put(path.join(dir, '.wai', 'project.yaml'), [
    'schemaVersion: 1.0.0', ...(id ? [`id: ${id}`] : []), `name: ${name}`, 'targets: []', `createdAt: '${STAMP}'`, `updatedAt: '${STAMP}'`, '',
  ].join('\n'));
  writeSpecFile(path.join(dir, '.wai', 'specs', '.index.yaml'), SystemSpecSchema.parse({
    schemaVersion: '1.0.0', name, vision: `${name}, standalone`, boundaries: [], globalRequirements: [], createdAt: STAMP, updatedAt: STAMP,
  }));
  writeSpecFile(path.join(dir, '.wai', 'specs', 'tooling', '.index.yaml'), SubsystemSpecSchema.parse({
    id: 'tooling', name: 'tooling', description: 'Its own subsystem', parentSystem: name, publicInterfaces: [], trustedLinks: [],
    status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
}

/** A project's configuration as written. */
const configOf = (dir: string): Record<string, unknown> => readYamlFile(path.join(dir, '.wai', 'project.yaml')) as Record<string, unknown>;
/** A project's pinned externals, alias → {project, digest}. */
const pinsOf = (dir: string): Record<string, { project: string; digest: string }> => {
  const file = path.join(dir, '.wai', 'externals.lock.yaml');
  const lock = fs.existsSync(file) ? (readYamlFile(file) as { externals?: Record<string, { project: string; digest: string }> }) : {};
  return Object.fromEntries(Object.entries(lock.externals ?? {}).map(([a, e]) => [a, { project: e.project, digest: e.digest }]));
};

describe('stage 6 — the membership verbs', () => {
  const made: ContractFamily[] = [];
  /** The contract family, billing pinned, and ledger's export widened to the instance audience — the design decision a detach needs made first. */
  const family = (): ContractFamily => {
    const f = buildContractFamily();
    made.push(f);
    widen(f.ledger);
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

  // ── attach ────────────────────────────────────────────────────────────────

  it('attach: an existing project becomes a member — its L0, subsystems and specs untouched, its defaulted id declared; family-consistent; idempotent', () => {
    const f = family();
    const tools = path.join(f.top, 'tools');
    standalone(tools, 'Tools');
    const specsBefore = Object.fromEntries(Object.entries(waiState(tools)).filter(([k]) => k.includes('/specs/')));
    const findingsBefore = familyFindings(f.top);
    const report = migrate(f.top, { verb: 'attach', alias: 'tools', path: 'tools', description: 'The build tools' });
    expect(report.applied).toBe(true);
    expect(report.plan.edits.map((e) => `${e.project}|${e.kind}|${e.detail}`)).toEqual([
      'tools|id|id: tools (declared)',
      '|member|members: tools → tools (an existing project, kept as it is)',
    ]);
    expect(configOf(f.top).members).toEqual({ ledger: 'ledger', billing: 'billing', tools: { source: 'tools', description: 'The build tools' } });
    expect(configOf(tools).id).toBe('tools');
    // Its own specs are byte-identical: attach keeps what it has (member add would scaffold).
    expect(Object.fromEntries(Object.entries(waiState(tools)).filter(([k]) => k.includes('/specs/')))).toEqual(specsBefore);
    // The attached project comes with its own state (never locked: MEMBER_UNAPPROVED names it); nothing else is new.
    const itsOwn = (i: { project?: string; message: string }): boolean => i.project === 'tools' || /"tools"/.test(i.message);
    expect(newFindings(findingsBefore, familyFindings(f.top, itsOwn)), familyLines(f.top).join('\n')).toEqual([]);
    // Idempotent: the completed attach re-plans nothing.
    const again = plan(f.top, { verb: 'attach', alias: 'tools', path: 'tools' });
    expect([again.refusals, again.changes]).toEqual([[], []]);
  });

  it('attach keeps the id a lock approved over the effective one, and lists the attached project to re-lock', () => {
    const f = family();
    const tools = path.join(f.top, 'tools');
    standalone(tools, 'Build Tools');
    put(path.join(tools, '.wai', 'lock.json'), JSON.stringify({ stateId: { algorithm: 'sha256', digest: '0' }, lockedAt: STAMP, lockedBy: { id: 't', source: 'git' }, validatorVersion: '0', validationResult: { valid: true, errors: 0, warnings: 0, notices: 0 }, status: 'ready', projectId: 'tooling-kit' }));
    const report = migrate(f.top, { verb: 'attach', alias: 'tools', path: 'tools' });
    expect(configOf(tools).id).toBe('tooling-kit');
    expect(report.relock).toEqual([path.resolve(tools)]);
  });

  it('attach refuses — each writing nothing: not-contained, alias-taken, already-member (a family project, or an external naming the directory), not-a-project, id-collision', () => {
    const f = family();
    const outside = fs.mkdtempSync(path.join(path.dirname(f.top), 'wairon-outside-'));
    standalone(path.join(f.top, 'ledger-copy'), 'Ledger Copy', 'ledger');
    fs.mkdirSync(path.join(f.top, 'empty'));
    standalone(path.join(f.top, 'crm'), 'Crm', 'crm');
    standalone(path.join(f.top, 'fresh'), 'Fresh', 'fresh');
    projectConfigRepositoryAt(f.top).declareExternal('crm', { source: { path: 'crm' } });
    const cases: [Record<string, string>, string][] = [
      [{ alias: 'x', path: path.relative(f.top, outside) }, 'not-contained'],
      [{ alias: 'billing', path: 'fresh' }, 'alias-taken'],
      // A malformed alias is alias-invalid, as rename-alias names it — never alias-taken.
      [{ alias: 'Bad Alias', path: 'fresh' }, 'alias-invalid'],
      [{ alias: 'again', path: 'ledger' }, 'already-member'],
      [{ alias: 'crm2', path: 'crm' }, 'already-member'],
      [{ alias: 'nothing', path: 'empty' }, 'not-a-project'],
      [{ alias: 'copy', path: 'ledger-copy' }, 'id-collision'],
    ];
    try {
      for (const [args, code] of cases) {
        const before = dirHash(f.top);
        const planned = plan(f.top, { verb: 'attach', alias: args.alias, path: args.path });
        expect(planned.refusals.map((r) => r.code), JSON.stringify(args)).toEqual([code]);
        expect(at(f.top, () => migrations.apply(planned)).applied).toBe(false);
        expect(dirHash(f.top), code).toEqual(before);
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // ── detach / adopt ────────────────────────────────────────────────────────

  it('detach --widen: exactly the used family-only exports widened to instance in the member\'s L0, shown in the plan; consumers\' own gates clean; idempotent', () => {
    const f = buildContractFamily();
    made.push(f);
    pinAt(f.billing);
    // An export nobody uses stays exactly as it is: --widen never widens what the family does not use.
    const l0 = path.join(f.ledger, '.wai', 'specs', '.index.yaml');
    fs.writeFileSync(l0, fs.readFileSync(l0, 'utf8').replace(
      'publicInterfaces:\n',
      'publicInterfaces:\n  - from: books\n    component: ledger-portal\n    as: ledger-archive\n    audience: project\n',
    ));
    invalidateSpecCache();
    const planned = plan(f.top, { verb: 'detach', alias: 'ledger', widen: true });
    expect(planned.refusals).toEqual([]);
    expect(planned.edits.filter((e) => e.kind === 'export').map((e) => `${e.project}|${e.detail}`)).toEqual(['ledger|widen ledger-portal project→instance (used by "billing")']);
    expect(at(f.top, () => migrations.apply(planned)).applied).toBe(true);
    const entries = (readYamlFile(l0) as { publicInterfaces: { as?: string; component: string; audience: string }[] }).publicInterfaces;
    expect(entries.map((e) => `${e.as ?? e.component}:${e.audience}`).sort()).toEqual(['ledger-archive:project', 'ledger-portal:instance']);
    // Detached, the parent and billing reach ledger by path and their own gates are clean.
    expect(configOf(f.top).externals).toEqual({ ledger: { source: { path: 'ledger' } } });
    for (const dir of [f.top, f.billing]) {
      expect(at(dir, () => validateProject()).issues.filter((i) => i.code.startsWith('EXTERNAL_')).map((i) => i.code), dir).toEqual([]);
    }
    // Idempotent: the completed detach --widen re-plans nothing.
    const again = plan(f.top, { verb: 'detach', alias: 'ledger', widen: true });
    expect([again.refusals, again.changes]).toEqual([[], []]);
  });

  it('detach: the member leaves the family; the parent and every family consumer reach it by path, the parent pinned last; family-consistent; idempotent', () => {
    const f = family();
    const before = familyFindings(f.top);
    const billingPin = pinsOf(f.billing).ledger;
    const report = migrate(f.top, { verb: 'detach', alias: 'ledger' });
    expect(report.applied).toBe(true);
    expect(configOf(f.top).members).toEqual({ billing: 'billing' });
    expect(configOf(f.top).externals).toEqual({ ledger: { source: { path: 'ledger' } } });
    expect(configOf(f.billing).externals).toEqual({ ledger: { source: { path: '../ledger' } } });
    // The parent pinned the detached project; billing's pin is untouched (the producer did not change).
    expect(Object.keys(pinsOf(f.top))).toEqual(['ledger']);
    expect(pinsOf(f.billing).ledger).toEqual(billingPin);
    expect(report.plan.notes.some((n) => /Consumers outside the family/.test(n))).toBe(true);
    // No reference text changed.
    expect(report.plan.edits.some((e) => e.kind === 'reference')).toBe(false);
    // Ledger is outside the family now; since stage 8 every producer is compared per use against its pin,
    // so nothing new is found — and each consumer's own gate judges it against its pin, and is clean.
    expect(newFindings(before, familyFindings(f.top)), familyLines(f.top).join('\n')).toEqual([]);
    for (const dir of [f.top, f.billing]) {
      expect(at(dir, () => validateProject()).issues.filter((i) => i.code.startsWith('EXTERNAL_')).map((i) => i.code), dir).toEqual([]);
    }
    const again = plan(f.top, { verb: 'detach', alias: 'ledger' });
    expect([again.refusals, again.changes]).toEqual([[], []]);
  });

  it('property: detach-then-adopt-is-identity — the member byte-identical, the parent and its sibling semantically identical', () => {
    const f = family();
    const memberBytes = waiState(f.ledger);
    const parentConfig = projectConfigRepositoryAt(f.top).load();
    const siblingConfig = projectConfigRepositoryAt(f.billing).load();
    const parentPins = pinsOf(f.top);
    const siblingPins = pinsOf(f.billing);
    migrate(f.top, { verb: 'detach', alias: 'ledger' });
    const adopted = migrate(f.top, { verb: 'adopt', alias: 'ledger' });
    expect(adopted.applied).toBe(true);
    expect(waiState(f.ledger)).toEqual(memberBytes);
    expect(projectConfigRepositoryAt(f.top).load()).toEqual(parentConfig);
    expect(projectConfigRepositoryAt(f.billing).load()).toEqual(siblingConfig);
    expect(pinsOf(f.top)).toEqual(parentPins);
    expect(pinsOf(f.billing)).toEqual(siblingPins);
    // Idempotent: the completed adopt re-plans nothing.
    const again = plan(f.top, { verb: 'adopt', alias: 'ledger' });
    expect([again.refusals, again.changes]).toEqual([[], []]);
  });

  it('detach refuses — each writing nothing: audience-too-narrow, not-a-member, member-absent, family-partial', () => {
    // A family consumer using a name the member exports to the family alone would stop resolving outside it.
    const narrow = buildContractFamily();
    made.push(narrow);
    const untouched = dirHash(narrow.top);
    const refusal = plan(narrow.top, { verb: 'detach', alias: 'ledger' }).refusals;
    // One refusal per export, naming every project that uses it and the audience it needs.
    expect(refusal.map((r) => `${r.code} ${r.project}`)).toEqual(['audience-too-narrow ledger']);
    expect(refusal[0].detail).toContain('"ledger-portal"');
    expect(refusal[0].detail).toContain('"billing" uses it');
    expect(refusal[0].detail).toContain('needs audience "instance"');
    expect(dirHash(narrow.top)).toEqual(untouched);
    const f = family();
    const cases: [() => ReturnType<typeof plan>, string][] = [
      [() => plan(f.top, { verb: 'detach', alias: 'ghost' }), 'not-a-member'],
      [() => runWithProjectBinding(f.billing, { topRoot: f.billing, parentReach: false }, () => { invalidateSpecCache(); return migrations.plan({ verb: 'detach', alias: 'nothing' }); }), 'not-a-member'],
    ];
    for (const [run, code] of cases) {
      const before = dirHash(f.top);
      expect(run().refusals.map((r) => r.code)).toContain(code);
      expect(dirHash(f.top)).toEqual(before);
    }
    // A member whose directory is gone.
    fs.renameSync(f.ledger, `${f.ledger}-away`);
    try {
      const before = dirHash(f.top);
      expect(plan(f.top, { verb: 'detach', alias: 'ledger' }).refusals.map((r) => r.code)).toEqual(['member-absent']);
      expect(dirHash(f.top)).toEqual(before);
    } finally {
      fs.renameSync(`${f.ledger}-away`, f.ledger);
    }
    // A request that may not read the family's top: a consumer could live there.
    standalone(path.join(f.billing, 'sub'), 'Sub', 'sub');
    projectConfigRepositoryAt(f.billing).declareMember('sub', { path: 'sub' });
    const partial = runWithProjectBinding(f.billing, { topRoot: f.billing, parentReach: false }, () => {
      invalidateSpecCache();
      return migrations.plan({ verb: 'detach', alias: 'sub' });
    });
    expect(partial.whole).toBe(false);
    expect(partial.refusals.map((r) => r.code)).toEqual(expect.arrayContaining(['family-partial']));
  });

  it('adopt refuses — each writing nothing: not-an-external, not-contained (no source path, or one outside), not-a-project, already-member, id-collision', () => {
    const f = family();
    const repo = projectConfigRepositoryAt(f.top);
    fs.mkdirSync(path.join(f.top, 'empty'));
    standalone(path.join(f.top, 'twin'), 'Twin', 'billing');
    repo.declareExternal('nopath', { project: 'crm' });
    repo.declareExternal('outside', { source: { path: '../elsewhere' } });
    repo.declareExternal('hollow', { source: { path: 'empty' } });
    repo.declareExternal('member', { project: 'ledger', source: { path: 'ledger' } });
    repo.declareExternal('twin', { project: 'billing', source: { path: 'twin' } });
    const cases: [string, string][] = [
      ['ghost', 'not-an-external'],
      ['nopath', 'not-contained'],
      ['outside', 'not-contained'],
      ['hollow', 'not-a-project'],
      ['member', 'already-member'],
      ['twin', 'id-collision'],
    ];
    for (const [alias, code] of cases) {
      const before = dirHash(f.top);
      expect(plan(f.top, { verb: 'adopt', alias }).refusals.map((r) => r.code), alias).toEqual([code]);
      expect(dirHash(f.top), alias).toEqual(before);
    }
  });
});

describe('stage 6 — detach and adopt on the reference family (canonicalized by the chaining migration)', () => {
  it('core — with a member of its own and consumers on both sides — detaches and is adopted back: its specs and its own member byte-identical, every configuration semantically identical', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const r = buildReferenceFamily();
    try {
      migrate(r.top, { verb: 'chaining' });
      widen(r.core);
      // core names shared (a sibling) through the family, so detach writes it: its configuration comes back
      // semantically identical (a first write materializes the schema's defaults, as every save does);
      // everything else of it — its specs, and its own member transpiler, which leaves with it — byte for byte.
      const untouched = (): Record<string, string> => Object.fromEntries(Object.entries(waiState(r.core)).filter(([k]) => k !== '.wai/project.yaml'));
      const coreBytes = untouched();
      const configs = [r.top, r.core, r.shared, r.transpiler].map((d) => projectConfigRepositoryAt(d).load());
      const before = familyFindings(r.top);
      expect(migrate(r.top, { verb: 'detach', alias: 'core' }).applied).toBe(true);
      expect(newFindings(before, familyFindings(r.top)), familyLines(r.top).join('\n')).toEqual([]);
      expect(migrate(r.top, { verb: 'adopt', alias: 'core' }).applied).toBe(true);
      expect(untouched()).toEqual(coreBytes);
      expect([r.top, r.core, r.shared, r.transpiler].map((d) => projectConfigRepositoryAt(d).load())).toEqual(configs);
      expect(familyFindings(r.top)).toEqual(before);
    } finally {
      vi.restoreAllMocks();
      setProjectRoot(null);
      invalidateSpecCache();
      r.cleanup();
    }
  });
});
