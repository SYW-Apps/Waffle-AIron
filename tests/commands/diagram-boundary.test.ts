import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  saveComponentSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import * as adapter from '../../src/commands/adapters/core.js';
import * as portal from '../../src/core/index.js';
import { runDiagram } from '../../src/commands/diagram.js';

// ---------------------------------------------------------------------------
// Where `wairon diagram` is allowed to reach the renderer.
//
// The command used to build its own artifacts: buildCanvasModel and
// renderCanvasHtml out of ../core/canvas.js, the two encoders out of
// ../core/diagram-export.js, the Mermaid generators out of ../core/diagram.js,
// and validateSddTree out of ../core/validation.js — four sdd_core modules
// reached straight from a command, while core_portal.renderDiagram(format)
// existed for exactly this. `wairon host demo` made the same reach for its
// seeded-tree census.
//
// Nothing was broken by it, which is why it survived four times: an import that
// works is invisible until something asks where the boundary is. These tests
// ask. Two of them are assertions a type-check cannot make — both spellings
// compile, so only the import SITE says which side of the boundary a file is
// on, and only the `type` keyword says whether an edge exists at runtime.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const now = '2026-09-20T10:00:00Z';

/** The render carries `generatedAt`, so two runs differ by a timestamp and nothing else. */
function undated(artifact: string): string {
  return artifact.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<when>');
}

describe('wairon diagram renders through cli_core_adapter, not through sdd_core modules', () => {
  let proj = '';

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    vi.restoreAllMocks();
    if (proj) {
      try { fs.rmSync(proj, { recursive: true, force: true }); } catch { /* win locks */ }
      proj = '';
    }
  });

  function buildFixture(): string {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-diagram-boundary-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'BoundarySys', projectType: 'backend',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: {}, createdAt: now, updatedAt: now,
    }));
    setProjectRoot(proj);

    saveSystemSpec({
      schemaVersion: '1.0.0', name: 'BoundarySys', vision: 'a rendering fixture',
      boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
    });
    saveSubsystemSpec({
      id: 'billing', name: 'Billing', description: 'billing',
      parentSystem: 'BoundarySys',
      publicInterfaces: [{ type: 'REST', details: 'api', component: 'billing-portal' }],
      createdAt: now, updatedAt: now,
    } as never);
    const comp = (over: Record<string, unknown>) => ({
      id: '', name: '', description: 'd', subsystem: 'billing',
      componentType: 'Orchestrator', owns: [], dependsOn: [],
      createdAt: now, updatedAt: now, ...over,
    });
    saveComponentSpec(comp({
      id: 'billing-portal', name: 'Billing Portal', componentType: 'Portal',
      portalType: 'HTTP_API', dependsOn: ['billing-orchestrator'],
    }) as never);
    saveComponentSpec(comp({ id: 'billing-orchestrator', name: 'Billing Orchestrator' }) as never);
    invalidateSpecCache();
    return proj;
  }

  // -- 1. the adapter method the contract names ------------------------------

  it('answers each of the four formats, as the format the caller asked for', () => {
    buildFixture();

    const canvas = adapter.renderDiagram('canvas');
    expect(canvas).toContain('<!DOCTYPE html>');
    expect(canvas).toContain('Billing Portal');

    const mermaid = adapter.renderDiagram('mermaid');
    expect(mermaid).toContain('flowchart LR');
    expect(mermaid).toContain('Billing Portal<br/>«Portal»');

    const drawio = adapter.renderDiagram('drawio');
    expect(drawio).toContain('<mxfile host="wairon"');
    expect(drawio).toContain('</mxfile>');

    const scene = JSON.parse(adapter.renderDiagram('excalidraw'));
    expect(scene.type).toBe('excalidraw');
    expect(scene.source).toBe('wairon');
    expect(Array.isArray(scene.elements)).toBe(true);
  });

  it('refuses a format sdd_core does not render, rather than writing an empty file', () => {
    buildFixture();
    expect(() => adapter.renderDiagram('pdf')).toThrow(/Unsupported diagram format "pdf"/);
  });

  it('forwards to core_portal rather than rendering a second time', () => {
    buildFixture();
    // A 1:1 forward, so the adapter and the Portal must answer the same artifact
    // for the same tree. Anything else is a second implementation to drift.
    for (const format of ['canvas', 'mermaid', 'drawio', 'excalidraw']) {
      expect(undated(adapter.renderDiagram(format))).toEqual(undated(portal.renderDiagram(format)));
    }
  });

  // -- 2. the command reaches rendering THROUGH it ---------------------------

  it('writes, for every format, exactly what the adapter rendered', async () => {
    const root = buildFixture();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const cases: { options: Record<string, unknown>; file: string; format: string }[] = [
      { options: { canvas: true }, file: 'c.html', format: 'canvas' },
      { options: { drawio: true }, file: 'a.drawio', format: 'drawio' },
      { options: { excalidraw: true }, file: 'a.excalidraw', format: 'excalidraw' },
    ];
    for (const { options, file, format } of cases) {
      const out = path.join(root, 'out', file);
      await runDiagram({ ...options, out });
      expect(undated(fs.readFileSync(out, 'utf-8'))).toEqual(undated(adapter.renderDiagram(format)));
    }

    // Mermaid lands inside a markdown wrapper, so the artifact is contained
    // rather than equal — but it is still the adapter's render, not a second one.
    const mmd = path.join(root, 'out', 'system.mmd');
    await runDiagram({ format: 'mermaid', out: mmd });
    expect(fs.readFileSync(mmd, 'utf-8').trim()).toEqual(adapter.renderDiagram('mermaid').trim());
  });

  it('still draws the scopes no format string can carry, and the whole set', async () => {
    // renderDiagram(format) is the four-format path and nothing else: --all,
    // --sequence and --subsystem are scopes DiagramOptions models as fields
    // while no contract method takes them. They cross the boundary through the
    // same adapter, and they have to keep working.
    const root = buildFixture();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const scoped = path.join(root, 'out', 'billing.md');
    await runDiagram({ subsystem: 'billing', out: scoped });
    expect(fs.readFileSync(scoped, 'utf-8')).toContain('Billing Portal');

    const outDir = path.join(root, 'set');
    await runDiagram({ all: true, out: outDir });
    for (const file of ['canvas.html', 'architecture.drawio', 'architecture.excalidraw', 'README.md']) {
      expect(fs.existsSync(path.join(outDir, file))).toBe(true);
    }
    expect(fs.readFileSync(path.join(outDir, 'README.md'), 'utf-8')).toContain('BoundarySys');
  });

  it('is the only way the command reaches sdd_core — it names no core module', () => {
    // The assertion a type-check cannot make: `../core/canvas.js` and
    // `./subsystem.js` both compile, so only the import site says which side of
    // the boundary the command is on. Literal lines, not patterns: an escaped
    // regex has quietly matched nothing here twice.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/commands/diagram.ts'), 'utf8');
    expect(source).not.toContain("from '../core/canvas.js'");
    expect(source).not.toContain("from '../core/diagram.js'");
    expect(source).not.toContain("from '../core/diagram-export.js'");
    expect(source).not.toContain("from '../core/validation.js'");
    expect(source).toContain("from './adapters/core.js'");
  });

  it('is how `wairon host demo` counts its seeded tree too', () => {
    // The same reach, in the file that seeds the demo project: it took
    // buildCanvasModel straight out of the canvas module to print how many
    // subsystems, components and edges it had just written.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/commands/host.ts'), 'utf8');
    expect(source).not.toContain("import { buildCanvasModel } from '../core/canvas.js';");
    expect(source).toContain("import { buildCanvasDataModel } from './subsystem.js';");
  });

  // -- 3. the false edge inside sdd_core -------------------------------------

  it('takes CanvasModel into the codec as a type, so the codec does not import the canvas', () => {
    // canvas.ts imports the two encoders as VALUES (it serializes their source
    // into the page). diagram-export.ts needed CanvasModel only to name a
    // parameter — as a plain import that read as a runtime edge back, and the
    // pair drew a cycle the code does not have. One keyword, one direction.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/core/diagram-export.ts'), 'utf8');
    expect(source).toContain("import type { CanvasModel } from './canvas.js';");
    expect(source).not.toContain("import { CanvasModel } from './canvas.js';");
  });
});
