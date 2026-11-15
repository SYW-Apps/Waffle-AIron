import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized } from '../config/paths.js';
// cli_skills_adapter — the skills portal, reached through the adapter's own module.
import { exportSddSkills, listSkillNames } from './adapters/skills.js';

// ---------------------------------------------------------------------------
// skills command
//
// SDD skills teach the host AI tool the spec-driven workflow. They are copied
// into each active target's skills directory and run in-session.
// ---------------------------------------------------------------------------

export function runSkillsList(): void {
  assertProjectInitialized();
  const names = listSkillNames();
  logger.header(`SDD Skills (${names.length})`);
  logger.blank();
  for (const n of names) {
    console.log(`  ${chalk.bold(n)}`);
  }
}

/** Say what an export left to the wairon plugin: the targets served by it, and the built-in copies it removed. */
export function reportPluginSkills(result: { pluginServed: string[]; removed: string[] }): void {
  if (result.pluginServed.length > 0) {
    logger.info(`The wairon plugin provides the built-in skills for ${result.pluginServed.join(', ')}: only pack skills are written there. A pack section extending a built-in skill reaches that tool through the wairon-skill:// resource alone.`);
  }
  for (const p of result.removed) {
    logger.info(`Removed the built-in skill copy ${p} (the wairon plugin provides it).`);
  }
}

export function runSkillsInstall(): void {
  assertProjectInitialized();
  const result = exportSddSkills();
  reportPluginSkills(result);

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
