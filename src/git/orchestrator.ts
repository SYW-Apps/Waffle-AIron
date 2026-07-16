import { readGitConfig, writeGitConfig, clearGitConfig } from './config.js';
import * as adapter from './adapter.js';
import type { GitBackingStatus, GitPublish } from './types.js';

// ---------------------------------------------------------------------------
// Git Orchestrator (sdd_git)
//
// The git-backing workflows: bind the project to its REAL repository, keep the
// working branch integrated, and publish DELIBERATE, .wai/-scoped commits
// (never `git add -A`). sync and publish no-op when the project is not
// git-backed, so the hosting server can call them unconditionally in the lock
// flow. Operates on the bound (request-scoped) project.
// ---------------------------------------------------------------------------

const WORKING_BRANCH = 'wairon/work';

/** The default staging scope: wairon owns ONLY the .wai/ tree inside a bound
 *  repository, so the repo can be shared with the project's own codebase. */
const DEFAULT_SCOPE = '.wai/';

/** Clone the remote onto the isolated working branch and persist the config. */
export function enable(remote: string, branch: string): void {
  const defaultBranch = branch || 'main';
  adapter.clone(remote, defaultBranch);
  adapter.ensureWorkingBranch(WORKING_BRANCH);
  adapter.excludeLocalFiles();
  writeGitConfig({ enabled: true, remote, defaultBranch, workingBranch: WORKING_BRANCH });
}

export function disable(): void {
  clearGitConfig();
}

/** Fetch + integrate the default branch into the working branch (no-op if native). */
export function sync(): void {
  const config = readGitConfig();
  if (!config || !config.enabled) return;
  adapter.fetch();
  adapter.integrateDefault(config.defaultBranch);
}

/**
 * Commit ONLY the scoped subpath (default .wai/) of the working tree, push the
 * working branch, and return the compare URL. No-op (published=false) when not
 * git-backed OR when the scoped path is clean — a quiet project never commits
 * noise. Commit = the local save, push = the actual backup; both happen.
 */
export function publish(message: string, subpath: string = DEFAULT_SCOPE): GitPublish {
  const config = readGitConfig();
  if (!config || !config.enabled) return { published: false };
  const commitSha = adapter.commitScoped(subpath, message);
  if (commitSha === null) return { published: false }; // clean scope
  adapter.push(config.workingBranch);
  const compareUrl = adapter.compareUrl(config.remote, config.defaultBranch, config.workingBranch);
  writeGitConfig({ ...config, lastSyncAt: new Date().toISOString() });
  return { published: true, commitSha, compareUrl };
}

/** The project's git-backing status: bound remote/branch, the periodic-sync
 *  setting, and scoped .wai/ dirtiness; enabled:false when no config exists. */
export function status(): GitBackingStatus {
  const config = readGitConfig();
  if (!config || !config.enabled) return { enabled: false };
  const backing: GitBackingStatus = {
    enabled: true,
    remote: config.remote,
    branch: config.defaultBranch,
    workingBranch: config.workingBranch,
    dirty: !adapter.isClean(DEFAULT_SCOPE),
  };
  if (config.periodicSyncMinutes !== undefined) backing.periodicSyncMinutes = config.periodicSyncMinutes;
  if (config.skipIfClean !== undefined) backing.skipIfClean = config.skipIfClean;
  if (config.lastSyncAt !== undefined) backing.lastSyncAt = config.lastSyncAt;
  return backing;
}

/** Persist the periodic-sync setting (interval + skip-if-clean, default true)
 *  into the project's git-backing config; rejects when not git-backed. */
export function configureSync(periodicSyncMinutes?: number, skipIfClean?: boolean): void {
  const config = readGitConfig();
  if (!config || !config.enabled) {
    throw new Error('not git-backed — bind a repository first');
  }
  const next = { ...config };
  if (periodicSyncMinutes === undefined) delete next.periodicSyncMinutes;
  else next.periodicSyncMinutes = periodicSyncMinutes;
  next.skipIfClean = skipIfClean ?? true;
  writeGitConfig(next);
}
