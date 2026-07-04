// ---------------------------------------------------------------------------
// Git-backing value types (sdd_git)
// ---------------------------------------------------------------------------

/** A project's git-backing configuration (persisted at .wai/git.json). */
export interface GitConfig {
  enabled: boolean;
  remote: string;
  defaultBranch: string;
  workingBranch: string;
}

/** Outcome of publishing a lock to git — never a merge. */
export interface GitPublish {
  published: boolean;
  commitSha?: string;
  compareUrl?: string;
}
