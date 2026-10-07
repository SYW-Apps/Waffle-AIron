import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseYaml, serializeYaml } from '../../src/utils/yaml.js';
import { WaironError, YamlSyntaxError } from '../../src/utils/errors.js';

describe('parseYaml', () => {
  it('parses a simple YAML string', () => {
    const result = parseYaml('key: value\nlist:\n  - a\n  - b');
    expect(result).toEqual({ key: 'value', list: ['a', 'b'] });
  });

  it('throws on invalid YAML', () => {
    expect(() => parseYaml(': : invalid')).toThrow();
  });

  // Round-4 trial (tinkerer): a duplicated key in project.yaml reached the user
  // as `Error: Failed to parse YAML (...): YAMLException ...` and a stack trace.
  it('throws a YamlSyntaxError (a WaironError) naming the file, the 1-based line and the duplicated key', () => {
    const text = 'id: lab\nrules:\n  a: 1\nname: lab\nrules:\n  b: 2\n';
    let thrown: unknown;
    try { parseYaml(text, '/nowhere/.wai/project.yaml'); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(YamlSyntaxError);
    expect(thrown).toBeInstanceOf(WaironError);
    const err = thrown as YamlSyntaxError;
    expect(err.line).toBe(5);
    expect(err.key).toBe('rules');
    expect(err.message).toMatch(/^\/nowhere\/\.wai\/project\.yaml:5: duplicated mapping key "rules" — a key may appear once per mapping/);
    expect(err.message.split('\n')).toHaveLength(1);
  });

  it('names a file under the working directory relative to it, and a non-key error without a key', () => {
    const file = path.join(process.cwd(), 'cfg', 'x.yaml');
    let thrown: unknown;
    try { parseYaml('a: [1, 2\nb: 3\n', file); } catch (e) { thrown = e; }
    const err = thrown as YamlSyntaxError;
    expect(err).toBeInstanceOf(YamlSyntaxError);
    expect(err.key).toBeUndefined();
    expect(err.message.startsWith('cfg/x.yaml:')).toBe(true);
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
