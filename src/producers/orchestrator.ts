import {
  readProducerConfig,
  writeProducerConfig,
  clearProducerConfig,
  listProducerConfigs,
} from './config.js';
import { project, projectGraph } from './projection.js';
import * as notion from './notion.js';
import * as miro from './miro.js';
import type { ProducerConfig } from './types.js';

// ---------------------------------------------------------------------------
// Producer Orchestrator (sdd_producers)
// ---------------------------------------------------------------------------

export function configure(target: string, parentPageId: string): void {
  writeProducerConfig({ target, parentPageId });
}

/**
 * Project the bound project and push it to the target, authenticating with the
 * token the CALLER resolved and handed in: this subsystem never asks anyone for
 * a secret by name.
 */
export async function produce(target: string, diagramUrl: string, token: string): Promise<void> {
  const config = readProducerConfig(target);
  if (!config) throw new Error(`Producer "${target}" is not configured for this project.`);
  switch (target) {
    case 'notion':
      await notion.sync(token, project(diagramUrl), config.parentPageId);
      return;
    case 'miro':
      await miro.sync(token, projectGraph(), config.parentPageId);
      return;
    default:
      throw new Error(`Unknown producer target "${target}".`);
  }
}

export function remove(target: string): void {
  clearProducerConfig(target);
}

export function list(): ProducerConfig[] {
  return listProducerConfigs();
}
