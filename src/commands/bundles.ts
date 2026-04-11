import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { listBundleIds, loadBundle } from '../core/bundles.js';

// ---------------------------------------------------------------------------
// bundles list command
//
// Lists all available bundles (built-in + project-local), showing the
// bundle name, description, and the agents it will scaffold.
// ---------------------------------------------------------------------------

export async function runBundlesList(): Promise<void> {
  const ids = listBundleIds();

  if (ids.length === 0) {
    logger.info('No bundles found.');
    return;
  }

  logger.header(`Bundles (${ids.length})`);
  console.log();

  for (const id of ids) {
    try {
      const bundle = loadBundle(id);
      console.log(`${chalk.bold(id)}`);
      console.log(`  ${chalk.white(bundle.name)}`);
      console.log(`  ${bundle.description}`);
      console.log(`  ${chalk.gray('Agents:')} ${bundle.agents.map((a) => chalk.cyan(`<scope>-${a.idSuffix}`)).join(chalk.gray(', '))}`);
      console.log();
    } catch {
      console.log(`${chalk.bold(id)}  ${chalk.red('(failed to load)')}`);
      console.log();
    }
  }
}
