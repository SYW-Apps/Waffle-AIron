import chalk from 'chalk';
import inquirer from 'inquirer';
import { WAIRON_VERSION, GITHUB_REPO } from '../config/defaults.js';
import { lastSeenVersion, setLastSeenVersion } from '../config/userconfig.js';
import * as fs from 'fs';
import * as path from 'path';
import { getProjectRootOverride, resolveProjectBinding } from '../utils/fs.js';
import { isSilent, logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import { isNewerVersion } from '../utils/version.js';
import { standing, plan as planUpgrade, apply as applyUpgrade, discard, releaseNotes } from '../cli/adapters/upgrade.js';
import type { UpgradePlan, TreeUpgradeReport } from '../upgrade/types.js';

// ---------------------------------------------------------------------------
// cli_runner — the upgrade workflows: `wairon upgrade`, `wairon whatsnew`, the
// guard that stops a project command on a tree another major wrote (and offers
// the upgrade where a person can answer), and the one-time release banner.
// Everything reaches sdd_upgrade through cli_upgrade_adapter.
// ---------------------------------------------------------------------------

/** The link to the full changelog. */
export const CHANGELOG_URL = `https://github.com/${GITHUB_REPO}/releases`;

/**
 * Commands (first word, or the whole path) that act on no project, or announce
 * their own binding — in one place so the binding banner (announceBinding) and
 * the standing guard (guardStanding) cannot disagree about which they are.
 */
const NO_PROJECT_COMMANDS = new Set(['init', 'host', 'remote', 'login', 'logout', 'serve', 'dev', 'update', 'aliases', 'help', 'mcp serve']);

/** Whether the command path (`status`, `mcp serve`, ...) acts on no project. */
export function actsOnNoProject(commandPath: string): boolean {
  const first = commandPath.split(' ')[0];
  return NO_PROJECT_COMMANDS.has(first) || NO_PROJECT_COMMANDS.has(commandPath);
}

/** `wairon upgrade` options. */
export interface UpgradeCommandOptions {
  /** Print the plan and write nothing. */
  report?: boolean;
  /** Apply without asking. */
  yes?: boolean;
}

/** Thrown when an upgrade cannot or did not happen; the message names what to do. */
export class UpgradeRefusedError extends WaironError {
  constructor(message: string) {
    super(message);
    this.name = 'UpgradeRefusedError';
  }
}

/** A terminal that may be asked: stdin and stdout are TTYs and CI is not set. */
function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);
}

/** The bound project's root: an explicit override, else the binding rule from the cwd. */
function boundRoot(): string | null {
  return getProjectRootOverride() ?? resolveProjectBinding(process.cwd())?.root ?? null;
}

/** Whether the root holds a project.yaml (under .wai, or the legacy .wairon) for a stamp to be read from. */
function holdsConfig(root: string): boolean {
  return ['.wai', '.wairon'].some((dir) => fs.existsSync(path.join(root, dir, 'project.yaml')));
}

/** Whether the plan only stamps: no step rewrites or reports anything. */
function isStampOnly(plan: UpgradePlan): boolean {
  return !plan.refusal && plan.steps.every((s) => s.changes.length === 0 && s.reported.length === 0);
}

/** Whether any project of the plan is older than the running major. */
function hasOlder(plan: UpgradePlan): boolean {
  return plan.standings.some((s) => s.state === 'older');
}

/** Print the plan: standings, every rewrite, what only an author can decide, then what the new major changes. */
function printPlan(plan: UpgradePlan): void {
  logger.blank();
  console.log(`${chalk.bold('wairon upgrade')} ${chalk.gray(`— to major ${plan.runningMajor}`)}`);
  // A stamp-only plan is a tree already in the running major's forms that predates the stamp (6.0.0).
  const stampOnly = isStampOnly(plan);
  for (const s of plan.standings) {
    const written = s.unfinished
      ? `stamped major ${s.runningMajor}, but still holding wairon ${s.writtenMajor} forms: an unfinished upgrade`
      : !s.stamped && stampOnly ? 'made by wairon 6.0.0, before the major stamp' : `written by major ${s.writtenMajor}${s.stamped ? '' : ' (unstamped)'}`;
    const note = s.state === 'older' ? written : s.state;
    console.log(`  ${s.root}  ${chalk.gray(note)}`);
  }
  if (isStampOnly(plan)) {
    console.log(`  ${chalk.gray('Nothing to rewrite: only the major stamp moves.')}`);
    logger.blank();
    return;
  }
  for (const step of plan.steps) {
    if (step.changes.length === 0 && step.reported.length === 0) continue;
    console.log(`\n  ${chalk.bold(step.project)} ${chalk.gray(`(major ${step.step.from} to ${step.step.to})`)}`);
    for (const c of step.changes) {
      const at = c.spec ? `${c.spec}: ` : '';
      console.log(`    ${c.design ? chalk.yellow('design') : chalk.gray('       ')} ${at}${c.description}`);
    }
    for (const r of step.reported) console.log(`    ${chalk.yellow('decide')} ${r}`);
  }
  if (plan.whatChanged.length > 0) {
    console.log(`\n  ${chalk.bold('What the new major changes')}`);
    for (const line of plan.whatChanged) console.log(`    - ${line}`);
  }
  logger.blank();
}

/** Where an applied upgrade's plan is written, under the family's top root. */
export const UPGRADE_REPORT_FILE = path.join('.wai', 'upgrade-report.md');

/**
 * The applied plan as Markdown: every rewrite and every decision in full, so
 * an author works from the file and never copies text off a wrapped console.
 * Pure.
 */
export function reportMarkdown(plan: UpgradePlan): string {
  const lines = [`# wairon upgrade — to major ${plan.runningMajor}`, ''];
  for (const s of plan.standings) {
    if (s.state === 'older') lines.push(`- \`${s.root}\`: ${s.unfinished ? `an unfinished upgrade from wairon ${s.writtenMajor}` : `written by major ${s.writtenMajor}`}`);
  }
  for (const step of plan.steps) {
    if (step.changes.length === 0 && step.reported.length === 0) continue;
    lines.push('', `## ${step.project} (major ${step.step.from} to ${step.step.to})`);
    if (step.changes.length > 0) {
      lines.push('', '### Rewritten', '');
      for (const c of step.changes) lines.push(`- ${c.design ? '**design** ' : ''}${c.spec ? `\`${c.spec}\`: ` : ''}${c.description}`);
    }
    if (step.reported.length > 0) {
      lines.push('', '### To decide', '');
      for (const r of step.reported) lines.push(`- ${r}`);
    }
  }
  if (plan.whatChanged.length > 0) {
    lines.push('', '## What the new major changes', '');
    for (const line of plan.whatChanged) lines.push(`- ${line}`);
  }
  return lines.join('\n') + '\n';
}

/** Print the projects now stamped and each that owes `wairon lock`; a plan that rewrote anything is also written to the report file. */
function printOutcome(report: TreeUpgradeReport): void {
  for (const root of report.stamped) logger.success(`${root} is now on major ${report.plan.runningMajor}`);
  for (const root of report.relock) logger.warn(`${root}: the approved design moved — run \`wairon lock\` at its root`);
  if (isStampOnly(report.plan)) return;
  const file = path.join(report.plan.familyRoot, UPGRADE_REPORT_FILE);
  try {
    fs.writeFileSync(file, reportMarkdown(report.plan));
    logger.info(`Every rewrite and decision is written to ${file}.`);
  } catch (err) {
    logger.warn(`The upgrade is applied, but its report could not be written to ${file} (${(err as Error).message}); the plan above is the whole of it.`);
  }
}

/** Ask the person a yes/no question; the default is no. */
async function ask(message: string): Promise<boolean> {
  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    { type: 'confirm', name: 'confirmed', message, default: false },
  ]);
  return confirmed;
}

/** The command that upgrades the bound project's family to the running major. */
export async function runUpgrade(options: UpgradeCommandOptions): Promise<void> {
  const root = boundRoot();
  if (!root) throw new UpgradeRefusedError('wairon upgrade: no wairon project binds this folder.');
  // Step 1: plan the upgrade of the bound project's family.
  const plan = planUpgrade(root);
  // Steps 2-3: a plan the release refuses stops here.
  if (plan.refusal) {
    throw new UpgradeRefusedError(`wairon upgrade: this release cannot upgrade the project — ${plan.refusal}`);
  }
  // Steps 4-5: nothing older, nothing to write.
  if (!hasOlder(plan)) {
    discard(plan);
    logger.success(`Already on the running major (${plan.runningMajor}); nothing was written.`);
    return;
  }
  // Step 6: the plan, then what the new major changes.
  printPlan(plan);
  // Steps 7-9: a report writes nothing.
  if (options.report) {
    discard(plan);
    console.log(chalk.gray('Nothing was written.'));
    return;
  }
  // Step 10: a stamp-only plan needs no confirmation; otherwise --yes or an interactive yes.
  const confirmed = isStampOnly(plan)
    || options.yes === true
    || (isInteractive() && await ask('Apply this upgrade?'));
  if (confirmed) {
    // Step 11: all or nothing.
    const report = applyUpgrade(plan);
    // Steps 12-13: a failure leaves every file as it was.
    if (!report.committed) {
      throw new UpgradeRefusedError(`wairon upgrade failed: ${report.failure ?? 'the transaction did not commit'}. Every file is as before.`);
    }
    // Steps 14-15.
    printOutcome(report);
    return;
  }
  // Steps 16-17: dropped; a non-interactive run is told how to confirm.
  discard(plan);
  logger.info('Nothing was written. Run `wairon upgrade --yes` to apply it without a prompt.');
}

/** The command that prints the curated notes of one release and the link to the full changelog. */
export function runWhatsNew(version?: string): void {
  // Step 1: the version named, else the running one.
  const target = version ?? WAIRON_VERSION;
  // Step 2.
  const notes = releaseNotes(null, target);
  // Step 3.
  logger.blank();
  console.log(chalk.bold(`What's new in ${target}`));
  if (notes.length === 0) {
    console.log(`  ${chalk.gray('This version has no curated notes.')}`);
  } else {
    for (const note of notes) for (const h of note.highlights) console.log(`  - ${h}`);
  }
  console.log(`\nFull changelog: ${CHANGELOG_URL}`);
  logger.blank();
}

/**
 * Stop a project command on a tree another major wrote. Exempt: upgrade,
 * whatsnew, doctor, init, help and version, and every command that acts on no
 * project; any folder no project binds; and a bound project whose
 * project.yaml is missing — the command reports that in its own words, and
 * `wairon upgrade` could not help.
 */
export async function guardStanding(commandPath: string): Promise<void> {
  // Steps 1-2: an exempt command, or no bound project, runs as it is.
  const first = commandPath.split(' ')[0];
  if (['upgrade', 'whatsnew', 'doctor', 'init', 'help', 'version'].includes(first) || actsOnNoProject(commandPath)) return;
  const root = boundRoot();
  if (!root || !holdsConfig(root)) return;
  // Step 3: where the bound tree stands.
  const where = standing(root);
  // Steps 4-6: current runs; newer and out of window are refused with the release to install.
  if (where.state === 'current') return;
  if (where.state !== 'older') {
    throw new UpgradeRefusedError(`wairon ${commandPath}: ${where.advice ?? 'this project was written by another wairon major'}`);
  }
  // Step 7.
  const plan = planUpgrade(root);
  let refusal: string | undefined = plan.refusal;
  if (!refusal && isStampOnly(plan)) {
    // Steps 8-10: a stamp-only plan is applied without asking.
    const report = applyUpgrade(plan);
    if (report.committed) return;
    refusal = report.failure;
  } else if (!refusal && isInteractive()) {
    // Steps 11-13: a terminal is asked.
    printPlan(plan);
    if (await ask('This project was written by an older wairon major. Upgrade now?')) {
      // Steps 14-16.
      const report = applyUpgrade(plan);
      if (report.committed) {
        printOutcome(report);
        return;
      }
      refusal = report.failure;
    } else {
      discard(plan);
    }
  } else {
    discard(plan);
  }
  // Steps 17-18: refused, naming the upgrade and the refusal or failure when there was one.
  throw new UpgradeRefusedError(
    `wairon ${commandPath}: this project was written by an older wairon major — run \`wairon upgrade\`.${refusal ? ` (${refusal})` : ''}`,
  );
}

/** Print the release notes since the version last seen on this machine, once per new version. */
export function announceRelease(): void {
  // Steps 1-2: nothing under --silent or on a non-interactive run.
  if (isSilent() || !process.stdout.isTTY || process.env.CI) return;
  // Steps 3-4: the running version must be newer than the one last seen, or none recorded.
  const seen = lastSeenVersion();
  if (seen !== null && !isNewerVersion(seen, WAIRON_VERSION)) return;
  // Step 5.
  const notes = releaseNotes(seen, WAIRON_VERSION);
  // Step 6: newest first, then the way to the rest.
  if (notes.length > 0) {
    console.log(chalk.bold(`wairon ${WAIRON_VERSION} — what's new`));
    for (const note of notes) {
      console.log(`  ${chalk.gray(note.version)}`);
      for (const h of note.highlights) console.log(`    - ${h}`);
    }
    console.log(`Run \`wairon whatsnew\` for this release, or see ${CHANGELOG_URL}\n`);
  }
  // Step 7: recorded as seen.
  setLastSeenVersion(WAIRON_VERSION);
}
