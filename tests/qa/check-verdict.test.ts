import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';

// The release QA gate's CI check (qa/scripts/check-verdict.mjs), run against a
// throwaway git repository: a verdict clears a pull request only when it passed,
// its RC is an ancestor of HEAD, and no shipped file moved after the RC.

const SCRIPT = path.resolve(__dirname, '..', '..', 'qa', 'scripts', 'check-verdict.mjs');

describe('qa/scripts/check-verdict.mjs', () => {
  let repo: string;
  const git = (...args: string[]): string => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
  }).trim();
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  const commit = (msg: string): string => {
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  const verdict = (rc: string, result = 'PASS'): void =>
    write('qa/verdicts/6.0.0.md', `---\nversion: 6.0.0\nrc: ${rc}\ndate: 2026-01-01\nresult: ${result}\n---\nbody\n`);
  const check = (): { code: number | null; out: string } => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  let rc: string;
  let main: string;
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-verdict-'));
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    write('src/a.ts', 'export const a = 1;\n');
    write('package.json', '{}\n');
    rc = commit('rc');
    main = git('rev-parse', '--abbrev-ref', 'HEAD');
  });
  afterAll(() => { fs.rmSync(repo, { recursive: true, force: true }); });

  it('fails when there is no verdict', () => {
    expect(check().code).toBe(1);
  });

  it('passes for a PASS verdict whose RC is an ancestor, after only docs, lock and QA files moved', () => {
    verdict(rc);
    write('CHANGELOG.md', 'notes\n');
    write('.wai/lock.json', '{}\n');
    commit('verdict + docs');
    const r = check();
    expect(r.code, r.out).toBe(0);
  });

  it('fails when the verdict says FAIL', () => {
    verdict(rc, 'FAIL');
    commit('failed verdict');
    const r = check();
    expect(r.code).toBe(1);
    expect(r.out).toContain('not PASS');
    verdict(rc);
    commit('pass again');
  });

  it('fails when the RC is not an ancestor of head', () => {
    git('checkout', '-q', '--orphan', 'unrelated');
    write('x.txt', 'x\n');
    commit('unrelated history');
    const r = check();
    expect(r.code).toBe(1);
    expect(r.out).toContain('not an ancestor');
    git('checkout', '-q', '-f', main);
  });

  it('fails when a shipped file changed after the RC, and names it', () => {
    write('src/a.ts', 'export const a = 2;\n');
    commit('fix after rc');
    const r = check();
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/a.ts');
  });

  it('fails when package.json changed after the RC', () => {
    git('reset', '-q', '--hard', 'HEAD~1');
    write('package.json', '{"version":"1"}\n');
    commit('bump');
    expect(check().out).toContain('package.json');
  });
});
