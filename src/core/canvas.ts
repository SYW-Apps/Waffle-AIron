import * as fs from 'fs';
import * as path from 'path';
import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
} from './specs.js';
import type { ValidationIssue } from './validation.js';
import { computeLayout } from './canvas-layout.js';
import { buildDrawioXml, buildExcalidrawScene } from './diagram-export.js';

// ---------------------------------------------------------------------------
// Interactive architecture canvas — a self-contained single-page app.
//
// One HTML file, zero network: Cytoscape.js is vendored inline, and the
// layout + export builders (computeLayout / buildDrawioXml /
// buildExcalidrawScene) are serialized verbatim from their TypeScript
// modules, so the browser and the CLI share one implementation. In-browser
// exports therefore use the user's CURRENT (possibly rearranged) positions.
//
// Features: SYW / light themes, view levels (system → components → full),
// collapse boundaries into tube edges, spec-derived detail sidebar with
// collapsible sections, narrative flowchart modal with call drill-down and
// back navigation, search that dims nodes AND their edges, hover-highlight
// from sidebar references, layout persistence (localStorage), presentation
// mode, and an export menu (PNG / draw.io / Excalidraw).
// ---------------------------------------------------------------------------

export interface CanvasModel {
  system: { name: string; vision?: string; targetLanguage?: string };
  generatedAt: string;
  subsystems: {
    id: string;
    name: string;
    description: string;
    targetLanguage?: string;
    status?: string;
    trustedLinks: { subsystem: string; reason: string }[];
  }[];
  components: {
    id: string;
    name: string;
    description: string;
    subsystem: string;
    componentType: string;
    portalType?: string;
    status?: string;
    public: boolean;
    owner?: string;
    owns: string[];
    dependsOn: string[];
    interfaces: {
      id: string;
      name: string;
      description: string;
      methods: {
        name: string;
        description: string;
        signature: string;
        returns: string;
        params?: { name: string; type: string; optional?: boolean }[];
        endpoint?: unknown;
        guarantees?: string[];
      }[];
    }[];
    narratives: {
      method: string;
      steps: { n: number; text: string; call?: { component: string; method: string } }[];
    }[];
  }[];
  edges: { from: string; to: string; cross: boolean }[];
  issues: { severity: string; code: string; message: string; specId?: string }[];
}

export function buildCanvasModel(issues: ValidationIssue[] = []): CanvasModel {
  const system = loadSystemSpec();
  const subsystems = loadSubsystemSpecs();
  const components = loadComponentSpecs();
  const interfaces = loadInterfaceSpecs();
  const implementations = loadImplementationSpecs();

  const componentIds = new Set(components.map(c => c.id));
  const publicComponents = new Set<string>();
  for (const sub of subsystems) {
    for (const pi of sub.publicInterfaces) {
      if (pi.component) publicComponents.add(pi.component);
    }
  }

  const ownerOf = new Map<string, string>();
  for (const comp of components) {
    for (const memberId of comp.owns) {
      if (componentIds.has(memberId)) ownerOf.set(memberId, comp.id);
    }
  }

  const modelComponents: CanvasModel['components'] = components.map(comp => {
    const compInterfaces = interfaces.filter(i => i.component === comp.id);
    const contractIds = new Set(compInterfaces.map(i => i.id));
    const impls = implementations.filter(im => contractIds.has(im.contract));
    const narratives: CanvasModel['components'][number]['narratives'] = [];
    for (const impl of impls) {
      for (const m of impl.methods) {
        if (!m.narrative.length) continue;
        narratives.push({
          method: m.name,
          steps: m.narrative.map(s => ({
            n: s.stepNumber,
            text: s.description,
            ...(s.type === 'call' && s.targetComponent && s.targetMethod
              ? { call: { component: s.targetComponent, method: s.targetMethod } }
              : {}),
          })),
        });
      }
    }
    return {
      id: comp.id,
      name: comp.name,
      description: comp.description,
      subsystem: comp.subsystem,
      componentType: comp.componentType,
      ...(comp.portalType ? { portalType: comp.portalType } : {}),
      ...(comp.status ? { status: comp.status } : {}),
      public: publicComponents.has(comp.id),
      ...(ownerOf.has(comp.id) ? { owner: ownerOf.get(comp.id) } : {}),
      owns: comp.owns.filter(o => componentIds.has(o)),
      dependsOn: comp.dependsOn,
      interfaces: compInterfaces.map(i => ({
        id: i.id,
        name: i.name,
        description: i.description,
        methods: i.methods.map(m => ({
          name: m.name,
          description: m.description,
          signature: m.signature,
          returns: m.returns,
          ...(m.params && m.params.length ? { params: m.params } : {}),
          ...(m.endpoint ? { endpoint: m.endpoint } : {}),
          ...(m.guarantees && m.guarantees.length ? { guarantees: m.guarantees } : {}),
        })),
      })),
      narratives,
    };
  });

  const componentSub = new Map(components.map(c => [c.id, c.subsystem]));
  const edges: CanvasModel['edges'] = [];
  for (const comp of components) {
    for (const depId of comp.dependsOn) {
      if (!componentIds.has(depId)) continue;
      edges.push({
        from: comp.id,
        to: depId,
        cross: componentSub.get(depId) !== comp.subsystem,
      });
    }
  }

  return {
    system: {
      name: system?.name ?? 'System',
      ...(system?.vision ? { vision: system.vision } : {}),
      ...(system?.targetLanguage ? { targetLanguage: system.targetLanguage } : {}),
    },
    generatedAt: new Date().toISOString(),
    subsystems: subsystems.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      ...(s.targetLanguage ? { targetLanguage: s.targetLanguage } : {}),
      ...(s.status ? { status: s.status } : {}),
      trustedLinks: s.trustedLinks ?? [],
    })),
    components: modelComponents,
    edges,
    issues: issues.map(i => ({
      severity: i.severity,
      code: i.code,
      message: i.message,
      ...(i.specId ? { specId: i.specId } : {}),
    })),
  };
}

/** Embed arbitrary JSON safely inside a <script> block. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** The vendored cytoscape bundle, shipped with wairon's templates. */
function loadCytoscapeLib(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'templates', 'canvas', 'cytoscape.min.js'), // src/core & dist/cli
    path.resolve(__dirname, 'templates', 'canvas', 'cytoscape.min.js'),       // dist (library entry)
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf-8').replace(/<\/script/gi, '<\\/script');
    }
  }
  throw new Error('Vendored cytoscape bundle not found (templates/canvas/cytoscape.min.js) — the wairon installation is incomplete.');
}

export function renderCanvasHtml(model: CanvasModel): string {
  const title = `${model.system.name} — architecture canvas`;
  return CANVAS_TEMPLATE
    .replace('__TITLE__', () => escapeHtml(title))
    .replace('__SYSTEM_NAME__', () => escapeHtml(model.system.name))
    .replace('__SYSTEM_NAME__', () => escapeHtml(model.system.name))
    .replace('__GENERATED_AT__', () => escapeHtml(model.generatedAt))
    .replace('__CYTOSCAPE_LIB__', () => loadCytoscapeLib())
    .replace('__LAYOUT_FN__', () => computeLayout.toString())
    .replace('__DRAWIO_FN__', () => buildDrawioXml.toString())
    .replace('__EXCALIDRAW_FN__', () => buildExcalidrawScene.toString())
    .replace('__MODEL_JSON__', () => embedJson(model));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The inline script avoids template literals so this outer file stays simple.
const CANVAS_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
/* SYW Apps Standardized Global CSS (inlined for offline use) */
:root {
  --syw-cyan: #22ddff;
  --syw-purple: #8b5cf6;
  --syw-yellow: #ddff22;
  --syw-amber: #f59e0b;
  --syw-bg: #0a0a0f;
  --syw-deep-space: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #312e81 100%);
  --syw-surface: rgba(13, 27, 42, 0.95);
  --syw-primary-gradient: linear-gradient(135deg, #22ddff 0%, #8b5cf6 100%);
  --syw-secondary-gradient: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
  --syw-surface-gradient: linear-gradient(135deg, rgba(13, 27, 42, 0.95) 0%, rgba(27, 38, 59, 0.98) 100%);
  --syw-glow: 0 0 20px rgba(34, 221, 255, 0.3);
  --syw-deep-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}
.syw-gradient-text { background: var(--syw-primary-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; display: inline-block; }
.syw-glass { background: rgba(255,255,255,0.03); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; }
* { box-sizing: border-box; }

/* Theme variables */
body[data-theme="syw"] {
  --bg: var(--syw-bg);
  --chrome: rgba(13, 27, 42, 0.92);
  --chrome-border: rgba(34, 221, 255, 0.18);
  --ink: #e8ecf3;
  --dim: #93a2b8;
  --line: rgba(255,255,255,0.10);
  --input-bg: rgba(255,255,255,0.06);
  --hover-bg: rgba(34, 221, 255, 0.10);
  --accent: var(--syw-cyan);
  --card: rgba(255,255,255,0.04);
  --danger: #ff6b81; --warn: #f59e0b;
}
body[data-theme="light"] {
  --bg: #fafbfc;
  --chrome: #ffffff;
  --chrome-border: #d8dee4;
  --ink: #1f2328;
  --dim: #57606a;
  --line: #e3e8ee;
  --input-bg: #f6f8fa;
  --hover-bg: rgba(74, 125, 207, 0.08);
  --accent: #4a7dcf;
  --card: #f8fafc;
  --danger: #cf4a4a; --warn: #c9963f;
}
body { margin:0; background:var(--bg); color:var(--ink); font:13px/1.45 "Inter", system-ui, "Segoe UI", sans-serif; overflow:hidden; }
body[data-theme="syw"] { background-image: var(--syw-deep-space); background-attachment: fixed; }

/* Header toolbar */
header { display:flex; align-items:center; gap:10px; padding:0 14px; height:52px; background:var(--chrome); border-bottom:1px solid var(--chrome-border); position:relative; z-index:20; }
header .brand { font-weight:800; font-size:17px; letter-spacing:.02em; }
header .sysname { font-weight:600; font-size:13.5px; white-space:nowrap; max-width:220px; overflow:hidden; text-overflow:ellipsis; }
header .divider { width:1px; height:24px; background:var(--line); margin:0 2px; }
header input[type="search"] { padding:6px 10px; border:1px solid var(--chrome-border); border-radius:8px; width:200px; font:inherit; background:var(--input-bg); color:var(--ink); }
header input[type="search"]::placeholder { color:var(--dim); }
.seg { display:flex; border:1px solid var(--chrome-border); border-radius:8px; overflow:hidden; }
.seg button { border:none; background:transparent; color:var(--dim); padding:6px 11px; cursor:pointer; font:inherit; font-size:12px; }
.seg button.active { background:var(--syw-primary-gradient); color:#fff; font-weight:700; }
body[data-theme="light"] .seg button.active { background:var(--accent); }
.switch { display:inline-flex; align-items:center; gap:6px; cursor:pointer; color:var(--dim); font-size:12px; white-space:nowrap; user-select:none; padding:5px 8px; border-radius:8px; }
.switch:hover { background:var(--hover-bg); color:var(--ink); }
.switch input { accent-color:var(--accent); margin:0; }
.tbtn { border:1px solid var(--chrome-border); background:var(--input-bg); color:var(--ink); padding:6px 11px; border-radius:8px; cursor:pointer; font:inherit; font-size:12px; white-space:nowrap; }
.tbtn:hover { background:var(--hover-bg); border-color:var(--accent); }
.spacer { flex:1; }

/* Export dropdown */
.dropdown { position:relative; }
.dropdown .menu { display:none; position:absolute; right:0; top:calc(100% + 6px); background:var(--chrome); border:1px solid var(--chrome-border); border-radius:10px; box-shadow:var(--syw-deep-shadow); min-width:200px; padding:6px; z-index:50; }
.dropdown.open .menu { display:block; }
.dropdown .menu button { display:block; width:100%; text-align:left; border:none; background:transparent; color:var(--ink); padding:8px 10px; border-radius:7px; cursor:pointer; font:inherit; font-size:12.5px; }
.dropdown .menu button:hover { background:var(--hover-bg); }
.dropdown .menu .hint { display:block; color:var(--dim); font-size:10.5px; }

/* Layout */
#wrap { display:flex; height:calc(100vh - 52px); }
#stage { flex:1; position:relative; }
#cy { position:absolute; inset:0; }
.legend { position:absolute; left:12px; bottom:12px; background:var(--chrome); border:1px solid var(--chrome-border); border-radius:10px; padding:8px 12px; font-size:11px; color:var(--dim); z-index:5; pointer-events:none; }
.legend .sw { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:4px; vertical-align:-1px; border:1.5px solid; }

/* Sidebar */
#panel { width:380px; border-left:1px solid var(--chrome-border); background:var(--chrome); overflow-y:auto; z-index:10; }
#panel .head { padding:16px 18px 10px; border-bottom:1px solid var(--line); }
#panel .head h2 { font-size:16px; margin:0 0 6px; }
#panel .body { padding:12px 18px 30px; }
#panel .chip { display:inline-block; padding:2px 9px; border-radius:11px; font-size:11px; border:1px solid var(--chrome-border); margin:0 4px 5px 0; background:var(--input-bg); color:var(--ink); }
#panel .chip[data-kind] { cursor:pointer; }
#panel .chip[data-kind]:hover { border-color:var(--accent); background:var(--hover-bg); }
#panel .desc { color:var(--dim); margin:8px 0 2px; }
#panel details { border:1px solid var(--line); border-radius:10px; margin:10px 0; background:var(--card); overflow:hidden; }
#panel summary { cursor:pointer; padding:9px 12px; font-size:11.5px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:var(--dim); user-select:none; display:flex; align-items:center; gap:8px; }
#panel summary:hover { color:var(--ink); background:var(--hover-bg); }
#panel summary .count { margin-left:auto; font-weight:600; background:var(--input-bg); border:1px solid var(--line); border-radius:9px; padding:0 7px; font-size:10.5px; }
#panel details > .inner { padding:4px 12px 12px; }
#panel .method { border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin:8px 0; background:var(--chrome); }
#panel .method .mname { font-weight:700; display:flex; align-items:center; gap:8px; }
#panel .method code { font-size:11px; word-break:break-all; color:var(--dim); display:block; margin-top:3px; }
#panel .method .mdesc { color:var(--dim); font-size:12px; margin-top:3px; }
#panel .flowbtn { border:1px solid var(--chrome-border); background:var(--input-bg); color:var(--accent); font-size:10.5px; padding:2px 8px; border-radius:7px; cursor:pointer; margin-left:auto; }
#panel .flowbtn:hover { background:var(--hover-bg); }
#panel .step { margin:4px 0 4px 4px; padding-left:10px; border-left:2px solid var(--line); font-size:12px; }
#panel .step .call { color:var(--accent); cursor:pointer; text-decoration:underline dotted; }
#panel .issue { border-left:3px solid var(--danger); padding:6px 9px; margin:6px 0; background:var(--card); font-size:12px; border-radius:0 7px 7px 0; }
#panel .issue.warning { border-left-color:var(--warn); }
#panel .issue code { font-size:10.5px; color:var(--dim); }

/* Presentation mode */
body.presentation header, body.presentation #panel, body.presentation .legend { display:none; }
body.presentation #wrap { height:100vh; }
#exitPresent { display:none; position:fixed; top:10px; right:10px; z-index:100; border:1px solid var(--chrome-border); background:var(--chrome); color:var(--ink); border-radius:9px; padding:7px 13px; cursor:pointer; opacity:0.06; transition:opacity .15s ease; font:inherit; }
#exitPresent:hover { opacity:1; box-shadow:var(--syw-glow); }
body.presentation #exitPresent { display:block; }

/* Flowchart modal */
#flowModal { display:none; position:fixed; inset:0; background:rgba(4,6,12,0.6); backdrop-filter:blur(3px); z-index:80; align-items:center; justify-content:center; }
#flowModal.open { display:flex; }
#flowModal .box { width:min(860px, 92vw); height:min(640px, 88vh); background:var(--chrome); border:1px solid var(--chrome-border); border-radius:14px; box-shadow:var(--syw-deep-shadow); display:flex; flex-direction:column; overflow:hidden; }
#flowModal .bar { display:flex; align-items:center; gap:10px; padding:10px 14px; border-bottom:1px solid var(--line); }
#flowModal .bar .crumb { font-weight:700; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#flowModal .bar .crumb .dimc { color:var(--dim); font-weight:400; }
#flowCy { flex:1; }
#flowModal .hintbar { padding:6px 14px; color:var(--dim); font-size:11px; border-top:1px solid var(--line); }
</style>
</head>
<body data-theme="syw">
<header>
  <span class="brand syw-gradient-text">wairon</span>
  <span class="sysname" title="__SYSTEM_NAME__">__SYSTEM_NAME__</span>
  <span class="divider"></span>
  <input id="search" type="search" placeholder="Search components…">
  <div class="seg" id="viewSeg">
    <button data-view="system" title="Subsystems only">System</button>
    <button data-view="components" title="Components (patterns collapsed)">Components</button>
    <button data-view="full" class="active" title="Everything expanded">Full</button>
  </div>
  <label class="switch"><input type="checkbox" id="issuesToggle"><span>Issues (<span id="issueCount"></span>)</span></label>
  <label class="switch"><input type="checkbox" id="dragToggle"><span>Rearrange</span></label>
  <span class="spacer"></span>
  <button class="tbtn" id="fitBtn" title="Fit graph to view">Fit</button>
  <button class="tbtn" id="resetBtn" title="Discard saved rearrangement and restore the computed layout">Reset layout</button>
  <div class="dropdown" id="exportDd">
    <button class="tbtn" id="exportBtn">Export ▾</button>
    <div class="menu">
      <button id="expPng">PNG image <span class="hint">high-res snapshot of the whole graph</span></button>
      <button id="expDrawio">draw.io file <span class="hint">editable, uses your current layout</span></button>
      <button id="expExcalidraw">Excalidraw file <span class="hint">editable, uses your current layout</span></button>
    </div>
  </div>
  <button class="tbtn" id="themeBtn" title="Toggle theme">◐ Theme</button>
  <button class="tbtn" id="presentBtn" title="Presentation mode (hides menus)">⛶ Present</button>
</header>
<div id="wrap">
  <div id="stage">
    <div id="cy"></div>
    <div class="legend" id="legend"></div>
  </div>
  <div id="panel"></div>
</div>
<button id="exitPresent">✕ Exit presentation</button>
<div id="flowModal">
  <div class="box">
    <div class="bar">
      <button class="tbtn" id="flowBack" title="Back to the calling narrative">← Back</button>
      <span class="crumb" id="flowCrumb"></span>
      <span class="spacer"></span>
      <button class="tbtn" id="flowPng">Export PNG</button>
      <button class="tbtn" id="flowClose">✕</button>
    </div>
    <div id="flowCy"></div>
    <div class="hintbar">Narrative flow (L5) — click a call step to drill into the target method's flow.</div>
  </div>
</div>
<script>__CYTOSCAPE_LIB__</script>
<script>
var MODEL = __MODEL_JSON__;
</script>
<script>
(function () {
  'use strict';
  var computeLayout = __LAYOUT_FN__;
  var buildDrawioXml = __DRAWIO_FN__;
  var buildExcalidrawScene = __EXCALIDRAW_FN__;

  var store = (typeof localStorage !== 'undefined') ? localStorage : null;
  var inBrowser = (typeof window !== 'undefined');
  var STORE_KEY = 'wairon:canvas:' + MODEL.system.name;

  // ---- indexes -------------------------------------------------------------
  var compById = {};
  MODEL.components.forEach(function (c) { compById[c.id] = c; });
  var subById = {};
  MODEL.subsystems.forEach(function (s) { subById[s.id] = s; });
  var issuesBySpec = {};
  MODEL.issues.forEach(function (i) {
    if (!i.specId) return;
    (issuesBySpec[i.specId] = issuesBySpec[i.specId] || []).push(i);
  });
  document.getElementById('issueCount').textContent =
    MODEL.issues.filter(function (i) { return i.severity === 'error'; }).length + 'e/' +
    MODEL.issues.filter(function (i) { return i.severity === 'warning'; }).length + 'w';

  var PATTERN_TYPES = { Repository:1, Gateway:1, FeatureComponent:1, RouterComponent:1 };
  function stereoClass(t) {
    if (t === 'Portal' || t === 'Observer') return 'entry';
    if (t === 'Store' || t === 'Index' || t === 'Registry') return 'data';
    if (t === 'Adapter') return 'adapter';
    if (PATTERN_TYPES[t]) return 'patternLeaf';
    return 'logic';
  }
  var CN = function (id) { return 'c~' + id; };
  var SN = function (id) { return 's~' + id; };

  // ---- persisted state -------------------------------------------------------
  var saved = { positions: {}, collapsed: [], theme: 'syw' };
  try { if (store && store.getItem(STORE_KEY)) saved = JSON.parse(store.getItem(STORE_KEY)) || saved; } catch (e) { /* corrupted — ignore */ }

  var state = {
    collapsed: {},
    selected: null,
    selectedKind: null,
    showIssues: false,
    query: '',
    theme: saved.theme === 'light' ? 'light' : 'syw',
  };
  (saved.collapsed || []).forEach(function (id) { state.collapsed[id] = true; });

  function persist() {
    if (!store) return;
    try {
      store.setItem(STORE_KEY, JSON.stringify({
        positions: saved.positions || {},
        collapsed: Object.keys(state.collapsed).filter(function (k) { return state.collapsed[k]; }),
        theme: state.theme,
      }));
    } catch (e) { /* storage full/blocked — non-fatal */ }
  }

  function matches(c) {
    if (!state.query) return true;
    var q = state.query.toLowerCase();
    return c.id.toLowerCase().indexOf(q) >= 0 || c.name.toLowerCase().indexOf(q) >= 0;
  }

  // ---- themes -----------------------------------------------------------------
  var THEMES = {
    light: {
      pageEdge: '#8d97a5', edgeText: '#57606a', cross: '#c26767', ink: '#1f2328',
      subFill: '#ffffff', subStroke: '#b6c0cc', subText: '#1f2328',
      patFill: '#f6f8fa', patStroke: '#6a737d',
      stereo: {
        entry:   { fill: '#eef4ff', stroke: '#4a7dcf' },
        logic:   { fill: '#f4effd', stroke: '#8a5cf6' },
        data:    { fill: '#fdf6e3', stroke: '#c9963f' },
        adapter: { fill: '#eef8f1', stroke: '#4f9e6b' },
        patternLeaf: { fill: '#f6f8fa', stroke: '#6a737d' },
      },
      issue: '#cf4a4a', selGlow: '#4a7dcf', bgLabel: '#fafbfc', png: '#fafbfc',
    },
    syw: {
      pageEdge: '#5b6b82', edgeText: '#93a2b8', cross: '#ff6b81', ink: '#e8ecf3',
      subFill: 'rgba(13,27,42,0.88)', subStroke: 'rgba(34,221,255,0.45)', subText: '#22ddff',
      patFill: 'rgba(255,255,255,0.04)', patStroke: '#7a8699',
      stereo: {
        entry:   { fill: '#0d2b4d', stroke: '#22ddff' },
        logic:   { fill: '#241b45', stroke: '#8b5cf6' },
        data:    { fill: '#3a2c10', stroke: '#f59e0b' },
        adapter: { fill: '#0f3323', stroke: '#34d399' },
        patternLeaf: { fill: 'rgba(255,255,255,0.05)', stroke: '#94a3b8' },
      },
      issue: '#ff6b81', selGlow: '#22ddff', bgLabel: '#0a0a0f', png: '#0a0a0f',
    },
  };

  function buildStyle(t) {
    return [
      { selector: 'node', style: {
        shape: 'round-rectangle', width: 'data(w)', height: 'data(h)',
        label: 'data(label)', 'text-wrap': 'wrap', 'text-max-width': 'data(tw)',
        'font-family': 'Inter, system-ui, sans-serif', 'font-size': 11, color: t.ink,
        'text-valign': 'center', 'text-halign': 'center', 'border-width': 1.5,
      }},
      { selector: '.entry', style: { 'background-color': t.stereo.entry.fill, 'border-color': t.stereo.entry.stroke } },
      { selector: '.logic', style: { 'background-color': t.stereo.logic.fill, 'border-color': t.stereo.logic.stroke } },
      { selector: '.data', style: { 'background-color': t.stereo.data.fill, 'border-color': t.stereo.data.stroke } },
      { selector: '.adapter', style: { 'background-color': t.stereo.adapter.fill, 'border-color': t.stereo.adapter.stroke } },
      { selector: '.patternLeaf', style: { 'background-color': t.stereo.patternLeaf.fill, 'border-color': t.stereo.patternLeaf.stroke, 'border-style': 'dashed' } },
      { selector: 'node.public', style: { 'border-width': 3.5 } },
      { selector: ':parent', style: {
        'text-valign': 'top', 'text-halign': 'center', 'font-size': 12.5, 'font-weight': 'bold',
        'text-margin-y': -6, padding: '16px', 'background-opacity': 1,
      }},
      { selector: '.subsysP', style: { 'background-color': t.subFill, 'border-color': t.subStroke, 'border-width': 1.4, color: t.subText } },
      { selector: '.subsysC', style: { 'background-color': t.subFill, 'border-color': t.subStroke, 'font-weight': 'bold', 'font-size': 12.5, color: t.subText } },
      { selector: '.patternP', style: { 'background-color': t.patFill, 'border-color': t.patStroke, 'border-style': 'dashed', color: t.ink } },
      { selector: 'edge', style: {
        'curve-style': 'bezier', width: 1.7, 'line-color': t.pageEdge,
        'target-arrow-shape': 'triangle', 'target-arrow-color': t.pageEdge, 'arrow-scale': 0.9,
        label: 'data(lbl)', 'font-size': 10, color: t.edgeText,
        'text-background-color': t.bgLabel, 'text-background-opacity': 0.85, 'text-rotation': 'autorotate',
      }},
      { selector: 'edge.cross', style: { 'line-color': t.cross, 'target-arrow-color': t.cross, width: 2.6 } },
      { selector: 'edge.tube', style: { width: 5.5, opacity: 0.55 } },
      { selector: '.dimmed', style: { opacity: 0.13 } },
      { selector: '.hasIssue', style: { 'border-color': t.issue, 'border-style': 'dashed', 'border-width': 3 } },
      { selector: '.sel', style: { 'overlay-color': t.selGlow, 'overlay-opacity': 0.2, 'overlay-padding': 5 } },
      { selector: '.hoverhl', style: { 'overlay-color': t.selGlow, 'overlay-opacity': 0.32, 'overlay-padding': 7 } },
    ];
  }

  function renderLegend() {
    var t = THEMES[state.theme];
    var sw = function (c) { return '<span class="sw" style="background:' + c.fill + ';border-color:' + c.stroke + '"></span>'; };
    document.getElementById('legend').innerHTML =
      sw(t.stereo.entry) + 'Portal/Observer&nbsp; ' + sw(t.stereo.logic) + 'Logic&nbsp; ' +
      sw(t.stereo.data) + 'Data&nbsp; ' + sw(t.stereo.adapter) + 'Adapter&nbsp; ' +
      sw(t.stereo.patternLeaf) + 'Pattern&nbsp; — bold border = published · ' +
      '<span style="color:' + t.cross + '">red edge</span> = boundary hop · thick faded = collapsed tube';
  }

  // ---- graph construction -------------------------------------------------------
  function layout() { return computeLayout(MODEL, state.collapsed); }

  function anchorFor(id, L) {
    var c = compById[id];
    if (!c) return null;
    if (state.collapsed[c.subsystem]) return SN(c.subsystem);
    if (c.owner && state.collapsed[c.owner]) return CN(c.owner);
    if (L.boxes[id]) return CN(id);
    return null;
  }

  function buildElements() {
    var L = layout();
    var eles = [];
    var dimmedAnchors = {};

    MODEL.subsystems.forEach(function (sub) {
      var sb = L.subs[sub.id];
      var dim = state.query && !MODEL.components.some(function (c) { return c.subsystem === sub.id && matches(c); });
      if (dim) dimmedAnchors[SN(sub.id)] = true;
      var extra = (dim ? ' dimmed' : '') + (state.showIssues && issuesBySpec[sub.id] ? ' hasIssue' : '')
        + (state.selectedKind === 'subsystem' && state.selected === sub.id ? ' sel' : '');
      if (sb.collapsed) {
        eles.push({
          data: { id: SN(sub.id), label: sub.name + '\\n(collapsed \\u25B8)', w: sb.w, h: sb.h, tw: sb.w - 20 },
          position: { x: sb.x + sb.w / 2, y: sb.y + sb.h / 2 },
          classes: 'subsysC boundary' + extra,
        });
      } else {
        eles.push({ data: { id: SN(sub.id), label: sub.name, w: sb.w, h: sb.h, tw: sb.w - 20 }, classes: 'subsysP boundary' + extra });
      }
    });

    var visible = Object.keys(L.boxes);
    var patterns = visible.filter(function (id) { var c = compById[id]; return PATTERN_TYPES[c.componentType] && c.owns.length && !state.collapsed[id]; });
    var leaves = visible.filter(function (id) { return patterns.indexOf(id) < 0; });

    patterns.forEach(function (id) {
      var c = compById[id], b = L.boxes[id];
      var dim = state.query && !matches(c);
      if (dim) dimmedAnchors[CN(id)] = true;
      eles.push({
        data: { id: CN(id), label: c.name + '  \\u00AB' + c.componentType + '\\u00BB', parent: SN(c.subsystem), w: b.w, h: b.h, tw: b.w - 16 },
        classes: 'patternP boundary' + (dim ? ' dimmed' : '') + (state.showIssues && issuesBySpec[id] ? ' hasIssue' : '') + (state.selectedKind === 'component' && state.selected === id ? ' sel' : ''),
      });
    });

    leaves.forEach(function (id) {
      var c = compById[id], b = L.boxes[id];
      var parent = (c.owner && !state.collapsed[c.owner] && L.boxes[c.owner]) ? CN(c.owner) : SN(c.subsystem);
      var collapsedPattern = PATTERN_TYPES[c.componentType] && c.owns.length && state.collapsed[id];
      var dim = state.query && !matches(c);
      if (dim) dimmedAnchors[CN(id)] = true;
      var label = c.name + '\\n\\u00AB' + c.componentType + (c.portalType ? '/' + c.portalType : '') + '\\u00BB' + (collapsedPattern ? ' \\u25B8' : '');
      eles.push({
        data: { id: CN(id), label: label, parent: parent, w: b.w, h: b.h, tw: b.w - 14 },
        position: { x: b.x + b.w / 2, y: b.y + b.h / 2 },
        classes: stereoClass(c.componentType)
          + (c.public ? ' public' : '')
          + (collapsedPattern ? ' boundary' : '')
          + (dim ? ' dimmed' : '')
          + (state.showIssues && issuesBySpec[id] ? ' hasIssue' : '')
          + (state.selectedKind === 'component' && state.selected === id ? ' sel' : ''),
      });
    });

    // aggregated edges between visible anchors — dimmed when either endpoint is
    var agg = {};
    MODEL.edges.forEach(function (e) {
      var a = anchorFor(e.from, L), b = anchorFor(e.to, L);
      if (!a || !b || a === b) return;
      var key = a + '=>' + b;
      if (!agg[key]) agg[key] = { a: a, b: b, n: 0, cross: false, tube: a !== CN(e.from) || b !== CN(e.to) };
      agg[key].n++;
      if (e.cross) agg[key].cross = true;
    });
    var i = 0;
    Object.keys(agg).forEach(function (key) {
      var e = agg[key];
      var dim = state.query && (dimmedAnchors[e.a] || dimmedAnchors[e.b]);
      eles.push({
        data: { id: 'e' + (i++), source: e.a, target: e.b, lbl: e.tube && e.n > 1 ? e.n + ' links' : '' },
        classes: 'dep' + (e.cross ? ' cross' : '') + (e.tube ? ' tube' : '') + (dim ? ' dimmed' : ''),
      });
    });

    return eles;
  }

  // ---- cytoscape init ----------------------------------------------------------
  document.body.setAttribute('data-theme', state.theme);
  renderLegend();

  var cy = cytoscape({
    container: document.getElementById('cy'),
    elements: buildElements(),
    style: buildStyle(THEMES[state.theme]),
    layout: { name: 'preset' },
    wheelSensitivity: 0.2,
    minZoom: 0.08,
    maxZoom: 3,
    boxSelectionEnabled: false,
    autounselectify: true,
  });
  cy.autolock(true);
  applySavedPositions();
  cy.fit(undefined, 40);

  function applySavedPositions() {
    var pos = saved.positions || {};
    cy.nodes().forEach(function (n) {
      if (!n.isParent() && pos[n.id()]) {
        var locked = n.locked();
        if (locked) n.unlock();
        n.position(pos[n.id()]);
        if (locked) n.lock();
      }
    });
  }

  function rebuild() {
    cy.batch(function () {
      cy.elements().remove();
      cy.add(buildElements());
    });
    applySavedPositions();
  }

  function harvestPositions() {
    var pos = saved.positions || {};
    cy.nodes().forEach(function (n) {
      if (!n.isParent()) pos[n.id()] = { x: n.position('x'), y: n.position('y') };
    });
    saved.positions = pos;
    persist();
  }

  // Layout in {boxes, subs} shape from CURRENT node positions (for exports).
  function harvestLayout() {
    var boxes = {}, subs = {};
    MODEL.components.forEach(function (c) {
      var n = cy.getElementById(CN(c.id));
      if (!n.length) return;
      var bb = n.boundingBox({ includeLabels: false, includeOverlays: false });
      boxes[c.id] = { x: bb.x1, y: bb.y1, w: bb.w, h: bb.h };
    });
    MODEL.subsystems.forEach(function (s) {
      var n = cy.getElementById(SN(s.id));
      if (!n.length) return;
      var bb = n.boundingBox({ includeLabels: false, includeOverlays: false });
      subs[s.id] = { x: bb.x1, y: bb.y1, w: bb.w, h: bb.h, collapsed: !!state.collapsed[s.id] };
    });
    return { boxes: boxes, subs: subs };
  }

  // ---- interactions -----------------------------------------------------------
  function idOf(node) {
    var raw = node.id();
    return { kind: raw.charAt(0) === 's' ? 'subsystem' : 'component', id: raw.slice(2) };
  }

  cy.on('tap', 'node', function (ev) { var t = idOf(ev.target); select(t.kind, t.id, false); });
  cy.on('tap', function (ev) { if (ev.target === cy) select(null, null, false); });
  cy.on('dbltap', 'node', function (ev) {
    var t = idOf(ev.target);
    if (t.kind === 'subsystem') { state.collapsed[t.id] = !state.collapsed[t.id]; persist(); rebuild(); return; }
    var c = compById[t.id];
    if (c && PATTERN_TYPES[c.componentType] && c.owns.length) { state.collapsed[t.id] = !state.collapsed[t.id]; persist(); rebuild(); }
  });
  cy.on('dragfree', 'node', function () { harvestPositions(); });

  document.getElementById('search').addEventListener('input', function (ev) { state.query = ev.target.value.trim(); rebuild(); });
  document.getElementById('issuesToggle').addEventListener('change', function (ev) { state.showIssues = ev.target.checked; rebuild(); renderPanel(); });
  document.getElementById('dragToggle').addEventListener('change', function (ev) { cy.autolock(!ev.target.checked); });
  document.getElementById('fitBtn').addEventListener('click', function () { cy.fit(undefined, 40); });
  document.getElementById('resetBtn').addEventListener('click', function () {
    saved.positions = {};
    persist();
    rebuild();
    cy.fit(undefined, 40);
  });

  // View levels
  var viewSeg = document.getElementById('viewSeg');
  function setView(level) {
    state.collapsed = {};
    if (level === 'system') {
      MODEL.subsystems.forEach(function (s) { state.collapsed[s.id] = true; });
    } else if (level === 'components') {
      MODEL.components.forEach(function (c) { if (PATTERN_TYPES[c.componentType] && c.owns.length) state.collapsed[c.id] = true; });
    }
    persist();
    rebuild();
    cy.fit(undefined, 40);
    var btns = viewSeg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].classList) btns[i].classList[btns[i].getAttribute('data-view') === level ? 'add' : 'remove']('active');
    }
  }
  (function () {
    var btns = viewSeg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      (function (b) { b.addEventListener('click', function () { setView(b.getAttribute('data-view')); }); })(btns[i]);
    }
  })();

  // Theme toggle
  document.getElementById('themeBtn').addEventListener('click', function () {
    state.theme = state.theme === 'syw' ? 'light' : 'syw';
    document.body.setAttribute('data-theme', state.theme);
    cy.style(buildStyle(THEMES[state.theme]));
    renderLegend();
    persist();
  });

  // Presentation mode
  function setPresentation(on) {
    if (document.body.classList) document.body.classList[on ? 'add' : 'remove']('presentation');
    if (inBrowser) {
      try {
        if (on && document.documentElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
        else if (!on && document.exitFullscreen && document.fullscreenElement) document.exitFullscreen();
      } catch (e) { /* fullscreen unavailable — mode still works */ }
    }
    setTimeout(function () { cy.resize(); cy.fit(undefined, 30); }, 60);
  }
  document.getElementById('presentBtn').addEventListener('click', function () { setPresentation(true); });
  document.getElementById('exitPresent').addEventListener('click', function () { setPresentation(false); });

  // Export dropdown
  var dd = document.getElementById('exportDd');
  document.getElementById('exportBtn').addEventListener('click', function (ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    if (dd.classList) dd.classList.toggle('open');
  });
  if (document.addEventListener) {
    document.addEventListener('click', function () { if (dd.classList) dd.classList.remove('open'); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        var modal = document.getElementById('flowModal');
        if (modal.classList && String(modal.className).indexOf('open') >= 0) { closeFlow(); return; }
        setPresentation(false);
        if (dd.classList) dd.classList.remove('open');
      }
    });
  }
  function fileBase() { return String(MODEL.system.name).replace(/\\s+/g, '-').toLowerCase(); }
  function downloadText(name, text, mime) {
    if (!inBrowser) return;
    var blob = new Blob([text], { type: mime });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }
  document.getElementById('expPng').addEventListener('click', function () {
    if (!inBrowser) return;
    var uri = cy.png({ full: true, scale: 2, bg: THEMES[state.theme].png });
    var a = document.createElement('a');
    a.href = uri; a.download = fileBase() + '-architecture.png';
    document.body.appendChild(a); a.click(); a.remove();
  });
  document.getElementById('expDrawio').addEventListener('click', function () {
    downloadText(fileBase() + '-architecture.drawio', buildDrawioXml(MODEL, harvestLayout()), 'application/xml');
  });
  document.getElementById('expExcalidraw').addEventListener('click', function () {
    downloadText(fileBase() + '-architecture.excalidraw', buildExcalidrawScene(MODEL, harvestLayout()), 'application/json');
  });

  // ---- narrative flowchart modal ------------------------------------------------
  var flowCy = null;
  var flowStack = [];
  function narrativeFor(compId, method) {
    var c = compById[compId];
    if (!c) return null;
    for (var i = 0; i < c.narratives.length; i++) {
      if (c.narratives[i].method === method) return c.narratives[i];
    }
    return null;
  }
  function renderFlow() {
    var top = flowStack[flowStack.length - 1];
    var c = compById[top.comp];
    var narrative = narrativeFor(top.comp, top.method);
    var t = THEMES[state.theme];
    document.getElementById('flowCrumb').innerHTML = flowStack.map(function (f, i) {
      var s = f.comp + '.' + f.method + '()';
      return i === flowStack.length - 1 ? s : '<span class="dimc">' + s + ' → </span>';
    }).join('');
    document.getElementById('flowBack').style.display = flowStack.length > 1 ? '' : 'none';

    var eles = [];
    eles.push({ data: { id: 'start', label: (c ? c.name : top.comp) + '.' + top.method + '()', w: 280, h: 44, tw: 260 }, position: { x: 0, y: 0 }, classes: 'flowstart' });
    var prev = 'start';
    (narrative ? narrative.steps : []).forEach(function (s, i) {
      var id = 'step' + i;
      var isCall = !!s.call;
      var callable = isCall && !!narrativeFor(s.call.component, s.call.method);
      var label = s.n + '. ' + s.text + (isCall ? '\\n\\u2192 ' + s.call.component + '.' + s.call.method + '()' + (callable ? '  \\u21B4' : '') : '');
      eles.push({
        data: { id: id, label: label, w: 300, h: isCall ? 58 : 46, tw: 280, callComp: isCall ? s.call.component : '', callMethod: isCall ? s.call.method : '' },
        position: { x: 0, y: (i + 1) * 86 },
        classes: (isCall ? 'flowcall' : 'flowlocal') + (callable ? ' drill' : ''),
      });
      eles.push({ data: { id: 'fe' + i, source: prev, target: id } });
      prev = id;
    });

    var style = [
      { selector: 'node', style: { shape: 'round-rectangle', width: 'data(w)', height: 'data(h)', label: 'data(label)', 'text-wrap': 'wrap', 'text-max-width': 'data(tw)', 'font-size': 11, 'font-family': 'Inter, system-ui, sans-serif', color: t.ink, 'text-valign': 'center', 'border-width': 1.5 } },
      { selector: '.flowstart', style: { 'background-color': t.stereo.entry.fill, 'border-color': t.stereo.entry.stroke, 'font-weight': 'bold' } },
      { selector: '.flowlocal', style: { 'background-color': t.patFill, 'border-color': t.patStroke } },
      { selector: '.flowcall', style: { 'background-color': t.stereo.logic.fill, 'border-color': t.stereo.logic.stroke } },
      { selector: '.drill', style: { 'border-width': 2.5 } },
      { selector: 'edge', style: { 'curve-style': 'bezier', width: 1.6, 'line-color': t.pageEdge, 'target-arrow-shape': 'triangle', 'target-arrow-color': t.pageEdge } },
    ];

    if (!flowCy) {
      flowCy = cytoscape({ container: document.getElementById('flowCy'), elements: eles, style: style, layout: { name: 'preset' }, wheelSensitivity: 0.2, boxSelectionEnabled: false, autounselectify: true });
      flowCy.on('tap', 'node.drill', function (ev) {
        var d = ev.target.data();
        flowStack.push({ comp: d.callComp, method: d.callMethod });
        renderFlow();
      });
    } else {
      flowCy.batch(function () { flowCy.elements().remove(); flowCy.add(eles); });
      flowCy.style(style);
    }
    flowCy.fit(undefined, 30);
  }
  function openFlow(compId, method) {
    flowStack = [{ comp: compId, method: method }];
    var modal = document.getElementById('flowModal');
    if (modal.classList) modal.classList.add('open');
    renderFlow();
    setTimeout(function () { if (flowCy) { flowCy.resize(); flowCy.fit(undefined, 30); } }, 60);
  }
  function closeFlow() {
    var modal = document.getElementById('flowModal');
    if (modal.classList) modal.classList.remove('open');
  }
  document.getElementById('flowClose').addEventListener('click', closeFlow);
  document.getElementById('flowBack').addEventListener('click', function () { if (flowStack.length > 1) { flowStack.pop(); renderFlow(); } });
  document.getElementById('flowPng').addEventListener('click', function () {
    if (!flowCy || !inBrowser) return;
    var top = flowStack[flowStack.length - 1];
    var uri = flowCy.png({ full: true, scale: 2, bg: THEMES[state.theme].png });
    var a = document.createElement('a');
    a.href = uri; a.download = (top.comp + '.' + top.method + '-flow.png');
    document.body.appendChild(a); a.click(); a.remove();
  });

  // ---- detail sidebar -------------------------------------------------------------
  var panel = document.getElementById('panel');
  function esc(s) { var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
  function chip(label, kind, target) {
    return '<span class="chip" data-kind="' + kind + '" data-id="' + esc(target) + '">' + esc(label) + '</span>';
  }
  function staticChip(label) { return '<span class="chip">' + esc(label) + '</span>'; }
  function section(title, count, inner, open) {
    return '<details' + (open ? ' open' : '') + '><summary>' + esc(title)
      + (count !== null ? '<span class="count">' + count + '</span>' : '') + '</summary><div class="inner">' + inner + '</div></details>';
  }
  function issueHtml(list) {
    return list.map(function (i) {
      return '<div class="issue ' + esc(i.severity) + '"><code>' + esc(i.code) + '</code><br>' + esc(i.message) + '</div>';
    }).join('');
  }

  function select(kind, id, focus) {
    state.selectedKind = kind;
    state.selected = id;
    cy.nodes().removeClass('sel');
    if (id) {
      var node = cy.getElementById(kind === 'subsystem' ? SN(id) : CN(id));
      if (node.length) {
        node.addClass('sel');
        if (focus) cy.animate({ center: { eles: node }, duration: 250 });
      }
    }
    renderPanel();
  }

  function renderPanel() {
    var head = '', body = '';
    if (state.selectedKind === 'component' && compById[state.selected]) {
      var c = compById[state.selected];
      head = '<h2>' + esc(c.name) + '</h2>'
        + staticChip('\\u00AB' + c.componentType + (c.portalType ? '/' + c.portalType : '') + '\\u00BB')
        + (c.public ? staticChip('published') : '')
        + (c.status ? staticChip(c.status) : '')
        + chip(c.subsystem, 'subsystem', c.subsystem);
      body += '<p class="desc">' + esc(c.description) + '</p>';

      var depInner = (c.dependsOn.length ? c.dependsOn.map(function (d) { return chip(d, 'component', d); }).join('') : '<span class="desc">none</span>')
        + (c.owns.length ? '<div style="margin-top:8px"><b style="font-size:11px">Owns:</b><br>' + c.owns.map(function (d) { return chip(d, 'component', d); }).join('') + '</div>' : '');
      body += section('Dependencies', c.dependsOn.length + c.owns.length, depInner, true);

      var methodCount = 0;
      var intfInner = c.interfaces.map(function (intf) {
        methodCount += intf.methods.length;
        return '<div style="margin:6px 0 2px"><b>' + esc(intf.name) + '</b> <code style="font-size:10.5px;display:inline">' + esc(intf.id) + '</code></div>'
          + intf.methods.map(function (m) {
            var hasFlow = !!narrativeFor(c.id, m.name);
            return '<div class="method"><div class="mname">' + esc(m.name)
              + (hasFlow ? '<button class="flowbtn" data-flow-comp="' + esc(c.id) + '" data-flow-method="' + esc(m.name) + '">flow \\u25F7</button>' : '')
              + '</div>'
              + '<code>' + esc(m.signature) + '</code>'
              + '<div class="mdesc">' + esc(m.description) + ' \\u2014 returns <code style="display:inline">' + esc(m.returns) + '</code></div>'
              + (m.params ? '<div class="mdesc">params: ' + m.params.map(function (p) { return esc(p.name) + ': ' + esc(p.type); }).join(', ') + '</div>' : '')
              + (m.endpoint ? '<code>' + esc(JSON.stringify(m.endpoint)) + '</code>' : '')
              + (m.guarantees ? '<div style="margin-top:4px">' + m.guarantees.map(staticChip).join('') + '</div>' : '')
              + '</div>';
          }).join('');
      }).join('');
      if (c.interfaces.length) body += section('Interfaces', methodCount, intfInner, false);

      if (c.narratives.length) {
        var narInner = c.narratives.map(function (n) {
          return '<div class="method"><div class="mname">' + esc(n.method) + '()'
            + '<button class="flowbtn" data-flow-comp="' + esc(c.id) + '" data-flow-method="' + esc(n.method) + '">flow \\u25F7</button></div>'
            + n.steps.map(function (s) {
              return '<div class="step">' + s.n + '. ' + esc(s.text)
                + (s.call ? ' \\u2192 <span class="call" data-kind="component" data-id="' + esc(s.call.component) + '">' + esc(s.call.component) + '.' + esc(s.call.method) + '()</span>' : '')
                + '</div>';
            }).join('')
            + '</div>';
        }).join('');
        body += section('Narratives (L5)', c.narratives.length, narInner, false);
      }

      var iss = issuesBySpec[c.id];
      if (iss) body += section('Validation issues', iss.length, issueHtml(iss), true);
    } else if (state.selectedKind === 'subsystem' && subById[state.selected]) {
      var s = subById[state.selected];
      head = '<h2>' + esc(s.name) + '</h2>' + staticChip('subsystem')
        + (s.targetLanguage ? staticChip(s.targetLanguage) : '')
        + (s.status ? staticChip(s.status) : '');
      body += '<p class="desc">' + esc(s.description) + '</p>';
      if (s.trustedLinks.length) {
        body += section('Trusted links (fast lanes)', s.trustedLinks.length, s.trustedLinks.map(function (t2) {
          return '<div class="method">' + chip(t2.subsystem, 'subsystem', t2.subsystem) + '<div class="mdesc">' + esc(t2.reason) + '</div></div>';
        }).join(''), true);
      }
      var comps = MODEL.components.filter(function (c2) { return c2.subsystem === s.id; });
      body += section('Components', comps.length, comps.map(function (c2) { return chip(c2.id, 'component', c2.id); }).join(''), true);
      var iss2 = issuesBySpec[s.id];
      if (iss2) body += section('Validation issues', iss2.length, issueHtml(iss2), true);
    } else {
      head = '<h2>' + esc(MODEL.system.name) + '</h2>'
        + (MODEL.system.targetLanguage ? staticChip(MODEL.system.targetLanguage) : '')
        + staticChip(MODEL.subsystems.length + ' subsystems')
        + staticChip(MODEL.components.length + ' components');
      if (MODEL.system.vision) body += '<p class="desc">' + esc(MODEL.system.vision) + '</p>';
      body += '<p class="desc">Click any component, pattern, or subsystem for details. Derived from <code style="display:inline">.wai/specs/</code> \\u2014 the same source of truth as the conformance gate.</p>';
      if (state.showIssues && MODEL.issues.length) body += section('All validation issues', MODEL.issues.length, issueHtml(MODEL.issues), true);
    }
    panel.innerHTML = '<div class="head">' + head + '</div><div class="body">' + body + '</div>';

    var navs = panel.querySelectorAll('[data-kind]');
    for (var i = 0; i < navs.length; i++) {
      (function (n) {
        n.addEventListener('click', function () { select(n.getAttribute('data-kind'), n.getAttribute('data-id'), true); });
        n.addEventListener('mouseenter', function () {
          var kind = n.getAttribute('data-kind'), id = n.getAttribute('data-id');
          var node = cy.getElementById(kind === 'subsystem' ? SN(id) : CN(id));
          if (node.length) node.addClass('hoverhl');
        });
        n.addEventListener('mouseleave', function () { cy.nodes().removeClass('hoverhl'); });
      })(navs[i]);
    }
    var flows = panel.querySelectorAll('[data-flow-comp]');
    for (var j = 0; j < flows.length; j++) {
      (function (b) {
        b.addEventListener('click', function (ev) {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          openFlow(b.getAttribute('data-flow-comp'), b.getAttribute('data-flow-method'));
        });
      })(flows[j]);
    }
  }

  renderPanel();
})();
</script>
</body>
</html>
`;
