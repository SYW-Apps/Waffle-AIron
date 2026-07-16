// ---------------------------------------------------------------------------
// Git-backing value types (sdd_git)
// ---------------------------------------------------------------------------

/** A project's git-backing configuration: the binding to the project's REAL
 *  repository — wairon manages ONLY the .wai/ tree inside it (commits are
 *  .wai/-scoped, never `git add -A`), so the repository is safely shared with
 *  the project's own codebase. Persisted at .wai/git.json. */
export interface GitConfig {
  enabled: boolean;
  remote: string;
  defaultBranch: string;
  workingBranch: string;
  /** Interval for the periodic .wai/-scoped backup sweep; absent disables
   *  periodic sync for this project. */
  periodicSyncMinutes?: number;
  /** The periodic sweep skips the commit when the scoped path is clean
   *  (default true) — a quiet project never commits noise. */
  skipIfClean?: boolean;
  /** ISO-8601 timestamp of the last successful publish (manual or periodic). */
  lastSyncAt?: string;
}

/** Outcome of publishing a lock to git — never a merge. */
export interface GitPublish {
  published: boolean;
  commitSha?: string;
  compareUrl?: string;
}

/** The read-model of a project's git backing for the admin surfaces. `dirty`
 *  reflects the scoped .wai/ path, never the whole working tree. */
export interface GitBackingStatus {
  enabled: boolean;
  remote?: string;
  branch?: string;
  workingBranch?: string;
  dirty?: boolean;
  periodicSyncMinutes?: number;
  skipIfClean?: boolean;
  lastSyncAt?: string;
}
