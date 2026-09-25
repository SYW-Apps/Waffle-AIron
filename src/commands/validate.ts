import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized } from '../config/paths.js';
import { ProjectNotInitializedError } from '../utils/errors.js';
// The core reads this adapter makes land on the core portals: the configuration,
// the agent registry, and the legacy spec filenames a migration would rename.
import { loadProjectConfig, loadRegistry, findLegacySpecFiles } from '../core/index.js';
import type { CarriedDebt } from '../models/project.js';
import { validateRegistry, validateProjectConfig, validateAsComplete, validateSddTree, computeGateStateId, type ValidationIssue } from '../core/validation.js';

// ---------------------------------------------------------------------------
// validate command (cli_validator_adapter)
//
// Checks the project config and registry for issues.
// Exits with code 1 if there are errors (or warnings in --ci mode).
// ---------------------------------------------------------------------------

// cli_validator_adapter.validateAsComplete — the as-complete conformance gate:
// validate the tree as if every spec were already complete (the status flip
// happens in-memory inside the validator and is restored — nothing on disk
// changes). Republished here as the adapter's forward to the validator portal;
// `wairon lock` gates its dry-run on this and refuses to freeze on errors.
//
// cli_validator_adapter.computeGateStateId — the gate identity a lock records
// and every staleness check compares, republished as the adapter's forward to
// the validator portal.
//
// cli_validator_adapter.validateSddTree — the full spec-tree conformance
// gate, republished as the adapter's forward to the validator portal;
// `wairon doctor` reports its error/warning counts.
export { validateAsComplete, computeGateStateId, validateSddTree };

export interface ValidateOptions {
  ci?: boolean; // treat warnings as errors (for CI pipelines)
  subsystem?: string; // validate only a specific subsystem
  recursive?: boolean | number; // whether to recursively validate subprojects
}

// ---------------------------------------------------------------------------
// --ci draft tolerance
//
// SDD has an explicit draft → design → complete lifecycle, so the CI gate must
// enforce completeness of finished work, not punish the existence of declared
// drafts. A warning is waived from the --ci failure decision only when it
// merely reflects a draft/design spec:
//   • DRAFT_SUBSYSTEM_WARNING / DRAFT_COMPONENT_WARNING — always, they exist
//     solely to surface a draft (the whole DRAFT_*_WARNING family is pure
//     status notice, emitted only for draft/design specs).
//   • UNUSED_COMPONENT — only when the referenced component is itself draft/
//     design (carried on the issue as draftContext by the rule that raised it);
//     an unused *complete* component is a real gap and stays fatal.
// Every other warning remains fatal in --ci mode. The warnings are still
// printed — this classifies the failure decision, it does not silence rules.
// ---------------------------------------------------------------------------

/**
 * The conformance debt register, said out loud on every run. A suppression is
 * silent by nature — that is what makes it rot — so the count of what this
 * tree carries, and which of it is debt rather than a limit, is composed here
 * whether or not anything else was reported.
 *
 * The re-evaluation count rides on the same line. `STALE_CARRIED_FINDING`
 * catches an entry that stopped applying; nothing catches one that still
 * applies for a reason that has become FALSE, and a confident-sounding `why`
 * that is wrong is worse than a missing one because it reads as settled and
 * nobody looks again. A group that admits it is unsure says so here, and each
 * one's sentence follows, because a reader deciding whether to pick it up
 * needs to know what to measure.
 */
export function carriedDebtSummary(
  carried: CarriedDebt[] | undefined,
): { line: string; revisits: string[] } | null {
  if (!carried || carried.length === 0) return null;
  const findings = carried.flatMap(g => g.findings ?? []);
  const units = findings.reduce((n, f) => n + (f.covers?.length ?? 1), 0);
  const perKind = (kind: string): number =>
    carried.filter(g => g.kind === kind).reduce((n, g) => n + (g.findings?.length ?? 0), 0);
  const provisional = carried.filter(g => g.revisit);
  const unsettled = provisional.reduce((n, g) => n + (g.findings?.length ?? 0), 0);
  return {
    line:
      `Conformance debt register: ${findings.length} finding(s) over ${units} unit(s) carried — `
      + `${perKind('drift')} drift, ${perKind('undecided')} undecided, ${perKind('unreadable')} unreadable `
      + '(`rules.conformance.carried`). Drift and undecided are owed; unreadable is what the analysis cannot follow.'
      + (unsettled > 0
        ? ` ${unsettled} finding(s) in ${provisional.length} group(s) are marked for re-evaluation — the classification is provisional, not the debt.`
        : ''),
    revisits: provisional.map(
      g => `  re-evaluate (${g.kind}, ${g.findings?.length ?? 0} finding(s)): ${g.revisit}`,
    ),
  };
}

export function isCiDraftWaivable(issue: ValidationIssue): boolean {
  if (issue.severity !== 'warning') return false;
  if (issue.code === 'DRAFT_SUBSYSTEM_WARNING') return true;
  if (issue.code === 'DRAFT_COMPONENT_WARNING') return true;
  if (issue.code === 'UNUSED_COMPONENT') return issue.draftContext === true;
  return false;
}

export async function runValidate(options: ValidateOptions = {}): Promise<void> {
  assertProjectInitialized();

  const projectConfig = loadProjectConfig();
  if (!projectConfig) throw new ProjectNotInitializedError();
  let registry = loadRegistry();
  if (options.subsystem) {
    registry = {
      ...registry,
      agents: registry.agents.filter(a => a.domainRoot === options.subsystem || a.domainRoot?.startsWith(`${options.subsystem}::`)),
    };
  }

  let hasErrors = false;
  // Warnings that count toward the --ci failure decision (everything except
  // draft-waivable ones). `waivedWarnings` are printed but excluded from it.
  let hasFatalWarnings = false;
  let waivedWarnings = 0;

  // --- Legacy spec filenames check ---
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
        hasFatalWarnings = true;
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
        hasFatalWarnings = true;
      }
    }
  }

  // --- SDD Spec Tree ---
  const { AI_PATHS: sddPaths } = require('../config/paths.js') as typeof import('../config/paths.js');
  const { pathExists: sddPathExists } = require('../utils/fs.js') as typeof import('../utils/fs.js');
  if (sddPathExists(sddPaths.specsSystem())) {
    logger.header('SDD Architectural Specs');
    const sddResult = validateSddTree({
      rules: projectConfig.rules,
      projectType: projectConfig.projectType,
      scopeSubsystem: options.subsystem,
      recursive: options.recursive ?? true,
    });
    if (sddResult.resolvedThrough) {
      logger.info(
        `Chained subproject — verified through the parent project at ${sddResult.resolvedThrough.root} ` +
          `(mount "${sddResult.resolvedThrough.scope}").`,
      );
    }
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
          if (isCiDraftWaivable(issue)) {
            waivedWarnings++;
          } else {
            hasFatalWarnings = true;
          }
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

  // The conformance debt register, said out loud on every run. A suppression
  // is silent by nature — that is what makes it rot — so the count of what
  // this tree carries, and which of it is debt rather than a limit, is
  // printed whether or not anything else was reported.
  const summary = carriedDebtSummary(projectConfig.rules?.conformance?.carried);
  if (summary) {
    logger.blank();
    logger.info(chalk.yellow(summary.line));
    for (const note of summary.revisits) logger.info(chalk.gray(note));
  }

  logger.blank();

  // Draft-related warnings are surfaced above but excluded from the --ci
  // failure decision (they reflect declared drafts, not incomplete finished
  // work). Make that explicit in the summary.
  if (options.ci && waivedWarnings > 0) {
    logger.info(chalk.gray(`${waivedWarnings} draft-related warning(s) (non-fatal in --ci): excluded from the failure decision because the referenced specs are in draft/design status.`));
  }

  const failOnWarnings = !!options.ci && hasFatalWarnings;

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
      logger.success('All checks passed (CI mode — warnings treated as errors, draft-related warnings excepted).');
    } else {
      logger.success('All checks passed.');
    }
  }
}
