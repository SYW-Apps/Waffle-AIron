import * as fs from 'fs';
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
    return JSON.parse(fs.readFileSync(configPath(), 'utf8')) as ProducerConfig[];
  } catch {
    return [];
  }
}

function save(configs: ProducerConfig[]): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(configs, null, 2) + '\n');
  fs.renameSync(tmp, p);
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
