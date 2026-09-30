import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { runWithProjectBinding, setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { validateAsComplete, validateProject, computeGateStateId } from '../../src/core/validation.js';
import { projectFamilyGraph } from '../../src/core/project-family.js';
import { runLock } from '../../src/commands/lock.js';
import { readYamlFile } from '../../src/utils/yaml.js';
import * as migrations from '../../src/migrations/index.js';
import { buildContractFamily, buildReferenceFamily, type ContractFamily } from '../helpers/reference-family.js';
import { at, dirHash, familyFindings, familyLines, migrate, newFindings, pinAt, plan, waiState } from '../helpers/family-verbs.js';

// ---------------------------------------------------------------------------
// Stage 6 wave B — the identity verbs (project rename, alias rename) through
// the migration portal, on the contract family (house ⊃ ledger, billing;
// billing consumes ledger through `externals: { ledger: {} }`, pinned) and on
// stage 2c's fleet (a member whose lock approved a defaulted id). Real temp
// directories; nothing mocked on the path under test.
//
// Properties: rename-reaches-every-reference (no alias, external, reference,
// L0 re-export or pin names the old id afterwards, and the re-lock the rename
// asks for succeeds — PROJECT_ID_RENAMED before it, nothing after), family-
// consistent, alias-rename touches no sibling, idempotence, and every refusal
// writing nothing (the whole directory hashed).
// ---------------------------------------------------------------------------

/** A project's configuration as written. */
const configOf = (dir: string): Record<string, unknown> => readYamlFile(path.join(dir, '.wai', 'project.yaml')) as Record<string, unknown>;
/** A project's pinned externals, alias → {project, digest}. */
const pinsOf = (dir: string): Record<string, { project: string; digest: string }> => {
  const file = path.join(dir, '.wai', 'externals.lock.yaml');
  const lock = fs.existsSync(file) ? (readYamlFile(file) as { externals?: Record<string, { project: string; digest: string }> }) : {};
  return Object.fromEntries(Object.entries(lock.externals ?? {}).map(([a, e]) => [a, { project: e.project, digest: e.digest }]));
};
/** The codes a result carries, each once per occurrence. */
const codesOf = (issues: { code: string }[], ...codes: string[]): string[] => issues.map((i) => i.code).filter((c) => codes.includes(c));

/** Lock a project at its own root, gated as `wairon lock` gates it. */
async function lockAt(dir: string): Promise<string | undefined> {
  invalidateSpecCache();
  setProjectRoot(dir);
  const config = projectConfigRepositoryAt(dir).load();
  const gate = validateAsComplete({ rules: config?.rules, projectType: config?.projectType });
  return (await runLock({ yes: true }, gate, computeGateStateId()))?.projectId;
}

/** Every text file under the family's .wai trees. */
function waiTexts(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of Object.keys(waiState(root))) if (!rel.endsWith('/')) out.set(rel, fs.readFileSync(path.join(root, rel), 'utf8'));
  return out;
}

describe('stage 6 — the identity verbs', () => {
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

  it('property: rename-reaches-every-reference — no alias, external, reference or pin names the old id; family-consistent; the re-lock succeeds, PROJECT_ID_RENAMED before it', async () => {
    const f = family();
    expect(await lockAt(f.ledger)).toBe('ledger');
    const before = familyFindings(f.top);
    const billingDigest = pinsOf(f.billing).ledger.digest;
    const report = migrate(f.top, { verb: 'rename', project: 'ledger', newId: 'books-ledger' });
    expect(report.applied).toBe(true);
    // Every project written is listed to re-lock, the renamed one first.
    expect(report.relock).toEqual([path.resolve(f.ledger), path.resolve(f.top), path.resolve(f.billing)]);
    // The id moved, the old one kept.
    expect(configOf(f.ledger)).toMatchObject({ id: 'books-ledger', previousIds: ['ledger'] });
    // The aliases that were the id followed it, their references with them; the pin moved, digest kept.
    expect(configOf(f.top).members).toEqual({ 'books-ledger': 'ledger', billing: 'billing' });
    expect(configOf(f.billing).externals).toEqual({ 'books-ledger': {} });
    expect(pinsOf(f.billing)).toEqual({ 'books-ledger': { project: 'books-ledger', digest: billingDigest } });
    // No text anywhere in the family's .wai trees names the old id as a reference, an alias or a producer.
    for (const [rel, text] of waiTexts(f.top)) {
      if (rel.startsWith('ledger/.wai/project.yaml')) continue; // previousIds keeps it, deliberately
      expect(text, rel).not.toMatch(/(^|[^\w-])ledger::/m);
      expect(text, rel).not.toMatch(/^\s*ledger:\s/m);
      expect(text, rel).not.toMatch(/project:\s*'?ledger'?\s*$/m);
    }
    const graph = at(f.top, () => projectFamilyGraph());
    expect(graph.authoredReferences.filter((r) => r.authored.startsWith('ledger::'))).toEqual([]);
    expect(graph.nodes.flatMap((n) => [...n.aliases.keys()])).not.toContain('ledger');
    expect(newFindings(before, familyFindings(f.top)), familyLines(f.top).join('\n')).toEqual([]);
    // The re-lock the rename asks for: PROJECT_ID_RENAMED (a notice) before it, never PROJECT_ID_CHANGED.
    const gate = at(f.ledger, () => validateProject());
    expect(codesOf(gate.issues, 'PROJECT_ID_RENAMED', 'PROJECT_ID_CHANGED')).toEqual(['PROJECT_ID_RENAMED']);
    expect(await lockAt(f.ledger)).toBe('books-ledger');
    expect(codesOf(at(f.ledger, () => validateProject()).issues, 'PROJECT_ID_RENAMED', 'PROJECT_ID_CHANGED')).toEqual([]);
    // Idempotent: the completed rename re-plans nothing.
    const again = plan(f.top, { verb: 'rename', project: 'books-ledger', newId: 'books-ledger' });
    expect([again.refusals, again.changes]).toEqual([[], []]);
  });

  it('a rename whose new id does not fit an alias keeps the aliases and repoints each external at the new id', () => {
    const f = family();
    const report = migrate(f.top, { verb: 'rename', project: 'ledger', newId: 'acme.ledger' });
    expect(report.applied).toBe(true);
    expect(configOf(f.top).members).toEqual({ ledger: 'ledger', billing: 'billing' });
    expect(configOf(f.billing).externals).toEqual({ ledger: { project: 'acme.ledger' } });
    expect(pinsOf(f.billing).ledger.project).toBe('acme.ledger');
    expect(at(f.billing, () => validateProject()).issues.filter((i) => i.code.startsWith('EXTERNAL_')).map((i) => i.code)).toEqual([]);
  });

  it('rename refuses — each writing nothing: not-a-member, member-absent, id-collision (taken or malformed), family-partial', () => {
    const f = family();
    const cases: [() => ReturnType<typeof plan>, string][] = [
      [() => plan(f.top, { verb: 'rename', project: 'ghost', newId: 'spirit' }), 'not-a-member'],
      [() => plan(f.top, { verb: 'rename', project: 'ledger', newId: 'billing' }), 'id-collision'],
      [() => plan(f.top, { verb: 'rename', project: 'ledger', newId: 'Not An Id' }), 'id-collision'],
      [() => runWithProjectBinding(f.billing, { topRoot: f.billing, parentReach: false }, () => { invalidateSpecCache(); return migrations.plan({ verb: 'rename', newId: 'invoices' }); }), 'family-partial'],
    ];
    for (const [run, code] of cases) {
      const before = dirHash(f.top);
      expect(run().refusals.map((r) => r.code)).toEqual([code]);
      expect(dirHash(f.top), code).toEqual(before);
    }
    fs.renameSync(f.ledger, `${f.ledger}-away`);
    try {
      const before = dirHash(f.top);
      expect(plan(f.top, { verb: 'rename', project: 'ledger', newId: 'x' }).refusals.map((r) => r.code)).toEqual(['member-absent']);
      expect(dirHash(f.top)).toEqual(before);
    } finally {
      fs.renameSync(`${f.ledger}-away`, f.ledger);
    }
    // A project with no id at all has nothing to move (id-moved).
    f.setConfig(f.ledger, ['name: 請求']);
    invalidateSpecCache();
    const before = dirHash(f.top);
    expect(plan(f.top, { verb: 'rename', project: 'ledger', newId: 'invoices' }).refusals.map((r) => r.code)).toEqual(['id-moved']);
    expect(dirHash(f.top)).toEqual(before);
  });

  it('rename-reaches-every-reference on the reference family, once the chaining migration canonicalized it: every project naming core follows; family-consistent', () => {
    const r = buildReferenceFamily();
    try {
      migrate(r.top, { verb: 'chaining' });
      const before = familyFindings(r.top);
      const report = migrate(r.top, { verb: 'rename', project: 'core', newId: 'engine-room' });
      expect(report.applied).toBe(true);
      const graph = at(r.top, () => projectFamilyGraph());
      expect(graph.authoredReferences.filter((x) => /(^|::)core::/.test(x.authored)).map((x) => `${x.specId} ${x.authored}`)).toEqual([]);
      expect(graph.nodes.flatMap((n) => [...n.aliases.keys()])).not.toContain('core');
      expect(newFindings(before, familyFindings(r.top)), familyLines(r.top).join('\n')).toEqual([]);
    } finally {
      r.cleanup();
    }
  });

  it('rename refuses reference-unwritable — writing nothing — when a deprecated member path runs through the alias that must follow the id', () => {
    const r = buildReferenceFamily();
    try {
      const before = dirHash(r.top);
      // transpiler writes `core::transpiler::lowering-portal`, a member path read from the top through its alias `core`.
      const planned = plan(r.top, { verb: 'rename', project: 'core', newId: 'engine-room' });
      expect(planned.refusals.map((x) => x.code)).toContain('reference-unwritable');
      expect(planned.refusals.find((x) => x.code === 'reference-unwritable')!.detail).toContain('core::transpiler::lowering-portal');
      expect(at(r.top, () => migrations.apply(planned)).applied).toBe(false);
      expect(dirHash(r.top)).toEqual(before);
    } finally {
      r.cleanup();
    }
  });

  it('rename-alias: the bound project alone — its alias rekeyed in place, its references respelled, its pin carried; no member or sibling changes', () => {
    const f = family();
    const before = familyFindings(f.top);
    const untouched = Object.fromEntries(Object.entries(waiState(f.top)).filter(([k]) => !k.startsWith('billing/')));
    const digest = pinsOf(f.billing).ledger.digest;
    const report = migrate(f.billing, { verb: 'rename-alias', alias: 'ledger', newAlias: 'books' });
    expect(report.applied).toBe(true);
    // The alias was the producer id: the external keeps naming ledger explicitly.
    expect(configOf(f.billing).externals).toEqual({ books: { project: 'ledger' } });
    expect(pinsOf(f.billing)).toEqual({ books: { project: 'ledger', digest } });
    const component = fs.readFileSync(path.join(f.billing, '.wai', 'specs', 'invoicing', 'invoice-poster', '.index.yaml'), 'utf8');
    expect(component).toContain('books::ledger-portal');
    expect(component).not.toContain('ledger::ledger-portal');
    // alias-rename-touches-no-sibling: every byte outside billing is as it was.
    expect(Object.fromEntries(Object.entries(waiState(f.top)).filter(([k]) => !k.startsWith('billing/')))).toEqual(untouched);
    expect(report.relock).toEqual([]);
    expect(newFindings(before, familyFindings(f.top)), familyLines(f.top).join('\n')).toEqual([]);
    const again = plan(f.billing, { verb: 'rename-alias', alias: 'ledger', newAlias: 'books' });
    expect([again.refusals, again.changes]).toEqual([[], []]);
  });

  it('rename-alias of a member keeps its place in `members`, with every comment of project.yaml', () => {
    const f = family();
    const file = path.join(f.top, '.wai', 'project.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('members:', '# the family\nmembers:'));
    migrate(f.top, { verb: 'rename-alias', alias: 'ledger', newAlias: 'books' });
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('# the family\nmembers:\n  books: ledger\n  billing: billing');
  });

  it('rename-alias refuses — each writing nothing: not-a-member, alias-taken (declared, or malformed)', () => {
    const f = family();
    for (const [alias, newAlias, code] of [['ghost', 'spirit', 'not-a-member'], ['ledger', 'billing', 'alias-taken'], ['ledger', 'Not An Alias', 'alias-taken']]) {
      const before = dirHash(f.top);
      expect(plan(f.top, { verb: 'rename-alias', alias, newAlias }).refusals.map((r) => r.code), code).toEqual([code]);
      expect(dirHash(f.top), code).toEqual(before);
    }
  });
});

// ── stage 3's id-locked case, unblocked ─────────────────────────────────────

const TS = '2026-01-01T00:00:00.000Z';
const dump = (spec: Record<string, unknown>): string => yaml.dump({ schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS, ...spec }, { noRefs: true, lineWidth: 200 });
function write(root: string, rel: string, text: string): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const projectYaml = (name: string): string => dump({ name, targets: [], rules: {}, extensions: { packs: [], useGlobalPacks: false } });

/** Stage 2c's fleet in miniature: a parent mounting billing (defaulted id `billing-service`), which a lock approved under that id. */
function fleet(): { root: string; billing: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-idlock-'));
  write(root, '.wai/project.yaml', projectYaml('FleetWorks'));
  write(root, '.wai/specs/.index.yaml', dump({ name: 'FleetWorks', vision: 'Delivery fleet platform.' }));
  write(root, '.wai/specs/subsystems/operations.yaml', dump({ id: 'operations', name: 'Operations', description: 'The console.', parentSystem: 'FleetWorks' }));
  write(root, '.wai/specs/subsystems/billing.yaml', dump({ id: 'billing', name: 'Billing', description: 'Chained billing member.', parentSystem: 'FleetWorks', projectPath: 'packages/billing' }));
  const b = 'packages/billing/.wai';
  write(root, `${b}/project.yaml`, projectYaml('Billing Service'));
  write(root, `${b}/specs/.index.yaml`, dump({ name: 'BillingService', vision: 'Invoices.' }));
  write(root, `${b}/specs/subsystems/invoicing.yaml`, dump({ id: 'invoicing', name: 'Invoicing', description: 'Invoicing.', parentSystem: 'BillingService' }));
  invalidateSpecCache();
  return { root, billing: path.join(root, 'packages', 'billing') };
}

describe("stage 6 — a rename unblocks stage 3's id-locked member", () => {
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

  it('the member kept the id its lock approved (id-locked); renaming it to its alias, then re-locking, succeeds', async () => {
    const f = fleet();
    roots.push(f.root);
    expect(await lockAt(f.billing)).toBe('billing-service');
    migrate(f.root, { verb: 'chaining' });
    expect(configOf(f.billing).id).toBe('billing-service');
    const planned = plan(f.root, { verb: 'rename', project: 'billing', newId: 'billing' });
    expect(planned.refusals).toEqual([]);
    expect(planned.notes.some((n) => /id-locked/.test(n))).toBe(true);
    expect(at(f.root, () => migrations.apply(planned)).applied).toBe(true);
    expect(configOf(f.billing)).toMatchObject({ id: 'billing', previousIds: ['billing-service'] });
    const gate = at(f.billing, () => validateAsComplete());
    expect(codesOf(gate.issues, 'PROJECT_ID_RENAMED', 'PROJECT_ID_CHANGED')).toEqual(['PROJECT_ID_RENAMED']);
    expect(await lockAt(f.billing)).toBe('billing');
    expect(codesOf(at(f.billing, () => validateProject()).issues, 'PROJECT_ID_RENAMED', 'PROJECT_ID_CHANGED')).toEqual([]);
  });
});
