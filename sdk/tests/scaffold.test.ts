import { describe, it, expect } from 'vitest';
import { render } from '../src/scaffold';

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

function text(files: { path: string; contents: Uint8Array }[], path: string): string {
  const file = files.find((f) => f.path === path);
  if (!file) throw new Error(`no file ${path}`);
  return decode(file.contents);
}

describe('scaffold.render', () => {
  it('renders a declarative pack with a matching envelope', () => {
    const files = render({ name: 'demo', version: '0.2.0', kind: 'declarative', targetDir: 'x' });
    const paths = files.map((f) => f.path);
    expect(paths).toContain('wairon-pack.yaml');
    expect(paths).toContain('pack.yaml');
    expect(paths).not.toContain('package.json');

    const env = text(files, 'wairon-pack.yaml');
    expect(env).toContain('kind: declarative');
    expect(env).toContain('name: demo');
    expect(env).toContain('version: 0.2.0');
    expect(env).toContain('entry: pack.yaml');

    const inner = text(files, 'pack.yaml');
    expect(inner).toContain('name: demo');
    expect(inner).toContain('version: 0.2.0');
  });

  it('renders a code pack pinned to the SDK version', () => {
    const files = render({ name: 'demo', kind: 'code', targetDir: 'x' });
    const paths = files.map((f) => f.path);
    expect(paths).toContain('package.json');
    expect(paths).toContain('pack.ts');
    expect(paths).toContain('tsconfig.json');
    expect(paths).toContain('wairon-pack.yaml');

    const pkg = JSON.parse(text(files, 'package.json'));
    expect(pkg.name).toBe('demo');
    expect(pkg.dependencies['@wairon/sdk']).toBeDefined();

    const packTs = text(files, 'pack.ts');
    expect(packTs).toContain('defineRule');
    expect(packTs).toContain("from '@wairon/sdk'");

    const env = text(files, 'wairon-pack.yaml');
    expect(env).toContain('kind: code');
    expect(env).toContain('entry: pack.cjs');
  });

  it('defaults the version to 0.1.0 when omitted', () => {
    const files = render({ name: 'demo', kind: 'declarative', targetDir: 'x' });
    expect(text(files, 'wairon-pack.yaml')).toContain('version: 0.1.0');
  });

  it('appends a SKILL.md stub only when requested', () => {
    const without = render({ name: 'demo', kind: 'declarative', targetDir: 'x' });
    expect(without.some((f) => f.path.endsWith('SKILL.md'))).toBe(false);

    const withSkill = render({ name: 'demo', kind: 'declarative', targetDir: 'x', withSkill: true });
    expect(withSkill.some((f) => f.path === 'skills/demo/SKILL.md')).toBe(true);
  });
});
