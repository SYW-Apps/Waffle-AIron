import * as fs from 'fs';
import * as path from 'path';
import { DetectedDomainCandidate, DomainType } from '../models/domain.js';
import { SCAN_EXCLUDE_DIRS } from '../config/defaults.js';

// ---------------------------------------------------------------------------
// Domain detection
//
// Scans the project for directories that are good candidates for agent
// domains. Three detection strategies:
//
//   1. Git submodules — parsed from .gitmodules (most reliable signal)
//   2. Nested .git repos — directories containing their own .git folder
//   3. Package roots — directories with package.json / pyproject.toml / etc.
//
// All results are candidates only. The user confirms which to include.
// ---------------------------------------------------------------------------

const PACKAGE_MARKERS = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'build.gradle',
  'build.gradle.kts',
  'pom.xml',
];

const MAX_SCAN_DEPTH = 5;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a project root and return all domain candidates.
 * Already-tracked domain paths are marked with alreadyTracked: true.
 *
 * De-duplication rules applied after detection:
 *   - package-root entries whose path is inside a git-submodule or git-repo
 *     are suppressed (the submodule already represents that boundary)
 *   - candidates with conflicting suggestedIds get their parent path segment
 *     prepended to produce a unique id (e.g. shared → packages-shared)
 */
export function detectDomainCandidates(
  projectRoot: string,
  alreadyTrackedPaths: Set<string> = new Set(),
  alreadyTrackedIds: Set<string> = new Set(),
): DetectedDomainCandidate[] {
  const candidates = new Map<string, DetectedDomainCandidate>();

  // 1. Git submodules (highest confidence)
  for (const c of detectGitSubmodules(projectRoot)) {
    candidates.set(c.path, { ...c, alreadyTracked: alreadyTrackedPaths.has(c.path) });
  }

  // 2. Nested git repos (catches non-declared submodules)
  for (const c of detectNestedGitRepos(projectRoot)) {
    if (!candidates.has(c.path)) {
      candidates.set(c.path, { ...c, alreadyTracked: alreadyTrackedPaths.has(c.path) });
    }
  }

  // 3. Package roots — but skip any that live inside a git-submodule / git-repo
  const gitPaths = new Set(
    Array.from(candidates.values())
      .filter((c) => c.type === 'git-submodule' || c.type === 'git-repo')
      .map((c) => c.path),
  );

  for (const c of detectPackageRoots(projectRoot)) {
    if (candidates.has(c.path)) continue;
    // Suppress if the package root is inside any git boundary
    const insideGit = Array.from(gitPaths).some(
      (gp) => c.path === gp || c.path.startsWith(gp + '/'),
    );
    if (insideGit) continue;
    candidates.set(c.path, { ...c, alreadyTracked: alreadyTrackedPaths.has(c.path) });
  }

  const sorted = Array.from(candidates.values()).sort((a, b) => a.path.localeCompare(b.path));

  // Resolve duplicate suggestedIds — also counting ids already claimed in the registry
  return deduplicateIds(sorted, alreadyTrackedIds);
}

/**
 * If two candidates share the same suggestedId, qualify each with its parent
 * directory segment (e.g. "shared" in packages/ vs services/ → "packages-shared"
 * and "services-shared").
 */
function deduplicateIds(
  candidates: DetectedDomainCandidate[],
  existingIds: Set<string> = new Set(),
): DetectedDomainCandidate[] {
  const idCount = new Map<string, number>();
  // Pre-seed counts with ids already claimed in the registry so that a single
  // new candidate whose basename matches an existing domain still gets qualified.
  for (const id of existingIds) {
    idCount.set(id, (idCount.get(id) ?? 0) + 1);
  }
  for (const c of candidates) {
    idCount.set(c.suggestedId, (idCount.get(c.suggestedId) ?? 0) + 1);
  }

  return candidates.map((c) => {
    if ((idCount.get(c.suggestedId) ?? 0) <= 1) return c;
    // Qualify with parent segment
    const parts = c.path.split('/');
    const qualifiedId = parts.length >= 2
      ? pathToId(`${parts[parts.length - 2]}-${parts[parts.length - 1]}`)
      : c.suggestedId;
    return { ...c, suggestedId: qualifiedId };
  });
}

// ---------------------------------------------------------------------------
// Strategy 1: Git submodules
// ---------------------------------------------------------------------------

interface GitSubmoduleEntry {
  name: string;
  path: string;
  url: string;
}

function parseGitmodules(filePath: string): GitSubmoduleEntry[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const entries: GitSubmoduleEntry[] = [];
  let current: Partial<GitSubmoduleEntry> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    const headerMatch = trimmed.match(/^\[submodule "(.+)"\]$/);
    if (headerMatch) {
      if (current.path) entries.push(current as GitSubmoduleEntry);
      current = { name: headerMatch[1] };
      continue;
    }

    const keyVal = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (keyVal) {
      const [, key, value] = keyVal;
      if (key === 'path') current.path = value.trim();
      if (key === 'url') current.url = value.trim();
    }
  }

  if (current.path) entries.push(current as GitSubmoduleEntry);
  return entries;
}

function detectGitSubmodules(projectRoot: string): DetectedDomainCandidate[] {
  const gitmodulesPath = path.join(projectRoot, '.gitmodules');
  if (!fs.existsSync(gitmodulesPath)) return [];

  return parseGitmodules(gitmodulesPath).map((entry) => ({
    suggestedId: pathToId(entry.path),
    suggestedName: pathToName(entry.path),
    path: normalizePath(entry.path),
    type: 'git-submodule' as DomainType,
    alreadyTracked: false,
  }));
}

// ---------------------------------------------------------------------------
// Strategy 2: Nested .git repos
// ---------------------------------------------------------------------------

function detectNestedGitRepos(projectRoot: string): DetectedDomainCandidate[] {
  const results: DetectedDomainCandidate[] = [];
  walkForGit(projectRoot, projectRoot, 0, results);
  return results;
}

function walkForGit(
  projectRoot: string,
  currentDir: string,
  depth: number,
  results: DetectedDomainCandidate[],
): void {
  if (depth > MAX_SCAN_DEPTH) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SCAN_EXCLUDE_DIRS.has(entry.name)) continue;

    const fullPath = path.join(currentDir, entry.name);
    const relPath = normalizePath(path.relative(projectRoot, fullPath));

    // Skip the project root itself
    if (relPath === '' || relPath === '.') continue;

    const gitPath = path.join(fullPath, '.git');
    if (fs.existsSync(gitPath)) {
      results.push({
        suggestedId: pathToId(relPath),
        suggestedName: pathToName(relPath),
        path: relPath,
        type: 'git-repo',
        alreadyTracked: false,
      });
      // Don't recurse into detected git repos — their internals are their own
      continue;
    }

    walkForGit(projectRoot, fullPath, depth + 1, results);
  }
}

// ---------------------------------------------------------------------------
// Strategy 3: Package roots
// ---------------------------------------------------------------------------

function detectPackageRoots(projectRoot: string): DetectedDomainCandidate[] {
  const results: DetectedDomainCandidate[] = [];
  walkForPackages(projectRoot, projectRoot, 0, results);
  return results;
}

function walkForPackages(
  projectRoot: string,
  currentDir: string,
  depth: number,
  results: DetectedDomainCandidate[],
): void {
  if (depth > MAX_SCAN_DEPTH) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SCAN_EXCLUDE_DIRS.has(entry.name)) continue;

    const fullPath = path.join(currentDir, entry.name);
    const relPath = normalizePath(path.relative(projectRoot, fullPath));
    if (relPath === '' || relPath === '.') continue;

    const hasMarker = PACKAGE_MARKERS.some((m) => fs.existsSync(path.join(fullPath, m)));
    if (hasMarker) {
      results.push({
        suggestedId: pathToId(relPath),
        suggestedName: pathToName(relPath),
        path: relPath,
        type: 'package-root',
        alreadyTracked: false,
      });
    }

    walkForPackages(projectRoot, fullPath, depth + 1, results);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a relative path to a domain id: "services/core-service" → "core-service" */
function pathToId(relPath: string): string {
  const basename = path.basename(relPath);
  return basename
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Convert a relative path to a display name: "services/core-service" → "Core Service" */
function pathToName(relPath: string): string {
  const id = pathToId(relPath);
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Normalize path separators to forward slashes */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}
