import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateProject } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { buildCodeModel } from '../../src/core/source-analysis.js';
import type { ImplementationSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The code<->spec gaps the fourth round of user trials found:
//
//   1. The Portal write-shortcut gate was fooled by receiver spellings the
//      shape facts did not know (element access, destructuring, a field chain,
//      a type alias, a barrel, a port interface, a constructed instance). Calls
//      are now resolved by the TypeScript type checker.
//   2. A receiver typed any/unknown was a NOTICE (CI green): it now fails
//      closed as a warning.
//   3. An Orchestrator's unnarrated write to a dependency went unreported.
//   4. Constructor parameter properties read as "no fields".
//   5. TypeScript 7 (or none) degraded the run; wairon reads with its own copy.
//   6. A long-lived process kept a stale compiler / stale parse.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-round4-')));
  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
  }));
  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }
  const stamp = "createdAt: '2026-10-05T10:00:00Z'\nupdatedAt: '2026-10-05T10:00:00Z'";
  const writeSpec = (type: string, name: string, content: string) => {
    const filePath = type === 'system'
      ? path.join(specsDir, '.index.yaml')
      : path.join(specsDir, `${type}s`, `${name}.yaml`);
    fs.writeFileSync(filePath, `${content}\n${stamp}\n`);
  };
  writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: TestSystem\nvision: testing');
  writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem');
  return {
    tempDir,
    component: (id: string, type: string, extra = '') =>
      writeSpec('component', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nsubsystem: sub-a\ncomponentType: ${type}\n${extra}`),
    contract: (compId: string, methods: Array<[string, string?]>) =>
      writeSpec('interface', `i${compId}`, [
        'schemaVersion: 1.0.0', `id: i${compId}`, `name: I${compId}`, 'description: contract', `component: ${compId}`, 'methods:',
        ...methods.map(([m, effect]) => [
          `  - name: ${m}`,
          `    description: ${m} does its one thing, carefully and observably`,
          `    signature: "${m}(id: string): string"`,
          '    params: [{ name: id, type: string }]',
          '    returns: string',
          ...(effect ? [`    effect: ${effect}`] : []),
        ].join('\n')),
      ].join('\n')),
    impl: (compId: string, body: string) =>
      writeSpec('implementation', `impl-${compId}`, `schemaVersion: 1.0.0\nid: impl-${compId}\nname: Impl${compId}\ndescription: impl\ncontract: i${compId}\n${body}`),
    type: (id: string, body: string) =>
      writeSpec('type', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\nkind: value-object\ndescription: a record\n${body}`),
    source: (relPath: string, content: string) => {
      const abs = path.join(tempDir, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    },
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

type Issue = { code: string; specId?: string; message: string; severity: string };
type Result = { issues: Issue[] };
const byCode = (res: Result, code: string) => res.issues.filter(i => i.code === code);
const intent = (m: string) => `  - name: ${m}\n    detail: intent\n    intent: Performs its one thing against held state; failures surface as thrown errors.`;

let proj: ReturnType<typeof createTempProject> | undefined;
afterEach(() => { proj?.cleanup(); proj = undefined; });

/**
 * Portal -> Orchestrator -> Store. The Store's class is `CheckinStore` in
 * src/store.ts; the Portal's file is written by the caller, with the narrated
 * orchestrator call kept.
 */
function habitShape(p: ReturnType<typeof createTempProject>, portalFile: string, extra: Record<string, string> = {}): void {
  p.component('store-a', 'Store', 'durability: read-through\nlint:\n  allow:\n    - { code: UNOWNED_STORE, reason: one keyed table }');
  p.contract('store-a', [['record', 'write'], ['find', 'read']]);
  p.impl('store-a', `sourcePath: src/store.ts\nmethods:\n${intent('record')}\n${intent('find')}`);
  p.source('src/store.ts', 'export class CheckinStore {\n  record(id: string): string { return id; }\n  find(id: string): string { return id; }\n}\n');
  p.component('tracker-a', 'Orchestrator', 'dependsOn: [store-a]');
  p.contract('tracker-a', [['checkIn', 'write']]);
  p.impl('tracker-a', [
    'sourcePath: src/tracker.ts', 'methods:', '  - name: checkIn', '    narrative:',
    '      - { stepNumber: 1, description: Record the check-in, type: call, targetComponent: store-a, targetMethod: record }',
    '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
  ].join('\n'));
  p.source('src/tracker.ts', [
    "import type { CheckinStore } from './store.js';",
    'export class HabitTracker {',
    '  constructor(private readonly checkins: CheckinStore) {}',
    '  checkIn(id: string): string { return this.checkins.record(id); }',
    '}', '',
  ].join('\n'));
  p.component('web-a', 'Portal', 'transport: InProcess\ndependsOn: [tracker-a]');
  p.contract('web-a', [['checkIn', 'write']]);
  p.impl('web-a', [
    'sourcePath: src/web.ts', 'methods:', '  - name: checkIn', '    narrative:',
    '      - { stepNumber: 1, description: Dispatch to the tracker, type: call, targetComponent: tracker-a, targetMethod: checkIn }',
    '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
  ].join('\n'));
  p.source('src/web.ts', portalFile);
  for (const [file, text] of Object.entries(extra)) p.source(file, text);
}

/** A Portal class whose checkIn runs `body` before the narrated call; `field` is its second collaborator. */
function portal(body: string, field = 'private readonly checkins: CheckinStore', head = "import type { CheckinStore } from './store.js';", tail = ''): string {
  return [
    "import type { HabitTracker } from './tracker.js';",
    head,
    'export class HabitsApi {',
    `  constructor(private readonly tracker: HabitTracker, ${field}) {}`,
    `  checkIn(id: string): string { ${body} return this.tracker.checkIn(id); }`,
    '}',
    tail,
    '',
  ].join('\n');
}

describe('1. the type checker resolves a Portal call whatever its spelling', () => {
  const shapes: Array<[string, string, Record<string, string>?]> = [
    ['an element access', portal("this.checkins['record'](id);")],
    ['a destructured method invoked with call()', portal('const { record } = this.checkins; record.call(this.checkins, id);')],
    ['a field of a dependency bag', portal('this.deps.store.record(id);', 'private readonly deps: { store: CheckinStore }')],
    ['a one-hop type alias', portal('this.checkins.record(id);', 'private readonly checkins: Writer', "import type { CheckinStore } from './store.js';\ntype Writer = CheckinStore;")],
    ['a factory field', portal('this.stores().record(id);', 'private readonly stores: () => CheckinStore')],
    ['a cast from unknown to the named type', portal('(this.checkins as CheckinStore).record(id);', 'private readonly checkins: unknown')],
    ['a constructed instance', portal('new CheckinStore().record(id);', 'private readonly unused?: number', "import { CheckinStore } from './store.js';")],
    ['a module-level instance (lib-and-app R4-33)', portal('store.record(id);', 'private readonly unused?: number', "import { CheckinStore } from './store.js';\nconst store = new CheckinStore();")],
    ['a type-only barrel re-export', portal('this.checkins.record(id);', 'private readonly checkins: CheckinStore', "import type { CheckinStore } from './contracts.js';"),
      { 'src/contracts.ts': "export type { CheckinStore } from './store.js';\n" }],
    ['a port interface the Portal declares itself', portal('this.checkins.record(id);', 'private readonly checkins: CheckinPort', "import type { CheckinPort } from './ports.js';"),
      { 'src/ports.ts': 'export interface CheckinPort { record(id: string): string }\n' }],
  ];
  for (const [label, file, extra] of shapes) {
    it(`${label} → PORTAL_WRITE_SHORTCUT_IN_CODE`, () => {
      proj = createTempProject();
      habitShape(proj, file, extra);
      proj.activate();
      const res = validateProject();
      const shortcut = byCode(res, 'PORTAL_WRITE_SHORTCUT_IN_CODE');
      expect(shortcut, JSON.stringify(res.issues.map(i => i.code))).toHaveLength(1);
      expect(shortcut[0].message).toContain('store-a.record');
      expect(byCode(res, 'PORTAL_CALL_UNRESOLVED')).toEqual([]);
    });
    it(`control: ${label} reaching the READ → no shortcut`, () => {
      proj = createTempProject();
      habitShape(proj, file.replace(/record/g, 'find'), Object.fromEntries(Object.entries(extra ?? {}).map(([k, v]) => [k, v.replace(/record/g, 'find')])));
      proj.activate();
      const res = validateProject();
      expect(byCode(res, 'PORTAL_WRITE_SHORTCUT_IN_CODE')).toEqual([]);
      expect(byCode(res, 'PORTAL_CALL_UNRESOLVED')).toEqual([]);
    });
  }

  it('a port the Portal declares itself is an undeclared edge to the store it lands on', () => {
    proj = createTempProject();
    habitShape(proj, portal('this.checkins.record(id);', 'private readonly checkins: CheckinPort', "import type { CheckinPort } from './ports.js';"),
      { 'src/ports.ts': 'export interface CheckinPort { record(id: string): string }\n' });
    proj.activate();
    const undeclared = byCode(validateProject(), 'UNDECLARED_DEPENDENCY');
    expect(undeclared.some(i => i.message.includes('src/web.ts -> src/store.ts') || (i.message.includes('src/web.ts') && i.message.includes('store-a.record')))).toBe(true);
  });
});

describe('2. a receiver whose type is gone fails closed', () => {
  for (const [label, file] of [
    ['an `as any` cast', portal('(this.checkins as any).record(id);')],
    ['an `<any>` cast', portal('(<any>this.checkins).record(id);')],
    ['a dependency bag typed any', portal('this.deps.store.record(id);', 'private readonly deps: any')],
    ['an untyped global', portal('(globalThis as any).store.record(id);', 'private readonly unused?: number')],
  ] as const) {
    it(`${label} → PORTAL_CALL_UNRESOLVED as a WARNING`, () => {
      proj = createTempProject();
      habitShape(proj, file);
      proj.activate();
      const res = validateProject();
      const unresolved = byCode(res, 'PORTAL_CALL_UNRESOLVED');
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0].severity).toBe('warning');
      expect(unresolved[0].message).toContain('store-a.record');
      expect(unresolved[0].message).toContain('fails closed');
    });
  }

  it('control: a receiver typed by a package with no typings in reach is no candidate (no any the code wrote)', () => {
    proj = createTempProject();
    habitShape(proj, portal('this.res.record(id);', 'private readonly res: Response', "import type { Response } from 'some-http-library';"));
    proj.activate();
    expect(byCode(validateProject(), 'PORTAL_CALL_UNRESOLVED')).toEqual([]);
  });

  it('control: a read under the same unresolvable receiver is no candidate', () => {
    proj = createTempProject();
    habitShape(proj, portal('(this.checkins as any).find(id);'));
    proj.activate();
    expect(byCode(validateProject(), 'PORTAL_CALL_UNRESOLVED')).toEqual([]);
  });
});

describe("3. an Orchestrator's write that no narrative step claims", () => {
  function trackerWith(body: string): void {
    proj = createTempProject();
    habitShape(proj, portal(''));
    proj.contract('tracker-a', [['checkIn', 'write'], ['peek', 'read']]);
    proj.impl('tracker-a', [
      'sourcePath: src/tracker.ts', 'methods:', '  - name: checkIn', '    narrative:',
      '      - { stepNumber: 1, description: Record the check-in, type: call, targetComponent: store-a, targetMethod: record }',
      '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
      '  - name: peek', '    narrative:',
      '      - { stepNumber: 1, description: Read the check-in, type: call, targetComponent: store-a, targetMethod: find }',
      '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
    ].join('\n'));
    proj.source('src/tracker.ts', [
      "import type { CheckinStore } from './store.js';",
      'export class HabitTracker {',
      '  constructor(private readonly checkins: CheckinStore) {}',
      '  checkIn(id: string): string { return this.checkins.record(id); }',
      `  peek(id: string): string { ${body} return this.checkins.find(id); }`,
      '}', '',
    ].join('\n'));
    proj.activate();
  }

  it('an extra store write in a read-narrated method → UNDECLARED_WRITE_CALL', () => {
    trackerWith('this.checkins.record(id);');
    const found = byCode(validateProject(), 'UNDECLARED_WRITE_CALL');
    expect(found).toHaveLength(1);
    expect(found[0].specId).toBe('impl-tracker-a');
    expect(found[0].message).toContain('"peek"');
    expect(found[0].message).toContain('store-a.record');
  });

  it('control: an extra READ is no unnarrated write', () => {
    trackerWith('this.checkins.find(id);');
    expect(byCode(validateProject(), 'UNDECLARED_WRITE_CALL')).toEqual([]);
  });
});

describe('4. constructor parameter properties are fields', () => {
  it('a class declaring its fields as parameter properties carries them', () => {
    proj = createTempProject();
    proj.type('money', 'subsystem: sub-a\nsourcePath: src/money.ts\nsymbol: Money\nfields:\n  - { name: amountMinor, type: int }\n  - { name: currency, type: string }');
    proj.source('src/money.ts', 'export class Money {\n  constructor(public readonly amountMinor: number, public readonly currency: string) {}\n}\n');
    proj.activate();
    const res = validateProject();
    expect(byCode(res, 'UNREALIZED_TYPE_FIELD')).toEqual([]);
    expect(byCode(res, 'UNDECLARED_TYPE_FIELD')).toEqual([]);
  });

  it('control: an undeclared parameter property is reported, an optional one as optional', () => {
    proj = createTempProject();
    proj.type('money', 'subsystem: sub-a\nsourcePath: src/money.ts\nsymbol: Money\nfields:\n  - { name: amountMinor, type: int }\n  - { name: currency, type: string }');
    proj.source('src/money.ts', 'export class Money {\n  constructor(public readonly amountMinor: number, public readonly currency?: string, private readonly rounding = 2) {}\n}\n');
    proj.activate();
    const res = validateProject();
    expect(byCode(res, 'UNDECLARED_TYPE_FIELD').some(i => i.message.includes('rounding'))).toBe(true);
    expect(byCode(res, 'TYPE_FIELD_OPTIONALITY').some(i => i.message.includes('currency'))).toBe(true);
  });
});

// ---- 5 + 6: which compiler, and what a long-lived process remembers ---------

const REAL_TS = path.dirname(require.resolve('typescript/package.json'));

function modelRoot(): { root: string; impl: ImplementationSpec; cleanup: () => void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-round4-ts-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "p", "version": "1.0.0" }\n');
  fs.writeFileSync(path.join(root, 'src', 'store.ts'), 'export class Store {\n  save(id: string): string { return id; }\n}\n');
  fs.writeFileSync(path.join(root, 'src', 'api.ts'), "import { Store } from './store.js';\nexport function hit(id: string): string { return new Store().save(id); }\n");
  const impl = { id: 'api_impl', contract: 'iapi', sourcePath: 'src/api.ts', methods: [] } as unknown as ImplementationSpec;
  return { root, impl, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ } } };
}

function fakeTypeScript(root: string, version: string, body: string): void {
  const dir = path.join(root, 'node_modules', 'typescript');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'typescript', version, main: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), body);
}

describe('5. the compiler the analysis reads with', () => {
  it('wairon depends on a TypeScript 5 compiler at runtime, not only to build', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.typescript).toMatch(/^\^5\./);
    expect(pkg.devDependencies?.typescript).toBeUndefined();
  });

  it('a project on TypeScript 7 (no JavaScript API) is read at exact grade with wairon\'s own copy', () => {
    const m = modelRoot();
    try {
      fakeTypeScript(m.root, '7.0.2', 'module.exports = { version: "7.0.2" };\n');
      const model = buildCodeModel([m.impl], [], m.root);
      const facts = model.files.find(f => f.path === 'src/api.ts')!;
      expect(facts.analysisGrade).toBe('exact');
      expect(facts.resolvedCalls?.some(c => c.targets.some(t => t.path === 'src/store.ts' && t.member === 'save'))).toBe(true);
    } finally { m.cleanup(); }
  });

  it('a project with no TypeScript at all is read at exact grade', () => {
    const m = modelRoot();
    try {
      const facts = buildCodeModel([m.impl], [], m.root).files.find(f => f.path === 'src/api.ts')!;
      expect(facts.analysisGrade).toBe('exact');
    } finally { m.cleanup(); }
  });
});

describe('6. nothing a long-lived process remembers outlives what it depends on', () => {
  it('replacing the project\'s TypeScript 7 with a 5.x one is seen by the next run (no stale module)', () => {
    const m = modelRoot();
    const g = globalThis as unknown as { __waironFakeTs?: number };
    try {
      fakeTypeScript(m.root, '7.0.2', 'module.exports = { version: "7.0.2" };\n');
      buildCodeModel([m.impl], [], m.root);
      g.__waironFakeTs = 0;
      // Same path, new install: a 5.x package that counts its own use.
      fakeTypeScript(m.root, '5.9.0', [
        `const real = require(${JSON.stringify(REAL_TS)});`,
        'module.exports = { ...real, createSourceFile: (...a) => { globalThis.__waironFakeTs = (globalThis.__waironFakeTs || 0) + 1; return real.createSourceFile(...a); } };',
        '',
      ].join('\n'));
      const facts = buildCodeModel([m.impl], [], m.root).files.find(f => f.path === 'src/api.ts')!;
      expect(facts.analysisGrade).toBe('exact');
      expect(g.__waironFakeTs).toBeGreaterThan(0);
    } finally {
      delete g.__waironFakeTs;
      m.cleanup();
    }
  });

  it('a source file changed between runs is resolved from its new text', () => {
    const m = modelRoot();
    try {
      const first = buildCodeModel([m.impl], [], m.root).files.find(f => f.path === 'src/api.ts')!;
      expect(first.resolvedCalls?.some(c => c.name === 'save')).toBe(true);
      fs.writeFileSync(path.join(m.root, 'src', 'store.ts'), 'export class Store {\n  save(id: string): string { return id; }\n  drop(id: string): string { return id; }\n}\n');
      fs.writeFileSync(path.join(m.root, 'src', 'api.ts'), "import { Store } from './store.js';\nexport function hit(id: string): string { return new Store().drop(id); }\n");
      const second = buildCodeModel([m.impl], [], m.root).files.find(f => f.path === 'src/api.ts')!;
      expect(second.resolvedCalls?.some(c => c.name === 'drop' && c.targets.some(t => t.path === 'src/store.ts'))).toBe(true);
      expect(second.resolvedCalls?.some(c => c.name === 'save')).toBe(false);
    } finally { m.cleanup(); }
  });
});

describe('7. a technology package no implementation binds', () => {
  function storeImporting(technologies: string): void {
    proj = createTempProject();
    proj.component('cache-a', 'Store', 'durability: cache\nlint:\n  allow:\n    - { code: UNOWNED_STORE, reason: one keyed cache }');
    proj.contract('cache-a', [['put', 'write']]);
    proj.impl('cache-a', `sourcePath: src/cache.ts\n${technologies}methods:\n${intent('put')}`);
    proj.source('src/cache.ts', "import Redis from 'ioredis';\nexport function put(id: string): string { void Redis; return id; }\n");
    proj.activate();
  }

  it('an `ioredis` import with no technology bound anywhere → TECH_LEAKAGE_IN_CODE naming the missing binding', () => {
    storeImporting('');
    const leaks = byCode(validateProject(), 'TECH_LEAKAGE_IN_CODE');
    expect(leaks).toHaveLength(1);
    expect(leaks[0].message).toContain('"ioredis"');
    expect(leaks[0].message).toContain('which no implementation binds');
  });

  it('control: the Store binding redis is its home', () => {
    storeImporting('technologies: [redis]\n');
    expect(byCode(validateProject(), 'TECH_LEAKAGE_IN_CODE')).toEqual([]);
  });
});
