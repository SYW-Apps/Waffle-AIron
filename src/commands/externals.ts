import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import { assertProjectInitialized } from '../config/paths.js';
import { getExternalsStatus, listExternals, pinExternals } from './adapters/surfaces.js';
import type { ExternalListing, ExternalPin, ExternalStatus } from '../models/index.js';

// ---------------------------------------------------------------------------
// `wairon externals` (sdd_cli → sdd_surfaces, through the surfaces client adapter)
//
// pin [alias…] — pin the named declared externals, else all, into
//                .wai/externals/ and .wai/externals.lock.yaml
// status       — each external's pin compared with its live producer at
//                signature level; reports, never fails on staleness
// list         — the declared externals, how each resolves, what is pinned
// ---------------------------------------------------------------------------

/** An unknown `wairon externals` action. */
export class UnknownExternalsActionError extends WaironError {
  constructor(action: string) {
    super(`Unknown externals action "${action}" (supported: pin, status, list).`);
    this.name = 'UnknownExternalsActionError';
  }
}

export interface ExternalsOptions {
  /** Print the structured answer instead of the table. */
  json?: boolean;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** One line per alias: its outcome, the used-name count and each unexported reference. */
function printPins(pins: ExternalPin[]): void {
  if (!pins.length) {
    logger.info('This project declares no externals (.wai/project.yaml `externals`).');
    return;
  }
  const outcome = (o: ExternalPin['outcome']): string =>
    o === 'pinned' ? chalk.green(o) : o === 'unchanged' ? chalk.gray(o) : chalk.yellow(o);
  for (const pin of pins) {
    const what = pin.digest ? ` ${pin.usedNames} used name(s), ${pin.digest.slice(0, 19)}…` : '';
    logger.info(`${chalk.cyan(pin.alias)} → ${pin.project ?? '?'}: ${outcome(pin.outcome)}${what}${pin.detail ? ` — ${pin.detail}` : ''}`);
    for (const ref of pin.unexported) {
      logger.info(`    unexported: "${ref.specId}" reaches "${ref.target}"${ref.member ? ` (${ref.member})` : ''} — export it from the producer's L0 to pin it`);
    }
  }
}

/** The status table: per alias its source, pin, reach, staleness and drift, then each used member. */
function printStatuses(statuses: ExternalStatus[]): void {
  if (!statuses.length) {
    logger.info('This project declares no externals (.wai/project.yaml `externals`).');
    return;
  }
  for (const s of statuses) {
    const flags = [
      s.sourceKind,
      s.pinned ? 'pinned' : chalk.yellow('not pinned'),
      s.reachable ? 'reachable' : chalk.yellow('unreachable'),
      s.stale ? chalk.red('stale') : 'current',
      ...(s.drifted ? [chalk.yellow('drifted')] : []),
    ];
    logger.info(`${chalk.cyan(s.alias)} → ${s.project}: ${flags.join(', ')}${s.detail ? ` — ${s.detail}` : ''}`);
    for (const u of s.uses) {
      const name = [u.publicName, u.member].filter(Boolean).join('.') || '(the external)';
      logger.info(`    ${name}: ${u.state}${u.code ? ` ${u.code}` : ''}${u.detail ? ` — ${u.detail}` : ''}`);
    }
  }
}

/** The list table: alias, producer, source kind and relation, audience, pinned digest or the problem. */
function printListings(rows: ExternalListing[]): void {
  if (!rows.length) {
    logger.info('This project declares no externals (.wai/project.yaml `externals`).');
    return;
  }
  for (const r of rows) {
    const source = r.relation ? `${r.sourceKind} (${r.relation})` : r.sourceKind;
    const tail = r.problem ? chalk.yellow(r.problem) : r.lock ? `pinned ${r.lock.digest.slice(0, 19)}…` : chalk.gray('not pinned');
    logger.info(`${chalk.cyan(r.alias)} → ${r.project}: ${source}, audience ${r.audience} — ${tail}`);
  }
}

/** cli_runner.runExternals — `wairon externals <action> [alias…]`. */
export async function runExternals(action: string, aliases: string[], options: ExternalsOptions = {}): Promise<void> {
  assertProjectInitialized();
  // Step 1: route on the action.
  switch (action) {
    case 'pin': {
      // Steps 2-3.
      const pins = pinExternals(aliases.length ? aliases : undefined);
      if (options.json) printJson(pins);
      else printPins(pins);
      return;
    }
    case 'status': {
      // Steps 4-5: staleness never fails the command.
      const statuses = getExternalsStatus();
      if (options.json) printJson(statuses);
      else printStatuses(statuses);
      return;
    }
    case 'list': {
      // Steps 6-7.
      const rows = listExternals();
      if (options.json) printJson(rows);
      else printListings(rows);
      return;
    }
    default:
      // Step 8.
      throw new UnknownExternalsActionError(action);
  }
}
