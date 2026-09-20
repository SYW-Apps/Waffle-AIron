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
import { findTestsReferencing } from '../../src/core/source-analysis.js';
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
