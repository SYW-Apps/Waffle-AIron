import * as path from 'path';
import * as yaml from 'js-yaml';
import { readFileOrNull, writeFile } from './fs.js';
import { YamlSyntaxError } from './errors.js';

// ---------------------------------------------------------------------------
// YAML read/write helpers
// ---------------------------------------------------------------------------

/**
 * Parse a YAML string into an unknown value.
 * Throws a YamlSyntaxError on parse failure: one line naming the file (relative
 * to the working directory when it lies under it), the 1-based line and, for
 * an error about one key (a duplicated mapping key), that key.
 */
export function parseYaml(content: string, sourcePath?: string): unknown {
  try {
    return yaml.load(content);
  } catch (err) {
    if (!(err instanceof yaml.YAMLException)) throw err;
    const mark = err.mark as { line?: number } | undefined;
    const line = typeof mark?.line === 'number' ? mark.line + 1 : undefined;
    const reason = err.reason || err.message;
    // The key a key-level error is about: the mapping key the marked line opens.
    const text = line !== undefined ? content.split(/\r?\n/)[line - 1] : undefined;
    const key = /mapping key/.test(reason) && text !== undefined
      ? /^\s*(?:-\s+)?(["']?)([^"':#]+?)\1\s*:/.exec(text)?.[2]
      : undefined;
    throw new YamlSyntaxError(sourcePath === undefined ? undefined : displayPath(sourcePath), line, reason, key);
  }
}

/** A file path as a reader types it: relative to the working directory when under it, else as given. */
function displayPath(file: string): string {
  const rel = path.relative(process.cwd(), file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : file;
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
