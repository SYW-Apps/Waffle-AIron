import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized } from '../config/paths.js';
import { LockRecordUnreadableError } from '../utils/errors.js';
// Both sdd_core reads cross the subsystem boundary through cli_core_adapter,
// the one component whose whole job is that crossing. This command used to
// reach past it — straight into ../core/specs.js for the tree and
// ../core/index.js for the verdict — and then render the report itself, line
// for line, a second copy of ../core/status.ts. The two copies drifted: the
// approval verdict existed in one of them and not the other, so `wairon status`
// and `sdd_get_status` disagreed about whether the tree had moved away from its
// lock. There is one renderer now, and this file only says what the colours are.
import { getStatusReport, approvalVerdict } from './adapters/core.js';
// The pin tree: every project's approval state, computed by the validator at
// that project's own root, so a member's state here is the one its own status prints.
import { familyApprovals } from './validate.js';
// The advisory live comparison of the externals, printed in its own section
// beside the verdict: what moved, who uses it, the fix — the pin still gates.
import { adviseExternals } from './validate.js';
import type { ValidationIssue } from '../core/validation.js';
import type { StatusDecor, StatusOptions } from '../core/status.js';
// The pending-transaction banner: unfinished family migrations, asked of the
// migration portal (recover with fix false — a report, nothing written).
import { recover as recoverMigrations } from './adapters/migrations.js';
import { getProjectRoot } from '../utils/fs.js';

// ---------------------------------------------------------------------------
// status command
//
// Shows the spec tree with its authoring readiness (from each spec's status)
// and, separately, the approval verdict from the lock record.
// ---------------------------------------------------------------------------

/** What each layer's label looks like in a terminal. */
const LAYER_COLOUR: Record<string, (text: string) => string> = {
  system: text => chalk.bold.blue(text),
  subsystem: text => chalk.bold.cyan(text),
  project: text => chalk.bold.yellow(text),
  component: text => chalk.magenta(text),
  interface: text => chalk.blue(text),
  implementation: text => chalk.green(text),
};

/** Green at complete, yellow past halfway, red below it. */
function scoreColour(pct: number): (text: string) => string {
  if (pct === 100) return text => chalk.green(text);
  if (pct >= 50) return text => chalk.yellow(text);
  return text => chalk.red(text);
}

/**
 * The terminal's reading of each role the report hands back. The report names
 * what a thing IS — scaffolding, a layer label, a score, a draft tag, a source
 * file present or missing — and this is the only place that decides what colour
 * that is. A role the terminal does not colour is simply not listed.
 */
const TERMINAL_DECOR: StatusDecor = {
  structure: text => chalk.gray(text),
  emphasis: text => chalk.bold(text),
  layer: (kind, text) => (LAYER_COLOUR[kind] ?? ((plain: string) => plain))(text),
  score: (pct, text) => scoreColour(pct)(text),
  draft: text => chalk.yellow(text),
  present: text => chalk.green(text),
  missing: text => chalk.red(text),
};

/**
 * The one failure a person at a terminal can act on in the next second, and
 * the advice that goes with it. Neither is in the report: `sdd_get_status`
 * hands the same explanation to an agent that cannot run `wairon init`, so
 * the suggestion belongs to the command, not to sdd_core.
 *
 * Recognising WHICH failure this is by its sentence is the last prose match
 * left here — the report says THAT it failed, never which way — so the two
 * spellings are pinned together by a test rather than by hope.
 */
const NO_SYSTEM_SPEC = 'This project has no L0 System spec yet (.wai/specs/.index.yaml): its design has not been started.';
const INIT_HINT = ' Run `wairon init` first.';

/**
 * A tree that will not load, said the way this command has always said it:
 * on stderr, one line per failure, and a non-zero exit.
 *
 * The exit code is the whole point. A script running `wairon status` over a
 * broken tree sees nothing else, and for one release it saw 0 — the report
 * had become a string carrying three different outcomes, so the only way to
 * tell a failure from a dashboard was to read the prose, and nothing did.
 */
function refuseUnreadableTree(explanation: string): never {
  const lines = withoutTrailingNewline(explanation).split('\n');
  const last = lines.length - 1;
  if (lines[last] === NO_SYSTEM_SPEC) lines[last] += INIT_HINT;
  for (const line of lines) logger.error(line);
  process.exit(1);
}

/**
 * The report already ends each line; `console.log` would add a second one.
 * Printing through `console.log` rather than writing to the stream is what
 * keeps the dashboard testable at all.
 */
function withoutTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

export async function runStatus(options: StatusOptions = {}, listAll = false): Promise<void> {
  // Step 1: refuse outside a wairon project — a dashboard of nothing would read
  // like an empty tree rather than like the wrong directory.
  assertProjectInitialized();

  // Step 2: the pending-transaction banner FIRST — a crash mid-swap is exactly
  // when the tree below may not read.
  printPendingTransactions();

  // Step 3: ask the validator for the pin tree, each project at its own root.
  // A tree that will not load has no states to print: the report below says why.
  let approvals;
  try {
    approvals = familyApprovals(options.memberDepth);
  } catch (e) {
    // An approval record that cannot be read is never shown as no approval:
    // the dashboard fails closed on it, as every gate does.
    if (e instanceof LockRecordUnreadableError) throw e;
    approvals = undefined;
  }

  // Step 3: ask the core adapter for the completeness report with the pin
  // tree, handing it the terminal's colours as roles.
  const report = getStatusReport({ ...options, approvals }, TERMINAL_DECOR);

  // Step 3: decide whether the tree could be reported on at all.
  if (report.failed) {
    // Step 4: print the explanation as an error and exit non-zero, naming
    // `wairon init` when there is no system specification.
    refuseUnreadableTree(report.text);
  }

  // Step 5: print a heading and the report beneath it.
  logger.header('Architecture Status Dashboard');
  logger.blank();
  console.log(withoutTrailingNewline(report.text));

  // Step 6: ask what the lock says about this tree. The same verdict the MCP
  // report carries — the CLI is where a human actually looks, so it must not be
  // the surface that stays quiet.
  const lock = approvalVerdict(approvals);

  // Step 7: print the verdict, choosing severity from whether it reports drift
  // rather than by matching its wording — which is why the verdict answers a
  // fact beside the sentence.
  if (lock.text.trim()) {
    logger.blank();
    // With --all, every moved spec instead of the first forty and a count
    // (the verdict names the command when it cuts the list).
    const lines = lock.text.trim().split('\n');
    const text = listAll && lock.moved && lock.moved.length > 0
      ? [lines[0], ...lock.moved.map((p) => `  ${p}`), ...lines.slice(1).filter((l) => !l.startsWith('  '))].join('\n')
      : lock.text.trim();
    // On stdout like the report above it, so the two never interleave.
    if (lock.drifted) console.log(chalk.yellow(`⚠  ${text}`));
    else logger.info(text);
  }
  // Steps 10-11: the externals compared with their live producers, offline and
  // advisory — the same pass plain `validate` appends. An Externals section
  // only when one moved, drifted or could not be compared; the exit code is
  // unchanged.
  printExternals(adviseExternals());
  // The percentages above and the approval answer different questions, and an
  // approved tree at "80% Complete" read like a contradiction — so say what the
  // percentage counts, always.
  logger.info(chalk.gray(
    'The percentages measure authoring progress, not approval: 80% once a component\'s component, contract and '
      + 'implementation specs are written, 100% once its implementation names source files that exist (capped at 50% '
      + 'while any of them is draft or design). Approval is the lock record (.wai/lock.json); `wairon lock` changes no spec.',
  ));

  logger.blank();
  // Step 8: done.
}

/**
 * The Externals section: one line per external that moved live, drifted or
 * could not be compared — what moved, who uses it and the fix — noting that
 * the pin still gates. Nothing when every external is current.
 */
function printExternals(advised: ValidationIssue[]): void {
  if (advised.length === 0) return;
  logger.header('Externals');
  for (const issue of advised) {
    const line = `[${issue.code}] ${issue.message}`;
    if (issue.severity === 'notice') logger.notice(line);
    else logger.warn(line);
  }
  logger.info(chalk.gray('Compared live and advisory: the pin still gates, so none of this changes an exit code. `wairon externals status` is the live gate.'));
}

/**
 * The pending-transaction banner (`wairon status` and `wairon validate`): one
 * notice line per unfinished family migration under this root, naming it and
 * pointing at `wairon doctor --fix`; silent when there is none. A notice never
 * changes the exit code, and a failure to read the transactions is not this
 * command's to report — doctor reports it.
 */
function printPendingTransactions(): void {
  let pending;
  try {
    pending = recoverMigrations(getProjectRoot(), false);
  } catch {
    return;
  }
  for (const t of pending) {
    logger.notice(`[TRANSACTION_PENDING] an unfinished family migration (${t.verb}, transaction ${t.id}, coordinator phase ${t.phase}) — run \`wairon doctor --fix\` to roll it back`);
  }
}
