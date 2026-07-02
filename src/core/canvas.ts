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
// Emits a SINGLE self-contained HTML file — no external libraries, no network
// (wairon's offline invariant), no build step. The whole spec tree is embedded
// as JSON; a small hand-rolled SVG renderer draws subsystems as containers,
// pattern compounds nested inside them, and components as stereotype-colored
// boxes laid out in dependency layers (entrypoints left → data right).
//
// Interactions: pan/zoom, collapse/expand boundaries (external edges of a
// collapsed boundary aggregate into labeled "tube" edges), click-through
// detail panel (description, interfaces, methods, narratives, dependencies),
// search, and a validation-issue overlay.
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

export function renderCanvasHtml(model: CanvasModel): string {
  const title = `${model.system.name} — architecture canvas`;
  // NOTE: the inline script below deliberately avoids template literals so this
  // outer TypeScript template stays trivially safe to compose.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --entry-fill:#eef4ff; --entry-stroke:#4a7dcf;
    --logic-fill:#f4effd; --logic-stroke:#8a63c9;
    --data-fill:#fdf6e3;  --data-stroke:#c9963f;
    --adapter-fill:#eef8f1; --adapter-stroke:#4f9e6b;
    --pattern-fill:#f6f8fa; --pattern-stroke:#6a737d;
    --ink:#1f2328; --dim:#57606a; --line:#8d97a5; --cross:#c26767;
    --bg:#fafbfc; --panel:#ffffff; --border:#d8dee4;
  }
  * { box-sizing: border-box; }
  body { margin:0; font:13px/1.45 system-ui, "Segoe UI", sans-serif; color:var(--ink); background:var(--bg); overflow:hidden; }
  header { display:flex; align-items:center; gap:14px; padding:8px 14px; background:var(--panel); border-bottom:1px solid var(--border); }
  header h1 { font-size:15px; margin:0; white-space:nowrap; }
  header .sub { color:var(--dim); font-size:12px; }
  header input { padding:5px 9px; border:1px solid var(--border); border-radius:6px; width:220px; font:inherit; }
  header label { display:flex; align-items:center; gap:5px; color:var(--dim); cursor:pointer; white-space:nowrap; }
  #wrap { display:flex; height:calc(100vh - 46px); }
  #stage { flex:1; overflow:hidden; cursor:grab; position:relative; }
  #stage.panning { cursor:grabbing; }
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
  #panel .step .call { color:var(--entry-stroke); cursor:pointer; text-decoration:underline dotted; }
  #panel .issue { border-left:3px solid var(--cross); padding:4px 8px; margin:5px 0; background:#fff6f6; font-size:12px; }
  #panel .issue.warning { border-left-color:var(--data-stroke); background:#fffaf0; }
  #panel .issue code { font-size:11px; color:var(--dim); }
  .legend { position:absolute; left:12px; bottom:12px; background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:8px 12px; font-size:11.5px; color:var(--dim); }
  .legend .sw { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:5px; vertical-align:-1px; border:1.5px solid; }
  svg text { user-select:none; }
  .comp { cursor:pointer; }
  .comp rect { stroke-width:1.4; }
  .comp.public rect { stroke-width:3; }
  .comp.dimmed, .subsys.dimmed { opacity:.25; }
  .comp.selected rect { filter:drop-shadow(0 0 4px rgba(74,125,207,.9)); }
  .comp.hasIssue rect { stroke:#cf4a4a !important; stroke-dasharray:5 3; }
  .subsys > rect.frame { fill:#ffffff; stroke:#b6c0cc; stroke-width:1.2; rx:10; }
  .subsys > rect.head { fill:#eef1f5; stroke:none; }
  .subsys.collapsed > rect.frame { fill:#eef1f5; }
  .subheader { font-weight:600; font-size:13px; cursor:pointer; }
  .subtoggle { cursor:pointer; font-size:12px; fill:var(--dim); }
  .pattern > rect { fill:var(--pattern-fill); stroke:var(--pattern-stroke); stroke-dasharray:6 3; }
  .edge { fill:none; stroke:var(--line); stroke-width:1.4; }
  .edge.cross { stroke:var(--cross); stroke-width:2.2; }
  .edge.tube { stroke-width:4.5; opacity:.55; }
  .edgeLabel { font-size:10.5px; fill:var(--dim); }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(model.system.name)}</h1>
  <span class="sub">architecture canvas · generated ${escapeHtml(model.generatedAt)} · <b>wairon</b></span>
  <input id="search" placeholder="search components…">
  <label><input type="checkbox" id="issuesToggle"> issues overlay (<span id="issueCount"></span>)</label>
  <span class="sub" style="margin-left:auto">double-click a boundary to collapse/expand · drag to pan · wheel to zoom</span>
</header>
<div id="wrap">
  <div id="stage">
    <svg id="svg" width="100%" height="100%">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="#8d97a5"></path>
        </marker>
        <marker id="arrowCross" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="#c26767"></path>
        </marker>
      </defs>
      <g id="root"></g>
    </svg>
    <div class="legend">
      <span class="sw" style="background:var(--entry-fill);border-color:var(--entry-stroke)"></span>Portal/Observer&nbsp;&nbsp;
      <span class="sw" style="background:var(--logic-fill);border-color:var(--logic-stroke)"></span>Logic&nbsp;&nbsp;
      <span class="sw" style="background:var(--data-fill);border-color:var(--data-stroke)"></span>Data&nbsp;&nbsp;
      <span class="sw" style="background:var(--adapter-fill);border-color:var(--adapter-stroke)"></span>Adapter&nbsp;&nbsp;
      <span class="sw" style="background:var(--pattern-fill);border-color:var(--pattern-stroke)"></span>Pattern&nbsp;&nbsp;
      — bold border = published · <span style="color:var(--cross)">thick red edge</span> = boundary hop · thick faded edge = collapsed tube
    </div>
  </div>
  <div id="panel"><h2>Architecture canvas</h2><p class="desc">Click any component, pattern, or subsystem for details. Derived from <code>.wai/specs/</code> — the same source of truth as the conformance gate.</p></div>
</div>
<script>
var MODEL = ${embedJson(model)};
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

  var state = {
    collapsed: {},          // subsystem or pattern id -> true
    selected: null,
    showIssues: false,
    query: ''
  };

  function stereoClass(t) {
    if (t === 'Portal' || t === 'Observer') return 'entry';
    if (t === 'Store' || t === 'Index' || t === 'Registry') return 'data';
    if (t === 'Adapter') return 'adapter';
    if (t === 'Repository' || t === 'Gateway' || t === 'FeatureComponent' || t === 'RouterComponent') return 'pattern';
    return 'logic';
  }
  var FILL = { entry:'#eef4ff', logic:'#f4effd', data:'#fdf6e3', adapter:'#eef8f1', pattern:'#f6f8fa' };
  var STROKE = { entry:'#4a7dcf', logic:'#8a63c9', data:'#c9963f', adapter:'#4f9e6b', pattern:'#6a737d' };
  var PATTERN_TYPES = { Repository:1, Gateway:1, FeatureComponent:1, RouterComponent:1 };

  // ---- layout --------------------------------------------------------------
  var BOX_W = 188, BOX_H = 50, GAP_X = 70, GAP_Y = 22, SUB_PAD = 22, SUB_HEAD = 36;
  var MEMBER_W = 168, MEMBER_H = 42, PAT_PAD = 12, PAT_HEAD = 30;

  function layerOf(comp, topIds, memo, stack) {
    if (memo[comp.id] !== undefined) return memo[comp.id];
    if (stack[comp.id]) return 0; // cycle guard
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
      return { w: MEMBER_W + PAT_PAD * 2 + 20, h: PAT_HEAD + comp.owns.length * (MEMBER_H + 10) + PAT_PAD };
    }
    return { w: BOX_W, h: BOX_H };
  }

  // Returns { boxes: {id:{x,y,w,h,kind}}, subs: {id:{x,y,w,h,collapsed}}, width, height }
  function layout() {
    var boxes = {}, subs = {};
    // subsystem order: alphabetical, stable and predictable
    var order = MODEL.subsystems.slice().sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    var sizes = {};
    order.forEach(function (sub) {
      if (state.collapsed[sub.id]) { sizes[sub.id] = { w: 240, h: 72, cols: [] }; return; }
      var comps = MODEL.components.filter(function (c) { return c.subsystem === sub.id && !c.owner; });
      var topIds = {}; comps.forEach(function (c) { topIds[c.id] = true; });
      var memo = {};
      comps.forEach(function (c) { layerOf(c, topIds, memo, {}); });
      var cols = {};
      comps.forEach(function (c) { (cols[memo[c.id]] = cols[memo[c.id]] || []).push(c); });
      var colKeys = Object.keys(cols).map(Number).sort(function (a, b) { return a - b; });
      var width = SUB_PAD * 2, height = 0;
      var colInfo = [];
      colKeys.forEach(function (k) {
        var colComps = cols[k].sort(function (a, b) { return a.id < b.id ? -1 : 1; });
        var colW = 0, colH = 0;
        colComps.forEach(function (c) { var s = boxSizeFor(c); colW = Math.max(colW, s.w); colH += s.h + GAP_Y; });
        colInfo.push({ comps: colComps, w: colW, h: colH });
        width += colW + GAP_X;
        height = Math.max(height, colH);
      });
      if (colInfo.length) width -= GAP_X;
      sizes[sub.id] = { w: Math.max(width, 240), h: SUB_HEAD + height + SUB_PAD, cols: colInfo };
    });

    // place subsystems in rows
    var MAX_ROW = 1750, x = 30, y = 20, rowH = 0, totalW = 0;
    order.forEach(function (sub) {
      var s = sizes[sub.id];
      if (x + s.w > MAX_ROW && x > 30) { x = 30; y += rowH + 46; rowH = 0; }
      subs[sub.id] = { x: x, y: y, w: s.w, h: s.h, collapsed: !!state.collapsed[sub.id] };
      // place its components
      if (!state.collapsed[sub.id]) {
        var cx = x + SUB_PAD;
        s.cols.forEach(function (col) {
          var cy = y + SUB_HEAD + (s.h - SUB_HEAD - SUB_PAD - col.h + GAP_Y) / 2;
          col.comps.forEach(function (c) {
            var bs = boxSizeFor(c);
            boxes[c.id] = { x: cx, y: cy, w: bs.w, h: bs.h, kind: 'comp' };
            // pattern members inside
            if (PATTERN_TYPES[c.componentType] && c.owns.length && !state.collapsed[c.id]) {
              var my = cy + PAT_HEAD;
              c.owns.forEach(function (mid) {
                boxes[mid] = { x: cx + PAT_PAD + 10, y: my, w: MEMBER_W, h: MEMBER_H, kind: 'member' };
                my += MEMBER_H + 10;
              });
            }
            cy += bs.h + GAP_Y;
          });
          cx += col.w + GAP_X;
        });
      }
      x += s.w + 46;
      rowH = Math.max(rowH, s.h);
      totalW = Math.max(totalW, x);
    });
    return { boxes: boxes, subs: subs, width: totalW + 40, height: y + rowH + 60 };
  }

  // The visible box representing a component id under current collapse state.
  function anchorFor(id, L) {
    var c = compById[id];
    if (!c) return null;
    if (state.collapsed[c.subsystem]) return { id: c.subsystem, box: L.subs[c.subsystem] };
    if (c.owner && state.collapsed[c.owner]) return { id: c.owner, box: L.boxes[c.owner] };
    if (L.boxes[id]) return { id: id, box: L.boxes[id] };
    return null;
  }

  // ---- svg helpers ----------------------------------------------------------
  var SVG = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, parent) {
    var e = document.createElementNS(SVG, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function textEl(parent, x, y, str, attrs) {
    var t = el('text', Object.assign({ x: x, y: y }, attrs || {}), parent);
    t.textContent = str;
    return t;
  }
  function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function matches(c) {
    if (!state.query) return true;
    var q = state.query.toLowerCase();
    return c.id.toLowerCase().indexOf(q) >= 0 || c.name.toLowerCase().indexOf(q) >= 0;
  }

  // ---- render ----------------------------------------------------------------
  var root = document.getElementById('root');
  function render() {
    var L = layout();
    while (root.firstChild) root.removeChild(root.firstChild);

    // subsystem containers
    MODEL.subsystems.forEach(function (sub) {
      var sb = L.subs[sub.id];
      var g = el('g', { 'class': 'subsys' + (sb.collapsed ? ' collapsed' : '') + (state.query && !MODEL.components.some(function (c) { return c.subsystem === sub.id && matches(c); }) ? ' dimmed' : '') }, root);
      el('rect', { 'class': 'frame', x: sb.x, y: sb.y, width: sb.w, height: sb.h, rx: 10 }, g);
      el('rect', { 'class': 'head', x: sb.x + 1, y: sb.y + 1, width: sb.w - 2, height: SUB_HEAD - 8, rx: 9 }, g);
      var head = textEl(g, sb.x + 14, sb.y + 20, trunc(sub.name, 40), { 'class': 'subheader' });
      textEl(g, sb.x + sb.w - 22, sb.y + 20, sb.collapsed ? '▸' : '▾', { 'class': 'subtoggle' });
      if (sb.collapsed) textEl(g, sb.x + 14, sb.y + 46, trunc(sub.description, 34), { fill: '#57606a', 'font-size': '11px' });
      g.addEventListener('dblclick', function (ev) { ev.stopPropagation(); state.collapsed[sub.id] = !state.collapsed[sub.id]; render(); });
      head.addEventListener('click', function (ev) { ev.stopPropagation(); select({ kind: 'subsystem', id: sub.id }); });
      g.addEventListener('click', function () { select({ kind: 'subsystem', id: sub.id }); });
    });

    // edges (aggregated by visible anchors)
    var agg = {};
    MODEL.edges.forEach(function (e) {
      var a = anchorFor(e.from, L), b = anchorFor(e.to, L);
      if (!a || !b || a.id === b.id) return;
      var key = a.id + '=>' + b.id;
      if (!agg[key]) agg[key] = { a: a, b: b, n: 0, cross: false, tube: a.id !== e.from || b.id !== e.to };
      agg[key].n++;
      if (e.cross) agg[key].cross = true;
    });
    Object.keys(agg).forEach(function (key) {
      var e = agg[key];
      var x1 = e.a.box.x + e.a.box.w, y1 = e.a.box.y + e.a.box.h / 2;
      var x2 = e.b.box.x, y2 = e.b.box.y + e.b.box.h / 2;
      if (x2 < x1 - 10) { x1 = e.a.box.x; x2 = e.b.box.x + e.b.box.w; }
      var dx = Math.max(40, Math.abs(x2 - x1) / 2);
      var d = 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + (x2 >= x1 ? dx : -dx)) + ' ' + y1 + ', ' + (x2 + (x2 >= x1 ? -dx : dx)) + ' ' + y2 + ', ' + x2 + ' ' + y2;
      var cls = 'edge' + (e.cross ? ' cross' : '') + (e.tube ? ' tube' : '');
      el('path', { d: d, 'class': cls, 'marker-end': e.cross ? 'url(#arrowCross)' : 'url(#arrow)' }, root);
      if (e.tube && e.n > 1) {
        textEl(root, (x1 + x2) / 2, (y1 + y2) / 2 - 6, e.n + ' links', { 'class': 'edgeLabel', 'text-anchor': 'middle' });
      }
    });

    // component boxes (patterns first so members draw on top)
    var drawn = Object.keys(L.boxes).map(function (id) { return compById[id]; }).filter(Boolean);
    drawn.sort(function (a, b) { return (L.boxes[a.id].kind === 'member' ? 1 : 0) - (L.boxes[b.id].kind === 'member' ? 1 : 0); });
    drawn.forEach(function (c) {
      var b = L.boxes[c.id];
      var sc = stereoClass(c.componentType);
      var isPattern = PATTERN_TYPES[c.componentType] && c.owns.length && !state.collapsed[c.id];
      var cls = 'comp' + (c.public ? ' public' : '') + (isPattern ? ' pattern' : '')
        + (state.selected && state.selected.id === c.id ? ' selected' : '')
        + (state.query && !matches(c) ? ' dimmed' : '')
        + (state.showIssues && issuesBySpec[c.id] ? ' hasIssue' : '');
      var g = el('g', { 'class': cls }, root);
      el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 8, fill: FILL[sc], stroke: STROKE[sc] }, g);
      textEl(g, b.x + 10, b.y + 19, trunc(c.name, b.w > 180 ? 24 : 21), { 'font-weight': 600, 'font-size': '12px' });
      textEl(g, b.x + 10, b.y + 34, '«' + c.componentType + (c.portalType ? '/' + c.portalType : '') + '»', { fill: '#57606a', 'font-size': '10.5px' });
      if (isPattern) {
        g.addEventListener('dblclick', function (ev) { ev.stopPropagation(); state.collapsed[c.id] = true; render(); });
      } else if (PATTERN_TYPES[c.componentType] && c.owns.length) {
        g.addEventListener('dblclick', function (ev) { ev.stopPropagation(); delete state.collapsed[c.id]; render(); });
      }
      g.addEventListener('click', function (ev) { ev.stopPropagation(); select({ kind: 'component', id: c.id }); });
    });
  }

  // ---- detail panel ----------------------------------------------------------
  var panel = document.getElementById('panel');
  function esc(s) { var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
  function chip(label, target) {
    return '<span class="chip" data-goto="' + esc(target || '') + '">' + esc(label) + '</span>';
  }
  function issueHtml(list) {
    return list.map(function (i) {
      return '<div class="issue ' + esc(i.severity) + '"><code>' + esc(i.code) + '</code><br>' + esc(i.message) + '</div>';
    }).join('');
  }
  function select(sel) {
    state.selected = sel;
    var html = '';
    if (sel && sel.kind === 'component') {
      var c = compById[sel.id];
      html += '<h2>' + esc(c.name) + '</h2>';
      html += '<span class="chip static">«' + esc(c.componentType) + (c.portalType ? '/' + esc(c.portalType) : '') + '»</span>';
      if (c.public) html += '<span class="chip static">published</span>';
      if (c.status) html += '<span class="chip static">' + esc(c.status) + '</span>';
      html += '<span class="chip" data-goto="sub:' + esc(c.subsystem) + '">' + esc(c.subsystem) + '</span>';
      html += '<p class="desc">' + esc(c.description) + '</p>';
      if (c.dependsOn.length) { html += '<h3>Depends on</h3>' + c.dependsOn.map(function (d) { return chip(d, 'comp:' + d); }).join(''); }
      if (c.owns.length) { html += '<h3>Owns</h3>' + c.owns.map(function (d) { return chip(d, 'comp:' + d); }).join(''); }
      c.interfaces.forEach(function (intf) {
        html += '<h3>' + esc(intf.name) + ' <code>' + esc(intf.id) + '</code></h3>';
        intf.methods.forEach(function (m) {
          html += '<div class="method"><b>' + esc(m.name) + '</b><br><code>' + esc(m.signature) + '</code><br><span class="ret">returns ' + esc(m.returns) + '</span>';
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
            if (s.call) html += ' → <span class="call" data-goto="comp:' + esc(s.call.component) + '">' + esc(s.call.component) + '.' + esc(s.call.method) + '()</span>';
            html += '</div>';
          });
          html += '</div>';
        });
      }
      var iss = issuesBySpec[c.id];
      if (iss) html += '<h3>Validation issues</h3>' + issueHtml(iss);
    } else if (sel && sel.kind === 'subsystem') {
      var s = subById[sel.id];
      html += '<h2>' + esc(s.name) + '</h2><span class="chip static">subsystem</span>';
      if (s.targetLanguage) html += '<span class="chip static">' + esc(s.targetLanguage) + '</span>';
      html += '<p class="desc">' + esc(s.description) + '</p>';
      if (s.trustedLinks.length) {
        html += '<h3>Trusted links (fast lanes)</h3>';
        s.trustedLinks.forEach(function (t) { html += '<div class="method">' + chip(t.subsystem, 'sub:' + t.subsystem) + '<br><span class="desc">' + esc(t.reason) + '</span></div>'; });
      }
      var comps = MODEL.components.filter(function (c) { return c.subsystem === s.id; });
      html += '<h3>Components (' + comps.length + ')</h3>' + comps.map(function (c) { return chip(c.id, 'comp:' + c.id); }).join('');
      var iss2 = issuesBySpec[s.id];
      if (iss2) html += '<h3>Validation issues</h3>' + issueHtml(iss2);
    } else {
      html += '<h2>' + esc(MODEL.system.name) + '</h2>';
      if (MODEL.system.targetLanguage) html += '<span class="chip static">' + esc(MODEL.system.targetLanguage) + '</span>';
      if (MODEL.system.vision) html += '<p class="desc">' + esc(MODEL.system.vision) + '</p>';
      if (state.showIssues && MODEL.issues.length) html += '<h3>All validation issues</h3>' + issueHtml(MODEL.issues);
    }
    panel.innerHTML = html;
    panel.querySelectorAll('[data-goto]').forEach(function (n) {
      n.addEventListener('click', function () {
        var t = n.getAttribute('data-goto');
        if (t.indexOf('comp:') === 0) select({ kind: 'component', id: t.slice(5) });
        if (t.indexOf('sub:') === 0) select({ kind: 'subsystem', id: t.slice(4) });
      });
    });
    render();
  }

  // ---- pan & zoom -------------------------------------------------------------
  var view = { x: 20, y: 20, k: 1 };
  var svg = document.getElementById('svg'), stage = document.getElementById('stage');
  function applyView() { root.setAttribute('transform', 'translate(' + view.x + ' ' + view.y + ') scale(' + view.k + ')'); }
  stage.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var rect = svg.getBoundingClientRect();
    var mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    var factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    var k2 = Math.min(3, Math.max(0.15, view.k * factor));
    view.x = mx - (mx - view.x) * (k2 / view.k);
    view.y = my - (my - view.y) * (k2 / view.k);
    view.k = k2;
    applyView();
  }, { passive: false });
  var panning = null;
  stage.addEventListener('mousedown', function (ev) { panning = { x: ev.clientX - view.x, y: ev.clientY - view.y }; stage.classList.add('panning'); });
  window.addEventListener('mousemove', function (ev) { if (!panning) return; view.x = ev.clientX - panning.x; view.y = ev.clientY - panning.y; applyView(); });
  window.addEventListener('mouseup', function () { panning = null; stage.classList.remove('panning'); });

  // ---- controls -----------------------------------------------------------------
  document.getElementById('search').addEventListener('input', function (ev) { state.query = ev.target.value.trim(); render(); });
  document.getElementById('issuesToggle').addEventListener('change', function (ev) { state.showIssues = ev.target.checked; select(state.selected); });

  render();
  applyView();
})();
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
