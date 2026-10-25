import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root = '';
vi.mock('../../../src/utils/fs.js', async (orig) => ({ ...(await orig<object>()), getProjectRoot: () => root }));
vi.mock('../../../src/core/adapters/validator-core.js', () => ({
  loadImplementationSpecs: () => [{ id: 'x_impl', name: 'X', contract: 'ix', sourcePath: 'src/x.ts', methods: [] }],
  loadTypeSpecs: () => [],
  loadProjectConfig: () => ({ rules: { conformance: { sourceRoots: ['src'] } } }),
}));
vi.mock('../../../src/core/source-analysis.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/core/source-analysis.js')>();
  return { ...actual, buildCodeModel: vi.fn(actual.buildCodeModel) };
});

import { current } from '../../../src/core/lookup/code-model-loader.js';
import { buildCodeModel } from '../../../src/core/source-analysis.js';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-loader-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/x.ts'), 'export const x = 1;\n');
  vi.mocked(buildCodeModel).mockClear();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('code_model_loader.current', () => {
  it('answers the cached entry on a second call with no file change', () => {
    const first = current();
    expect(buildCodeModel).toHaveBeenCalledTimes(1);
    expect(first.model.files.map(f => f.path)).toEqual(['src/x.ts']);
    expect(Number.isNaN(Date.parse(first.builtAt))).toBe(false);
    const second = current();
    expect(buildCodeModel).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('rebuilds when a file is touched', () => {
    const first = current();
    fs.writeFileSync(path.join(root, 'src/x.ts'), 'export const x = 123456;\n');
    const second = current();
    expect(buildCodeModel).toHaveBeenCalledTimes(2);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('rebuilds when a walked file appears', () => {
    current();
    fs.writeFileSync(path.join(root, 'src/y.ts'), 'export const y = 1;\n');
    expect(current().model.files.map(f => f.path).sort()).toEqual(['src/x.ts', 'src/y.ts']);
    expect(buildCodeModel).toHaveBeenCalledTimes(2);
  });
});
