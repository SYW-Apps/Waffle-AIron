import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, loadProjectConfig, loadRegistry } from '../config/loader.js';
import { validateRegistry, validateProjectConfig } from '../core/validation.js';

// ---------------------------------------------------------------------------
// validate command
//
// Checks the project config and registry for issues.
// Exits with code 1 if there are errors (or warnings in --ci mode).
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  ci?: boolean; // treat warnings as errors (for CI pipelines)
}

export async function runValidate(options: ValidateOptions = {}): Promise<void> {
  assertProjectInitialized();

  const projectConfig = loadProjectConfig();
  const registry = loadRegistry();

  let hasErrors = false;
  let hasWarnings = false;

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
        hasWarnings = true;
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
        hasWarnings = true;
      }
    }
  }

  // --- SDD Spec Tree ---
  const { AI_PATHS: sddPaths } = require('../config/loader.js') as typeof import('../config/loader.js');
  const { pathExists: sddPathExists } = require('../utils/fs.js') as typeof import('../utils/fs.js');
  if (sddPathExists(sddPaths.specsSystem())) {
    logger.header('SDD Architectural Specs');
    const { validateSddTree } = require('../core/validation.js') as typeof import('../core/validation.js');
    const sddResult = validateSddTree(projectConfig.rules, projectConfig.projectType);
    if (sddResult.issues.length === 0) {
      logger.success('Spec tree is valid and component type boundaries are enforced.');
    } else {
      for (const issue of sddResult.issues) {
        const prefix = issue.specId ? chalk.gray(`[${issue.specId}] `) : '';
        if (issue.severity === 'error') {
          logger.error(`${prefix}[${issue.code}] ${issue.message}`);
          hasErrors = true;
        } else {
          logger.warn(`${prefix}[${issue.code}] ${issue.message}`);
          hasWarnings = true;
        }
      }
    }
  }

  logger.blank();

  const failOnWarnings = options.ci && hasWarnings;

  if (hasErrors || failOnWarnings) {
    if (options.ci && failOnWarnings && !hasErrors) {
      logger.error('Validation failed: warnings are treated as errors in --ci mode.');
    } else {
      logger.error('Validation failed. Fix the errors above.');
      logger.info(chalk.cyan('Tip: If you need to temporarily bypass an architectural rule, you can override its severity level in your `.wai/project.yaml` config (e.g. `rules.sddRuleSeverity.CIRCULAR_DEPENDENCY: warning`).'));
    }
    process.exit(1);
  } else {
    if (options.ci) {
      logger.success('All checks passed (CI mode — warnings treated as errors).');
    } else {
      logger.success('All checks passed.');
    }
  }
}
