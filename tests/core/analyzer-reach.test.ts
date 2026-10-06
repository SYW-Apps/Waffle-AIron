import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateProject } from '../../src/core/validation.js';
import { buildCodeModel } from '../../src/core/source-analysis.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { factsFor, resolveImport } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Three code shapes the source analysis follows only where the code settles
// them, and stays silent about otherwise:
//   1. forwarding bindings with no specifier — `export { a as b }`, and the
//      properties of an exported adapter object `{ b: a }` / `{ b }`;
//   2. package specifiers naming a package of THIS repository (workspaces),
//      resolved like relative imports — a third-party one stays unresolved;
//   3. `fn().method()` through what fn is declared (or constructed) to return,
//      and `this.method()` inside a class's own method.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-analyzer-reach-'));
  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: { noOverlappingOwnership: true, requireOwnedPaths: true, metaAgentTags: ['meta'], enforceReproducibility: true },
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
    contract: (compId: string, methods: string[]) =>
      writeSpec('interface', `i${compId}`, [
        'schemaVersion: 1.0.0', `id: i${compId}`, `name: I${compId}`, 'description: contract', `component: ${compId}`, 'methods:',
        ...methods.map(m => [
          `  - name: ${m}`,
          `    description: ${m} does its one thing, carefully and observably`,
          `    signature: "${m}(): void"`,
          '    returns: "void"',
        ].join('\n')),
      ].join('\n')),
    impl: (compId: string, body: string) =>
      writeSpec('implementation', `impl-${compId}`, `schemaVersion: 1.0.0\nid: impl-${compId}\nname: Impl${compId}\ndescription: impl\ncontract: i${compId}\n${body}`),
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

type Project = ReturnType<typeof createTempProject>;
const byCode = (res: { issues: { code: string; specId?: string; message: string }[] }, code: string) =>
  res.issues.filter(i => i.code === code);

/** A store whose `listSnapshots` lives in `file`, and nothing else. */
const store = (proj: Project, file = 'src/store.ts', source = 'export function listSnapshots(): string[] { return []; }\n') => {
  proj.component('store-a', 'Store');
  proj.contract('store-a', ['listSnapshots']);
  proj.impl('store-a', `sourcePath: ${file}\nmethods:\n  - name: listSnapshots\n    detail: intent\n    intent: Answers every snapshot held, in the order they were stored; an empty store answers none.`);
  if (source) proj.source(file, source);
};

/** An orchestrator whose `runFlow` (in `file`) claims one call: store-a.listSnapshots. */
const caller = (proj: Project, file: string, source: string | null, extraMethod = '') => {
  proj.component('orch-a', 'Orchestrator', 'dependsOn: [store-a]');
  proj.contract('orch-a', ['runFlow']);
  proj.impl('orch-a', [
    `sourcePath: ${file}`,
    'methods:',
    '  - name: runFlow',
    extraMethod,
    '    narrative:',
    '      - { stepNumber: 1, description: Read the snapshots from the store, type: call, targetComponent: store-a, targetMethod: listSnapshots }',
    '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
  ].filter(Boolean).join('\n'));
  if (source !== null) proj.source(file, source);
};

/** Analyze a handful of files directly and answer the facts of one. */
const factsOf = (files: Record<string, string>, target: string, pkgs?: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-reach-facts-'));
  try {
    for (const [rel, text] of Object.entries({ ...files, ...(pkgs ?? {}) })) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    const model = buildCodeModel([], [], dir, ['src', 'pkgs', 'node_modules'].filter(r => fs.existsSync(path.join(dir, r))));
    return { model, facts: factsFor(model, target)! };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
  }
};

describe('export aliases — `export { a as b }` resolves the published name to its body', () => {
  it('a renamed export of an IMPORTED function realizes the method and forwards by identity', () => {
    const proj = createTempProject();
    store(proj);
    caller(proj, 'src/orch.ts', "import { listSnapshots } from './store.js';\nexport { listSnapshots as runFlow };\n");
    proj.activate();
    try {
      const res = validateProject();
      // Before: METHOD_BODY_NOT_FOUND — the name was a bodiless export specifier.
      expect(byCode(res, 'METHOD_BODY_NOT_FOUND')).toEqual([]);
      expect(byCode(res, 'CALL_STEP_UNREALIZED')).toEqual([]);
      expect(byCode(res, 'CALL_ORIGIN_UNRESOLVED')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('a renamed export of the file\'s OWN function carries that body, whose calls are then checked', () => {
    const proj = createTempProject();
    store(proj);
    caller(proj, 'src/orch.ts', "import { listSnapshots } from './store.js';\nfunction drive(): void { listSnapshots(); }\nexport { drive as runFlow };\n");
    proj.activate();
    try {
      const res = validateProject();
      expect(byCode(res, 'METHOD_BODY_NOT_FOUND')).toEqual([]);
      expect(byCode(res, 'CALL_STEP_UNREALIZED')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('the carried body is READ, not waved through: a body that never makes the claimed call is accused', () => {
    const proj = createTempProject();
    store(proj);
    caller(proj, 'src/orch.ts', "function drive(): void { /* forgot the store */ }\nexport { drive as runFlow };\n");
    proj.activate();
    try {
      expect(byCode(validateProject(), 'CALL_STEP_UNREALIZED')).toHaveLength(1);
    } finally { proj.cleanup(); }
  });

  it('a forwarded body is the forwarded method\'s: its calls are not the forwarding facade\'s colocated crossings', () => {
    // ext.ts holds a reader (component reader-a) and a facade (facade-a) that
    // republishes the store's install; the store's install calls the reader
    // back. The facade's body IS the store's method, so what it calls is the
    // store's narrative's subject, not a crossing the facade failed to claim.
    const proj = createTempProject();
    proj.component('reader-a', 'Adapter');
    proj.contract('reader-a', ['readManifest']);
    proj.impl('reader-a', 'sourcePath: src/ext.ts\nmethods:\n  - name: readManifest\n    detail: intent\n    intent: Reads one manifest and answers it parsed; an unreadable one throws.');
    proj.component('store-b', 'Adapter', 'dependsOn: [reader-a]');
    proj.contract('store-b', ['installPack']);
    proj.impl('store-b', [
      'sourcePath: src/store.ts', 'methods:', '  - name: installPack', '    narrative:',
      '      - { stepNumber: 1, description: Read the manifest, type: call, targetComponent: reader-a, targetMethod: readManifest }',
    ].join('\n'));
    proj.component('facade-a', 'Orchestrator', 'dependsOn: [store-b]');
    proj.contract('facade-a', ['installPack']);
    proj.impl('facade-a', [
      'sourcePath: src/ext.ts', 'methods:', '  - name: installPack', '    narrative:',
      '      - { stepNumber: 1, description: Forward to the store, type: call, targetComponent: store-b, targetMethod: installPack }',
    ].join('\n'));
    proj.source('src/ext.ts', "import { installPack } from './store.js';\nexport { installPack };\nexport function readManifest(): string { return ''; }\n");
    proj.source('src/store.ts', "import { readManifest } from './ext.js';\nexport function installPack(): void { readManifest(); }\n");
    proj.activate();
    try {
      const res = validateProject();
      expect(byCode(res, 'UNDECLARED_COLOCATED_CALL')).toEqual([]);
      expect(byCode(res, 'METHOD_BODY_NOT_FOUND')).toEqual([]);
      expect(byCode(res, 'CALL_STEP_UNREALIZED')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('stays bodiless when the local name does not settle: a nested same-named body beside the module one', () => {
    const { facts } = factsOf({
      'src/a.ts': 'function drive(): void {}\nexport function outer(): void { function drive(): void {} drive(); }\nexport { drive as runFlow };\n',
    }, 'src/a.ts');
    expect(facts.exportAliases).toContainEqual({ exported: 'runFlow', local: 'drive' });
    expect(facts.functionCallSites?.runFlow).toBeUndefined();
    expect(facts.functionBodies?.runFlow).toBeUndefined();
  });
});

describe('adapter objects — `{ b: a }` / `{ b }` on an EXPORTED object resolve under its exportedVia handle', () => {
  const viaHandle = '    exportedVia: flows';

  it('a property alias carries the body as a member of the object', () => {
    const proj = createTempProject();
    store(proj);
    caller(proj, 'src/orch.ts', "import { listSnapshots } from './store.js';\nfunction drive(): void { listSnapshots(); }\nexport const flows = { runFlow: drive };\n", viaHandle);
    proj.activate();
    try {
      const res = validateProject();
      expect(byCode(res, 'METHOD_BODY_NOT_FOUND')).toEqual([]);
      expect(byCode(res, 'CALL_STEP_UNREALIZED')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('a shorthand property of an imported function forwards by identity', () => {
    const proj = createTempProject();
    store(proj, 'src/store.ts', 'export function runFlow(): string[] { return []; }\nexport function listSnapshots(): string[] { return []; }\n');
    caller(proj, 'src/orch.ts', "import { listSnapshots } from './store.js';\nexport const flows = { runFlow: listSnapshots };\n", viaHandle);
    proj.activate();
    try {
      const res = validateProject();
      expect(byCode(res, 'CALL_STEP_UNREALIZED')).toEqual([]);
      expect(byCode(res, 'METHOD_BODY_NOT_FOUND')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('records the property aliases of an exported object only', () => {
    const { facts } = factsOf({
      'src/a.ts': 'function drive(): void {}\nconst hidden = { runFlow: drive };\nexport const shown = { drive, go: drive, inline() {} };\nvoid hidden;\n',
    }, 'src/a.ts');
    expect(facts.exportAliases).toEqual([
      { exported: 'drive', local: 'drive', container: 'shown' },
      { exported: 'go', local: 'drive', container: 'shown' },
    ]);
    expect(facts.functionBodies?.go?.map(b => b.container)).toEqual(['shown']);
    expect(facts.functionBodies?.runFlow).toBeUndefined();
  });
});

describe('local packages — a workspace package specifier resolves like a relative import', () => {
  const workspace = (proj: Project) => {
    proj.source('package.json', JSON.stringify({ name: 'root', private: true, workspaces: ['pkgs/lib'] }));
    proj.source('pkgs/lib/package.json', JSON.stringify({ name: '@t/lib', main: './dist/index.js', types: './dist/index.d.ts' }));
    proj.source('pkgs/lib/tsconfig.json', '{\n  // comments are legal in a tsconfig\n  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" }\n}\n');
  };

  it('a call through a workspace package import realizes the claim', () => {
    const proj = createTempProject();
    workspace(proj);
    store(proj, 'pkgs/lib/src/index.ts');
    caller(proj, 'src/orch.ts', "import { listSnapshots } from '@t/lib';\nexport function runFlow(): void { listSnapshots(); }\n");
    proj.activate();
    try {
      const res = validateProject();
      // Before: CALL_ORIGIN_UNRESOLVED — a package specifier resolved to no file.
      expect(byCode(res, 'CALL_ORIGIN_UNRESOLVED')).toEqual([]);
      expect(byCode(res, 'CALL_STEP_UNREALIZED')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('a namespace import of the workspace package resolves too', () => {
    const proj = createTempProject();
    workspace(proj);
    store(proj, 'pkgs/lib/src/index.ts');
    caller(proj, 'src/orch.ts', "import * as lib from '@t/lib';\nexport function runFlow(): void { lib.listSnapshots(); }\n");
    proj.activate();
    try {
      expect(byCode(validateProject(), 'CALL_ORIGIN_UNRESOLVED')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('a third-party package stays unresolved — reported as unchecked, never accused', () => {
    const proj = createTempProject();
    workspace(proj);
    store(proj, 'pkgs/lib/src/index.ts');
    caller(proj, 'src/orch.ts', "import { listSnapshots } from 'some-vendor-lib';\nexport function runFlow(): void { listSnapshots(); }\n");
    proj.activate();
    try {
      const res = validateProject();
      expect(byCode(res, 'CALL_ORIGIN_UNRESOLVED')).toHaveLength(1);
      expect(byCode(res, 'CALL_STEP_UNREALIZED')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('maps build entries back to source, reads subpath exports, and never reads node_modules', () => {
    const { model } = factsOf({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['pkgs/*', 'node_modules/evil', '../outside'] }),
      'pkgs/lib/package.json': JSON.stringify({ name: '@t/lib', exports: { '.': { types: './dist/index.d.ts', require: './dist/index.js' }, './extra': './dist/extra.js', './wild/*': './dist/*.js' } }),
      'pkgs/lib/tsconfig.json': JSON.stringify({ compilerOptions: { outDir: './dist', rootDir: './src' } }),
      'pkgs/lib/src/index.ts': 'export const a = 1;\n',
      'pkgs/lib/src/extra.ts': 'export const b = 1;\n',
      'pkgs/plain/package.json': JSON.stringify({ name: 'plain', main: 'index.js' }),
      'pkgs/plain/index.js': 'module.exports = {};\n',
      'node_modules/evil/package.json': JSON.stringify({ name: 'evil', main: 'index.js' }),
      'node_modules/evil/index.js': 'module.exports = {};\n',
      'src/a.ts': 'export const c = 1;\n',
    }, 'src/a.ts');
    expect(model.packages).toEqual({
      '@t/lib': 'pkgs/lib/src/index.ts',
      '@t/lib/extra': 'pkgs/lib/src/extra.ts',
      plain: 'pkgs/plain/index.js',
    });
    const known = new Set(['pkgs/lib/src/index.ts']);
    expect(resolveImport('src/a.ts', '@t/lib', known, model.packages)).toBe('pkgs/lib/src/index.ts');
    // Mapped, but outside the closed path set: unresolved, like a relative miss.
    expect(resolveImport('src/a.ts', '@t/lib/extra', known, model.packages)).toBeUndefined();
    expect(resolveImport('src/a.ts', 'evil', known, model.packages)).toBeUndefined();
  });
});

describe('`fn().method()` and `this.method()` — followed only where the code settles the receiver', () => {
  const SNAPSHOTS = 'export class Snapshots {\n  listSnapshots(): string[] { return []; }\n}\n';

  it('resolves through fn\'s RETURN ANNOTATION to the class holding the method\'s body', () => {
    const proj = createTempProject();
    store(proj, 'src/store.ts', `${SNAPSHOTS}export function current(): Snapshots { return shared; }\nconst shared = new Snapshots();\n`);
    caller(proj, 'src/orch.ts', "import { current } from './store.js';\nexport function runFlow(): void { current().listSnapshots(); }\n");
    proj.activate();
    try {
      const res = validateProject();
      // Before: CALL_ORIGIN_UNRESOLVED, written as `<receiver>.listSnapshots(…)`.
      expect(byCode(res, 'CALL_ORIGIN_UNRESOLVED')).toEqual([]);
      expect(byCode(res, 'CALL_STEP_UNREALIZED')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('resolves an unannotated fn whose ONE return constructs the class', () => {
    const proj = createTempProject();
    store(proj, 'src/store.ts', `${SNAPSHOTS}export function current() { return new Snapshots(); }\n`);
    caller(proj, 'src/orch.ts', "import { current } from './store.js';\nexport function runFlow(): void { current().listSnapshots(); }\n");
    proj.activate();
    try {
      expect(byCode(validateProject(), 'CALL_ORIGIN_UNRESOLVED')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('stays silent when the return is not settled: an unannotated variable, or an interface with no body', () => {
    for (const current of [
      'const shared = new Snapshots();\nexport function current() { return shared; }\n',
      'export interface Listing { listSnapshots(): string[] }\nexport function current(): Listing { return new Snapshots(); }\n',
    ]) {
      const proj = createTempProject();
      store(proj, 'src/store.ts', `${SNAPSHOTS}${current}`);
      caller(proj, 'src/orch.ts', "import { current } from './store.js';\nexport function runFlow(): void { current().listSnapshots(); }\n");
      proj.activate();
      try {
        const res = validateProject();
        expect(byCode(res, 'CALL_ORIGIN_UNRESOLVED')).toHaveLength(1);
        expect(byCode(res, 'CALL_ORIGIN_UNRESOLVED')[0].message).toContain('current(…).listSnapshots(…)');
        expect(byCode(res, 'CALL_STEP_UNREALIZED')).toEqual([]);
      } finally { proj.cleanup(); }
    }
  });

  it('`this.method()` inside a class\'s own method resolves to the class — the facade-over-workspace shape', () => {
    const proj = createTempProject();
    const ws = [
      'export class Workspace {',
      '  listSnapshots(): string[] { return []; }',
      '  runFlow(): void { const go = () => this.listSnapshots(); go(); }',
      '}',
      'function current(): Workspace { return new Workspace(); }',
      'export function runFlow(): void { current().runFlow(); }',
      'export function listSnapshots(): string[] { return current().listSnapshots(); }',
      '',
    ].join('\n');
    store(proj, 'src/ws.ts', ws);
    caller(proj, 'src/ws.ts', null);
    proj.activate();
    try {
      const res = validateProject();
      expect(byCode(res, 'CALL_ORIGIN_UNRESOLVED')).toEqual([]);
      expect(byCode(res, 'CALL_STEP_UNREALIZED')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('`this` rebound by a function expression or an object literal names no class', () => {
    const { facts } = factsOf({
      'src/a.ts': [
        'export class K {',
        '  m(): void {}',
        '  a(): void { this.m(); }',
        '  b(): void { [1].forEach(function () { this.m(); }); }',
        '}',
        'export const o = { m() {}, c() { this.m(); } };',
        '',
      ].join('\n'),
    }, 'src/a.ts');
    expect(facts.functionCallSites?.a).toEqual([{ name: 'm', member: true, enclosingClass: 'K' }]);
    expect(facts.functionCallSites?.b).toContainEqual({ name: 'm', member: true });
    expect(facts.functionCallSites?.c).toEqual([{ name: 'm', member: true }]);
  });

  it('records a return type only where every same-named body agrees', () => {
    const { facts } = factsOf({
      'src/a.ts': [
        'export class A {}',
        'export class B {}',
        'export function one(): A { return new A(); }',
        'export function two(): Promise<B> { return Promise.resolve(new B()); }',
        'export function three() { if (Math.random()) return new A(); return new A(); }',
        'export class C { make(): A { return new A(); } }',
        'export class D { make(): B { return new B(); } }',
        '',
      ].join('\n'),
    }, 'src/a.ts');
    expect(facts.returnTypes).toEqual({ one: 'A', two: 'B' });
  });
});

describe('lazy loads — a destructured require(…) / await import(…) binds like a static named import', () => {
  it('a call through `const { f } = require(…)` realizes the claimed call (old analysis: unrealized)', () => {
    const proj = createTempProject();
    store(proj);
    caller(proj, 'src/orch.ts', "export function runFlow(): void {\n  const { listSnapshots } = require('./store.js') as typeof import('./store.js');\n  listSnapshots();\n}\n");
    proj.activate();
    try {
      expect(byCode(validateProject(), 'CALL_STEP_UNREALIZED')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('a renamed element of `await import(…)` binds the module export it names', () => {
    const proj = createTempProject();
    store(proj);
    caller(proj, 'src/orch.ts', "export async function runFlow(): Promise<void> {\n  const { listSnapshots: list } = await import('./store.js');\n  list();\n}\n");
    proj.activate();
    try {
      expect(byCode(validateProject(), 'CALL_STEP_UNREALIZED')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('records the binding in the facts, and stays silent where the name is ambiguous', () => {
    const { facts } = factsOf({
      'src/a.ts': 'export function f(): void {}\nexport function g(): void {}\n',
      'src/b.ts': 'export function f(): void {}\n',
      'src/use.ts': [
        "export function one(): void { const { g } = require('./a.js'); g(); }",
        // the same local name lazily loaded from two modules: ambiguous, so unbound
        "export function two(): void { const { f } = require('./a.js'); f(); }",
        "export function three(): void { const { f } = require('./b.js'); f(); }",
        // a rest element and a nested pattern bind nothing nameable
        "export function four(): void { const { ...rest } = require('./a.js'); const { x: { y } } = require('./a.js'); void rest; void y; }",
      ].join('\n') + '\n',
    }, 'src/use.ts');
    const bindings = facts.importBindings ?? {};
    expect(bindings['g']).toEqual({ from: './a.js' });
    expect(bindings['f']).toBeUndefined();
    expect(bindings['rest']).toBeUndefined();
    expect(bindings['y']).toBeUndefined();
  });

  it('never overrides a static import binding of the same name', () => {
    const { facts } = factsOf({
      'src/a.ts': 'export function f(): void {}\n',
      'src/b.ts': 'export function f(): void {}\n',
      'src/use.ts': "import { f } from './a.js';\nexport function one(): void { f(); }\nexport function two(): void { const { f: _f } = require('./b.js'); void _f; }\nexport function three(): void { const { f } = require('./b.js'); f(); }\n",
    }, 'src/use.ts');
    expect((facts.importBindings ?? {})['f']).toEqual({ from: './a.js' });
  });
});
