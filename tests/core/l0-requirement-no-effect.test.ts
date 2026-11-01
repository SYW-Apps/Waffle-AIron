import { describe, it, expect } from 'vitest';
import { ineffectiveDeltaPaths } from '../../src/core/specs.js';

// A requirement written as text and one written as { description } are the same
// requirement, so a delta naming one in either spelling must not be reported as
// "not stored" when the stored list holds it in the other.

const text = (r: string): string => r;
const obj = (r: string): { description: string } => ({ description: r });

describe('sdd_update_spec: L0 requirement spellings in the NO EFFECT report', () => {
  const spellings: Array<[string, (r: string) => unknown, string, (r: string) => unknown]> = [
    ['text', text, 'text', text],
    ['text', text, 'object', obj],
    ['object', obj, 'text', text],
    ['object', obj, 'object', obj],
  ];
  for (const [deltaName, deltaOf, storedName, storedOf] of spellings) {
    it(`a ${deltaName} delta against a ${storedName} stored requirement is not reported as unstored`, () => {
      const stored = { globalRequirements: [storedOf('keep')] };
      const merged = { globalRequirements: [storedOf('keep'), storedOf('fresh')] };
      const delta = { globalRequirements: [deltaOf('fresh')] };
      expect(ineffectiveDeltaPaths(delta, merged, stored)).toEqual([]);
    });
  }

  it('a plain-list value written as { value } is judged by its value, as the merge stores it', () => {
    const stored = { owns: ['reading_store'] };
    const merged = { owns: ['reading_store', 'blob_files'] };
    expect(ineffectiveDeltaPaths({ owns: [{ value: 'blob_files' }] }, merged, stored)).toEqual([]);
    expect(ineffectiveDeltaPaths({ owns: [{ value: 'reading_store' }] }, stored, stored))
      .toEqual(['owns — the stored spec already held this value']);
    expect(ineffectiveDeltaPaths({ owns: [{ value: 'lost' }] }, stored, stored)).toHaveLength(1);
  });

  it('a requirement the write genuinely dropped is still reported, in either spelling', () => {
    const stored = { globalRequirements: [text('keep')] };
    const merged = { globalRequirements: [text('keep')] };
    for (const deltaOf of [text, obj]) {
      const found = ineffectiveDeltaPaths({ globalRequirements: [deltaOf('lost')] }, merged, stored);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('globalRequirements');
    }
  });
});
