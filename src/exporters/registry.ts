import { Exporter } from './base.js';
import { ClaudeExporter } from './claude.js';
import { CustomExporter } from './custom.js';
import { GeminiExporter } from './gemini.js';
import { TargetConfig } from '../models/project.js';
import { WaironError } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Exporter registry
//
// Maps target types to their Exporter implementations.
// To add a new built-in target, register it here.
// ---------------------------------------------------------------------------

const EXPORTERS = new Map<string, Exporter>([
  ['claude', new ClaudeExporter()],
  ['gemini', new GeminiExporter()],
  ['agy', new GeminiExporter()],
  ['cursor', new ClaudeExporter()],
  ['copilot', new ClaudeExporter()],
  ['codex', new ClaudeExporter()],
  ['custom', new CustomExporter()],
]);

/**
 * Return the exporter for a given target config.
 */
export function getExporter(target: TargetConfig): Exporter {
  const type = typeof target === 'string' ? target : target.type;
  const exporter = EXPORTERS.get(type);
  if (!exporter) {
    throw new WaironError(`No exporter registered for target type: "${type}"`);
  }
  return exporter;
}

/**
 * Register a custom exporter (for programmatic use / future plugin support).
 */
export function registerExporter(type: string, exporter: Exporter): void {
  EXPORTERS.set(type, exporter);
}
