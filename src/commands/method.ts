import { logger } from '../utils/logger.js';
import { ProjectNotInitializedError } from '../utils/errors.js';
import chalk from 'chalk';
import * as path from 'path';
import { projectConfigExists, renameMethod, renameParam } from './adapters/core.js';
import { listConsumers } from './adapters/surfaces.js';
import { consumerReaches } from '../models/index.js';

// ---------------------------------------------------------------------------
// `wairon method …` — edits to one contract method of the bound project's spec
// tree that a hand edit would get wrong: a renamed parameter must keep a trace a
// generator and a consumer can follow, and its HTTP path placeholder must move
// with it.
// ---------------------------------------------------------------------------

/**
 * icli_runner.runMethodRenameParam — `wairon method rename-param <component>
 * <method> <param> <new-name>`: rename a parameter of a contract method, the
 * old name kept in the parameter's rename trace (previousNames, `formerly` in
 * the design export). A refusal is a WaironError: the CLI prints its reason
 * and exits non-zero, having written nothing.
 */
/** The options `wairon method rename` reads (method_rename_options). */
export interface MethodRenameOptions {
  /** --dry-run: print what the rename would move, retarget and break, and write nothing. */
  dryRun?: boolean;
  /** --search <dir...>: folders to scan for consumer checkouts outside the family. */
  search?: string[];
  /** --no-pin-symbol sets it false: an implementation that declares no symbol is not pinned to the old name. */
  pinSymbol?: boolean;
}

/**
 * icli_runner.runMethodRename — `wairon method rename <component> <method>
 * <new-name> [--dry-run] [--search <dir...>] [--no-pin-symbol]`: rename a
 * contract method and retarget every reference to it, the old name kept in its
 * rename trace, naming every consumer whose specs call it through an export
 * publishing it — the projects the rename breaks. A refusal is a WaironError:
 * the CLI prints its reason and exits non-zero, having written nothing.
 */
export async function runMethodRename(componentId: string, methodName: string, newName: string, options: MethodRenameOptions): Promise<void> {
  // Step 1: an initialized project.
  if (!projectConfigExists()) throw new ProjectNotInitializedError();
  // Step 2: the consumers, before anything moves.
  const consumers = listConsumers(options.search?.map((d) => path.resolve(d)));
  // Step 3: the rename, or what it would do.
  const result = renameMethod(componentId, methodName, newName, options.pinSymbol, options.dryRun);
  // Step 4: the consumers it breaks.
  const breaks = result.publishedIn.length > 0 ? consumers.filter((c) => consumerReaches(c, result.publishedIn, methodName)) : [];
  // Step 5: what moved, and who breaks.
  const would = result.dryRun ? 'would move' : 'moved';
  logger.success(`${result.dryRun ? 'Dry run: renaming' : 'Renamed'} "${result.component}.${result.from}" to "${result.to}" — ${would} in ${result.renamed.join(', ')}; "${result.from}" joins its rename trace (previousNames; \`formerly\` in the design export).`);
  if (result.rewritten.length > 0) logger.info(`References ${result.dryRun ? 'it would retarget' : 'retargeted'}: ${result.rewritten.join(', ')}.`);
  if (result.mentions.length > 0) logger.info(`Left alone (prose or a gRPC wire method still names "${result.from}"): ${result.mentions.join(', ')}.`);
  if (result.pinnedSymbol) logger.info(`symbol ${result.dryRun ? 'would be kept' : 'kept'} at "${result.pinnedSymbol}" so existing code stays linked — \`--no-pin-symbol\` when the code is not written yet.`);
  if (result.publishedIn.length > 0) {
    logger.info(`Published as: ${result.publishedIn.join(', ')} — a consumer of these sees a member renamed.`);
    if (breaks.length > 0) {
      logger.warn(`${breaks.length} consumer(s) call "${result.from}" and break until they follow the rename:`);
      for (const c of breaks) logger.warn(`  ${c.project} (${c.section}.${c.alias})${c.found === 'search' ? ` [${c.directory}]` : ''}`);
    } else {
      logger.info(chalk.gray(`No consumer in reach calls it${options.search?.length ? ' (the searched folders included)' : ' — a sibling checkout is found with --search <dir>'}.`));
    }
  }
  if (result.dryRun) logger.info('Nothing was written.');
  else logger.info('The approval reads the contract as changed until the next `wairon lock`, as with any design edit.');
}

export async function runMethodRenameParam(componentId: string, methodName: string, param: string, newName: string): Promise<void> {
  // Step 1: an initialized project.
  if (!projectConfigExists()) throw new ProjectNotInitializedError();
  // Step 2: the rename.
  const result = renameParam(componentId, methodName, param, newName);
  // Step 3: what moved.
  if (result.from === result.to) {
    logger.info(`Parameter "${result.from}" of "${result.component}.${result.method}" already has that name — nothing to do.`);
    return;
  }
  logger.success(`Renamed parameter "${result.from}" of "${result.component}.${result.method}" to "${result.to}" in ${result.movedIn.join(', ')} — "${result.from}" joins its rename trace (previousNames; \`formerly\` in the design export).`);
  if (result.rewritten.length > 0) logger.info(`Endpoint path placeholders respelled: ${result.rewritten.join('; ')} (the URL a caller sends is unchanged).`);
  logger.info('The approval reads the contract as changed until the next `wairon lock`, as with any design edit.');
}
