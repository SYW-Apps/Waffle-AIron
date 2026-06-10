import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { listTemplateIds, loadTemplate } from '../core/templates.js';
import { loadProjectConfig, isProjectInitialized } from '../config/loader.js';

// ---------------------------------------------------------------------------
// templates list command
//
// Lists all available templates across built-in, global, and project-local
// tiers, showing name, description, and which tier they come from.
// ---------------------------------------------------------------------------

export async function runTemplatesList(): Promise<void> {
  const globalOverride = isProjectInitialized()
    ? loadProjectConfig().globalTemplatesDir
    : undefined;

  const ids = listTemplateIds(globalOverride);

  if (ids.length === 0) {
    logger.info('No templates found.');
    return;
  }

  logger.header(`Templates (${ids.length})`);
  console.log();

  for (const id of ids) {
    try {
      const tpl = loadTemplate(id, globalOverride);
      const tags =
        tpl.defaultTags.length > 0
          ? chalk.gray(` [${tpl.defaultTags.join(', ')}]`)
          : '';
      console.log(`${chalk.bold(id)}${tags}`);
      console.log(`  ${chalk.white(tpl.name)}`);
      console.log(`  ${tpl.description}`);
      if (!tpl.requiresOwnedPaths) {
        console.log(`  ${chalk.yellow('Does not require owned paths')}`);
      }
      console.log();
    } catch {
      console.log(`${chalk.bold(id)}  ${chalk.red('(failed to load)')}`);
      console.log();
    }
  }
}
