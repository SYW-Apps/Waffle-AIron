import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { lastCommitOf, commitTime } from '../../src/core/adapters/git-source.js';

// ---------------------------------------------------------------------------
// git_source_adapter.lastCommitOf(until) and commitTime: how a member's own
// last committed approval is read as of a moment (surface diff's baseline).
// ---------------------------------------------------------------------------

let dir: string;
afterEach(() => { try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win locks */ } });

/** Commit the file with an explicit committer/author time, quietly. */
function commit(file: string, body: string, at: string): string {
  fs.writeFileSync(path.join(dir, file), body);
  const env = { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env, encoding: 'utf8' }).trim();
  git('add', '-A');
  git('commit', '-q', '-m', `edit ${file}`);
  return git('rev-parse', 'HEAD');
}

describe('git_source_adapter.lastCommitOf / commitTime', () => {
  it('answers the last commit of a file, as of a moment when given, and the committer time of a commit', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gitsrc-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const first = commit('lock.json', '1', '2026-11-01T10:00:00Z');
    const second = commit('lock.json', '2', '2026-11-10T10:00:00Z');

    expect(lastCommitOf(dir, 'lock.json')).toBe(second);
    expect(lastCommitOf(dir, 'lock.json', new Date('2026-11-05T00:00:00Z'))).toBe(first);
    // At the very moment of the later commit it still counts: the comparison is inclusive.
    expect(lastCommitOf(dir, 'lock.json', new Date('2026-11-10T10:00:00Z'))).toBe(second);
    // Before any commit: none.
    expect(lastCommitOf(dir, 'lock.json', new Date('2026-10-01T00:00:00Z'))).toBeNull();
    expect(lastCommitOf(dir, 'absent.json')).toBeNull();

    expect(commitTime(dir, second)?.toISOString()).toBe('2026-11-10T10:00:00.000Z');
    expect(commitTime(dir, 'deadbeef')).toBeNull();
  });

  it('answers none outside a work tree', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gitsrc-'));
    expect(lastCommitOf(dir, 'lock.json')).toBeNull();
    expect(commitTime(dir, 'HEAD')).toBeNull();
  });
});
