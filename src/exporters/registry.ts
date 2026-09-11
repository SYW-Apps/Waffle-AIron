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

// Execution-budget front-matter is emitted ONLY for the claude target. The
// cursor/copilot/codex targets reuse the Claude markdown SHAPE, which is a fair
// approximation for name/description/body — but `model`, `maxTurns`,
// `mcpServers` and `effort` are Claude Code's subagent contract. Emitting them
// elsewhere would add keys those tools ignore rather than constraints they
// honour, and an unhonoured budget is worse than none: it reads as enforced.
// A target opts in here once its own fields are verified.
const EXPORTERS = new Map<string, Exporter>([
  ['claude', new ClaudeExporter({ emitBudget: true })],
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
