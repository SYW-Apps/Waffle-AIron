import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import { assertProjectInitialized } from '../config/paths.js';
import { declareExternal, getExternalsStatus, listExternals, pinExternals } from './adapters/surfaces.js';
import { relationHealth, type ExternalAddition, type ExternalListing, type ExternalPin, type ExternalStatus, type RelationHealth } from '../models/index.js';

// ---------------------------------------------------------------------------
// `wairon externals` (sdd_cli → sdd_surfaces, through the surfaces client adapter)
//
// add <alias> [<source>] — declare one external in .wai/project.yaml, checked
//                against the producer it reaches and pinned by default
// pin [alias…] — pin the named declared externals, else all, into
//                .wai/externals/ and .wai/externals.lock.yaml; exit 1 when an
//                alias could not be pinned
// status       — each external's pin compared with its live producer at
//                signature level: the opt-in live gate (exit 1 incompatible,
//                2 not compared, 0 otherwise)
// list         — the declared externals, how each resolves, what is pinned
// ---------------------------------------------------------------------------

/** An unknown `wairon externals` action. */
export class UnknownExternalsActionError extends WaironError {
  constructor(action: string) {
    super(`Unknown externals action "${action}" (supported: add, pin, status, list).`);
    this.name = 'UnknownExternalsActionError';
  }
}

export interface ExternalsOptions {
  /** Print the structured answer instead of the table. */
  json?: boolean;
  /** add: the producer's project id when it differs from the alias (--project). */
  project?: string;
  /** add: git only — the branch, tag or full commit the pin follows (--ref). */
  ref?: string;
  /** add: git only — the producer's root inside the repository (--dir). */
  dir?: string;
  /** add: public names to import bare (--use a,b or --use '*'). */
  use?: string[];
  /** add: what the producer is to this project (--description). */
  description?: string;
  /** add: pin right after declaring (default true; --no-pin declares only). */
  pin?: boolean;
  /** add: say what would be declared, write nothing (--dry-run). */
  dryRun?: boolean;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** How a source.hosted external's reason begins when it is read outside a hosted server. */
const HOSTED_ONLY = 'hosted-only producer';

/** One line per alias: its outcome, the used-name count and each unexported reference. */
function printPins(pins: ExternalPin[]): void {
  if (!pins.length) {
    logger.info('This project declares no externals (.wai/project.yaml `externals`).');
    return;
  }
  const outcome = (o: ExternalPin['outcome']): string =>
    o === 'pinned' ? chalk.green(o) : o === 'unchanged' ? chalk.gray(o) : chalk.yellow(o);
  for (const pin of pins) {
    // A source.hosted external outside a hosted server: say where it is available, never a bare unresolved.
    if (pin.outcome === 'unresolved' && pin.detail?.startsWith(HOSTED_ONLY)) {
      logger.info(`${chalk.cyan(pin.alias)} → ${pin.project ?? '?'}: ${chalk.yellow(pin.detail)}`);
      continue;
    }
    const what = pin.digest ? ` ${pin.usedNames} used name(s), ${pin.digest.slice(0, 19)}…` : '';
    logger.info(`${chalk.cyan(pin.alias)} → ${pin.project ?? '?'}: ${outcome(pin.outcome)}${what}${pin.detail ? ` — ${pin.detail}` : ''}`);
    for (const ref of pin.unexported) {
      logger.info(`    unexported: "${ref.specId}" reaches "${ref.target}"${ref.member ? ` (${ref.member})` : ''} — export it from the producer's L0 to pin it`);
    }
  }
}

/** How each health word reads in the table: never `current` beside `unreachable`. */
const HEALTH_WORD: Record<RelationHealth, string> = {
  incompatible: chalk.red('incompatible'),
  unavailable: chalk.yellow('not compared'),
  drifted: chalk.yellow('drifted'),
  ok: 'ok',
};

/** The status table: per alias its source, pin, reach and health, then each used member. */
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
      HEALTH_WORD[relationHealth(s)],
    ];
    logger.info(`${chalk.cyan(s.alias)} → ${s.project}: ${flags.join(', ')}${s.detail ? ` — ${s.detail}` : ''}`);
    for (const u of s.uses) {
      const name = [u.publicName, u.member].filter(Boolean).join('.') || '(the external)';
      const state = u.state === 'renamed' && u.renamedTo ? `renamed to ${u.renamedTo}` : u.state;
      logger.info(`    ${name}: ${state}${u.code ? ` ${u.code}` : ''}${u.detail ? ` — ${u.detail}` : ''}`);
    }
  }
  // One legend for every word above, and the fix each one asks for.
  logger.info(chalk.gray(
    'Words: incompatible — a name this project uses changed, was renamed or was removed since the pin (adapt the uses, then re-pin); '
      + 'not compared — the producer could not be read, or a use is not in the pin (make the producer reachable, or re-pin; never a pass); '
      + 'drifted — the producer moved since the pin while nothing used changed (re-pin when convenient); ok — every used name matches the pin. '
      + 'Per name: unchanged; changed (its signature moved); renamed (the producer\'s rename trace names the new name — follow it); '
      + 'removed (gone from the producer\'s export table); unlocked (used but not in the pin yet — re-pin); unavailable (not compared — never a pass).',
  ));
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

/** What declaring answered, one line per fact: the declaration and pin, a dry run, an unreadable producer, or the refusal. */
function printAddition(addition: ExternalAddition, dryRun: boolean): void {
  if (addition.refusal) {
    logger.error(addition.refusal);
    return;
  }
  const declaration = JSON.stringify(addition.declaration ?? {});
  if (dryRun) {
    logger.info(`Dry run: would declare ${chalk.cyan(addition.alias)} → ${addition.project ?? addition.alias} as ${declaration} (the producer is checked, and the external pinned, on the real run). Nothing was written.`);
    return;
  }
  logger.success(`Declared ${chalk.cyan(addition.alias)} → ${addition.project ?? addition.alias} as ${declaration} in .wai/project.yaml.`);
  if (addition.pin) printPins([addition.pin]);
  if (addition.unreachable) logger.warn(`Declared but not pinned: ${addition.unreachable}.`);
}

/** The worst health over every external, as the exit code: 1 incompatible, 2 not compared, 0 otherwise. */
export function statusExitCode(statuses: ExternalStatus[]): number {
  const health = statuses.map(relationHealth);
  if (health.includes('incompatible')) return 1;
  if (health.includes('unavailable')) return 2;
  return 0;
}

/** cli_runner.runExternals — `wairon externals <action> [alias…]`. */
export async function runExternals(action: string, aliases: string[], options: ExternalsOptions = {}): Promise<void> {
  assertProjectInitialized();
  // Step 1: route on the action.
  switch (action) {
    case 'add': {
      // Step 2: the alias, then the source when given; the options fill the rest.
      const [alias, source] = aliases;
      if (alias === undefined) throw new WaironError('`wairon externals add` needs an alias: `wairon externals add <alias> [<source>]`, the source being `../sibling`, `hosted:<id>`, `<git url>` or `<git url>#<commit>`.');
      const addition = declareExternal({
        alias,
        ...(source !== undefined ? { source } : {}),
        ...(options.project !== undefined ? { project: options.project } : {}),
        ...(options.ref !== undefined ? { ref: options.ref } : {}),
        ...(options.dir !== undefined ? { dir: options.dir } : {}),
        ...(options.use !== undefined ? { use: options.use } : {}),
        ...(options.description !== undefined ? { description: options.description } : {}),
        ...(options.pin === false ? { pin: false } : {}),
        ...(options.dryRun ? { dryRun: true } : {}),
      });
      // Step 3: the answer; a refusal exits 1.
      if (options.json) printJson(addition);
      else printAddition(addition, options.dryRun === true);
      if (addition.refusal) process.exitCode = 1;
      return;
    }
    case 'pin': {
      // Steps 4-5: an alias that could not be pinned keeps its previous pin, and the command exits 1.
      const pins = pinExternals(aliases.length ? aliases : undefined);
      if (options.json) printJson(pins);
      else printPins(pins);
      if (pins.some((p) => p.outcome === 'unresolved' || p.outcome === 'unreachable')) process.exitCode = 1;
      return;
    }
    case 'status': {
      // Steps 6-7: the live gate — fetching git producers — exiting with the worst health.
      const statuses = getExternalsStatus();
      if (options.json) printJson(statuses);
      else printStatuses(statuses);
      const code = statusExitCode(statuses);
      if (code !== 0) process.exitCode = code;
      return;
    }
    case 'list': {
      // Steps 8-9.
      const rows = listExternals();
      if (options.json) printJson(rows);
      else printListings(rows);
      return;
    }
    default:
      // Step 10.
      throw new UnknownExternalsActionError(action);
  }
}
