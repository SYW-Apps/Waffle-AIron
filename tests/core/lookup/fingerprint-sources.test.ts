import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  const wrapped = { ...actual, readFileSync: vi.fn(actual.readFileSync), openSync: vi.fn(actual.openSync) };
  return { ...wrapped, default: wrapped };
});

import { buildCodeModel, sourceFiles } from '../../../src/core/source-analysis.js';

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-fingerprint-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const impl = { id: 'x_impl', name: 'X', contract: 'ix', sourcePath: 'src/x.ts', methods: [] } as never;

describe('sourceFiles', () => {
  it('names the walked roots, deduplicated, and nothing else for no specs', () => {
    const dir = project({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' });
    const set = sourceFiles([], [], dir, ['src']);
    expect([...set.files].sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(set.claimed).toEqual([]);
    // Nothing walked: the project's other source files are still named, since the code model reads them.
    expect([...sourceFiles([], [], dir, []).files].sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('names the other project source files the bounded outside walk reads, within its skipped folders', () => {
    const dir = project({
      'src/x.ts': 'export const x = 1;\n',
      'wiring/main.ts': "import { x } from '../src/x.js';\nexport const y = x;\n",
      'scripts/tool.py': 'print(1)\n',
      'node_modules/dep/index.js': 'module.exports = 1;\n',
      'dist/out.js': 'module.exports = 2;\n',
      '.hidden/h.ts': 'export const h = 1;\n',
      'README.md': 'not source\n',
    });
    const set = sourceFiles([impl], [], dir);
    expect([...set.files].sort()).toEqual(['scripts/tool.py', 'src/x.ts', 'wiring/main.ts']);
    expect(set.claimed).toEqual(['src/x.ts']);
    const model = buildCodeModel([impl], [], dir);
    expect(model.outsideNames).toContain('y');
  });

  it('takes the file set buildCodeModel takes, spec-named files included, exclude honoured', () => {
    const dir = project({ 'src/x.ts': 'export const x = 1;\n', 'src/gen/g.ts': 'export const g = 1;\n' });
    const model = buildCodeModel([impl], [], dir, ['src'], ['src/gen']);
    expect(model.files.map(f => f.path).sort()).toEqual(['src/x.ts']);
    // An excluded file is not analyzed, but the outside walk reads it, so it is named, after the analyzed ones.
    const set = sourceFiles([impl], [], dir, ['src'], ['src/gen']);
    expect(set.files).toEqual(['src/x.ts', 'src/gen/g.ts']);
    expect(set.claimed).toEqual(['src/x.ts']);
  });

  it('names a missing or escaped spec-named file without touching it', () => {
    const dir = project({});
    const missing = { ...(impl as object), sourcePath: 'src/later.ts' } as never;
    const escaped = { ...(impl as object), sourcePath: '../outside.ts' } as never;
    expect(sourceFiles([missing], [], dir).files).toEqual(['src/later.ts']);
    expect(sourceFiles([escaped], [], dir).files).toEqual(['../outside.ts']);
  });

  it('reads no file content', () => {
    const dir = project({ 'src/a.ts': 'export const a = 1;\n' });
    const read = vi.mocked(fs.readFileSync);
    const open = vi.mocked(fs.openSync);
    read.mockClear();
    open.mockClear();
    sourceFiles([impl], [], dir, ['src']);
    expect(read).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});

describe('call site line', () => {
  it('records the 1-based line of exact-grade call sites', () => {
    const source = [
      'export function run(store: { save(): void }) {',
      '  helper();',
      '',
      '  store',
      '    .save();',
      '}',
      'function helper() {}',
      '',
    ].join('\n');
    const dir = project({ 'src/x.ts': source });
    const model = buildCodeModel([impl], [], dir);
    const file = model.files.find(f => f.path === 'src/x.ts')!;
    expect(file.analysisGrade).toBe('exact');
    const sites = file.functionCallSites!.run;
    expect(sites.find(s => s.name === 'helper')?.line).toBe(2);
    expect(sites.find(s => s.name === 'save')?.line).toBe(5);
  });
});
