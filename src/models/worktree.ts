import { z } from 'zod';

// ---------------------------------------------------------------------------
// Worktree — wairon metadata for a git worktree
//
// Git worktrees are managed by git itself; wairon stores a thin metadata file
// at .wai/worktrees/<id>/.wai-worktree.yaml to track what wairon knows about
// each worktree (which run/step it belongs to, its branch, sparse paths, etc.)
//
// The worktree directory lives at <worktreeBase>/<id>/  (default inside .wai/)
// ---------------------------------------------------------------------------

export const WorktreeStatusSchema = z.enum([
  'active',     // worktree exists and is healthy
  'merging',    // merge in progress (branch exists, not yet merged)
  'merged',     // branch was merged; worktree can be cleaned
  'abandoned',  // worktree exists but run was cancelled
  'removed',    // worktree directory was removed (metadata kept for history)
]);
export type WorktreeStatus = z.infer<typeof WorktreeStatusSchema>;

export const WorktreeSchema = z.object({
  /** Short identifier — used as the worktree directory name */
  id: z.string(),

  /** The git branch this worktree is on */
  branch: z.string(),

  /**
   * Path relative to project root where this worktree is located.
   * Typically `.wai/worktrees/<id>`
   */
  path: z.string(),

  /** Domain this worktree is scoped to (null = whole repo) */
  domainId: z.string().nullable().default(null),

  /**
   * Sparse checkout paths materialised in this worktree.
   * Empty array means full checkout (no sparsity).
   */
  sparsePaths: z.array(z.string()).default([]),

  status: WorktreeStatusSchema.default('active'),

  /** Run id that owns this worktree (if created by a pipeline/run) */
  runId: z.string().optional(),

  /** Step id that owns this worktree */
  stepId: z.string().optional(),

  /** The target branch to merge into when work is done */
  targetBranch: z.string().optional(),

  createdAt: z.string().datetime(),
  mergedAt:  z.string().datetime().optional(),
});
export type Worktree = z.infer<typeof WorktreeSchema>;
