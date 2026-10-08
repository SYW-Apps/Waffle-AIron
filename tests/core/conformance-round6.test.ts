import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { validateProject, type ValidationIssue } from '../../src/core/validation.js';
import { pinExternals } from '../../src/core/surfaces.js';
import { buildCodeModel } from '../../src/core/source-analysis.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';
import { geoKit, habitly, NO_FIELD, orchestratorFile, portalFile, projectYaml, routePlanner, type HabitlyOptions } from '../helpers/conformance-r6-trees.js';
import type { ImplementationSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The code<->spec gaps the sixth round of user trials found:
//
//   1. Two computed-key shapes on a data component were silent:
//      `(store as any)[name](…)` with `name` a const literal (the variable's
//      own name was read as the member's), and `store[k]` with k a `keyof`
//      union taken as a value and invoked later through `.call`.
//   2a. A claimed call through a port to a collaborator whose code is not
//      written yet was CALL_ORIGIN_UNRESOLVED (a warning) — CI red on the
//      normal state after the first component is implemented from its brief.
//   2b. A Portal's unnarrated READ through an Orchestrator verb with no
//      declared effect was reported as a write.
//   2c. A node:http handler `(_req, _url, params)` realizing `(id)` raised
//      UNDECLARED_PARAM, and its request was silently paired with `id`.
//   3. A rename of a parameter typed by an EXTERNAL type went unreported.
//   4. A technology import moved into a helper module escaped
//      TECH_LEAKAGE_IN_CODE.
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const dir of roots.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
  }
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-round6-')));
  roots.push(dir);
  return dir;
}

function materialize(dir: string, tree: FixtureTree): void {
  materializeFixtureProject(dir, tree);
  for (const [rel, text] of Object.entries(tree.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

function run(tree: FixtureTree): ValidationIssue[] {
  const dir = tempDir();
  materialize(dir, tree);
  setProjectRoot(dir);
  invalidateSpecCache();
  return validateProject().issues;
}

const habits = (o: HabitlyOptions = {}): ValidationIssue[] => run(habitly(o));
const byCode = (issues: ValidationIssue[], code: string): ValidationIssue[] => issues.filter(i => i.code === code);
const said = (issues: ValidationIssue[]): string => issues.map(i => `${i.code}: ${i.message.slice(0, 220)}`).join('\n');

describe('1. a computed key on a data component fails closed however it is cast', () => {
  const portalShapes: Array<[string, string]> = [
    ['D24d: a const literal key on a receiver cast to any', "const name = 'addCheckIn'; (this.checkins as any)[name](id);"],
    ['D24: a key built from an expression, taken as a value and invoked through call()',
      "const k = ('add' + 'CheckIn') as keyof HabitStore; const f = this.checkins[k] as unknown as (x: string) => string; f.call(this.checkins, id);"],
    ['a keyof key invoked on the spot', "const k = ('add' + 'CheckIn') as keyof HabitStore; (this.checkins[k] as unknown as (x: string) => string)(id);"],
  ];
  for (const [label, body] of portalShapes) {
    it(`Portal — ${label} → PORTAL_CALL_UNRESOLVED naming the store's write`, () => {
      const issues = habits({ portal: portalFile({ body }) });
      const found = byCode(issues, 'PORTAL_CALL_UNRESOLVED');
      expect(found, said(issues)).toHaveLength(1);
      expect(found[0].severity).toBe('warning');
      expect(found[0].message).toContain('habit_store.addCheckIn');
    });
  }

  it('control: the const literal key naming the READ through the same cast → nothing', () => {
    const issues = habits({ portal: portalFile({ body: "const name = 'find'; (this.checkins as any)[name](id);" }) });
    expect(byCode(issues, 'PORTAL_CALL_UNRESOLVED'), said(issues)).toEqual([]);
    expect(byCode(issues, 'PORTAL_WRITE_SHORTCUT_IN_CODE')).toEqual([]);
  });

  it('control: a computed key on a local table of formatters (never a component) → nothing', () => {
    const issues = habits({
      portal: portalFile({ body: "const table = { plain: (x: string) => x, loud: (x: string) => x }; const k = ('pl' + 'ain') as keyof typeof table; const f = table[k]; f.call(table, id);", field: NO_FIELD, head: '' }),
    });
    expect(byCode(issues, 'PORTAL_CALL_UNRESOLVED'), said(issues)).toEqual([]);
  });

  it('a const literal naming the WRITE taken as a value off the typed receiver → PORTAL_WRITE_SHORTCUT_IN_CODE', () => {
    const issues = habits({ portal: portalFile({ body: "const name = 'addCheckIn'; const f = this.checkins[name]; f.call(this.checkins, id);" }) });
    expect(byCode(issues, 'PORTAL_WRITE_SHORTCUT_IN_CODE').map(i => i.message).join('\n'), said(issues)).toContain('habit_store.addCheckIn');
  });

  it('Orchestrator — D24d in a read-narrated verb → CALL_ORIGIN_UNRESOLVED (fails closed)', () => {
    const issues = habits({ orchestrator: orchestratorFile({ extra: "const name = 'addCheckIn'; (this.checkins as any)[name](id);" }) });
    const found = byCode(issues, 'CALL_ORIGIN_UNRESOLVED').filter(i => i.message.includes('fails closed'));
    expect(found, said(issues)).toHaveLength(1);
    expect(found[0].message).toContain('habit_store.addCheckIn');
  });

  it('Orchestrator — D24 in a read-narrated verb → CALL_ORIGIN_UNRESOLVED (fails closed)', () => {
    const issues = habits({ orchestrator: orchestratorFile({ extra: "const k = ('add' + 'CheckIn') as keyof HabitStore; const f = this.checkins[k] as unknown as (x: string) => string; f.call(this.checkins, id);" }) });
    expect(byCode(issues, 'CALL_ORIGIN_UNRESOLVED').filter(i => i.message.includes('habit_store.addCheckIn')), said(issues)).toHaveLength(1);
  });

  it('control: Orchestrator — the const literal naming the read → nothing', () => {
    const issues = habits({ orchestrator: orchestratorFile({ extra: "const name = 'find'; (this.checkins as any)[name](id);" }) });
    expect(byCode(issues, 'CALL_ORIGIN_UNRESOLVED'), said(issues)).toEqual([]);
  });
});

describe('2a. a claimed call to a collaborator whose code is not written yet is planned, not unresolved', () => {
  const PORT_ORCHESTRATOR = [
    'export interface Checkins {',
    '  addCheckIn(id: string): string;',
    '  find(id: string): string;',
    '}',
    'export class HabitOrchestrator {',
    '  constructor(private readonly checkins: Checkins) {}',
    '  checkIn(id: string): string { this.checkins.find(id); return this.checkins.addCheckIn(id); }',
    '  streak(id: string): string { return this.checkins.find(id); }',
    '  archive(id: string): string { return id; }',
    '}', '',
  ].join('\n');

  it('the Store unwritten, the Orchestrator typing it by a port of its own → CALL_TARGET_PLANNED (notice), no CALL_ORIGIN_UNRESOLVED', () => {
    const issues = habits({ store: null, orchestrator: PORT_ORCHESTRATOR });
    expect(byCode(issues, 'CALL_ORIGIN_UNRESOLVED'), said(issues)).toEqual([]);
    const planned = byCode(issues, 'CALL_TARGET_PLANNED');
    expect(planned.length, said(issues)).toBeGreaterThan(0);
    expect(planned.every(i => i.severity === 'notice')).toBe(true);
    expect(planned.map(i => i.message).join('\n')).toContain('habit_store.addCheckIn');
    expect(planned.map(i => i.message).join('\n')).toContain('src/habit-store.ts');
  });

  it('control: once the Store\'s realization has begun, the same unlandable port is CALL_ORIGIN_UNRESOLVED again', () => {
    const issues = habits({ store: 'export const placeholder = 1;\n', orchestrator: PORT_ORCHESTRATOR });
    expect(byCode(issues, 'CALL_ORIGIN_UNRESOLVED').length, said(issues)).toBeGreaterThan(0);
    expect(byCode(issues, 'CALL_TARGET_PLANNED')).toEqual([]);
  });

  it('control: a planned target the code never calls at all is still CALL_STEP_UNREALIZED', () => {
    const issues = habits({ store: null, orchestrator: PORT_ORCHESTRATOR.replace('this.checkins.find(id); return this.checkins.addCheckIn(id);', 'return this.checkins.find(id);') });
    expect(byCode(issues, 'CALL_STEP_UNREALIZED').map(i => i.message).join('\n'), said(issues)).toContain('habit_store.addCheckIn');
  });
});

describe('2b. an undeclared workflow verb\'s effect is read off its own narrative', () => {
  const calling = (verb: string): string => portalFile({ body: `this.habits.${verb}(id);`, field: NO_FIELD, head: '' });

  it('a Portal\'s unnarrated call to a verb with no effect whose narrative only READS → nothing', () => {
    const issues = habits({ portal: calling('streak'), effects: { streak: undefined } });
    expect(byCode(issues, 'UNDECLARED_WRITE_CALL'), said(issues)).toEqual([]);
  });

  it('a verb with no effect whose narrative reaches a WRITE → UNDECLARED_WRITE_CALL as a write', () => {
    const issues = habits({ portal: calling('archive'), archiveCalls: 'addCheckIn' });
    const found = byCode(issues, 'UNDECLARED_WRITE_CALL');
    expect(found, said(issues)).toHaveLength(1);
    expect(found[0].message).toContain('habit_orchestrator.archive');
    expect(found[0].message).toContain('change state');
    expect(found[0].message).not.toContain('effect undeclared');
  });

  it('a verb with no effect and no narrative → UNDECLARED_WRITE_CALL worded as an unnarrated call whose effect is undeclared, never as a write', () => {
    const issues = habits({ portal: calling('archive'), archiveIntent: true });
    const found = byCode(issues, 'UNDECLARED_WRITE_CALL');
    expect(found, said(issues)).toHaveLength(1);
    expect(found[0].message).toContain('unnarrated call to habit_orchestrator.archive (effect undeclared)');
    expect(found[0].message).not.toContain('change state');
  });

  it('control: the verb with no effect whose narrative only reads the Store → nothing', () => {
    const issues = habits({ portal: calling('archive'), archiveCalls: 'find' });
    expect(byCode(issues, 'UNDECLARED_WRITE_CALL'), said(issues)).toEqual([]);
  });

  it('control: the same verb declaring read → nothing', () => {
    const issues = habits({ portal: calling('archive'), effects: { archive: 'read' }, archiveIntent: true });
    expect(byCode(issues, 'UNDECLARED_WRITE_CALL'), said(issues)).toEqual([]);
  });
});

describe('2c. a node:http handler\'s imposed parameters are never undeclared', () => {
  const handler = (signature: string): ValidationIssue[] => habits({
    portal: portalFile({ signature, field: NO_FIELD, head: '', dispatch: "params.id ?? ''" }),
  });

  it('`checkIn(_req, _url, id)` realizing `checkIn(id)`, the request and URL unused → no UNDECLARED_PARAM, no PARAM_NAME_MISMATCH', () => {
    const issues = habits({ portal: portalFile({ signature: '_req: object, _url: URL, id: string', field: NO_FIELD, head: '' }) });
    expect(byCode(issues, 'UNDECLARED_PARAM'), said(issues)).toEqual([]);
    expect(byCode(issues, 'PARAM_NAME_MISMATCH')).toEqual([]);
  });

  it('control: the same handler naming its request and URL → UNDECLARED_PARAM', () => {
    const issues = handler('req: object, url: URL, params: Record<string, string>');
    expect(byCode(issues, 'UNDECLARED_PARAM'), said(issues)).toHaveLength(1);
  });

  it('`_id` realizing `id` is the same argument, unused — no PARAM_NAME_MISMATCH', () => {
    const issues = habits({ orchestrator: orchestratorFile().replace('archive(id: string)', 'archive(_id: string)').replace('return id; }\n}', "return ''; }\n}") });
    expect(byCode(issues, 'PARAM_NAME_MISMATCH'), said(issues)).toEqual([]);
    expect(byCode(issues, 'UNREALIZED_PARAM')).toEqual([]);
  });

  it('a trailing `_extra` is never undeclared; control: a trailing `extra` is', () => {
    const quiet = habits({ orchestrator: orchestratorFile().replace('archive(id: string)', 'archive(id: string, _extra?: string)') });
    expect(byCode(quiet, 'UNDECLARED_PARAM'), said(quiet)).toEqual([]);
    const loud = habits({ orchestrator: orchestratorFile().replace('archive(id: string)', 'archive(id: string, extra?: string)') });
    expect(byCode(loud, 'UNDECLARED_PARAM').map(i => i.message).join('\n'), said(loud)).toContain('"extra"');
  });
});

describe('3. a rename is a rename whatever project declared the parameter\'s type', () => {
  function planner(signature: string): ValidationIssue[] {
    const root = tempDir();
    const geo = path.join(root, 'geo');
    const studio = path.join(root, 'route-planner');
    fs.mkdirSync(geo, { recursive: true });
    fs.mkdirSync(studio, { recursive: true });
    materialize(geo, geoKit());
    fs.writeFileSync(path.join(geo, '.wai', 'project.yaml'), projectYaml('geo-kit'));
    materialize(studio, routePlanner(signature));
    fs.writeFileSync(path.join(studio, '.wai', 'project.yaml'), projectYaml('route-planner', { externals: { geo: { source: { path: '../geo' } } } }));
    setProjectRoot(studio);
    invalidateSpecCache();
    pinExternals();
    invalidateSpecCache();
    return validateProject().issues;
  }

  it('`sequence(stops: list<geo::coordinate>)` realized as `sequence(points: Coordinate[])` → PARAM_NAME_MISMATCH', () => {
    const issues = planner('points: Coordinate[]');
    const found = byCode(issues, 'PARAM_NAME_MISMATCH');
    expect(found, said(issues)).toHaveLength(1);
    expect(found[0].message).toContain('"stops" (the code calls it "points")');
  });

  it('control: the same name → nothing', () => {
    const issues = planner('stops: Coordinate[]');
    expect(byCode(issues, 'PARAM_NAME_MISMATCH'), said(issues)).toEqual([]);
  });
});

describe('4. a technology import moved into a helper module is the importer\'s', () => {
  const DB = "import { Client } from 'pg';\nexport const db = new Client();\n";
  const withHelper = (helper: string, files: Record<string, string>): ValidationIssue[] => habits({
    postgres: true,
    portal: portalFile({ field: NO_FIELD, head: `import { db } from '${helper}';`, body: 'void db;' }),
    files,
  });

  it('the Portal imports src/db.ts, which imports pg → TECH_LEAKAGE_IN_CODE naming the hop', () => {
    const issues = withHelper('./db.js', { 'src/db.ts': DB });
    const found = byCode(issues, 'TECH_LEAKAGE_IN_CODE');
    expect(found, said(issues)).toHaveLength(1);
    expect(found[0].message).toContain('src/habit-portal.ts');
    expect(found[0].message).toContain('"src/db.ts"');
  });

  it('two unowned hops (src/infra/index.ts → src/infra/db.ts) → TECH_LEAKAGE_IN_CODE', () => {
    const issues = withHelper('./infra/index.js', { 'src/infra/index.ts': "export { db } from './db.js';\n", 'src/infra/db.ts': DB });
    expect(byCode(issues, 'TECH_LEAKAGE_IN_CODE'), said(issues)).toHaveLength(1);
  });

  it('control: the helper imports no technology → nothing', () => {
    const issues = withHelper('./db.js', { 'src/db.ts': 'export const db = { query: (q: string) => q };\n' });
    expect(byCode(issues, 'TECH_LEAKAGE_IN_CODE'), said(issues)).toEqual([]);
  });

  it('control: the Store (the home) imports the same helper → nothing', () => {
    const issues = habits({
      postgres: true,
      store: `import { db } from './db.js';\nexport class HabitStore {\n  addCheckIn(id: string): string { void db; return id; }\n  find(id: string): string { return id; }\n}\n`,
      files: { 'src/db.ts': DB },
    });
    expect(byCode(issues, 'TECH_LEAKAGE_IN_CODE'), said(issues)).toEqual([]);
  });

  it('the model records what each own file imports (reachedImports), helpers included', () => {
    const dir = tempDir();
    materialize(dir, habitly({ postgres: true, portal: portalFile({ field: NO_FIELD, head: "import { db } from './db.js';", body: 'void db;' }), files: { 'src/db.ts': DB } }));
    const impls = [{ id: 'p', contract: 'ihabit_portal', sourcePath: 'src/habit-portal.ts', methods: [] }] as unknown as ImplementationSpec[];
    const model = buildCodeModel(impls, [], dir);
    expect(model.reachedImports?.['src/habit-portal.ts']?.files).toContain('src/db.ts');
    expect(model.reachedImports?.['src/db.ts']?.packages).toEqual(['pg']);
  });
});

describe('a binding module an implementation declares is claimed code', () => {
  const BINDING = 'export interface Coordinate {\n  lat: number;\n  lon: number;\n}\n';
  const withBinding = (bindings?: string[]): ValidationIssue[] => {
    const tree = habitly({ files: { 'src/geo-binding.ts': BINDING } });
    const store = (tree.implementations ?? []).find((i) => i.id === 'habit_store_impl') as Record<string, unknown>;
    if (bindings) store.bindings = bindings;
    const dir = tempDir();
    materialize(dir, tree);
    setProjectRoot(dir);
    invalidateSpecCache();
    return validateProject({ rules: { conformance: { sourceRoots: ['src'] } } as never }).issues;
  };

  it('src/geo-binding.ts named in bindings under a declared source root → no UNCLAIMED_SOURCE_FILE', () => {
    const issues = withBinding(['src/geo-binding.ts']);
    expect(byCode(issues, 'UNCLAIMED_SOURCE_FILE'), said(issues)).toEqual([]);
  });

  it('control: the same file named by no spec → UNCLAIMED_SOURCE_FILE', () => {
    const issues = withBinding();
    expect(byCode(issues, 'UNCLAIMED_SOURCE_FILE').map(i => i.message).join('\n'), said(issues)).toContain('src/geo-binding.ts');
  });
});
