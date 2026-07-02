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

// ---------------------------------------------------------------------------
// Interactive architecture canvas (stage 2 of spec-driven visualization).
//
// Emits a SINGLE self-contained HTML file. Cytoscape.js (vendored, embedded
// inline — no network, honoring the offline invariant) renders the graph:
// subsystems and patterns as compound containers, components as
// stereotype-colored nodes. Positions come from wairon's own deterministic
// layered layout (entrypoints left → data right) fed to cytoscape as a preset
// layout — organized like a blueprint, not force-directed scatter — while
// cytoscape provides dragging, pan/zoom, and compound interaction.
//
// Interactions: drag nodes/boundaries, pan/zoom, double-click a boundary to
// collapse it (its external edges aggregate into labeled "tube" edges),
// click-through detail panel (description, interfaces, methods, narratives,
// dependencies, trusted links), search, and a validation-issue overlay.
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
    /** Owning pattern component id, when this block is a pattern member. */
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
  /** dependsOn edges (owns is shown as containment, not edges). */
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
  const html = CANVAS_TEMPLATE
    .replace('__TITLE__', () => escapeHtml(title))
    .replace('__SYSTEM_NAME__', () => escapeHtml(model.system.name))
    .replace('__GENERATED_AT__', () => escapeHtml(model.generatedAt))
    .replace('__CYTOSCAPE_LIB__', () => loadCytoscapeLib())
    .replace('__MODEL_JSON__', () => embedJson(model));
  return html;
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
  :root {
    --ink:#1f2328; --dim:#57606a; --bg:#fafbfc; --panel:#ffffff; --border:#d8dee4; --cross:#c26767;
  }
  * { box-sizing: border-box; }
  body { margin:0; font:13px/1.45 system-ui, "Segoe UI", sans-serif; color:var(--ink); background:var(--bg); overflow:hidden; }
  header { display:flex; align-items:center; gap:14px; padding:8px 14px; background:var(--panel); border-bottom:1px solid var(--border); }
  header h1 { font-size:15px; margin:0; white-space:nowrap; }
  header .sub { color:var(--dim); font-size:12px; }
  header input { padding:5px 9px; border:1px solid var(--border); border-radius:6px; width:220px; font:inherit; }
  header label { display:flex; align-items:center; gap:5px; color:var(--dim); cursor:pointer; white-space:nowrap; }
  header button { padding:4px 10px; border:1px solid var(--border); border-radius:6px; background:var(--bg); cursor:pointer; font:inherit; }
  #wrap { display:flex; height:calc(100vh - 46px); }
  #stage { flex:1; position:relative; }
  #cy { position:absolute; inset:0; }
  #panel { width:360px; border-left:1px solid var(--border); background:var(--panel); overflow-y:auto; padding:14px 16px; }
  #panel h2 { font-size:15px; margin:0 0 2px; }
  #panel h3 { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--dim); margin:16px 0 6px; }
  #panel .chip { display:inline-block; padding:1px 8px; border-radius:10px; font-size:11px; border:1px solid var(--border); margin:0 4px 4px 0; background:var(--bg); cursor:pointer; }
  #panel .chip.static { cursor:default; }
  #panel .desc { color:var(--dim); }
  #panel .method { border:1px solid var(--border); border-radius:6px; padding:6px 9px; margin-bottom:6px; }
  #panel .method code { font-size:11.5px; word-break:break-all; }
  #panel .method .ret { color:var(--dim); font-size:11.5px; }
  #panel .step { margin:2px 0; }
  #panel .step .call { color:#4a7dcf; cursor:pointer; text-decoration:underline dotted; }
  #panel .issue { border-left:3px solid var(--cross); padding:4px 8px; margin:5px 0; background:#fff6f6; font-size:12px; }
  #panel .issue.warning { border-left-color:#c9963f; background:#fffaf0; }
  #panel .issue code { font-size:11px; color:var(--dim); }
  .legend { position:absolute; left:12px; bottom:12px; background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:8px 12px; font-size:11.5px; color:var(--dim); z-index:5; pointer-events:none; }
  .legend .sw { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:5px; vertical-align:-1px; border:1.5px solid; }
</style>
</head>
<body>
<header>
  <h1>__SYSTEM_NAME__</h1>
  <span class="sub">architecture canvas · generated __GENERATED_AT__ · <b>wairon</b></span>
  <input id="search" placeholder="search components…">
  <label><input type="checkbox" id="issuesToggle"> issues overlay (<span id="issueCount"></span>)</label>
  <label><input type="checkbox" id="dragToggle"> rearrange</label>
  <button id="fitBtn">fit</button>
  <button id="resetBtn">reset layout</button>
  <button id="pngBtn">export PNG</button>
  <span class="sub" style="margin-left:auto">double-click a boundary to collapse/expand · wheel to zoom · layout locked (enable “rearrange” to drag)</span>
</header>
<div id="wrap">
  <div id="stage">
    <div id="cy"></div>
    <div class="legend">
      <span class="sw" style="background:#eef4ff;border-color:#4a7dcf"></span>Portal/Observer&nbsp;&nbsp;
      <span class="sw" style="background:#f4effd;border-color:#8a63c9"></span>Logic&nbsp;&nbsp;
      <span class="sw" style="background:#fdf6e3;border-color:#c9963f"></span>Data&nbsp;&nbsp;
      <span class="sw" style="background:#eef8f1;border-color:#4f9e6b"></span>Adapter&nbsp;&nbsp;
      <span class="sw" style="background:#f6f8fa;border-color:#6a737d"></span>Pattern&nbsp;&nbsp;
      — bold border = published · <span style="color:#c26767">red edge</span> = boundary hop · thick faded edge = collapsed tube
    </div>
  </div>
  <div id="panel"><h2>Architecture canvas</h2><p class="desc">Click any component, pattern, or subsystem for details. Derived from <code>.wai/specs/</code> — the same source of truth as the conformance gate.</p></div>
</div>
<script>__CYTOSCAPE_LIB__</script>
<script>
var MODEL = __MODEL_JSON__;
</script>
<script>
(function () {
  'use strict';
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
    MODEL.issues.filter(function (i) { return i.severity === 'error'; }).length + ' err / ' +
    MODEL.issues.filter(function (i) { return i.severity === 'warning'; }).length + ' warn';

  var state = { collapsed: {}, selected: null, showIssues: false, query: '' };

  var PATTERN_TYPES = { Repository:1, Gateway:1, FeatureComponent:1, RouterComponent:1 };
  function stereoClass(t) {
    if (t === 'Portal' || t === 'Observer') return 'entry';
    if (t === 'Store' || t === 'Index' || t === 'Registry') return 'data';
    if (t === 'Adapter') return 'adapter';
    if (PATTERN_TYPES[t]) return 'patternLeaf';
    return 'logic';
  }
  function matches(c) {
    if (!state.query) return true;
    var q = state.query.toLowerCase();
    return c.id.toLowerCase().indexOf(q) >= 0 || c.name.toLowerCase().indexOf(q) >= 0;
  }
  var CN = function (id) { return 'c~' + id; };
  var SN = function (id) { return 's~' + id; };

  // ---- deterministic layered layout (preset positions for cytoscape) --------
  var BOX_W = 190, BOX_H = 52, GAP_X = 90, GAP_Y = 26, SUB_PAD = 30, SUB_HEAD = 44;
  var MEMBER_W = 168, MEMBER_H = 44, PAT_PAD = 16, PAT_HEAD = 34;

  function layerOf(comp, topIds, memo, stack) {
    if (memo[comp.id] !== undefined) return memo[comp.id];
    if (stack[comp.id]) return 0;
    stack[comp.id] = true;
    var l;
    if (comp.componentType === 'Portal' || comp.componentType === 'Observer') {
      l = 0;
    } else {
      l = 0;
      MODEL.components.forEach(function (other) {
        if (other.subsystem !== comp.subsystem) return;
        if (!topIds[other.id]) return;
        if (other.dependsOn.indexOf(comp.id) >= 0) {
          l = Math.max(l, layerOf(other, topIds, memo, stack) + 1);
        }
      });
      if (l === 0) l = 1;
    }
    delete stack[comp.id];
    memo[comp.id] = l;
    return l;
  }

  function boxSizeFor(comp) {
    if (PATTERN_TYPES[comp.componentType] && comp.owns.length && !state.collapsed[comp.id]) {
      return { w: MEMBER_W + PAT_PAD * 2 + 24, h: PAT_HEAD + comp.owns.length * (MEMBER_H + 12) + PAT_PAD };
    }
    return { w: BOX_W, h: BOX_H };
  }

  // Subsystems ordered so callers sit left of the subsystems they depend on —
  // cross-boundary edges then flow consistently rightward (shorter, fewer
  // weird back-links). DFS post-order over the subsystem dep graph, reversed;
  // alphabetical tiebreak; cycle-guarded (mutual deps keep declaration order).
  function subsystemOrder() {
    var deps = {};
    MODEL.edges.forEach(function (e) {
      if (!e.cross) return;
      var fs = compById[e.from].subsystem, ts = compById[e.to].subsystem;
      (deps[fs] = deps[fs] || {})[ts] = 1;
    });
    var ids = MODEL.subsystems.map(function (s) { return s.id; }).sort();
    var order = [], mark = {};
    function visit(id, stack) {
      if (mark[id] || stack[id]) return;
      stack[id] = 1;
      Object.keys(deps[id] || {}).sort().forEach(function (d) { if (subById[d]) visit(d, stack); });
      delete stack[id];
      mark[id] = 1;
      order.push(id);
    }
    ids.forEach(function (id) { visit(id, {}); });
    order.reverse();
    return order.map(function (id) { return subById[id]; });
  }

  // Barycenter crossing-reduction: within a subsystem, order each column's
  // components by the mean row of their neighbors in the adjacent column
  // (alternating sweep directions). Unconnected components keep their row.
  function refineColumns(colInfo) {
    function neighborsMean(c, refIds, fallback) {
      var vals = [];
      c.dependsOn.forEach(function (d) { if (refIds[d] !== undefined) vals.push(refIds[d]); });
      MODEL.components.forEach(function (o) {
        if (refIds[o.id] !== undefined && o.dependsOn.indexOf(c.id) >= 0) vals.push(refIds[o.id]);
      });
      if (!vals.length) return fallback;
      return vals.reduce(function (s, v) { return s + v; }, 0) / vals.length;
    }
    for (var iter = 0; iter < 4; iter++) {
      var forward = iter % 2 === 0;
      colInfo.forEach(function (col, k) {
        var refK = forward ? k - 1 : k + 1;
        if (refK < 0 || refK >= colInfo.length) return;
        var refIds = {};
        colInfo[refK].comps.forEach(function (c, i) { refIds[c.id] = i; });
        var keyed = col.comps.map(function (c, i) { return { c: c, key: neighborsMean(c, refIds, i) }; });
        keyed.sort(function (a, b) { return a.key - b.key || (a.c.id < b.c.id ? -1 : 1); });
        col.comps = keyed.map(function (x) { return x.c; });
      });
    }
  }

  // boxes: component id -> {x,y,w,h}; subs: id -> {x,y,w,h,collapsed}
  function layout() {
    var boxes = {}, subs = {};
    var order = subsystemOrder();
    var sizes = {};
    order.forEach(function (sub) {
      if (state.collapsed[sub.id]) { sizes[sub.id] = { w: 240, h: 76, cols: [] }; return; }
      var comps = MODEL.components.filter(function (c) { return c.subsystem === sub.id && !c.owner; });
      var topIds = {}; comps.forEach(function (c) { topIds[c.id] = true; });
      var memo = {};
      comps.forEach(function (c) { layerOf(c, topIds, memo, {}); });
      var cols = {};
      comps.forEach(function (c) { (cols[memo[c.id]] = cols[memo[c.id]] || []).push(c); });
      var colKeys = Object.keys(cols).map(Number).sort(function (a, b) { return a - b; });
      var colInfo = [];
      colKeys.forEach(function (k) {
        colInfo.push({ comps: cols[k].sort(function (a, b) { return a.id < b.id ? -1 : 1; }), w: 0, h: 0 });
      });
      refineColumns(colInfo);
      var width = SUB_PAD * 2, height = 0;
      colInfo.forEach(function (col) {
        var colW = 0, colH = 0;
        col.comps.forEach(function (c) { var s = boxSizeFor(c); colW = Math.max(colW, s.w); colH += s.h + GAP_Y; });
        col.w = colW; col.h = colH;
        width += colW + GAP_X;
        height = Math.max(height, colH);
      });
      if (colInfo.length) width -= GAP_X;
      sizes[sub.id] = { w: Math.max(width, 240), h: SUB_HEAD + height + SUB_PAD, cols: colInfo };
    });

    var MAX_ROW = 2100, x = 40, y = 40, rowH = 0;
    order.forEach(function (sub) {
      var s = sizes[sub.id];
      if (x + s.w > MAX_ROW && x > 40) { x = 40; y += rowH + 70; rowH = 0; }
      subs[sub.id] = { x: x, y: y, w: s.w, h: s.h, collapsed: !!state.collapsed[sub.id] };
      if (!state.collapsed[sub.id]) {
        var cx = x + SUB_PAD;
        s.cols.forEach(function (col) {
          var cy0 = y + SUB_HEAD + Math.max(0, (s.h - SUB_HEAD - SUB_PAD - col.h + GAP_Y) / 2);
          col.comps.forEach(function (c) {
            var bs = boxSizeFor(c);
            boxes[c.id] = { x: cx, y: cy0, w: bs.w, h: bs.h };
            if (PATTERN_TYPES[c.componentType] && c.owns.length && !state.collapsed[c.id]) {
              var my = cy0 + PAT_HEAD;
              c.owns.forEach(function (mid) {
                boxes[mid] = { x: cx + PAT_PAD + 12, y: my, w: MEMBER_W, h: MEMBER_H };
                my += MEMBER_H + 12;
              });
            }
            cy0 += bs.h + GAP_Y;
          });
          cx += col.w + GAP_X;
        });
      }
      x += s.w + 70;
      rowH = Math.max(rowH, s.h);
    });
    return { boxes: boxes, subs: subs };
  }

  // The visible node id representing a component under the collapse state.
  function anchorFor(id, L) {
    var c = compById[id];
    if (!c) return null;
    if (state.collapsed[c.subsystem]) return SN(c.subsystem);
    if (c.owner && state.collapsed[c.owner]) return CN(c.owner);
    if (L.boxes[id]) return CN(id);
    return null;
  }

  // ---- element construction ---------------------------------------------------
  function buildElements() {
    var L = layout();
    var eles = [];

    MODEL.subsystems.forEach(function (sub) {
      var sb = L.subs[sub.id];
      var dim = state.query && !MODEL.components.some(function (c) { return c.subsystem === sub.id && matches(c); });
      if (sb.collapsed) {
        eles.push({
          data: { id: SN(sub.id), label: sub.name + '\\n(collapsed \\u25B8)', w: sb.w, h: sb.h, tw: sb.w - 20 },
          position: { x: sb.x + sb.w / 2, y: sb.y + sb.h / 2 },
          classes: 'subsysC boundary' + (dim ? ' dimmed' : '') + (state.showIssues && issuesBySpec[sub.id] ? ' hasIssue' : ''),
        });
      } else {
        eles.push({
          data: { id: SN(sub.id), label: sub.name, w: sb.w, h: sb.h, tw: sb.w - 20 },
          classes: 'subsysP boundary' + (dim ? ' dimmed' : '') + (state.showIssues && issuesBySpec[sub.id] ? ' hasIssue' : ''),
        });
      }
    });

    // parents before children: patterns next, then leaves
    var visible = Object.keys(L.boxes);
    var patterns = visible.filter(function (id) { var c = compById[id]; return PATTERN_TYPES[c.componentType] && c.owns.length && !state.collapsed[id]; });
    var leaves = visible.filter(function (id) { return patterns.indexOf(id) < 0; });

    patterns.forEach(function (id) {
      var c = compById[id], b = L.boxes[id];
      eles.push({
        data: { id: CN(id), label: c.name + '  \\u00AB' + c.componentType + '\\u00BB', parent: SN(c.subsystem), w: b.w, h: b.h, tw: b.w - 16 },
        classes: 'patternP boundary' + (state.query && !matches(c) ? ' dimmed' : '') + (state.showIssues && issuesBySpec[id] ? ' hasIssue' : '') + (state.selected === id ? ' sel' : ''),
      });
    });

    leaves.forEach(function (id) {
      var c = compById[id], b = L.boxes[id];
      var parent = (c.owner && !state.collapsed[c.owner] && L.boxes[c.owner]) ? CN(c.owner) : SN(c.subsystem);
      var collapsedPattern = PATTERN_TYPES[c.componentType] && c.owns.length && state.collapsed[id];
      var label = c.name + '\\n\\u00AB' + c.componentType + (c.portalType ? '/' + c.portalType : '') + '\\u00BB' + (collapsedPattern ? ' \\u25B8' : '');
      eles.push({
        data: { id: CN(id), label: label, parent: parent, w: b.w, h: b.h, tw: b.w - 14 },
        position: { x: b.x + b.w / 2, y: b.y + b.h / 2 },
        classes: stereoClass(c.componentType)
          + (c.public ? ' public' : '')
          + (collapsedPattern ? ' boundary' : '')
          + (state.query && !matches(c) ? ' dimmed' : '')
          + (state.showIssues && issuesBySpec[id] ? ' hasIssue' : '')
          + (state.selected === id ? ' sel' : ''),
      });
    });

    // aggregated edges between visible anchors
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
      eles.push({
        data: { id: 'e' + (i++), source: e.a, target: e.b, lbl: e.tube && e.n > 1 ? e.n + ' links' : '' },
        classes: 'dep' + (e.cross ? ' cross' : '') + (e.tube ? ' tube' : ''),
      });
    });

    return eles;
  }

  // ---- cytoscape ----------------------------------------------------------------
  var STYLE = [
    { selector: 'node', style: {
      shape: 'round-rectangle', width: 'data(w)', height: 'data(h)',
      label: 'data(label)', 'text-wrap': 'wrap', 'text-max-width': 'data(tw)',
      'font-family': 'system-ui, sans-serif', 'font-size': 11, color: '#1f2328',
      'text-valign': 'center', 'text-halign': 'center', 'border-width': 1.5,
    }},
    { selector: '.entry', style: { 'background-color': '#eef4ff', 'border-color': '#4a7dcf' } },
    { selector: '.logic', style: { 'background-color': '#f4effd', 'border-color': '#8a63c9' } },
    { selector: '.data', style: { 'background-color': '#fdf6e3', 'border-color': '#c9963f' } },
    { selector: '.adapter', style: { 'background-color': '#eef8f1', 'border-color': '#4f9e6b' } },
    { selector: '.patternLeaf', style: { 'background-color': '#f6f8fa', 'border-color': '#6a737d', 'border-style': 'dashed' } },
    { selector: 'node.public', style: { 'border-width': 3.5 } },
    { selector: ':parent', style: {
      'text-valign': 'top', 'text-halign': 'center', 'font-size': 12.5, 'font-weight': 'bold',
      'text-margin-y': -6, padding: '16px', 'background-opacity': 1,
    }},
    { selector: '.subsysP', style: { 'background-color': '#ffffff', 'border-color': '#b6c0cc', 'border-width': 1.4 } },
    { selector: '.subsysC', style: { 'background-color': '#eef1f5', 'border-color': '#b6c0cc', 'font-weight': 'bold', 'font-size': 12.5 } },
    { selector: '.patternP', style: { 'background-color': '#f6f8fa', 'border-color': '#6a737d', 'border-style': 'dashed' } },
    { selector: 'edge', style: {
      'curve-style': 'bezier', width: 1.7, 'line-color': '#8d97a5',
      'target-arrow-shape': 'triangle', 'target-arrow-color': '#8d97a5', 'arrow-scale': 0.9,
      label: 'data(lbl)', 'font-size': 10, color: '#57606a',
      'text-background-color': '#fafbfc', 'text-background-opacity': 0.85, 'text-rotation': 'autorotate',
    }},
    { selector: 'edge.cross', style: { 'line-color': '#c26767', 'target-arrow-color': '#c26767', width: 2.6 } },
    { selector: 'edge.tube', style: { width: 5.5, opacity: 0.55 } },
    { selector: '.dimmed', style: { opacity: 0.18 } },
    { selector: '.hasIssue', style: { 'border-color': '#cf4a4a', 'border-style': 'dashed', 'border-width': 3 } },
    { selector: '.sel', style: { 'overlay-color': '#4a7dcf', 'overlay-opacity': 0.18, 'overlay-padding': 5 } },
  ];

  var cy = cytoscape({
    container: document.getElementById('cy'),
    elements: buildElements(),
    style: STYLE,
    layout: { name: 'preset' },
    wheelSensitivity: 0.2,
    minZoom: 0.08,
    maxZoom: 3,
    boxSelectionEnabled: false,
    autounselectify: true,
  });
  // The computed layout is the source of truth: nodes are locked against
  // dragging unless the user explicitly enables "rearrange".
  cy.autolock(true);
  cy.fit(undefined, 40);

  function rebuild() {
    cy.batch(function () {
      cy.elements().remove();
      cy.add(buildElements());
    });
  }

  // ---- interactions -----------------------------------------------------------
  function idOf(node) {
    var raw = node.id();
    return { kind: raw.charAt(0) === 's' ? 'subsystem' : 'component', id: raw.slice(2) };
  }

  cy.on('tap', 'node', function (ev) {
    var t = idOf(ev.target);
    select(t.kind, t.id, false);
  });
  cy.on('tap', function (ev) {
    if (ev.target === cy) select(null, null, false);
  });
  cy.on('dbltap', 'node', function (ev) {
    var t = idOf(ev.target);
    if (t.kind === 'subsystem') {
      state.collapsed[t.id] = !state.collapsed[t.id];
      rebuild();
      return;
    }
    var c = compById[t.id];
    if (c && PATTERN_TYPES[c.componentType] && c.owns.length) {
      state.collapsed[t.id] = !state.collapsed[t.id];
      rebuild();
    }
  });

  document.getElementById('search').addEventListener('input', function (ev) {
    state.query = ev.target.value.trim();
    rebuild();
  });
  document.getElementById('issuesToggle').addEventListener('change', function (ev) {
    state.showIssues = ev.target.checked;
    rebuild();
    renderPanel();
  });
  document.getElementById('dragToggle').addEventListener('change', function (ev) {
    cy.autolock(!ev.target.checked);
  });
  document.getElementById('fitBtn').addEventListener('click', function () { cy.fit(undefined, 40); });
  // Discard any manual rearranging and restore the computed layout.
  document.getElementById('resetBtn').addEventListener('click', function () { rebuild(); cy.fit(undefined, 40); });
  // High-res PNG of the whole graph — paste into Miro, docs, slides, PRs.
  document.getElementById('pngBtn').addEventListener('click', function () {
    var uri = cy.png({ full: true, scale: 2, bg: '#fafbfc' });
    var a = document.createElement('a');
    a.href = uri;
    a.download = (MODEL.system.name + '-architecture.png').replace(/\\s+/g, '-').toLowerCase();
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  // ---- detail panel -------------------------------------------------------------
  var panel = document.getElementById('panel');
  var selectedKind = null;
  function esc(s) { var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
  function chip(label, kind, target) {
    return '<span class="chip" data-kind="' + kind + '" data-id="' + esc(target) + '">' + esc(label) + '</span>';
  }
  function issueHtml(list) {
    return list.map(function (i) {
      return '<div class="issue ' + esc(i.severity) + '"><code>' + esc(i.code) + '</code><br>' + esc(i.message) + '</div>';
    }).join('');
  }
  function select(kind, id, focus) {
    selectedKind = kind;
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
    var html = '';
    if (selectedKind === 'component' && compById[state.selected]) {
      var c = compById[state.selected];
      html += '<h2>' + esc(c.name) + '</h2>';
      html += '<span class="chip static">\\u00AB' + esc(c.componentType) + (c.portalType ? '/' + esc(c.portalType) : '') + '\\u00BB</span>';
      if (c.public) html += '<span class="chip static">published</span>';
      if (c.status) html += '<span class="chip static">' + esc(c.status) + '</span>';
      html += chip(c.subsystem, 'subsystem', c.subsystem);
      html += '<p class="desc">' + esc(c.description) + '</p>';
      if (c.dependsOn.length) { html += '<h3>Depends on</h3>' + c.dependsOn.map(function (d) { return chip(d, 'component', d); }).join(''); }
      if (c.owns.length) { html += '<h3>Owns</h3>' + c.owns.map(function (d) { return chip(d, 'component', d); }).join(''); }
      c.interfaces.forEach(function (intf) {
        html += '<h3>' + esc(intf.name) + ' <code>' + esc(intf.id) + '</code></h3>';
        intf.methods.forEach(function (m) {
          html += '<div class="method"><b>' + esc(m.name) + '</b><br><code>' + esc(m.signature) + '</code><br><span class="ret">returns ' + esc(m.returns) + '</span>';
          if (m.params) html += '<br><span class="ret">params: ' + m.params.map(function (p) { return esc(p.name) + ': ' + esc(p.type); }).join(', ') + '</span>';
          if (m.endpoint) html += '<br><code>' + esc(JSON.stringify(m.endpoint)) + '</code>';
          if (m.guarantees) html += '<br>' + m.guarantees.map(function (g) { return '<span class="chip static">' + esc(g) + '</span>'; }).join('');
          html += '</div>';
        });
      });
      if (c.narratives.length) {
        html += '<h3>Narratives (L5)</h3>';
        c.narratives.forEach(function (n) {
          html += '<div class="method"><b>' + esc(n.method) + '()</b>';
          n.steps.forEach(function (s) {
            html += '<div class="step">' + s.n + '. ' + esc(s.text);
            if (s.call) html += ' \\u2192 <span class="call chip-nav" data-kind="component" data-id="' + esc(s.call.component) + '">' + esc(s.call.component) + '.' + esc(s.call.method) + '()</span>';
            html += '</div>';
          });
          html += '</div>';
        });
      }
      var iss = issuesBySpec[c.id];
      if (iss) html += '<h3>Validation issues</h3>' + issueHtml(iss);
    } else if (selectedKind === 'subsystem' && subById[state.selected]) {
      var s = subById[state.selected];
      html += '<h2>' + esc(s.name) + '</h2><span class="chip static">subsystem</span>';
      if (s.targetLanguage) html += '<span class="chip static">' + esc(s.targetLanguage) + '</span>';
      html += '<p class="desc">' + esc(s.description) + '</p>';
      if (s.trustedLinks.length) {
        html += '<h3>Trusted links (fast lanes)</h3>';
        s.trustedLinks.forEach(function (t) { html += '<div class="method">' + chip(t.subsystem, 'subsystem', t.subsystem) + '<br><span class="desc">' + esc(t.reason) + '</span></div>'; });
      }
      var comps = MODEL.components.filter(function (c) { return c.subsystem === s.id; });
      html += '<h3>Components (' + comps.length + ')</h3>' + comps.map(function (c) { return chip(c.id, 'component', c.id); }).join('');
      var iss2 = issuesBySpec[s.id];
      if (iss2) html += '<h3>Validation issues</h3>' + issueHtml(iss2);
    } else {
      html += '<h2>' + esc(MODEL.system.name) + '</h2>';
      if (MODEL.system.targetLanguage) html += '<span class="chip static">' + esc(MODEL.system.targetLanguage) + '</span>';
      if (MODEL.system.vision) html += '<p class="desc">' + esc(MODEL.system.vision) + '</p>';
      if (state.showIssues && MODEL.issues.length) html += '<h3>All validation issues</h3>' + issueHtml(MODEL.issues);
    }
    panel.innerHTML = html;
    panel.querySelectorAll('[data-kind]').forEach(function (n) {
      n.addEventListener('click', function () {
        select(n.getAttribute('data-kind'), n.getAttribute('data-id'), true);
      });
    });
  }

  renderPanel();
})();
</script>
</body>
</html>
`;
