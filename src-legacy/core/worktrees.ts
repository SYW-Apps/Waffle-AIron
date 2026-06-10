import * as fs from 'fs';
import * as path from 'path';
import { aiDir, ensureDir, fromProjectRoot, pathExists } from '../utils/fs.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';
import { Worktree, WorktreeSchema } from '../models/worktree.js';
import {
  addWorktree,
  removeWorktree,
  pruneWorktrees,
  setSparseCheckout,
  branchExists,
  currentBranch,
} from './git.js';

// ---------------------------------------------------------------------------
// Worktree storage — .wai/worktrees/<id>/.wai-worktree.yaml
// ---------------------------------------------------------------------------

function worktreesDir(): string {
  return aiDir('worktrees');
}

function worktreeDir(id: string): string {
  return aiDir('worktrees', id);
}

function worktreeMetaPath(id: string): string {
  return path.join(worktreeDir(id), '.wai-worktree.yaml');
}

export function loadWorktree(id: string): Worktree {
  const raw = readYamlFile(worktreeMetaPath(id));
  if (!raw) throw new Error(`Worktree "${id}" metadata not found.`);
  return WorktreeSchema.parse(raw);
}

export function saveWorktree(wt: Worktree): void {
  writeYamlFile(worktreeMetaPath(wt.id), wt);
}

export function listWorktrees(): Worktree[] {
  const dir = worktreesDir();
  if (!pathExists(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      try { return loadWorktree(e.name); } catch { return null; }
    })
    .filter((w): w is Worktree => w !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---------------------------------------------------------------------------
// Worktree ID generation
// ---------------------------------------------------------------------------

function generateWorktreeId(label?: string): string {
  const base = label
    ? label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28)
    : 'wt';
  const rand = Math.random().toString(36).slice(2, 5);
  return `${base}-${rand}`;
}

// ---------------------------------------------------------------------------
// Guard: require git.waironManaged = true
// ---------------------------------------------------------------------------

export function assertGitManaged(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadProjectConfig } = require('../config/loader.js') as typeof import('../config/loader.js');
  const config = loadProjectConfig();
  if (!config.git?.waironManaged) {
    throw new Error(
      'wairon git management is not enabled for this project.\n' +
      'Add the following to .wai/project.yaml and try again:\n\n' +
      '  git:\n    waironManaged: true\n'
    );
  }
}

// ---------------------------------------------------------------------------
// Create a worktree
// ---------------------------------------------------------------------------

export interface CreateWorktreeOptions {
  /** Human-readable label (used for id generation and branch name) */
  label: string;
  /** Branch to create / check out in the worktree */
  branch: string;
  /** Create a new branch (true) or check out an existing one (false) */
  newBranch?: boolean;
  /** Base branch/ref for the new branch (defaults to current HEAD) */
  baseBranch?: string;
  /** Domain to scope to — drives sparse-checkout paths */
  domainId?: string;
  /** Explicit sparse-checkout paths (overrides domain auto-detection) */
  sparsePaths?: string[];
  /** Run + step that created this worktree */
  runId?: string;
  stepId?: string;
  /** The branch to merge into when done */
  targetBranch?: string;
}

export interface CreateWorktreeResult {
  worktree: Worktree;
  worktreePath: string;
}

export function createWorktree(options: CreateWorktreeOptions): CreateWorktreeResult {
  assertGitManaged();

  const id           = generateWorktreeId(options.label);
  const wtPath       = worktreeDir(id);
  const wtAbsPath    = fromProjectRoot(wtPath);
  const projectRoot  = fromProjectRoot();

  // Determine sparse paths
  let sparsePaths: string[] = options.sparsePaths ?? [];
  if (sparsePaths.length === 0 && options.domainId) {
    sparsePaths = _sparsePathsForDomain(options.domainId);
  }

  // Ensure .wai/worktrees/ exists (git needs the parent to exist)
  ensureDir(fromProjectRoot(worktreesDir()));

  // Add the worktree
  addWorktree(wtAbsPath, options.branch, {
    newBranch:  options.newBranch ?? !branchExists(options.branch),
    baseBranch: options.baseBranch,
    cwd:        projectRoot,
  });

  // Apply sparse checkout if requested
  if (sparsePaths.length > 0) {
    setSparseCheckout(sparsePaths, wtAbsPath);
  }

  // Write wairon metadata
  const worktree: Worktree = WorktreeSchema.parse({
    id,
    branch:      options.branch,
    path:        wtPath,
    domainId:    options.domainId ?? null,
    sparsePaths,
    status:      'active',
    runId:       options.runId,
    stepId:      options.stepId,
    targetBranch: options.targetBranch ?? currentBranch(projectRoot),
    createdAt:   new Date().toISOString(),
  });

  saveWorktree(worktree);

  return { worktree, worktreePath: wtAbsPath };
}

// ---------------------------------------------------------------------------
// Merge a worktree branch back into the target
// ---------------------------------------------------------------------------

export interface MergeWorktreeOptions {
  /** Override the target branch declared in the worktree metadata */
  targetBranch?: string;
  /** Skip confirmation (caller is responsible for prompting) */
  force?: boolean;
}

export interface MergeWorktreeResult {
  merged:       boolean;
  targetBranch: string;
  message:      string;
}

export function mergeWorktree(
  id: string,
  options: MergeWorktreeOptions = {},
): MergeWorktreeResult {
  assertGitManaged();

  const wt           = loadWorktree(id);
  const projectRoot  = fromProjectRoot();
  const target       = options.targetBranch ?? wt.targetBranch ?? currentBranch(projectRoot);

  if (wt.status === 'merged') {
    return { merged: false, targetBranch: target, message: `Worktree "${id}" is already merged.` };
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { checkout, mergeBranch } = require('./git.js') as typeof import('./git.js');

  // Switch to target branch in main worktree
  checkout(target, projectRoot);

  // Merge
  const commitMsg = `merge: ${wt.branch} → ${target} (wairon worktree ${id})`;
  mergeBranch(wt.branch, { noFf: true, message: commitMsg, cwd: projectRoot });

  // Update metadata
  wt.status   = 'merged';
  wt.mergedAt = new Date().toISOString();
  saveWorktree(wt);

  return { merged: true, targetBranch: target, message: commitMsg };
}

// ---------------------------------------------------------------------------
// Remove a worktree
// ---------------------------------------------------------------------------

export interface RemoveWorktreeOptions {
  /** Remove even if there are uncommitted changes */
  force?: boolean;
  /** Also delete the branch */
  deleteBranch?: boolean;
}

export function removeWorktreeById(id: string, options: RemoveWorktreeOptions = {}): void {
  const wt          = loadWorktree(id);
  const projectRoot = fromProjectRoot();
  const wtAbsPath   = fromProjectRoot(wt.path);

  if (pathExists(wtAbsPath)) {
    try {
      removeWorktree(wtAbsPath, { force: options.force, cwd: projectRoot });
    } catch (err) {
      if (!options.force) throw err;
      // Force: remove directory manually and prune
      fs.rmSync(wtAbsPath, { recursive: true, force: true });
      pruneWorktrees(projectRoot);
    }
  } else {
    pruneWorktrees(projectRoot);
  }

  if (options.deleteBranch && branchExists(wt.branch, projectRoot)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { deleteBranch: gitDeleteBranch } = require('./git.js') as typeof import('./git.js');
      gitDeleteBranch(wt.branch, { force: true, cwd: projectRoot });
    } catch {
      // best effort
    }
  }

  // Mark as removed in metadata (keep file for history)
  wt.status = 'removed';
  saveWorktree(wt);
}

// ---------------------------------------------------------------------------
// Clean — remove all merged/abandoned/removed worktrees
// ---------------------------------------------------------------------------

export function cleanWorktrees(options: { all?: boolean } = {}): number {
  const wts = listWorktrees();
  let removed = 0;

  for (const wt of wts) {
    const shouldRemove = options.all
      || ['merged', 'abandoned', 'removed'].includes(wt.status);

    if (shouldRemove) {
      try {
        removeWorktreeById(wt.id, { force: true });
        removed++;
      } catch {
        // best effort
      }
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _sparsePathsForDomain(domainId: string): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadDomainRegistry } = require('../config/loader.js') as typeof import('../config/loader.js');
    const registry = loadDomainRegistry();
    const domain   = registry.domains.find((d) => d.id === domainId);
    if (!domain) return [];

    const paths: string[] = [];
    // The domain directory itself
    paths.push(domain.path.replace(/\\/g, '/').replace(/\/$/, ''));

    // Any domains explicitly named "__shared" (wairon's shared-context convention)
    const sharedDomains = registry.domains.filter(
      (d) => d.id !== domainId && d.id === '__shared',
    );
    for (const sd of sharedDomains) {
      paths.push(sd.path.replace(/\\/g, '/').replace(/\/$/, ''));
    }

    return paths;
  } catch {
    return [];
  }
}
