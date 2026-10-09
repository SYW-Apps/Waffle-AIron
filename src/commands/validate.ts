import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, AI_PATHS } from '../config/paths.js';
import { pathExists } from '../utils/fs.js';
import { ProjectNotInitializedError } from '../utils/errors.js';
// The core reads this adapter makes land on the core portals: the configuration,
// the agent registry, and the legacy spec filenames a migration would rename.
import { loadProjectConfig, loadRegistry, findLegacySpecFiles, findOrphanedSpecFiles, resolveChainingParent, loadSubsystemSpecs, readLockRecord } from '../core/index.js';
import { declaredMembers, isPart, type CarriedDebt, type ProjectConfig, type RulesConfig } from '../models/project.js';
import type { Registry } from '../models/registry.js';
import { selectsFamily } from '../models/validation-options.js';
import { isCiDraftWaivable as waivable, missingTreeSentence } from '../models/lock.js';
import {
  validateRegistry as registryRules, validateProjectConfig as configRules, validateAsComplete, validateProject as ownersGate, validateFamily as familyRun, computeGateStateId, familyApprovals, familyRelations,
  adviseExternals as adviseLive,
  type ValidationIssue, type ValidationResult, type ValidationOptions,
} from '../core/validation.js';

// ---------------------------------------------------------------------------
// validate command (cli_validator_adapter)
//
// Checks the project config and registry for issues.
// Exits with code 1 if there are errors (or warnings in --ci mode). Notices are
// printed and counted, and never fail the run — with or without --ci.
// ---------------------------------------------------------------------------

// cli_validator_adapter.validateAsComplete — the as-complete conformance gate:
// validate the tree as if every spec were already complete (the status flip
// happens in-memory inside the validator and is restored — nothing on disk
// changes). Republished here as the adapter's forward to the validator portal;
// `wairon lock` gates its dry-run on this and refuses to approve on errors.
//
// cli_validator_adapter.computeGateStateId — the gate identity a lock records
// and every staleness check compares, republished as the adapter's forward to
// the validator portal.
//
// cli_validator_adapter.validateProject — the full spec-tree conformance
// gate, republished as the adapter's forward to the validator portal;
// `wairon doctor` reports its error/warning/notice counts.
//
// cli_validator_adapter.validateFamily — the family run (every selected
// project's own gate verbatim, the composition of each project's externals and
// the family checks), republished as the adapter's forward to the validator
// portal.
//
// cli_validator_adapter.familyApprovals — the bound project's pin tree (its own
// approval state and each member's, each computed at that project's own root),
// republished as the adapter's forward to the validator portal: the local lock
// asks with depth 1, `wairon status` for every level.
export { validateAsComplete, computeGateStateId, familyApprovals };
// cli_validator_adapter.familyRelations — the bound family's relation health,
// for `wairon diagram` to colour the canvas's consumption edges.
export { familyRelations };

/** cli_validator_adapter.validateProject — the owner's gate, forwarded to the validator portal. */
export function validateProject(options?: ValidationOptions, projectType?: string): ValidationResult {
  return ownersGate(options, projectType);
}

/** cli_validator_adapter.validateFamily — the family run, forwarded to the validator portal. */
export function validateFamily(options: ValidationOptions): ValidationResult {
  return familyRun(options);
}

/**
 * cli_validator_adapter.adviseExternals — the advisory live comparison of the
 * bound project's externals the run did not compose, forwarded to the
 * validator portal. Every finding is advisory: it never decides the exit code.
 */
export function adviseExternals(composed?: string[]): ValidationIssue[] {
  return adviseLive(composed);
}

/** The heading the advisory live comparison is printed under, by `validate` and `status` alike. */
const ADVISORY_HEADING = 'Externals, compared live (advisory: the pin gates)';

/**
 * Print the advisory findings in their own section — each moved external with
 * who uses it and the fix, each drifted or uncompared one — and say that none
 * of them is part of the failure decision. Prints nothing when there are none.
 */
function renderAdvisory(advised: ValidationIssue[], heading = ADVISORY_HEADING): void {
  if (advised.length === 0) return;
  logger.header(heading);
  for (const issue of advised) {
    const line = `[${issue.code}] ${issue.message}`;
    if (issue.severity === 'error') logger.error(line);
    else if (issue.severity === 'notice') logger.notice(line);
    else logger.warn(line);
  }
  logger.info(chalk.gray(`${advised.length} advisory finding(s): the pin is the reproducible gate, so these never fail validate (nor --ci); \`wairon externals status\` is the live gate.`));
}

/** cli_validator_adapter.validateRegistry — the registry's topology rules, forwarded to the validator portal. */
export function validateRegistry(registry: Registry, rules: RulesConfig): ValidationResult {
  return registryRules(registry, rules);
}

/** cli_validator_adapter.validateProjectConfig — the configuration check, forwarded to the validator portal. */
export function validateProjectConfig(config: ProjectConfig): ValidationResult {
  return configRules(config);
}

/**
 * The one line a member validated on its own prints: its network proofs
 * (ENTRY_UNPROVEN, the gateway and cross-project reach checks) are judged at
 * the family root, by the family run there.
 */
function memberNetworkLine(alias: string, parentRoot: string): string {
  return `Member "${alias}" of ${parentRoot}: its network proofs are judged at the family root — run \`wairon validate\` there; here its network entries count as declared, not proven.`;
}

export interface ValidateOptions {
  ci?: boolean; // treat warnings as errors (for CI pipelines); notices never fail
  subsystem?: string; // validate only a specific subsystem
  recursive?: boolean; // at a parent: the family run (true, the default) or the owner's gate alone (false, a member depth of 0)
  family?: boolean; // ask for the family run explicitly (`validate --family` at a member)
  all?: boolean; // print every finding instead of the first 100 per severity
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
//
// A NOTICE is never part of the failure decision at all: it is printed and
// counted under every mode, and `--ci` never fails on it.
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

/** The --ci draft waiver, the one reading validate and the release re-validation share (models/lock.ts). */
export function isCiDraftWaivable(issue: ValidationIssue): boolean {
  return waivable(issue);
}

/** How a family run labels a project: its key, or the bound root's id. */
function projectLabel(key: string | undefined, result: ValidationResult): string {
  if (key === undefined) return '';
  if (key !== '') return key;
  const root = result.projects?.find((p) => p.key === '');
  return `${root?.id ?? 'bound project'} (bound)`;
}

/** What rendering the spec-tree findings decided for the failure decision. */
interface SpecTally {
  errors: boolean;
  fatalWarnings: boolean;
  waived: number;
  notices: number;
  /** Every warning printed, draft-waivable ones included: what the closing line counts. */
  warnings: number;
}

/**
 * Render the spec-tree verdict: every finding (errors, warnings and notices
 * each as their own kind) — in a family run each under its project key, the
 * per-project verdicts after them — and the one-line hint, when there is one.
 */
export function renderSpecFindings(result: ValidationResult, all = false): SpecTally {
  const tally: SpecTally = { errors: false, fatalWarnings: false, waived: 0, notices: 0, warnings: 0 };
  if (result.issues.length === 0) {
    logger.success('Spec tree is valid and component type boundaries are enforced.');
  }
  // The first 100 findings per severity, unless --all asks for every one.
  const MAX_PRINT = all ? Number.POSITIVE_INFINITY : 100;
  const printed = { error: 0, warning: 0, notice: 0 };
  const skipped = { error: 0, warning: 0, notice: 0 };
  for (const issue of result.issues) {
    const label = projectLabel(issue.project, result);
    const prefix = `${label ? chalk.cyan(`[${label}] `) : ''}${issue.specId ? chalk.gray(`[${issue.specId}] `) : ''}`;
    const line = `${prefix}[${issue.code}] ${issue.message}`;
    if (issue.severity === 'error') tally.errors = true;
    else if (issue.severity === 'notice') tally.notices++;
    else if (isCiDraftWaivable(issue)) { tally.waived++; tally.warnings++; }
    else { tally.fatalWarnings = true; tally.warnings++; }
    if (printed[issue.severity] >= MAX_PRINT) {
      skipped[issue.severity]++;
      continue;
    }
    printed[issue.severity]++;
    if (issue.severity === 'error') logger.error(line);
    else if (issue.severity === 'notice') logger.notice(line);
    else logger.warn(line);
  }
  const more = (n: number, what: string): string =>
    `... and ${n} more ${what}(s) not shown (${printed[what as keyof typeof printed]} of ${printed[what as keyof typeof printed] + n} printed). Run with --all to print every finding.`;
  if (skipped.error > 0) logger.error(more(skipped.error, 'error'));
  if (skipped.warning > 0) logger.warn(more(skipped.warning, 'warning'));
  if (skipped.notice > 0) logger.notice(more(skipped.notice, 'notice'));
  // When the list was long enough to be cut (or --all printed a long one),
  // the per-code totals are the picture a reader actually needs.
  if (skipped.error + skipped.warning + skipped.notice > 0 || (all && result.issues.length > 100)) renderCodeTotals(result);
  if (result.projects) {
    logger.blank();
    logger.info('Per project (its own gate, and the family findings on it):');
    for (const p of result.projects) {
      const mark = p.valid ? chalk.green('ok') : chalk.red('fails');
      logger.info(`  ${projectLabel(p.key, result)} — ${mark}: ${p.errors} error(s), ${p.warnings} warning(s), ${p.notices} notice(s)`);
    }
  }
  if (result.hint) logger.info(result.hint);
  if (result.codeReading) logger.info(result.codeReading);
  return tally;
}

/** Findings counted per severity and code, most frequent first. */
function renderCodeTotals(result: ValidationResult): void {
  const counts = new Map<string, { severity: string; code: string; n: number }>();
  for (const issue of result.issues) {
    const key = `${issue.severity} ${issue.code}`;
    const entry = counts.get(key) ?? { severity: issue.severity, code: issue.code, n: 0 };
    entry.n++;
    counts.set(key, entry);
  }
  const rank: Record<string, number> = { error: 0, warning: 1, notice: 2 };
  const rows = [...counts.values()].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3) || b.n - a.n || a.code.localeCompare(b.code));
  logger.blank();
  logger.info('Findings by code:');
  for (const r of rows) logger.info(`  ${String(r.n).padStart(6)}  ${r.severity.padEnd(7)}  ${r.code}`);
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
  // Notices: printed and counted, never part of the failure decision.
  let noticeTotal = 0;
  // Every warning printed: plain validate passes with them, and says so.
  let warningTotal = 0;
  // Whether there was a design to check at all: an empty tree passes, but
  // "all checks passed" over nothing would claim more than was checked.
  let treeChecked = false;

  // --- Legacy spec filenames check ---
  const legacySpecs = findLegacySpecFiles();
  if (legacySpecs.length > 0) {
    logger.warn(`Warning: ${legacySpecs.length} legacy spec filename(s) detected (e.g., component.yaml). These are deprecated. Please run \`wairon doctor --fix\` to migrate them to the new unified .index.yaml schema.`);
    logger.blank();
  }

  // --- Project config ---
  logger.header('Project Config');
  // A part's configuration says only what it is a part of: its
  // parent's configuration governs it, so it has no targets of its own to check.
  const part = isPart(projectConfig);
  const configResult = part ? { valid: true, issues: [] } : validateProjectConfig(projectConfig);
  if (configResult.issues.length === 0) {
    logger.success('Project config is valid.');
  } else {
    for (const issue of configResult.issues) {
      if (issue.severity === 'error') {
        logger.error(`[${issue.code}] ${issue.message}`);
        hasErrors = true;
      } else if (issue.severity === 'notice') {
        logger.notice(`[${issue.code}] ${issue.message}`);
        noticeTotal++;
      } else {
        logger.warn(`[${issue.code}] ${issue.message}`);
        hasFatalWarnings = true;
        warningTotal++;
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
      } else if (issue.severity === 'notice') {
        logger.notice(`${prefix}[${issue.code}] ${issue.message}`);
        noticeTotal++;
      } else {
        logger.warn(`${prefix}[${issue.code}] ${issue.message}`);
        hasFatalWarnings = true;
        warningTotal++;
      }
    }
  }

  // --- SDD Spec Tree ---
  // A part opened alone has no L0 of its own: its gate judges it against its pinned parent.
  if (pathExists(AI_PATHS.specsSystem()) || part) {
    logger.header('SDD Architectural Specs');
    const sddOptions = {
      rules: projectConfig.rules,
      projectType: projectConfig.projectType,
      scopeSubsystem: options.subsystem,
      // The flag at the edge: --no-recursive is a member depth of 0, the default every level.
      ...(options.recursive === false ? { memberDepth: 0 } : {}),
      family: options.family,
    };
    // Step 6: which spec-tree check — validation_options.selectsFamily, the one
    // reading of the flags every caller shares.
    const family = selectsFamily(sddOptions, declaredMembers(projectConfig).length > 0);
    // Steps 7-9: the family run already holds the owner's gate of every
    // selected project; otherwise the owner's gate over the bound project alone.
    const sddResult = family ? validateFamily(sddOptions) : validateProject(sddOptions);
    // Step 10: the advisory live comparison of every external the run did not
    // compose (a family run hands over the aliases it composed in reach).
    const advised = adviseExternals(family ? sddResult.composed : undefined);
    // Step 11: render — the advisory findings in their own section, never in
    // the failure decision.
    const tally = renderSpecFindings(sddResult, options.all === true);
    hasErrors ||= tally.errors;
    hasFatalWarnings ||= tally.fatalWarnings;
    waivedWarnings += tally.waived;
    noticeTotal += tally.notices;
    warningTotal += tally.warnings;
    treeChecked = part || loadSubsystemSpecs().length > 0;
    if (!treeChecked) logger.info(chalk.gray('The spec tree holds the L0 and nothing below it yet: no subsystem, component or contract to check.'));
    renderAdvisory(advised);
    // A member judged here is judged by its own gate only: its `network`
    // entries count as declared. The proofs that need the whole family run
    // at the root, so a green member run is never read as a proven one.
    const parent = resolveChainingParent();
    if (parent) logger.info(chalk.gray(memberNetworkLine(parent.alias, parent.parentRoot)));
    // Step 12: the approval line, when the approval was taken under another
    // release — the verdict lock-check exits on, never part of this decision.
    const releaseLine = approvalReleaseLine();
    if (releaseLine) logger.info(releaseLine);
  }

  else {
    logger.header('SDD Architectural Specs');
    // A specs folder with no L0 but spec files below it is a tree whose root
    // was deleted (a bad merge, a `git rm` of the wrong path) — never an empty
    // tree: reading it as one switched the gate off over everything below it.
    const orphaned = findOrphanedSpecFiles();
    if (orphaned.length > 0) {
      logger.error(orphanedTreeMessage(orphaned));
      hasErrors = true;
      treeChecked = true;
    } else {
      // No L0 and no file below it: a project that never approved a design has
      // none to check yet; one whose approval records spec files had its tree
      // deleted, which fails closed exactly as lock-check and status do. An
      // unreadable record is lock-check's and status's to refuse (they name it).
      let record = null;
      try { record = readLockRecord(); } catch { record = null; }
      const missing = record ? missingTreeSentence(record) : null;
      if (missing) {
        logger.error(missing);
        hasErrors = true;
        treeChecked = true;
      } else {
        logger.info(chalk.gray('No spec tree yet (.wai/specs holds no L0): there is no design to check. Start one with the sdd-architect skill.'));
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

  // Notices are counted on every run, and said to be outside the failure
  // decision, so a reader of a green CI log still sees they exist.
  if (noticeTotal > 0) {
    logger.info(chalk.blue(`${noticeTotal} notice(s) reported — never part of the failure decision${options.ci ? ' (--ci does not fail on notices)' : ''}.`));
  }

  // Draft-related warnings are surfaced above but excluded from the --ci
  // failure decision (they reflect declared drafts, not incomplete finished
  // work). Make that explicit in the summary.
  if (options.ci && waivedWarnings > 0) {
    logger.warn(`--ci waived ${waivedWarnings} draft-related warning(s): excluded from the failure decision because the referenced specs are in draft/design status. They fail --ci once those specs are marked complete.`);
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
    if (!treeChecked) {
      logger.success('Nothing to check yet: the spec tree is empty, and the project configuration is valid.');
    } else if (options.ci) {
      logger.success(`All checks passed (CI mode — warnings treated as errors, draft-related warnings excepted; notices never fail)${waivedWarnings > 0 ? ` — ${waivedWarnings} draft-related warning(s) waived` : ''}.`);
    } else if (warningTotal > 0) {
      logger.warn(`Passed with ${warningTotal} warning(s) — not a failure here, but \`wairon validate --ci\` fails on them${waivedWarnings > 0 ? ` (except the ${waivedWarnings} draft-related one(s))` : ''}.`);
    } else {
      logger.success('All checks passed.');
    }
  }
}

/**
 * The approval line `validate` prints when the bound project's approval was
 * taken under another wairon release: carried (re-validated clean: still
 * approved) or not (the new release's findings). Null otherwise, and when the
 * approval cannot be read — `lock-check` and `status` own that refusal.
 */
function approvalReleaseLine(): string | null {
  let own;
  try {
    own = familyApprovals(0).find((a) => a.key === '');
  } catch {
    return null;
  }
  const release = own?.release;
  // A release stamp this wairon cannot stand behind is said here too: every surface names it.
  const stamp = own?.stampProblem !== undefined
    ? `Approval notice: ${own.stampProblem} — \`wairon lock\` replaces the stamp with this release.`
    : null;
  if (!release) return stamp === null ? null : chalk.blue(stamp);
  return release.carried
    ? chalk.green(`Approval: approved under wairon ${release.from}, re-validated under ${release.to}: still approved. (\`wairon lock\` refreshes the record's release stamp without a re-approval.)`)
    : release.reason
      ? chalk.yellow(`Approval: ${release.reason} \`wairon lock-check\` fails until it is re-locked.`)
      : chalk.yellow(`Approval: approved under wairon ${release.from}, and the new release (${release.to}) finds ${release.count ?? 0} issue(s) in the approved design — \`wairon lock-check\` fails until they are resolved and the design re-locked.`);
}

/**
 * What `validate` and `lock-check` say of a specs folder that holds spec
 * files but no L0: the root that is missing, how many files it leaves
 * unjudged (the first few named), and how to restore it.
 */
function orphanedTreeMessage(orphaned: string[]): string {
  const shown = orphaned.slice(0, 3).join(', ') + (orphaned.length > 3 ? `, … and ${orphaned.length - 3} more` : '');
  return `The L0 System spec (.wai/specs/.index.yaml) is missing, but ${orphaned.length} spec file(s) remain below it (${shown}): `
    + 'the tree is not empty, its root is gone, so nothing below it can be judged. Restore it from version control '
    + '(`git checkout -- .wai/specs/.index.yaml`); remove the remaining spec files only if the whole design is meant to go.';
}
