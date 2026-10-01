import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { writeSpecFile } from '../../src/core/spec-files.js';
import { ComponentSpecSchema, TypeSpecSchema } from '../../src/models/index.js';
import { validateProject, validateFamily, type ValidationResult } from '../../src/core/validation.js';
import { plan, isEmpty } from '../../src/migrations/chaining-migration.js';
import { apply } from '../helpers/chaining-transaction.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { explain } from '../../src/commands/verdict-changes.js';
import { buildImportFamily, type ImportFamily } from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// Stage 4, wave C — the positional migration: the `use` imports, the exports
// and externals they need, the self-prefix rewrites and the pins LAST, over
// the import family (tests/helpers/reference-family.ts) and real temp
// directories; nothing on the path under test is mocked.
//
// What the family holds before the migration, beside the import family's own
// references: the top names `IndexValue` (only shared has it) and its own
// `report` through its own id (`vocab.report`); app names `BannerStyle`, a
// type only ui owns and exports under no name, and `Palette`, a type only ui
// owns — while app has a component `palette` of its own, which would shadow a
// named import. The top's `report` names `WafflerError`, which shared and ui
// both export and the top declares both: a person picks.
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
const STAMP = '2026-09-29T00:00:00.000Z';

/** `wairon doctor …` in a real process with no terminal; resolves whatever its exit code. */
const doctorCli = (cwd: string, ...args: string[]): Promise<{ stdout: string; code: number }> =>
  execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'doctor', ...args], { cwd, timeout: 180_000 })
    .then((r) => ({ stdout: r.stdout, code: 0 }))
    .catch((e: Error & { stdout?: string; code?: number }) => ({ stdout: e.stdout ?? '', code: e.code ?? 1 }));

function at<T>(dir: string, fn: () => T): T {
  invalidateSpecCache();
  setProjectRoot(dir);
  return fn();
}

/** Every file under the family, hashed. */
function dirHash(root: string): Record<string, string> {
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

const typeFile = (dir: string, id: string, fields: { name: string; type: string }[]): void =>
  writeSpecFile(path.join(dir, '.wai', 'specs', 'types', `${id}.yaml`), TypeSpecSchema.parse({
    kind: 'value-object', id, name: id, description: `The ${id} type`,
    fields: fields.map((f) => ({ ...f, description: `The ${f.name}`, optional: false })),
    methods: [], createdAt: STAMP, updatedAt: STAMP,
  }));

/** The import family with what the positional migration is for. */
function positionalFamily(): ImportFamily {
  const f = buildImportFamily();
  f.addTopType('ledger-line', [{ name: 'index', type: 'IndexValue' }, { name: 'source', type: 'vocab.report' }]);
  typeFile(f.ui, 'banner-style', [{ name: 'tone', type: 'string' }]);
  typeFile(f.ui, 'palette', [{ name: 'base', type: 'string' }]);
  typeFile(f.app, 'screen-state', [
    { name: 'error', type: 'WafflerError' }, { name: 'record', type: 'shared::host-record' },
    { name: 'style', type: 'BannerStyle' }, { name: 'colours', type: 'Palette' },
  ]);
  writeSpecFile(path.join(f.app, '.wai', 'specs', 'screens', 'palette', '.index.yaml'), ComponentSpecSchema.parse({
    id: 'palette', name: 'palette', description: 'The app\'s own palette component', subsystem: 'screens', componentType: 'Store',
    owns: [], dependsOn: [], status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
  return f;
}

const configOf = (dir: string): Record<string, unknown> =>
  yaml.load(fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8')) as Record<string, unknown>;

const errorsOf = (res: ValidationResult): string[] =>
  res.issues.filter((i) => i.severity === 'error').map((i) => `${i.project ?? ''}|${i.code}|${i.specId ?? '-'}`).sort();

describe('stage 4 — the positional migration', () => {
  let family: ImportFamily | null = null;
  const fresh = (): ImportFamily => {
    family = positionalFamily();
    return family;
  };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    family?.cleanup();
    family = null;
  });

  it('plans named imports with the reason each producer was chosen, the export and external they need, and the self-prefix rewrite', () => {
    const f = fresh();
    const planned = at(f.app, () => plan());
    const imports = planned.projects.flatMap((p) => p.imports.map((i) => `${p.project}|${i.alias}|${i.name}|${i.reason}|export:${i.exportPlanned}|external:${i.declaresExternal}|${i.references.join(',')}`));
    expect(imports).toEqual([
      '|shared|index-value|only-match|export:false|external:false|ledger-line type IndexValue',
      'app|shared|waffler-error|declared-producer|export:false|external:false|app::screen-state type WafflerError',
      'app|ui|banner-style|only-match|export:true|external:true|app::screen-state type BannerStyle',
    ]);
    // ui gains the export the import names; app declares ui and pins both its externals — shared never was.
    const ui = planned.projects.find((p) => p.project === 'ui')!;
    expect(ui.exports.map((e) => `${e.typeDef}|${e.publicName}|${e.reason}|${e.consumers.join(',')}`)).toEqual(['banner-style|banner-style|positional|app']);
    const app = planned.projects.find((p) => p.project === 'app')!;
    expect(app.externals.map((e) => `${e.alias}|${e.reason}`)).toEqual(['ui|positional']);
    expect(app.pins).toEqual(['shared', 'ui']);
    // The top's own id used as a prefix is rewritten to the bare local id.
    expect(planned.rewrites.map((r) => [r.project, r.specId, r.form, r.from, r.to])).toEqual([['', 'ledger-line', 'self-prefix', 'vocab.report', 'report']]);
    // What no rule decides is reported, never guessed.
    expect(planned.findings.map((x) => x.kind).sort()).toEqual(['import-shadowed', 'positional-ambiguous']);
    const ambiguous = planned.findings.find((x) => x.kind === 'positional-ambiguous')!;
    expect(ambiguous.detail).toContain('shared::waffler-error and ui::waffler_error');
    expect(ambiguous.detail).toContain('a person picks');
    // The upgrade report reads the same match: what it leaves to a person is what the plan leaves.
    expect(at(f.top, () => explain()).unmatched.filter((m) => m.kind === 'ambiguous').map((m) => `${m.consumer}|${m.authored}`)).toEqual(['|WafflerError']);
  });

  it('property: newDependencies lists exactly the edges no external and no pin had before', () => {
    const f = fresh();
    expect(at(f.top, () => plan()).newDependencies).toEqual(['app now depends on ui (1 reference)']);
    // An edge the consumer already declares is no new dependency: declare ui by hand and it goes.
    f.setAppExternals({ shared: {}, ui: {} });
    expect(at(f.top, () => plan()).newDependencies).toEqual([]);
  });

  it('a name no rule decides in one round is decided in the next, by what the plan declares — so a re-run finds nothing left', () => {
    const f = fresh();
    // `Glyph` keys onto the top and ui, neither of which app declares; `BannerStyle` makes the plan declare ui.
    typeFile(f.top, 'glyph', [{ name: 'shape', type: 'string' }]);
    typeFile(f.ui, 'glyph', [{ name: 'shape', type: 'string' }]);
    typeFile(f.app, 'badge', [{ name: 'glyph', type: 'Glyph' }]);
    const planned = at(f.top, () => plan());
    const app = planned.projects.find((p) => p.project === 'app')!;
    expect(app.imports.map((i) => `${i.alias}|${i.name}|${i.reason}`)).toEqual([
      'shared|waffler-error|declared-producer', 'ui|banner-style|only-match', 'ui|glyph|declared-producer',
    ]);
    expect(planned.newDependencies).toEqual(['app now depends on ui (2 references)']);
    at(f.top, () => apply(planned));
    expect(isEmpty(at(f.top, () => plan()))).toBe(true);
  });

  it('a producer the plan\'s own crossings declare is a declared producer for the positional step', () => {
    const f = fresh();
    // app declares nothing, but its `shared::host-record` makes the plan declare shared; so `WafflerError` is shared's.
    fs.writeFileSync(path.join(f.app, '.wai', 'project.yaml'), ['schemaVersion: 1.0.0', 'id: app', 'name: App', 'targets: []',
      `createdAt: '${STAMP}'`, `updatedAt: '${STAMP}'`, ''].join('\n'));
    const planned = at(f.top, () => plan());
    const app = planned.projects.find((p) => p.project === 'app')!;
    expect(app.externals.map((e) => `${e.alias}|${e.reason}`)).toEqual(['shared|reference', 'ui|positional']);
    expect(app.imports.find((i) => i.name === 'waffler-error')).toMatchObject({ alias: 'shared', reason: 'declared-producer' });
    at(f.top, () => apply(planned));
    expect(isEmpty(at(f.top, () => plan()))).toBe(true);
  });

  it('a member that declares no id: its alias used as a prefix is its own id after the fix, so the first plan rewrites it', () => {
    const f = fresh();
    // app answers to "app-screens" until the migration declares the alias its parent gives it, "app".
    fs.writeFileSync(path.join(f.app, '.wai', 'project.yaml'), ['schemaVersion: 1.0.0', 'name: App Screens', 'externals:', '  shared: {}', 'targets: []',
      `createdAt: '${STAMP}'`, `updatedAt: '${STAMP}'`, ''].join('\n'));
    typeFile(f.app, 'panel', [{ name: 'state', type: 'app.screen-state' }]);
    const planned = at(f.top, () => plan());
    expect(planned.projects.find((p) => p.project === 'app-screens')?.idToWrite).toBe('app');
    expect(planned.rewrites.filter((r) => r.form === 'self-prefix').map((r) => [r.from, r.to])).toContainEqual(['app.screen-state', 'screen-state']);
    at(f.top, () => apply(planned));
    expect(fs.readFileSync(path.join(f.app, '.wai', 'specs', 'types', 'panel.yaml'), 'utf8')).toContain('type: screen-state');
    expect(isEmpty(at(f.top, () => plan()))).toBe(true);
  });

  it('property: a named import a local spec would shadow is reported, never written', () => {
    const f = fresh();
    const planned = at(f.top, () => plan());
    const shadowed = planned.findings.find((x) => x.kind === 'import-shadowed')!;
    expect(shadowed).toMatchObject({ project: 'app', blocking: false });
    expect(shadowed.detail).toContain('"palette" from "ui"');
    expect(shadowed.detail).toContain('its own spec "palette"');
    expect(planned.projects.flatMap((p) => p.imports).some((i) => i.name === 'palette')).toBe(false);
    at(f.top, () => apply(planned));
    expect(JSON.stringify(configOf(f.app))).not.toContain('palette');
    // And ui was not made to export it for an import nobody writes.
    const uiL0 = fs.readFileSync(path.join(f.ui, '.wai', 'specs', '.index.yaml'), 'utf8');
    expect(uiL0).not.toContain('palette');
  });

  it('property: two imports supplying one bare name to one consumer are both dropped and reported', () => {
    const f = fresh();
    // app imports `index-value` from ui by name already — ui exports no such name, so app's bare
    // `IndexValue` still resolves to nothing, and the plan would import `index-value` from shared.
    typeFile(f.app, 'gauge', [{ name: 'index', type: 'IndexValue' }]);
    f.setAppExternals({ shared: {}, ui: { use: ['index-value'] } });
    const planned = at(f.top, () => plan());
    const collision = planned.findings.find((x) => x.kind === 'import-collision')!;
    expect(collision.project).toBe('app');
    expect(collision.detail).toContain('"index-value" from "shared"');
    expect(collision.detail).toContain('"index-value" from "ui" (imported already)');
    expect(planned.projects.flatMap((p) => p.imports).some((i) => i.name === 'index-value' && i.consumer === 'app')).toBe(false);
  });

  it('after apply: the imports, exports and externals written, pins last, and the family run clean apart from what a person must decide', () => {
    const f = fresh();
    const before = at(f.top, () => validateFamily({}));
    expect(errorsOf(before).filter((e) => e.includes('UNDEFINED_TYPE_REFERENCE')).length).toBeGreaterThan(2);
    const report = at(f.top, () => apply(plan()));
    const rel = report.written.map((w) => path.relative(f.top, w).split(path.sep).join('/'));
    // Pins are the LAST writes.
    const firstPin = rel.findIndex((w) => /externals(\/|\.lock)/.test(w));
    expect(firstPin).toBeGreaterThan(0);
    expect(rel.slice(firstPin).every((w) => /externals(\/|\.lock)/.test(w))).toBe(true);
    // The named imports, where each consumer declares its producer.
    expect(configOf(f.top).members).toMatchObject({ shared: { path: 'shared', use: ['index-value'] } });
    expect(configOf(f.app).externals).toEqual({ shared: { use: ['waffler-error'] }, ui: { use: ['banner-style'] } });
    // ui exports what app imports; app's pin of ui carries it.
    const uiL0 = yaml.load(fs.readFileSync(path.join(f.ui, '.wai', 'specs', '.index.yaml'), 'utf8')) as { publicInterfaces: { typeDef?: string }[] };
    expect(uiL0.publicInterfaces.map((e) => e.typeDef)).toContain('banner-style');
    expect(fs.readFileSync(path.join(f.app, '.wai', 'externals', 'ui.yaml'), 'utf8')).toContain('banner-style');
    // The self-prefix, bare on disk.
    expect(fs.readFileSync(path.join(f.top, '.wai', 'specs', 'types', 'ledger-line.yaml'), 'utf8')).not.toContain('vocab.report');
    // No positional error is left but the two a person decides, and no deprecated form.
    const after = at(f.top, () => validateFamily({}));
    expect(after.issues.filter((i) => i.code === 'DEPRECATED_REFERENCE_FORM')).toEqual([]);
    expect(errorsOf(after)).toEqual(['app|UNDEFINED_TYPE_REFERENCE|screen-state', '|UNDEFINED_TYPE_REFERENCE|report']);
    // Each owner's gate agrees from its own root.
    expect(errorsOf(at(f.app, () => validateProject()))).toEqual(['|UNDEFINED_TYPE_REFERENCE|screen-state']);
    expect(at(f.app, () => validateProject()).issues.filter((i) => i.code.startsWith('EXTERNAL_'))).toEqual([]);
  });

  it('property: idempotence — the second plan is empty and a second apply writes nothing', () => {
    const f = fresh();
    const first = at(f.top, () => plan());
    at(f.top, () => apply(first));
    const settled = dirHash(f.top);
    for (const root of [f.top, f.shared, f.ui, f.app]) {
      const again = at(root, () => plan());
      expect(isEmpty(again)).toBe(true);
      expect(again.newDependencies).toEqual([]);
      // Only what a person must decide is still reported.
      expect(again.findings.map((x) => x.kind).sort()).toEqual(['import-shadowed', 'positional-ambiguous']);
    }
    const second = at(f.top, () => plan());
    expect(at(f.top, () => apply(second))).toEqual({ plan: second, applied: false, written: [], relock: [] });
    expect(at(f.top, () => apply(first)).written).toEqual([]);
    expect(dirHash(f.top)).toEqual(settled);
  });

  it('property: migration-is-plan-first — the reports, the plan and an unconfirmed --fix write nothing', async () => {
    const f = fresh();
    const before = dirHash(f.top);
    at(f.top, () => plan());
    await runDoctor({ report: 'chaining' });
    await runDoctor({ report: 'composed-validation' });
    const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('app now depends on ui (1 reference)');
    expect(printed).toContain('use: ui: [banner-style]');
    expect(printed).toContain('positional-ambiguous');
    expect(printed).toContain('Positional matches no rule decides');
    expect(dirHash(f.top)).toEqual(before);
    const unconfirmed = await doctorCli(f.top, '--fix');
    expect(unconfirmed.stdout).toContain('Chaining migration skipped: no terminal to confirm it');
    const after = dirHash(f.top);
    const touched = Object.keys(after).filter((k) => after[k] !== before[k] && /[\\/]?\.wai[\\/](specs|project\.yaml|externals|surfaces)/.test(k));
    expect(touched).toEqual([]);
  }, 240_000);
});
