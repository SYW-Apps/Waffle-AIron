import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Stub implementations for future commands
//
// These commands are planned but not yet implemented. They exist here so
// the CLI binary can surface helpful "not yet available" messages rather
// than silently failing.
// ---------------------------------------------------------------------------

function notImplemented(commandName: string): void {
  logger.warn(`\`${commandName}\` is not yet implemented.`);
  logger.info('See docs/roadmap.md for the planned implementation phases.');
}

export async function runAnalyze(): Promise<void> {
  notImplemented('wairon analyze');
  logger.info('Planned: analyze a repository and suggest agent topology.');
}

export async function runSuggestTopology(): Promise<void> {
  notImplemented('wairon suggest-topology');
  logger.info('Planned: suggest new agents or restructure based on ownership gaps.');
}

export async function runCreateAgent(): Promise<void> {
  notImplemented('wairon create-agent');
  logger.info('Planned: interactively create a new agent from a template.');
}

export async function runCreateBundle(): Promise<void> {
  notImplemented('wairon create-bundle');
  logger.info('Planned: scaffold multiple agents from a bundle definition.');
}

export async function runSplit(): Promise<void> {
  notImplemented('wairon split');
  logger.info('Planned: split an agent into two or more focused agents.');
}

export async function runMerge(): Promise<void> {
  notImplemented('wairon merge');
  logger.info('Planned: merge two agents into one.');
}
