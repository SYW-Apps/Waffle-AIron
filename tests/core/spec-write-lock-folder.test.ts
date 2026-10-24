import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { lockTree, unlockTree } from '../../src/core/spec-files.js';

// The spec tree's write lock keeps its generation files inside the folder
// `.wai/.spec-write.lock/`: every ignore rule a tree already has for the old
// lock file covers a folder of that name, so no gitignore is ever written.

const dirs: string[] = [];
function tree(gitignore?: { where: '.wai' | 'root'; text: string }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-lock-folder-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.wai'), { recursive: true });
  if (gitignore !== undefined) fs.writeFileSync(path.join(gitignore.where === 'root' ? dir : path.join(dir, '.wai'), '.gitignore'), gitignore.text);
  return dir;
}
const lockPath = (dir: string): string => path.join(dir, '.wai', '.spec-write.lock');

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('the spec tree lock keeps its files in a folder', () => {
  it('after a write the only lock artefacts are inside .wai/.spec-write.lock/', () => {
    const dir = tree();
    lockTree(dir);
    unlockTree(dir);
    expect(fs.readdirSync(path.join(dir, '.wai'))).toEqual(['.spec-write.lock']);
    expect(fs.statSync(lockPath(dir)).isDirectory()).toBe(true);
    const inside = fs.readdirSync(lockPath(dir));
    expect(inside.length).toBeGreaterThan(0);
    expect(inside.every((f) => /^tree\.lock\.\d+(\.end)?$/.test(f))).toBe(true);
    // No gitignore is written or amended by taking a lock.
    expect(fs.existsSync(path.join(dir, '.wai', '.gitignore'))).toBe(false);
  });

  it.each([
    ['a .wai/.gitignore holding .spec-write.lock', { where: '.wai' as const, text: '.spec-write.lock\n' }],
    ['a root .gitignore holding .wai/.spec-write.lock', { where: 'root' as const, text: '.wai/.spec-write.lock\n' }],
  ])('git reports the lock files ignored with %s, and the ignore file is untouched', (_name, ignore) => {
    const dir = tree(ignore);
    const file = path.join(ignore.where === 'root' ? dir : path.join(dir, '.wai'), '.gitignore');
    spawnSync('git', ['init', '-q'], { cwd: dir });
    lockTree(dir);
    unlockTree(dir);
    const files = fs.readdirSync(lockPath(dir)).map((f) => `.wai/.spec-write.lock/${f}`);
    expect(files.length).toBeGreaterThan(0);
    const checked = spawnSync('git', ['check-ignore', ...files], { cwd: dir, encoding: 'utf8' });
    expect(checked.stdout.split(/\r?\n/).filter(Boolean).sort()).toEqual([...files].sort());
    expect(fs.readFileSync(file, 'utf8')).toBe(ignore.text);
  });

  it('a stale single lock FILE of the pre-6.2 layout is removed and the folder made', () => {
    const dir = tree();
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    fs.writeFileSync(lockPath(dir), `${Number(gone.stdout)}\n${Date.now()}\n`);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockPath(dir), old, old);
    lockTree(dir);
    unlockTree(dir);
    expect(fs.statSync(lockPath(dir)).isDirectory()).toBe(true);
  });

  it('a legacy file whose holder process is gone is reclaimed even when young', () => {
    const dir = tree();
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    fs.writeFileSync(lockPath(dir), `${Number(gone.stdout)}\n${Date.now()}\n`);
    lockTree(dir);
    unlockTree(dir);
    expect(fs.statSync(lockPath(dir)).isDirectory()).toBe(true);
  });

  it('a fresh legacy file held by a live process is waited for, then refused naming it', () => {
    const dir = tree();
    // Another LIVE local process: the parent of this test process.
    fs.writeFileSync(lockPath(dir), `${process.ppid}
${Date.now()}
`);
    // The clock runs 7s per look: the 30s wait ends after a few looks, well inside the 60s stale age.
    const real = Date.now();
    let looks = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => real + 7_000 * looks++);
    try {
      expect(() => lockTree(dir)).toThrow(/spec-tree-locked.*spec-write\.lock/);
    } finally {
      clock.mockRestore();
    }
    expect(looks).toBeGreaterThan(3);
    expect(fs.statSync(lockPath(dir)).isFile()).toBe(true);
  });
});
