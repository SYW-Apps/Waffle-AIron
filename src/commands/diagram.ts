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
import { buildCanvasModel, renderCanvasHtml } from '../core/canvas.js';
import { generateDrawioXml, generateExcalidrawScene } from '../core/diagram-export.js';
import { validateSddTree } from '../core/validation.js';
import { loadProjectConfig } from '../config/loader.js';
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

function collectIssues() {
  try {
    const config = loadProjectConfig();
    return validateSddTree({ rules: config.rules, projectType: config.projectType }).issues;
  } catch {
    return validateSddTree().issues;
  }
}

function writeCanvas(dest: string): void {
  const model = buildCanvasModel(collectIssues());
  ensureDir(path.dirname(path.resolve(dest)));
  fs.writeFileSync(dest, renderCanvasHtml(model), 'utf-8');
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

  if (options.canvas && !options.all) {
    const dest = options.out ?? path.join(AI_PATHS.docsDir(), 'diagrams', 'canvas.html');
    writeCanvas(dest);
    logger.success(`Interactive canvas written to ${dest}`);
    logger.info('Open it in a browser — fully self-contained (works offline).');
    return;
  }

  if (options.drawio && !options.all) {
    const dest = options.out ?? path.join(AI_PATHS.docsDir(), 'diagrams', 'architecture.drawio');
    ensureDir(path.dirname(path.resolve(dest)));
    fs.writeFileSync(dest, generateDrawioXml(buildCanvasModel()), 'utf-8');
    logger.success(`draw.io diagram written to ${dest}`);
    logger.info('Open with draw.io / diagrams.net (or import into tools that accept the format).');
    return;
  }

  if (options.excalidraw && !options.all) {
    const dest = options.out ?? path.join(AI_PATHS.docsDir(), 'diagrams', 'architecture.excalidraw');
    ensureDir(path.dirname(path.resolve(dest)));
    fs.writeFileSync(dest, generateExcalidrawScene(buildCanvasModel()), 'utf-8');
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
    writeCanvas(dest);
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
      const dest = path.join(outDir, file.relPath);
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, toMarkdown(file), 'utf-8');
    }
    writeCanvas(path.join(outDir, 'canvas.html'));
    const exportModel = buildCanvasModel();
    fs.writeFileSync(path.join(outDir, 'architecture.drawio'), generateDrawioXml(exportModel), 'utf-8');
    fs.writeFileSync(path.join(outDir, 'architecture.excalidraw'), generateExcalidrawScene(exportModel), 'utf-8');
    const graph = loadSpecGraph();
    const indexPath = path.join(outDir, 'README.md');
    fs.writeFileSync(indexPath, diagramSetIndex(files, graph.systemName), 'utf-8');
    logger.success(`Generated ${files.length} diagram(s) + interactive canvas.html + index into ${outDir}`);
    for (const file of files.slice(0, 12)) {
      logger.info(`  ${file.relPath}`);
    }
    if (files.length > 12) logger.info(`  … and ${files.length - 12} more`);
    return;
  }

  // Mermaid — like every other format, written to a file.
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
    mermaid = generateComponentDiagram();
    title = 'Component architecture';
    defaultDest = path.join(diagramsDir, 'system.md');
  }

  const dest = options.out ?? defaultDest;
  ensureDir(path.dirname(path.resolve(dest)));
  const content = dest.endsWith('.mmd')
    ? `${mermaid}\n`
    : toMarkdown({ relPath: dest, title, mermaid });
  fs.writeFileSync(dest, content, 'utf-8');
  logger.success(`Mermaid diagram written to ${dest}`);
  logger.info('Renders on GitHub/IDE previews; use a .mmd --out path for raw Mermaid.');
}
