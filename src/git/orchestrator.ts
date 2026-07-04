import { readGitConfig, writeGitConfig, clearGitConfig } from './config.js';
import * as adapter from './adapter.js';
import type { GitPublish } from './types.js';

// ---------------------------------------------------------------------------
// Git Orchestrator (sdd_git)
//
// The git-backing workflows. sync and publish no-op when the project is not
// git-backed, so the hosting server can call them unconditionally in the lock
// flow. Operates on the bound (request-scoped) project.
// ---------------------------------------------------------------------------

const WORKING_BRANCH = 'wairon/work';

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

/** Commit the promoted working tree, push, and return the compare URL (no-op if native). */
export function publish(message: string): GitPublish {
  const config = readGitConfig();
  if (!config || !config.enabled) return { published: false };
  const commitSha = adapter.commitAll(message);
  adapter.push(config.workingBranch);
  const compareUrl = adapter.compareUrl(config.remote, config.defaultBranch, config.workingBranch);
  return { published: true, commitSha, compareUrl };
}
