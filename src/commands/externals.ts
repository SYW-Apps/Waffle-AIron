import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import { assertProjectInitialized } from '../config/paths.js';
import { declareExternal, getExternalsStatus, listConsumers, listExternals, pinExternals, removeExternal, updateExternalUse } from './adapters/surfaces.js';
import { relationHealth, type ExternalAddition, type ExternalConsumer, type ExternalListing, type ExternalPin, type ExternalRemoval, type ExternalStatus, type ExternalUseChange, type RelationHealth } from '../models/index.js';

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
//                (an orphaned pin listed with its problem)
// remove <alias> — take one external and its pin out together
// use <alias>  — add (--add) and remove (--remove) its `use` imports
// consumers    — the family projects in reach that consume this project
// ---------------------------------------------------------------------------

/** An unknown `wairon externals` action. */
export class UnknownExternalsActionError extends WaironError {
  constructor(action: string) {
    super(`Unknown externals action "${action}" (supported: add, pin, status, list, remove, use, consumers).`);
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
  /** add, use, remove: say what would change, write nothing (--dry-run); add still reads the producer. */
  dryRun?: boolean;
  /** use: public names to import bare (--add a,b or --add '*'). */
  add?: string[];
  /** use: names to stop importing (--remove a,b). */
  remove?: string[];
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
    if (s.staleFacts?.length) {
      logger.info(chalk.yellow(`    pinned snapshot is stale: ${s.staleFacts.join(', ')} changed in the producer — re-pin (\`wairon externals pin ${s.alias}\`) to refresh it`));
    }
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
      + 'drifted — the producer moved since the pin while nothing used changed, or the pinned snapshot carries a fact the producer no longer says (an abi, a transport, a role: re-pin to refresh it); ok — every used name matches the pin and the snapshot is current. '
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
    const read = addition.unreachable ? ` — ${addition.unreachable}` : ' — the producer was read and agrees';
    logger.info(`Dry run: would declare ${chalk.cyan(addition.alias)} → ${addition.project ?? addition.alias} as ${declaration}${read}. Nothing was written.`);
    return;
  }
  logger.success(`Declared ${chalk.cyan(addition.alias)} → ${addition.project ?? addition.alias} as ${declaration} in .wai/project.yaml.`);
  if (addition.pin) printPins([addition.pin]);
  if (addition.unreachable) logger.warn(`Declared but not pinned: ${addition.unreachable}.`);
}

/** What removing answered: what went, or the refusal. */
function printRemoval(removal: ExternalRemoval, dryRun: boolean): void {
  if (removal.refusal) {
    logger.error(removal.refusal);
    return;
  }
  const what = [removal.removed || dryRun ? 'its declaration' : '', removal.unpinned ? 'its pin (lock entry and snapshot)' : ''].filter(Boolean).join(' and ') || 'nothing more';
  if (dryRun) logger.info(`Dry run: would remove ${chalk.cyan(removal.alias)} — ${what}. Nothing was written.`);
  else logger.success(`Removed ${chalk.cyan(removal.alias)}: ${what}.`);
}

/** What changing `use` answered: the resulting list and what moved, or the refusal. */
function printUseChange(change: ExternalUseChange, dryRun: boolean): void {
  if (change.refusal) {
    logger.error(change.refusal);
    return;
  }
  const moved = [change.added.length ? `+ ${change.added.join(', ')}` : '', change.removed.length ? `- ${change.removed.join(', ')}` : ''].filter(Boolean).join('; ') || 'no change';
  const list = change.use.length ? change.use.join(', ') : '(none)';
  if (dryRun) logger.info(`Dry run: ${chalk.cyan(change.alias)}.use would be [${list}] (${moved}). Nothing was written.`);
  else if (change.written) logger.success(`${chalk.cyan(change.alias)}.use is now [${list}] (${moved}).`);
  else logger.info(`${chalk.cyan(change.alias)}.use is already [${list}] — nothing to change.`);
}

/** The consumers table: one line per family project that consumes this one. */
function printConsumers(rows: ExternalConsumer[]): void {
  if (!rows.length) logger.info('No project of the family in reach consumes this project.');
  for (const r of rows) {
    logger.info(`${chalk.cyan(r.project)} (${r.section}.${r.alias}): ${r.names.length ? r.names.join(', ') : chalk.gray('declares it, uses no name yet')}`);
  }
  logger.info(chalk.gray('Only the family read from the highest root in reach is listed: a sibling checkout, git or hosted consumer outside it declares its dependency on its own side and is not visible here.'));
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
      // A refusal exits 1; a declaration whose producer could not be read
      // pinned nothing, which a script must not read as done (exit 2).
      if (addition.refusal) process.exitCode = 1;
      else if (addition.unreachable && options.pin !== false) process.exitCode = 2;
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
    case 'remove': {
      // Steps 10-11.
      const [alias] = aliases;
      if (alias === undefined) throw new WaironError('`wairon externals remove` needs an alias: `wairon externals remove <alias> [--dry-run]`.');
      const removal = removeExternal(alias, options.dryRun === true);
      if (options.json) printJson(removal);
      else printRemoval(removal, options.dryRun === true);
      if (removal.refusal) process.exitCode = 1;
      return;
    }
    case 'use': {
      // Steps 12-13.
      const [alias] = aliases;
      if (alias === undefined) throw new WaironError('`wairon externals use` needs an alias: `wairon externals use <alias> --add a,b --remove c [--dry-run]`.');
      const change = updateExternalUse({
        alias,
        ...(options.add !== undefined ? { add: options.add } : {}),
        ...(options.remove !== undefined ? { remove: options.remove } : {}),
        ...(options.dryRun ? { dryRun: true } : {}),
      });
      if (options.json) printJson(change);
      else printUseChange(change, options.dryRun === true);
      if (change.refusal) process.exitCode = 1;
      return;
    }
    case 'consumers': {
      // Steps 14-15.
      const rows = listConsumers();
      if (options.json) printJson(rows);
      else printConsumers(rows);
      return;
    }
    default:
      // Step 16.
      throw new UnknownExternalsActionError(action);
  }
}
