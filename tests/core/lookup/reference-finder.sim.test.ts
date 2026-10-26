import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setProjectRoot } from '../../../src/utils/fs.js';
import { invalidateSpecCache, saveSpec, saveSystemSpec } from '../../../src/core/specs.js';
import { WAIRON_MAJOR } from '../../../src/config/defaults.js';
import { lookupProject } from '../../helpers/lookup-fixture.js';
// The real modules of the component and of each direct dependency: no fakes.
import { collect } from '../../../src/core/lookup/reference-finder.js';
import { find } from '../../../src/core/lookup/spec-search.js';
import { current } from '../../../src/core/lookup/code-model-loader.js';
import { findTestsReferencing } from '../../../src/core/source-analysis.js';
import * as validatorCore from '../../../src/core/adapters/validator-core.js';

// Integration sim for reference_finder: the real finder, search, code model and
// test scan against a small real spec tree whose code mostly agrees with it.
describe('sim: reference_finder.collect', () => {
  const fixture = lookupProject();
  beforeAll(() => { setProjectRoot(fixture.root); invalidateSpecCache(); });
  afterAll(() => fixture.cleanup());

  it('wires its real dependencies', () => {
    for (const fn of [find, current, findTestsReferencing, validatorCore.scanAllSpecs, validatorCore.projectFamily]) expect(typeof fn).toBe('function');
  });

  const ofMethod = () => collect('ledger.record');

  it('confirms a declared call the code also makes, with its line on the code side', () => {
    const r = ofMethod();
    expect(r.target).toMatchObject({ id: 'ledger.record', kind: 'method' });
    const declared = r.references.find((x) => x.kind === 'call-step' && x.fromSpec === 'orders_impl');
    expect(declared).toMatchObject({ evidence: 'declared', agreement: 'confirmed', fromMember: 'placeOrder', linked: true });
    const code = r.references.find((x) => x.kind === 'code-call' && x.file === 'src/orders.ts');
    expect(code).toMatchObject({ evidence: 'resolved', agreement: 'confirmed', fromSpec: 'orders_impl', line: 4 });
  });

  it('names a declared call the code does not make as declared-only', () => {
    const declared = ofMethod().references.find((x) => x.kind === 'call-step' && x.fromSpec === 'reports_impl');
    expect(declared).toMatchObject({ evidence: 'declared', agreement: 'declared-only' });
  });

  it('names a code call the design never declared as observed-only', () => {
    const code = ofMethod().references.find((x) => x.kind === 'code-call' && x.file === 'src/audit.ts');
    expect(code).toMatchObject({ evidence: 'resolved', agreement: 'observed-only', fromSpec: 'audit_impl', line: 4 });
  });

  it('marks a test that imports the method as inTest, apart from the code', () => {
    const tests = ofMethod().references.filter((x) => x.inTest);
    expect(tests).toEqual([expect.objectContaining({ kind: 'import', evidence: 'syntactic', file: 'tests/ledger.test.ts', inTest: true })]);
    expect(ofMethod().references.filter((x) => !x.inTest && x.file?.startsWith('tests/'))).toEqual([]);
  });

  it('answers candidates and no references for an ambiguous target', () => {
    const r = collect('sync');
    expect(r.target).toBeNull();
    expect(r.candidates.map((c) => c.id).sort()).toEqual(['audit.sync', 'orders.sync']);
    expect(r.references).toEqual([]);
    expect(r.impact).toBe('none');
    expect(r.snapshot.codeGrade).toBe('exact');
  });

  it('judges the impact as the widest place a reference sits, widening to project across subsystems', () => {
    expect(ofMethod().impact).toBe('subsystem');
    fixture.addComponent({ id: 'invoicing', subsystem: 'billing', dependsOn: ['ledger'], methods: [{ name: 'invoice', calls: ['ledger', 'record'] }] });
    const widened = ofMethod();
    expect(widened.references.some((x) => x.fromSpec === 'invoicing_impl')).toBe(true);
    expect(widened.impact).toBe('project');
  });

  it('lists a component by its dependsOn, and a text mention apart from the linked ones', () => {
    const r = collect('ledger');
    expect(r.references.filter((x) => x.kind === 'depends-on').map((x) => x.fromSpec)).toEqual(expect.arrayContaining(['orders', 'reports']));
    const none = collect('ledger', false);
    expect(none.references.some((x) => x.kind === 'mention' && !x.inTest)).toBe(false);
  });

  it('lists the unclaimed waiver for an unclaimed file', () => {
    const r = collect('src/orphan.ts');
    expect(r.target).toMatchObject({ id: 'src/orphan.ts', kind: 'file' });
    expect(r.waivers).toEqual([expect.objectContaining({ kind: 'unclaimed', subject: 'src/orphan.ts' })]);
  });

  it('finds a code file target through its implementation', () => {
    const r = collect('src/ledger.ts');
    expect(r.target).toMatchObject({ id: 'ledger_impl', kind: 'implementation' });
    expect(r.references.some((x) => x.kind === 'code-call' && x.file === 'src/orders.ts')).toBe(true);
    expect(r.references.some((x) => x.kind === 'import' && x.file === 'src/orders.ts' && !x.inTest)).toBe(true);
  });

  it('answers the snapshot the search wrote and an element nothing refers to as none', () => {
    const r = collect('shipping.ship');
    expect(r.target).toMatchObject({ id: 'shipping.ship', planned: true });
    expect(r.references).toEqual([]);
    expect(r.impact).toBe('none');
    expect(r.snapshot.searched.join(' ')).toContain('source files walked');
  });
});

describe('sim: reference_finder.collect against the L0 export table', () => {
  const fixture = lookupProject();
  const now = '2026-10-25T10:00:00.000Z';
  const publish = (audience: string): void => {
    setProjectRoot(fixture.root);
    saveSpec('subsystem', { id: 'shop', name: 'shop', description: 'the shop subsystem', parentSystem: 'lookup-sys', publicInterfaces: [{ component: 'reports', details: 'the reports' }], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now } as never);
    saveSystemSpec({
      schemaVersion: '1.0.0', waironMajor: WAIRON_MAJOR, name: 'lookup-sys', vision: 'a lookup fixture', boundaries: [], globalRequirements: [],
      publicInterfaces: [{ as: 'reports-api', from: 'shop', component: 'reports', audience }], createdAt: now, updatedAt: now,
    } as never);
    invalidateSpecCache();
  };
  beforeAll(() => { setProjectRoot(fixture.root); invalidateSpecCache(); });
  afterAll(() => fixture.cleanup());

  it('judges an element exported beyond the family as public, whatever its references show', () => {
    publish('external');
    expect(validatorCore.resolveProjectExports().entries.map((e) => e.publicName)).toContain('reports-api');
    expect(collect('reports').impact).toBe('public');
    expect(collect('reports.report').impact).toBe('public');
  });

  it('keeps an export to the family only, and an element the table does not export, at the widest reference', () => {
    publish('project');
    expect(validatorCore.resolveProjectExports().entries.find((e) => e.publicName === 'reports-api')?.audience).toBe('project');
    expect(collect('reports').impact).not.toBe('public');
    publish('external');
    expect(collect('audit').impact).not.toBe('public');
  });
});

describe('sim: reference_finder.collect through an adapter of identity re-exports', () => {
  const fixture = lookupProject();
  beforeAll(() => {
    setProjectRoot(fixture.root);
    fixture.edit('src/ledger-port.ts', "export { record } from './ledger.js';\n");
    fixture.edit('src/settle.ts', "import { record } from './ledger-port.js';\n\nexport function settle(id: string): void {\n  record(id);\n  const log = { record: (s: string) => s };\n  log.record(id);\n}\n");
    fixture.edit('src/ledger.test.ts', "import { record } from './ledger.js';\n\nexport function check(): void {\n  record('x');\n}\n");
    fixture.addComponent({ id: 'ledger_port', subsystem: 'billing', methods: [{ name: 'record' }], sourcePath: 'src/ledger-port.ts' });
    fixture.addComponent({ id: 'settlement', subsystem: 'billing', dependsOn: ['ledger_port'], methods: [{ name: 'settle', calls: ['ledger_port', 'record'] }], sourcePath: 'src/settle.ts' });
    invalidateSpecCache();
  });
  afterAll(() => fixture.cleanup());

  it('confirms a declared call the code makes through the republished name', () => {
    const r = collect('ledger_port.record');
    expect(r.references.find((x) => x.kind === 'call-step' && x.fromSpec === 'settlement_impl')).toMatchObject({ agreement: 'confirmed' });
    expect(r.references.find((x) => x.kind === 'code-call' && x.file === 'src/settle.ts')).toMatchObject({ evidence: 'resolved', agreement: 'confirmed' });
  });

  it('does not count a call into the forwarded body from a file that never imports the adapter', () => {
    const r = collect('ledger_port.record');
    expect(r.references.some((x) => x.kind === 'code-call' && x.file === 'src/orders.ts')).toBe(false);
  });

  it('gives a call the line it is written on, never the line of a member call of the same name', () => {
    const lines = collect('ledger_port.record').references.filter((x) => x.kind === 'code-call' && x.file === 'src/settle.ts').map((x) => x.line);
    expect(lines).toEqual([4]);
  });

  it("never judges a test's call as a disagreement with the design", () => {
    const tests = collect('ledger.record').references.filter((x) => x.kind === 'code-call' && x.inTest);
    expect(tests.length).toBeGreaterThan(0);
    expect(tests.every((x) => x.agreement === 'unjudged')).toBe(true);
  });

  it('lists a test file once, however many scans find its import', () => {
    const files = collect('ledger.record').references.filter((x) => x.kind === 'import' && x.inTest).map((x) => x.file);
    expect(files.length).toBe(new Set(files).size);
  });
});
