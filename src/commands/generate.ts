import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, loadProjectConfig, loadRegistry } from '../config/loader.js';
import { generateAll } from '../exporters/generate.js';
import { WAIRON_MANAGED_MARKER } from '../exporters/base.js';
import { hasContext, syncContextFiles } from '../core/context.js';
import { getProjectRoot, runWithProjectRoot } from '../utils/fs.js';
import { listDirectChainedSubprojects, ensureProjectInitialized } from '../core/provision.js';
import { invalidateSpecCache } from '../core/specs.js';

/** Filenames that only wairon's topology produces (architect / owners /
 *  implementers). Used as the migration fallback when reconciling a dir whose
 *  pre-existing files predate the managed marker. */
const WAIRON_AGENT_FILE = /-(owner|implementer|architect)\.md$/;

/**
 * Reconcile the managed output dirs after a FULL generation: delete agent files
 * that wairon owns but that are no longer in the freshly-written set. A file is
 * "wairon-owned" if it carries the managed marker OR matches the generated
 * agent-file naming (the latter migrates dirs written before the marker
 * existed). Hand-authored files that satisfy neither are never touched.
 * Returns the number of files pruned.
 */
export function pruneStaleAgents(writtenPaths: Set<string>): number {
  const dirs = new Set([...writtenPaths].map((p) => path.dirname(p)));
  let pruned = 0;
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      const full = path.resolve(dir, name);
      if (writtenPaths.has(full)) continue; // part of the current topology
      let owned = WAIRON_AGENT_FILE.test(name);
      if (!owned) {
        try {
          owned = fs.readFileSync(full, 'utf8').includes(WAIRON_MANAGED_MARKER);
        } catch {
          owned = false;
        }
      }
      if (!owned) continue; // hand-authored — leave it alone
      fs.unlinkSync(full);
      pruned++;
      logger.verbose(`Pruned stale: ${full}`);
    }
  }
  return pruned;
}

// ---------------------------------------------------------------------------
// generate command
//
// Regenerates all agent output files from the registry. Safe to run repeatedly —
// output is deterministic. Topology is LAYERED: this generates only the current
// project's own agents (chained subprojects collapse to one delegating owner
// each), then — unless --no-recurse — cascades into each chained subproject and
// generates its layer in its OWN .wai/.claude, so the whole stack is populated by
// one command while each layer stays proportional to itself.
// ---------------------------------------------------------------------------

interface GenerateOptions {
  /** Limit to a specific target type: claude, gemini, custom */
  target?: string;
  /** Limit to a single domain id (or 'root' for root-level agents) */
  domain?: string;
  /** Comma-separated list of domain ids */
  domains?: string;
  /** Only generate root-level agents (no domainRoot) */
  root?: boolean;
  dryRun?: boolean;
  /** Cascade into chained subprojects, generating each layer in its own .wai
   *  (default true). Set false for --no-recurse (current layer only). */
  recurse?: boolean;
  /** Reconcile managed output dirs — prune wairon-owned agent files no longer in
   *  the topology (default true). Set false for --no-prune (write-only). */
  prune?: boolean;
}

export async function runGenerate(options: GenerateOptions = {}): Promise<void> {
  await generateLayer(options);

  // Cascade one layer at a time into each DIRECT chained subproject, generating
  // its agents in its own .wai/.claude. Skipped for --no-recurse, dry runs, and
  // scoped (--domain/--root) runs. Each subproject is ensured-initialized first
  // (non-destructive) so a not-yet-runnable child becomes generable in place.
  const scoped = options.root || options.domain || options.domains;
  if (options.recurse === false || options.dryRun || scoped) return;

  const children = listDirectChainedSubprojects(getProjectRoot());
  for (const child of children) {
    logger.blank();
    logger.info(`↳ Chained subproject "${child.subsystemId}" — generating its layer in ${path.relative(getProjectRoot(), child.dir) || '.'}/`);
    await runWithProjectRoot(child.dir, async () => {
      ensureProjectInitialized(child.subsystemId); // non-destructive
      invalidateSpecCache();
      await runGenerate(options); // recurse: this child's layer + its own subprojects
    });
  }
}

/** Generate the CURRENT project's own agent layer (no cascade). */
async function generateLayer(options: GenerateOptions = {}): Promise<void> {
  assertProjectInitialized();

  const projectConfig = loadProjectConfig();
  const registry = loadRegistry();

  if (registry.agents.length === 0) {
    logger.warn('No agents resolved from the spec tree. Define subsystems and components first — see `wairon status`.');
    return;
  }

  const filterTargets = options.target ? [options.target] : undefined;

  let filterDomainIds: string[] | undefined;
  if (options.root) {
    filterDomainIds = ['root'];
  } else if (options.domains) {
    filterDomainIds = options.domains.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (options.domain) {
    const matches = registry.agents
      .map(a => a.domainRoot)
      .filter((d): d is string => !!d && (d === options.domain || d.startsWith(`${options.domain}::`)));
    filterDomainIds = Array.from(new Set([options.domain, ...matches]));
  }

  const agentPool = filterDomainIds
    ? registry.agents.filter((a) => filterDomainIds!.includes(a.domainRoot ?? 'root'))
    : registry.agents;

  if (options.dryRun) {
    logger.info('Dry run — no files will be written.');
  }

  logger.info(`Generating ${agentPool.length} agent(s)...`);
  logger.blank();

  const summaries = generateAll(registry.agents, projectConfig, {
    filterTargets,
    filterDomainIds,
    dryRun: options.dryRun,
  });

  let written = 0;
  let skipped = 0;

  for (const summary of summaries) {
    if (options.dryRun) {
      logger.info(`[dry-run] Would generate: ${summary.agent.id}`);
    } else {
      for (const result of summary.results) {
        if (result.unchanged) {
          logger.verbose(`Unchanged: ${result.outputPath}`);
          skipped++;
        } else {
          logger.success(`Written:   ${result.outputPath}`);
          written++;
        }
      }
    }
  }

  // Reconcile: prune wairon-owned agent files no longer in the topology (removed
  // components, or the old flat pile after the switch to layered). Only on a FULL
  // generation — a domain/root-scoped run wrote just part of the set, so pruning
  // would wrongly delete the layers it didn't touch. Target-scoped runs are fine:
  // they still wrote the whole agent set for that target, and we only reconcile
  // dirs we wrote to.
  let prunedCount = 0;
  if (!options.dryRun && options.prune !== false && !filterDomainIds) {
    const writtenPaths = new Set(
      summaries.flatMap((s) => s.results.map((r) => path.resolve(r.outputPath))),
    );
    prunedCount = pruneStaleAgents(writtenPaths);
  }

  logger.blank();
  if (options.dryRun) {
    logger.success(`Dry run complete. ${summaries.length} agent(s) would be processed.`);
  } else {
    const parts = [];
    if (written > 0) parts.push(`${written} written`);
    if (skipped > 0) parts.push(`${skipped} unchanged`);
    if (prunedCount > 0) parts.push(`${prunedCount} pruned`);
    logger.success(`Done. ${summaries.length} agent(s) processed — ${parts.join(', ') || 'none'}.`);

    // Keep context files current if context has been initialised
    if (!options.dryRun && hasContext()) {
      syncContextFiles();
      logger.verbose('Context files synced.');
    }

    // Also re-export SDD skills if spec tree exists
    const { AI_PATHS: sddPaths } = require('../config/loader.js') as typeof import('../config/loader.js');
    const { pathExists: sddPathExists } = require('../utils/fs.js') as typeof import('../utils/fs.js');
    if (!options.dryRun && sddPathExists(sddPaths.specsSystem())) {
      try {
        const { exportSddSkills } = require('../core/skills.js') as typeof import('../core/skills.js');
        exportSddSkills();
        logger.verbose('SDD AI Skills synced.');
      } catch (err) {
        logger.warn(`Failed to export SDD Skills: ${String(err)}`);
      }
    }

    // Re-inject the project-local guides so .claude/CLAUDE.md / .gemini/GEMINI.md
    // stay current with the installed wairon (otherwise only `init` writes them).
    if (!options.dryRun) {
      try {
        const { reinjectLocalGuides } = require('../utils/ai-guide.js') as typeof import('../utils/ai-guide.js');
        const { activeTargetTypes } = require('../core/skills.js') as typeof import('../core/skills.js');
        // getProjectRoot() (not process.cwd()) so a cascaded subproject layer
        // re-injects ITS guides into ITS own dir, not the original invocation dir.
        reinjectLocalGuides(getProjectRoot(), activeTargetTypes());
        logger.verbose('Local AI guides re-injected.');
      } catch (err) {
        logger.warn(`Failed to re-inject AI guides: ${String(err)}`);
      }
    }
  }
}
