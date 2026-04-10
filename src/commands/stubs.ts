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
  notImplemented('waffagent analyze');
  logger.info('Planned: analyze a repository and suggest agent topology.');
}

export async function runSuggestTopology(): Promise<void> {
  notImplemented('waffagent suggest-topology');
  logger.info('Planned: suggest new agents or restructure based on ownership gaps.');
}

export async function runCreateAgent(): Promise<void> {
  notImplemented('waffagent create-agent');
  logger.info('Planned: interactively create a new agent from a template.');
}

export async function runCreateBundle(): Promise<void> {
  notImplemented('waffagent create-bundle');
  logger.info('Planned: scaffold multiple agents from a bundle definition.');
}

export async function runSplit(): Promise<void> {
  notImplemented('waffagent split');
  logger.info('Planned: split an agent into two or more focused agents.');
}

export async function runMerge(): Promise<void> {
  notImplemented('waffagent merge');
  logger.info('Planned: merge two agents into one.');
}
