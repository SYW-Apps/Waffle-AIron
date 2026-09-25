import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, AI_PATHS } from '../config/paths.js';
import { ensureDir } from '../utils/fs.js';
// Every sdd_core call goes through cli_core_adapter, never a core module
// directly — the same boundary `wairon lock` and `wairon status` were taught.
// renderDiagram is the whole of the four-format path; the scoped Mermaid and
// the --all set come through the adapter too.
import { renderDiagram } from './adapters/core.js';
import {
  generateComponentDiagram,
  generateSequenceDiagram,
  generateDiagramSet,
  toMarkdown,
  diagramSetIndex,
  loadSpecGraph,
} from './subsystem.js';
import { WaironError } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// diagram command
//
// Living documentation derived from the spec tree: the interactive canvas,
// Mermaid component diagrams (system-wide or per subsystem), sequence diagrams
// from L5 narratives, and the two editable exchange formats.
//
// This file decides WHAT was asked for and WHERE it lands. It does not build
// artifacts: which encoder runs, and against which model, is sdd_core's, and
// the CLI asks for it by name through the core adapter.
// ---------------------------------------------------------------------------

export interface DiagramOptions {
  subsystem?: string;
  /** "component:method" (or "component.method") for a narrative sequence diagram. */
  sequence?: string;
  depth?: number;
  all?: boolean;
  /** Emit the interactive self-contained HTML canvas instead of Mermaid. */
  canvas?: boolean;
  /** Emit an editable draw.io (diagrams.net) file. */
  drawio?: boolean;
  /** Emit an editable Excalidraw scene file. */
  excalidraw?: boolean;
  /** Friendly alias: mermaid | canvas | drawio | excalidraw (same as the dedicated flags). */
  format?: string;
  /** Output file (or directory with --all). Default with --all: .wai/docs/diagrams */
  out?: string;
}

const FORMATS = ['mermaid', 'canvas', 'drawio', 'excalidraw'] as const;

/** Map --format onto the dedicated flags so both spellings work identically. */
function applyFormat(options: DiagramOptions): DiagramOptions {
  if (!options.format) return options;
  const fmt = options.format.toLowerCase().replace(/[^a-z]/g, ''); // "draw.io" → "drawio"
  if (!(FORMATS as readonly string[]).includes(fmt)) {
    throw new WaironError(`Unknown diagram format "${options.format}". Valid formats: ${FORMATS.join(', ')}.`);
  }
  return {
    ...options,
    canvas: options.canvas || fmt === 'canvas',
    drawio: options.drawio || fmt === 'drawio',
    excalidraw: options.excalidraw || fmt === 'excalidraw',
    // mermaid is the default path — no flag needed
  };
}

/** Write one rendered artifact, creating the directory it lands in. */
function writeArtifact(dest: string, content: string): void {
  ensureDir(path.dirname(path.resolve(dest)));
  fs.writeFileSync(dest, content, 'utf-8');
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

export async function runDiagram(rawOptions: DiagramOptions = {}): Promise<void> {
  assertProjectInitialized();
  const options = applyFormat(rawOptions);

  // Step 1: render the requested format through the core client adapter.
  // Step 2: write the artifact where it was asked for and say where it landed.
  if (options.canvas && !options.all) {
    const dest = options.out ?? path.join(AI_PATHS.docsDir(), 'diagrams', 'canvas.html');
    writeArtifact(dest, renderDiagram('canvas'));
    logger.success(`Interactive canvas written to ${dest}`);
    logger.info('Open it in a browser — fully self-contained (works offline).');
    return;
  }

  if (options.drawio && !options.all) {
    const dest = options.out ?? path.join(AI_PATHS.docsDir(), 'diagrams', 'architecture.drawio');
    writeArtifact(dest, renderDiagram('drawio'));
    logger.success(`draw.io diagram written to ${dest}`);
    logger.info('Open with draw.io / diagrams.net (or import into tools that accept the format).');
    return;
  }

  if (options.excalidraw && !options.all) {
    const dest = options.out ?? path.join(AI_PATHS.docsDir(), 'diagrams', 'architecture.excalidraw');
    writeArtifact(dest, renderDiagram('excalidraw'));
    logger.success(`Excalidraw scene written to ${dest}`);
    logger.info('Open with excalidraw.com or the VS Code extension.');
    return;
  }

  // Bare `wairon diagram` (no format, no scope) → the interactive canvas.
  const wantsMermaid = options.format?.toLowerCase().startsWith('mermaid')
    || !!options.subsystem
    || !!options.sequence;
  if (!options.all && !options.sequence && !wantsMermaid) {
    const dest = options.out ?? path.join(AI_PATHS.docsDir(), 'diagrams', 'canvas.html');
    writeArtifact(dest, renderDiagram('canvas'));
    logger.success(`Interactive canvas written to ${dest}`);
    logger.info('Open it in a browser — fully self-contained (works offline). Other formats: --format mermaid|drawio|excalidraw.');
    return;
  }

  if (options.all) {
    const outDir = options.out ?? path.join(AI_PATHS.docsDir(), 'diagrams');
    const files = generateDiagramSet();
    if (files.length === 0) {
      logger.warn('No diagrams to generate — the spec tree has no components yet.');
      return;
    }
    for (const file of files) {
      writeArtifact(path.join(outDir, file.relPath), toMarkdown(file));
    }
    writeArtifact(path.join(outDir, 'canvas.html'), renderDiagram('canvas'));
    writeArtifact(path.join(outDir, 'architecture.drawio'), renderDiagram('drawio'));
    writeArtifact(path.join(outDir, 'architecture.excalidraw'), renderDiagram('excalidraw'));
    const graph = loadSpecGraph();
    const indexPath = path.join(outDir, 'README.md');
    writeArtifact(indexPath, diagramSetIndex(files, graph.systemName));
    logger.success(`Generated ${files.length} diagram(s) + interactive canvas.html + index into ${outDir}`);
    for (const file of files.slice(0, 12)) {
      logger.info(`  ${file.relPath}`);
    }
    if (files.length > 12) logger.info(`  … and ${files.length - 12} more`);
    return;
  }

  // Mermaid — like every other format, written to a file. The system-wide
  // diagram IS renderDiagram('mermaid'); a scope narrows it to one subsystem or
  // to one narrative, which no format string can carry.
  let mermaid: string;
  let title: string;
  let defaultDest: string;
  const diagramsDir = path.join(AI_PATHS.docsDir(), 'diagrams');
  if (options.sequence) {
    const { component, method } = parseSequenceRef(options.sequence);
    mermaid = generateSequenceDiagram(component, method, { depth: options.depth });
    title = `${component}.${method} — narrative sequence`;
    defaultDest = path.join(diagramsDir, 'sequences', `${component.replace(/::/g, '--')}.${method}.md`);
  } else if (options.subsystem) {
    mermaid = generateComponentDiagram({ subsystem: options.subsystem });
    title = `${options.subsystem} — components`;
    defaultDest = path.join(diagramsDir, 'subsystems', `${options.subsystem.replace(/::/g, '--')}.md`);
  } else {
    mermaid = renderDiagram('mermaid');
    title = 'Component architecture';
    defaultDest = path.join(diagramsDir, 'system.md');
  }

  const dest = options.out ?? defaultDest;
  const content = dest.endsWith('.mmd')
    ? `${mermaid}\n`
    : toMarkdown({ relPath: dest, title, mermaid });
  writeArtifact(dest, content);
  logger.success(`Mermaid diagram written to ${dest}`);
  logger.info('Renders on GitHub/IDE previews; use a .mmd --out path for raw Mermaid.');
}
