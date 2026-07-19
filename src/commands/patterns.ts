import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { loadProjectExtensions } from '../core/extensions.js';

// ---------------------------------------------------------------------------
// patterns command — the reusable, versioned architecture patterns declared by
// loaded extension packs. `patterns list` gives adoption/discovery/versioning
// visibility; a spec references a pattern via `patterns: [{ id, version }]` on a
// component, and the declaring pack's own rules enforce its actual constraints.
// ---------------------------------------------------------------------------

export async function listPatterns(): Promise<void> {
  const ext = loadProjectExtensions();

  console.log(chalk.bold(`\nReusable patterns (${ext.patterns.length})\n`));
  if (ext.patterns.length === 0) {
    console.log(chalk.dim('  (none — declare patterns in an extension pack under `patterns:`)'));
  }
  for (const p of ext.patterns) {
    console.log(
      chalk.bold.cyan(`■ ${p.id}`) + chalk.dim(`  v${p.version}`) + chalk.magenta(`  [pack: ${p.pack}]`),
    );
    if (p.description) console.log(`  ${chalk.dim(p.description)}`);
  }
  console.log('');
  for (const err of ext.errors) logger.error(err);
  logger.info(
    "Reference a pattern from a component spec via `patterns: [{ id, version }]`; the declaring pack's rules enforce it.",
  );
}
