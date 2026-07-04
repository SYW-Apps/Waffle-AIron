import * as fs from 'fs';
import * as path from 'path';
import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  loadTypeSpecs,
} from './specs.js';
import type { ValidationIssue } from './validation.js';
import { extractTypeIdentifiers, matchTypeRef, methodTypeRefs } from './rules/type-analysis.js';
import { buildDrawioXml, buildExcalidrawScene } from './diagram-export.js';

// ---------------------------------------------------------------------------
// Interactive architecture canvas — a self-contained single-page app with
// C4-style scoped navigation.
//
// One HTML file, zero network: Cytoscape.js is vendored inline, and the
// export builders (buildDrawioXml / buildExcalidrawScene) are serialized
// verbatim from their TypeScript modules — in-browser exports use the
// CURRENT view and positions (main canvas AND narrative flowcharts).
//
// Navigation model: a VIEW renders exactly one scope's direct children —
// System → top-level subsystems → a subsystem's children (nested subsystems
// + components) → a pattern's members, infinitely deep by ownership.
// Double-click drills in; the breadcrumb navigates back out. "Internals"
// previews each child's own children inside its box WITH their relations
// (micro-layered). "Externals" shows ghost references to out-of-scope
// dependencies. Per-view layout rearrangements persist in localStorage.
//
// All theme fills are solid and chosen for WCAG AA (≥4.5:1) text contrast.
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
      steps: {
        n: number;
        text: string;
        kind: string;
        call?: { component: string; method: string };
        // flow config (present per kind; names kept short — this JSON ships inline in the HTML)
        cond?: string;
        onTrue?: number;
        onFalse?: number;
        on?: string;
        cases?: { value: string; step: number }[];
        defaultStep?: number;
        loopKind?: string;
        over?: string;
        end?: number;
        catches?: { error: string; step: number }[];
        fin?: number;
        to?: number;
        outcome?: string;
        err?: string;
      }[];
    }[];
    /** Methods specified as intent prose instead of a narrative (the detail dial). */
    intents: { method: string; text: string }[];
  }[];
  edges: { from: string; to: string; cross: boolean }[];
  types: {
    id: string;
    name: string;
    kind: string;
    subsystem?: string;
    fields: { name: string; type: string; optional?: boolean; key?: string }[];
    methods: { name: string; signature: string; returns: string; description?: string }[];
    /** Interface methods whose params/returns reference this type (usage trace). */
    usedBy: { component: string; method: string }[];
  }[];
  /** Type → type references derived from field type strings (ERD edges). */
  typeEdges: { from: string; to: string; field: string; card: '1' | '0..1' | '*' }[];
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
    const intents: CanvasModel['components'][number]['intents'] = [];
    for (const impl of impls) {
      for (const m of impl.methods) {
        if (!m.narrative.length) {
          if (m.intent) intents.push({ method: m.name, text: m.intent });
          continue;
        }
        narratives.push({
          method: m.name,
          steps: m.narrative.map(s => ({
            n: s.stepNumber,
            text: s.description,
            kind: s.type,
            ...(s.type === 'call' && s.targetComponent && s.targetMethod
              ? { call: { component: s.targetComponent, method: s.targetMethod } }
              : {}),
            ...(s.condition ? { cond: s.condition } : {}),
            ...(s.onTrueStep !== undefined ? { onTrue: s.onTrueStep } : {}),
            ...(s.onFalseStep !== undefined ? { onFalse: s.onFalseStep } : {}),
            ...(s.on ? { on: s.on } : {}),
            ...(s.cases && s.cases.length ? { cases: s.cases } : {}),
            ...(s.defaultStep !== undefined ? { defaultStep: s.defaultStep } : {}),
            ...(s.loopKind ? { loopKind: s.loopKind } : {}),
            ...(s.over ? { over: s.over } : {}),
            ...(s.endStep !== undefined ? { end: s.endStep } : {}),
            ...(s.catches && s.catches.length ? { catches: s.catches } : {}),
            ...(s.finallyStep !== undefined ? { fin: s.finallyStep } : {}),
            ...(s.toStep !== undefined ? { to: s.toStep } : {}),
            ...(s.outcome ? { outcome: s.outcome } : {}),
            ...(s.error ? { err: s.error } : {}),
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
      intents,
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

  // Types + ERD reference edges (field type strings → defined types)
  const typeSpecs = loadTypeSpecs();
  // Usage trace: every interface method whose params/returns reference a type.
  const usedByFor = (t: (typeof typeSpecs)[number]): { component: string; method: string }[] => {
    const qualified = t.subsystem && !t.id.startsWith(`${t.subsystem}::`) ? `${t.subsystem}::${t.id}` : t.id;
    const seen = new Set<string>();
    const out: { component: string; method: string }[] = [];
    for (const intf of interfaces) {
      for (const m of intf.methods) {
        for (const ref of methodTypeRefs(m)) {
          if (!matchTypeRef(ref, qualified)) continue;
          const k = `${intf.component}#${m.name}`;
          if (!seen.has(k)) { seen.add(k); out.push({ component: intf.component, method: m.name }); }
          break;
        }
      }
    }
    return out;
  };

  const modelTypes: CanvasModel['types'] = typeSpecs.map(t => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    ...(t.subsystem ? { subsystem: t.subsystem } : {}),
    fields: t.fields.map(f => ({ name: f.name, type: f.type, ...(f.optional ? { optional: true } : {}), ...(f.key ? { key: f.key } : {}) })),
    methods: t.methods.map(m => ({ name: m.name, signature: m.signature, returns: m.returns, ...(m.description ? { description: m.description } : {}) })),
    usedBy: usedByFor(t),
  }));
  // Cardinality is derivable from the field's type string: collection shapes
  // mean "many", the optional flag means 0..1 — real ERD multiplicity for free.
  const MANY_SHAPE = /\[\s*\]|Array<|Vec<|Set<|List<|Map<|Record<|HashMap</i;
  const typeEdges: CanvasModel['typeEdges'] = [];
  for (const t of typeSpecs) {
    for (const field of t.fields) {
      for (const ref of extractTypeIdentifiers(field.type)) {
        const target = typeSpecs.find(other => {
          const qualified = other.subsystem && !other.id.startsWith(`${other.subsystem}::`)
            ? `${other.subsystem}::${other.id}`
            : other.id;
          return matchTypeRef(ref, qualified);
        });
        if (target && target.id !== t.id) {
          const card = MANY_SHAPE.test(field.type) ? '*' : field.optional ? '0..1' : '1';
          typeEdges.push({ from: t.id, to: target.id, field: field.name, card });
        }
      }
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
    types: modelTypes,
    typeEdges,
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
  --chrome: #0e1a2b;
  --chrome-border: rgba(34, 221, 255, 0.22);
  --ink: #e8ecf3;
  --dim: #9db0c7;
  --line: rgba(255,255,255,0.12);
  --input-bg: rgba(255,255,255,0.07);
  --hover-bg: rgba(34, 221, 255, 0.12);
  --accent: var(--syw-cyan);
  --card: rgba(255,255,255,0.05);
  --danger: #ff6b81; --warn: #f59e0b;
}
body[data-theme="light"] {
  --bg: #f2f5f8;
  --chrome: #ffffff;
  --chrome-border: #cfd8e1;
  --ink: #1f2328;
  --dim: #4d5761;
  --line: #dde4ea;
  --input-bg: #f1f4f7;
  --hover-bg: rgba(74, 125, 207, 0.10);
  --accent: #3465b4;
  --card: #f7fafc;
  --danger: #c22f3e; --warn: #9a6a00;
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
.seg { display:flex; border:1px solid var(--chrome-border); border-radius:8px; overflow:hidden; }
.seg button { border:none; background:transparent; color:var(--dim); padding:5px 11px; cursor:pointer; font:inherit; font-size:12px; }
.seg button.active { background:var(--accent); color:#fff; font-weight:700; }

.dropdown { position:relative; }
.dropdown .menu { display:none; position:absolute; right:0; top:calc(100% + 6px); background:var(--chrome); border:1px solid var(--chrome-border); border-radius:10px; box-shadow:var(--syw-deep-shadow); min-width:200px; padding:6px; z-index:120; }
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
#typesWarn { position:absolute; top:10px; left:50%; transform:translateX(-50%); color:var(--ink); font-size:12px; background:var(--chrome); border:1px solid var(--warn); border-radius:9px; padding:6px 12px; z-index:6; max-width:72vw; box-shadow:var(--syw-deep-shadow); display:none; }
#typesWarn button { margin-left:8px; }

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
#panel .method .mname { font-weight:700; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
#panel .method .mname .grow { flex:1; }
#panel .method code { font-size:11px; word-break:break-all; color:var(--dim); display:block; margin-top:3px; }
#panel .method .mdesc { color:var(--dim); font-size:12px; margin-top:3px; }
#panel .flowbtn { border:1px solid var(--chrome-border); background:var(--input-bg); color:var(--accent); font-size:10.5px; padding:2px 8px; border-radius:7px; cursor:pointer; }
#panel .flowbtn:hover { background:var(--hover-bg); }
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
#flowModal .box { width:min(880px, 92vw); height:min(660px, 88vh); background:var(--chrome); border:1px solid var(--chrome-border); border-radius:14px; box-shadow:var(--syw-deep-shadow); display:flex; flex-direction:column; overflow:hidden; }
#flowModal .bar { display:flex; align-items:center; gap:10px; padding:10px 14px; border-bottom:1px solid var(--line); }
#flowModal .bar .crumbf { font-weight:700; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#flowModal .bar .crumbf .dimc { color:var(--dim); font-weight:400; }
#flowCy { flex:1; }
#flowSteps { flex:1; display:none; overflow-y:auto; padding:16px 22px; }
#flowModal.steps #flowCy { display:none; }
#flowModal.steps #flowSteps { display:block; }
#flowSteps .fstep { border:1px solid var(--line); border-radius:9px; background:var(--card); padding:9px 12px; margin:8px 0; font-size:12.5px; }
#flowSteps .fstep .num { display:inline-block; min-width:22px; font-weight:700; color:var(--accent); }
#flowSteps .fstep .call { color:var(--accent); cursor:pointer; text-decoration:underline dotted; }
#flowModal .hintbar { padding:6px 14px; color:var(--dim); font-size:11px; border-top:1px solid var(--line); }
</style>
</head>
<body data-theme="syw">
<header>
  <span class="brand syw-gradient-text">wairon</span>
  <div class="seg" id="modeSeg" title="Switch between the component architecture and the type ERD">
    <button data-vm="components" class="active">Components</button>
    <button data-vm="types">Types</button>
  </div>
  <nav id="crumbs"></nav>
  <span class="divider"></span>
  <input id="search" type="search" placeholder="Search this view…">
  <label class="switch" title="Preview each child's own children and their relations inside its box"><input type="checkbox" id="internalsToggle"><span>Internals</span></label>
  <label class="switch" title="Show out-of-scope dependencies as ghost references"><input type="checkbox" id="externalsToggle" checked><span>Externals</span></label>
  <label class="switch"><input type="checkbox" id="issuesToggle"><span>Issues (<span id="issueCount"></span>)</span></label>
  <label class="switch"><input type="checkbox" id="dragToggle"><span>Rearrange</span></label>
  <div class="seg" id="typesDetailSeg" style="display:none" title="ERD detail level">
    <button data-td="full">Full</button>
    <button data-td="fields">Fields</button>
    <button data-td="keys">Keys</button>
    <button data-td="names">Names</button>
  </div>
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
    <div id="typesWarn"></div>
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
      <div class="seg" id="flowModeSeg">
        <button data-fm="flow" class="active">Flow</button>
        <button data-fm="steps">Steps</button>
      </div>
      <button class="tbtn" id="flowErrToggle" title="Hide the paths only reachable through error handling (catch regions, propagated throws)">Hide error paths</button>
      <div class="dropdown" id="flowExportDd">
        <button class="tbtn" id="flowExportBtn">Export ▾</button>
        <div class="menu">
          <button id="flowExpPng">PNG image</button>
          <button id="flowExpDrawio">draw.io file</button>
          <button id="flowExpExcalidraw">Excalidraw file</button>
        </div>
      </div>
      <button class="tbtn" id="flowClose">✕</button>
    </div>
    <div id="flowCy"></div>
    <div id="flowSteps"></div>
    <div class="hintbar">Narrative (L5) — double-click a call step to drill into the target method; Back returns to the caller.</div>
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
  var IN = function (kind, id) { return 'i~' + kind + '~' + id; };

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
  function subsystemChainOf(comp) {
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
      return { kind: 'component', id: owners.length ? owners[0] : c.id };
    }
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
    typesDetail: ['full', 'fields', 'keys', 'names'].indexOf(saved.typesDetail) >= 0 ? saved.typesDetail : 'full',
    typesRenderAll: false,
  };
  // Set by buildTypeElements when the ERD is degraded for performance (huge
  // scopes); consumed by renderTypesNotice to explain the level-of-detail.
  var typesNotice = '';

  function viewKey() {
    // 'types2' + detail level: table sizes differ per detail, and the prefix
    // bump invalidates layouts saved for the old compact type boxes.
    if (state.view.kind === 'types') return 'types2:' + (state.view.id || 'root') + ':' + state.typesDetail;
    return state.view.kind + ':' + (state.view.id || 'root') + (state.internals ? '+i' : '');
  }
  function persist() {
    if (!store) return;
    try { store.setItem(STORE_KEY, JSON.stringify({ positionsByView: saved.positionsByView || {}, theme: state.theme, typesDetail: state.typesDetail })); } catch (e) { /* non-fatal */ }
  }

  function matches(entry) {
    if (!state.query) return true;
    var q = state.query.toLowerCase();
    return entry.id.toLowerCase().indexOf(q) >= 0 || nameOf(entry).toLowerCase().indexOf(q) >= 0;
  }

  // ---- themes (solid fills, WCAG AA text contrast) ------------------------------
  var THEMES = {
    light: {
      pageEdge: '#5f6b78', edgeText: '#3d4650', cross: '#b3261e', ink: '#1a1f24',
      subFill: '#e9eef4', subStroke: '#8195aa', subText: '#122a44',
      patFill: '#eef1f5', patStroke: '#5f6b78',
      innerFill: '#dbe3ec', innerStroke: '#8195aa', innerText: '#1a1f24',
      ghostFill: '#eceff2', ghostStroke: '#7d8a97', ghostText: '#414b55',
      typeE: { fill: '#e6efd8', stroke: '#4e6b23', text: '#22300d' },
      typeV: { fill: '#ecdff3', stroke: '#6e4288', text: '#2d1740' },
      proxyIn: { fill: '#d5eef8', stroke: '#14708f' },
      proxyOut: { fill: '#f7e8cd', stroke: '#8a6116' },
      stereo: {
        entry:   { fill: '#dcebff', stroke: '#2f5fa8', text: '#0f2a4d' },
        logic:   { fill: '#ece2fb', stroke: '#6d3fbf', text: '#2a1650' },
        data:    { fill: '#f7ecd0', stroke: '#8a6116', text: '#3d2c05' },
        adapter: { fill: '#dcf2e4', stroke: '#2e7d4f', text: '#0e3320' },
        patternLeaf: { fill: '#eef1f5', stroke: '#5f6b78', text: '#1a1f24' },
      },
      issue: '#b3261e', selGlow: '#3465b4', bgLabel: '#f2f5f8', png: '#f2f5f8',
    },
    syw: {
      pageEdge: '#7c8ca3', edgeText: '#aebdd2', cross: '#ff6b81', ink: '#eef2f8',
      subFill: '#101f33', subStroke: '#3ec5e8', subText: '#7fe7ff',
      patFill: '#1b2740', patStroke: '#93a1b8',
      innerFill: '#243a5c', innerStroke: '#6b7c96', innerText: '#eef2f8',
      ghostFill: '#16202f', ghostStroke: '#5d6b80', ghostText: '#aab8cc',
      typeE: { fill: '#1e3317', stroke: '#8fd14f', text: '#e2f5cf' },
      typeV: { fill: '#321a3d', stroke: '#c084fc', text: '#f0dcff' },
      proxyIn: { fill: '#0d3b4a', stroke: '#22ddff' },
      proxyOut: { fill: '#3b2a10', stroke: '#f59e0b' },
      stereo: {
        entry:   { fill: '#0d2b4d', stroke: '#22ddff', text: '#d8f6ff' },
        logic:   { fill: '#2a2052', stroke: '#a78bfa', text: '#eae2ff' },
        data:    { fill: '#3a2c10', stroke: '#f59e0b', text: '#ffe9c2' },
        adapter: { fill: '#0f3323', stroke: '#34d399', text: '#d3f8e6' },
        patternLeaf: { fill: '#1b2740', stroke: '#93a1b8', text: '#eef2f8' },
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
      { selector: '.entry', style: { 'background-color': t.stereo.entry.fill, 'border-color': t.stereo.entry.stroke, color: t.stereo.entry.text } },
      { selector: '.logic', style: { 'background-color': t.stereo.logic.fill, 'border-color': t.stereo.logic.stroke, color: t.stereo.logic.text } },
      { selector: '.data', style: { 'background-color': t.stereo.data.fill, 'border-color': t.stereo.data.stroke, color: t.stereo.data.text } },
      { selector: '.adapter', style: { 'background-color': t.stereo.adapter.fill, 'border-color': t.stereo.adapter.stroke, color: t.stereo.adapter.text } },
      { selector: '.patternLeaf', style: { 'background-color': t.stereo.patternLeaf.fill, 'border-color': t.stereo.patternLeaf.stroke, color: t.stereo.patternLeaf.text, 'border-style': 'dashed' } },
      { selector: '.subsysBox', style: { 'background-color': t.subFill, 'border-color': t.subStroke, color: t.subText, 'font-weight': 'bold', 'font-size': 12.5 } },
      { selector: 'node.public', style: { 'border-width': 3.5 } },
      { selector: ':parent', style: { 'text-valign': 'top', 'text-halign': 'center', 'font-size': 12, 'font-weight': 'bold', 'text-margin-y': -5, padding: '10px', 'background-opacity': 1 } },
      { selector: '.inner', style: { 'background-color': t.innerFill, 'border-color': t.innerStroke, 'border-width': 1.2, 'font-size': 9.5, color: t.innerText } },
      { selector: '.ghost', style: { 'background-color': t.ghostFill, 'border-color': t.ghostStroke, 'border-style': 'dotted', color: t.ghostText, 'font-size': 10 } },
      { selector: '.typeEntity', style: { 'background-color': t.typeE.fill, 'border-color': t.typeE.stroke, color: t.typeE.text, 'text-halign': 'center', 'font-size': 10.5 } },
      { selector: '.typeValue', style: { 'background-color': t.typeV.fill, 'border-color': t.typeV.stroke, color: t.typeV.text, 'border-style': 'dashed', 'font-size': 10.5 } },
      { selector: '.typeBox', style: { 'background-opacity': 0.18, padding: '0px', 'border-width': 1.8 } },
      { selector: '.typeHead', style: { 'font-weight': 'bold', 'font-size': 11 } },
      { selector: '.typeRow', style: { 'background-color': t.innerFill, 'border-color': t.innerStroke, 'border-width': 0.5, color: t.innerText, 'font-size': 10, 'text-justification': 'left', shape: 'rectangle' } },
      { selector: '.typePlain', style: { 'font-weight': 'bold' } },
      { selector: 'edge.typeref', style: { width: 1.4, 'line-style': 'solid' } },
      { selector: 'edge.erd', style: { 'source-label': '1', 'target-label': 'data(tcard)', 'source-text-offset': 16, 'target-text-offset': 22, 'font-size': 9.5, color: t.edgeText } },
      { selector: 'edge.fieldhl', style: { 'line-color': t.selGlow, 'target-arrow-color': t.selGlow, width: 2.6 } },
      { selector: '.proxyExt', style: { 'font-size': 12, 'border-width': 1.6 } },
      { selector: '.proxyIn', style: { 'background-color': t.proxyIn.fill, 'border-color': t.proxyIn.stroke, color: t.proxyIn.stroke } },
      { selector: '.proxyOut', style: { 'background-color': t.proxyOut.fill, 'border-color': t.proxyOut.stroke, color: t.proxyOut.stroke } },
      { selector: 'edge.revealEdge', style: { 'line-color': t.selGlow, 'target-arrow-color': t.selGlow, 'line-style': 'dashed', width: 2.4, opacity: 0.95 } },
      { selector: 'edge', style: {
        'curve-style': 'bezier', width: 1.8, 'line-color': t.pageEdge,
        'target-arrow-shape': 'triangle', 'target-arrow-color': t.pageEdge, 'arrow-scale': 0.9,
        label: 'data(lbl)', 'font-size': 10, color: t.edgeText,
        'text-background-color': t.bgLabel, 'text-background-opacity': 0.85, 'text-rotation': 'autorotate',
      }},
      { selector: 'edge.cross', style: { 'line-color': t.cross, 'target-arrow-color': t.cross, width: 2.6 } },
      { selector: 'edge.bundle', style: { width: 4.5, opacity: 0.7 } },
      { selector: 'edge.toghost', style: { 'line-style': 'dashed', opacity: 0.75 } },
      { selector: 'edge.inneredge', style: { width: 1.1, 'arrow-scale': 0.6, opacity: 0.8 } },
      { selector: '.dimmed', style: { opacity: 0.13 } },
      { selector: '.hasIssue', style: { 'border-color': t.issue, 'border-style': 'dashed', 'border-width': 3 } },
      { selector: '.sel', style: { 'overlay-color': t.selGlow, 'overlay-opacity': 0.2, 'overlay-padding': 5 } },
      { selector: '.hoverhl', style: { 'overlay-color': t.selGlow, 'overlay-opacity': 0.32, 'overlay-padding': 7 } },
      // Focus mode: on selection, the picked element's edges are lifted above
      // every box and recoloured, while unrelated elements recede — so a single
      // block's relations read clearly even in a dense graph.
      { selector: '.defocus', style: { opacity: 0.08 } },
      { selector: 'edge.edgeFocus', style: {
        'line-color': t.selGlow, 'target-arrow-color': t.selGlow, 'source-arrow-color': t.selGlow,
        width: 3.6, opacity: 1, 'z-compound-depth': 'top', 'z-index': 9999,
        'text-background-opacity': 1,
      }},
      { selector: 'node.typeCluster', style: {
        'background-color': t.subFill, 'border-color': t.subStroke, color: t.subText,
        'font-weight': 'bold', 'font-size': 12, 'border-width': 2, 'text-wrap': 'wrap',
      }},
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
      sw({ fill: t.ghostFill, stroke: t.ghostStroke }) + 'External&nbsp; ' +
      sw(t.proxyIn) + '\\u21E0 in-port&nbsp; ' + sw(t.proxyOut) + '\\u21E2 out-port&nbsp; — bold border = published · ' +
      '<span style="color:' + t.cross + '">red</span> = boundary hop · double-click = open';
  }

  // ---- view layout ---------------------------------------------------------------
  var BOX_W = 200, BOX_H = 56, SUBBOX_W = 230, SUBBOX_H = 84, GAP_X = 110, GAP_Y = 34;
  var INNER_W = 130, INNER_H = 36, INNER_GAPX = 26, INNER_GAPY = 12, HEAD_H = 34, PADI = 14;

  // Micro-layout for a container's direct children when Internals is on:
  // layered mini columns + intra-container edges. Each external relation gets
  // its own small PORT node INSIDE the container (one per external
  // counterpart; incoming left, outgoing right). Children connect to ports
  // with short edges that never leave the box — the real cross-boundary line
  // is only revealed on hover, or pinned while the port is selected.
  function innerLayout(entry) {
    var kids = state.internals && entry.hasKids ? childrenOf({ kind: entry.kind, id: entry.id }) : [];
    if (!kids.length) return null;
    var scope = { kind: entry.kind, id: entry.id };
    var kidAnchor = {};
    kids.forEach(function (k) { kidAnchor[k.kind + ':' + k.id] = k; });
    var parentId = anchorNodeId(entry);
    var pBaseIn = 'p~in~' + parentId + '~', pBaseOut = 'p~out~' + parentId + '~';
    var edges = {};
    var extIn = {}, extOut = {};
    MODEL.edges.forEach(function (edge) {
      var a = childOfScopeContaining(edge.from, scope);
      var b = childOfScopeContaining(edge.to, scope);
      var aKid = a && kidAnchor[a.kind + ':' + a.id];
      var bKid = b && kidAnchor[b.kind + ':' + b.id];
      if (aKid && bKid) {
        if (a.kind === b.kind && a.id === b.id) return;
        edges[IN(a.kind, a.id) + '=>' + IN(b.kind, b.id)] = { src: IN(a.kind, a.id), tgt: IN(b.kind, b.id) };
      } else if (aKid && !bKid) {
        // raws = raw ids on OUR side of the relation — they key the matching
        // port inside the counterpart's container (port-to-port reveal).
        var ro = extOut[edge.to] = extOut[edge.to] || { kids: {}, raws: {} };
        ro.kids[a.kind + ':' + a.id] = a;
        ro.raws[edge.from] = 1;
        edges[IN(a.kind, a.id) + '=>' + pBaseOut + edge.to] = { src: IN(a.kind, a.id), tgt: pBaseOut + edge.to, stub: true };
      } else if (!aKid && bKid) {
        var ri = extIn[edge.from] = extIn[edge.from] || { kids: {}, raws: {} };
        ri.kids[b.kind + ':' + b.id] = b;
        ri.raws[edge.to] = 1;
        edges[pBaseIn + edge.from + '=>' + IN(b.kind, b.id)] = { src: pBaseIn + edge.from, tgt: IN(b.kind, b.id), stub: true };
      }
    });
    // layering
    var layer = {};
    function calc(k, stack) {
      var key = IN(k.kind, k.id);
      if (layer[key] !== undefined) return layer[key];
      if (stack[key]) return 0;
      stack[key] = 1;
      var l = 0;
      if (k.kind === 'component') {
        var c = compById[k.id];
        if (c && (c.componentType === 'Portal' || c.componentType === 'Observer')) { layer[key] = 0; delete stack[key]; return 0; }
      }
      Object.keys(edges).forEach(function (ek) {
        var e = edges[ek];
        if (e.tgt !== key) return;
        var srcKid = kids.filter(function (x) { return IN(x.kind, x.id) === e.src; })[0];
        if (srcKid) l = Math.max(l, calc(srcKid, stack) + 1);
      });
      delete stack[key];
      layer[key] = l;
      return l;
    }
    kids.forEach(function (k) { calc(k, {}); });
    var cols = {};
    kids.forEach(function (k) { var l = layer[IN(k.kind, k.id)] || 0; (cols[l] = cols[l] || []).push(k); });
    var colKeys = Object.keys(cols).map(Number).sort(function (a, b) { return a - b; });
    var inIds = Object.keys(extIn).sort(), outIds = Object.keys(extOut).sort();
    var hasIn = inIds.length > 0, hasOut = outIds.length > 0;
    var PROXY_W = 22, PROXY_H = 22, PROXY_GAP = 8;
    var tiles = [], x = PADI + (hasIn ? PROXY_W + INNER_GAPX : 0), maxH = 0;
    colKeys.forEach(function (ck) {
      var col = cols[ck].sort(function (a, b) { return a.id < b.id ? -1 : 1; });
      var y = HEAD_H;
      col.forEach(function (k) {
        tiles.push({ kid: k, x: x + INNER_W / 2, y: y + INNER_H / 2 });
        y += INNER_H + INNER_GAPY;
      });
      maxH = Math.max(maxH, y);
      x += INNER_W + INNER_GAPX;
    });
    var stackMax = Math.max(inIds.length, outIds.length);
    maxH = Math.max(maxH, HEAD_H + stackMax * PROXY_H + Math.max(0, stackMax - 1) * PROXY_GAP + INNER_GAPY);
    var midY = HEAD_H + Math.max(0, (maxH - HEAD_H - INNER_GAPY) / 2);
    var outX = x;
    if (hasOut) x += PROXY_W + INNER_GAPX;
    function stackPorts(ids, recs, base, cx, dir) {
      var total = ids.length * PROXY_H + Math.max(0, ids.length - 1) * PROXY_GAP;
      var y0 = Math.max(HEAD_H + PROXY_H / 2, midY - total / 2 + PROXY_H / 2);
      return ids.map(function (eid, i) {
        var km = recs[eid].kids, klist = [];
        Object.keys(km).forEach(function (key) { klist.push(km[key]); });
        return { id: base + eid, extId: eid, dir: dir, kids: klist, raws: Object.keys(recs[eid].raws), x: cx, y: y0 + i * (PROXY_H + PROXY_GAP), w: PROXY_W, h: PROXY_H };
      });
    }
    return {
      tiles: tiles,
      edges: Object.keys(edges).map(function (k) { return edges[k]; }),
      proxies: stackPorts(inIds, extIn, pBaseIn, PADI + PROXY_W / 2, 'in')
        .concat(stackPorts(outIds, extOut, pBaseOut, outX + PROXY_W / 2, 'out')),
      w: Math.max(x - INNER_GAPX + PADI, entry.kind === 'subsystem' ? SUBBOX_W : BOX_W),
      h: maxH - INNER_GAPY + PADI,
    };
  }

  function sizeOf(entry, inner) {
    if (inner) return { w: inner.w, h: inner.h };
    return entry.kind === 'subsystem' ? { w: SUBBOX_W, h: SUBBOX_H } : { w: BOX_W, h: BOX_H };
  }

  function viewEdges(scope, entries) {
    var entryByAnchor = {};
    entries.forEach(function (e) { entryByAnchor[e.kind + ':' + e.id] = e; });
    var agg = {}, ghosts = {};
    MODEL.edges.forEach(function (edge) {
      var a = childOfScopeContaining(edge.from, scope);
      var b = childOfScopeContaining(edge.to, scope);
      var aIn = a && entryByAnchor[a.kind + ':' + a.id];
      var bIn = b && entryByAnchor[b.kind + ':' + b.id];
      if (!aIn && !bIn) return;
      var src, tgt, ghost = false;
      if (aIn && bIn) {
        if (a.kind === b.kind && a.id === b.id) return;
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

  function externalAnchorFor(compId, scope) {
    var c = compById[compId];
    if (!c) return null;
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

  // ---- Types (ERD) view ------------------------------------------------------
  function typeMatches(t) {
    if (!state.query) return true;
    var q = state.query.toLowerCase();
    return t.id.toLowerCase().indexOf(q) >= 0 || t.name.toLowerCase().indexOf(q) >= 0;
  }
  // Types visible in the current ERD scope: the focused subsystem's own
  // (and nested) types, plus system-level shared ones. Unscoped = all.
  function typesInScope() {
    var sid = state.view.id;
    return MODEL.types.filter(function (t) {
      if (!sid) return true;
      if (!t.subsystem) return true;
      return t.subsystem === sid || t.subsystem.indexOf(sid + '::') === 0;
    });
  }

  // ERD proper: each type is a compound TABLE — header row + one child node
  // per field (marker | name | type), so relation edges anchor at the exact
  // field they originate from. Detail levels: full (+methods), fields, keys
  // (PK/U/FK rows only), names (headers + aggregated dependency lines).
  // Level-of-detail thresholds: a system can have 1000+ types, and a full
  // compound table per type (header + a node per field) melts the renderer.
  // Above CLUSTER_AT we draw a subsystem-cluster overview (a handful of nodes,
  // drill in for detail); above NAMES_AT we force header-only boxes. The user
  // can override to force full detail (accepting the cost) via the banner.
  var TYPES_CLUSTER_AT = 400, TYPES_NAMES_AT = 120;

  // Collapse the in-scope types into one node per child subsystem, with
  // aggregated cross-cluster reference edges — the whole system as a small,
  // fast, navigable map. Returns null if it wouldn't reduce to >1 cluster.
  function buildTypeClusters(list) {
    var scopeId = state.view.id;
    function keyOf(t) {
      var sub = t.subsystem || '';
      if (!sub) return '\\u2014 shared \\u2014';
      if (!scopeId) return sub.split('::')[0];
      if (sub === scopeId) return scopeId;
      if (sub.indexOf(scopeId + '::') === 0) return scopeId + '::' + sub.slice(scopeId.length + 2).split('::')[0];
      return sub.split('::')[0];
    }
    var groups = {}, order = [], clusterOf = {};
    list.forEach(function (t) {
      var k = keyOf(t); clusterOf[t.id] = k;
      if (!groups[k]) { groups[k] = 0; order.push(k); }
      groups[k]++;
    });
    if (order.length < 2) return null;
    var agg = {};
    MODEL.typeEdges.forEach(function (e) {
      var a = clusterOf[e.from], b = clusterOf[e.to];
      if (a === undefined || b === undefined || a === b) return;
      var key = a + '=>' + b; agg[key] = (agg[key] || 0) + 1;
    });
    var out = [], keys = order.slice().sort();
    var per = Math.max(1, Math.ceil(Math.sqrt(keys.length)));
    keys.forEach(function (k, i) {
      var nm = subById[k] ? subById[k].name : k;
      out.push({
        data: { id: 'TC~' + k, label: nm + '\\n' + groups[k] + ' types', w: 210, h: 66, tw: 192, clusterKey: k },
        position: { x: (i % per) * 300, y: Math.floor(i / per) * 150 }, classes: 'typeCluster',
      });
    });
    var ei = 0;
    Object.keys(agg).forEach(function (key) {
      var pr = key.split('=>');
      out.push({ data: { id: 'tc' + (ei++), source: 'TC~' + pr[0], target: 'TC~' + pr[1], lbl: agg[key] > 1 ? String(agg[key]) : '' }, classes: 'typeref' });
    });
    return out;
  }

  function buildTypeElements() {
    var eles = [];
    var det = state.typesDetail;
    var list = typesInScope();
    typesNotice = '';
    if (!state.typesRenderAll) {
      if (list.length > TYPES_CLUSTER_AT) {
        var clustered = buildTypeClusters(list);
        if (clustered) { typesNotice = 'cluster:' + list.length; return clustered; }
      }
      if (list.length > TYPES_NAMES_AT && det !== 'names') { det = 'names'; typesNotice = 'names:' + list.length; }
    }
    var inList = {};
    list.forEach(function (t) { inList[t.id] = 1; });

    var CARD_RANK = { '1': 0, '0..1': 1, '*': 2 };
    var fkBy = {}, aggRefs = {};
    MODEL.typeEdges.forEach(function (e) {
      if (!inList[e.from] || !inList[e.to]) return;
      (fkBy[e.from] = fkBy[e.from] || {})[e.field] = e;
      var key = e.from + '=>' + e.to;
      if (!aggRefs[key]) aggRefs[key] = { from: e.from, to: e.to, card: e.card || '1' };
      else if (CARD_RANK[e.card] > CARD_RANK[aggRefs[key].card]) aggRefs[key].card = e.card;
    });

    function markerOf(t, f) {
      if (f.key === 'primary') return 'PK';
      if (f.key === 'unique') return 'U';
      if (fkBy[t.id] && fkBy[t.id][f.name]) return 'FK';
      return '';
    }
    function visibleFields(t) {
      if (det === 'names') return [];
      if (det === 'keys') return t.fields.filter(function (f) { return markerOf(t, f) !== ''; });
      return t.fields;
    }
    function rowText(t, f) {
      var m = markerOf(t, f);
      return (m ? '[' + m + '] ' : '') + f.name + (f.optional ? '?' : '') + ': ' + f.type;
    }

    var groups = {}, groupIds = [];
    list.forEach(function (t) {
      var g = t.subsystem || '\\u2014 shared \\u2014';
      if (!groups[g]) { groups[g] = []; groupIds.push(g); }
      groups[g].push(t);
    });
    groupIds.sort();
    var multi = groupIds.length > 1;

    var layer = {};
    function calc(id, stack) {
      if (layer[id] !== undefined) return layer[id];
      if (stack[id]) return 0;
      stack[id] = 1;
      var l = 0;
      Object.keys(aggRefs).forEach(function (k) {
        var r = aggRefs[k];
        if (r.to !== id) return;
        l = Math.max(l, calc(r.from, stack) + 1);
      });
      delete stack[id];
      layer[id] = l;
      return l;
    }
    list.forEach(function (t) { calc(t.id, {}); });

    var ROW_H = 20, TH_H = 26, X_GAP = 170, Y_GAP = 60, GROUP_GAP = 130;
    var rowIds = {};
    var groupY = 0;
    groupIds.forEach(function (g) {
      var gid = 'TG~' + g;
      if (multi) eles.push({ data: { id: gid, label: g }, classes: 'subsysBox' });
      var cols = {};
      groups[g].forEach(function (t) { var l = layer[t.id] || 0; (cols[l] = cols[l] || []).push(t); });
      var colKeys = Object.keys(cols).map(Number).sort(function (a, b) { return a - b; });
      var x = 0, groupH = 0;
      colKeys.forEach(function (ck) {
        var col = cols[ck].sort(function (a, b) { return a.id < b.id ? -1 : 1; });
        var y = groupY, colW = 230;
        col.forEach(function (t) {
          var fields = visibleFields(t);
          var meths = det === 'full' ? t.methods : [];
          var head = t.name + '  \\u00AB' + t.kind + '\\u00BB';
          var rows = fields.map(function (f) { return rowText(t, f); })
            .concat(meths.map(function (m) { return '\\u0192 ' + m.name + '(): ' + m.returns; }));
          var longest = head.length + 4;
          rows.forEach(function (r) { if (r.length > longest) longest = r.length; });
          var W = Math.max(210, Math.min(400, longest * 6.6 + 30));
          var kindCls = t.kind === 'entity' ? 'typeEntity' : 'typeValue';
          var dim = !typeMatches(t);
          var extra = (dim ? ' dimmed' : '')
            + (state.showIssues && issuesBySpec[t.id] ? ' hasIssue' : '')
            + (state.selectedKind === 'type' && state.selected === t.id ? ' sel' : '');
          if (!rows.length) {
            var pw = Math.max(170, head.length * 6.8 + 26);
            eles.push({
              data: { id: 'T~' + t.id, parent: multi ? gid : undefined, label: head, w: pw, h: 40, tw: pw - 12 },
              position: { x: x + pw / 2, y: y + 20 },
              classes: 'typePlain ' + kindCls + extra,
            });
            y += 40 + Y_GAP;
            if (pw > colW) colW = pw;
          } else {
            eles.push({ data: { id: 'T~' + t.id, parent: multi ? gid : undefined, label: '' }, classes: 'typeBox ' + kindCls + extra });
            eles.push({
              data: { id: 'TH~' + t.id, parent: 'T~' + t.id, label: head, w: W, h: TH_H, tw: W - 12 },
              position: { x: x + W / 2, y: y + TH_H / 2 },
              classes: 'typeHead ' + kindCls + (dim ? ' dimmed' : ''),
              grabbable: false,
            });
            var ry = y + TH_H;
            fields.forEach(function (f) {
              var rid = 'TF~' + t.id + '~' + f.name;
              rowIds[rid] = 1;
              eles.push({
                data: { id: rid, parent: 'T~' + t.id, label: rowText(t, f), w: W, h: ROW_H, tw: W - 14 },
                position: { x: x + W / 2, y: ry + ROW_H / 2 },
                classes: 'typeRow' + (fkBy[t.id] && fkBy[t.id][f.name] ? ' fkRow' : '') + (dim ? ' dimmed' : ''),
                grabbable: false,
              });
              ry += ROW_H;
            });
            meths.forEach(function (m, mi) {
              eles.push({
                data: { id: 'TM~' + t.id + '~' + mi, parent: 'T~' + t.id, label: '\\u0192 ' + m.name + '(): ' + m.returns, w: W, h: ROW_H, tw: W - 14 },
                position: { x: x + W / 2, y: ry + ROW_H / 2 },
                classes: 'typeRow methRow' + (dim ? ' dimmed' : ''),
                grabbable: false,
              });
              ry += ROW_H;
            });
            y = ry + Y_GAP;
            if (W > colW) colW = W;
          }
        });
        groupH = Math.max(groupH, y - groupY);
        x += colW + X_GAP;
      });
      groupY += groupH + GROUP_GAP;
    });

    var i = 0;
    var typeById = {};
    MODEL.types.forEach(function (t) { typeById[t.id] = t; });
    var dimEdge = function (from, to) {
      return state.query && (!typeMatches(typeById[from] || { id: from, name: '' }) || !typeMatches(typeById[to] || { id: to, name: '' }));
    };
    if (det === 'names') {
      // Header-only mode: plain aggregated dependency lines, no ERD labels.
      Object.keys(aggRefs).forEach(function (k) {
        var r = aggRefs[k];
        eles.push({ data: { id: 'te' + (i++), source: 'T~' + r.from, target: 'T~' + r.to, lbl: '' }, classes: 'typeref plain' + (dimEdge(r.from, r.to) ? ' dimmed' : '') });
      });
    } else {
      // One relation line per field, anchored AT that field's row, with
      // UML multiplicity on the ends (1 at the owner, card at the target).
      MODEL.typeEdges.forEach(function (e) {
        if (!inList[e.from] || !inList[e.to]) return;
        var rowId = 'TF~' + e.from + '~' + e.field;
        eles.push({
          data: {
            id: 'te' + (i++), source: rowIds[rowId] ? rowId : 'T~' + e.from, target: 'T~' + e.to,
            lbl: '', tcard: e.card || '1', ffrom: e.from, ffield: e.field,
          },
          classes: 'typeref erd' + (dimEdge(e.from, e.to) ? ' dimmed' : ''),
        });
      });
    }
    return eles;
  }

  function buildElements() {
    var scope = state.view;
    if (scope.kind === 'types') return buildTypeElements();
    var entries = childrenOf(scope);
    var eles = [];
    var ve = viewEdges(scope, entries);
    var inners = {};
    entries.forEach(function (e) { inners[anchorNodeId(e)] = innerLayout(e); });

    // Resolve a port's reveal target(s) in THIS view. Preference order: the
    // MATCHING PORT inside the counterpart's container (a port-to-port line
    // both endpoints share), then the counterpart's container box, then a
    // ghost node when externals are shown.
    var entryAnchors = {};
    entries.forEach(function (e2) { entryAnchors[anchorNodeId(e2)] = 1; });
    function resolvePortTargets(px) {
      var child = childOfScopeContaining(px.extId, scope);
      if (child && entryAnchors[anchorNodeId(child)]) {
        var cAid = anchorNodeId(child);
        var cInner = inners[cAid];
        if (cInner && cInner.proxies) {
          var base = (px.dir === 'out' ? 'p~in~' : 'p~out~') + cAid + '~';
          var have = {};
          cInner.proxies.forEach(function (q) { have[q.id] = 1; });
          var hits = [];
          (px.raws || []).forEach(function (r) { if (have[base + r]) hits.push(base + r); });
          if (hits.length) return hits;
        }
        return [cAid];
      }
      if (state.externals) {
        var ext = externalAnchorFor(px.extId, scope);
        if (ext && ve.ghosts[ext.gid]) return [ext.gid];
      }
      return [];
    }

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
    var x = 0;
    var posByAnchor = {};
    colKeys.forEach(function (ck) {
      var col = cols[ck].sort(function (a, b) { return a.id < b.id ? -1 : 1; });
      var colW = 0, y = 0;
      col.forEach(function (e) { var s = sizeOf(e, inners[anchorNodeId(e)]); colW = Math.max(colW, s.w); });
      col.forEach(function (e) {
        var s = sizeOf(e, inners[anchorNodeId(e)]);
        posByAnchor[anchorNodeId(e)] = { x: x + colW / 2, y: y + s.h / 2, w: s.w, h: s.h };
        y += s.h + GAP_Y;
      });
      x += colW + GAP_X;
    });

    entries.forEach(function (e) {
      var aid = anchorNodeId(e);
      var p = posByAnchor[aid];
      var inner = inners[aid];
      var dim = state.query && !matches(e);
      var classes, label;
      var isPub = e.kind === 'component' && compById[e.id] && compById[e.id].public;
      if (e.kind === 'subsystem') {
        classes = 'subsysBox';
        label = nameOf(e) + (e.hasKids && !inner ? '\\n\\u25B8 open' : '');
      } else {
        var c = compById[e.id];
        classes = stereoClass(c.componentType);
        label = c.name + '\\n\\u00AB' + c.componentType + (c.portalType ? '/' + c.portalType : '') + '\\u00BB' + (e.hasKids && !inner ? ' \\u25B8' : '');
      }
      classes += (e.hasKids ? ' drillable' : '') + (isPub ? ' public' : '')
        + (dim ? ' dimmed' : '')
        + (state.showIssues && issuesBySpec[e.id] ? ' hasIssue' : '')
        + (state.selectedKind === e.kind && state.selected === e.id ? ' sel' : '');
      if (inner) {
        eles.push({ data: { id: aid, label: e.kind === 'subsystem' ? nameOf(e) : nameOf(e), w: p.w, h: p.h, tw: p.w - 16 }, classes: classes });
        inner.tiles.forEach(function (tile) {
          eles.push({
            data: {
              id: IN(tile.kid.kind, tile.kid.id), parent: aid,
              label: nameOf(tile.kid), w: INNER_W, h: INNER_H, tw: INNER_W - 10,
            },
            position: { x: p.x - p.w / 2 + tile.x, y: p.y - p.h / 2 + tile.y },
            classes: 'inner' + (dim ? ' dimmed' : ''),
          });
        });
        (inner.proxies || []).forEach(function (px) {
          eles.push({
            data: {
              id: px.id, parent: aid, label: px.dir === 'in' ? '\\u21E0' : '\\u21E2',
              w: px.w, h: px.h, tw: px.w,
              extId: px.extId, dir: px.dir,
              rvTargets: resolvePortTargets(px), rvDir: px.dir,
              viaKids: px.kids.map(function (k2) { return { kind: k2.kind, id: k2.id, label: nameOf(k2) }; }),
            },
            position: { x: p.x - p.w / 2 + px.x, y: p.y - p.h / 2 + px.y },
            classes: 'proxyExt ' + (px.dir === 'in' ? 'proxyIn' : 'proxyOut')
              + (dim ? ' dimmed' : '')
              + (state.selectedKind === 'external' && state.selected === px.id ? ' sel' : ''),
          });
        });
        inner.edges.forEach(function (ie, k) {
          eles.push({ data: { id: aid + '-ie' + k, source: ie.src, target: ie.tgt, lbl: '' }, classes: 'inneredge' + (ie.stub ? ' toghost' : '') + (dim ? ' dimmed' : '') });
        });
      } else {
        eles.push({ data: { id: aid, label: label, w: p.w, h: p.h, tw: p.w - 14 }, position: { x: p.x, y: p.y }, classes: classes });
      }
    });

    // Externals placed by dependency DIRECTION: parties entering this scope
    // (they depend on us) sit on the LEFT, in front of the entry points;
    // our outgoing dependencies sit on the RIGHT.
    var ghostDir = {};
    Object.keys(ve.agg).forEach(function (k) {
      var e = ve.agg[k];
      if (ve.ghosts[e.src]) ghostDir[e.src] = (ghostDir[e.src] || 0) | 1; // incoming
      if (ve.ghosts[e.tgt]) ghostDir[e.tgt] = (ghostDir[e.tgt] || 0) | 2; // outgoing
    });
    var gyL = 0, gyR = 0;
    Object.keys(ve.ghosts).sort().forEach(function (gid) {
      var g = ve.ghosts[gid];
      var incoming = (ghostDir[gid] || 2) & 1;
      var gx = incoming ? -(170 + 70) : x + 40;
      var gy = incoming ? gyL : gyR;
      eles.push({
        data: { id: gid, label: g.label + '\\n(external)', w: 170, h: 46, tw: 156, extKind: g.kind, extId: g.id },
        position: { x: gx + 85, y: gy + 23 },
        classes: 'ghost',
      });
      if (incoming) gyL += 46 + 18; else gyR += 46 + 18;
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
    minZoom: 0.05,
    maxZoom: 4,
    boxSelectionEnabled: false,
    autounselectify: true,
  });
  cy.autolock(true);
  var pinnedProxy = null;
  applySavedPositions();
  cy.fit(undefined, 60);
  renderCrumbs();
  renderViewHint();

  // NOTE: lift autolock globally instead of lock-juggling per node — with
  // autolock on, n.locked() is true for EVERY node, so restoring it would
  // set individual locks that survive rearrange mode (frozen tiles that no
  // longer follow their dragged parent).
  function applySavedPositions() {
    var pos = (saved.positionsByView || {})[viewKey()] || {};
    var wasAuto = cy.autolock();
    if (wasAuto) cy.autolock(false);
    cy.nodes().forEach(function (n) {
      if (!n.isParent() && pos[n.id()]) n.position(pos[n.id()]);
    });
    if (wasAuto) cy.autolock(true);
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
    pinnedProxy = null;
    cy.batch(function () {
      cy.elements().remove();
      cy.add(buildElements());
    });
    applySavedPositions();
    if (fit) cy.fit(undefined, 60);
    // A selected port survives a rebuild (e.g. issue toggle) if it still
    // exists; otherwise (Internals off) drop the selection cleanly.
    if (state.selectedKind === 'external') {
      if (cy.getElementById(state.selected).length) { pinnedProxy = state.selected; showPinned(); }
      else { state.selectedKind = null; state.selected = null; renderPanel(); }
    }
    renderCrumbs();
    renderViewHint();
    renderTypesNotice();
    updateHeaderSegs();
    if (state.selectedKind && state.selectedKind !== 'external') {
      var rfn = nodeForRef(state.selectedKind, state.selected);
      if (rfn.length) applyFocus(rfn);
    }
  }

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

  // Resolve a spec reference to whatever node represents it in the CURRENT view:
  // the exact node, its inner tile, or the visible child-of-scope containing it.
  function nodeForRef(kind, id) {
    if (kind === 'type') return cy.getElementById('T~' + id);
    if (kind === 'external') return cy.getElementById(id);
    var direct = cy.getElementById(kind === 'subsystem' ? SN(id) : CN(id));
    if (direct.length) return direct;
    var tile = cy.getElementById(IN(kind, id));
    if (tile.length) return tile;
    if (kind === 'component') {
      var child = childOfScopeContaining(id, state.view);
      if (child) {
        var anchor = cy.getElementById(anchorNodeId(child));
        if (anchor.length) return anchor;
      }
      var ghost = cy.getElementById('x~component~' + id);
      if (ghost.length) return ghost;
    } else {
      var g2 = cy.getElementById('x~subsystem~' + id);
      if (g2.length) return g2;
    }
    return cy.collection();
  }

  // ---- navigation -----------------------------------------------------------
  function crumbPath() {
    var path = [{ kind: 'system', id: null, label: MODEL.system.name }];
    var v = state.view;
    if (v.kind === 'types') {
      // Breadcrumbs stay in TYPES mode when walking up — a subsystem's types
      // lead to the PARENT'S types, not the parent's components. The header
      // Components/Types toggle remains the explicit way to change mode.
      var tpath = [{ kind: 'types', id: null, label: MODEL.system.name }];
      if (v.id) {
        var tsegs = v.id.split('::');
        for (var ti = 1; ti <= tsegs.length; ti++) {
          var tsid = tsegs.slice(0, ti).join('::');
          tpath.push({ kind: 'types', id: tsid, label: nameOf({ kind: 'subsystem', id: tsid }) });
        }
      }
      // Keep the ERD legible in the trail by tagging the current scope.
      tpath[tpath.length - 1].label += ' \\u00B7 Types (ERD)';
      return tpath;
    }
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
    if (state.view.kind === 'types') {
      var scoped = typesInScope().length;
      document.getElementById('viewHint').textContent = 'View: ' + scoped + ' types (ERD'
        + (state.view.id ? ', ' + state.view.id + ' + shared' : '') + ') \\u00B7 '
        + (state.typesDetail === 'names' ? 'dependency lines' : 'relation lines anchor at their field \\u00B7 double-click an FK row to jump to its type');
      return;
    }
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
    state.typesRenderAll = false; // a fresh scope re-evaluates the LOD budget
    rebuild(true);
    renderPanel();
  }
  // Explain (and offer to override) a performance-degraded ERD.
  function renderTypesNotice() {
    var el = document.getElementById('typesWarn');
    if (!el) return;
    if (state.view.kind !== 'types' || !typesNotice) { el.style.display = 'none'; el.innerHTML = ''; return; }
    var cut = typesNotice.indexOf(':');
    var mode = typesNotice.slice(0, cut), count = typesNotice.slice(cut + 1);
    var msg = mode === 'cluster'
      ? '\\u26A0 ' + count + ' types \\u2014 showing a subsystem overview so it stays fast. Double-click a group to open its types.'
      : '\\u26A0 ' + count + ' types \\u2014 showing names only so it stays fast. Drill into a subsystem for fields, or';
    el.innerHTML = msg + '<button class="tbtn" id="typesAllBtn">Render full detail anyway</button>';
    el.style.display = 'block';
    var b = document.getElementById('typesAllBtn');
    if (b) b.addEventListener('click', function () { state.typesRenderAll = true; rebuild(true); });
  }

  // ---- interactions -----------------------------------------------------------
  function idOf(node) {
    var raw = node.id();
    if (raw.indexOf('p~') === 0) return { proxy: true, id: raw };
    if (raw.indexOf('x~') === 0) return { ghost: true, kind: node.data('extKind'), id: node.data('extId') };
    if (raw.indexOf('TC~') === 0) return { cluster: true, id: raw.slice(3) };
    if (raw.indexOf('TG~') === 0) return { group: true, id: raw };
    if (raw.indexOf('TH~') === 0) return { kind: 'type', id: raw.slice(3) };
    if (raw.indexOf('TM~') === 0) return { kind: 'type', id: raw.slice(3, raw.lastIndexOf('~')) };
    if (raw.indexOf('TF~') === 0) {
      var trest = raw.slice(3);
      var tcut = trest.lastIndexOf('~');
      return { kind: 'type', id: trest.slice(0, tcut), field: trest.slice(tcut + 1) };
    }
    if (raw.indexOf('T~') === 0) return { kind: 'type', id: raw.slice(2) };
    if (raw.indexOf('i~') === 0) {
      var rest = raw.slice(2);
      var sep = rest.indexOf('~');
      return { inner: true, kind: rest.slice(0, sep), id: rest.slice(sep + 1) };
    }
    return { kind: raw.charAt(0) === 's' ? 'subsystem' : 'component', id: raw.slice(2) };
  }

  // Port reveal: the selected (pinned) port and a hovered port each draw
  // their own cross-boundary lines in independent namespaces, so both can be
  // visible at the same time.
  // Reveal edge ids are canonical by ENDPOINTS (not by which port initiated),
  // so the two ports of one relation share a single line — hovering one end
  // of an already-pinned relation adds nothing instead of stacking a twin.
  function revealEdgesFor(node, cls) {
    var targets = node.data('rvTargets') || [];
    var dir = node.data('rvDir');
    var adds = [];
    targets.forEach(function (tid) {
      if (!cy.getElementById(tid).length) return;
      var src = dir === 'out' ? node.id() : tid;
      var tgt = dir === 'out' ? tid : node.id();
      var eid = 'rv~' + cls + '~' + src + '~' + tgt;
      if (cy.getElementById(eid).length) return;
      if (cls === 'revealHover' && cy.getElementById('rv~revealPin~' + src + '~' + tgt).length) return;
      adds.push({ group: 'edges', data: { id: eid, source: src, target: tgt }, classes: 'revealEdge ' + cls });
    });
    if (adds.length) cy.add(adds);
  }
  function showPinned() {
    cy.remove('.revealPin');
    if (!pinnedProxy) return;
    var pn = cy.getElementById(pinnedProxy);
    if (pn.length) revealEdgesFor(pn, 'revealPin');
  }
  function clearReveal() {
    cy.remove('.revealEdge');
  }
  cy.on('mouseover', 'node.proxyExt', function (ev) {
    cy.remove('.revealHover');
    if (ev.target.id() !== pinnedProxy) revealEdgesFor(ev.target, 'revealHover');
  });
  cy.on('mouseout', 'node.proxyExt', function () { cy.remove('.revealHover'); });

  cy.on('tap', 'node', function (ev) {
    var t = idOf(ev.target);
    if (t.group) return;
    if (t.cluster) { select(null, null, false); return; }
    if (t.proxy) {
      // Ports are real nodes: selecting one pins its cross-boundary line and
      // shows the external counterpart's details in the sidebar.
      cy.remove('.revealHover');
      if (pinnedProxy === t.id) { pinnedProxy = null; showPinned(); select(null, null, false); }
      else { pinnedProxy = t.id; showPinned(); select('external', t.id, false); }
      return;
    }
    if (pinnedProxy) { pinnedProxy = null; clearReveal(); }
    select(t.kind, t.id, false);
    // Tapping a field row also spotlights the relation line leaving it.
    if (t.kind === 'type' && t.field) {
      cy.edges().removeClass('fieldhl');
      cy.edges().filter(function (e) { return e.data('ffrom') === t.id && e.data('ffield') === t.field; }).addClass('fieldhl');
    }
  });
  cy.on('tap', function (ev) {
    if (ev.target === cy) {
      if (pinnedProxy) { pinnedProxy = null; clearReveal(); }
      select(null, null, false);
    }
  });
  cy.on('dbltap', 'node', function (ev) {
    var t = idOf(ev.target);
    if (t.proxy || t.group) return;
    if (t.cluster) { navigateTo('types', t.id); return; }
    if (t.kind === 'type') {
      // Double-clicking an FK field row jumps to the referenced type.
      if (t.field) {
        var fe = null;
        MODEL.typeEdges.forEach(function (e) { if (!fe && e.from === t.id && e.field === t.field) fe = e; });
        if (fe) select('type', fe.to, true);
      }
      return;
    }
    if (t.ghost) {
      state.view = parentViewOf(t.kind, t.id);
      rebuild(true);
      select(t.kind, t.id, true);
      return;
    }
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
  // Mode seg: Components ⇄ Types. Entering Types keeps the current subsystem
  // scope, so a subsystem's own types (plus shared ones) show scoped.
  function typesScopeFromView() {
    if (state.view.kind === 'subsystem') return state.view.id;
    if (state.view.kind === 'component') {
      var c = compById[state.view.id];
      return c ? c.subsystem : null;
    }
    if (state.view.kind === 'types') return state.view.id;
    return null;
  }
  (function () {
    var seg = document.getElementById('modeSeg');
    var btns = seg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener('click', function () {
          var vm = b.getAttribute('data-vm');
          if (vm === 'types' && state.view.kind !== 'types') navigateTo('types', typesScopeFromView());
          else if (vm === 'components' && state.view.kind === 'types') navigateTo(state.view.id ? 'subsystem' : 'system', state.view.id || null);
        });
      })(btns[i]);
    }
  })();
  (function () {
    var seg = document.getElementById('typesDetailSeg');
    var btns = seg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener('click', function () {
          state.typesDetail = b.getAttribute('data-td');
          persist();
          if (state.view.kind === 'types') rebuild(true);
          else updateHeaderSegs();
        });
      })(btns[i]);
    }
  })();
  function updateHeaderSegs() {
    var seg = document.getElementById('modeSeg');
    var btns = seg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var active = (btns[i].getAttribute('data-vm') === 'types') === (state.view.kind === 'types');
      if (btns[i].classList) btns[i].classList[active ? 'add' : 'remove']('active');
    }
    var td = document.getElementById('typesDetailSeg');
    td.style.display = state.view.kind === 'types' ? '' : 'none';
    var tbs = td.querySelectorAll('button');
    for (var j = 0; j < tbs.length; j++) {
      if (tbs[j].classList) tbs[j].classList[tbs[j].getAttribute('data-td') === state.typesDetail ? 'add' : 'remove']('active');
    }
  }
  document.getElementById('fitBtn').addEventListener('click', function () { cy.fit(undefined, 60); });
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
    setTimeout(function () { cy.resize(); cy.fit(undefined, 40); }, 60);
  }
  document.getElementById('presentBtn').addEventListener('click', function () { setPresentation(true); });
  document.getElementById('exitPresent').addEventListener('click', function () { setPresentation(false); });

  function wireDropdown(ddId, btnId) {
    var dd = document.getElementById(ddId);
    document.getElementById(btnId).addEventListener('click', function (ev) {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      if (dd.classList) dd.classList.toggle('open');
    });
    return dd;
  }
  var dd = wireDropdown('exportDd', 'exportBtn');
  var fdd = wireDropdown('flowExportDd', 'flowExportBtn');
  if (document.addEventListener) {
    document.addEventListener('click', function () {
      if (dd.classList) dd.classList.remove('open');
      if (fdd.classList) fdd.classList.remove('open');
    });
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
    var scope = state.view.kind === 'types' ? 'types'
      : state.view.id ? state.view.id.replace(/::/g, '-') : 'system';
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
  function downloadPng(cyInst, name) {
    if (!inBrowser) return;
    var uri = cyInst.png({ full: true, scale: 2, bg: THEMES[state.theme].png });
    var a = document.createElement('a');
    a.href = uri; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }
  // Types (ERD) view exports through the same builders via a synthetic model.
  function typesExportModel() {
    var list = typesInScope();
    var inScope = {};
    list.forEach(function (t) { inScope[t.id] = 1; });
    var comps = list.map(function (t) {
      return { id: t.id, name: t.name, subsystem: 'types', componentType: t.kind === 'entity' ? 'Entity' : 'ValueObject', public: false, owns: [] };
    });
    var seen = {};
    var edges = [];
    MODEL.typeEdges.forEach(function (e) {
      if (!inScope[e.from] || !inScope[e.to]) return;
      var k = e.from + '=>' + e.to;
      if (seen[k]) return;
      seen[k] = 1;
      edges.push({ from: e.from, to: e.to, cross: false });
    });
    return {
      system: { name: MODEL.system.name },
      generatedAt: MODEL.generatedAt,
      subsystems: [{ id: 'types', name: MODEL.system.name + ' — types' }],
      components: comps,
      edges: edges,
    };
  }
  function typesHarvestLayout() {
    var boxes = {};
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    cy.nodes().forEach(function (n) {
      if (n.id().indexOf('T~') !== 0) return;
      var bb = n.boundingBox({ includeLabels: false, includeOverlays: false });
      boxes[n.id().slice(2)] = { x: bb.x1, y: bb.y1, w: bb.w, h: bb.h };
      minX = Math.min(minX, bb.x1); minY = Math.min(minY, bb.y1);
      maxX = Math.max(maxX, bb.x2); maxY = Math.max(maxY, bb.y2);
    });
    return { boxes: boxes, subs: { types: { x: minX - 24, y: minY - 42, w: (maxX - minX) + 48, h: (maxY - minY) + 66, collapsed: false } } };
  }
  function currentExport() {
    if (state.view.kind === 'types') return { model: typesExportModel(), layout: typesHarvestLayout() };
    return { model: MODEL, layout: harvestLayout() };
  }
  document.getElementById('expPng').addEventListener('click', function () { downloadPng(cy, fileBase() + '.png'); });
  document.getElementById('expDrawio').addEventListener('click', function () {
    var ex = currentExport();
    downloadText(fileBase() + '.drawio', buildDrawioXml(ex.model, ex.layout), 'application/xml');
  });
  document.getElementById('expExcalidraw').addEventListener('click', function () {
    var ex = currentExport();
    downloadText(fileBase() + '.excalidraw', buildExcalidrawScene(ex.model, ex.layout), 'application/json');
  });

  // ---- narrative modal (Flow + Steps modes) --------------------------------------
  var flowCy = null;
  var flowStack = [];
  var flowMode = 'flow';
  var flowHideErr = false;
  function narrativeFor(compId, method) {
    var c = compById[compId];
    if (!c) return null;
    for (var i = 0; i < c.narratives.length; i++) {
      if (c.narratives[i].method === method) return c.narratives[i];
    }
    return null;
  }
  function flowTitle() {
    var top = flowStack[flowStack.length - 1];
    return top.comp + '.' + top.method;
  }
  function renderFlowCrumb() {
    document.getElementById('flowCrumb').innerHTML = flowStack.map(function (f, i) {
      var s = f.comp + '.' + f.method + '()';
      return i === flowStack.length - 1 ? s : '<span class="dimc">' + s + ' → </span>';
    }).join('');
    document.getElementById('flowBack').style.display = flowStack.length > 1 ? '' : 'none';
  }
  function drillFlow(comp, method) {
    flowStack.push({ comp: comp, method: method });
    renderFlowModal();
  }
  // Shared flow-graph derivation: one node per step plus semantic edges
  // (seq | true | false | case | default | enter | exit | back | error |
  // finally | jump). Both the modal renderer and the exports consume it.
  function buildFlowGraph(narrative) {
    var steps = (narrative ? narrative.steps.slice() : []).sort(function (a, b) { return a.n - b.n; });
    var byN = {}, nums = [];
    steps.forEach(function (s) { byN[s.n] = s; nums.push(s.n); });
    var idx = {};
    nums.forEach(function (n, i) { idx[n] = i; });
    function nextOf(n) { var i = idx[n]; return i !== undefined && i + 1 < nums.length ? nums[i + 1] : null; }

    // Region depth (loop/try bodies) → indentation; loop body ends flow back
    // to their header instead of falling through.
    var depth = {}, open = [], loopEnd = {};
    steps.forEach(function (s) {
      while (open.length && open[open.length - 1] < s.n) open.pop();
      depth[s.n] = open.length;
      if ((s.kind === 'loop' || s.kind === 'try') && s.end !== undefined) open.push(s.end);
      if (s.kind === 'loop' && s.end !== undefined) loopEnd[s.end] = s.n;
    });

    // Lanes: structured-flowchart X assignment. Loop/try bodies, branch
    // then-blocks, and switch case blocks shift into their own lane, so the
    // alternate path (false / default / loop-exit) continues straight down
    // an EMPTY main lane instead of cutting through the block's nodes.
    // Nested structures shift additively.
    var laneAdd = nums.map(function () { return 0; });
    function prevOf(n) { var i = idx[n]; return i !== undefined && i > 0 ? nums[i - 1] : null; }
    function shiftSpan(a, b, amt) {
      if (a === null || a === undefined || b === null || b === undefined) return;
      var i = idx[a], j = idx[b];
      if (i === undefined || j === undefined || j < i) return;
      for (var k = i; k <= j; k++) laneAdd[k] += amt;
    }
    steps.forEach(function (s) {
      if ((s.kind === 'loop' || s.kind === 'try') && s.end !== undefined) {
        shiftSpan(nextOf(s.n), s.end, 1);
      }
      if (s.kind === 'branch' && s.onFalse !== undefined && s.onFalse > s.n) {
        var thenStart = s.onTrue !== undefined ? s.onTrue : nextOf(s.n);
        if (thenStart !== null && thenStart > s.n && thenStart < s.onFalse) {
          shiftSpan(thenStart, prevOf(s.onFalse), 1);
        }
      }
      if (s.kind === 'switch') {
        var starts = (s.cases || []).map(function (cse) { return cse.step; })
          .filter(function (n2) { return n2 > s.n && byN[n2]; })
          .sort(function (a, b) { return a - b; });
        // Each case block gets its own lane (a staircase); a block ends
        // where the next case (or the default target) starts. The default
        // path stays in the main lane — the straight-down continuation.
        var bound = s.defaultStep !== undefined && s.defaultStep > s.n ? s.defaultStep : null;
        starts.forEach(function (cs, ci) {
          var endN = ci + 1 < starts.length ? prevOf(starts[ci + 1])
            : (bound !== null && bound > cs ? prevOf(bound) : null);
          if (endN !== null && endN >= cs) shiftSpan(cs, endN, ci + 1);
        });
      }
    });
    var lane = {};
    nums.forEach(function (n, i) { lane[n] = laneAdd[i]; });

    var edges = [];
    function E(a, b, kind, label) { if (b !== null && b !== undefined && byN[b]) edges.push({ from: a, to: b, kind: kind, label: label || '' }); }
    steps.forEach(function (s) {
      var n = s.n;
      switch (s.kind) {
        case 'branch':
          E(n, s.onTrue !== undefined ? s.onTrue : nextOf(n), 'true', 'true');
          E(n, s.onFalse, 'false', 'false');
          break;
        case 'switch':
          (s.cases || []).forEach(function (cse) { E(n, cse.step, 'case', cse.value); });
          E(n, s.defaultStep !== undefined ? s.defaultStep : nextOf(n), 'default', 'default');
          break;
        case 'loop':
          E(n, nextOf(n), 'enter', s.loopKind === 'doWhile' ? 'do' : '');
          if (s.end !== undefined) {
            E(s.end, n, 'back', s.loopKind === 'doWhile' ? 'while ' + (s.cond || '') : '\\u27F3');
            E(n, nextOf(s.end), 'exit', 'done');
          }
          break;
        case 'try':
          E(n, nextOf(n), 'seq');
          (s.catches || []).forEach(function (cc) { E(n, cc.step, 'error', cc.error); });
          if (s.fin !== undefined) E(n, s.fin, 'finally', 'finally');
          break;
        case 'jump':
          E(n, s.to, 'jump');
          break;
        case 'return':
        case 'throw':
          break;
        default:
          if (loopEnd[n] === undefined) E(n, nextOf(n), 'seq');
      }
    });
    return { steps: steps, edges: edges, depth: depth, lane: lane, first: nums.length ? nums[0] : null };
  }

  // "Hide error paths": drop everything only reachable through error edges —
  // catch regions, their throws — leaving the pure happy-path flow.
  function pruneErrorPaths(graph) {
    if (graph.first === null) return graph;
    var adj = {};
    graph.edges.forEach(function (e) {
      if (e.kind === 'error') return;
      (adj[e.from] = adj[e.from] || []).push(e.to);
    });
    var keep = {}, stack = [graph.first];
    while (stack.length) {
      var n = stack.pop();
      if (keep[n]) continue;
      keep[n] = 1;
      (adj[n] || []).forEach(function (m) { if (!keep[m]) stack.push(m); });
    }
    return {
      steps: graph.steps.filter(function (s) { return keep[s.n]; }),
      edges: graph.edges.filter(function (e) { return e.kind !== 'error' && keep[e.from] && keep[e.to]; }),
      depth: graph.depth,
      lane: graph.lane,
      first: graph.first,
    };
  }

  function flowStepLabel(s) {
    switch (s.kind) {
      case 'branch': return s.n + '. \\u25C7 ' + (s.cond || s.text);
      case 'switch': return s.n + '. \\u25C7 switch ' + (s.on || s.text);
      case 'loop': return s.n + '. \\u27F3 ' + (s.loopKind === 'doWhile' ? 'do' : (s.loopKind || 'forEach')) + (s.over ? ' ' + s.over : s.cond ? ' while ' + s.cond : '');
      case 'try': return s.n + '. \\u26E8 try \\u2014 ' + s.text;
      case 'jump': return s.n + '. \\u21B7 ' + s.text;
      case 'return': return s.n + '. \\u23CE return' + (s.outcome ? ' \\u2014 ' + s.outcome : '');
      case 'throw': return s.n + '. \\u26A1 throw' + (s.err ? ' ' + s.err : '');
      default: return s.n + '. ' + s.text;
    }
  }

  function renderFlowGraph() {
    var top = flowStack[flowStack.length - 1];
    var c = compById[top.comp];
    var narrative = narrativeFor(top.comp, top.method);
    var t = THEMES[state.theme];

    var graph = buildFlowGraph(narrative);
    if (flowHideErr) graph = pruneErrorPaths(graph);

    var eles = [];
    eles.push({ data: { id: 'start', label: (c ? c.name : top.comp) + '.' + top.method + '()', w: 280, h: 44, tw: 260 }, position: { x: 0, y: 0 }, classes: 'flowstart' });
    graph.steps.forEach(function (s, i) {
      var id = 'n' + s.n;
      var isCall = s.kind === 'call' && !!s.call;
      var callable = isCall && !!narrativeFor(s.call.component, s.call.method);
      var isCond = s.kind === 'branch' || s.kind === 'switch' || s.kind === 'loop';
      var label = flowStepLabel(s) + (isCall ? '\\n\\u2192 ' + s.call.component + '.' + s.call.method + '()' + (callable ? '  \\u21B4' : '') : '');
      var cls = s.kind === 'branch' || s.kind === 'switch' ? 'flowcond'
        : s.kind === 'loop' ? 'flowloop'
        : s.kind === 'try' ? 'flowtry'
        : s.kind === 'return' ? 'flowend'
        : s.kind === 'throw' ? 'flowthrow'
        : s.kind === 'jump' ? 'flowjumpn'
        : isCall ? 'flowcall' : 'flowlocal';
      eles.push({
        data: {
          id: id, label: label,
          w: isCond ? 320 : 300, h: isCall ? 58 : isCond ? 64 : 46, tw: isCond ? 210 : 280,
          callComp: isCall ? s.call.component : '', callMethod: isCall ? s.call.method : '',
        },
        // Rows keep code order (Y); lanes give branches/cases their own
        // column (X), wide enough that side-by-side nodes never overlap.
        position: { x: (graph.lane[s.n] || 0) * 344, y: (i + 1) * 92 },
        classes: cls + (callable ? ' drill' : ''),
      });
    });
    if (graph.first !== null) eles.push({ data: { id: 'fe-start', source: 'start', target: 'n' + graph.first, lbl: '' } });
    graph.edges.forEach(function (e, i) {
      var cls = e.kind === 'error' ? 'fErr'
        : e.kind === 'back' ? 'fBack'
        : e.kind === 'false' ? 'fAlt'
        : e.kind === 'jump' || e.kind === 'finally' ? 'fJump'
        : e.kind === 'case' || e.kind === 'default' ? 'fAlt'
        : e.kind === 'exit' ? 'fAlt' : '';
      eles.push({ data: { id: 'fe' + i, source: 'n' + e.from, target: 'n' + e.to, lbl: e.label }, classes: cls });
    });

    var style = [
      { selector: 'node', style: { shape: 'round-rectangle', width: 'data(w)', height: 'data(h)', label: 'data(label)', 'text-wrap': 'wrap', 'text-max-width': 'data(tw)', 'font-size': 11, 'font-family': 'Inter, system-ui, sans-serif', color: t.ink, 'text-valign': 'center', 'border-width': 1.5 } },
      { selector: '.flowstart', style: { 'background-color': t.stereo.entry.fill, 'border-color': t.stereo.entry.stroke, color: t.stereo.entry.text, 'font-weight': 'bold' } },
      { selector: '.flowlocal', style: { 'background-color': t.innerFill, 'border-color': t.innerStroke, color: t.innerText } },
      { selector: '.flowcall', style: { 'background-color': t.stereo.logic.fill, 'border-color': t.stereo.logic.stroke, color: t.stereo.logic.text } },
      { selector: '.flowcond', style: { shape: 'round-diamond', 'background-color': t.stereo.data.fill, 'border-color': t.stereo.data.stroke, color: t.stereo.data.text } },
      { selector: '.flowloop', style: { shape: 'round-diamond', 'background-color': t.stereo.adapter.fill, 'border-color': t.stereo.adapter.stroke, color: t.stereo.adapter.text } },
      { selector: '.flowtry', style: { 'background-color': t.innerFill, 'border-color': t.issue, 'border-style': 'dashed', color: t.innerText } },
      { selector: '.flowend', style: { shape: 'round-rectangle', 'background-color': t.stereo.entry.fill, 'border-color': t.stereo.entry.stroke, color: t.stereo.entry.text, 'border-width': 2.5 } },
      { selector: '.flowthrow', style: { shape: 'round-rectangle', 'background-color': t.ghostFill, 'border-color': t.issue, color: t.issue, 'border-width': 2.5 } },
      { selector: '.flowjumpn', style: { 'background-color': t.ghostFill, 'border-color': t.ghostStroke, 'border-style': 'dotted', color: t.ghostText } },
      { selector: '.drill', style: { 'border-width': 2.5 } },
      { selector: 'edge', style: { 'curve-style': 'bezier', width: 1.6, 'line-color': t.pageEdge, 'target-arrow-shape': 'triangle', 'target-arrow-color': t.pageEdge, label: 'data(lbl)', 'font-size': 9.5, color: t.edgeText, 'text-background-color': t.bgLabel, 'text-background-opacity': 0.85, 'text-rotation': 'autorotate' } },
      // Long edges (false/case/exit, jumps, error paths) route orthogonally:
      // down the source's lane, one horizontal turn just above the target
      // row (where the corridor between rows is guaranteed free), then into
      // the target — instead of a straight line cutting through the nodes
      // stacked in between.
      { selector: 'edge.fAlt', style: { 'line-style': 'dashed', 'curve-style': 'taxi', 'taxi-direction': 'downward', 'taxi-turn': -34, 'taxi-turn-min-distance': 10 } },
      { selector: 'edge.fBack', style: { 'line-style': 'dashed', 'curve-style': 'unbundled-bezier', 'control-point-distances': [-70], 'control-point-weights': [0.5] } },
      { selector: 'edge.fErr', style: { 'line-style': 'dashed', 'curve-style': 'taxi', 'taxi-direction': 'downward', 'taxi-turn': -34, 'taxi-turn-min-distance': 10, 'line-color': t.issue, 'target-arrow-color': t.issue, color: t.issue } },
      { selector: 'edge.fJump', style: { 'line-style': 'dotted', 'curve-style': 'taxi', 'taxi-direction': 'downward', 'taxi-turn': -34, 'taxi-turn-min-distance': 10 } },
    ];

    if (!flowCy) {
      flowCy = cytoscape({ container: document.getElementById('flowCy'), elements: eles, style: style, layout: { name: 'preset' }, boxSelectionEnabled: false, autounselectify: true });
      // Flowcharts are fixed documentation — never rearrangeable.
      flowCy.autolock(true);
      // Drill on DOUBLE-click only — single taps in a dense flowchart are
      // too easy to land accidentally.
      flowCy.on('dbltap', 'node.drill', function (ev) {
        var d = ev.target.data();
        drillFlow(d.callComp, d.callMethod);
      });
    } else {
      flowCy.batch(function () { flowCy.elements().remove(); flowCy.add(eles); });
      flowCy.style(style);
    }
    flowCy.fit(undefined, 30);
  }
  function flowStepText(s) {
    switch (s.kind) {
      case 'branch': return '\\u25C7 if ' + (s.cond || s.text) + (s.onFalse !== undefined ? ' \\u2014 else \\u2192 ' + s.onFalse : '');
      case 'switch': return '\\u25C7 switch on ' + (s.on || s.text) + ' \\u2014 ' + (s.cases || []).map(function (c) { return c.value + ' \\u2192 ' + c.step; }).join(', ') + (s.defaultStep !== undefined ? ', default \\u2192 ' + s.defaultStep : '');
      case 'loop': return '\\u27F3 ' + (s.loopKind || 'forEach') + (s.over ? ' ' + s.over : '') + (s.cond ? ' while ' + s.cond : '') + (s.end !== undefined ? ' (body \\u2192 ' + s.end + ')' : '');
      case 'try': return '\\u26E8 try (body \\u2192 ' + s.end + ')' + (s.catches || []).map(function (c) { return ' \\u2014 on ' + c.error + ' \\u2192 ' + c.step; }).join('') + (s.fin !== undefined ? ' \\u2014 finally \\u2192 ' + s.fin : '');
      case 'jump': return '\\u21B7 \\u2192 step ' + s.to + (s.text ? ' \\u2014 ' + s.text : '');
      case 'return': return '\\u23CE return' + (s.outcome ? ' \\u2014 ' + s.outcome : '') + (s.text ? ' (' + s.text + ')' : '');
      case 'throw': return '\\u26A1 throw' + (s.err ? ' ' + s.err : '') + (s.text ? ' \\u2014 ' + s.text : '');
      default: return s.text;
    }
  }
  function renderFlowSteps() {
    var top = flowStack[flowStack.length - 1];
    var narrative = narrativeFor(top.comp, top.method);
    var el = document.getElementById('flowSteps');
    var html = (narrative ? narrative.steps : []).map(function (s) {
      var callHtml = '';
      if (s.call) {
        var callable = !!narrativeFor(s.call.component, s.call.method);
        callHtml = ' \\u2192 <span class="call' + (callable ? ' drillstep' : '') + '" data-dc="' + s.call.component + '" data-dm="' + s.call.method + '">'
          + s.call.component + '.' + s.call.method + '()' + (callable ? ' \\u21B4' : '') + '</span>';
      }
      return '<div class="fstep"><span class="num">' + s.n + '.</span> ' + escText(flowStepText(s)) + callHtml + '</div>';
    }).join('') || '<div class="fstep">No narrative steps.</div>';
    el.innerHTML = html;
    var drills = el.querySelectorAll('.drillstep');
    for (var i = 0; i < drills.length; i++) {
      (function (d) {
        d.addEventListener('dblclick', function () { drillFlow(d.getAttribute('data-dc'), d.getAttribute('data-dm')); });
      })(drills[i]);
    }
  }
  function escText(s) { var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
  function renderFlowModal() {
    renderFlowCrumb();
    renderFlowGraph();
    renderFlowSteps();
    var modal = document.getElementById('flowModal');
    if (modal.classList) modal.classList[flowMode === 'steps' ? 'add' : 'remove']('steps');
  }
  function openFlow(compId, method, mode) {
    flowStack = [{ comp: compId, method: method }];
    flowMode = mode || 'flow';
    var seg = document.getElementById('flowModeSeg');
    var btns = seg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].classList) btns[i].classList[btns[i].getAttribute('data-fm') === flowMode ? 'add' : 'remove']('active');
    }
    var modal = document.getElementById('flowModal');
    if (modal.classList) modal.classList.add('open');
    renderFlowModal();
    setTimeout(function () { if (flowCy) { flowCy.resize(); flowCy.fit(undefined, 30); } }, 60);
  }
  function closeFlow() {
    var modal = document.getElementById('flowModal');
    if (modal.classList) { modal.classList.remove('open'); modal.classList.remove('steps'); }
  }
  document.getElementById('flowClose').addEventListener('click', closeFlow);
  document.getElementById('flowBack').addEventListener('click', function () { if (flowStack.length > 1) { flowStack.pop(); renderFlowModal(); } });
  document.getElementById('flowErrToggle').addEventListener('click', function () {
    flowHideErr = !flowHideErr;
    var b = document.getElementById('flowErrToggle');
    b.textContent = flowHideErr ? 'Show error paths' : 'Hide error paths';
    if (!flowStack.length) return;
    renderFlowGraph();
    if (flowCy) flowCy.fit(undefined, 30);
  });
  (function () {
    var seg = document.getElementById('flowModeSeg');
    var btns = seg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener('click', function () {
          flowMode = b.getAttribute('data-fm');
          for (var j = 0; j < btns.length; j++) {
            if (btns[j].classList) btns[j].classList[btns[j] === b ? 'add' : 'remove']('active');
          }
          renderFlowModal();
          setTimeout(function () { if (flowCy && flowMode === 'flow') { flowCy.resize(); flowCy.fit(undefined, 30); } }, 60);
        });
      })(btns[i]);
    }
  })();

  // Flow exports: build a small synthetic model so the same draw.io/Excalidraw
  // builders produce editable flowcharts (using the flow's current positions).
  function flowExportModel() {
    var top = flowStack[flowStack.length - 1];
    var narrative = narrativeFor(top.comp, top.method) || { steps: [] };
    var graph = buildFlowGraph(narrative);
    if (flowHideErr) graph = pruneErrorPaths(graph);
    var comps = [], edges = [];
    comps.push({ id: 'start', name: flowTitle() + '()', subsystem: 'flow', componentType: 'Start', public: false, owns: [] });
    graph.steps.forEach(function (s) {
      var name = flowStepLabel(s) + (s.call ? ' \\u2192 ' + s.call.component + '.' + s.call.method + '()' : '');
      comps.push({ id: 'n' + s.n, name: name, subsystem: 'flow', componentType: s.kind === 'call' ? 'Call' : 'Step', public: false, owns: [] });
    });
    if (graph.first !== null) edges.push({ from: 'start', to: 'n' + graph.first, cross: false });
    graph.edges.forEach(function (e) {
      edges.push({ from: 'n' + e.from, to: 'n' + e.to, cross: e.kind === 'error' });
    });
    return {
      system: { name: MODEL.system.name },
      generatedAt: MODEL.generatedAt,
      subsystems: [{ id: 'flow', name: flowTitle() + '()' }],
      components: comps,
      edges: edges,
    };
  }
  function flowHarvestLayout() {
    var boxes = {};
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    flowCy.nodes().forEach(function (n) {
      var bb = n.boundingBox({ includeLabels: false, includeOverlays: false });
      boxes[n.id()] = { x: bb.x1, y: bb.y1, w: bb.w, h: bb.h };
      minX = Math.min(minX, bb.x1); minY = Math.min(minY, bb.y1);
      maxX = Math.max(maxX, bb.x2); maxY = Math.max(maxY, bb.y2);
    });
    var subs = { flow: { x: minX - 24, y: minY - 42, w: (maxX - minX) + 48, h: (maxY - minY) + 66, collapsed: false } };
    return { boxes: boxes, subs: subs };
  }
  function flowFileBase() { return flowTitle().replace(/[^a-zA-Z0-9_.-]/g, '-') + '-flow'; }
  document.getElementById('flowExpPng').addEventListener('click', function () { if (flowCy) downloadPng(flowCy, flowFileBase() + '.png'); });
  document.getElementById('flowExpDrawio').addEventListener('click', function () {
    if (flowCy) downloadText(flowFileBase() + '.drawio', buildDrawioXml(flowExportModel(), flowHarvestLayout()), 'application/xml');
  });
  document.getElementById('flowExpExcalidraw').addEventListener('click', function () {
    if (flowCy) downloadText(flowFileBase() + '.excalidraw', buildExcalidrawScene(flowExportModel(), flowHarvestLayout()), 'application/json');
  });

  // ---- detail sidebar -------------------------------------------------------------
  var panel = document.getElementById('panel');
  function esc(s) { var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
  function chip(label, kind, target) {
    return '<span class="chip" data-kind="' + kind + '" data-id="' + esc(target) + '">' + esc(label) + '</span>';
  }
  function staticChip(label) { return '<span class="chip">' + esc(label) + '</span>'; }
  // Resolve a signature type reference (possibly wrapped: Foo[], Array<Foo>)
  // to a defined type id, for click-through from method cards into the ERD.
  function typeIdFor(ref) {
    if (!ref) return null;
    var r = String(ref).toLowerCase();
    for (var i = 0; i < MODEL.types.length; i++) {
      var t2 = MODEL.types[i];
      if (r === t2.id.toLowerCase() || r === t2.name.toLowerCase()) return t2.id;
    }
    for (var j = 0; j < MODEL.types.length; j++) {
      var t3 = MODEL.types[j];
      if (t3.name.length > 2 && r.indexOf(t3.name.toLowerCase()) >= 0) return t3.id;
    }
    return null;
  }
  function typeRefHtml(ref) {
    var tid = typeIdFor(ref);
    return tid ? chip(ref, 'type', tid) : esc(ref);
  }
  function section(title, count, inner, open) {
    return '<details' + (open ? ' open' : '') + '><summary>' + esc(title)
      + (count !== null ? '<span class="count">' + count + '</span>' : '') + '</summary><div class="inner">' + inner + '</div></details>';
  }
  function issueHtml(list) {
    return list.map(function (i) {
      return '<div class="issue ' + esc(i.severity) + '"><code>' + esc(i.code) + '</code><br>' + esc(i.message) + '</div>';
    }).join('');
  }

  // Focus mode: lift the selected element's own edges above everything and let
  // the rest recede, so its relations read clearly in a busy graph.
  function clearFocus() { cy.elements().removeClass('defocus edgeFocus'); }
  function applyFocus(node) {
    clearFocus();
    if (!node || !node.length) return;
    var core = node;
    if (node.isParent && node.isParent()) core = core.union(node.descendants());
    var edges = core.connectedEdges().not('.inneredge');
    if (!edges.length) return; // isolated node — nothing to spotlight
    var keep = core.union(edges).union(edges.connectedNodes());
    keep = keep.union(keep.ancestors());
    cy.elements().addClass('defocus');
    keep.removeClass('defocus');
    edges.addClass('edgeFocus').removeClass('defocus');
  }

  function select(kind, id, focus) {
    // Selecting a type from a component view (param chip, "Used by" chip…)
    // switches into the ERD first, keeping the current subsystem scope.
    if (kind === 'type' && state.view.kind !== 'types') {
      state.view = { kind: 'types', id: typesScopeFromView() };
      rebuild(true);
    }
    state.selectedKind = kind;
    state.selected = id;
    cy.nodes().removeClass('sel');
    cy.edges().removeClass('fieldhl');
    if (id) {
      var node = nodeForRef(kind, id);
      if (node.length) {
        node.addClass('sel');
        applyFocus(node);
        if (focus) cy.animate({ center: { eles: node }, duration: 250 });
      } else { clearFocus(); }
    } else { clearFocus(); }
    renderPanel();
  }

  function openViewButton(kind, id, hasKids) {
    if (!hasKids) return '';
    return '<div class="openbtn"><button class="tbtn" data-open-kind="' + kind + '" data-open-id="' + esc(id) + '">\\u25B8 Open as view</button></div>';
  }

  function renderPanel() {
    var head = '', body = '';
    // With nothing selected, describe the CURRENT VIEW SCOPE rather than the
    // root system — so drilling into a subsystem/component shows that scope's
    // details, and the breadcrumb still walks back up to the parent.
    var focusKind = state.selectedKind, focusId = state.selected, scopeFocus = false;
    if (!focusKind) {
      scopeFocus = true;
      if (state.view.kind === 'subsystem') { focusKind = 'subsystem'; focusId = state.view.id; }
      else if (state.view.kind === 'component') { focusKind = 'component'; focusId = state.view.id; }
      else if (state.view.kind === 'types' && state.view.id) { focusKind = 'subsystem'; focusId = state.view.id; }
    }
    if (focusKind === 'component' && compById[focusId]) {
      var c = compById[focusId];
      head = '<h2>' + esc(c.name) + '</h2>'
        + staticChip('\\u00AB' + c.componentType + (c.portalType ? '/' + c.portalType : '') + '\\u00BB')
        + (c.public ? staticChip('published') : '')
        + (c.status ? staticChip(c.status) : '')
        + (scopeFocus ? staticChip('current view') : '')
        + chip(c.subsystem, 'subsystem', c.subsystem)
        + (scopeFocus ? '' : openViewButton('component', c.id, c.owns.length > 0));
      body += '<p class="desc">' + esc(c.description) + '</p>';

      var depInner = (c.dependsOn.length ? c.dependsOn.map(function (d) { return chip(d, 'component', d); }).join('') : '<span class="desc">none</span>')
        + (c.owns.length ? '<div style="margin-top:8px"><b style="font-size:11px">Owns:</b><br>' + c.owns.map(function (d) { return chip(d, 'component', d); }).join('') + '</div>' : '');
      body += section('Dependencies', c.dependsOn.length + c.owns.length, depInner, true);

      // Methods: contracts + narratives unified — each method card links to its
      // narrative (flowchart or numbered steps) instead of dumping steps inline.
      var methodCount = 0;
      var intfInner = c.interfaces.map(function (intf) {
        methodCount += intf.methods.length;
        return '<div style="margin:6px 0 2px"><b>' + esc(intf.name) + '</b> <code style="font-size:10.5px;display:inline">' + esc(intf.id) + '</code></div>'
          + intf.methods.map(function (m) {
            var hasNarr = !!narrativeFor(c.id, m.name);
            var mIntent = null;
            (c.intents || []).forEach(function (x) { if (x.method === m.name) mIntent = x.text; });
            return '<div class="method"><div class="mname">' + esc(m.name) + '<span class="grow"></span>'
              + (hasNarr
                ? '<button class="flowbtn" data-flow-comp="' + esc(c.id) + '" data-flow-method="' + esc(m.name) + '" data-flow-mode="flow">flow \\u25F7</button>'
                  + '<button class="flowbtn" data-flow-comp="' + esc(c.id) + '" data-flow-method="' + esc(m.name) + '" data-flow-mode="steps">steps</button>'
                : mIntent
                  ? '<span class="chip">intent</span>'
                  : '<span class="chip" style="opacity:.6">no narrative</span>')
              + '</div>'
              + '<code>' + esc(m.signature) + '</code>'
              + '<div class="mdesc">' + esc(m.description) + ' \\u2014 returns ' + typeRefHtml(m.returns) + '</div>'
              + (mIntent && !hasNarr ? '<div class="mdesc" style="font-style:italic">' + esc(mIntent) + '</div>' : '')
              + (m.params ? '<div class="mdesc">params: ' + m.params.map(function (p) { return esc(p.name) + ': ' + typeRefHtml(p.type); }).join(', ') + '</div>' : '')
              + (m.endpoint ? '<code>' + esc(JSON.stringify(m.endpoint)) + '</code>' : '')
              + (m.guarantees ? '<div style="margin-top:4px">' + m.guarantees.map(staticChip).join('') + '</div>' : '')
              + '</div>';
          }).join('');
      }).join('');
      // narratives without a matching contract method (edge case) still reachable
      var orphanNarrs = c.narratives.filter(function (n) {
        return !c.interfaces.some(function (intf) { return intf.methods.some(function (m) { return m.name === n.method; }); });
      });
      if (orphanNarrs.length) {
        intfInner += orphanNarrs.map(function (n) {
          return '<div class="method"><div class="mname">' + esc(n.method) + '() <span class="grow"></span>'
            + '<button class="flowbtn" data-flow-comp="' + esc(c.id) + '" data-flow-method="' + esc(n.method) + '" data-flow-mode="flow">flow \\u25F7</button>'
            + '<button class="flowbtn" data-flow-comp="' + esc(c.id) + '" data-flow-method="' + esc(n.method) + '" data-flow-mode="steps">steps</button>'
            + '</div><div class="mdesc">narrative without a contract method</div></div>';
        }).join('');
      }
      if (c.interfaces.length || orphanNarrs.length) body += section('Methods', methodCount + orphanNarrs.length, intfInner, true);

      var iss = issuesBySpec[c.id];
      if (iss) body += section('Validation issues', iss.length, issueHtml(iss), true);
    } else if (focusKind === 'external') {
      var pn2 = cy.getElementById(state.selected);
      var pd = pn2.length ? pn2.data() : null;
      if (pd) {
        var xt = compById[pd.extId];
        head = '<h2>' + esc(xt ? xt.name : pd.extId) + '</h2>'
          + staticChip(pd.dir === 'in' ? '\\u21E0 external caller' : 'external dependency \\u21E2')
          + (xt ? staticChip('\\u00AB' + xt.componentType + (xt.portalType ? '/' + xt.portalType : '') + '\\u00BB') : '')
          + (xt ? chip(xt.subsystem, 'subsystem', xt.subsystem) : '');
        body += '<p class="desc">' + (pd.dir === 'in'
          ? 'Lives outside this box and depends on something inside it. The dashed line shows the actual cross-boundary link while this port is selected.'
          : 'A dependency of this box\\u2019s internals that lives outside it. The dashed line shows the actual cross-boundary link while this port is selected.') + '</p>';
        if (xt) {
          body += section('External component', null,
            chip(xt.id, 'component', xt.id) + '<div class="mdesc">' + esc(xt.description) + '</div>', true);
        }
        var via = pd.viaKids || [];
        if (via.length) {
          body += section(pd.dir === 'in' ? 'Enters through' : 'Used by (inside this box)', via.length,
            via.map(function (v) { return chip(v.label, v.kind, v.id); }).join(''), true);
        }
      }
    } else if (focusKind === 'type') {
      var ty = null;
      MODEL.types.forEach(function (t2) { if (t2.id === focusId) ty = t2; });
      if (ty) {
        head = '<h2>' + esc(ty.name) + '</h2>' + staticChip('\\u00AB' + ty.kind + '\\u00BB')
          + (ty.subsystem ? chip(ty.subsystem, 'subsystem', ty.subsystem) : staticChip('system-level shared'));
        var fieldsInner = ty.fields.length
          ? ty.fields.map(function (f) {
              var fk = null;
              MODEL.typeEdges.forEach(function (e2) { if (!fk && e2.from === ty.id && e2.field === f.name) fk = e2; });
              return '<div class="method"><div class="mname">' + esc(f.name)
                + (f.key === 'primary' ? ' <span class="chip">PK</span>' : f.key === 'unique' ? ' <span class="chip">unique</span>' : '')
                + (f.optional ? ' <span class="chip" style="opacity:.7">optional</span>' : '')
                + '</div><code>' + esc(f.type) + '</code>'
                + (fk ? '<div class="mdesc">FK \\u2192 ' + chip(fk.to + ' [' + (fk.card || '1') + ']', 'type', fk.to) + '</div>' : '')
                + '</div>';
            }).join('')
          : '<span class="desc">no fields</span>';
        body += section('Fields', ty.fields.length, fieldsInner, true);
        if (ty.usedBy && ty.usedBy.length) {
          body += section('Used by methods', ty.usedBy.length, ty.usedBy.map(function (u) {
            return chip(u.component + '.' + u.method + '()', 'component', u.component);
          }).join(''), true);
        }
        if (ty.methods.length) {
          body += section('Methods (pure intrinsic)', ty.methods.length, ty.methods.map(function (m2) {
            return '<div class="method"><div class="mname">' + esc(m2.name) + '</div><code>' + esc(m2.signature) + '</code><div class="mdesc">' + esc(m2.description || '') + ' \\u2014 returns <code style="display:inline">' + esc(m2.returns) + '</code></div></div>';
          }).join(''), true);
        }
        var refsOut = MODEL.typeEdges.filter(function (e2) { return e2.from === ty.id; });
        var refsIn = MODEL.typeEdges.filter(function (e2) { return e2.to === ty.id; });
        if (refsOut.length || refsIn.length) {
          var refInner = (refsOut.length ? '<div class="mdesc"><b>References:</b></div>' + refsOut.map(function (e2) { return chip(e2.to + ' \\u00B7 ' + e2.field + ' [' + (e2.card || '1') + ']', 'type', e2.to); }).join('') : '')
            + (refsIn.length ? '<div class="mdesc" style="margin-top:6px"><b>Referenced by:</b></div>' + refsIn.map(function (e2) { return chip(e2.from + ' \\u00B7 ' + e2.field + ' [' + (e2.card || '1') + ']', 'type', e2.from); }).join('') : '');
          body += section('Relations', refsOut.length + refsIn.length, refInner, true);
        }
        var issT = issuesBySpec[ty.id];
        if (issT) body += section('Validation issues', issT.length, issueHtml(issT), true);
      }
    } else if (focusKind === 'subsystem' && subById[focusId]) {
      var s = subById[focusId];
      var subKids = childSubsOf(s.id).length + childCompsOf(s.id).length;
      head = '<h2>' + esc(s.name) + '</h2>' + staticChip('subsystem')
        + (s.targetLanguage ? staticChip(s.targetLanguage) : '')
        + (s.status ? staticChip(s.status) : '')
        + (scopeFocus ? staticChip('current view') : '')
        + (scopeFocus ? '' : openViewButton('subsystem', s.id, subKids > 0));
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
        + staticChip(MODEL.components.length + ' components')
        + (MODEL.types.length ? '<div class="openbtn"><button class="tbtn" id="openTypesBtn">\\u25B8 Types (ERD) \\u2014 ' + MODEL.types.length + '</button></div>' : '');
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
          var node = nodeForRef(n.getAttribute('data-kind'), n.getAttribute('data-id'));
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
    var typesOpen = document.getElementById('openTypesBtn');
    if (typesOpen && typesOpen.addEventListener && panel.innerHTML.indexOf('openTypesBtn') >= 0) {
      typesOpen.addEventListener('click', function () { navigateTo('types', null); });
    }
    var flows = panel.querySelectorAll('[data-flow-comp]');
    for (var j = 0; j < flows.length; j++) {
      (function (b) {
        b.addEventListener('click', function (ev) {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          openFlow(b.getAttribute('data-flow-comp'), b.getAttribute('data-flow-method'), b.getAttribute('data-flow-mode') || 'flow');
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
