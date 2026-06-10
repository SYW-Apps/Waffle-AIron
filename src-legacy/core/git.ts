import { spawnSync } from 'child_process';

// ---------------------------------------------------------------------------
// git — thin wrapper around the git CLI
//
// Every function here:
//   - Runs git as a child process (no libgit2 dependency)
//   - Throws a GitError with the stderr output on failure
//   - Accepts an optional `cwd` to run in (defaults to process.cwd())
// ---------------------------------------------------------------------------

export class GitError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

function run(args: string[], cwd?: string): string {
  const result = spawnSync('git', args, {
    cwd: cwd ?? process.cwd(),
    encoding: 'utf-8',
  });

  if (result.error) {
    throw new GitError(`git ${args[0]} failed: ${result.error.message}`, args.join(' '), '');
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? '';
    throw new GitError(
      `git ${args[0]} failed (exit ${result.status}): ${stderr}`,
      args.join(' '),
      stderr,
    );
  }
  return (result.stdout ?? '').trim();
}

// ---------------------------------------------------------------------------
// Repository info
// ---------------------------------------------------------------------------

/** Returns the root directory of the git repo (absolute path). */
export function repoRoot(cwd?: string): string {
  return run(['rev-parse', '--show-toplevel'], cwd);
}

/** Returns the name of the current branch. */
export function currentBranch(cwd?: string): string {
  return run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

/** Returns true if there are uncommitted changes in the working tree. */
export function hasUncommittedChanges(cwd?: string): boolean {
  const output = run(['status', '--porcelain'], cwd);
  return output.length > 0;
}

/** Returns list of all local branches. */
export function listBranches(cwd?: string): string[] {
  const out = run(['branch', '--list', '--format=%(refname:short)'], cwd);
  return out.split('\n').map((b) => b.trim()).filter(Boolean);
}

/** Returns true if the given branch exists locally. */
export function branchExists(branch: string, cwd?: string): boolean {
  return listBranches(cwd).includes(branch);
}

// ---------------------------------------------------------------------------
// Worktree operations
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  bare: boolean;
}

/** Parse `git worktree list --porcelain` output into structured records. */
export function listWorktrees(cwd?: string): WorktreeInfo[] {
  const out = run(['worktree', 'list', '--porcelain'], cwd);
  const records: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) records.push(current as WorktreeInfo);
      current = { path: line.slice('worktree '.length), bare: false };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line === 'bare') {
      current.bare = true;
    }
  }
  if (current.path) records.push(current as WorktreeInfo);
  return records;
}

/**
 * Create a new worktree at `worktreePath` on `branch`.
 * If `branch` doesn't exist yet, pass `newBranch: true` to create it from
 * `baseBranch` (defaults to current HEAD).
 */
export function addWorktree(
  worktreePath: string,
  branch: string,
  options: { newBranch?: boolean; baseBranch?: string; cwd?: string } = {},
): void {
  const args = ['worktree', 'add'];
  if (options.newBranch) {
    args.push('-b', branch);
  }
  args.push(worktreePath);
  if (options.newBranch && options.baseBranch) {
    args.push(options.baseBranch);
  } else if (!options.newBranch) {
    args.push(branch);
  }
  run(args, options.cwd);
}

/**
 * Remove a worktree (the directory and git's reference to it).
 * Pass `force: true` to remove even if there are changes.
 */
export function removeWorktree(
  worktreePath: string,
  options: { force?: boolean; cwd?: string } = {},
): void {
  const args = ['worktree', 'remove'];
  if (options.force) args.push('--force');
  args.push(worktreePath);
  run(args, options.cwd);
}

/** Run `git worktree prune` to clean up stale worktree references. */
export function pruneWorktrees(cwd?: string): void {
  run(['worktree', 'prune'], cwd);
}

// ---------------------------------------------------------------------------
// Sparse checkout
// ---------------------------------------------------------------------------

/**
 * Enable sparse checkout in a worktree and set the paths to materialise.
 * Must be called with `cwd` set to the worktree directory.
 */
export function setSparseCheckout(paths: string[], cwd: string): void {
  // Enable sparse-checkout in cone mode (most efficient)
  run(['sparse-checkout', 'init', '--cone'], cwd);
  // Set the directories/paths to materialise
  run(['sparse-checkout', 'set', ...paths], cwd);
}

/** Disable sparse checkout (materialise full tree) in a worktree. */
export function disableSparseCheckout(cwd: string): void {
  run(['sparse-checkout', 'disable'], cwd);
}

// ---------------------------------------------------------------------------
// Branch operations
// ---------------------------------------------------------------------------

/** Create a new local branch from the given base (defaults to HEAD). */
export function createBranch(branch: string, base?: string, cwd?: string): void {
  const args = ['branch', branch];
  if (base) args.push(base);
  run(args, cwd);
}

/** Delete a local branch. Pass `force: true` for unmerged branches. */
export function deleteBranch(branch: string, options: { force?: boolean; cwd?: string } = {}): void {
  const flag = options.force ? '-D' : '-d';
  run(['branch', flag, branch], options.cwd);
}

// ---------------------------------------------------------------------------
// Merge operations
// ---------------------------------------------------------------------------

export interface MergeOptions {
  /** Strategy message (default: --no-ff) */
  noFf?: boolean;
  /** Commit message */
  message?: string;
  cwd?: string;
}

/**
 * Merge `branch` into the current branch.
 * Throws GitError if there are conflicts — caller must handle.
 */
export function mergeBranch(branch: string, options: MergeOptions = {}): void {
  const args = ['merge'];
  if (options.noFf !== false) args.push('--no-ff');
  if (options.message) args.push('-m', options.message);
  args.push(branch);
  run(args, options.cwd);
}

/** Returns true if the current working tree is in a merge conflict state. */
export function isInMergeConflict(cwd?: string): boolean {
  try {
    const out = run(['status', '--porcelain'], cwd);
    return out.split('\n').some((l) => l.startsWith('UU') || l.startsWith('AA') || l.startsWith('DD'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/** Switch the current branch (in the cwd worktree). */
export function checkout(branch: string, cwd?: string): void {
  run(['checkout', branch], cwd);
}
