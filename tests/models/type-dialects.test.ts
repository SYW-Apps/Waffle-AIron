import { describe, it, expect } from 'vitest';
import { typeDialectFor } from '../../src/models/type-dialects.js';
import { canonicalTypeText, parseTypeExpression } from '../../src/models/type-grammar.js';

// ---------------------------------------------------------------------------
// The TypeScript dialect: its reader is the grammar's alias table, its writer
// the TypeScript spelling of each canonical form, and its agreement loose
// exactly where TypeScript cannot tell two canonical types apart.
// ---------------------------------------------------------------------------

const ts = typeDialectFor('typescript')!;
const expr = (text: string) => parseTypeExpression(text, 'returns').expression!;

describe('result<T, E> in TypeScript: T, throwing E', () => {
  it('writes the success type, and agrees with an annotation of it (E is never compared)', () => {
    expect(ts.write(expr('result<Invoice, BillingError>'))).toBe('Invoice');
    expect(ts.write(expr('async result<void, BillingError>'))).toBe('Promise<void>');
    expect(ts.agrees('Invoice', expr('result<Invoice, BillingError>'), new Map())).toBe(true);
    expect(ts.agrees('Promise<Invoice[]>', expr('async result<list<Invoice>, BillingError>'), new Map())).toBe(true);
    expect(ts.agrees('string', expr('result<Invoice, BillingError>'), new Map())).toBe(false);
  });

  it('a TypeScript Result<T, E> annotation reads as result<T, E> and agrees with it', () => {
    expect(canonicalTypeText(ts.read('Result<Invoice, BillingError>')!)).toBe('result<Invoice, BillingError>');
    expect(ts.agrees('Result<Invoice, BillingError>', expr('result<Invoice, BillingError>'), new Map())).toBe(true);
  });

  it('carries the mapping in the brief table', () => {
    expect(ts.mappingLines().some((l) => l.startsWith('result<T, E> → T, throwing E'))).toBe(true);
  });
});

describe('type_dialect.forLanguage', () => {
  it('answers the TypeScript dialect for TypeScript and JavaScript files, and none for a language without one', () => {
    expect(ts.language).toBe('typescript');
    expect(typeDialectFor('javascript')).toBe(ts);
    expect(typeDialectFor('TypeScript')).toBe(ts);
    expect(typeDialectFor('rust')).toBeNull();
    expect(typeDialectFor('python')).toBeNull();
  });
});

describe('typescript.read', () => {
  it.each([
    ['string[]', 'list<string>'],
    ['Array<Invoice>', 'list<Invoice>'],
    ['Record<string, boolean>', 'map<string, bool>'],
    ['Map<string, Invoice>', 'map<string, Invoice>'],
    ['Set<string>', 'set<string>'],
    ['Invoice | null', 'Invoice?'],
    ['Invoice | undefined', 'Invoice?'],
    ['Promise<void>', 'async void'],
    ['Buffer', 'bytes'],
    ['Date', 'datetime'],
    ['unknown', 'any'],
    ['object', 'any'],
    ['void', 'void'],
  ])('%s reads as %s', (annotation, canonical) => {
    expect(canonicalTypeText(ts.read(annotation)!)).toBe(canonical);
  });

  it('an annotation with no canonical reading is none, never a guess', () => {
    expect(ts.read('{ a: string }')).toBeNull();
    expect(ts.read('(a: string) => void')).toBeNull();
    expect(ts.read("'a' | 'b'")).toBeNull();
    expect(ts.read('Partial<Invoice>')).toBeNull();
    expect(ts.read('not a type!')).toBeNull();
  });
});

describe('typescript.agrees', () => {
  const names = new Map([['invoice', 'Invoice'], ['billing::invoice', 'Invoice']]);

  it('compares canonical with canonical', () => {
    expect(ts.agrees('string[]', expr('list<string>'), names)).toBe(true);
    expect(ts.agrees('Record<string, boolean>', expr('map<string, bool>'), names)).toBe(true);
    expect(ts.agrees('Promise<void>', expr('async void'), names)).toBe(true);
    expect(ts.agrees('string', expr('list<string>'), names)).toBe(false);
    expect(ts.agrees('boolean', expr('string'), names)).toBe(false);
  });

  it('number agrees with int and float alike — TypeScript cannot tell them apart', () => {
    expect(ts.agrees('number', expr('int'), names)).toBe(true);
    expect(ts.agrees('number', expr('float'), names)).toBe(true);
    expect(ts.agrees('number[]', expr('list<int>'), names)).toBe(true);
    expect(ts.agrees('number', expr('string'), names)).toBe(false);
  });

  it('T | undefined agrees with T?', () => {
    expect(ts.agrees('Invoice | undefined', expr('Invoice?'), names)).toBe(true);
  });

  it('a named type agrees through its code-level name', () => {
    expect(ts.agrees('Invoice', expr('invoice'), names)).toBe(true);
    expect(ts.agrees('Invoice[]', expr('list<billing::invoice>'), names)).toBe(true);
    expect(ts.agrees('Receipt', expr('invoice'), names)).toBe(false);
  });

  it('an annotation the dialect cannot read never agrees', () => {
    expect(ts.agrees('{ a: string }', expr('any'), names)).toBe(false);
  });
});

describe('typescript.write and mappingLines', () => {
  it.each([
    ['string', 'string'], ['int', 'number'], ['float', 'number'], ['bool', 'boolean'], ['bytes', 'Uint8Array'],
    ['date', 'string'], ['datetime', 'string'], ['duration', 'string'], ['any', 'unknown'], ['void', 'void'],
    ['list<Invoice>', 'Invoice[]'], ['list<A | B>', '(A | B)[]'], ['set<string>', 'Set<string>'],
    ['map<string, int>', 'Record<string, number>'], ['Invoice?', 'Invoice | null'], ['A | B', 'A | B'],
    ['async void', 'Promise<void>'], ['Page<Invoice>', 'Page<Invoice>'],
  ])('%s is written %s', (canonical, written) => {
    expect(ts.write(expr(canonical))).toBe(written);
  });

  it('the mapping lines name every canonical form', () => {
    const lines = ts.mappingLines().join('\n');
    for (const form of ['list<T> → T[]', 'set<T>', 'map<K, V>', 'T? → T | null', 'async T → Promise<T>', 'bool → boolean', 'enum']) {
      expect(lines).toContain(form);
    }
  });
});
