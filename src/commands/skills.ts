import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized } from '../config/loader.js';
import { exportSddSkills, listSkillNames } from '../core/skills.js';

// ---------------------------------------------------------------------------
// skills command
//
// SDD skills teach the host AI tool the spec-driven workflow. They are copied
// into each active target's skills directory and run in-session.
// ---------------------------------------------------------------------------

export async function runSkillsList(): Promise<void> {
  assertProjectInitialized();
  const names = listSkillNames();
  logger.header(`SDD Skills (${names.length})`);
  logger.blank();
  for (const n of names) {
    console.log(`  ${chalk.bold(n)}`);
  }
}

export async function runSkillsInstall(): Promise<void> {
  assertProjectInitialized();
  const result = exportSddSkills();

  if (result.destinations.length === 0) {
    logger.warn('No active target has a skills directory — nothing installed.');
    if (result.skipped.length > 0) {
      logger.info(`Targets without skills support: ${result.skipped.join(', ')}`);
    }
    return;
  }

  logger.success(`Installed ${listSkillNames().length} SDD skill(s) into ${result.destinations.length} target(s):`);
  for (const d of result.destinations) {
    console.log(`  ${chalk.gray(d)}`);
  }
  if (result.skipped.length > 0) {
    logger.info(`Skipped (no skills dir): ${result.skipped.join(', ')}`);
  }
}
