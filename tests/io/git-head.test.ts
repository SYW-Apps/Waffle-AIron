import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { head, headFile, hasBranch } from '../../src/io/git-head.js';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

describe('io/git-head (git_head_adapter): HEAD read without running git', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows */ }
    }
  });
  const tmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-githead-'));
    dirs.push(d);
    return d;
  };
  const write = (file: string, text: string): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  it('reads the branch and the loose ref of a normal repository', () => {
    const root = tmp();
    write(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/feat/x\n');
    write(path.join(root, '.git', 'refs', 'heads', 'feat', 'x'), SHA + '\n');
    expect(head(root)).toEqual({ branch: 'feat/x', commit: SHA });
    expect(headFile(root)).toBe(path.join(root, '.git', 'HEAD'));
    expect(hasBranch(root, 'feat/x')).toBe(true);
    expect(hasBranch(root, 'feat/y')).toBe(false);
  });

  it('finds the repository of a project in a subfolder', () => {
    const root = tmp();
    write(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    write(path.join(root, '.git', 'refs', 'heads', 'main'), SHA + '\n');
    const project = path.join(root, 'services', 'api');
    fs.mkdirSync(project, { recursive: true });
    expect(head(project)).toEqual({ branch: 'main', commit: SHA });
    expect(headFile(project)).toBe(path.join(root, '.git', 'HEAD'));
  });

  it('falls back to packed-refs, and answers a branch with no commit yet', () => {
    const root = tmp();
    write(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    write(path.join(root, '.git', 'packed-refs'), '# pack-refs\n' + SHA2 + ' refs/heads/other\n' + SHA + ' refs/heads/main\n^' + SHA2 + '\n');
    expect(head(root)).toEqual({ branch: 'main', commit: SHA });
    expect(hasBranch(root, 'other')).toBe(true);
    write(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/unborn\n');
    expect(head(root)).toEqual({ branch: 'unborn' });
    expect(hasBranch(root, 'unborn')).toBe(false);
  });

  it('follows a worktree .git file to its gitdir and the refs of the common folder', () => {
    const main = tmp();
    write(path.join(main, '.git', 'packed-refs'), SHA2 + ' refs/heads/wt\n');
    write(path.join(main, '.git', 'refs', 'heads', 'loose'), SHA + '\n');
    const gitdir = path.join(main, '.git', 'worktrees', 'wt');
    write(path.join(gitdir, 'HEAD'), 'ref: refs/heads/wt\n');
    write(path.join(gitdir, 'commondir'), '../..\n');
    const work = tmp();
    write(path.join(work, '.git'), 'gitdir: ' + gitdir + '\n');
    expect(head(work)).toEqual({ branch: 'wt', commit: SHA2 });
    expect(headFile(work)).toBe(path.join(gitdir, 'HEAD'));
    expect(hasBranch(work, 'loose')).toBe(true);
    // a relative gitdir is read against the file's folder
    const rel = tmp();
    write(path.join(rel, 'g', 'HEAD'), 'ref: refs/heads/r\n');
    write(path.join(rel, '.git'), 'gitdir: g\n');
    expect(head(rel)).toEqual({ branch: 'r' });
  });

  it('answers a commit and no branch on a detached HEAD', () => {
    const root = tmp();
    write(path.join(root, '.git', 'HEAD'), SHA + '\n');
    expect(head(root)).toEqual({ commit: SHA });
  });

  it('answers none outside a git checkout, and for unreadable metadata', () => {
    const root = tmp();
    expect(head(root)).toBeUndefined();
    expect(headFile(root)).toBeUndefined();
    expect(hasBranch(root, 'main')).toBe(false);
    write(path.join(root, '.git'), 'not a pointer');
    expect(head(root)).toBeUndefined();
    fs.rmSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, '.git'));
    expect(head(root)).toBeUndefined();
  });
});
