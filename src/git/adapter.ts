import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getProjectRoot } from '../utils/fs.js';

// ---------------------------------------------------------------------------
// Git Client Adapter (sdd_git)
//
// The only block doing git I/O. Runs the git CLI against the bound project's
// checkout using the container's bot identity (WAIRON_GIT_TOKEN + committer
// name/email). The token is injected into the clone URL, so `origin` carries it
// for later fetch/push — this lives only in the container-local .git/config,
// never in the repo.
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

/** Inject the bot token into an https remote so fetch/push authenticate. */
function authRemote(remote: string): string {
  const token = process.env['WAIRON_GIT_TOKEN'];
  if (!token || !/^https:\/\//.test(remote)) return remote;
  return remote.replace(/^https:\/\//, `https://x-access-token:${token}@`);
}

/** Clone the remote (at branch) into the bound (empty) project directory. */
export function clone(remote: string, branch: string): void {
  git(['clone', '--branch', branch, authRemote(remote), '.']);
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

/** Stage and commit the working tree; return the resulting commit SHA. */
export function commitAll(message: string): string {
  git(['add', '-A']);
  try {
    git(['commit', '-m', message]);
  } catch {
    /* nothing to commit — return the existing HEAD */
  }
  return git(['rev-parse', 'HEAD']);
}

export function push(branch: string): void {
  git(['push', 'origin', branch]);
}

/** Host-agnostic best-effort compare/PR URL for workingBranch -> defaultBranch. */
export function compareUrl(remote: string, defaultBranch: string, workingBranch: string): string {
  const web = remote.replace(/\.git$/, '').replace(/\/$/, '');
  return `${web}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(workingBranch)}`;
}

/** Keep container-local files (lock.json, git.json) out of commits, without
 *  touching the repo's own .gitignore. */
export function excludeLocalFiles(): void {
  const excludePath = path.join(getProjectRoot(), '.git', 'info', 'exclude');
  try {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.appendFileSync(excludePath, '\n.wai/lock.json\n.wai/git.json\n');
  } catch {
    /* best effort */
  }
}
