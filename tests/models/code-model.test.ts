import { describe, it, expect } from 'vitest';
import { factsFor, pathKey, resolveImport, type CodeModel, type SourceFileFacts } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The code model's type methods (code_model.pathKey / factsFor,
// source_file_facts.resolveImport): the key every code↔spec rule indexes the
// analyzed files by, and the pure relative-import resolution the dependency and
// integration conformance rules lift import edges with.
// ---------------------------------------------------------------------------

const facts = (path: string, extra: Partial<SourceFileFacts> = {}): SourceFileFacts => ({
  path,
  status: 'analyzed',
  declaredNames: [],
  anchoredNames: [],
  exportedNames: [],
  imports: [],
  reexports: [],
  ...extra,
});

describe('code_model.pathKey', () => {
  it('turns backslashes into forward slashes', () => {
    expect(pathKey('src\\core\\a.ts')).toBe('src/core/a.ts');
  });

  it('drops one leading ./ (in either slash spelling) and nothing else', () => {
    expect(pathKey('./src/a.ts')).toBe('src/a.ts');
    expect(pathKey('.\\src\\a.ts')).toBe('src/a.ts');
    expect(pathKey('src/./a.ts')).toBe('src/./a.ts');
    expect(pathKey('../src/a.ts')).toBe('../src/a.ts');
  });

  it('leaves a key already in canonical form unchanged', () => {
    expect(pathKey('src/a.ts')).toBe('src/a.ts');
  });
});

describe('code_model.factsFor', () => {
  const model: CodeModel = {
    projectRoot: '/proj',
    files: [facts('src/a.ts'), facts('src/b.ts', { status: 'missing' })],
  };

  it('finds the entry for a source path in any spelling of its key', () => {
    expect(factsFor(model, 'src/a.ts')).toBe(model.files[0]);
    expect(factsFor(model, './src/a.ts')).toBe(model.files[0]);
    expect(factsFor(model, 'src\\b.ts')).toBe(model.files[1]);
  });

  it('answers undefined for a path the run did not analyze', () => {
    expect(factsFor(model, 'src/c.ts')).toBeUndefined();
    expect(factsFor({ projectRoot: '', files: [] }, 'src/a.ts')).toBeUndefined();
  });

  it('compares stored paths by key too, and the later of two entries for one key answers', () => {
    const first = facts('./src/x.ts');
    const second = facts('src\\x.ts', { status: 'unreadable' });
    expect(factsFor({ projectRoot: '', files: [first, second] }, 'src/x.ts')).toBe(second);
  });
});

describe('source_file_facts.resolveImport', () => {
  const known = new Set([
    'src/core/a.ts',
    'src/core/b.tsx',
    'src/core/c.js',
    'src/core/d.ts',
    'src/lib/index.ts',
    'src/lib2/index.js',
    'src/plain',
  ]);

  it('swaps .js for .ts, then .tsx, the way ESM TypeScript specifiers are written', () => {
    expect(resolveImport('src/core/x.ts', './a.js', known)).toBe('src/core/a.ts');
    expect(resolveImport('src/core/x.ts', './b.js', known)).toBe('src/core/b.tsx');
  });

  it('tries the joined path itself, then the .ts, .tsx and .js extensions', () => {
    expect(resolveImport('src/core/x.ts', '../plain', known)).toBe('src/plain');
    expect(resolveImport('src/core/x.ts', './d', known)).toBe('src/core/d.ts');
    expect(resolveImport('src/core/x.ts', './b', known)).toBe('src/core/b.tsx');
    expect(resolveImport('src/core/x.ts', './c', known)).toBe('src/core/c.js');
  });

  it('resolves a directory import to its index file', () => {
    expect(resolveImport('src/core/x.ts', '../lib', known)).toBe('src/lib/index.ts');
    expect(resolveImport('src/core/x.ts', '../lib2', known)).toBe('src/lib2/index.js');
  });

  it("joins against the importing file's directory and normalizes the result", () => {
    expect(resolveImport('src/core/deep/y.ts', '../a.js', known)).toBe('src/core/a.ts');
    expect(resolveImport('src/core/x.ts', './../core/./a.js', known)).toBe('src/core/a.ts');
  });

  it('answers undefined for a bare package specifier, or when no known path matches', () => {
    expect(resolveImport('src/core/x.ts', 'typescript', known)).toBeUndefined();
    expect(resolveImport('src/core/x.ts', './missing.js', known)).toBeUndefined();
  });
});
