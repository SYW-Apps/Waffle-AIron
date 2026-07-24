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

// Normalize CRLF: the ^…$ section markers below require LF lines, and a fresh
// Windows checkout (core.autocrlf) would otherwise crash the generator — which
// now runs as the web build's prebuild step.
const readLines = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').split('\n');
const canvas = readLines(path.join(ROOT, 'src/core/canvas.ts'));
const dexp = readLines(path.join(ROOT, 'src/core/diagram-export.ts'));

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

// canvas.ts holds the CSS/skeleton/engine INSIDE a template literal, so runtime
// escapes are double-escaped in the source (a runtime `\n` is written `\\n`).
// Evaluate each section as the template literal it is — exactly what canvas.ts
// does at render time — to recover the real strings before writing them out.
// (These sections contain no backticks or `${`, verified, so this is safe.)
const evalTL = (s) => new Function('return `' + s + '`')();

let css = evalTL(canvas.slice(styleOpen + 1, styleClose).join('\n'));
const skel = evalTL(canvas.slice(bodyOpen + 1, cyLib - 3).join('\n')); // header..flow modal
// IIFE body only: skip the `(function () {` line, `'use strict';`, and the two
// server-only `var buildDrawioXml/Scene = __DRAWIO_FN__/__EXCALIDRAW_FN__;` decls
// (those placeholders are replaced by imports here). Template-eval to recover
// real escapes (`\\n` → `\n`, etc.).
let eng = evalTL(canvas.slice(iifeOpen + 4, iifeClose).join('\n'));

// ── CSS: scope body→.cbody, :root→:host/.cbody, viewport heights → flex ──
css = css.replace(/:root \{/, ':host, .cbody {');
// Only rewrite `body` when it is the ELEMENT selector — the negative lookbehind
// excludes a `.`/`#`/`-`/word char before it, so the `.body` class (e.g.
// `#panel .body`) is NOT corrupted into `..cbody` (which matched nothing and
// dropped the details-panel padding).
css = css.replace(/(?<![.#\w-])body\b/g, '.cbody');
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
  setTheme(theme: string, vars?: Record<string, string>): void;
  /** Apply a URL route (Stage J) to the engine WITHOUT echoing onViewChange —
   *  used by the shell for browser back/forward that changed the URL. */
  openRoute(route: string): void;
}

/** Mount the classic canvas into \`host\`. shadow (default true) isolates its CSS
 *  in a shadow root; theme sets the initial data-theme (\`syw\` dark | \`light\`);
 *  \`vars\` overlays CSS custom properties (e.g. the app's derived palette) on
 *  the canvas body — inline custom props win over the stylesheet's theme vars,
 *  so the whole chrome follows the host app's selected theme. */
export function mountCanvas(host, model, opts = {}) {
  const useShadow = opts.shadow !== false;
  // attachShadow is once-per-element and a shadow root can never be detached, so
  // a REMOUNT onto the same host (e.g. a realtime refetch re-running a React
  // mount effect) must REUSE the existing root — a second attachShadow throws
  // NotSupportedError and the refreshed canvas never renders. Clearing rootEl
  // makes the mount idempotent for shadow and light-DOM hosts alike.
  const rootEl = useShadow ? (host.shadowRoot || host.attachShadow({ mode: 'open' })) : host;
  rootEl.innerHTML = '';
  const styleEl = document.createElement('style');
  styleEl.textContent = CANVAS_CSS;
  rootEl.appendChild(styleEl);
  const cbody = document.createElement('div');
  cbody.className = 'cbody' + (opts.embed ? ' embed' : '');
  cbody.setAttribute('data-theme', opts.theme || 'syw');
  cbody.innerHTML = CANVAS_SKELETON;
  rootEl.appendChild(cbody);
  let appliedVars = [];
  function applyVars(vars) {
    for (const k of appliedVars) cbody.style.removeProperty(k);
    appliedVars = [];
    if (vars) {
      for (const k of Object.keys(vars)) {
        cbody.style.setProperty(k, vars[k]);
        appliedVars.push(k);
      }
    }
  }
  applyVars(opts.vars);

  var ROOT = useShadow ? rootEl : document;
  var CBODY = cbody;
  var MODEL = model;

${eng}

  return {
    destroy() {
      try { if (typeof cy !== 'undefined' && cy) cy.destroy(); } catch (e) { /* ignore */ }
      // The content lives in rootEl — the SHADOW tree when mounted with shadow;
      // host.innerHTML there would only touch the (empty) light DOM.
      rootEl.innerHTML = '';
    },
    // Drive the engine's OWN theme state (not just the CSS attribute) so the
    // cytoscape node fills recolor too, and a later view switch keeps the theme
    // (view rebuilds read state.theme). Mirrors the in-engine themeBtn handler.
    // \`vars\` (optional) replaces the mounted custom-property overlay — the
    // cytoscape content keeps its semantic light/dark palettes; vars theme the
    // CHROME (background, header, panel, accent) to the host app's palette.
    setTheme(theme, vars) {
      var next = theme === 'light' ? 'light' : 'syw';
      if (typeof state !== 'undefined' && state) state.theme = next;
      cbody.setAttribute('data-theme', next);
      if (vars !== undefined) applyVars(vars);
      try {
        if (typeof cy !== 'undefined' && cy) cy.style(buildStyle(THEMES[next]));
        if (typeof renderLegend === 'function') renderLegend();
        if (typeof persist === 'function') persist();
      } catch (e) { /* ignore */ }
    },
    // Drive the engine to a URL route (Stage J). The engine's own openRoute sets
    // an applyingRoute guard so this does NOT echo back through onViewChange —
    // letting the shell honour browser back/forward without a mount/unmount.
    openRoute(route) {
      try { if (typeof openRoute === 'function') openRoute(route); } catch (e) { /* ignore */ }
    },
  };
}
`,
);

console.log('[gen-canvas-engine] generated web/src/canvas/{engine,styles,skeleton,exporters}.ts from canvas.ts');
