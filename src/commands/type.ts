import { logger } from '../utils/logger.js';
import { ProjectNotInitializedError } from '../utils/errors.js';
import { projectConfigExists, renameField } from './adapters/core.js';

// ---------------------------------------------------------------------------
// `wairon type …` — edits to one type of the bound project's spec tree that a
// hand edit would get wrong: a renamed field must take its references along
// and keep a trace a consumer can follow.
// ---------------------------------------------------------------------------

/**
 * icli_runner.runTypeRenameField — `wairon type rename-field <type> <field>
 * <new-name>`: rename a field of a type and respell every reference to it, the
 * old name kept in the field's rename trace (previousNames, `formerly` in the
 * design export). A refusal is a WaironError: the CLI prints its reason and
 * exits non-zero, having written nothing.
 */
export async function runTypeRenameField(typeId: string, field: string, newName: string): Promise<void> {
  // Step 1: an initialized project.
  if (!projectConfigExists()) throw new ProjectNotInitializedError();
  // Step 2: the rename.
  const result = renameField(typeId, field, newName);
  // Step 3: what moved.
  if (result.from === result.to) {
    logger.info(`Field "${result.from}" of type "${result.type}" already has that name — nothing to do.`);
    return;
  }
  logger.success(`Renamed field "${result.from}" of type "${result.type}" to "${result.to}" — "${result.from}" joins its rename trace (previousNames; \`formerly\` in the design export).`);
  if (result.rewritten.length > 0) logger.info(`References respelled in: ${result.rewritten.join(', ')}`);
  logger.info('The approval reads the type as changed until the next `wairon lock`, as with any design edit.');
}
