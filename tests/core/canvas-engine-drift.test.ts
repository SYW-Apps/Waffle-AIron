import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Drift guard: web/src/canvas/*.ts are GENERATED from src/core/canvas.ts (+
// diagram-export.ts) by scripts/gen-canvas-engine.mjs — canvas.ts is the single
// source of truth. A stale committed copy already shipped a real bug (the SPA
// lost parallel/detach rendering), so this test re-runs the generator and fails
// whenever the committed engine no longer matches what the sources produce.
//
// The generator runs against an LF-normalized SHADOW COPY in a temp directory
// rather than in place:
//  - its `^<style>$`-style section markers require LF line endings, so on a
//    Windows checkout with core.autocrlf=true an in-place run crashes with
//    "marker not found" before writing anything;
//  - the checked-in files are never touched, so nothing needs restoring even
//    if the test dies mid-way.
// The content comparison also normalizes CRLF→LF on both sides: the generator
// writes LF while the checkout may materialize the committed files as CRLF.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const COMMITTED_DIR = path.join(REPO_ROOT, 'web', 'src', 'canvas');
const norm = (s: string) => s.replace(/\r\n/g, '\n');

describe('generated web canvas engine drift guard', () => {
  it('web/src/canvas/*.ts matches a fresh run of scripts/gen-canvas-engine.mjs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-canvas-gen-'));
    try {
      fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'src', 'core'), { recursive: true });
      // The generator reads exactly these two sources, resolves the project
      // root from its own file location, and writes <root>/web/src/canvas.
      for (const rel of ['src/core/canvas.ts', 'src/core/diagram-export.ts'] as const) {
        fs.writeFileSync(path.join(tmp, rel), norm(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')));
      }
      fs.copyFileSync(
        path.join(REPO_ROOT, 'scripts', 'gen-canvas-engine.mjs'),
        path.join(tmp, 'scripts', 'gen-canvas-engine.mjs'),
      );
      execFileSync(process.execPath, [path.join(tmp, 'scripts', 'gen-canvas-engine.mjs')], { encoding: 'utf8' });

      const genDir = path.join(tmp, 'web', 'src', 'canvas');
      const generated = fs.readdirSync(genDir).filter(f => f.endsWith('.ts')).sort();
      const committed = fs.readdirSync(COMMITTED_DIR).filter(f => f.endsWith('.ts')).sort();
      expect(
        committed,
        'web/src/canvas file set differs from the generator output — run `node scripts/gen-canvas-engine.mjs` and commit the result',
      ).toEqual(generated);

      const drifted = generated.filter(
        f => norm(fs.readFileSync(path.join(genDir, f), 'utf8')) !== norm(fs.readFileSync(path.join(COMMITTED_DIR, f), 'utf8')),
      );
      expect(
        drifted,
        'web/src/canvas is STALE relative to src/core/canvas.ts / src/core/diagram-export.ts — the SPA would ship an ' +
        'engine that drifts from the classic canvas. Run `node scripts/gen-canvas-engine.mjs` and commit the ' +
        'regenerated files: ' + drifted.join(', '),
      ).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
