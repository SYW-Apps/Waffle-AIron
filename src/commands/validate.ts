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
  subsystem?: string; // validate only a specific subsystem
  recursive?: boolean | number; // whether to recursively validate subprojects
}

export async function runValidate(options: ValidateOptions = {}): Promise<void> {
  assertProjectInitialized();

  const projectConfig = loadProjectConfig();
  let registry = loadRegistry();
  if (options.subsystem) {
    registry = {
      ...registry,
      agents: registry.agents.filter(a => a.domainRoot === options.subsystem || a.domainRoot?.startsWith(`${options.subsystem}::`)),
    };
  }

  let hasErrors = false;
  let hasWarnings = false;

  // --- Legacy spec filenames check ---
  const { findLegacySpecFiles } = require('../core/specs.js') as typeof import('../core/specs.js');
  const legacySpecs = findLegacySpecFiles();
  if (legacySpecs.length > 0) {
    logger.warn(`Warning: ${legacySpecs.length} legacy spec filename(s) detected (e.g., component.yaml). These are deprecated. Please run \`wairon doctor --fix\` to migrate them to the new unified .index.yaml schema.`);
    logger.blank();
  }

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
    const sddResult = validateSddTree({
      rules: projectConfig.rules,
      projectType: projectConfig.projectType,
      scopeSubsystem: options.subsystem,
      recursive: options.recursive ?? true,
    });
    if (sddResult.issues.length === 0) {
      logger.success('Spec tree is valid and component type boundaries are enforced.');
    } else {
      let errorCount = 0;
      let warningCount = 0;
      const MAX_PRINT = 100;
      let skippedErrors = 0;
      let skippedWarnings = 0;

      for (const issue of sddResult.issues) {
        const prefix = issue.specId ? chalk.gray(`[${issue.specId}] `) : '';
        if (issue.severity === 'error') {
          hasErrors = true;
          if (errorCount < MAX_PRINT) {
            logger.error(`${prefix}[${issue.code}] ${issue.message}`);
            errorCount++;
          } else {
            skippedErrors++;
          }
        } else {
          hasWarnings = true;
          if (warningCount < MAX_PRINT) {
            logger.warn(`${prefix}[${issue.code}] ${issue.message}`);
            warningCount++;
          } else {
            skippedWarnings++;
          }
        }
      }

      if (skippedErrors > 0) {
        logger.error(`... and ${skippedErrors} more error(s) omitted. Use '--subsystem <id>' to validate a specific subsystem.`);
      }
      if (skippedWarnings > 0) {
        logger.warn(`... and ${skippedWarnings} more warning(s) omitted. Use '--subsystem <id>' to validate a specific subsystem.`);
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
