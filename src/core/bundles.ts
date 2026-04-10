import * as path from 'path';
import { listFiles, pathExists } from '../utils/fs.js';
import { parseYaml, readYamlFile } from '../utils/yaml.js';
import { BundleNotFoundError } from '../utils/errors.js';
import { Bundle, BundleSchema } from '../models/bundle.js';
import { AI_PATHS } from '../config/loader.js';

// ---------------------------------------------------------------------------
// Bundle loader
//
// Resolution order (same as templates):
//   1. Project-local: .ai/bundles/<id>.yaml
//   2. Built-in:      <package>/src/bundles/<id>.yaml
// ---------------------------------------------------------------------------

function builtinBundlesDir(): string {
  return path.resolve(__dirname, '..', 'bundles');
}

/**
 * Load a single bundle by id.
 */
export function loadBundle(id: string): Bundle {
  const localPath = path.join(AI_PATHS.bundlesDir(), `${id}.yaml`);
  if (pathExists(localPath)) {
    const raw = readYamlFile(localPath);
    return BundleSchema.parse(raw);
  }

  const builtinPath = path.join(builtinBundlesDir(), `${id}.yaml`);
  if (pathExists(builtinPath)) {
    const raw = readYamlFile(builtinPath);
    return BundleSchema.parse(raw);
  }

  throw new BundleNotFoundError(id);
}

/**
 * List all available bundle ids (built-in + project-local, deduplicated).
 */
export function listBundleIds(): string[] {
  const seen = new Set<string>();

  for (const file of listFiles(AI_PATHS.bundlesDir(), '.yaml')) {
    seen.add(path.basename(file, '.yaml'));
  }

  for (const file of listFiles(builtinBundlesDir(), '.yaml')) {
    seen.add(path.basename(file, '.yaml'));
  }

  return Array.from(seen).sort();
}

/**
 * Parse a bundle from a raw YAML string (used for testing / one-off loading).
 */
export function parseBundle(yamlContent: string): Bundle {
  return BundleSchema.parse(parseYaml(yamlContent));
}
