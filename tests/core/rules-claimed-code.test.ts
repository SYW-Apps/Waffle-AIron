/**
 * Claiming code — the two halves of "conformance that never goes quiet":
 *
 *  - the SOURCE-ROOT WALK and the pure-re-export-barrel fact, both produced by
 *    the source analysis adapter (src/core/source-analysis.ts),
 *  - the TYPE CLAIM itself: a type's sourcePath is judged exactly as an
 *    implementation's is, so a claim on a file that does not exist, or that
 *    escapes the root, is reported rather than quietly skipped.
 *
 * The end-to-end firing of UNREALIZED_TYPE, UNREALIZED_TYPE_METHOD,
 * UNCLAIMED_SOURCE_FILE and STALE_UNCLAIMED_ENTRY is pinned by the rule-matrix
 * tier (tests/rules-matrix/families/conformance-claims.fixtures.ts); what is
 * pinned here is the machinery underneath, which no fixture can reach.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCodeModel } from '../../src/core/source-analysis.js';
import { buildRuleContext } from '../../src/core/rules/index.js';
import { typeRealizationRule } from '../../src/core/rules/conformance/type-realization.js';
import { typeSourceFiles, type TypeSpec } from '../../src/models/specs.js';
import type { ValidationIssue } from '../../src/core/validation.js';

const mkTemp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-claim-')));

const write = (dir: string, rel: string, content: string): void => {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

const type = (over: Partial<TypeSpec> & { id: string; name: string }): TypeSpec => ({
  kind: 'value-object',
  description: 'A domain type of this scenario.',
  fields: [],
  methods: [],
  createdAt: '2026-09-01T10:00:00Z',
  updatedAt: '2026-09-01T10:00:00Z',
  ...over,
} as TypeSpec);

/** Run type-realization alone over a set of types against a real temp project. */
function findingsFor(dir: string, types: TypeSpec[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const codeModel = buildCodeModel([], types, dir);
  const ctx = buildRuleContext({
    system: { schemaVersion: '1.0.0', name: 'ClaimSystem', vision: 'v', createdAt: '', updatedAt: '' },
    subsystems: [], components: [], interfaces: [], implementations: [], types,
    projectType: 'backend', codeModel, roundTripIssues: [],
    knownIssueCodes: new Set(typeRealizationRule.codes.map((c) => c.code)),
    issues,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  typeRealizationRule.check(ctx);
  return issues;
}

describe('buildCodeModel — the source-root walk', () => {
  it('walks a directory root recursively and keeps only files whose extension names a known language', () => {
    const dir = mkTemp();
    try {
      write(dir, 'src/billing/invoice.ts', 'export interface Invoice { id: string; }\n');
      write(dir, 'src/billing/rates.py', 'def rate():\n    return 1\n');
      write(dir, 'src/billing/README.md', '# not source\n');
      write(dir, 'src/billing/fixtures.json', '{}\n');
      const model = buildCodeModel([], [], dir, ['src']);
      expect(model.rootFiles.sort()).toEqual(['src/billing/invoice.ts', 'src/billing/rates.py']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('takes a root that names a single file as itself, and finds nothing when no root is declared', () => {
    const dir = mkTemp();
    try {
      write(dir, 'src/billing/invoice.ts', 'export interface Invoice { id: string; }\n');
      write(dir, 'src/billing/ledger.ts', 'export interface Ledger { id: string; }\n');
      expect(buildCodeModel([], [], dir, ['src/billing/invoice.ts']).rootFiles).toEqual(['src/billing/invoice.ts']);
      expect(buildCodeModel([], [], dir).rootFiles).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('never descends into node_modules or a dot-directory, so a broad root cannot turn pathological', () => {
    const dir = mkTemp();
    try {
      write(dir, 'src/billing/invoice.ts', 'export interface Invoice { id: string; }\n');
      write(dir, 'src/node_modules/left-pad/index.js', 'module.exports = 1;\n');
      write(dir, 'src/.cache/build/tmp.ts', 'export const cached = 1;\n');
      expect(buildCodeModel([], [], dir, ['src']).rootFiles).toEqual(['src/billing/invoice.ts']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('leaves out a path at, or under, an exclude entry entirely — vendored code is neither reported nor carried as debt', () => {
    const dir = mkTemp();
    try {
      write(dir, 'src/billing/invoice.ts', 'export interface Invoice { id: string; }\n');
      write(dir, 'src/vendor/barcode.min.js', 'export function decode(){return 1}\n');
      write(dir, 'src/generated.ts', 'export const generated = 1;\n');
      const model = buildCodeModel([], [], dir, ['src'], ['src/vendor', 'src/generated.ts']);
      expect(model.rootFiles).toEqual(['src/billing/invoice.ts']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses an absolute or parent-escaping root by containment, exactly as a sourcePath is refused', () => {
    const dir = mkTemp();
    const outside = mkTemp();
    try {
      write(dir, 'src/billing/invoice.ts', 'export interface Invoice { id: string; }\n');
      write(outside, 'secrets/keys.ts', 'export const key = 1;\n');
      const model = buildCodeModel([], [], dir, [outside, '../', 'src']);
      expect(model.rootFiles).toEqual(['src/billing/invoice.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('analyzes the walked files like any other path, so the barrel exemption has facts to read', () => {
    const dir = mkTemp();
    try {
      write(dir, 'src/billing/invoice.ts', 'export interface Invoice { id: string; }\n');
      const model = buildCodeModel([], [], dir, ['src']);
      const facts = model.files.find((f) => f.path === 'src/billing/invoice.ts');
      expect(facts?.status).toBe('analyzed');
      expect(facts?.exportedNames).toContain('Invoice');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('source_file_facts.reexportOnly — what a pure re-export barrel is', () => {
  const barrelFact = (source: string): boolean | undefined => {
    const dir = mkTemp();
    try {
      write(dir, 'src/billing/target.ts', 'export interface Invoice { id: string; }\n');
      write(dir, 'src/billing/entry.ts', source);
      return buildCodeModel([], [], dir, ['src']).files
        .find((f) => f.path === 'src/billing/entry.ts')?.reexportOnly;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };

  it('is a file whose every top-level statement re-exports another module', () => {
    expect(barrelFact("export * from './target.js';\n")).toBe(true);
    expect(barrelFact("export * from './target.js';\nexport * as invoices from './target.js';\n")).toBe(true);
    expect(barrelFact("export { Invoice } from './target.js';\n")).toBe(true);
  });

  it('is NOT a file that declares anything of its own, imports for a side effect, or re-exports a local name', () => {
    expect(barrelFact("export * from './target.js';\nexport const VERSION = 1;\n")).toBe(false);
    expect(barrelFact("import './target.js';\nexport * from './target.js';\n")).toBe(false);
    expect(barrelFact('const local = 1;\nexport { local };\n')).toBe(false);
    expect(barrelFact('')).toBe(false);
  });

  it('survives the barrel chase, which fills declaredNames with everything the barrel publishes', () => {
    const dir = mkTemp();
    try {
      write(dir, 'src/billing/target.ts', 'export interface Invoice { id: string; }\n');
      write(dir, 'src/billing/entry.ts', "export * from './target.js';\n");
      const facts = buildCodeModel([], [], dir, ['src']).files.find((f) => f.path === 'src/billing/entry.ts');
      // The chase republished the name — which is exactly why the fact cannot
      // be derived from declaredNames after the fact.
      expect(facts?.declaredNames).toContain('Invoice');
      expect(facts?.reexportOnly).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('type_spec.sourceFiles', () => {
  it('lists the type\'s own path then each method\'s, deduplicated, in declaration order', () => {
    expect(typeSourceFiles(type({
      id: 'invoice', name: 'Invoice', sourcePath: 'src/billing/invoice.ts',
      methods: [
        { name: 'total', signature: 'total(): number', returns: 'number', sourcePath: 'src/billing/totals.ts' },
        { name: 'tax', signature: 'tax(): number', returns: 'number', sourcePath: 'src/billing/totals.ts' },
        { name: 'id', signature: 'id(): string', returns: 'string' },
      ],
    }))).toEqual(['src/billing/invoice.ts', 'src/billing/totals.ts']);
    expect(typeSourceFiles(type({ id: 'invoice', name: 'Invoice' }))).toEqual([]);
  });
});

describe('type-realization — a type claim is judged like every other claim on code', () => {
  it('reports a type sourcePath that resolves to no file, naming the type', () => {
    const dir = mkTemp();
    try {
      const issues = findingsFor(dir, [type({ id: 'invoice', name: 'Invoice', sourcePath: 'src/billing/invoice.ts' })]);
      expect(issues.map((i) => i.code)).toEqual(['MISSING_SOURCE_FILE']);
      expect(issues[0].message).toContain('Type "invoice"');
      expect(issues[0].specId).toBe('invoice');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports a type sourcePath that escapes the project root, and blocks nothing else on that file', () => {
    const dir = mkTemp();
    try {
      const issues = findingsFor(dir, [type({ id: 'invoice', name: 'Invoice', sourcePath: '../elsewhere/invoice.ts' })]);
      expect(issues.map((i) => i.code)).toEqual(['SOURCE_PATH_ESCAPES_ROOT']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('names the methods that pointed at a broken file, not the type, when the file is a method\'s own', () => {
    const dir = mkTemp();
    try {
      write(dir, 'src/billing/invoice.ts', 'export interface Invoice { id: string; }\n');
      const issues = findingsFor(dir, [type({
        id: 'invoice', name: 'Invoice', sourcePath: 'src/billing/invoice.ts',
        methods: [{ name: 'total', signature: 'total(): number', returns: 'number', sourcePath: 'src/billing/totals.ts' }],
      })]);
      expect(issues.map((i) => i.code)).toEqual(['MISSING_SOURCE_FILE']);
      expect(issues[0].message).toContain('method "total"');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('stays silent for a type that claims nothing at all', () => {
    const dir = mkTemp();
    try {
      expect(findingsFor(dir, [type({ id: 'invoice', name: 'Invoice' })])).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('accepts a declaration-tier anchor for a method — an interface member is not an export of its own', () => {
    const dir = mkTemp();
    try {
      write(dir, 'src/billing/invoice.ts', 'export interface Invoice { id: string; total(): number; }\n');
      expect(findingsFor(dir, [type({
        id: 'invoice', name: 'Invoice', sourcePath: 'src/billing/invoice.ts',
        methods: [{ name: 'total', signature: 'total(): number', returns: 'number' }],
      })])).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
