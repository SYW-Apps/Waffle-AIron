import chalk from 'chalk';
import { logger } from '../../utils/logger.js';
// The registry is read through sdd_core's extension portal.
import { loadProjectVariants } from '../../core/index.js';

// ---------------------------------------------------------------------------
// cli_variants_adapter — `wairon variants list`: the component variant
// registry governing this project: wairon's built-in variants, then global
// (WAIRON_VARIANTS_DIR), then project (.wai/variants/), a later layer overriding
// by id. A dynamic layer ON TOP of
// packs — define a variant on demand without touching a pack, share it
// anywhere. Each variant is a base-anchored kind + implementation guidance a
// component opts into via `variant: <id>`.
// ---------------------------------------------------------------------------

export async function listVariants(): Promise<void> {
  const variants = loadProjectVariants();

  console.log(chalk.bold(`\nComponent variants (${variants.length})\n`));
  if (variants.length === 0) {
    console.log(chalk.dim('  (none — define one under .wai/variants/*.yaml or the global variants directory)'));
  }
  for (const v of variants) {
    const scope = [v.target ? `target:${v.target}` : '', v.profile ? `profile:${v.profile}` : ''].filter(Boolean).join(' ');
    console.log(
      chalk.bold.cyan(`■ ${v.id}`) + chalk.dim(`  (a kind of ${v.base})`) + (scope ? chalk.magenta(`  [${scope}]`) : ''),
    );
    console.log(`  ${chalk.dim(v.guidance)}`);
  }
  console.log('');
  logger.info('Reference a variant from a component spec via `variant: <id>`; the base stereotype stays authoritative for generic semantics.');
}
