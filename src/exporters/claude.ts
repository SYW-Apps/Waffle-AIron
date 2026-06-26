import * as path from 'path';
import { writeFileIfChanged } from '../utils/fs.js';
import { Exporter, ExportContext, ExportResult } from './base.js';

// ---------------------------------------------------------------------------
// Claude Code exporter
//
// Generates agent definition files for Claude Code's sub-agent system.
// Output format: Markdown with YAML front-matter.
//
// Front-matter fields:
//   name        — display name shown in the Claude UI
//   description — used by Claude to decide when to invoke this sub-agent;
//                 keep it concise and action-oriented
//
// Note: the `tools:` front-matter field controls which Claude built-in tools
// (Bash, Read, Write, Edit, …) the sub-agent may use. wairon does not
// manage that list — it belongs in the agent template body. ownedPaths is a
// wairon topology concept and is embedded in the rendered instructions.
//
// Reference: https://docs.anthropic.com/en/docs/claude-code/sub-agents
//
// Generated file path: <outputDir>/<agent-id>.md
// ---------------------------------------------------------------------------

export class ClaudeExporter implements Exporter {
  readonly targetType = 'claude';

  outputPath(ctx: Omit<ExportContext, 'renderedInstructions'>): string {
    const { agent, target, projectRoot } = ctx;
    const outputDir = 'outputDir' in target ? target.outputDir : '.claude/agents';
    return path.resolve(projectRoot, outputDir, `${agent.id.replace(/::/g, '--')}.md`);
  }

  export(ctx: ExportContext): ExportResult {
    const { agent, renderedInstructions } = ctx;
    const filePath = this.outputPath(ctx);

    // Escape any characters in description that would break inline YAML
    const safeDescription = agent.description.includes(':') || agent.description.includes('#')
      ? `"${agent.description.replace(/"/g, '\\"')}"`
      : agent.description;

    const content = [
      '---',
      `name: ${agent.name}`,
      `description: ${safeDescription}`,
      '---',
      '',
      renderedInstructions,
      '',
    ].join('\n');

    const changed = writeFileIfChanged(filePath, content);
    return { outputPath: filePath, content, unchanged: !changed };
  }
}
