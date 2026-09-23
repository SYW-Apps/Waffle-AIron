import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized } from '../config/paths.js';
// Both sdd_core reads cross the subsystem boundary through cli_core_adapter,
// the one component whose whole job is that crossing. This command used to
// reach past it — straight into ../core/specs.js for the tree and
// ../core/index.js for the verdict — and then render the report itself, line
// for line, a second copy of ../core/status.ts. The two copies drifted: the
// approval verdict existed in one of them and not the other, so `wairon status`
// and `sdd_get_status` disagreed about whether the tree had moved away from its
// lock. There is one renderer now, and this file only says what the colours are.
import { getStatusReport, approvalVerdict } from './subsystem.js';
import type { StatusDecor, StatusOptions } from '../core/status.js';

// ---------------------------------------------------------------------------
// status command
//
// Shows a hierarchical completeness map of the SDD Spec Tree.
// ---------------------------------------------------------------------------

/** What each layer's label looks like in a terminal. */
const LAYER_COLOUR: Record<string, (text: string) => string> = {
  system: text => chalk.bold.blue(text),
  subsystem: text => chalk.bold.cyan(text),
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
const NO_SYSTEM_SPEC = 'L0 System specification (system.yaml) is missing.';
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

export async function runStatus(options: StatusOptions = {}): Promise<void> {
  // Step 1: refuse outside a wairon project — a dashboard of nothing would read
  // like an empty tree rather than like the wrong directory.
  assertProjectInitialized();

  // Step 2: ask the core adapter for the completeness report, handing it the
  // terminal's colours as roles.
  const report = getStatusReport(options, TERMINAL_DECOR);

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
  const lock = approvalVerdict();

  // Step 7: print the verdict, choosing severity from whether it reports drift
  // rather than by matching its wording — which is why the verdict answers a
  // fact beside the sentence.
  if (lock.text.trim()) {
    logger.blank();
    if (lock.drifted) logger.warn(lock.text.trim());
    else logger.info(lock.text.trim());
  }

  logger.blank();
  // Step 8: done.
}
