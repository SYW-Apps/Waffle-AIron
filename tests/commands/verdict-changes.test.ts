import { describe, it, expect, afterEach, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { explain } from '../../src/commands/verdict-changes.js';
import { match } from '../../src/migrations/position-reader.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { DoctorOptionsError } from '../../src/utils/errors.js';
import { projectFamily, resolveProjectExports, loadTypeSpecs } from '../../src/core/index.js';
import { buildImportFamily, type ImportFamily } from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// Stage 4, wave B — the upgrade report (`wairon doctor --report
// composed-validation`) and the positional match it shares with the
// positional migration step. The lock records totals only, so the report
// compares totals and classes today's findings by a reason it can compute.
// ---------------------------------------------------------------------------

const cleanups: (() => void)[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0)) {
    try { c(); } catch { /* windows file locks */ }
  }
});

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

/**
 * The import family with what stage 4 changes in it: the top names a type only
 * shared exports by position (`IndexValue`), a type both shared and ui export
 * (`WafflerError`), its own type through its own id (`vocab.report`), and a
 * project it never declared (`ghost::thing`); app reaches shared through an
 * external it never pinned. The top holds a lock taken before stage 4.
 */
function upgradedFamily(): ImportFamily {
  const f = buildImportFamily();
  cleanups.push(() => f.cleanup());
  f.addTopType('ledger-line', [
    { name: 'index', type: 'IndexValue' },
    { name: 'source', type: 'vocab.report' },
    { name: 'origin', type: 'ghost::thing' },
  ]);
  fs.writeFileSync(path.join(f.top, '.wai', 'lock.json'), JSON.stringify({
    stateId: { algorithm: 'gate-v1', digest: 'recorded-before-stage-4' },
    lockedAt: '2026-08-01T00:00:00.000Z',
    lockedBy: { id: 'a reviewer', source: 'os' },
    validatorVersion: '5.1.1-dev.40',
    validationResult: { valid: true, errors: 0, warnings: 3, notices: 1 },
    status: 'ready',
  }, null, 2));
  return f;
}

/** Every file of the family, hashed — the report writes none of them. */
function state(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

describe('the upgrade report — verdict_changes.explain', () => {
  it('puts the lock\'s totals beside today\'s, attributed to the upgrade only when the lock predates stage 4', () => {
    const f = upgradedFamily();
    bind(f.top);
    const report = explain();
    expect(report.projects.map((p) => p.key)).toEqual(['', 'shared', 'ui', 'app']);
    const top = report.projects[0];
    expect(top).toMatchObject({ lockedBy: '5.1.1-dev.40', lockedTotals: '0 error(s), 3 warning(s), 1 notice(s)', predatesStage4: true });
    expect(top.currentTotals).toMatch(/^\d+ error\(s\), \d+ warning\(s\), \d+ notice\(s\)$/);
    // A member never locked has no lock line, and nothing is attributed to the upgrade.
    expect(report.projects[1]).toMatchObject({ key: 'shared', predatesStage4: false });
    expect(report.projects[1].lockedTotals).toBeUndefined();
    // A lock a stage-4 validator took is not the upgrade's.
    const record = JSON.parse(fs.readFileSync(path.join(f.top, '.wai', 'lock.json'), 'utf8'));
    fs.writeFileSync(path.join(f.top, '.wai', 'lock.json'), JSON.stringify({ ...record, validatorVersion: '6.0.0' }));
    bind(f.top);
    expect(explain().projects[0].predatesStage4).toBe(false);
  });

  it('classes today\'s findings: escalated, pinned, positional (with the match and the rewrite), and counts the rest', () => {
    const f = upgradedFamily();
    bind(f.top);
    const report = explain();
    const where = (reason: string): string[] => report.entries.filter((e) => e.reason === reason).map((e) => `${e.project}|${e.code}|${e.specId ?? '-'}`).sort();
    // Escalated: a stage-2 notice that is an error now.
    expect(where('escalated')).toEqual(['|EXTERNAL_UNDECLARED|ledger-line']);
    // Pinned: app's reference into the sibling it declares as an external, judged against its own (missing) pin.
    expect(where('pinned')).toEqual(['app|EXTERNAL_CHECK_UNAVAILABLE|screen-state']);
    // Positional: the bare name only shared supplies, the top's own id used as a
    // prefix, and app's `WafflerError`, which it declares only shared for.
    const positional = report.entries.filter((e) => e.reason === 'positional');
    expect(positional.map((e) => [e.project, e.code, e.resolvedAs, e.rewrite]).sort()).toEqual([
      ['', 'DEPRECATED_REFERENCE_FORM', 'vocab::report', 'vocab.report -> report'],
      ['', 'UNDEFINED_TYPE_REFERENCE', 'shared::index-value', 'members.shared.use: [index-value]'],
      ['app', 'UNDEFINED_TYPE_REFERENCE', 'shared::waffler-error', 'externals.shared.use: [waffler-error]'],
    ]);
    // `WafflerError` keys onto both shared and ui, both declared, both exporting: a person picks — unclassified, counted,
    // and listed with every candidate; `ghost::thing` names a project nobody declares, which is not a positional candidate.
    expect(report.unclassified).toBeGreaterThan(0);
    expect(report.unmatched.map((m) => [m.consumer, m.specId, m.authored, m.kind, [...(m.candidates ?? [])].sort()])).toEqual([
      ['', 'report', 'WafflerError', 'ambiguous', ['shared::waffler-error', 'ui::waffler_error']],
    ]);
  });

  it('every finding of every covered gate is either classed or counted', () => {
    const f = upgradedFamily();
    bind(f.top);
    const report = explain();
    const today = report.projects.reduce((n, p) => n + p.currentTotals.match(/\d+/g)!.map(Number).reduce((a, b) => a + b, 0), 0);
    expect(report.entries.length + report.unclassified).toBe(today);
  });

  it('bound at a member it covers that member, and walks up to the top of the family for the match', () => {
    const f = upgradedFamily();
    bind(f.app);
    const report = explain();
    expect(report.projects.map((p) => p.key)).toEqual(['']);
    expect(report.entries.filter((e) => e.reason === 'positional').map((e) => [e.project, e.resolvedAs, e.rewrite]))
      .toEqual([['', 'shared::waffler-error', 'externals.shared.use: [waffler-error]']]);
  });

  it('`wairon doctor --report composed-validation` prints the report and writes nothing', async () => {
    const f = upgradedFamily();
    bind(f.top);
    const before = state(f.top);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runDoctor({ report: 'composed-validation' });
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('this is not a per-code diff');
    expect(printed).toMatch(/locked by v5\.1\.1-dev\.40: 0 error\(s\), 3 warning\(s\), 1 notice\(s\)/);
    expect(printed).toContain('the lock predates stage 4');
    expect(printed).toContain('members.shared.use: [index-value]');
    expect(printed).toMatch(/\d+ finding\(s\) could not be attributed to stage 4/);
    expect(printed).toContain('Positional matches no rule decides (1)');
    expect(printed).toMatch(/report: "WafflerError" matches shared::waffler-error and ui::waffler_error/);
    expect(printed).toContain('Nothing was written.');
    expect(state(f.top)).toEqual(before);
    await expect(runDoctor({ report: 'composed-validation', fix: true })).rejects.toThrow(DoctorOptionsError);
  });
});

describe('the positional match — position_reader.match', () => {
  /** The top's scan: its graph, every project's table and every type. */
  function scan(f: ImportFamily): Parameters<typeof match> {
    bind(f.top);
    const family = projectFamily();
    const tables = [resolveProjectExports(), ...family.nodes.filter((n) => n.namespace !== '').map((n) => resolveProjectExports(n.namespace))];
    const unresolved = family.authoredReferences.filter((r) => r.form === 'import' && r.binding === 'unresolved');
    return [unresolved, family, tables, loadTypeSpecs()];
  }

  const byName = (matches: ReturnType<typeof match>, consumer: string, authored: string) =>
    matches.find((m) => m.consumer === consumer && m.authored === authored);

  it('only-match, declared-producer and ambiguous — every automatic choice with its reason', () => {
    const f = buildImportFamily();
    cleanups.push(() => f.cleanup());
    f.addTopType('ledger-line', [{ name: 'index', type: 'IndexValue' }]);
    const matches = match(...scan(f));
    // One project has the name: only-match, with its existing public name.
    expect(byName(matches, '', 'IndexValue')).toMatchObject({ kind: 'import', producer: 'shared', target: 'shared::index-value', publicName: 'index-value', reason: 'only-match' });
    // Two do, and app declares only shared: declared-producer.
    expect(byName(matches, 'app', 'WafflerError')).toMatchObject({ kind: 'import', producer: 'shared', target: 'shared::waffler-error', reason: 'declared-producer' });
    // Two do, the top declares both, both export it: a person picks.
    const ambiguous = byName(matches, '', 'WafflerError')!;
    expect(ambiguous.kind).toBe('ambiguous');
    expect(ambiguous.candidates!.sort()).toEqual(['shared::waffler-error', 'ui::waffler_error']);
    expect(ambiguous.reason).toMatch(/a person picks/);
  });

  it('already-exported: several own the name, the declared rule leaves several, and exactly one exports it', () => {
    const f = buildImportFamily();
    cleanups.push(() => f.cleanup());
    // ui also owns an `index-value` it does not export; the top declares both.
    fs.writeFileSync(path.join(f.ui, '.wai', 'specs', 'types', 'index_value.yaml'), [
      'kind: value-object', 'id: index_value', 'name: index_value', 'description: The ui index value', 'fields: []', 'methods: []',
      "createdAt: '2026-09-27T00:00:00.000Z'", "updatedAt: '2026-09-27T00:00:00.000Z'", ''].join('\n'));
    f.addTopType('ledger-line', [{ name: 'index', type: 'IndexValue' }]);
    const found = byName(match(...scan(f)), '', 'IndexValue');
    expect(found).toMatchObject({ kind: 'import', producer: 'shared', reason: 'already-exported' });
  });

  it('none: nothing in the family has the name', () => {
    const f = buildImportFamily();
    cleanups.push(() => f.cleanup());
    f.addTopType('ledger-line', [{ name: 'index', type: 'CompletelyUnheardOf' }]);
    expect(byName(match(...scan(f)), '', 'CompletelyUnheardOf')).toMatchObject({ kind: 'none' });
  });
});
