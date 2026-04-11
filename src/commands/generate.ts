import { logger } from '../utils/logger.js';
import { assertProjectInitialized, loadProjectConfig, loadRegistry } from '../config/loader.js';
import { generateAll } from '../exporters/generate.js';

// ---------------------------------------------------------------------------
// generate command
//
// Regenerates all agent output files from the registry.
// This is safe to run repeatedly — output is deterministic.
// ---------------------------------------------------------------------------

interface GenerateOptions {
  target?: string; // limit to a specific target type
  dryRun?: boolean;
}

export async function runGenerate(options: GenerateOptions = {}): Promise<void> {
  assertProjectInitialized();

  const projectConfig = loadProjectConfig();
  const registry = loadRegistry();

  if (registry.agents.length === 0) {
    logger.warn('No agents in registry. Add agents with `wairon create-agent`.');
    return;
  }

  const filterTargets = options.target ? [options.target] : undefined;

  if (options.dryRun) {
    logger.info('Dry run — no files will be written.');
  }

  logger.info(`Generating ${registry.agents.length} agent(s)...`);
  logger.blank();

  const summaries = generateAll(registry.agents, projectConfig, {
    filterTargets,
    dryRun: options.dryRun,
  });

  for (const summary of summaries) {
    if (options.dryRun) {
      logger.info(`[dry-run] Would generate: ${summary.agent.id}`);
    } else {
      for (const result of summary.results) {
        logger.success(`Generated: ${result.outputPath}`);
      }
    }
  }

  logger.blank();
  logger.success(`Done. ${summaries.length} agent(s) processed.`);
}
