import {
  readProducerConfig,
  writeProducerConfig,
  clearProducerConfig,
  listProducerConfigs,
} from './config.js';
import { project } from './projection.js';
import * as notion from './notion.js';
import type { ProducerConfig } from './types.js';

// ---------------------------------------------------------------------------
// Producer Orchestrator (sdd_producers)
// ---------------------------------------------------------------------------

export function configure(target: string, parentPageId: string): void {
  writeProducerConfig({ target, parentPageId });
}

export async function produce(target: string, diagramUrl: string): Promise<void> {
  const config = readProducerConfig(target);
  if (!config) throw new Error(`Producer "${target}" is not configured for this project.`);
  const docTree = project(diagramUrl);
  switch (target) {
    case 'notion':
      await notion.sync(docTree, config.parentPageId);
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
