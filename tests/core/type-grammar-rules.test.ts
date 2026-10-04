/**
 * Stage 2's rules wave: the analyzer facts the grammar's conformance rules
 * read (asyncFunctions, enumValues, the file's dialect), and the deprecated
 * pack field the extension loader merges away. The rules themselves are
 * pinned fire-and-control in tests/rules-matrix; this file pins the facts
 * underneath them.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCodeModel } from '../../src/core/source-analysis.js';
import { loadExtensions } from '../../src/core/extensions.js';
import { dialectOf, parseTypeExpression, type SourceFileFacts } from '../../src/models/index.js';

const mkTemp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-grammar-rules-'));

/** The exact-grade facts of one TypeScript file. */
function factsOf(source: string): SourceFileFacts {
  const dir = mkTemp();
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'subject.ts'), source);
    const model = buildCodeModel([{
      id: 'subject_impl', name: 'Subject', description: 'd', contract: 'isubject',
      sourcePath: 'src/subject.ts', methods: [], status: 'complete' as const,
      createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z',
    }], [], dir);
    expect(model.files[0].analysisGrade).toBe('exact');
    return model.files[0];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('source_file_facts.asyncFunctions', () => {
  it('lists each body that completes later — declared async or annotated to return a Promise — once per body', () => {
    const facts = factsOf([
      'export async function bookCollection(id: string): Promise<void> { await Promise.resolve(id); }',
      'export function quoteLater(id: string): Promise<number> { return Promise.resolve(id.length); }',
      'export const releaseHold = async (id: string) => { await Promise.resolve(id); };',
      'export function quoteNow(id: string): number { return id.length; }',
      'export function forwarded(id: string) { return quoteLater(id); }',
      'class Dock { async bookCollection(id: string): Promise<void> { await Promise.resolve(id); } }',
      'export const dock = new Dock();',
    ].join('\n'));
    // Two bodies under bookCollection, both async: two entries, beside two signatures.
    expect(facts.asyncFunctions?.filter((n) => n === 'bookCollection')).toHaveLength(2);
    expect(facts.functionParams?.bookCollection).toHaveLength(2);
    expect(facts.asyncFunctions).toContain('quoteLater');
    expect(facts.asyncFunctions).toContain('releaseHold');
    // Completing now, and returning an inferred promise, are not declared async.
    expect(facts.asyncFunctions).not.toContain('quoteNow');
    expect(facts.asyncFunctions).not.toContain('forwarded');
  });
});

describe('source_file_facts.enumValues', () => {
  it('reads a string-literal union alias, a z.enum constant (and the alias inferring from it), and a string enum', () => {
    const facts = factsOf([
      "import { z } from 'zod';",
      "export type ParcelSize = 'small' | 'medium' | 'large';",
      "export const ShipmentStatusSchema = z.enum(['picked', 'in-transit', 'delivered']).default('picked');",
      'export type ShipmentStatus = z.infer<typeof ShipmentStatusSchema>;',
      "const CARRIERS = ['dhl', 'ups'] as const;",
      'export const CarrierSchema = z.enum(CARRIERS);',
      "export enum Lane { Inbound = 'inbound', Outbound = 'outbound' }",
    ].join('\n'));
    expect(facts.enumValues?.ParcelSize).toEqual(['small', 'medium', 'large']);
    expect(facts.enumValues?.ShipmentStatusSchema).toEqual(['picked', 'in-transit', 'delivered']);
    expect(facts.enumValues?.ShipmentStatus).toEqual(['picked', 'in-transit', 'delivered']);
    expect(facts.enumValues?.CarrierSchema).toEqual(['dhl', 'ups']);
    expect(facts.enumValues?.Lane).toEqual(['inbound', 'outbound']);
  });

  it('records nothing for a union mixing in a non-literal, or an enum that is not all strings', () => {
    const facts = factsOf([
      "export type Weight = 'light' | number;",
      'export enum Priority { Low = 1, High = 2 }',
      "export enum Mixed { A = 'a', B }",
    ].join('\n'));
    expect(facts.enumValues?.Weight).toBeUndefined();
    expect(facts.enumValues?.Priority).toBeUndefined();
    expect(facts.enumValues?.Mixed).toBeUndefined();
  });
});

describe('source_file_facts.dialect', () => {
  it('answers the TypeScript dialect for a TypeScript file, reading its spelling into the neutral grammar', () => {
    const facts = factsOf('export function quote(bands: string[]): number { return bands.length; }');
    const dialect = dialectOf(facts);
    expect(dialect?.language).toBe('typescript');
    const spec = parseTypeExpression('list<string>', 'param').expression!;
    expect(dialect?.agrees('string[]', spec, new Map())).toBe(true);
    expect(dialect?.agrees('Set<string>', spec, new Map())).toBe(false);
  });

  it('answers none for a file with no language a dialect reads', () => {
    expect(dialectOf({ path: 'flow.py', status: 'analyzed', language: 'python', declaredNames: [], anchoredNames: [], exportedNames: [], imports: [], reexports: [] })).toBeNull();
    expect(dialectOf({ path: 'notes.txt', status: 'analyzed', declaredNames: [], anchoredNames: [], exportedNames: [], imports: [], reexports: [] })).toBeNull();
  });
});

describe('loaded_extensions.deprecations', () => {
  it('merges a language without its deprecated foreignBuiltins and records the deprecation', () => {
    const dir = mkTemp();
    try {
      const packDir = path.join(dir, 'packs', 'plant-floor');
      fs.mkdirSync(packDir, { recursive: true });
      fs.writeFileSync(path.join(packDir, 'pack.yaml'), [
        'name: plant-floor',
        'version: 1.0.0',
        'languages:',
        '  structured-text:',
        '    unsupportedFlow:',
        '      try: return a status word instead',
        '    foreignBuiltins: [TIME, DINT]',
        '',
      ].join('\n'));
      const loaded = loadExtensions(['./packs/plant-floor'], dir);
      expect(loaded.errors).toEqual([]);
      expect(loaded.languages['structured-text']).toEqual({ unsupportedFlow: { try: 'return a status word instead' } });
      expect(loaded.deprecations).toHaveLength(1);
      expect(loaded.deprecations[0]).toContain('plant-floor: languages.structured-text.foreignBuiltins');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records nothing for a pack that does not declare it', () => {
    const dir = mkTemp();
    try {
      const packDir = path.join(dir, 'packs', 'plant-floor');
      fs.mkdirSync(packDir, { recursive: true });
      fs.writeFileSync(path.join(packDir, 'pack.yaml'), 'name: plant-floor\nversion: 1.0.0\nlanguages:\n  structured-text:\n    unsupportedFlow: {}\n');
      expect(loadExtensions(['./packs/plant-floor'], dir).deprecations).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
