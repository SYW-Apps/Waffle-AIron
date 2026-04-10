import * as path from 'path';
import { writeFile } from '../utils/fs.js';
import { Exporter, ExportContext, ExportResult } from './base.js';

// ---------------------------------------------------------------------------
// Gemini CLI exporter
//
// Generates agent definition files for Gemini CLI's agent system.
// Output format: Markdown with YAML front-matter.
//
// Generated file path: <outputDir>/<agent-id>.md
// ---------------------------------------------------------------------------

export class GeminiExporter implements Exporter {
  readonly targetType = 'gemini';

  outputPath(ctx: Omit<ExportContext, 'renderedInstructions'>): string {
    const { agent, target, projectRoot } = ctx;
    const outputDir = 'outputDir' in target ? target.outputDir : '.gemini/agents';
    return path.resolve(projectRoot, outputDir, `${agent.id}.md`);
  }

  export(ctx: ExportContext): ExportResult {
    const { agent, renderedInstructions } = ctx;
    const filePath = this.outputPath(ctx);

    const content = [
      '---',
      `name: ${agent.name}`,
      `description: ${agent.description}`,
      `id: ${agent.id}`,
      ...(agent.tags.length > 0 ? [`tags: [${agent.tags.join(', ')}]`] : []),
      '---',
      '',
      renderedInstructions,
      '',
    ].join('\n');

    writeFile(filePath, content);
    return { outputPath: filePath, content };
  }
}
