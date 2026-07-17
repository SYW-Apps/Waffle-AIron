// Generate the shared, in-React canvas engine (web/src/canvas/*) from the SINGLE
// source of truth: src/core/canvas.ts's classic renderer. The engine is lifted
// VERBATIM — only its DOM access is parameterised (document.getElementById →
// ROOT.getElementById; document.body / document.documentElement → CBODY) so the
// exact same code drives a shadow root (React, isolated + themeable) or the
// document (the standalone snapshot export). Run before the web build so the
// module never drifts from canvas.ts. Never hand-edit web/src/canvas/*.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web/src/canvas');
fs.mkdirSync(OUT, { recursive: true });

const canvas = fs.readFileSync(path.join(ROOT, 'src/core/canvas.ts'), 'utf8').split('\n');
const dexp = fs.readFileSync(path.join(ROOT, 'src/core/diagram-export.ts'), 'utf8').split('\n');

// Locate the section boundaries by their stable markers (robust to line drift).
const at = (re, from = 0) => {
  for (let i = from; i < canvas.length; i++) if (re.test(canvas[i])) return i;
  throw new Error('gen-canvas-engine: marker not found: ' + re);
};
const styleOpen = at(/^<style>$/);
const styleClose = at(/^<\/style>$/, styleOpen);
const bodyOpen = at(/^<body data-theme="syw">$/, styleClose);
const cyLib = at(/^<script>__CYTOSCAPE_LIB__<\/script>$/, bodyOpen);
const iifeOpen = at(/^\(function \(\) \{$/, cyLib);
const iifeClose = at(/^\}\)\(\);$/, iifeOpen);

let css = canvas.slice(styleOpen + 1, styleClose).join('\n');
const skel = canvas.slice(bodyOpen + 1, cyLib - 3).join('\n'); // header..flow modal (before the __MODEL__ script)
let eng = canvas.slice(iifeOpen + 3, iifeClose).join('\n'); // IIFE body, minus `'use strict';` + the two __FN__ decls

// ── CSS: scope body→.cbody, :root→:host/.cbody, viewport heights → flex ──
css = css.replace(/:root \{/, ':host, .cbody {');
css = css.replace(/\bbody\b/g, '.cbody');
css = css.replace(/height:calc\(100vh - 52px\)/g, 'flex:1 1 auto; min-height:0');
css = css.replace(/height:100vh/g, 'height:100%');
css = css.replace('header { display:flex; align-items:center;', 'header { flex:0 0 auto; display:flex; align-items:center;');
css =
  `/* GENERATED from src/core/canvas.ts by scripts/gen-canvas-engine.mjs — do not edit. */\n` +
  `:host { display:block; width:100%; height:100%; }\n` +
  `.cbody { display:flex; flex-direction:column; width:100%; height:100%; overflow:hidden; }\n` +
  css;

// ── ENGINE: parameterise element access ──
eng = eng.replace(/document\.getElementById\(/g, 'ROOT.getElementById(');
eng = eng.replace(/document\.documentElement/g, 'CBODY');
eng = eng.replace(/document\.body/g, 'CBODY');

// ── exporters: the two self-contained builders (verbatim) ──
const exDefStart = dexp.findIndex((l) => /^export interface ExportModel/.test(l));
const exFnStart = dexp.findIndex((l) => /^export function buildDrawioXml/.test(l));
const exFnEnd = dexp.findIndex((l, i) => i > dexp.findIndex((x) => /^export function buildExcalidrawScene/.test(x)) && /^\}$/.test(l));
const exporters =
  `// @ts-nocheck\n/* GENERATED from src/core/diagram-export.ts — do not edit. Self-contained by design. */\n` +
  dexp.slice(exDefStart, exFnStart - 1).join('\n') + '\n' +
  `type LayoutResult = any;\n\n` +
  dexp.slice(exFnStart, exFnEnd + 1).join('\n') + '\n';

const lit = (s) => '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
fs.writeFileSync(path.join(OUT, 'styles.ts'), `/* GENERATED — do not edit. */\nexport const CANVAS_CSS = ${lit(css)};\n`);
fs.writeFileSync(path.join(OUT, 'skeleton.ts'), `/* GENERATED — do not edit. */\nexport const CANVAS_SKELETON = ${lit(skel)};\n`);
fs.writeFileSync(path.join(OUT, 'exporters.ts'), exporters);

fs.writeFileSync(
  path.join(OUT, 'engine.ts'),
  `// @ts-nocheck
/* GENERATED from src/core/canvas.ts by scripts/gen-canvas-engine.mjs — do not edit.
 * The interactive engine is lifted VERBATIM; only DOM access is parameterised
 * (ROOT/CBODY) so one engine drives a shadow root (React) or the document
 * (standalone export). Edit src/core/canvas.ts, then re-run the generator. */
import cytoscape from 'cytoscape';
import { buildDrawioXml, buildExcalidrawScene } from './exporters';
import { CANVAS_CSS } from './styles';
import { CANVAS_SKELETON } from './skeleton';

export interface CanvasHandle {
  destroy(): void;
  setTheme(theme: string): void;
}

/** Mount the classic canvas into \`host\`. shadow (default true) isolates its CSS
 *  in a shadow root; theme sets the initial data-theme (\`syw\` dark | \`light\`). */
export function mountCanvas(host, model, opts = {}) {
  const useShadow = opts.shadow !== false;
  const rootEl = useShadow ? host.attachShadow({ mode: 'open' }) : host;
  const styleEl = document.createElement('style');
  styleEl.textContent = CANVAS_CSS;
  rootEl.appendChild(styleEl);
  const cbody = document.createElement('div');
  cbody.className = 'cbody';
  cbody.setAttribute('data-theme', opts.theme || 'syw');
  cbody.innerHTML = CANVAS_SKELETON;
  rootEl.appendChild(cbody);

  var ROOT = useShadow ? rootEl : document;
  var CBODY = cbody;
  var MODEL = model;

${eng}

  return {
    destroy() {
      try { if (typeof cy !== 'undefined' && cy) cy.destroy(); } catch (e) { /* ignore */ }
      host.innerHTML = '';
    },
    setTheme(theme) { cbody.setAttribute('data-theme', theme); },
  };
}
`,
);

console.log('[gen-canvas-engine] generated web/src/canvas/{engine,styles,skeleton,exporters}.ts from canvas.ts');
