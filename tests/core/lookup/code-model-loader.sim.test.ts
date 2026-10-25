import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setProjectRoot } from '../../../src/utils/fs.js';
import { invalidateSpecCache } from '../../../src/core/specs.js';
import { lookupProject } from '../../helpers/lookup-fixture.js';
// The real modules of the component and of each direct dependency: no fakes.
import { current } from '../../../src/core/lookup/code-model-loader.js';
import * as cache from '../../../src/core/lookup/code-model-cache.js';
import { fingerprintSources } from '../../../src/core/source-analysis.js';
import * as validatorCore from '../../../src/core/adapters/validator-core.js';

// Integration sim for code_model_loader: the real loader, cache, fingerprint
// and analyzer against a small real project.
describe('sim: code_model_loader.current', () => {
  const fixture = lookupProject();
  beforeAll(() => { setProjectRoot(fixture.root); invalidateSpecCache(); });
  afterAll(() => fixture.cleanup());

  it('builds once, holds the entry in the cache and answers it again while the files stand', () => {
    expect(cache.get(fixture.root)).toBeNull();
    const first = current();
    expect(first.model.files.map((f) => f.path)).toEqual(expect.arrayContaining(['src/ledger.ts', 'src/orders.ts', 'src/shipping.ts']));
    expect(first.model.files.find((f) => f.path === 'src/shipping.ts')?.status).toBe('missing');
    expect(cache.get(fixture.root)).toBe(first);
    expect(current()).toBe(first);
  });

  it('fingerprints the same files the gate walks, from the real configuration', () => {
    const conformance = validatorCore.loadProjectConfig()?.rules?.conformance;
    const again = fingerprintSources(validatorCore.loadImplementationSpecs(), validatorCore.loadTypeSpecs(), fixture.root, conformance?.sourceRoots ?? [], conformance?.exclude ?? []);
    expect(again).toBe(current().fingerprint);
  });

  it('rebuilds when a file changes and when a walked file appears', () => {
    const before = current();
    fixture.edit('src/ledger.ts', 'export function record(entry: string): void {\n  void entry;\n  void 0;\n}\n');
    const touched = current();
    expect(touched).not.toBe(before);
    expect(touched.fingerprint).not.toBe(before.fingerprint);
    fixture.edit('src/extra.ts', 'export const extra = 1;\n');
    expect(current().model.files.map((f) => f.path)).toContain('src/extra.ts');
  });
});
