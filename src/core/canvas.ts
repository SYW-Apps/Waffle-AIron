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
import { buildDrawioXml, buildExcalidrawScene } from './diagram-export.js';

// ---------------------------------------------------------------------------
// Interactive architecture canvas — a self-contained single-page app with
// C4-style scoped navigation.
//
// One HTML file, zero network: Cytoscape.js is vendored inline, and the
// export builders (buildDrawioXml / buildExcalidrawScene) are serialized
// verbatim from their TypeScript modules — in-browser exports use the
// CURRENT view and positions.
//
// Navigation model: a VIEW renders exactly one scope's direct children —
// System → top-level subsystems → a subsystem's children (nested subsystems
// + components) → a pattern's members, infinitely deep by ownership.
// Double-click drills in; the breadcrumb navigates back out. "Internals"
// previews each child's own children inside its box (one level); "Externals"
// shows ghost references to out-of-scope dependencies. Per-view layout
// rearrangements persist in localStorage.
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
* { box-sizing: border-box; }

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

header { display:flex; align-items:center; gap:10px; padding:0 14px; height:52px; background:var(--chrome); border-bottom:1px solid var(--chrome-border); position:relative; z-index:20; }
header .brand { font-weight:800; font-size:17px; letter-spacing:.02em; }
#crumbs { display:flex; align-items:center; gap:4px; max-width:34vw; overflow-x:auto; white-space:nowrap; scrollbar-width:thin; }
#crumbs .crumb { border:none; background:transparent; color:var(--dim); cursor:pointer; font:inherit; font-size:12.5px; padding:4px 7px; border-radius:7px; }
#crumbs .crumb:hover { background:var(--hover-bg); color:var(--ink); }
#crumbs .crumb.cur { color:var(--ink); font-weight:700; cursor:default; }
#crumbs .sep { color:var(--dim); font-size:11px; }
header .divider { width:1px; height:24px; background:var(--line); margin:0 2px; }
header input[type="search"] { padding:6px 10px; border:1px solid var(--chrome-border); border-radius:8px; width:170px; font:inherit; background:var(--input-bg); color:var(--ink); }
header input[type="search"]::placeholder { color:var(--dim); }
.switch { display:inline-flex; align-items:center; gap:6px; cursor:pointer; color:var(--dim); font-size:12px; white-space:nowrap; user-select:none; padding:5px 8px; border-radius:8px; }
.switch:hover { background:var(--hover-bg); color:var(--ink); }
.switch input { accent-color:var(--accent); margin:0; }
.tbtn { border:1px solid var(--chrome-border); background:var(--input-bg); color:var(--ink); padding:6px 11px; border-radius:8px; cursor:pointer; font:inherit; font-size:12px; white-space:nowrap; }
.tbtn:hover { background:var(--hover-bg); border-color:var(--accent); }
.spacer { flex:1; }

.dropdown { position:relative; }
.dropdown .menu { display:none; position:absolute; right:0; top:calc(100% + 6px); background:var(--chrome); border:1px solid var(--chrome-border); border-radius:10px; box-shadow:var(--syw-deep-shadow); min-width:200px; padding:6px; z-index:50; }
.dropdown.open .menu { display:block; }
.dropdown .menu button { display:block; width:100%; text-align:left; border:none; background:transparent; color:var(--ink); padding:8px 10px; border-radius:7px; cursor:pointer; font:inherit; font-size:12.5px; }
.dropdown .menu button:hover { background:var(--hover-bg); }
.dropdown .menu .hint { display:block; color:var(--dim); font-size:10.5px; }

#wrap { display:flex; height:calc(100vh - 52px); }
#stage { flex:1; position:relative; }
#cy { position:absolute; inset:0; }
.legend { position:absolute; left:12px; bottom:12px; background:var(--chrome); border:1px solid var(--chrome-border); border-radius:10px; padding:8px 12px; font-size:11px; color:var(--dim); z-index:5; pointer-events:none; }
.legend .sw { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:4px; vertical-align:-1px; border:1.5px solid; }
.viewhint { position:absolute; top:10px; left:12px; color:var(--dim); font-size:11px; background:var(--chrome); border:1px solid var(--chrome-border); border-radius:9px; padding:5px 10px; z-index:5; pointer-events:none; }

#panel { width:380px; border-left:1px solid var(--chrome-border); background:var(--chrome); overflow-y:auto; z-index:10; }
#panel .head { padding:16px 18px 10px; border-bottom:1px solid var(--line); }
#panel .head h2 { font-size:16px; margin:0 0 6px; }
#panel .body { padding:12px 18px 30px; }
#panel .chip { display:inline-block; padding:2px 9px; border-radius:11px; font-size:11px; border:1px solid var(--chrome-border); margin:0 4px 5px 0; background:var(--input-bg); color:var(--ink); }
#panel .chip[data-kind] { cursor:pointer; }
#panel .chip[data-kind]:hover { border-color:var(--accent); background:var(--hover-bg); }
#panel .desc { color:var(--dim); margin:8px 0 2px; }
#panel .openbtn { margin:6px 0 0; }
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

body.presentation header, body.presentation #panel, body.presentation .legend { display:none; }
body.presentation #wrap { height:100vh; }
#exitPresent { display:none; position:fixed; top:10px; right:10px; z-index:100; border:1px solid var(--chrome-border); background:var(--chrome); color:var(--ink); border-radius:9px; padding:7px 13px; cursor:pointer; opacity:0.06; transition:opacity .15s ease; font:inherit; }
#exitPresent:hover { opacity:1; box-shadow:var(--syw-glow); }
body.presentation #exitPresent { display:block; }

#flowModal { display:none; position:fixed; inset:0; background:rgba(4,6,12,0.6); backdrop-filter:blur(3px); z-index:80; align-items:center; justify-content:center; }
#flowModal.open { display:flex; }
#flowModal .box { width:min(860px, 92vw); height:min(640px, 88vh); background:var(--chrome); border:1px solid var(--chrome-border); border-radius:14px; box-shadow:var(--syw-deep-shadow); display:flex; flex-direction:column; overflow:hidden; }
#flowModal .bar { display:flex; align-items:center; gap:10px; padding:10px 14px; border-bottom:1px solid var(--line); }
#flowModal .bar .crumbf { font-weight:700; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#flowModal .bar .crumbf .dimc { color:var(--dim); font-weight:400; }
#flowCy { flex:1; }
#flowModal .hintbar { padding:6px 14px; color:var(--dim); font-size:11px; border-top:1px solid var(--line); }
</style>
</head>
<body data-theme="syw">
<header>
  <span class="brand syw-gradient-text">wairon</span>
  <nav id="crumbs"></nav>
  <span class="divider"></span>
  <input id="search" type="search" placeholder="Search this view…">
  <label class="switch" title="Preview each child's own children inside its box"><input type="checkbox" id="internalsToggle"><span>Internals</span></label>
  <label class="switch" title="Show out-of-scope dependencies as ghost references"><input type="checkbox" id="externalsToggle" checked><span>Externals</span></label>
  <label class="switch"><input type="checkbox" id="issuesToggle"><span>Issues (<span id="issueCount"></span>)</span></label>
  <label class="switch"><input type="checkbox" id="dragToggle"><span>Rearrange</span></label>
  <span class="spacer"></span>
  <button class="tbtn" id="fitBtn" title="Fit graph to view">Fit</button>
  <button class="tbtn" id="resetBtn" title="Discard this view's saved rearrangement">Reset layout</button>
  <div class="dropdown" id="exportDd">
    <button class="tbtn" id="exportBtn">Export ▾</button>
    <div class="menu">
      <button id="expPng">PNG image <span class="hint">this view, high-res</span></button>
      <button id="expDrawio">draw.io file <span class="hint">this view, editable, current layout</span></button>
      <button id="expExcalidraw">Excalidraw file <span class="hint">this view, editable, current layout</span></button>
    </div>
  </div>
  <button class="tbtn" id="themeBtn" title="Toggle theme">◐ Theme</button>
  <button class="tbtn" id="presentBtn" title="Presentation mode (hides menus)">⛶ Present</button>
</header>
<div id="wrap">
  <div id="stage">
    <div id="cy"></div>
    <div class="viewhint" id="viewHint"></div>
    <div class="legend" id="legend"></div>
  </div>
  <div id="panel"></div>
</div>
<button id="exitPresent">✕ Exit presentation</button>
<div id="flowModal">
  <div class="box">
    <div class="bar">
      <button class="tbtn" id="flowBack" title="Back to the calling narrative">← Back</button>
      <span class="crumbf" id="flowCrumb"></span>
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
  var buildDrawioXml = __DRAWIO_FN__;
  var buildExcalidrawScene = __EXCALIDRAW_FN__;

  var store = (typeof localStorage !== 'undefined') ? localStorage : null;
  var inBrowser = (typeof window !== 'undefined');
  var STORE_KEY = 'wairon:canvas2:' + MODEL.system.name;

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

  // ---- ownership hierarchy ----------------------------------------------------
  function topSubsystems() {
    return MODEL.subsystems.filter(function (s) { return s.id.indexOf('::') < 0; });
  }
  function childSubsOf(subId) {
    var prefix = subId + '::';
    return MODEL.subsystems.filter(function (s) {
      return s.id.indexOf(prefix) === 0 && s.id.slice(prefix.length).indexOf('::') < 0;
    });
  }
  function childCompsOf(subId) {
    return MODEL.components.filter(function (c) { return c.subsystem === subId && !c.owner; });
  }
  function memberCompsOf(compId) {
    var c = compById[compId];
    return c ? c.owns.map(function (id) { return compById[id]; }).filter(Boolean) : [];
  }
  // children of a scope, as {kind, id, hasKids} entries
  function childrenOf(scope) {
    var out = [];
    if (scope.kind === 'system') {
      topSubsystems().forEach(function (s) { out.push({ kind: 'subsystem', id: s.id }); });
    } else if (scope.kind === 'subsystem') {
      childSubsOf(scope.id).forEach(function (s) { out.push({ kind: 'subsystem', id: s.id }); });
      childCompsOf(scope.id).forEach(function (c) { out.push({ kind: 'component', id: c.id }); });
    } else if (scope.kind === 'component') {
      memberCompsOf(scope.id).forEach(function (c) { out.push({ kind: 'component', id: c.id }); });
    }
    out.forEach(function (e) {
      e.hasKids = e.kind === 'subsystem'
        ? (childSubsOf(e.id).length + childCompsOf(e.id).length) > 0
        : memberCompsOf(e.id).length > 0;
    });
    return out;
  }
  // is a component inside the subtree of a scope entry?
  function subsystemChainOf(comp) {
    // list of subsystem ids from top to comp's subsystem (namespaced ancestry)
    var segs = comp.subsystem.split('::');
    var out = [];
    for (var i = 1; i <= segs.length; i++) out.push(segs.slice(0, i).join('::'));
    return out;
  }
  function ownerChainOf(comp) {
    var out = [];
    var cur = comp;
    while (cur && cur.owner) { out.unshift(cur.owner); cur = compById[cur.owner]; }
    return out;
  }
  // The direct-child-of-scope entry containing comp, or null if outside scope.
  function childOfScopeContaining(compId, scope) {
    var c = compById[compId];
    if (!c) return null;
    var subs = subsystemChainOf(c);
    var owners = ownerChainOf(c);
    if (scope.kind === 'system') {
      return { kind: 'subsystem', id: subs[0] };
    }
    if (scope.kind === 'subsystem') {
      var idx = subs.indexOf(scope.id);
      if (idx < 0) return null;
      if (idx < subs.length - 1) return { kind: 'subsystem', id: subs[idx + 1] };
      // comp lives directly in this subsystem — its child anchor is its top owner or itself
      return { kind: 'component', id: owners.length ? owners[0] : c.id };
    }
    // component scope: comp must be a descendant member
    var chain = owners.concat([c.id]);
    var pos = chain.indexOf(scope.id);
    if (pos < 0 || pos === chain.length - 1) return null;
    return { kind: 'component', id: chain[pos + 1] };
  }
  function anchorNodeId(entry) { return entry.kind === 'subsystem' ? SN(entry.id) : CN(entry.id); }
  function nameOf(entry) {
    if (entry.kind === 'subsystem') { var s = subById[entry.id]; return s ? s.name : entry.id; }
    var c = compById[entry.id]; return c ? c.name : entry.id;
  }

  // ---- persisted state -------------------------------------------------------
  var saved = { positionsByView: {}, theme: 'syw' };
  try { if (store && store.getItem(STORE_KEY)) saved = JSON.parse(store.getItem(STORE_KEY)) || saved; } catch (e) { /* ignore */ }

  var state = {
    view: { kind: 'system', id: null },
    internals: false,
    externals: true,
    showIssues: false,
    query: '',
    selected: null,
    selectedKind: null,
    theme: saved.theme === 'light' ? 'light' : 'syw',
  };

  function viewKey() {
    return state.view.kind + ':' + (state.view.id || 'root') + (state.internals ? '+i' : '');
  }
  function persist() {
    if (!store) return;
    try { store.setItem(STORE_KEY, JSON.stringify({ positionsByView: saved.positionsByView || {}, theme: state.theme })); } catch (e) { /* non-fatal */ }
  }

  function matches(entry) {
    if (!state.query) return true;
    var q = state.query.toLowerCase();
    return entry.id.toLowerCase().indexOf(q) >= 0 || nameOf(entry).toLowerCase().indexOf(q) >= 0;
  }

  // ---- themes -----------------------------------------------------------------
  var THEMES = {
    light: {
      pageEdge: '#8d97a5', edgeText: '#57606a', cross: '#c26767', ink: '#1f2328',
      subFill: '#ffffff', subStroke: '#b6c0cc', subText: '#1f2328',
      patFill: '#f6f8fa', patStroke: '#6a737d',
      ghostFill: '#f1f3f5', ghostStroke: '#adb5bd', ghostText: '#868e96',
      innerFill: '#eef1f4', innerStroke: '#c3ccd6',
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
      ghostFill: 'rgba(255,255,255,0.03)', ghostStroke: '#4a5568', ghostText: '#718096',
      innerFill: 'rgba(255,255,255,0.05)', innerStroke: 'rgba(255,255,255,0.18)',
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
      { selector: '.subsysBox', style: { 'background-color': t.subFill, 'border-color': t.subStroke, color: t.subText, 'font-weight': 'bold', 'font-size': 12.5 } },
      { selector: 'node.public', style: { 'border-width': 3.5 } },
      { selector: '.drillable', style: {} },
      { selector: ':parent', style: { 'text-valign': 'top', 'text-halign': 'center', 'font-size': 12, 'font-weight': 'bold', 'text-margin-y': -5, padding: '12px', 'background-opacity': 1 } },
      { selector: '.inner', style: { 'background-color': t.innerFill, 'border-color': t.innerStroke, 'border-width': 1, 'font-size': 9.5, color: t.ink } },
      { selector: '.ghost', style: { 'background-color': t.ghostFill, 'border-color': t.ghostStroke, 'border-style': 'dotted', color: t.ghostText, 'font-size': 10 } },
      { selector: 'edge', style: {
        'curve-style': 'bezier', width: 1.8, 'line-color': t.pageEdge,
        'target-arrow-shape': 'triangle', 'target-arrow-color': t.pageEdge, 'arrow-scale': 0.9,
        label: 'data(lbl)', 'font-size': 10, color: t.edgeText,
        'text-background-color': t.bgLabel, 'text-background-opacity': 0.85, 'text-rotation': 'autorotate',
      }},
      { selector: 'edge.cross', style: { 'line-color': t.cross, 'target-arrow-color': t.cross, width: 2.6 } },
      { selector: 'edge.bundle', style: { width: 4.5, opacity: 0.6 } },
      { selector: 'edge.toghost', style: { 'line-style': 'dashed', opacity: 0.7 } },
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
      sw({ fill: t.subFill, stroke: t.subStroke }) + 'Subsystem&nbsp; ' +
      sw(t.stereo.entry) + 'Portal/Observer&nbsp; ' + sw(t.stereo.logic) + 'Logic&nbsp; ' +
      sw(t.stereo.data) + 'Data&nbsp; ' + sw(t.stereo.adapter) + 'Adapter&nbsp; ' +
      sw(t.stereo.patternLeaf) + 'Pattern&nbsp; ' +
      sw({ fill: t.ghostFill, stroke: t.ghostStroke }) + 'External&nbsp; — bold border = published · ' +
      '<span style="color:' + t.cross + '">red</span> = boundary hop · double-click = open';
  }

  // ---- view layout ---------------------------------------------------------------
  var BOX_W = 200, BOX_H = 56, SUBBOX_W = 230, SUBBOX_H = 84, GAP_X = 110, GAP_Y = 34;
  var INNER_W = 120, INNER_H = 34, INNER_COLS = 2, INNER_GAP = 8, HEAD_H = 34, PADI = 14;

  function innerKidsOf(entry) {
    if (!state.internals || !entry.hasKids) return [];
    return childrenOf({ kind: entry.kind, id: entry.id });
  }
  function sizeOf(entry) {
    var kids = innerKidsOf(entry);
    if (kids.length) {
      var rows = Math.ceil(kids.length / INNER_COLS);
      var w = Math.max(entry.kind === 'subsystem' ? SUBBOX_W : BOX_W, INNER_COLS * (INNER_W + INNER_GAP) + PADI * 2);
      var h = HEAD_H + rows * (INNER_H + INNER_GAP) + PADI;
      return { w: w, h: h };
    }
    return entry.kind === 'subsystem' ? { w: SUBBOX_W, h: SUBBOX_H } : { w: BOX_W, h: BOX_H };
  }

  // Aggregate model edges to view-level edges between child entries (+ externals).
  function viewEdges(scope, entries) {
    var entryByAnchor = {};
    entries.forEach(function (e) { entryByAnchor[e.kind + ':' + e.id] = e; });
    var agg = {}, ghosts = {};
    MODEL.edges.forEach(function (edge) {
      var a = childOfScopeContaining(edge.from, scope);
      var b = childOfScopeContaining(edge.to, scope);
      var aIn = a && entryByAnchor[a.kind + ':' + a.id];
      var bIn = b && entryByAnchor[b.kind + ':' + b.id];
      if (!aIn && !bIn) return; // fully outside this scope
      var src, tgt, ghost = false;
      if (aIn && bIn) {
        if (a.kind === b.kind && a.id === b.id) return; // internal to one child
        src = anchorNodeId(a); tgt = anchorNodeId(b);
      } else if (state.externals) {
        ghost = true;
        if (aIn) {
          var ext = externalAnchorFor(edge.to, scope);
          if (!ext) return;
          ghosts[ext.gid] = ext;
          src = anchorNodeId(a); tgt = ext.gid;
        } else {
          var ext2 = externalAnchorFor(edge.from, scope);
          if (!ext2) return;
          ghosts[ext2.gid] = ext2;
          src = ext2.gid; tgt = anchorNodeId(b);
        }
      } else {
        return;
      }
      var key = src + '=>' + tgt;
      if (!agg[key]) agg[key] = { src: src, tgt: tgt, n: 0, cross: false, ghost: ghost };
      agg[key].n++;
      if (edge.cross) agg[key].cross = true;
    });
    return { agg: agg, ghosts: ghosts };
  }

  // How an out-of-scope element is represented: the nearest "sibling-level" ancestor.
  function externalAnchorFor(compId, scope) {
    var c = compById[compId];
    if (!c) return null;
    // Walk outward from the scope: find the closest enclosing context that DOES contain the target.
    var contexts = [];
    if (scope.kind === 'component') {
      var oc = compById[scope.id];
      var chain = oc ? ownerChainOf(oc) : [];
      for (var i = chain.length - 1; i >= 0; i--) contexts.push({ kind: 'component', id: chain[i] });
      if (oc) subsystemChainOf(oc).reverse().forEach(function (sid) { contexts.push({ kind: 'subsystem', id: sid }); });
    } else if (scope.kind === 'subsystem') {
      var segs = scope.id.split('::');
      for (var j = segs.length - 1; j >= 1; j--) contexts.push({ kind: 'subsystem', id: segs.slice(0, j).join('::') });
    }
    contexts.push({ kind: 'system', id: null });
    for (var k = 0; k < contexts.length; k++) {
      var child = childOfScopeContaining(compId, contexts[k]);
      if (child) {
        return { gid: 'x~' + child.kind + '~' + child.id, kind: child.kind, id: child.id, label: nameOf(child) };
      }
    }
    return null;
  }

  function buildElements() {
    var scope = state.view;
    var entries = childrenOf(scope);
    var eles = [];
    var ve = viewEdges(scope, entries);

    // simple layered placement: layer by aggregated deps among entries
    var layerOf = {};
    function calcLayer(e, stack) {
      var key = anchorNodeId(e);
      if (layerOf[key] !== undefined) return layerOf[key];
      if (stack[key]) return 0;
      stack[key] = 1;
      var l = 0;
      if (e.kind === 'component') {
        var c = compById[e.id];
        if (c && (c.componentType === 'Portal' || c.componentType === 'Observer')) { layerOf[key] = 0; delete stack[key]; return 0; }
      }
      Object.keys(ve.agg).forEach(function (k) {
        var edge = ve.agg[k];
        if (edge.tgt !== key) return;
        var srcEntry = entries.filter(function (x) { return anchorNodeId(x) === edge.src; })[0];
        if (srcEntry) l = Math.max(l, calcLayer(srcEntry, stack) + 1);
      });
      delete stack[key];
      layerOf[key] = l;
      return l;
    }
    entries.forEach(function (e) { calcLayer(e, {}); });
    var cols = {};
    entries.forEach(function (e) { var l = layerOf[anchorNodeId(e)] || 0; (cols[l] = cols[l] || []).push(e); });
    var colKeys = Object.keys(cols).map(Number).sort(function (a, b) { return a - b; });
    var x = 0, maxColH = 0;
    var posByAnchor = {};
    colKeys.forEach(function (ck) {
      var col = cols[ck].sort(function (a, b) { return a.id < b.id ? -1 : 1; });
      var colW = 0, y = 0;
      col.forEach(function (e) { var s = sizeOf(e); colW = Math.max(colW, s.w); });
      col.forEach(function (e) {
        var s = sizeOf(e);
        posByAnchor[anchorNodeId(e)] = { x: x + colW / 2, y: y + s.h / 2, w: s.w, h: s.h };
        y += s.h + GAP_Y;
      });
      maxColH = Math.max(maxColH, y);
      x += colW + GAP_X;
    });

    entries.forEach(function (e) {
      var p = posByAnchor[anchorNodeId(e)];
      var kids = innerKidsOf(e);
      var dim = state.query && !matches(e);
      var classes, label;
      var isPub = e.kind === 'component' && compById[e.id] && compById[e.id].public;
      if (e.kind === 'subsystem') {
        classes = 'subsysBox';
        label = nameOf(e) + (e.hasKids && !kids.length ? '\\n\\u25B8 open' : '');
      } else {
        var c = compById[e.id];
        classes = stereoClass(c.componentType);
        label = c.name + '\\n\\u00AB' + c.componentType + (c.portalType ? '/' + c.portalType : '') + '\\u00BB' + (e.hasKids && !kids.length ? ' \\u25B8' : '');
      }
      classes += (e.hasKids ? ' drillable' : '') + (isPub ? ' public' : '')
        + (dim ? ' dimmed' : '')
        + (state.showIssues && issuesBySpec[e.id] ? ' hasIssue' : '')
        + (state.selectedKind === e.kind && state.selected === e.id ? ' sel' : '');
      if (kids.length) {
        eles.push({ data: { id: anchorNodeId(e), label: (e.kind === 'subsystem' ? nameOf(e) : label.split('\\n')[0]), w: p.w, h: p.h, tw: p.w - 16 }, classes: classes });
        kids.forEach(function (kid, ki) {
          var kc = ki % INNER_COLS, kr = Math.floor(ki / INNER_COLS);
          eles.push({
            data: {
              id: 'i~' + kid.kind + '~' + kid.id, parent: anchorNodeId(e),
              label: nameOf(kid), w: INNER_W, h: INNER_H, tw: INNER_W - 10,
            },
            position: {
              x: p.x - p.w / 2 + PADI + kc * (INNER_W + INNER_GAP) + INNER_W / 2,
              y: p.y - p.h / 2 + HEAD_H + kr * (INNER_H + INNER_GAP) + INNER_H / 2,
            },
            classes: 'inner' + (dim ? ' dimmed' : ''),
          });
        });
      } else {
        eles.push({ data: { id: anchorNodeId(e), label: label, w: p.w, h: p.h, tw: p.w - 14 }, position: { x: p.x, y: p.y }, classes: classes });
      }
    });

    // ghosts column (externals) at far right
    var gx = x + 40, gy = 0;
    Object.keys(ve.ghosts).sort().forEach(function (gid) {
      var g = ve.ghosts[gid];
      eles.push({
        data: { id: gid, label: g.label + '\\n(external)', w: 170, h: 46, tw: 156, extKind: g.kind, extId: g.id },
        position: { x: gx + 85, y: gy + 23 },
        classes: 'ghost',
      });
      gy += 46 + 18;
    });

    var dimmedAnchors = {};
    entries.forEach(function (e) { if (state.query && !matches(e)) dimmedAnchors[anchorNodeId(e)] = true; });
    var i = 0;
    Object.keys(ve.agg).forEach(function (key) {
      var e = ve.agg[key];
      var bundle = e.n > 1;
      var dim = state.query && (dimmedAnchors[e.src] || dimmedAnchors[e.tgt]);
      eles.push({
        data: { id: 'e' + (i++), source: e.src, target: e.tgt, lbl: bundle ? e.n + ' links' : '' },
        classes: (e.cross ? 'cross ' : '') + (bundle ? 'bundle ' : '') + (e.ghost ? 'toghost ' : '') + (dim ? 'dimmed' : ''),
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
  cy.fit(undefined, 50);
  renderCrumbs();
  renderViewHint();

  function applySavedPositions() {
    var pos = (saved.positionsByView || {})[viewKey()] || {};
    cy.nodes().forEach(function (n) {
      if (!n.isParent() && pos[n.id()]) {
        var locked = n.locked();
        if (locked) n.unlock();
        n.position(pos[n.id()]);
        if (locked) n.lock();
      }
    });
  }
  function harvestPositions() {
    var all = saved.positionsByView || {};
    var pos = all[viewKey()] || {};
    cy.nodes().forEach(function (n) { if (!n.isParent()) pos[n.id()] = { x: n.position('x'), y: n.position('y') }; });
    all[viewKey()] = pos;
    saved.positionsByView = all;
    persist();
  }
  function rebuild(fit) {
    cy.batch(function () {
      cy.elements().remove();
      cy.add(buildElements());
    });
    applySavedPositions();
    if (fit) cy.fit(undefined, 50);
    renderCrumbs();
    renderViewHint();
  }

  // Current-view layout in {boxes, subs} shape for the export builders.
  function harvestLayout() {
    var boxes = {}, subs = {};
    cy.nodes().forEach(function (n) {
      var id = n.id();
      var bb = n.boundingBox({ includeLabels: false, includeOverlays: false });
      var box = { x: bb.x1, y: bb.y1, w: bb.w, h: bb.h };
      if (id.indexOf('s~') === 0) subs[id.slice(2)] = { x: box.x, y: box.y, w: box.w, h: box.h, collapsed: true };
      else if (id.indexOf('c~') === 0) boxes[id.slice(2)] = box;
    });
    return { boxes: boxes, subs: subs };
  }

  // ---- navigation -----------------------------------------------------------
  function crumbPath() {
    var path = [{ kind: 'system', id: null, label: MODEL.system.name }];
    var v = state.view;
    if (v.kind === 'subsystem') {
      var segs = v.id.split('::');
      for (var i = 1; i <= segs.length; i++) {
        var sid = segs.slice(0, i).join('::');
        path.push({ kind: 'subsystem', id: sid, label: nameOf({ kind: 'subsystem', id: sid }) });
      }
    } else if (v.kind === 'component') {
      var c = compById[v.id];
      if (c) {
        subsystemChainOf(c).forEach(function (sid) {
          path.push({ kind: 'subsystem', id: sid, label: nameOf({ kind: 'subsystem', id: sid }) });
        });
        ownerChainOf(c).forEach(function (oid) {
          path.push({ kind: 'component', id: oid, label: nameOf({ kind: 'component', id: oid }) });
        });
        path.push({ kind: 'component', id: c.id, label: c.name });
      }
    }
    return path;
  }
  function renderCrumbs() {
    var el = document.getElementById('crumbs');
    var path = crumbPath();
    el.innerHTML = path.map(function (p, i) {
      var cur = i === path.length - 1;
      return '<button class="crumb' + (cur ? ' cur' : '') + '" data-ck="' + p.kind + '" data-ci="' + (p.id || '') + '">' + p.label + '</button>'
        + (cur ? '' : '<span class="sep">\\u203A</span>');
    }).join('');
    var btns = el.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener('click', function () {
          navigateTo(b.getAttribute('data-ck'), b.getAttribute('data-ci') || null);
        });
      })(btns[i]);
    }
  }
  function renderViewHint() {
    var n = childrenOf(state.view).length;
    var what = state.view.kind === 'system' ? 'top-level subsystems'
      : state.view.kind === 'subsystem' ? 'children of this subsystem' : 'members of this pattern';
    document.getElementById('viewHint').textContent = 'View: ' + n + ' ' + what + ' \\u00B7 double-click a box to open it';
  }
  function navigateTo(kind, id) {
    if (state.view.kind === kind && state.view.id === id) return;
    state.view = { kind: kind, id: id };
    state.selected = null;
    state.selectedKind = null;
    rebuild(true);
    renderPanel();
  }

  // ---- interactions -----------------------------------------------------------
  function idOf(node) {
    var raw = node.id();
    if (raw.indexOf('x~') === 0) return { ghost: true, kind: node.data('extKind'), id: node.data('extId') };
    if (raw.indexOf('i~') === 0) { var parts = raw.split('~'); return { inner: true, kind: parts[1], id: parts.slice(2).join('~') }; }
    return { kind: raw.charAt(0) === 's' ? 'subsystem' : 'component', id: raw.slice(2) };
  }

  cy.on('tap', 'node', function (ev) {
    var t = idOf(ev.target);
    select(t.kind, t.id, false);
  });
  cy.on('tap', function (ev) { if (ev.target === cy) select(null, null, false); });
  cy.on('dbltap', 'node', function (ev) {
    var t = idOf(ev.target);
    if (t.ghost) {
      // jump to the external element's parent view and select it
      var parentView = parentViewOf(t.kind, t.id);
      state.view = parentView;
      rebuild(true);
      select(t.kind, t.id, true);
      return;
    }
    var entry = { kind: t.kind, id: t.id };
    var hasKids = t.kind === 'subsystem'
      ? (childSubsOf(t.id).length + childCompsOf(t.id).length) > 0
      : memberCompsOf(t.id).length > 0;
    if (hasKids) navigateTo(t.kind, t.id);
  });
  cy.on('dragfree', 'node', function () { harvestPositions(); });

  function parentViewOf(kind, id) {
    if (kind === 'subsystem') {
      var segs = id.split('::');
      return segs.length > 1 ? { kind: 'subsystem', id: segs.slice(0, -1).join('::') } : { kind: 'system', id: null };
    }
    var c = compById[id];
    if (c && c.owner) return { kind: 'component', id: c.owner };
    return c ? { kind: 'subsystem', id: c.subsystem } : { kind: 'system', id: null };
  }

  document.getElementById('search').addEventListener('input', function (ev) { state.query = ev.target.value.trim(); rebuild(false); });
  document.getElementById('internalsToggle').addEventListener('change', function (ev) { state.internals = ev.target.checked; rebuild(true); });
  document.getElementById('externalsToggle').addEventListener('change', function (ev) { state.externals = ev.target.checked; rebuild(true); });
  document.getElementById('issuesToggle').addEventListener('change', function (ev) { state.showIssues = ev.target.checked; rebuild(false); renderPanel(); });
  document.getElementById('dragToggle').addEventListener('change', function (ev) { cy.autolock(!ev.target.checked); });
  document.getElementById('fitBtn').addEventListener('click', function () { cy.fit(undefined, 50); });
  document.getElementById('resetBtn').addEventListener('click', function () {
    var all = saved.positionsByView || {};
    delete all[viewKey()];
    saved.positionsByView = all;
    persist();
    rebuild(true);
  });

  document.getElementById('themeBtn').addEventListener('click', function () {
    state.theme = state.theme === 'syw' ? 'light' : 'syw';
    document.body.setAttribute('data-theme', state.theme);
    cy.style(buildStyle(THEMES[state.theme]));
    renderLegend();
    persist();
  });

  function setPresentation(on) {
    if (document.body.classList) document.body.classList[on ? 'add' : 'remove']('presentation');
    if (inBrowser) {
      try {
        if (on && document.documentElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
        else if (!on && document.exitFullscreen && document.fullscreenElement) document.exitFullscreen();
      } catch (e) { /* fullscreen unavailable */ }
    }
    setTimeout(function () { cy.resize(); cy.fit(undefined, 30); }, 60);
  }
  document.getElementById('presentBtn').addEventListener('click', function () { setPresentation(true); });
  document.getElementById('exitPresent').addEventListener('click', function () { setPresentation(false); });

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
  function fileBase() {
    var scope = state.view.id ? state.view.id.replace(/::/g, '-') : 'system';
    return (String(MODEL.system.name) + '-' + scope).replace(/\\s+/g, '-').toLowerCase();
  }
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
    a.href = uri; a.download = fileBase() + '.png';
    document.body.appendChild(a); a.click(); a.remove();
  });
  document.getElementById('expDrawio').addEventListener('click', function () {
    downloadText(fileBase() + '.drawio', buildDrawioXml(MODEL, harvestLayout()), 'application/xml');
  });
  document.getElementById('expExcalidraw').addEventListener('click', function () {
    downloadText(fileBase() + '.excalidraw', buildExcalidrawScene(MODEL, harvestLayout()), 'application/json');
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

  function openViewButton(kind, id, hasKids) {
    if (!hasKids) return '';
    return '<div class="openbtn"><button class="tbtn" data-open-kind="' + kind + '" data-open-id="' + esc(id) + '">\\u25B8 Open as view</button></div>';
  }

  function renderPanel() {
    var head = '', body = '';
    if (state.selectedKind === 'component' && compById[state.selected]) {
      var c = compById[state.selected];
      head = '<h2>' + esc(c.name) + '</h2>'
        + staticChip('\\u00AB' + c.componentType + (c.portalType ? '/' + c.portalType : '') + '\\u00BB')
        + (c.public ? staticChip('published') : '')
        + (c.status ? staticChip(c.status) : '')
        + chip(c.subsystem, 'subsystem', c.subsystem)
        + openViewButton('component', c.id, c.owns.length > 0);
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
      var subKids = childSubsOf(s.id).length + childCompsOf(s.id).length;
      head = '<h2>' + esc(s.name) + '</h2>' + staticChip('subsystem')
        + (s.targetLanguage ? staticChip(s.targetLanguage) : '')
        + (s.status ? staticChip(s.status) : '')
        + openViewButton('subsystem', s.id, subKids > 0);
      body += '<p class="desc">' + esc(s.description) + '</p>';
      if (s.trustedLinks.length) {
        body += section('Trusted links (fast lanes)', s.trustedLinks.length, s.trustedLinks.map(function (t2) {
          return '<div class="method">' + chip(t2.subsystem, 'subsystem', t2.subsystem) + '<div class="mdesc">' + esc(t2.reason) + '</div></div>';
        }).join(''), true);
      }
      var subs2 = childSubsOf(s.id);
      if (subs2.length) body += section('Nested subsystems', subs2.length, subs2.map(function (s2) { return chip(s2.id, 'subsystem', s2.id); }).join(''), true);
      var comps = childCompsOf(s.id);
      body += section('Components', comps.length, comps.map(function (c2) { return chip(c2.id, 'component', c2.id); }).join(''), true);
      var iss2 = issuesBySpec[s.id];
      if (iss2) body += section('Validation issues', iss2.length, issueHtml(iss2), true);
    } else {
      head = '<h2>' + esc(MODEL.system.name) + '</h2>'
        + (MODEL.system.targetLanguage ? staticChip(MODEL.system.targetLanguage) : '')
        + staticChip(MODEL.subsystems.length + ' subsystems')
        + staticChip(MODEL.components.length + ' components');
      if (MODEL.system.vision) body += '<p class="desc">' + esc(MODEL.system.vision) + '</p>';
      body += '<p class="desc">Each view shows one scope\\u2019s direct children \\u2014 double-click a box (or use \\u201COpen as view\\u201D) to drill in, and the breadcrumb to come back. Derived from <code style="display:inline">.wai/specs/</code>.</p>';
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
    var opens = panel.querySelectorAll('[data-open-kind]');
    for (var k = 0; k < opens.length; k++) {
      (function (b) {
        b.addEventListener('click', function () { navigateTo(b.getAttribute('data-open-kind'), b.getAttribute('data-open-id')); });
      })(opens[k]);
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
