import { describe, it, expect } from 'vitest';
import { get, put } from '../../../src/core/lookup/code-model-cache.js';
import { emptyCodeModel } from '../../../src/core/source-analysis.js';
import type { CachedCodeModel } from '../../../src/models/lookup.js';

const entry = (fingerprint: string): CachedCodeModel => ({ fingerprint, model: emptyCodeModel(), builtAt: new Date().toISOString() });

describe('code_model_cache', () => {
  it('answers none when nothing is held, and never throws', () => {
    expect(get('/nowhere')).toBeNull();
  });
  it('holds one entry per root and replaces it whole', () => {
    put('/a', entry('1'));
    put('/b', entry('2'));
    put('/a', entry('3'));
    expect(get('/a')?.fingerprint).toBe('3');
    expect(get('/b')?.fingerprint).toBe('2');
  });
  it('is idempotent for the same entry', () => {
    const e = entry('x');
    put('/c', e);
    put('/c', e);
    expect(get('/c')).toBe(e);
  });
});
