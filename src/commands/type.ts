import * as path from 'path';
import { logger } from '../utils/logger.js';
import { ProjectNotInitializedError } from '../utils/errors.js';
import { projectConfigExists, renameField } from './adapters/core.js';
import { listConsumers } from './adapters/surfaces.js';
import { narrowedToUses, type ExternalConsumer } from '../models/index.js';
import { reportBreaks, type RenamePreviewOptions } from './method.js';

// ---------------------------------------------------------------------------
// `wairon type …` — edits to one type of the bound project's spec tree that a
// hand edit would get wrong: a renamed field must take its references along
// and keep a trace a consumer can follow.
// ---------------------------------------------------------------------------

/**
 * icli_runner.runTypeRenameField — `wairon type rename-field <type> <field>
 * <new-name> [--dry-run] [--search <dir...>]`: rename a field of a type and
 * respell every reference to it, the old name kept in the field's rename trace
 * (previousNames, `formerly` in the design export), naming every consumer
 * whose specs reach a public name carrying the field. A refusal is a
 * WaironError: the CLI prints its reason and exits non-zero, having written
 * nothing.
 */
export async function runTypeRenameField(typeId: string, field: string, newName: string, options: RenamePreviewOptions): Promise<void> {
  // Step 1: an initialized project.
  if (!projectConfigExists()) throw new ProjectNotInitializedError();
  // Step 2: the consumers, before anything moves.
  const consumers = listConsumers(options.search?.map((d) => path.resolve(d)));
  // Step 3: the rename, or what it would do.
  const result = renameField(typeId, field, newName, options.dryRun);
  // Step 4: the consumers reaching a public name that carries the field.
  const breaks = consumers.map((c) => narrowedToUses(c, result.publishedIn)).filter((c): c is ExternalConsumer => c !== null);
  // Step 5: what moved, and who breaks.
  if (result.from === result.to) {
    logger.info(`Field "${result.from}" of type "${result.type}" already has that name — nothing to do.`);
    return;
  }
  logger.success(`${result.dryRun ? 'Dry run: renaming' : 'Renamed'} field "${result.from}" of type "${result.type}" to "${result.to}" — "${result.from}" joins its rename trace (previousNames; \`formerly\` in the design export).`);
  if (result.rewritten.length > 0) logger.info(`References ${result.dryRun ? 'it would respell' : 'respelled'} in: ${result.rewritten.join(', ')}`);
  reportBreaks(result.publishedIn.map((u) => u.publicName), breaks, `read "${result.type}"`, options);
  if (result.dryRun) logger.info('Nothing was written.');
  else logger.info('The approval reads the type as changed until the next `wairon lock`, as with any design edit.');
}
