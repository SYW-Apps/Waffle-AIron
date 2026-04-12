import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Stub implementations for future commands
// ---------------------------------------------------------------------------

function notImplemented(commandName: string): void {
  logger.warn(`\`${commandName}\` is not yet implemented.`);
  logger.info('See docs/roadmap.md for the planned implementation phases.');
}

export async function runSuggestTopology(): Promise<void> {
  notImplemented('wairon suggest-topology');
  logger.info('Planned: suggest new agents or restructure based on ownership gaps.');
}

export async function runSplit(): Promise<void> {
  notImplemented('wairon split');
  logger.info('Planned: split an agent into two or more focused agents.');
}

export async function runMerge(): Promise<void> {
  notImplemented('wairon merge');
  logger.info('Planned: merge two agents into one.');
}
