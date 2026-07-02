import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, AI_PATHS } from '../config/loader.js';
import { ensureDir } from '../utils/fs.js';
import {
  generateComponentDiagram,
  generateSequenceDiagram,
  generateDiagramSet,
  toMarkdown,
  diagramSetIndex,
  loadSpecGraph,
} from '../core/diagram.js';
import { WaironError } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// diagram command
//
// Living documentation derived from the spec tree: Mermaid component diagrams
// (system-wide or per subsystem) and sequence diagrams from L5 narratives.
// Stage 1 of the visualization plan — the interactive canvas builds on the
// same graph extraction.
// ---------------------------------------------------------------------------

export interface DiagramOptions {
  subsystem?: string;
  /** "component:method" (or "component.method") for a narrative sequence diagram. */
  sequence?: string;
  depth?: number;
  all?: boolean;
  /** Output file (or directory with --all). Default with --all: .wai/docs/diagrams */
  out?: string;
}

function parseSequenceRef(ref: string): { component: string; method: string } {
  const sep = ref.includes(':') ? ref.lastIndexOf(':') : ref.lastIndexOf('.');
  if (sep <= 0 || sep === ref.length - 1) {
    throw new WaironError(
      `Invalid --sequence reference "${ref}". Use <componentId>:<methodName> (e.g. billing-portal:authorize).`,
    );
  }
  return { component: ref.slice(0, sep), method: ref.slice(sep + 1) };
}

export async function runDiagram(options: DiagramOptions = {}): Promise<void> {
  assertProjectInitialized();

  if (options.all) {
    const outDir = options.out ?? path.join(AI_PATHS.docsDir(), 'diagrams');
    const files = generateDiagramSet();
    if (files.length === 0) {
      logger.warn('No diagrams to generate — the spec tree has no components yet.');
      return;
    }
    for (const file of files) {
      const dest = path.join(outDir, file.relPath);
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, toMarkdown(file), 'utf-8');
    }
    const graph = loadSpecGraph();
    const indexPath = path.join(outDir, 'README.md');
    fs.writeFileSync(indexPath, diagramSetIndex(files, graph.systemName), 'utf-8');
    logger.success(`Generated ${files.length} diagram(s) + index into ${outDir}`);
    for (const file of files.slice(0, 12)) {
      logger.info(`  ${file.relPath}`);
    }
    if (files.length > 12) logger.info(`  … and ${files.length - 12} more`);
    return;
  }

  let mermaid: string;
  let title: string;
  if (options.sequence) {
    const { component, method } = parseSequenceRef(options.sequence);
    mermaid = generateSequenceDiagram(component, method, { depth: options.depth });
    title = `${component}.${method} — narrative sequence`;
  } else {
    mermaid = generateComponentDiagram({ subsystem: options.subsystem });
    title = options.subsystem
      ? `${options.subsystem} — components`
      : 'Component architecture';
  }

  if (options.out) {
    ensureDir(path.dirname(path.resolve(options.out)));
    const isMarkdown = options.out.endsWith('.md');
    const content = isMarkdown
      ? toMarkdown({ relPath: options.out, title, mermaid })
      : `${mermaid}\n`;
    fs.writeFileSync(options.out, content, 'utf-8');
    logger.success(`Diagram written to ${options.out}`);
  } else {
    console.log(mermaid);
  }
}
