import * as path from 'path';
import { writeFile } from '../utils/fs.js';
import { Exporter, ExportContext, ExportResult } from './base.js';

// ---------------------------------------------------------------------------
// Custom path exporter
//
// Used when the target is a user-defined { type: 'custom', outputDir: '...' }.
// Generates the same Markdown+frontmatter format as the Claude exporter, but
// at the user-specified path. Users can override this by providing their own
// exporter via a plugin system (future work).
// ---------------------------------------------------------------------------

export class CustomExporter implements Exporter {
  readonly targetType = 'custom';

  outputPath(ctx: Omit<ExportContext, 'renderedInstructions'>): string {
    const { agent, target, projectRoot } = ctx;
    if (!('outputDir' in target)) {
      throw new Error('CustomExporter requires target.outputDir');
    }
    return path.resolve(projectRoot, target.outputDir, `${agent.id}.md`);
  }

  export(ctx: ExportContext): ExportResult {
    const { agent, target, renderedInstructions } = ctx;
    const label = 'label' in target ? target.label : 'Custom';
    const filePath = this.outputPath(ctx);

    const content = [
      '---',
      `name: ${agent.name}`,
      `description: ${agent.description}`,
      `id: ${agent.id}`,
      `target: ${label}`,
      '---',
      '',
      renderedInstructions,
      '',
    ].join('\n');

    writeFile(filePath, content);
    return { outputPath: filePath, content };
  }
}
