import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, loadRegistry, loadProjectConfig } from '../config/loader.js';
import { listBundleIds, loadBundle } from '../core/bundles.js';
import { AgentRecord } from '../models/agent.js';

// ---------------------------------------------------------------------------
// suggest-topology command
//
// Analyses the current registry and repository structure, then emits a
// human-readable list of suggestions. Nothing is applied automatically.
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target',
  '.wai', '.wairon', '.claude', '.gemini', '.cursor', '.vscode',
  'coverage', '.nyc_output', '.cache',
]);

export async function runSuggestTopology(): Promise<void> {
  assertProjectInitialized();

  const registry = loadRegistry();
  const projectConfig = loadProjectConfig();
  const projectRoot = process.cwd();
  const activeAgents = registry.agents.filter((a) => a.status === 'active');

  logger.header('Topology Suggestions');
  logger.blank();

  const suggestions: Suggestion[] = [];

  // --- 1. Coverage gaps ---
  const topLevel = walkTopLevel(projectRoot);
  const uncovered = topLevel.filter(
    (entry) => !activeAgents.some((a) => pathIsCovered(entry, a.ownedPaths)),
  );

  if (uncovered.length > 0) {
    const bundleIds = listBundleIds();

    for (const entry of uncovered) {
      const name = entry.split('/').pop() ?? entry;
      const matchedBundle = bundleIds.find((id) => bundleFitsPath(id, name));

      if (matchedBundle) {
        const bundle = loadBundle(matchedBundle);
        suggestions.push({
          type: 'gap-bundle',
          priority: 'high',
          title: `Create agent bundle for uncovered path: ${chalk.cyan(entry)}`,
          detail: `"${entry}" has no owning agent. The "${bundle.name}" bundle fits this pattern.`,
          command: `wairon create-bundle --bundle ${matchedBundle} --scope ${toScope(entry)} --dir ${entry}`,
        });
      } else {
        suggestions.push({
          type: 'gap-agent',
          priority: 'medium',
          title: `Create agent for uncovered path: ${chalk.cyan(entry)}`,
          detail: `"${entry}" has no owning agent. Add one to track ownership.`,
          command: `wairon create-agent`,
        });
      }
    }
  }

  // --- 2. Redundant / very broad ownership ---
  for (const agent of activeAgents) {
    const hasCatchAll = agent.ownedPaths.some(
      (p) => p === '**' || p === './**' || p === '/**',
    );
    if (hasCatchAll) {
      suggestions.push({
        type: 'broad-ownership',
        priority: 'medium',
        title: `Agent "${agent.id}" has catch-all ownership`,
        detail: `ownedPaths contains "**" which covers everything. ` +
                `Consider scoping this agent to a specific directory.`,
        command: `wairon show ${agent.id}`,
      });
    }
  }

  // --- 3. Agents with identical ownedPaths (merge candidates) ---
  for (let i = 0; i < activeAgents.length; i++) {
    for (let j = i + 1; j < activeAgents.length; j++) {
      const a = activeAgents[i];
      const b = activeAgents[j];
      if (
        a.ownedPaths.length > 0 &&
        JSON.stringify([...a.ownedPaths].sort()) === JSON.stringify([...b.ownedPaths].sort())
      ) {
        suggestions.push({
          type: 'merge-candidate',
          priority: 'low',
          title: `"${a.id}" and "${b.id}" own identical paths`,
          detail: `Both own: ${a.ownedPaths.join(', ')}. ` +
                  `If their responsibilities overlap, consider merging them.`,
          command: `wairon merge ${a.id} ${b.id}`,
        });
      }
    }
  }

  // --- 4. Agents owning a very large number of paths (split candidates) ---
  for (const agent of activeAgents) {
    if (agent.ownedPaths.length >= 6) {
      suggestions.push({
        type: 'split-candidate',
        priority: 'low',
        title: `Agent "${agent.id}" owns many paths (${agent.ownedPaths.length})`,
        detail: `Agents with many owned paths can be harder to reason about. ` +
                `Consider splitting into focused sub-agents.`,
        command: `wairon split ${agent.id}`,
      });
    }
  }

  // --- 5. Draft agents that have been sitting unactivated ---
  const drafts = registry.agents.filter((a) => a.status === 'draft');
  if (drafts.length > 0) {
    suggestions.push({
      type: 'draft-cleanup',
      priority: 'low',
      title: `${drafts.length} draft agent(s) have never been activated`,
      detail: `Draft agents don't participate in topology coverage. ` +
              `Review each and either activate them or remove them.`,
      command: drafts.map((a) => `wairon show ${a.id}`).join('\n         '),
    });
  }

  // --- 6. No targets enabled for some agents ---
  const enabledTargetTypes = projectConfig.targets
    .filter((t) => !('enabled' in t) || t.enabled)
    .map((t) => (typeof t === 'string' ? t : t.type));

  for (const agent of activeAgents) {
    const agentTargetTypes = agent.targets.map((t) =>
      typeof t === 'string' ? t : (t as { type: string }).type,
    );
    const hasEnabledTarget = agentTargetTypes.some((t) => enabledTargetTypes.includes(t));
    if (!hasEnabledTarget) {
      suggestions.push({
        type: 'no-target',
        priority: 'high',
        title: `Agent "${agent.id}" has no enabled output target`,
        detail: `Its targets (${agentTargetTypes.join(', ')}) are not enabled in project.yaml. ` +
                `It will not be generated.`,
        command: `wairon show ${agent.id}`,
      });
    }
  }

  // --- Output ---
  if (suggestions.length === 0) {
    logger.success('Topology looks well-structured — no suggestions.');
    return;
  }

  const high = suggestions.filter((s) => s.priority === 'high');
  const medium = suggestions.filter((s) => s.priority === 'medium');
  const low = suggestions.filter((s) => s.priority === 'low');

  let index = 1;
  for (const group of [high, medium, low]) {
    for (const s of group) {
      const priorityLabel =
        s.priority === 'high' ? chalk.red('high') :
        s.priority === 'medium' ? chalk.yellow('medium') : chalk.gray('low');

      console.log(`${chalk.bold(`#${index}`)}  [${priorityLabel}]  ${s.title}`);
      console.log(`     ${chalk.gray(s.detail)}`);
      console.log(`     ${chalk.cyan('→')} ${s.command}`);
      console.log();
      index++;
    }
  }

  logger.info(`${suggestions.length} suggestion(s). None have been applied — run the commands above to act on them.`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Suggestion {
  type: string;
  priority: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  command: string;
}

// ---------------------------------------------------------------------------
// Helpers (duplicated from analyze to keep commands self-contained)
// ---------------------------------------------------------------------------

function walkTopLevel(projectRoot: string): string[] {
  const entries: string[] = [];
  try {
    const items = fs.readdirSync(projectRoot, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      if (item.isDirectory() && SKIP_DIRS.has(item.name)) continue;
      entries.push(item.name);
    }
  } catch { /* ignore */ }
  return entries;
}

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
    return !p.slice(prefix.length + 1).includes('/');
  }
  return p === pat || p.startsWith(pat + '/');
}

function bundleFitsPath(bundleId: string, name: string): boolean {
  const servicePat = /service|svc|api|server|backend/i;
  const packagePat = /package|pkg|lib|module|shared/i;
  if (bundleId === 'service-default') return servicePat.test(name);
  if (bundleId === 'package-family-default') return packagePat.test(name);
  return false;
}

function toScope(entry: string): string {
  return (entry.split('/').pop() ?? entry)
    .replace(/[^a-z0-9-]/gi, '-')
    .toLowerCase();
}
