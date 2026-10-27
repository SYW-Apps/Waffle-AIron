import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  const wrapped = { ...actual, readFileSync: vi.fn(actual.readFileSync), openSync: vi.fn(actual.openSync) };
  return { ...wrapped, default: wrapped };
});

import { buildCodeModel, fingerprintSources } from '../../../src/core/source-analysis.js';

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

describe('fingerprintSources', () => {
  it('is stable for an unchanged tree and covers the walked roots', () => {
    const dir = project({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' });
    const one = fingerprintSources([], [], dir, ['src']);
    expect(fingerprintSources([], [], dir, ['src'])).toBe(one);
    expect(fingerprintSources([], [], dir, [])).not.toBe(one);
  });

  it('changes when a file changes size or time, appears or disappears', () => {
    const dir = project({ 'src/a.ts': 'export const a = 1;\n' });
    const base = fingerprintSources([], [], dir, ['src']);
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 12345;\n');
    const grown = fingerprintSources([], [], dir, ['src']);
    expect(grown).not.toBe(base);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, 'src/a.ts'), later, later);
    const touched = fingerprintSources([], [], dir, ['src']);
    expect(touched).not.toBe(grown);
    fs.writeFileSync(path.join(dir, 'src/c.ts'), 'export const c = 3;\n');
    const added = fingerprintSources([], [], dir, ['src']);
    expect(added).not.toBe(touched);
    fs.rmSync(path.join(dir, 'src/c.ts'));
    expect(fingerprintSources([], [], dir, ['src'])).toBe(touched);
  });

  it('takes the file set buildCodeModel takes, spec-named files included, exclude honoured', () => {
    const dir = project({ 'src/x.ts': 'export const x = 1;\n', 'src/gen/g.ts': 'export const g = 1;\n' });
    const model = buildCodeModel([impl], [], dir, ['src'], ['src/gen']);
    expect(model.files.map(f => f.path).sort()).toEqual(['src/x.ts']);
    const before = fingerprintSources([impl], [], dir, ['src'], ['src/gen']);
    fs.writeFileSync(path.join(dir, 'src/gen/g.ts'), 'export const g = 99999;\n');
    expect(fingerprintSources([impl], [], dir, ['src'], ['src/gen'])).toBe(before);
    fs.writeFileSync(path.join(dir, 'src/x.ts'), 'export const x = 99999;\n');
    expect(fingerprintSources([impl], [], dir, ['src'], ['src/gen'])).not.toBe(before);
  });

  it('lets a missing or escaped spec-named file contribute its classification', () => {
    const dir = project({});
    const missing = { ...(impl as object), sourcePath: 'src/later.ts' } as never;
    const escaped = { ...(impl as object), sourcePath: '../outside.ts' } as never;
    const planned = fingerprintSources([missing], [], dir);
    const out = fingerprintSources([escaped], [], dir);
    expect(planned).not.toBe(out);
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src/later.ts'), 'export {};\n');
    expect(fingerprintSources([missing], [], dir)).not.toBe(planned);
  });

  it('reads no file content', () => {
    const dir = project({ 'src/a.ts': 'export const a = 1;\n' });
    const read = vi.mocked(fs.readFileSync);
    const open = vi.mocked(fs.openSync);
    read.mockClear();
    open.mockClear();
    fingerprintSources([impl], [], dir, ['src']);
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
