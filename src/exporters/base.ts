import { AgentRecord } from '../models/agent.js';
import { TargetConfig } from '../models/project.js';
import { Template } from '../models/template.js';

// ---------------------------------------------------------------------------
// Exporter abstraction
//
// An Exporter takes an AgentRecord + its rendered template and produces a
// file at a target path. The separation of concerns is:
//
//   core/  — knows about agents, templates, registry, topology rules
//   exporters/ — knows about tool-specific file formats and output paths
//
// This means adding a new output target (e.g., Cursor) requires only adding
// a new Exporter implementation, with zero changes to core logic.
// ---------------------------------------------------------------------------

export interface ExportContext {
  agent: AgentRecord;
  template: Template;
  /** Rendered instruction body (template vars already substituted) */
  renderedInstructions: string;
  /** Absolute path to the project root */
  projectRoot: string;
  target: TargetConfig;
}

export interface ExportResult {
  /** Absolute path where the file was written */
  outputPath: string;
  /** The content that was written */
  content: string;
  /** True if the file already existed with identical content and was not rewritten */
  unchanged: boolean;
}

export interface Exporter {
  /**
   * Returns the target type(s) this exporter handles.
   * For built-ins: 'claude' | 'gemini'.
   * For custom exporters, this returns 'custom'.
   */
  readonly targetType: string;

  /**
   * Export an agent definition to the target location.
   * Must be idempotent — calling multiple times produces the same output.
   */
  export(ctx: ExportContext): ExportResult;

  /**
   * Return the output file path for an agent without writing it.
   * Useful for validation and dry-run modes.
   */
  outputPath(ctx: Omit<ExportContext, 'renderedInstructions'>): string;
}
