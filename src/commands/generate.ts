import { logger } from '../utils/logger.js';
import { assertProjectInitialized, loadProjectConfig, loadRegistry } from '../config/loader.js';
import { generateAll } from '../exporters/generate.js';
import { hasContext, syncContextFiles } from '../core/context.js';

// ---------------------------------------------------------------------------
// generate command
//
// Regenerates all agent output files from the registry.
// This is safe to run repeatedly — output is deterministic.
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
}

export async function runGenerate(options: GenerateOptions = {}): Promise<void> {
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

  logger.blank();
  if (options.dryRun) {
    logger.success(`Dry run complete. ${summaries.length} agent(s) would be processed.`);
  } else {
    const parts = [];
    if (written > 0) parts.push(`${written} written`);
    if (skipped > 0) parts.push(`${skipped} unchanged`);
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
        reinjectLocalGuides(process.cwd(), activeTargetTypes());
        logger.verbose('Local AI guides re-injected.');
      } catch (err) {
        logger.warn(`Failed to re-inject AI guides: ${String(err)}`);
      }
    }
  }
}
