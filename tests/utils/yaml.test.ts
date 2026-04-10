import { describe, it, expect } from 'vitest';
import { parseYaml, serializeYaml } from '../../src/utils/yaml.js';

describe('parseYaml', () => {
  it('parses a simple YAML string', () => {
    const result = parseYaml('key: value\nlist:\n  - a\n  - b');
    expect(result).toEqual({ key: 'value', list: ['a', 'b'] });
  });

  it('throws on invalid YAML', () => {
    expect(() => parseYaml(': : invalid')).toThrow();
  });

  it('returns undefined for empty YAML (js-yaml behavior)', () => {
    const result = parseYaml('');
    // js-yaml returns undefined for empty/null documents
    expect(result).toBeUndefined();
  });
});

describe('serializeYaml', () => {
  it('serializes an object to YAML', () => {
    const yaml = serializeYaml({ name: 'test', version: '1.0.0' });
    expect(yaml).toContain('name: test');
    expect(yaml).toContain('version: 1.0.0');
  });

  it('round-trips through parse and serialize', () => {
    const original = { id: 'my-agent', tags: ['a', 'b'], enabled: true };
    const yaml = serializeYaml(original);
    const parsed = parseYaml(yaml);
    expect(parsed).toEqual(original);
  });
});
