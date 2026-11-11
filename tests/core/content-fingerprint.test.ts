import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  const wrapped = { ...actual, readFileSync: vi.fn(actual.readFileSync) };
  return { ...wrapped, default: wrapped };
});
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  const wrapped = { ...actual, readFileSync: vi.fn(actual.readFileSync) };
  return { ...wrapped, default: wrapped };
});

import { digest } from '../../src/core/content-fingerprint.js';

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-cfp-'));
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

describe('content_fingerprint.digest', () => {
  it('is equal for equal paths and bytes, whatever the modification time', () => {
    const a = project({ 'src/a.ts': 'one\n' });
    const b = project({ 'src/a.ts': 'one\n' });
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(b, 'src/a.ts'), later, later);
    expect(digest(a, ['src/a.ts'])).toBe(digest(b, ['src/a.ts']));
  });

  it('follows content: a rewrite with other bytes changes it, a rewrite back restores it', () => {
    const dir = project({ 'src/a.ts': 'one\n' });
    const first = digest(dir, ['src/a.ts']);
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'two, longer\n');
    expect(digest(dir, ['src/a.ts'])).not.toBe(first);
    const later = new Date(Date.now() + 120_000);
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'one\n');
    fs.utimesSync(path.join(dir, 'src/a.ts'), later, later);
    expect(digest(dir, ['src/a.ts'])).toBe(first);
  });

  it('reads a file again only when its size or modification time moved', () => {
    const dir = project({ 'src/a.ts': 'one\n', 'src/b.ts': 'two\n' });
    const read = vi.mocked(fs.readFileSync);
    const taken = digest(dir, ['src/a.ts', 'src/b.ts']);
    read.mockClear();
    expect(digest(dir, ['src/a.ts', 'src/b.ts'])).toBe(taken);
    expect(read).not.toHaveBeenCalled();
    fs.writeFileSync(path.join(dir, 'src/b.ts'), 'three!\n');
    read.mockClear();
    expect(digest(dir, ['src/a.ts', 'src/b.ts'])).not.toBe(taken);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('folds missing and escaped paths without throwing, and treats absolute-inside like relative', () => {
    const dir = project({ 'src/a.ts': 'one\n' });
    const present = digest(dir, ['src/a.ts']);
    expect(digest(dir, [path.join(dir, 'src/a.ts')])).toBe(present);
    const withMissing = digest(dir, ['src/a.ts', 'src/gone.ts']);
    expect(withMissing).not.toBe(present);
    const withEscaped = digest(dir, ['src/a.ts', '../outside.ts']);
    expect(withEscaped).not.toBe(present);
    expect(withEscaped).not.toBe(withMissing);
  });
});
