import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { lockTree, unlockTree, LOCK_IGNORE_LINE } from '../../src/core/spec-files.js';

// 6.2 keeps one generation file of the spec tree's write lock on disk after a
// write. A tree initialized before 6.2 ignores only `.spec-write.lock`, so the
// lock itself must make .wai/.gitignore cover the generation files, or every
// existing project's git status would list them.

const dirs: string[] = [];
function tree(gitignore?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-lock-ignore-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.wai'), { recursive: true });
  if (gitignore !== undefined) fs.writeFileSync(path.join(dir, '.wai', '.gitignore'), gitignore);
  return dir;
}
const ignore = (dir: string): string => fs.readFileSync(path.join(dir, '.wai', '.gitignore'), 'utf8');

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('the spec tree lock keeps its files out of git', () => {
  it('adds the generation pattern to a pre-6.2 .wai/.gitignore and keeps its other lines', () => {
    const dir = tree('# mine\n.spec-write.lock\nscratch/\n');
    lockTree(dir);
    unlockTree(dir);
    expect(ignore(dir)).toBe(`# mine\n.spec-write.lock\nscratch/\n${LOCK_IGNORE_LINE}\n`);
    const left = fs.readdirSync(path.join(dir, '.wai')).filter((f) => f.startsWith('.spec-write.lock'));
    expect(left.length).toBeGreaterThan(0);
    expect(left.every((f) => f.startsWith('.spec-write.lock'))).toBe(true);
  });

  it('creates .wai/.gitignore when absent, and leaves one that already covers the files untouched', () => {
    const fresh = tree();
    lockTree(fresh);
    unlockTree(fresh);
    expect(ignore(fresh)).toContain(`${LOCK_IGNORE_LINE}\n`);

    const covered = tree(`${LOCK_IGNORE_LINE}\n`);
    lockTree(covered);
    unlockTree(covered);
    expect(ignore(covered)).toBe(`${LOCK_IGNORE_LINE}\n`);
  });

  it('adds a missing final newline before the line', () => {
    const dir = tree('scratch/');
    lockTree(dir);
    unlockTree(dir);
    expect(ignore(dir)).toBe(`scratch/\n${LOCK_IGNORE_LINE}\n`);
  });
});
