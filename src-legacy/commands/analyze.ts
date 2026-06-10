import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, loadRegistry } from '../config/loader.js';
import { AgentRecord } from '../models/agent.js';

// ---------------------------------------------------------------------------
// analyze command
//
// Walks the project directory and reports:
//   1. Paths with no owning agent (coverage gaps)
//   2. Agents with overlapping ownedPaths
//   3. Draft / deprecated agents still in registry
//   4. Overall coverage percentage
//
// Note: glob matching uses prefix-based heuristics. For exact glob semantics
// (e.g. `src/**/*.test.ts`) add micromatch to dependencies (see roadmap).
// ---------------------------------------------------------------------------

// Directories to skip entirely when walking the repo
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target',
  '.wai', '.wairon', '.claude', '.gemini', '.cursor', '.vscode',
  'coverage', '.nyc_output', '.cache',
]);

export async function runAnalyze(): Promise<void> {
  assertProjectInitialized();

  const registry = loadRegistry();
  const projectRoot = process.cwd();
  const activeAgents = registry.agents.filter((a) => a.status === 'active');

  logger.header('Repository Analysis');
  logger.blank();

  // ------------------------------------------------------------------
  // 1. Walk top-level entries
  // ------------------------------------------------------------------

  const entries = walkTopLevel(projectRoot);

  // ------------------------------------------------------------------
  // 2. Coverage analysis
  // ------------------------------------------------------------------

  const covered: string[] = [];
  const uncovered: string[] = [];
  const gaps: Array<{ entry: string; suggestion: string | null }> = [];

  for (const entry of entries) {
    const owners = activeAgents.filter((a) => pathIsCovered(entry, a.ownedPaths));
    if (owners.length > 0) {
      covered.push(entry);
    } else {
      uncovered.push(entry);
      gaps.push({ entry, suggestion: suggestBundle(entry) });
    }
  }

  const coveragePct = entries.length === 0
    ? 100
    : Math.round((covered.length / entries.length) * 100);

  // ------------------------------------------------------------------
  // 3. Overlapping ownership
  // ------------------------------------------------------------------

  const overlaps = findOverlaps(activeAgents);

  // ------------------------------------------------------------------
  // 4. Non-active agents
  // ------------------------------------------------------------------

  const drafts = registry.agents.filter((a) => a.status === 'draft');
  const deprecated = registry.agents.filter((a) => a.status === 'deprecated');

  // ------------------------------------------------------------------
  // Report
  // ------------------------------------------------------------------

  // Coverage summary
  const coverageColor = coveragePct >= 80 ? chalk.green : coveragePct >= 50 ? chalk.yellow : chalk.red;
  console.log(`${chalk.bold('Coverage')}  ${coverageColor(`${coveragePct}%`)}  (${covered.length} of ${entries.length} top-level paths owned)`);
  console.log();

  // Gaps
  if (gaps.length > 0) {
    console.log(chalk.bold(`Coverage gaps (${gaps.length})`));
    for (const { entry, suggestion } of gaps) {
      const hint = suggestion ? chalk.gray(`  → consider: wairon create-bundle --scope ${toScope(entry)} --dir ${entry}`) : '';
      console.log(`  ${chalk.red('✖')}  ${entry}${hint}`);
    }
    console.log();
  } else {
    console.log(`${chalk.green('✔')}  All top-level paths are covered.`);
    console.log();
  }

  // Overlapping ownership
  if (overlaps.length > 0) {
    console.log(chalk.bold(`Overlapping ownership (${overlaps.length})`));
    for (const { a, b, paths } of overlaps) {
      console.log(`  ${chalk.yellow('⚠')}  ${chalk.bold(a.id)} and ${chalk.bold(b.id)} both own:`);
      for (const p of paths) {
        console.log(`       ${chalk.gray(p)}`);
      }
    }
    console.log();
  }

  // Draft agents
  if (drafts.length > 0) {
    console.log(chalk.bold(`Draft agents (${drafts.length})`));
    for (const agent of drafts) {
      console.log(`  ${chalk.yellow('·')}  ${chalk.bold(agent.id)}  — ${agent.description}`);
    }
    console.log(chalk.gray('  Run `wairon show <id>` and promote them to active or remove them.'));
    console.log();
  }

  // Deprecated agents
  if (deprecated.length > 0) {
    console.log(chalk.bold(`Deprecated agents (${deprecated.length})`));
    for (const agent of deprecated) {
      console.log(`  ${chalk.gray('·')}  ${chalk.gray(chalk.bold(agent.id))}  — ${chalk.gray(agent.description)}`);
    }
    console.log(chalk.gray('  Remove them from .wai/registry/agents.json when no longer needed.'));
    console.log();
  }

  // All-clear summary
  if (gaps.length === 0 && overlaps.length === 0 && drafts.length === 0 && deprecated.length === 0) {
    logger.success('Topology looks clean — no gaps, overlaps, or stale agents.');
  }
}

// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------

function walkTopLevel(projectRoot: string): string[] {
  const entries: string[] = [];

  try {
    const items = fs.readdirSync(projectRoot, { withFileTypes: true });

    for (const item of items) {
      if (item.name.startsWith('.') && SKIP_DIRS.has(item.name)) continue;
      if (item.isDirectory() && SKIP_DIRS.has(item.name)) continue;
      if (item.name.startsWith('.')) continue; // skip hidden files/dirs

      const rel = item.isDirectory() ? item.name : item.name;
      entries.push(rel);

      // For directories, also walk one level deeper to improve gap detection
      if (item.isDirectory()) {
        try {
          const children = fs.readdirSync(path.join(projectRoot, item.name), { withFileTypes: true });
          for (const child of children) {
            if (child.isDirectory() && SKIP_DIRS.has(child.name)) continue;
            if (child.name.startsWith('.')) continue;
            entries.push(`${item.name}/${child.name}`);
          }
        } catch { /* unreadable — skip */ }
      }
    }
  } catch { /* unreadable root — return empty */ }

  return entries;
}

// ---------------------------------------------------------------------------
// Glob matching (prefix-based heuristics)
// ---------------------------------------------------------------------------

/**
 * Returns true if `relPath` is covered by any of the given glob patterns.
 *
 * Handles common patterns:
 *   **               → matches everything
 *   dir/**           → matches dir and everything under it
 *   dir/*            → matches direct children of dir
 *   dir/file.ts      → exact match
 */
function pathIsCovered(relPath: string, ownedPaths: string[]): boolean {
  return ownedPaths.some((pattern) => matchesGlob(relPath, pattern));
}

function matchesGlob(relPath: string, pattern: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  const pat = pattern.replace(/\\/g, '/');

  if (pat === '**' || pat === './**') return true;

  if (pat.endsWith('/**')) {
    const prefix = pat.slice(0, -3);
    return p === prefix || p.startsWith(prefix + '/');
  }

  if (pat.endsWith('/*')) {
    const prefix = pat.slice(0, -2);
    if (!p.startsWith(prefix + '/')) return false;
    const rest = p.slice(prefix.length + 1);
    return !rest.includes('/');
  }

  // Wildcard extension pattern: src/**/*.ts → covered if path starts with src/
  if (pat.includes('/**/*.')) {
    const prefix = pat.split('/**')[0];
    return p === prefix || p.startsWith(prefix + '/');
  }

  return p === pat || p.startsWith(pat + '/');
}

// ---------------------------------------------------------------------------
// Overlap detection
// ---------------------------------------------------------------------------

interface Overlap {
  a: AgentRecord;
  b: AgentRecord;
  paths: string[];
}

function findOverlaps(agents: AgentRecord[]): Overlap[] {
  const overlaps: Overlap[] = [];

  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const a = agents[i];
      const b = agents[j];

      const sharedPaths = a.ownedPaths.filter((p) =>
        b.ownedPaths.some((q) => patternsOverlap(p, q)),
      );

      if (sharedPaths.length > 0) {
        overlaps.push({ a, b, paths: sharedPaths });
      }
    }
  }

  return overlaps;
}

/**
 * Returns true if two glob patterns could match the same paths.
 * Conservative: only flags clear overlaps (same prefix or one subsumes the other).
 */
function patternsOverlap(a: string, b: string): boolean {
  const na = a.replace(/\\/g, '/');
  const nb = b.replace(/\\/g, '/');

  if (na === nb) return true;

  const prefixA = na.replace(/\/\*\*.*$/, '').replace(/\/\*$/, '');
  const prefixB = nb.replace(/\/\*\*.*$/, '').replace(/\/\*$/, '');

  if (prefixA === '' || prefixB === '') return true; // one covers everything
  return prefixA.startsWith(prefixB + '/') || prefixB.startsWith(prefixA + '/') || prefixA === prefixB;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Suggest a bundle type based on the directory name/structure.
 */
function suggestBundle(entry: string): string | null {
  const name = entry.split('/').pop() ?? entry;
  if (/service|svc|api|server/.test(name)) return 'service-default';
  if (/package|pkg|lib|module/.test(name)) return 'package-family-default';
  return null;
}

/**
 * Convert a directory path to a scope-style name (e.g. "services/core" → "core").
 */
function toScope(entry: string): string {
  return entry.split('/').pop()?.replace(/[^a-z0-9-]/gi, '-').toLowerCase() ?? entry;
}
