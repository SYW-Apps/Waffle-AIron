import { describe, it, expect } from 'vitest';
import {
  identifierProblem,
  reservedWordProblem,
  displayNameProblem,
  SpecIdSchema,
  MethodNameSchema,
  ParamNameSchema,
  FieldNameSchema,
  DisplayNameSchema,
  PROJECT_ID_RE,
  EXTERNAL_ALIAS_RE,
  aliasGrammarProblem,
  effectiveProjectId,
  projectIdentity,
  methodCasingFor,
  fitsMethodCasing,
} from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// identifier — one grammar for every kind of id (round-5 trials: tinkerer M6,
// lib-and-app R5-3/R5-23, solo-app "ids know casing but not reserved words or
// any length"). Every kind shares the portability floor; each adds its own
// characters; the path-segment kinds refuse Windows devices; member names
// never start with a digit; the target language's reserved words are refused
// where that language cannot use them.
// ---------------------------------------------------------------------------

const KINDS = ['spec-id', 'project-id', 'alias', 'method', 'param', 'field'] as const;

describe('identifier.problemAs — the floor every kind shares', () => {
  for (const kind of KINDS) {
    it(`${kind}: empty, invisible characters, over 64, a leading "-" and __proto__ are refused`, () => {
      expect(identifierProblem('', kind)).toMatch(/empty/);
      expect(identifierProblem('ab\u0000c', kind)).toMatch(/U\+0000/);
      expect(identifierProblem('ab​c', kind)).toMatch(/U\+200B/);
      expect(identifierProblem('a'.repeat(65), kind)).toMatch(/longer than 64 characters/);
      expect(identifierProblem('a'.repeat(64), kind)).toBeNull();
      expect(identifierProblem('-x', kind)).toMatch(/starts with "-"|not an identifier/);
      expect(identifierProblem('__proto__', kind)).toMatch(/prototype/);
    });
  }

  it('path-segment kinds refuse Windows device names; member names do not become files', () => {
    for (const kind of ['spec-id', 'project-id', 'alias'] as const) {
      for (const id of ['con', 'aux', 'nul', 'prn', 'com1', 'lpt9']) expect(identifierProblem(id, kind), `${kind} ${id}`).toMatch(/Windows reserves for a device/);
    }
    expect(identifierProblem('con.x', 'project-id')).toMatch(/device/);
    for (const kind of ['method', 'param', 'field'] as const) expect(identifierProblem('aux', kind)).toBeNull();
    expect(identifierProblem('aux_store', 'spec-id')).toBeNull();
  });

  it('project ids and aliases refuse super, the reserved namespace hop', () => {
    expect(identifierProblem('super', 'project-id')).toMatch(/namespace hop/);
    expect(identifierProblem('super', 'alias')).toMatch(/namespace hop/);
    expect(identifierProblem('superb', 'alias')).toBeNull();
  });

  it('member names are ASCII identifiers that never start with a digit', () => {
    expect(identifierProblem('9starts_with_digit', 'method')).toMatch(/starts with a digit/);
    expect(identifierProblem('has-dash', 'param')).toMatch(/not an identifier/);
    expect(identifierProblem('ünïcode', 'field')).toMatch(/not an identifier/);
    expect(identifierProblem('_private', 'field')).toBeNull();
    expect(identifierProblem('9lives', 'spec-id')).toBeNull();
  });

  it('display names: never blank, never invisible characters', () => {
    expect(displayNameProblem('')).toMatch(/empty/);
    expect(displayNameProblem('   ')).toMatch(/empty/);
    expect(displayNameProblem('nul\u0000byte')).toMatch(/U\+0000/);
    expect(displayNameProblem('zero​width')).toMatch(/U\+200B/);
    expect(displayNameProblem('on')).toBeNull();
    expect(displayNameProblem('2026-10-07')).toBeNull();
  });
});

describe('the schemas and the project-config grammar agree with identifier.problemAs', () => {
  it('SpecIdSchema refuses a leading dash and __proto__; constructor is a legal id', () => {
    expect(SpecIdSchema.safeParse('-leading-dash').success).toBe(false);
    expect(SpecIdSchema.safeParse('__proto__').success).toBe(false);
    expect(SpecIdSchema.safeParse('constructor').success).toBe(true);
  });

  it('member-name schemas refuse a 300-character name, a leading digit, empty and __proto__', () => {
    for (const schema of [MethodNameSchema, ParamNameSchema, FieldNameSchema]) {
      expect(schema.safeParse('m'.repeat(300)).success).toBe(false);
      expect(schema.safeParse('9x').success).toBe(false);
      expect(schema.safeParse('').success).toBe(false);
      expect(schema.safeParse('__proto__').success).toBe(false);
      expect(schema.safeParse('toString').success).toBe(true);
    }
  });

  it('DisplayNameSchema refuses empty, NUL, BEL and zero-width names', () => {
    for (const bad of ['', ' ', 'nul\u0000byte', 'bel\u0007', 'z​w']) expect(DisplayNameSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(DisplayNameSchema.safeParse('@at-sign *star &amp').success).toBe(true);
  });

  it('PROJECT_ID_RE and EXTERNAL_ALIAS_RE carry the whole grammar, so every `.test` agrees', () => {
    for (const bad of ['con', 'constructor'.repeat(7), 'super', 'aux.x']) expect(PROJECT_ID_RE.test(bad), bad).toBe(false);
    expect(PROJECT_ID_RE.test('geo-sdk.v2')).toBe(true);
    expect(PROJECT_ID_RE.test('constructor')).toBe(true);
    for (const bad of ['aux', '-x', 'super', '__proto__', 'a'.repeat(65)]) expect(EXTERNAL_ALIAS_RE.test(bad), bad).toBe(false);
    expect(EXTERNAL_ALIAS_RE.test('constructor')).toBe(true);
  });

  it('member add aux is refused for the right reason (a device name, not the character grammar)', () => {
    expect(aliasGrammarProblem('aux')).toMatch(/Windows reserves for a device/);
    expect(aliasGrammarProblem('aux')).not.toMatch(/breaks \[a-z0-9-_\]\+/);
  });

  it('a name-derived id is cut to 64, and one the grammar still refuses is no id at all', () => {
    expect(effectiveProjectId({ name: 'x'.repeat(115) })).toBe('x'.repeat(64));
    expect(effectiveProjectId({ name: 'con' })).toBeNull();
    expect(effectiveProjectId({ name: 'super' })).toBeNull();
    expect(projectIdentity({ id: 'con', name: 'x' }).problems[0]?.detail).toMatch(/device/);
  });
});

describe('identifier.reservedIn — the target language\'s reserved words', () => {
  it('Rust refuses its keywords as methods, parameters and fields, naming the language and an alternative', () => {
    for (const word of ['fn', 'self', 'super', 'type', 'match', 'async', 'crate']) {
      for (const kind of ['method', 'param', 'field'] as const) {
        const problem = reservedWordProblem(word, kind, 'rust', 'snake_case');
        expect(problem, `${kind} ${word}`).toMatch(/Rust/);
        expect(problem).toMatch(/e\.g\. "/);
      }
    }
    expect(reservedWordProblem('typed', 'method', 'rust')).toBeNull();
  });

  it('TypeScript allows a keyword as a method or a field, never as a parameter, and never constructor as a method', () => {
    expect(reservedWordProblem('delete', 'method', 'typescript', 'camelCase')).toBeNull();
    expect(reservedWordProblem('default', 'field', 'typescript')).toBeNull();
    expect(reservedWordProblem('class', 'param', 'typescript')).toMatch(/TypeScript/);
    expect(reservedWordProblem('constructor', 'method', 'typescript', 'camelCase')).toMatch(/constructor/);
    expect(reservedWordProblem('constructor', 'field', 'typescript')).toBeNull();
    expect(reservedWordProblem('constructor', 'method', 'rust', 'snake_case')).toBeNull();
  });

  it('Python, Go, Java, C# and C refuse their keywords; an unknown language reserves nothing', () => {
    expect(reservedWordProblem('lambda', 'param', 'python')).toMatch(/Python/);
    expect(reservedWordProblem('func', 'field', 'go')).toMatch(/Go/);
    expect(reservedWordProblem('new', 'method', 'java')).toMatch(/Java/);
    expect(reservedWordProblem('object', 'param', 'csharp')).toMatch(/C#/);
    expect(reservedWordProblem('register', 'field', 'c')).toMatch(/\bC\b/);
    expect(reservedWordProblem('fn', 'method', 'cobol')).toBeNull();
    expect(reservedWordProblem('fn', 'method', undefined)).toBeNull();
    expect(reservedWordProblem('fn', 'method', 'constructor')).toBeNull();
  });

  it('a language or casing named like a prototype property never resolves to a built-in', () => {
    expect(methodCasingFor(undefined, 'constructor')).toBe('camelCase');
    expect(fitsMethodCasing('getStats', 'constructor')).toBe(false);
    expect(fitsMethodCasing('getStats', 'camelCase')).toBe(true);
  });
});
