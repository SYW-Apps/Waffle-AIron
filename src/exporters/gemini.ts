import * as path from 'path';
import { writeFile } from '../utils/fs.js';
import { Exporter, ExportContext, ExportResult } from './base.js';

// ---------------------------------------------------------------------------
// Gemini CLI exporter
//
// Generates agent definition files for the Gemini CLI agent system.
// Output format: pure YAML (NOT markdown with frontmatter).
//
// Gemini CLI agents live in .gemini/agents/<id>.yaml and are structured as:
//
//   name:          display name
//   description:   one-line summary used by Gemini when selecting this agent
//   system_prompt: |
//     Full instruction body in markdown (multi-line YAML literal block)
//
// Key differences from Claude:
//   - File extension is .yaml, not .md
//   - No markdown frontmatter — the entire file is YAML
//   - Instructions go into the `system_prompt` key as a literal block scalar
//
// Generated file path: <outputDir>/<agent-id>.yaml
// ---------------------------------------------------------------------------

export class GeminiExporter implements Exporter {
  readonly targetType = 'gemini';

  outputPath(ctx: Omit<ExportContext, 'renderedInstructions'>): string {
    const { agent, target, projectRoot } = ctx;
    const outputDir = 'outputDir' in target ? target.outputDir : '.gemini/agents';
    return path.resolve(projectRoot, outputDir, `${agent.id}.yaml`);
  }

  export(ctx: ExportContext): ExportResult {
    const { agent, renderedInstructions } = ctx;
    const filePath = this.outputPath(ctx);

    // Indent every line of the instructions by 2 spaces for the YAML literal block
    const indentedInstructions = renderedInstructions
      .split('\n')
      .map((line) => (line.length > 0 ? `  ${line}` : ''))
      .join('\n');

    const content = [
      `name: ${yamlString(agent.name)}`,
      `description: ${yamlString(agent.description)}`,
      `system_prompt: |`,
      indentedInstructions,
      '',
    ].join('\n');

    writeFile(filePath, content);
    return { outputPath: filePath, content };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a string in double quotes if it contains characters that would
 * need quoting in a YAML flow scalar (colon, hash, special chars).
 */
function yamlString(value: string): string {
  if (/[:#\[\]{},&*!|>'"%@`]/.test(value) || value.startsWith(' ') || value.endsWith(' ')) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}
