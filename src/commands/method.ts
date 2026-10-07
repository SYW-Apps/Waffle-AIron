import { logger } from '../utils/logger.js';
import { ProjectNotInitializedError } from '../utils/errors.js';
import { projectConfigExists, renameParam } from './adapters/core.js';

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
