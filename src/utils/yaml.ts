import * as yaml from 'js-yaml';
import { readFileOrNull, writeFile } from './fs.js';

// ---------------------------------------------------------------------------
// YAML read/write helpers
// ---------------------------------------------------------------------------

/**
 * Parse a YAML string into an unknown value.
 * Throws a descriptive error on parse failure.
 */
export function parseYaml(content: string, sourcePath?: string): unknown {
  try {
    return yaml.load(content);
  } catch (err) {
    const loc = sourcePath ? ` (${sourcePath})` : '';
    throw new Error(`Failed to parse YAML${loc}: ${String(err)}`);
  }
}

/**
 * Serialize a value to a YAML string.
 */
export function serializeYaml(value: unknown): string {
  return yaml.dump(value, {
    indent: 2,
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
  });
}

/**
 * Read and parse a YAML file.
 * Returns null if the file does not exist.
 */
export function readYamlFile(filePath: string): unknown {
  const content = readFileOrNull(filePath);
  if (content === null) return null;
  return parseYaml(content, filePath);
}

/**
 * Serialize and write a value to a YAML file.
 */
export function writeYamlFile(filePath: string, value: unknown): void {
  writeFile(filePath, serializeYaml(value));
}

/**
 * Read and parse a JSON file.
 * Returns null if the file does not exist.
 */
export function readJsonFile(filePath: string): unknown {
  const content = readFileOrNull(filePath);
  if (content === null) return null;
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to parse JSON (${filePath}): ${String(err)}`);
  }
}

/**
 * Serialize and write a value to a JSON file (pretty-printed).
 */
export function writeJsonFile(filePath: string, value: unknown): void {
  writeFile(filePath, JSON.stringify(value, null, 2) + '\n');
}
