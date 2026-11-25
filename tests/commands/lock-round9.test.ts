import { describe, expect, it } from 'vitest';
import { upgradeLine } from '../../src/models/lock.js';
import { groupRemovedByComponent, isLocalInstall, waironCommand } from '../../src/commands/lock.js';
import { weakestFilesNote } from '../../src/core/validation.js';

describe('waironCommand', () => {
  it('says npx wairon for a binary inside the project node_modules', () => {
    expect(waironCommand('/work/app', '/work/app/node_modules/.bin/wairon')).toBe('npx wairon');
    expect(waironCommand('/work/app/sub', '/work/app/node_modules/wairon/dist/cli/index.js')).toBe('npx wairon');
  });
  it('says wairon for a global or unrelated binary', () => {
    expect(waironCommand('/work/app', '/usr/lib/node_modules/wairon/dist/cli/index.js')).toBe('wairon');
    expect(waironCommand('/work/app', '/work/app/node_modules/vitest/vitest.mjs')).toBe('wairon');
    expect(isLocalInstall(undefined, '/work/app')).toBe(false);
  });
});

describe('upgradeLine', () => {
  it('reads cleanly in both variants', () => {
    const carried = upgradeLine(3, true);
    expect(carried).toContain('carried this approval over');
    expect(carried).toContain('without a review');
    expect(carried).not.toContain('did not carry');
    const not = upgradeLine(3, false);
    expect(not).toContain('could not carry this approval over');
    expect(not).toContain('reads stale until the next `wairon lock`');
    expect(not).not.toContain('without a review');
  });
});

describe('groupRemovedByComponent', () => {
  it('collapses a removed component to one line and keeps lone files', () => {
    const out = groupRemovedByComponent([
      '.wai/specs/components/foo.yaml',
      '.wai/specs/implementations/foo_impl.yaml',
      '.wai/specs/interfaces/ifoo.yaml',
      '.wai/specs/types/t.yaml',
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^component foo \(its component spec, implementation, contract/);
    expect(out[1]).toBe('.wai/specs/types/t.yaml');
  });
});

describe('weakestFilesNote', () => {
  it('names up to three files then counts the rest', () => {
    const f = (p: string, g: string) => ({ path: p, analysisGrade: g }) as never;
    const files = ['a', 'b', 'c', 'd', 'e'].map((n) => f(`${n}.py`, 'generic')).concat(f('x.ts', 'exact'));
    expect(weakestFilesNote(files, 'generic')).toBe(': a.py, b.py, c.py and 2 more');
    expect(weakestFilesNote(files.slice(0, 2), 'generic')).toBe(': a.py, b.py');
  });
});
