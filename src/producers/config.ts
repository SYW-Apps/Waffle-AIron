import { files } from '../io/index.js';
import * as path from 'path';
import { aiDir } from '../utils/fs.js';
import type { ProducerConfig } from './types.js';

// ---------------------------------------------------------------------------
// Producer Config Registry (sdd_producers) — .wai/producers.json for the bound
// project, keyed by target.
// ---------------------------------------------------------------------------

function configPath(): string {
  return aiDir('producers.json');
}

function load(): ProducerConfig[] {
  try {
    return JSON.parse(files.readText(configPath())) as ProducerConfig[];
  } catch {
    return [];
  }
}

function save(configs: ProducerConfig[]): void {
  const p = configPath();
  files.ensureDir(path.dirname(p));
  const tmp = `${p}.tmp`;
  files.writeText(tmp, JSON.stringify(configs, null, 2) + '\n');
  files.rename(tmp, p);
}

export function readProducerConfig(target: string): ProducerConfig | null {
  return load().find((c) => c.target === target) ?? null;
}

export function writeProducerConfig(config: ProducerConfig): void {
  const configs = load().filter((c) => c.target !== config.target);
  configs.push(config);
  save(configs);
}

export function clearProducerConfig(target: string): void {
  save(load().filter((c) => c.target !== target));
}

export function listProducerConfigs(): ProducerConfig[] {
  return load();
}
