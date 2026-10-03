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
// cli_validator_adapter: the family's relation health the canvas colours its
// consumption edges by.
import { familyRelations } from './validate.js';
import {
  generateComponentDiagram,
  generateSequenceDiagram,
  generateDiagramSet,
  toMarkdown,
  diagramSetIndex,
  loadSpecGraph,
} from './subsystem.js';
import { WaironError } from '../utils/errors.js';
import type { ProjectRelations } from '../models/index.js';

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
  /**
   * Compare each consumption relation of the family with its live producer and
   * colour the canvas's edges by it. On unless `--no-health` sets it false; then
   * every consumption edge is drawn neutral, labelled not checked. Only the
   * canvas carries health.
   */
  health?: boolean;
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

/**
 * Steps 1-2 of runDiagram: should the canvas carry relation health, and if so
 * the family's relations compared with their live producers — each project's
 * externals status at its own root, within a plain run's reach (the family
 * root); what cannot be compared is unavailable, never a pass. Undefined with
 * `--no-health`, so the canvas says health was not checked.
 */
function canvasRelations(options: DiagramOptions): ProjectRelations[] | undefined {
  if (options.health === false) return undefined;
  return familyRelations();
}

export async function runDiagram(options: DiagramOptions = {}): Promise<void> {
  assertProjectInitialized();
  const formatted = applyFormat(options);

  // Step 1: render the requested format through the core client adapter.
  // Step 2: write the artifact where it was asked for and say where it landed.
  if (formatted.canvas && !formatted.all) {
    const dest = formatted.out ?? path.join(AI_PATHS.docsDir(), 'diagrams', 'canvas.html');
    writeArtifact(dest, renderDiagram('canvas', canvasRelations(formatted)));
    logger.success(`Interactive canvas written to ${dest}`);
    logger.info('Open it in a browser — fully self-contained (works offline).');
    return;
  }

  if (formatted.drawio && !formatted.all) {
    const dest = formatted.out ?? path.join(AI_PATHS.docsDir(), 'diagrams', 'architecture.drawio');
    writeArtifact(dest, renderDiagram('drawio'));
    logger.success(`draw.io diagram written to ${dest}`);
    logger.info('Open with draw.io / diagrams.net (or import into tools that accept the format).');
    return;
  }

  if (formatted.excalidraw && !formatted.all) {
    const dest = formatted.out ?? path.join(AI_PATHS.docsDir(), 'diagrams', 'architecture.excalidraw');
    writeArtifact(dest, renderDiagram('excalidraw'));
    logger.success(`Excalidraw scene written to ${dest}`);
    logger.info('Open with excalidraw.com or the VS Code extension.');
    return;
  }

  // Bare `wairon diagram` (no format, no scope) → the interactive canvas.
  const wantsMermaid = formatted.format?.toLowerCase().startsWith('mermaid')
    || !!formatted.subsystem
    || !!formatted.sequence;
  if (!formatted.all && !formatted.sequence && !wantsMermaid) {
    const dest = formatted.out ?? path.join(AI_PATHS.docsDir(), 'diagrams', 'canvas.html');
    writeArtifact(dest, renderDiagram('canvas', canvasRelations(formatted)));
    logger.success(`Interactive canvas written to ${dest}`);
    logger.info('Open it in a browser — fully self-contained (works offline). Other formats: --format mermaid|drawio|excalidraw.');
    return;
  }

  if (formatted.all) {
    const outDir = formatted.out ?? path.join(AI_PATHS.docsDir(), 'diagrams');
    const files = generateDiagramSet();
    if (files.length === 0) {
      logger.warn('No diagrams to generate — the spec tree has no components yet.');
      return;
    }
    for (const file of files) {
      writeArtifact(path.join(outDir, file.relPath), toMarkdown(file));
    }
    writeArtifact(path.join(outDir, 'canvas.html'), renderDiagram('canvas', canvasRelations(formatted)));
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
  if (formatted.sequence) {
    const { component, method } = parseSequenceRef(formatted.sequence);
    mermaid = generateSequenceDiagram(component, method, { depth: formatted.depth });
    title = `${component}.${method} — narrative sequence`;
    defaultDest = path.join(diagramsDir, 'sequences', `${component.replace(/::/g, '--')}.${method}.md`);
  } else if (formatted.subsystem) {
    mermaid = generateComponentDiagram({ subsystem: formatted.subsystem });
    title = `${formatted.subsystem} — components`;
    defaultDest = path.join(diagramsDir, 'subsystems', `${formatted.subsystem.replace(/::/g, '--')}.md`);
  } else {
    mermaid = renderDiagram('mermaid');
    title = 'Component architecture';
    defaultDest = path.join(diagramsDir, 'system.md');
  }

  const dest = formatted.out ?? defaultDest;
  const content = dest.endsWith('.mmd')
    ? `${mermaid}\n`
    : toMarkdown({ relPath: dest, title, mermaid });
  writeArtifact(dest, content);
  logger.success(`Mermaid diagram written to ${dest}`);
  logger.info('Renders on GitHub/IDE previews; use a .mmd --out path for raw Mermaid.');
}
