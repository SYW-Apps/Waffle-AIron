import * as path from 'path';
import { writeFile } from '../utils/fs.js';
import { Exporter, ExportContext, ExportResult } from './base.js';

// ---------------------------------------------------------------------------
// Claude Code exporter
//
// Generates agent definition files for Claude Code's sub-agent system.
// Output format: Markdown with YAML front-matter.
//
// Reference: https://docs.anthropic.com/en/docs/claude-code/agents
//
// Generated file path: <outputDir>/<agent-id>.md
// ---------------------------------------------------------------------------

export class ClaudeExporter implements Exporter {
  readonly targetType = 'claude';

  outputPath(ctx: Omit<ExportContext, 'renderedInstructions'>): string {
    const { agent, target, projectRoot } = ctx;
    const outputDir = 'outputDir' in target ? target.outputDir : '.claude/agents';
    return path.resolve(projectRoot, outputDir, `${agent.id}.md`);
  }

  export(ctx: ExportContext): ExportResult {
    const { agent, renderedInstructions } = ctx;
    const filePath = this.outputPath(ctx);

    const content = [
      '---',
      `name: ${agent.name}`,
      `description: ${agent.description}`,
      ...(agent.ownedPaths.length > 0
        ? ['tools:', ...agent.ownedPaths.map((p) => `  - ${p}`)]
        : []),
      '---',
      '',
      renderedInstructions,
      '',
    ].join('\n');

    writeFile(filePath, content);
    return { outputPath: filePath, content };
  }
}
