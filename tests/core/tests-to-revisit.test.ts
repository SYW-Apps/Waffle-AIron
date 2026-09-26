/**
 * The tests a write just invalidated.
 *
 * F25: eight hosted tests encoded behaviour the committed specs had changed.
 * Nothing in the spec pass listed them, so a brief that said "keep existing
 * tests green" collided with the spec it was built on. The search that closes
 * that runs ON THE GATED WRITE, so the change which creates the collision is
 * the one that reports it.
 *
 * What is pinned here is the instrument, because the instrument is the design:
 * an import is a BINDING and a bare name is a coincidence, and the two fail in
 * opposite directions — measured over this tree's own suite, matching an
 * imported symbol misses 382 of 695 methods outright while matching the bare
 * name drowns (`project` matched 187 of 264 files). So: two lists, kept apart,
 * and a mention list WITHHELD above a tenth of the walked suite. Every
 * boundary below is the one that measurement bought.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCodeModel, findTestsReferencing } from '../../src/core/source-analysis.js';
import { findTestsReferencing as findThroughValidator } from '../../src/core/validation.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSubsystemSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { updateSpecGated } from '../../src/core/authoring.js';

const now = new Date().toISOString();
let projects: string[] = [];

function tempProject(): string {
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-revisit-')));
  projects.push(proj);
  return proj;
}

function write(root: string, rel: string, content: string | Buffer): void {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

afterEach(() => {
  for (const proj of projects) fs.rmSync(proj, { recursive: true, force: true });
  projects = [];
  invalidateSpecCache();
});

// ---------------------------------------------------------------------------
// The instrument (isource_analysis_adapter.findTestsReferencing)
// ---------------------------------------------------------------------------

describe('findTestsReferencing — the two lists', () => {
  it('reports a test that IMPORTS the symbol as imported, not as a mention', () => {
    const root = tempProject();
    write(root, 'tests/billing.test.ts', [
      "import { runBilling } from '../src/billing.js';",
      "it('runs', () => runBilling());",
    ].join('\n'));

    const [entry] = findTestsReferencing([{ name: 'runBilling' }], root, ['tests']);

    expect(entry.imported).toEqual(['tests/billing.test.ts']);
    // The same file also NAMES it — the import wins, because the two lists
    // exist to say which evidence was found, not to double-count one file.
    expect(entry.mentioned).toEqual([]);
    expect(entry.indiscriminate).toBe(false);
  });

  it('reports a test that only NAMES the symbol as a mention — the portal-driven case an import misses', () => {
    const root = tempProject();
    write(root, 'tests/portal.test.ts', [
      "import { portal } from '../src/portal.js';",
      "it('drives it through the portal', () => portal.runBilling());",
    ].join('\n'));
    // A suite big enough for ONE mention to stay under a tenth of it. The
    // threshold is a PROPORTION, so a mention is only signal in a suite with
    // room for it — see the withholding tests below.
    for (let i = 0; i < 19; i += 1) write(root, `tests/filler${i}.test.ts`, "it('x', () => 1);");

    const [entry] = findTestsReferencing([{ name: 'runBilling' }], root, ['tests']);

    expect(entry.imported).toEqual([]);
    expect(entry.mentioned).toEqual(['tests/portal.test.ts']);
    expect(entry.indiscriminate).toBe(false);
  });

  it('answers per method, naming the contract method and the symbol it searched for', () => {
    const root = tempProject();
    write(root, 'tests/a.test.ts', "import { runBilling } from '../src/billing.js';");

    const [entry] = findTestsReferencing([{ name: 'runBilling' }], root, ['tests']);

    expect(entry.method).toBe('runBilling');
    expect(entry.symbol).toBe('runBilling');
  });

  it('contributes no entry for a method nothing references', () => {
    const root = tempProject();
    write(root, 'tests/a.test.ts', "import { runBilling } from '../src/billing.js';");

    const found = findTestsReferencing(
      [{ name: 'runBilling' }, { name: 'runNothingAtAll' }],
      root,
      ['tests'],
    );

    expect(found.map(e => e.method)).toEqual(['runBilling']);
  });
});

describe('findTestsReferencing — the symbol override', () => {
  it('searches a method\'s `symbol` rather than its contract name', () => {
    const root = tempProject();
    write(root, 'tests/store.test.ts', "import { saveSnapshot } from '../src/store.js';");
    // A file naming the CONTRACT name must not be dragged in: `put` is the
    // intent-language name and no test can have bound it.
    write(root, 'tests/other.test.ts', "it('puts', () => { const put = 1; return put; });");

    const [entry] = findTestsReferencing([{ name: 'put', symbol: 'saveSnapshot' }], root, ['tests']);

    expect(entry.method).toBe('put');
    expect(entry.symbol).toBe('saveSnapshot');
    expect(entry.imported).toEqual(['tests/store.test.ts']);
    expect(entry.mentioned).toEqual([]);
  });

  it('reads both sides of a renamed import, because either spelling is the symbol somebody searched for', () => {
    const root = tempProject();
    write(root, 'tests/renamed.test.ts', "import { saveSnapshot as put } from '../src/store.js';");

    const [entry] = findTestsReferencing([{ name: 'put', symbol: 'saveSnapshot' }], root, ['tests']);

    expect(entry.imported).toEqual(['tests/renamed.test.ts']);
  });
});

describe('findTestsReferencing — the tenth-of-the-suite threshold', () => {
  /** A suite of `total` files, the first `mentioning` of which name `symbol` without importing it. */
  const suite = (root: string, total: number, mentioning: number, symbol: string): void => {
    for (let i = 0; i < total; i += 1) {
      write(root, `tests/f${i}.test.ts`, i < mentioning ? `describe('x', () => obj.${symbol}());` : "it('x', () => 1);");
    }
  };

  it('withholds the mention list and says why once the bare name passes a tenth of the walked files', () => {
    const root = tempProject();
    suite(root, 20, 3, 'status'); // 3 > 20/10

    const [entry] = findTestsReferencing([{ name: 'status' }], root, ['tests']);

    expect(entry.indiscriminate).toBe(true);
    expect(entry.mentioned).toEqual([]);
    // Withheld, not discarded: the entry still exists, because "the name is
    // too common to list" is an answer and silence is not.
    expect(entry.method).toBe('status');
  });

  it('keeps the list at exactly a tenth — the threshold is "more than", not "at least"', () => {
    const root = tempProject();
    suite(root, 20, 2, 'status'); // 2 is not > 20/10

    const [entry] = findTestsReferencing([{ name: 'status' }], root, ['tests']);

    expect(entry.indiscriminate).toBe(false);
    expect(entry.mentioned).toHaveLength(2);
  });

  it('never withholds the IMPORT list, however common the name', () => {
    const root = tempProject();
    for (let i = 0; i < 20; i += 1) {
      write(root, `tests/f${i}.test.ts`, "import { status } from '../src/status.js';");
    }

    const [entry] = findTestsReferencing([{ name: 'status' }], root, ['tests']);

    expect(entry.imported).toHaveLength(20);
    // Nothing MENTIONS it without importing it, so nothing was withheld.
    expect(entry.indiscriminate).toBe(false);
  });
});

describe('findTestsReferencing — what it refuses to walk', () => {
  it('walks nothing and answers empty when the project declares no test roots', () => {
    const root = tempProject();
    write(root, 'tests/billing.test.ts', "import { runBilling } from '../src/billing.js';");

    expect(findTestsReferencing([{ name: 'runBilling' }], root, [])).toEqual([]);
    expect(findTestsReferencing([{ name: 'runBilling' }], root)).toEqual([]);
  });

  it('refuses a root that escapes the project root rather than walking it', () => {
    const root = tempProject();
    const outside = tempProject();
    // A real file with a real match, sitting where a containment refusal is
    // the only thing that can keep it out of the answer.
    write(outside, 'billing.test.ts', "import { runBilling } from '../src/billing.js';");

    expect(findTestsReferencing([{ name: 'runBilling' }], root, [`../${path.basename(outside)}`])).toEqual([]);
    expect(findTestsReferencing([{ name: 'runBilling' }], root, [outside])).toEqual([]);
  });

  it('skips a test file it cannot read instead of failing the search', () => {
    const root = tempProject();
    // Text the search WOULD match, behind bytes that say the file is not text.
    // Skipping it has to be what keeps it out of the answer — an assertion
    // that would pass on an empty file proves nothing.
    write(root, 'tests/binary.test.ts', Buffer.concat([
      Buffer.from("import { runBilling } from '../src/billing.js';"),
      Buffer.from([0x00, 0x01, 0x00]),
    ]));
    write(root, 'tests/real.test.ts', "import { runBilling } from '../src/billing.js';");

    expect(() => findTestsReferencing([{ name: 'runBilling' }], root, ['tests'])).not.toThrow();
    const [entry] = findTestsReferencing([{ name: 'runBilling' }], root, ['tests']);

    expect(entry.imported).toEqual(['tests/real.test.ts']);
  });

  it('never descends into node_modules or a dot-directory', () => {
    const root = tempProject();
    write(root, 'tests/node_modules/dep/dep.test.ts', "import { runBilling } from '../src/billing.js';");
    write(root, 'tests/.cache/cached.test.ts', "import { runBilling } from '../src/billing.js';");

    expect(findTestsReferencing([{ name: 'runBilling' }], root, ['tests'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The pattern tables are shared module state
//
// This search reuses the JS table's named-import clause rather than forking it,
// which is only safe while those patterns are stateless between files. They
// were not: `matchAll` CLONES a regex together with its `lastIndex`, and the
// export-marker scan drives the same patterns with `exec`, which leaves one
// behind on a match. The next file scanned with that pattern then starts part
// way in. Pinned on RUST, where the pattern grade is reachable — for TypeScript
// the exact analyzer always wins here, so the same defect would sit untested.
// ---------------------------------------------------------------------------

describe('the shared declaration patterns carry no offset between files', () => {
  it('reads a declaration at the head of a file scanned after an exported one', () => {
    const root = tempProject();
    // `pub fn` matches the export marker, so the declaration pattern is exec'd
    // and left pointing past "fn alpha_one" — index 16.
    write(root, 'src/a.rs', 'pub fn alpha_one() {}\n');
    // Whose declaration sits before index 16, and disappears if the offset rides.
    write(root, 'src/b.rs', 'fn beta_two() {}\n');

    const model = buildCodeModel([], [], root, ['src']);
    const b = model.files.find(f => f.path === 'src/b.rs');

    expect(b?.analysisGrade).toBe('pattern');
    expect(b?.declaredNames).toContain('beta_two');
  });
});

describe('the validator\'s forward (ispec_validator/ivalidator_portal.findTestsReferencing)', () => {
  it('answers exactly what the source analyzer answers', () => {
    const root = tempProject();
    write(root, 'tests/billing.test.ts', "import { runBilling } from '../src/billing.js';");

    expect(findThroughValidator([{ name: 'runBilling' }], root, ['tests']))
      .toEqual(findTestsReferencing([{ name: 'runBilling' }], root, ['tests']));
  });

  it('answers empty rather than throwing when no test roots are declared', () => {
    const root = tempProject();
    expect(() => findThroughValidator([{ name: 'runBilling' }], root, [])).not.toThrow();
    expect(findThroughValidator([{ name: 'runBilling' }], root, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The gated write (iauthoring_orchestrator.updateSpecGated)
// ---------------------------------------------------------------------------

/** A project holding one implementation with one narrated method, and a suite that encodes it. */
function seedGatedProject(testRoots?: string[]): string {
  invalidateSpecCache();
  const proj = tempProject();
  fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'revisit-project',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: testRoots ? { conformance: { testRoots } } : {},
    createdAt: now,
    updatedAt: now,
  }));
  setProjectRoot(proj);

  saveSubsystemSpec({
    schemaVersion: '1.0.0', id: 'billing', name: 'Billing', description: 'Billing',
    parentSystem: 'GK', publicInterfaces: [], createdAt: now, updatedAt: now,
  });
  saveComponentSpec({
    id: 'flow_comp', name: 'Flow', description: 'The flow', subsystem: 'billing',
    componentType: 'Orchestrator', owns: [], dependsOn: [], status: 'complete',
    createdAt: now, updatedAt: now,
  });
  saveInterfaceSpec({
    id: 'iflow', name: 'IFlow', description: 'The flow contract', component: 'flow_comp',
    methods: [{
      name: 'run', description: 'runs the flow', signature: 'run(payload: string)', returns: 'void',
      params: [{ name: 'payload', type: 'string', description: 'what to run' }],
    }],
    status: 'complete', createdAt: now, updatedAt: now,
  });
  saveImplementationSpec({
    id: 'flow_impl', name: 'FlowImpl', description: 'The flow implementation', contract: 'iflow',
    methods: [{
      name: 'run',
      narrative: [{ stepNumber: 1, description: 'Do the work', type: 'local' }],
    } as never],
    status: 'complete', createdAt: now, updatedAt: now,
  });
  invalidateSpecCache();

  write(proj, 'tests/flow.test.ts', "import { run } from '../src/flow.js';\nit('runs', () => run(''));");
  return proj;
}

describe('updateSpecGated — the write names the tests it just invalidated', () => {
  it('carries the tests to revisit when the write changed a method', () => {
    seedGatedProject(['tests']);

    const report = updateSpecGated('implementation', 'flow_impl', {
      methods: [{
        name: 'run',
        narrative: [{ stepNumber: 1, description: 'Do the work differently now', type: 'local' }],
      }],
    });

    expect(report.written).toBe(true);
    expect(report.testsToRevisit).toHaveLength(1);
    expect(report.testsToRevisit[0]).toMatchObject({
      method: 'run',
      symbol: 'run',
      imported: ['tests/flow.test.ts'],
      mentioned: [],
      indiscriminate: false,
    });
  });

  it('searches the symbol the delta gives the method, not its contract name', () => {
    const proj = seedGatedProject(['tests']);
    write(proj, 'tests/flow.test.ts', "import { runFlow } from '../src/flow.js';\nit('runs', () => runFlow(''));");

    const report = updateSpecGated('implementation', 'flow_impl', {
      methods: [{ name: 'run', symbol: 'runFlow' }],
    });

    expect(report.testsToRevisit[0]).toMatchObject({
      method: 'run',
      symbol: 'runFlow',
      imported: ['tests/flow.test.ts'],
    });
  });

  it('carries none when the write changed no method', () => {
    seedGatedProject(['tests']);

    const report = updateSpecGated('implementation', 'flow_impl', {
      description: 'The flow implementation, described again.',
    });

    expect(report.written).toBe(true);
    expect(report.changes.map(c => c.path)).toEqual(['description']);
    expect(report.testsToRevisit).toEqual([]);
  });

  it('carries none when the project declares no test roots — opt-in, and never the thing that fails a write', () => {
    seedGatedProject();

    const report = updateSpecGated('implementation', 'flow_impl', {
      methods: [{
        name: 'run',
        narrative: [{ stepNumber: 1, description: 'Do the work differently now', type: 'local' }],
      }],
    });

    expect(report.written).toBe(true);
    expect(report.testsToRevisit).toEqual([]);
  });

  it('carries none when the delta changed nothing at all', () => {
    seedGatedProject(['tests']);

    const report = updateSpecGated('implementation', 'flow_impl', {
      methods: [{ name: 'run', narrative: [{ stepNumber: 1, description: 'Do the work', type: 'local' }] }],
    });

    expect(report.written).toBe(false);
    expect(report.testsToRevisit).toEqual([]);
  });

  it('names them on a DRY RUN too — the question is worth asking before the write, not after', () => {
    seedGatedProject(['tests']);

    const report = updateSpecGated('implementation', 'flow_impl', {
      methods: [{
        name: 'run',
        narrative: [{ stepNumber: 1, description: 'Do the work differently now', type: 'local' }],
      }],
    }, true);

    expect(report.dryRun).toBe(true);
    expect(report.written).toBe(false);
    expect(report.testsToRevisit.map(e => e.method)).toEqual(['run']);
  });
});

// ---------------------------------------------------------------------------
// F75 — a binding binds ONE module
//
// Removing eleven thin adapter methods named like core's functions once listed
// ~250 test files: every test that imported CORE's function of the same name.
// None of them tested the adapter. A method whose realizing file is known is
// searched by module: an import counts only when it resolves to that file or
// to a module re-exporting the name from there.
// ---------------------------------------------------------------------------

describe('findTestsReferencing — resolved by the module a test imports FROM (F75)', () => {
  /**
   * The shape that flooded: core realizes saveSpec/loadSpec, an adapter module
   * republishes them by identity under the same names, and most of the suite
   * imports core's functions directly.
   */
  const floodShape = (root: string): void => {
    write(root, 'src/core/specs.ts', 'export function saveSpec() {}\nexport function loadSpec() {}\n');
    write(root, 'src/core/adapters/authoring-core.ts', "export { saveSpec, loadSpec } from '../specs.js';\n");
    for (let i = 0; i < 12; i += 1) {
      write(root, `tests/core/specs${i}.test.ts`, "import { saveSpec, loadSpec } from '../../src/core/specs.js';\nit('saves', () => saveSpec());");
    }
    write(root, 'tests/core/adapter.test.ts', "import { saveSpec } from '../../src/core/adapters/authoring-core.js';\nit('forwards', () => saveSpec());");
  };

  it('counts no test that imports the PROVIDER\'s same-named function when the removed method is the adapter\'s', () => {
    const root = tempProject();
    floodShape(root);
    const found = findTestsReferencing(
      [{ name: 'saveSpec', sourcePath: 'src/core/adapters/authoring-core.ts' }, { name: 'loadSpec', sourcePath: 'src/core/adapters/authoring-core.ts' }],
      root,
      ['tests'],
    );
    // saveSpec: only the adapter's own test. loadSpec: every file naming it binds
    // it to core, so nothing names the adapter's method at all — no entry, and
    // not a withheld "indiscriminate" mention list either.
    expect(found).toEqual([
      { method: 'saveSpec', symbol: 'saveSpec', imported: ['tests/core/adapter.test.ts'], mentioned: [], indiscriminate: false },
    ]);
  });

  it('counts a test importing through a module that RE-EXPORTS the method from its file, aliased or not, through a chain', () => {
    const root = tempProject();
    floodShape(root);
    write(root, 'src/core/index.ts', "export { saveSpec as storeSpec } from './adapters/authoring-core.js';\n");
    write(root, 'src/barrel.ts', "export * from './core/index.js';\n");
    write(root, 'tests/barrel.test.ts', "import { storeSpec } from '../src/barrel.js';\nit('stores', () => storeSpec());");
    const found = findTestsReferencing([{ name: 'saveSpec', sourcePath: 'src/core/specs.ts' }], root, ['tests']);
    // Every one of them reaches core's saveSpec: directly, through the adapter's
    // identity re-export, and through an aliased re-export behind a star barrel.
    expect(found[0].imported).toEqual([
      'tests/barrel.test.ts',
      'tests/core/adapter.test.ts',
      ...Array.from({ length: 12 }, (_, i) => `tests/core/specs${i}.test.ts`).sort(),
    ].sort());
  });

  it('keeps a prose or string mention as a mention, and drops a file that binds the name to another module', () => {
    const root = tempProject();
    write(root, 'src/billing.ts', 'export function runBilling() {}\n');
    write(root, 'src/legacy.ts', 'export function runBilling() {}\n');
    write(root, 'tests/portal.test.ts', "// drives runBilling through the portal\nit('bills', () => portal.handle('runBilling'));");
    write(root, 'tests/legacy.test.ts', "import { runBilling } from '../src/legacy.js';\nit('bills', () => runBilling());");
    write(root, 'tests/billing.test.ts', "import * as billing from '../src/billing.js';\nit('bills', () => billing.runBilling());");
    for (let i = 0; i < 20; i += 1) write(root, `tests/filler${i}.test.ts`, "it('x', () => 1);");
    const found = findTestsReferencing([{ name: 'runBilling', sourcePath: 'src/billing.ts' }], root, ['tests']);
    expect(found).toEqual([{
      method: 'runBilling',
      symbol: 'runBilling',
      // A namespace import of the method's own module that names the symbol.
      imported: ['tests/billing.test.ts'],
      mentioned: ['tests/portal.test.ts'],
      indiscriminate: false,
    }]);
  });

  it('reads a destructured dynamic import like a static one', () => {
    const root = tempProject();
    write(root, 'src/billing.ts', 'export function runBilling() {}\n');
    write(root, 'tests/lazy.test.ts', "it('bills', async () => { const { runBilling: run } = await import('../src/billing.js'); run(); });");
    const found = findTestsReferencing([{ name: 'runBilling', sourcePath: 'src/billing.ts' }], root, ['tests']);
    expect(found[0].imported).toEqual(['tests/lazy.test.ts']);
  });

  it('merges a method realized in several files into one entry, imported from any of them', () => {
    const root = tempProject();
    write(root, 'src/a.ts', 'export function run() {}\n');
    write(root, 'src/b.ts', 'export function run() {}\n');
    write(root, 'tests/a.test.ts', "import { run } from '../src/a.js';\nit('a', () => run());");
    write(root, 'tests/b.test.ts', "import { run } from '../src/b.js';\nit('b', () => run());");
    const found = findTestsReferencing([{ name: 'run', sourcePath: 'src/a.ts' }, { name: 'run', sourcePath: 'src/b.ts' }], root, ['tests']);
    expect(found).toHaveLength(1);
    expect(found[0].imported).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
  });

  it('searches by name alone, as before, when no spec places the method in a file', () => {
    const root = tempProject();
    floodShape(root);
    const found = findTestsReferencing([{ name: 'loadSpec' }], root, ['tests']);
    expect(found[0].imported).toHaveLength(12);
  });

  it('the gated write resolves a CONTRACT method to its realization\'s file, so a same-named import elsewhere is not its test', () => {
    const proj = seedGatedProject(['tests']);
    saveImplementationSpec({
      id: 'flow_impl', name: 'FlowImpl', description: 'The flow implementation', contract: 'iflow',
      sourcePath: 'src/adapters/flow.ts',
      methods: [{ name: 'run', narrative: [{ stepNumber: 1, description: 'Do the work', type: 'local' }] } as never],
      status: 'complete', createdAt: now, updatedAt: now,
    });
    invalidateSpecCache();
    write(proj, 'src/flow.ts', 'export function run(payload: string) {}\n');
    write(proj, 'src/adapters/flow.ts', "export { run } from '../flow.js';\n");
    write(proj, 'tests/adapter.test.ts', "import { run } from '../src/adapters/flow.js';\nit('forwards', () => run(''));");
    write(proj, 'tests/other.test.ts', "import { run } from '../src/other.js';\nit('other', () => run(''));");

    const report = updateSpecGated('interface', 'iflow', {
      methods: [{ name: 'run', description: 'runs the flow, now differently' }],
    });
    // tests/flow.test.ts imports the PROVIDER (src/flow.js), which is not the
    // adapter's file and re-exports nothing from it; tests/other.test.ts binds
    // the name to a module of its own. Only the adapter's own test remains.
    expect(report.testsToRevisit).toEqual([
      { method: 'run', symbol: 'run', imported: ['tests/adapter.test.ts'], mentioned: [], indiscriminate: false },
    ]);
  });
});
