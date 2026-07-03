import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { SDD_RULES } from '../core/rules/index.js';
import { isProjectInitialized, loadProjectConfig } from '../config/loader.js';

// ---------------------------------------------------------------------------
// rules command
//
// The conformance gate as a documented linter: list every rule in the
// registry, the issue codes it can emit, default severities, and any
// project-level overrides from rules.sddRuleSeverity.
// ---------------------------------------------------------------------------

export async function runRulesList(): Promise<void> {
  let overrides: Record<string, 'error' | 'warning' | 'off'> = {};
  if (isProjectInitialized()) {
    try {
      overrides = loadProjectConfig().rules.sddRuleSeverity ?? {};
    } catch {
      // unreadable config — show defaults only
    }
  }

  const sevLabel = (sev: 'error' | 'warning' | 'off'): string => {
    if (sev === 'error') return chalk.red('error  ');
    if (sev === 'warning') return chalk.yellow('warning');
    return chalk.gray('off    ');
  };

  console.log(chalk.bold(`\nSDD conformance rules (${SDD_RULES.length} rule groups)\n`));
  for (const rule of SDD_RULES) {
    console.log(chalk.bold.cyan(`■ ${rule.name}`));
    console.log(`  ${chalk.dim(rule.description)}`);
    for (const c of rule.codes) {
      const effective = overrides[c.code] ?? c.defaultSeverity;
      const overridden = overrides[c.code] && overrides[c.code] !== c.defaultSeverity;
      console.log(
        `    ${sevLabel(effective)} ${c.code}${overridden ? chalk.magenta(` (override; default ${c.defaultSeverity})`) : ''}`,
      );
      console.log(`            ${chalk.dim(c.summary)}`);
    }
    console.log('');
  }
  logger.info('Override severities per project via rules.sddRuleSeverity in .wai/project.yaml (error | warning | off).');
}
