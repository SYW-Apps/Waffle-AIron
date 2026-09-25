import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getProjectRoot } from '../utils/fs.js';

// ---------------------------------------------------------------------------
// Git Client Adapter (sdd_git)
//
// The only block doing git I/O. Runs the git CLI against the bound project's
// checkout using the container's bot identity (committer name/email). The
// token is INJECTED by whoever wires the clone up — the caller resolves it
// (the hosted plane from its own secret repository); this module never asks
// anyone for a secret by name. It goes into the clone URL, so `origin` carries
// it for later fetch/push — only in the container-local .git/config, never in
// the repo.
// ---------------------------------------------------------------------------

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd: cwd ?? getProjectRoot(),
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function gitName(): string {
  return process.env['WAIRON_GIT_NAME'] || 'wairon-bot';
}
function gitEmail(): string {
  return process.env['WAIRON_GIT_EMAIL'] || 'wairon-bot@localhost';
}

/** Inject the token into an https remote so fetch/push authenticate. */
function authRemote(remote: string, token: string | null): string {
  if (!token || !/^https:\/\//.test(remote)) return remote;
  return remote.replace(/^https:\/\//, `https://x-access-token:${token}@`);
}

/** Clone the remote (at branch) into the bound (empty) project directory. The
 *  token is injected into the clone URL, so `origin` carries it for later
 *  fetch/push (container-local .git/config only, never the repo). */
export function clone(token: string | null, remote: string, branch: string): void {
  git(['clone', '--branch', branch, authRemote(remote, token), '.']);
  git(['config', 'user.name', gitName()]);
  git(['config', 'user.email', gitEmail()]);
}

export function fetch(): void {
  git(['fetch', 'origin']);
}

/** Create or reset the isolated working branch at the current HEAD. */
export function ensureWorkingBranch(name: string): void {
  git(['checkout', '-B', name]);
}

/** Integrate the default branch into the current working branch. */
export function integrateDefault(defaultBranch: string): void {
  git(['merge', '--no-edit', `origin/${defaultBranch}`]);
}

/**
 * Stage ONLY the given subpath (pathspec-confined — never the whole tree) and
 * commit; returns the new commit SHA, or null when nothing under the subpath
 * changed (a clean scope never produces an empty commit). There is deliberately
 * NO stage-everything operation anymore: `git add -A` was the bug that made a
 * repository shared with the project's own codebase unsafe — wairon must never
 * commit a team's own files.
 */
export function commitScoped(subpath: string, message: string): string | null {
  git(['add', '--', subpath]);
  const staged = git(['diff', '--cached', '--name-only', '--', subpath]);
  if (!staged) return null;
  git(['commit', '-m', message, '--', subpath]);
  return git(['rev-parse', 'HEAD']);
}

/** True when the given subpath holds no uncommitted changes (scoped
 *  `status --porcelain -- <subpath>`), backing the skip-if-clean sweep check. */
export function isClean(subpath: string): boolean {
  return git(['status', '--porcelain', '--', subpath]) === '';
}

export function push(branch: string): void {
  git(['push', 'origin', branch]);
}

/** Host-agnostic best-effort compare/PR URL for workingBranch -> defaultBranch. */
export function compareUrl(remote: string, defaultBranch: string, workingBranch: string): string {
  const web = remote.replace(/\.git$/, '').replace(/\/$/, '');
  return `${web}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(workingBranch)}`;
}

/**
 * Keep CONTAINER-LOCAL files out of commits, without touching the repo's own
 * .gitignore. Only .wai/git.json qualifies — it holds this container's own
 * connection config, meaningless (and potentially stale) anywhere else.
 *
 * .wai/lock.json is DELIBERATELY not excluded: approvals live there now, and a
 * hosted project's approval must reach the remote for the record to mean
 * anything outside this container. An earlier wairon version excluded it; that
 * exclusion is actively removed (with a warning) rather than left in place, so
 * an upgraded container stops silently hiding an approval that should ship.
 * Idempotent — re-enabling never duplicates the git.json line.
 */
export function excludeLocalFiles(): void {
  const excludePath = path.join(getProjectRoot(), '.git', 'info', 'exclude');
  try {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    const lines = existing.split(/\r?\n/).filter((line) => line.length > 0);

    const hadLegacyLockExclusion = lines.some((line) => line.trim() === '.wai/lock.json');
    const kept = lines.filter((line) => line.trim() !== '.wai/lock.json');
    if (!kept.some((line) => line.trim() === '.wai/git.json')) {
      kept.push('.wai/git.json');
    }
    fs.writeFileSync(excludePath, kept.join('\n') + '\n');

    if (hadLegacyLockExclusion) {
      console.warn(
        '[wairon git] removed a .wai/lock.json exclusion left by an earlier version — the approval it ' +
          'records is committed with the rest of .wai/ now, so it reaches the remote.',
      );
    }
  } catch {
    /* best effort */
  }
}
