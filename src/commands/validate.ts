import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, loadProjectConfig, loadRegistry } from '../config/loader.js';
import { validateRegistry, validateProjectConfig } from '../core/validation.js';

// ---------------------------------------------------------------------------
// validate command
//
// Checks the project config and registry for issues.
// Exits with code 1 if there are errors, 0 if clean (warnings allowed).
// ---------------------------------------------------------------------------

export async function runValidate(): Promise<void> {
  assertProjectInitialized();

  const projectConfig = loadProjectConfig();
  const registry = loadRegistry();

  let hasErrors = false;

  // --- Project config ---
  logger.header('Project Config');
  const configResult = validateProjectConfig(projectConfig);
  if (configResult.issues.length === 0) {
    logger.success('Project config is valid.');
  } else {
    for (const issue of configResult.issues) {
      if (issue.severity === 'error') {
        logger.error(`[${issue.code}] ${issue.message}`);
        hasErrors = true;
      } else {
        logger.warn(`[${issue.code}] ${issue.message}`);
      }
    }
  }

  // --- Registry ---
  logger.header('Registry');
  logger.info(`Agents: ${registry.agents.length}`);

  const regResult = validateRegistry(registry, projectConfig.rules);
  if (regResult.issues.length === 0) {
    logger.success('Registry is valid.');
  } else {
    for (const issue of regResult.issues) {
      const prefix = issue.agentId ? chalk.gray(`[${issue.agentId}] `) : '';
      if (issue.severity === 'error') {
        logger.error(`${prefix}[${issue.code}] ${issue.message}`);
        hasErrors = true;
      } else {
        logger.warn(`${prefix}[${issue.code}] ${issue.message}`);
      }
    }
  }

  logger.blank();

  if (hasErrors) {
    logger.error('Validation failed. Fix the errors above.');
    process.exit(1);
  } else {
    logger.success('All checks passed.');
  }
}
