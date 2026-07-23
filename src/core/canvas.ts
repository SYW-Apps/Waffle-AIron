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
// SCOPE NOTE (deliberate, revisit in the canvas-engine epic): the model
// projects structure + contracts + flow. Newer component-level semantics —
// durability, emits/subscribesTo event topology, ext maps, method effect
// tags, type invariants, narrative step labels — are NOT projected yet;
// omitting a field here means "not visualized", never "not persisted".
//
// ---------------------------------------------------------------------------

export interface CanvasModel {
  system: {
    name: string;
    vision?: string;
    targetLanguage?: string;
    databases?: { id: string; name: string; engine: string; description?: string; tables?: string[] }[];
    diagram?: { lineStyle?: 'bezier' | 'straight' | 'taxi'; defaultView?: 'architecture' | 'types' | 'databases'; showDatabases?: boolean };
  };
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
    /** The L0 gateway entry id this component backs (the OpenAPI operation tag),
     *  present only for a component published in the system's public surface. */
    apiTag?: string;
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
        /** parallel: arm entry steps (contiguous ordered sub-regions of the body). */
        branches?: { step: number; name?: string }[];
        /** call/dispatch: fire-and-forget — failure does not propagate to this flow. */
        detach?: boolean;
        outcome?: string;
        err?: string;
      }[];
    }[];
    /** Opaque external references surfaced on the canvas element (see ExternalLinkSchema).
     *  wairon never fetches them; an `implementation` link is the external source-of-record. */
    externalLinks?: { url: string; type: string; label?: string }[];
    /** Methods specified as intent prose instead of a narrative (the detail dial). */
    intents: { method: string; text: string }[];
  }[];
  edges: { from: string; to: string; cross: boolean }[];
  types: {
    id: string;
    name: string;
    kind: string;
    subsystem?: string;
    fields: { name: string; type: string; optional?: boolean; key?: string; references?: string }[];
    methods: { name: string; signature: string; returns: string; description?: string }[];
    /** Interface methods whose params/returns reference this type (usage trace). */
    usedBy: { component: string; method: string }[];
    componentClass?: string;
    database?: string;
    table?: string;
    linkedEntity?: string;
  }[];
  /** Type → type references derived from field type strings (ERD edges). */
  typeEdges: { from: string; to: string; field: string; card: '1' | '0..1' | '*' }[];
  /** Data-coupling edges: a component depends on another subsystem's data
   *  (uses a type it owns), pointed at that subsystem's published portal. */
  dataEdges: { from: string; to: string }[];
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
  // The combined project OpenAPI tags each operation with its L0 gateway entry id.
  // Map the backing component → that tag so a portal's "View OpenAPI" can deep-link
  // straight to its section of the combined spec.
  const apiTagOf = new Map<string, string>();
  for (const pi of system?.publicInterfaces ?? []) {
    if (pi.component && pi.id) apiTagOf.set(pi.component, pi.id);
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
            ...(s.type === 'dispatch' && s.targetComponent && s.capability
              ? { call: { component: s.targetComponent, method: `⟨${s.capability}⟩` } }
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
            ...(s.branches && s.branches.length
              ? { branches: s.branches.map(b => ({ step: b.step, ...(b.name ? { name: b.name } : {}) })) }
              : {}),
            ...(s.detach ? { detach: true } : {}),
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
      ...(apiTagOf.has(comp.id) ? { apiTag: apiTagOf.get(comp.id) } : {}),
      ...(ownerOf.has(comp.id) ? { owner: ownerOf.get(comp.id) } : {}),
      owns: comp.owns.filter(o => componentIds.has(o)),
      dependsOn: comp.dependsOn,
      ...(comp.externalLinks && comp.externalLinks.length ? { externalLinks: comp.externalLinks } : {}),
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
    fields: t.fields.map(f => ({
      name: f.name,
      type: f.type,
      ...(f.optional ? { optional: true } : {}),
      ...(f.key ? { key: f.key } : {}),
      ...(f.references ? { references: f.references } : {}),
    })),
    methods: t.methods.map(m => ({ name: m.name, signature: m.signature, returns: m.returns, ...(m.description ? { description: m.description } : {}) })),
    usedBy: usedByFor(t),
    ...(t.componentClass ? { componentClass: t.componentClass } : {}),
    ...(t.database ? { database: t.database } : {}),
    ...(t.table ? { table: t.table } : {}),
    ...(t.linkedEntity ? { linkedEntity: t.linkedEntity } : {}),
  }));
  // Cardinality is derivable from the field's type string: collection shapes
  // mean "many", the optional flag means 0..1 — real ERD multiplicity for free.
  const MANY_SHAPE = /\[\s*\]|Array<|Vec<|Set<|List<|Map<|Record<|HashMap</i;
  const typeEdges: CanvasModel['typeEdges'] = [];
  for (const t of typeSpecs) {
    for (const field of t.fields) {
      const refs = new Set<string>(extractTypeIdentifiers(field.type));
      if (field.references) {
        const refStr = field.references;
        refs.add(refStr);
        if (refStr.includes('.')) {
          const parts = refStr.split('.');
          parts.pop(); // remove field/column name if present
          refs.add(parts.join('.'));
        }
      }

      for (const ref of refs) {
        const target = typeSpecs.find(other => {
          const qualified = other.subsystem && !other.id.startsWith(`${other.subsystem}::`)
            ? `${other.subsystem}::${other.id}`
            : other.id;
          return matchTypeRef(ref, qualified);
        });
        if (target && target.id !== t.id) {
          const card = MANY_SHAPE.test(field.type) ? '*' : field.optional ? '0..1' : '1';
          if (!typeEdges.some(e => e.from === t.id && e.to === target.id && e.field === field.name)) {
            typeEdges.push({ from: t.id, to: target.id, field: field.name, card });
          }
        }
      }
    }
  }

  // Data-coupling edges: a component that USES a type owned by another subsystem
  // depends on that subsystem's data — represented as a dependency on the owner
  // subsystem's published portal (its front door). Shared (system-level) types
  // have no owner, so imply no directional coupling. Rendered only under the toggle.
  const portalOf = new Map<string, string>();
  for (const sub of subsystems) {
    for (const pi of sub.publicInterfaces) {
      if (pi.component && !portalOf.has(sub.id)) portalOf.set(sub.id, pi.component);
    }
  }
  const dataEdges: { from: string; to: string }[] = [];
  const dataSeen = new Set<string>();
  const addData = (from: string, ownerSub?: string): void => {
    if (!from || !ownerSub) return;
    const fromSub = componentSub.get(from);
    if (!fromSub || fromSub === ownerSub) return; // same subsystem — not coupling
    const target = portalOf.get(ownerSub);
    if (!target || target === from) return;
    const key = `${from}=>${target}`;
    if (dataSeen.has(key)) return;
    dataSeen.add(key);
    dataEdges.push({ from, to: target });
  };
  const typeSubOf = new Map<string, string | undefined>(typeSpecs.map(t => [t.id, t.subsystem]));
  for (const mt of modelTypes) {
    if (!mt.subsystem) continue;
    for (const u of mt.usedBy) addData(u.component, mt.subsystem);
  }
  for (const te of typeEdges) {
    const fromSub = typeSubOf.get(te.from), toSub = typeSubOf.get(te.to);
    if (fromSub && toSub && fromSub !== toSub) {
      const src = portalOf.get(fromSub);
      if (src) addData(src, toSub);
    }
  }

  return {
    system: {
      name: system?.name ?? 'System',
      ...(system?.vision ? { vision: system.vision } : {}),
      ...(system?.targetLanguage ? { targetLanguage: system.targetLanguage } : {}),
      ...(system?.databases ? { databases: system.databases } : {}),
      ...(system?.diagram ? { diagram: system.diagram } : {}),
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
    dataEdges,
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
body { margin:0; position:relative; background:var(--bg); color:var(--ink); font:13px/1.45 "Inter", system-ui, "Segoe UI", sans-serif; overflow:hidden; }
body[data-theme="syw"] { background-image: var(--syw-deep-space); background-attachment: fixed; }

/* Floating header: the toolbar hovers over a FULL-BLEED canvas (blueprint-
   designer style) instead of reserving a solid top bar. It anchors to the body
   (position:relative there) and yields to the details panel when that is open. */
header { display:flex; align-items:center; gap:10px; padding:0 14px; height:52px; background:var(--chrome); border:1px solid var(--chrome-border); border-radius:12px; box-shadow:var(--syw-deep-shadow); position:absolute; top:10px; left:12px; right:12px; z-index:20; overflow-x:auto; scrollbar-width:thin; }
body:not(.panel-closed) header { right:calc(var(--panel-width, 380px) + 19px); }
/* Responsive overflow: on a narrow header the toolbar buttons must stay
   REACHABLE (scroll) rather than wrapping off the right edge. Groups keep their
   own shape; nothing shrinks below its content width. */
header > * { flex:0 0 auto; }
header .toolbar, header .tabs, header .grp { display:flex; align-items:center; gap:6px; flex:0 0 auto; }
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
/* Fixed (viewport-anchored) + JS-positioned on open, so the menu overlays the
   whole page and is NEVER clipped by the header's overflow-x:auto (or, in the
   embedded canvas, the app's scroll container) — which would otherwise trap it
   inside the canvas and force a scrollbar. Position is set in wireDropdown. */
.dropdown .menu { display:none; position:fixed; max-height:calc(100vh - 80px); overflow-y:auto; background:var(--chrome); border:1px solid var(--chrome-border); border-radius:10px; box-shadow:var(--syw-deep-shadow); min-width:200px; padding:6px; z-index:120; }
/* Child combinator, deliberately: a dropdown moved INTO the "⋯" overflow menu
   must not auto-open when the More dropdown opens (a descendant selector would
   match every nested menu under .dropdown.open). */
.dropdown.open > .menu { display:block; }
.dropdown .menu button { display:block; width:100%; text-align:left; border:none; background:transparent; color:var(--ink); padding:8px 10px; border-radius:7px; cursor:pointer; font:inherit; font-size:12.5px; }
.dropdown .menu button:hover { background:var(--hover-bg); }
.dropdown .menu .hint { display:block; color:var(--dim); font-size:10.5px; }
/* Header controls collapsed into the "⋯" overflow menu: whole items (buttons
   or nested dropdowns) stack vertically; a nested dropdown's own menu still
   opens fixed-positioned over the page. */
#moreMenu .dropdown { display:block; width:100%; }
#moreMenu .dropdown > .tbtn, #moreMenu > .tbtn { display:block; width:100%; text-align:left; border:none; background:transparent; margin:2px 0; }
#moreMenu .dropdown > .tbtn:hover, #moreMenu > .tbtn:hover { background:var(--hover-bg); }

/* Settings panel — toggle switches */
.settings-menu { min-width:266px; }
.swrow { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:7px 9px; border-radius:8px; cursor:pointer; user-select:none; }
.swrow:hover { background:var(--hover-bg); }
.swrow .lbl { font-size:12.5px; color:var(--ink); line-height:1.3; }
.swrow .lbl .sub { display:block; color:var(--dim); font-size:10.5px; font-weight:400; }
.selectWrap { position:relative; width:100%; }
.selectWrap::after { content:'\\25BE'; position:absolute; right:10px; top:50%; transform:translateY(-50%); color:var(--dim); pointer-events:none; font-size:10px; }
.selectControl { width:100%; appearance:none; -webkit-appearance:none; background:var(--input-bg); color:var(--ink); border:1px solid var(--chrome-border); border-radius:7px; padding:6px 30px 6px 9px; font-size:11.5px; font-family:inherit; outline:none; color-scheme:dark; }
.selectControl:hover { border-color:var(--accent); background:var(--hover-bg); }
.selectControl:focus { border-color:var(--accent); box-shadow:0 0 0 2px color-mix(in srgb, var(--accent) 28%, transparent); }
.selectControl option { background:var(--chrome); color:var(--ink); }
body[data-theme="light"] .selectControl { color-scheme:light; }
.toggle { position:relative; display:inline-block; width:36px; height:20px; flex:0 0 auto; }
.toggle input { position:absolute; opacity:0; width:0; height:0; margin:0; }
.toggle .track { position:absolute; inset:0; background:var(--input-bg); border:1px solid var(--chrome-border); border-radius:20px; transition:background .15s, border-color .15s; }
.toggle .track::after { content:''; position:absolute; top:2px; left:2px; width:14px; height:14px; background:var(--dim); border-radius:50%; transition:transform .15s, background .15s; }
.toggle input:checked + .track { background:var(--accent); border-color:var(--accent); }
.toggle input:checked + .track::after { transform:translateX(16px); background:#fff; }

#wrap { display:flex; height:100vh; }
#stage { flex:1; min-width:0; position:relative; }
#cy { position:absolute; inset:0; }
.legend { position:absolute; left:12px; bottom:12px; background:var(--chrome); border:1px solid var(--chrome-border); border-radius:10px; padding:8px 12px; font-size:11px; color:var(--dim); z-index:5; pointer-events:none; }
.legend .sw { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:4px; vertical-align:-1px; border:1.5px solid; }
/* Stage overlays clear the floating header (52px + 10px top + 10px gap). The
   header hides in presentation mode, where they return to the top edge. */
.viewhint { position:absolute; top:72px; left:12px; color:var(--dim); font-size:11px; background:var(--chrome); border:1px solid var(--chrome-border); border-radius:9px; padding:5px 10px; z-index:5; pointer-events:none; }
body.presentation .viewhint { top:10px; }
#typesWarn { position:absolute; top:72px; left:50%; transform:translateX(-50%); color:var(--ink); font-size:12px; background:var(--chrome); border:1px solid var(--warn); border-radius:9px; padding:6px 12px; z-index:6; max-width:72vw; box-shadow:var(--syw-deep-shadow); display:none; }
#typesWarn button { margin-left:8px; }

#panelResizer { flex:0 0 7px; cursor:col-resize; background:var(--chrome); border-left:1px solid var(--chrome-border); border-right:1px solid var(--line); z-index:11; position:relative; }
#panelResizer::after { content:''; position:absolute; top:50%; left:50%; width:2px; height:48px; transform:translate(-50%, -50%); border-radius:2px; background:var(--dim); opacity:.45; }
#panelResizer:hover::after, body.resizing-panel #panelResizer::after { background:var(--accent); opacity:1; }
#panel { width:var(--panel-width, 380px); flex:0 0 var(--panel-width, 380px); border-left:1px solid var(--chrome-border); background:var(--chrome); overflow-y:auto; z-index:10; }
body.panel-closed #panel, body.panel-closed #panelResizer { display:none; }
body.resizing-panel { cursor:col-resize; user-select:none; }
body.resizing-panel #cy { pointer-events:none; }
body:not(.panel-closed) #panelToggle { background:var(--accent); color:#fff; border-color:var(--accent); font-weight:700; }
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

/* Presentation mode = the canvas page, focused: the header chrome and legend
   are hidden, but the details panel stays TOGGLE-ABLE (the current settings are
   still applied). It does NOT force browser fullscreen (F11) — exiting is one
   step, not two. */
body.presentation header, body.presentation .legend { display:none; }
/* Embed mode (?_embed=true): the canvas is rendered inside the wairon web app's
   own chrome, so its redundant brand mark is hidden — the interactive toolbar
   (views, search, settings) stays. Keeps the iframe from showing a second logo. */
body.embed header .brand { display:none; }
/* Embedded in the web UI: the app owns the brand + theme, so hide the canvas's
   own brand mark and Theme toggle (the host drives the canvas theme). */
body.embed #themeBtn { display:none; }
/* The details panel hides by default in presentation, but the floating details
   toggle brings it back without leaving presentation mode. */
body.presentation #panel, body.presentation #panelResizer { display:none; }
body.presentation.show-details #panel { display:block; }
body.presentation.show-details #panelResizer { display:block; }
body.presentation #wrap { height:100vh; }
#exitPresent, #presentDetails { display:none; position:fixed; top:10px; z-index:100; border:1px solid var(--chrome-border); background:var(--chrome); color:var(--ink); border-radius:9px; padding:7px 13px; cursor:pointer; opacity:0.06; transition:opacity .15s ease; font:inherit; }
#exitPresent { right:10px; }
#presentDetails { right:190px; }
#exitPresent:hover, #presentDetails:hover { opacity:1; box-shadow:var(--syw-glow); }
body.presentation #exitPresent, body.presentation #presentDetails { display:block; }

@media (max-width: 860px) {
  #wrap { position:relative; }
  #panel { position:absolute; top:0; right:0; bottom:0; width:min(var(--panel-width, 360px), calc(100vw - 44px)); flex-basis:auto; box-shadow:var(--syw-deep-shadow); }
  #panelResizer { position:absolute; top:0; bottom:0; right:min(var(--panel-width, 360px), calc(100vw - 44px)); width:7px; flex-basis:auto; box-shadow:-3px 0 10px rgba(0,0,0,.18); }
  /* The panel overlays the stage here, so the floating header keeps full width. */
  body:not(.panel-closed) header { right:12px; }
}

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
#flowSteps .fstep .call { color:var(--dim); }
#flowSteps .fstep .call.drillstep { color:var(--accent); cursor:pointer; text-decoration:underline; }
#flowSteps .fstep .call.drillstep:hover { opacity:.82; }
#flowModal .hintbar { padding:6px 14px; color:var(--dim); font-size:11px; border-top:1px solid var(--line); }
</style>
</head>
<body data-theme="syw">
<header id="hdr">
  <span class="brand syw-gradient-text">wairon</span>
  <div class="seg" id="modeSeg" title="Switch between the component architecture, the type ERD, or the database schemas">
    <button data-vm="components" class="active">Components</button>
    <button data-vm="types">Types</button>
    <button data-vm="databases">Databases</button>
  </div>
  <nav id="crumbs"></nav>
  <span class="divider"></span>
  <input id="search" type="search" placeholder="Search this view…">
  <div class="seg" id="typesDetailSeg" style="display:none" title="ERD detail level">
    <button data-td="full">Full</button>
    <button data-td="fields">Fields</button>
    <button data-td="keys">Keys</button>
    <button data-td="names">Names</button>
  </div>
  <span class="spacer"></span>
  <div class="dropdown" id="settingsDd">
    <button class="tbtn" id="settingsBtn" title="View options">⚙ View ▾</button>
    <div class="menu settings-menu" id="settingsMenu">
      <label class="swrow">
        <span class="lbl">Internals<span class="sub">preview each box's children + relations</span></span>
        <span class="toggle"><input type="checkbox" id="internalsToggle"><span class="track"></span></span>
      </label>
      <label class="swrow">
        <span class="lbl">Externals<span class="sub">out-of-scope dependencies as ghosts</span></span>
        <span class="toggle"><input type="checkbox" id="externalsToggle" checked><span class="track"></span></span>
      </label>
      <label class="swrow">
        <span class="lbl">Data coupling<span class="sub">who uses another subsystem's types (dashed)</span></span>
        <span class="toggle"><input type="checkbox" id="dataCouplingToggle"><span class="track"></span></span>
      </label>
      <label class="swrow">
        <span class="lbl">Issues (<span id="issueCount"></span>)<span class="sub">overlay validation findings</span></span>
        <span class="toggle"><input type="checkbox" id="issuesToggle"><span class="track"></span></span>
      </label>
      <label class="swrow">
        <span class="lbl">Rearrange<span class="sub">drag boxes to fine-tune the layout</span></span>
        <span class="toggle"><input type="checkbox" id="dragToggle"><span class="track"></span></span>
      </label>
      <div class="swrow" style="flex-direction:column;align-items:flex-start;gap:6px;padding:8px 12px 10px;border-top:1px solid var(--line);">
        <span class="lbl" style="padding:0">Line Style<span class="sub" style="margin-top:2px">Choose how relationship lines are routed</span></span>
        <span class="selectWrap">
        <select id="lineStyleSelect" class="selectControl">
          <option value="bezier">Curved Bezier</option>
          <option value="straight">Straight Lines</option>
          <option value="taxi">Orthogonal Corners</option>
        </select>
        </span>
      </div>
    </div>
  </div>
  <button class="tbtn" id="fitBtn" title="Fit graph to view">Fit</button>
  <button class="tbtn" id="resetBtn" title="Discard this view's saved rearrangement">Reset layout</button>
  <button class="tbtn" id="panelToggle" title="Show or hide the details sidebar">Details</button>
  <div class="dropdown" id="layoutDd">
    <button class="tbtn" id="layoutBtn" title="Choose the auto-layout algorithm">Layout: Layered ▾</button>
    <div class="menu">
      <button id="layoutLayered">Layered <span class="hint">dependency columns (default)</span></button>
      <button id="layoutForce">Force <span class="hint">physics relaxation — untangles crossings</span></button>
      <button id="layoutConcentric">Concentric <span class="hint">most-referenced in the centre, rings outward</span></button>
      <button id="layoutGrid">Grid <span class="hint">compact wrapped rows</span></button>
    </div>
  </div>
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
  <div class="dropdown" id="moreDd" style="display:none">
    <button class="tbtn" id="moreBtn" title="More options">⋯</button>
    <div class="menu" id="moreMenu"></div>
  </div>
</header>
<div id="wrap">
  <div id="stage">
    <div id="cy"></div>
    <div class="viewhint" id="viewHint"></div>
    <div id="typesWarn"></div>
    <div class="legend" id="legend"></div>
  </div>
  <div id="panelResizer" title="Drag to resize details sidebar"></div>
  <div id="panel"></div>
</div>
<button id="presentDetails">Details</button>
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

  // Embed mode: when the canvas is iframed inside the wairon web app
  // (?_embed=true), hide its own brand mark so the app's chrome isn't doubled.
  if (inBrowser && document.body && new URLSearchParams(window.location.search).get('_embed') === 'true') {
    document.body.classList.add('embed');
  }

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

  var diagramConfig = MODEL.system.diagram || {};
  var showDatabaseTab = diagramConfig.showDatabases !== false;
  var configuredLineStyle = ['bezier', 'straight', 'taxi'].indexOf(diagramConfig.lineStyle) >= 0 ? diagramConfig.lineStyle : 'bezier';
  var defaultViewKind = diagramConfig.defaultView === 'types' ? 'types' : (diagramConfig.defaultView === 'databases' && showDatabaseTab ? 'databases' : 'system');

  // Stage J: a deep link (opts.initialRoute) seeds the initial view directly so a
  // refresh / shared URL renders the right scope with NO root-first flash. Parsed
  // by the same resolver as openRoute (hoisted below). No onViewChange fires for
  // this initial seed.
  var initialView = { kind: defaultViewKind, id: null };
  if (typeof opts !== 'undefined' && opts && typeof opts.initialRoute === 'string' && opts.initialRoute.length) {
    initialView = resolveRoute(opts.initialRoute);
  }

  var state = {
    view: initialView,
    internals: typeof saved.internals === 'boolean' ? saved.internals : false,
    externals: typeof saved.externals === 'boolean' ? saved.externals : true,
    dataCoupling: typeof saved.dataCoupling === 'boolean' ? saved.dataCoupling : false,
    showIssues: typeof saved.showIssues === 'boolean' ? saved.showIssues : false,
    query: '',
    selected: null,
    selectedKind: null,
    theme: (typeof opts !== 'undefined' && opts && opts.theme) ? (opts.theme === 'light' ? 'light' : 'syw') : (saved.theme === 'light' ? 'light' : 'syw'),
    typesDetail: ['full', 'fields', 'keys', 'names'].indexOf(saved.typesDetail) >= 0 ? saved.typesDetail : 'full',
    typesRenderAll: false,
    layout: ['layered', 'force', 'concentric', 'grid'].indexOf(saved.layout) >= 0 ? saved.layout : 'layered',
    lineStyle: ['bezier', 'straight', 'taxi'].indexOf(saved.lineStyle) >= 0 ? saved.lineStyle : configuredLineStyle,
    panelOpen: typeof saved.panelOpen === 'boolean' ? saved.panelOpen : !(inBrowser && window.innerWidth < 900),
    panelWidth: typeof saved.panelWidth === 'number' ? saved.panelWidth : 380,
  };
  // Set by buildTypeElements when the ERD is degraded for performance (huge
  // scopes); consumed by renderTypesNotice to explain the level-of-detail.
  var typesNotice = '';
  // Stage J: true while openRoute is applying a URL-driven view change, so the
  // onViewChange callback is suppressed and we do not loop URL -> engine -> URL.
  var applyingRoute = false;

  function viewKey() {
    // 'types2' + detail level: table sizes differ per detail, and the prefix
    // bump invalidates layouts saved for the old compact type boxes. The layout
    // strategy is part of the key so a manual rearrange is remembered per layout.
    if (state.view.kind === 'types' || state.view.kind === 'databases') return 'types2:' + (state.view.id || 'root') + ':' + state.typesDetail + ':' + state.layout;
    return state.view.kind + ':' + (state.view.id || 'root') + (state.internals ? '+i' : '') + ':' + state.layout;
  }
  function persist() {
    if (!store) return;
    try {
      store.setItem(STORE_KEY, JSON.stringify({
        positionsByView: saved.positionsByView || {},
        theme: state.theme,
        typesDetail: state.typesDetail,
        layout: state.layout,
        lineStyle: state.lineStyle,
        panelOpen: state.panelOpen,
        panelWidth: state.panelWidth,
        internals: state.internals,
        externals: state.externals,
        dataCoupling: state.dataCoupling,
        showIssues: state.showIssues,
      }));
    } catch (e) { /* non-fatal */ }
  }

  // ---- details panel sizing -------------------------------------------------
  var PANEL_MIN = 260;
  var PANEL_MAX = 620;
  var panelToggle = document.getElementById('panelToggle');
  var panelResizer = document.getElementById('panelResizer');

  function panelMaxWidth() {
    if (!inBrowser) return PANEL_MAX;
    var room = window.innerWidth <= 860 ? window.innerWidth - 44 : window.innerWidth - 320;
    return Math.max(PANEL_MIN, Math.min(PANEL_MAX, room));
  }
  function clampPanelWidth(width) {
    return Math.max(PANEL_MIN, Math.min(panelMaxWidth(), Math.round(width || 380)));
  }
  function resizeCanvasSoon() {
    setTimeout(function () {
      if (typeof cy !== 'undefined' && cy && cy.resize) cy.resize();
    }, 60);
  }
  function applyPanelState(skipPersist) {
    state.panelWidth = clampPanelWidth(state.panelWidth);
    if (document.documentElement && document.documentElement.style) {
      document.documentElement.style.setProperty('--panel-width', state.panelWidth + 'px');
    }
    if (document.body.classList) document.body.classList[state.panelOpen ? 'remove' : 'add']('panel-closed');
    if (panelToggle) {
      if (panelToggle.setAttribute) panelToggle.setAttribute('aria-expanded', state.panelOpen ? 'true' : 'false');
      panelToggle.title = state.panelOpen ? 'Hide the details sidebar' : 'Show the details sidebar';
    }
    if (!skipPersist) persist();
    resizeCanvasSoon();
  }
  applyPanelState(true);
  if (panelToggle && panelToggle.addEventListener) {
    panelToggle.addEventListener('click', function () {
      state.panelOpen = !state.panelOpen;
      applyPanelState(false);
    });
  }
  if (panelResizer && panelResizer.addEventListener) {
    panelResizer.addEventListener('mousedown', function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      state.panelOpen = true;
      applyPanelState(false);
      if (document.body.classList) document.body.classList.add('resizing-panel');
      function move(mev) {
        var next = inBrowser ? window.innerWidth - mev.clientX : state.panelWidth;
        state.panelWidth = clampPanelWidth(next);
        if (document.documentElement && document.documentElement.style) {
          document.documentElement.style.setProperty('--panel-width', state.panelWidth + 'px');
        }
        resizeCanvasSoon();
      }
      function done() {
        if (document.body.classList) document.body.classList.remove('resizing-panel');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', done);
        persist();
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', done);
    });
  }
  if (inBrowser && window.addEventListener) {
    window.addEventListener('resize', function () { applyPanelState(false); });
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
    var routingStyle = state.lineStyle === 'taxi'
      ? { 'curve-style': 'taxi', 'taxi-direction': 'horizontal', 'taxi-turn': 54, 'taxi-turn-min-distance': 34 }
      : state.lineStyle === 'straight'
        ? { 'curve-style': 'straight' }
        : { 'curve-style': 'unbundled-bezier', 'control-point-distances': [78], 'control-point-weights': [0.48] };
    var routedStyle = state.lineStyle === 'bezier'
      ? { 'control-point-distances': 'data(cpDist)', 'control-point-weights': 'data(cpWeight)' }
      : state.lineStyle === 'taxi'
        ? { 'taxi-turn': 'data(taxiTurn)' }
        : {};
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
      { selector: 'edge', style: Object.assign({}, routingStyle, {
        width: 1.8, 'line-color': t.pageEdge,
        'target-arrow-shape': 'triangle', 'target-arrow-color': t.pageEdge, 'arrow-scale': 0.9,
        label: 'data(lbl)', 'font-size': 10, color: t.edgeText,
        'text-background-color': t.bgLabel, 'text-background-opacity': 0.85, 'text-rotation': 'autorotate',
      })},
      { selector: 'edge.routed', style: routedStyle },
      { selector: 'edge.cross', style: { 'line-color': t.cross, 'target-arrow-color': t.cross, width: 2.6 } },
      { selector: 'edge.datacoupling', style: {
        'line-color': t.typeV.stroke, 'target-arrow-color': t.typeV.stroke, 'line-style': 'dashed',
        width: 1.8, 'arrow-scale': 0.85, label: 'data(lbl)', 'font-size': 9, color: t.typeV.stroke,
        'text-background-color': t.bgLabel, 'text-background-opacity': 0.85, 'text-rotation': 'autorotate',
      }},
      { selector: 'edge.bundle', style: { width: 4.5, opacity: 0.7 } },
      { selector: 'edge.toghost', style: { 'line-style': 'dashed', opacity: 0.75 } },
      { selector: 'edge.inneredge', style: { width: 1.1, 'arrow-scale': 0.6, opacity: 0.8 } },
      { selector: 'edge.stubHover', style: { 'line-color': t.selGlow, 'target-arrow-color': t.selGlow, width: 2.6, opacity: 1, 'z-compound-depth': 'top' } },
      { selector: '.dimmed', style: { opacity: 0.13 } },
      { selector: '.hasIssue', style: { 'border-color': t.issue, 'border-style': 'dashed', 'border-width': 3 } },
      // Overlay only (no border) — a border changes node geometry, which nudges
      // the compound parent and makes hover flicker; overlay never affects layout.
      { selector: '.sel', style: { 'overlay-color': t.selGlow, 'overlay-opacity': 0.34, 'overlay-padding': 6 } },
      { selector: '.hoverhl', style: { 'overlay-color': t.selGlow, 'overlay-opacity': 0.2, 'overlay-padding': 6 } },
      // Focus mode: on selection, the picked element's edges are lifted above
      // every box and recoloured, while unrelated elements recede — so a single
      // block's relations read clearly even in a dense graph.
      { selector: '.defocus', style: { opacity: 0.08 } },
      { selector: 'edge.edgeFocus', style: {
        'line-color': t.selGlow, 'target-arrow-color': t.selGlow, 'source-arrow-color': t.selGlow,
        width: 3.6, opacity: 1, 'z-compound-depth': 'top', 'z-index': 9999,
        'text-background-opacity': 1,
      }},
      // Directional focus: outgoing (this element depends on →) vs incoming
      // (← something depends on this element) get distinct colours.
      { selector: 'edge.edgeOut', style: {
        'line-color': t.selGlow, 'target-arrow-color': t.selGlow, 'source-arrow-color': t.selGlow,
        width: 3.6, opacity: 1, 'z-compound-depth': 'top', 'z-index': 9999, 'text-background-opacity': 1,
      }},
      { selector: 'edge.edgeIn', style: {
        'line-color': t.warn, 'target-arrow-color': t.warn, 'source-arrow-color': t.warn,
        width: 3.6, opacity: 1, 'z-compound-depth': 'top', 'z-index': 9998, 'text-background-opacity': 1,
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
      '<span style="color:' + t.cross + '">red</span> = boundary hop · double-click = open<br>' +
      'on select: <span style="color:' + t.selGlow + '">\\u2192 depends on</span>&nbsp; <span style="color:' + t.warn + '">\\u2190 used by</span>' +
      (state.dataCoupling ? '&nbsp; · &nbsp;<span style="color:' + t.typeV.stroke + '">- - \\u25B8 uses models</span>' : '');
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
    // Inner tile placement mirrors the diagram's chosen layout (ports still flank
    // the box on the left/right). Layered keeps the dependency columns; Grid and
    // Concentric re-place the children; Force approximates with Concentric (a
    // physics sim can't run inside a build-time sub-layout).
    var leftPad = PADI + (hasIn ? PROXY_W + INNER_GAPX : 0);
    var tiles = [], x, maxH;
    var kidKey = function (k) { return IN(k.kind, k.id); };
    if (state.layout === 'grid' || state.layout === 'concentric' || state.layout === 'force') {
      var ids = kids.map(kidKey), byKey = {};
      kids.forEach(function (k) { byKey[kidKey(k)] = k; });
      var rel;
      if (state.layout === 'grid') {
        rel = {};
        var per = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
        ids.slice().sort().forEach(function (id, idx) { rel[id] = { x: (idx % per) * (INNER_W + INNER_GAPX), y: Math.floor(idx / per) * (INNER_H + INNER_GAPY) }; });
      } else {
        var ideg = {};
        ids.forEach(function (id) { ideg[id] = 0; });
        Object.keys(edges).forEach(function (ek) { var e = edges[ek]; if (ideg[e.src] !== undefined) ideg[e.src]++; if (ideg[e.tgt] !== undefined) ideg[e.tgt]++; });
        rel = concentricPositions(ids, function (id) { return ideg[id] || 0; }, function () { return { w: INNER_W, h: INNER_H }; });
      }
      var minX = Infinity, minY = Infinity;
      ids.forEach(function (id) { var p = rel[id] || { x: 0, y: 0 }; if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; });
      if (minX === Infinity) { minX = 0; minY = 0; }
      tiles = ids.map(function (id) { var p = rel[id] || { x: 0, y: 0 }; return { kid: byKey[id], x: leftPad + (p.x - minX) + INNER_W / 2, y: HEAD_H + (p.y - minY) + INNER_H / 2 }; });
      var maxRight = leftPad + INNER_W, maxBottom = HEAD_H + INNER_H;
      tiles.forEach(function (t) { maxRight = Math.max(maxRight, t.x + INNER_W / 2); maxBottom = Math.max(maxBottom, t.y + INNER_H / 2); });
      x = maxRight + INNER_GAPX;
      maxH = maxBottom + INNER_GAPY;
    } else {
      x = leftPad; maxH = 0;
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
    }
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

  function viewEdges(scope, entries, edgeList) {
    edgeList = edgeList || MODEL.edges;
    var entryByAnchor = {};
    entries.forEach(function (e) { entryByAnchor[e.kind + ':' + e.id] = e; });
    var agg = {}, ghosts = {};
    edgeList.forEach(function (edge) {
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
  // Types visible in the current ERD scope: the focused subsystem's own (and
  // nested) types, plus only the system-level SHARED types those own types
  // actually reference — NOT the entire shared library. (Including all shared
  // types flooded a small subsystem's scope so it re-clustered and its single
  // own type was unreachable.) Unscoped = all.
  var SHARED_KEY = '\\u2014 shared \\u2014';
  function databaseAllowsType(t) {
    if (!t.database) return false;
    if (!MODEL.system.databases || !MODEL.system.databases.length) return true;
    var db = MODEL.system.databases.find(function (d) { return d.id === t.database; });
    if (!db || !db.tables || !db.tables.length) return true;
    return db.tables.indexOf(t.id) >= 0 || db.tables.indexOf(t.table || t.id) >= 0;
  }
  function typesInScope() {
    var sid = state.view.id;
    if (state.view.kind === 'databases') {
      return MODEL.types.filter(function (t) {
        if (!databaseAllowsType(t)) return false;
        if (sid) {
          return t.database === sid || t.subsystem === sid || (t.subsystem && t.subsystem.indexOf(sid + '::') === 0);
        }
        return true;
      });
    }
    if (!sid) return MODEL.types;
    // The shared-library cluster scopes to the system-level (unowned) types.
    if (sid === SHARED_KEY) return MODEL.types.filter(function (t) { return !t.subsystem; });
    var own = {};
    MODEL.types.forEach(function (t) {
      if (t.subsystem === sid || (t.subsystem && t.subsystem.indexOf(sid + '::') === 0)) own[t.id] = 1;
    });
    var sharedRef = {};
    MODEL.typeEdges.forEach(function (e) {
      if (own[e.from] && !own[e.to]) sharedRef[e.to] = 1;
      if (own[e.to] && !own[e.from]) sharedRef[e.from] = 1;
    });
    return MODEL.types.filter(function (t) {
      return own[t.id] || (!t.subsystem && sharedRef[t.id]);
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

  // Size-aware concentric placement shared by the component view and the ERD.
  // Rank by degree (references); the most-connected sit toward the centre. A
  // ring's radius is derived from the ACTUAL node sizes it must hold (so it is
  // only as spacious as needed, and dense rings grow), and a tied innermost tier
  // becomes a proper ring rather than a pile at the centre — only a lone top
  // node truly sits at (0,0). Returns { id: {x, y} } (centres).
  function concentricPositions(ids, degFn, sizeFn, aspectX, rankFn) {
    aspectX = aspectX || 1; // >1 widens the rings into landscape ellipses
    if (!ids.length) return {};
    var sorted = ids.slice().sort(function (a, b) { return (degFn(b) - degFn(a)) || (a < b ? -1 : 1); });
    var rings = [], idx = 0;
    if (sorted.length === 1 || degFn(sorted[0]) > degFn(sorted[1])) { rings.push([sorted[0]]); idx = 1; }
    var rn = rings.length;
    while (idx < sorted.length) {
      var cap = Math.max(6, rn * 8);
      rings.push(sorted.slice(idx, idx + cap));
      idx += cap; rn++;
    }
    var pos = {}, prevRadius = 0, prevMaxDim = 0;
    var RING_GAP = 80, ARC_GAP = 70;
    rings.forEach(function (members, ri) {
      var maxDim = 0, maxW = 0;
      members.forEach(function (id) { var s = sizeFn(id); if (Math.max(s.w, s.h) > maxDim) maxDim = Math.max(s.w, s.h); if (s.w > maxW) maxW = s.w; });
      var n = members.length;
      var radius;
      if (ri === 0 && n === 1) {
        radius = 0;
      } else {
        // Chord constraint: adjacent nodes on the ring must clear each other's
        // width, so the radius is derived from the actual node width — not an
        // arc-length estimate (which under-sizes small rings and overlaps).
        var chordR = n >= 2 ? (maxW + ARC_GAP) / (2 * Math.sin(Math.PI / n)) : 0;
        radius = Math.max(chordR, prevRadius + prevMaxDim / 2 + maxDim / 2 + RING_GAP);
      }
      if (radius === 0) {
        members.forEach(function (id) { pos[id] = { x: 0, y: 0 }; });
      } else if (rankFn) {
        // Flow order: sort the ring by rank (entrypoints first) and lay it out
        // from TOP to BOTTOM on both sides — so entrypoints sit at the top and
        // leaves at the bottom, at the same density (no new overlap).
        var ordered = members.slice().sort(function (a, b) { return (rankFn(a) - rankFn(b)) || (a < b ? -1 : 1); });
        var mL = Math.ceil(n / 2), mR = n - mL;
        ordered.forEach(function (id, i) {
          var ang = (i % 2 === 0)
            ? -Math.PI / 2 - ((i / 2) + 0.5) / mL * Math.PI          // left column, top → bottom
            : -Math.PI / 2 + (((i - 1) / 2) + 0.5) / Math.max(1, mR) * Math.PI; // right column
          pos[id] = { x: Math.cos(ang) * radius * aspectX, y: Math.sin(ang) * radius };
        });
      } else {
        members.forEach(function (id, i) {
          var ang = n === 1 ? -Math.PI / 2 : (i / n) * 2 * Math.PI - Math.PI / 2;
          pos[id] = { x: Math.cos(ang) * radius * aspectX, y: Math.sin(ang) * radius };
        });
      }
      prevRadius = radius; prevMaxDim = maxDim;
    });
    return pos;
  }

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

    // Table geometry, independent of placement — so a layout strategy can size
    // tables before choosing anchors.
    function tableShape(t) {
      var fields = visibleFields(t);
      var meths = det === 'full' ? t.methods : [];
      var head = t.name + '  \\u00AB' + t.kind + '\\u00BB';
      var rows = fields.map(function (f) { return rowText(t, f); })
        .concat(meths.map(function (m) { return '\\u0192 ' + m.name + '(): ' + m.returns; }));
      var longest = head.length + 4;
      rows.forEach(function (r) { if (r.length > longest) longest = r.length; });
      var plain = rows.length === 0;
      var pw = Math.max(170, head.length * 6.8 + 26);
      var W = Math.max(210, Math.min(400, longest * 6.6 + 30));
      return { fields: fields, meths: meths, head: head, plain: plain, w: plain ? pw : W, h: plain ? 40 : TH_H + fields.length * ROW_H + meths.length * ROW_H };
    }

    // Emit one type table with its top-left at (ax, ay); returns its size.
    function emitTable(t, ax, ay, parentId) {
      var sh = tableShape(t);
      var kindCls = t.kind === 'entity' ? 'typeEntity' : 'typeValue';
      var dim = !typeMatches(t);
      var extra = (dim ? ' dimmed' : '')
        + (state.showIssues && issuesBySpec[t.id] ? ' hasIssue' : '')
        + (state.selectedKind === 'type' && state.selected === t.id ? ' sel' : '');
      if (sh.plain) {
        eles.push({
          data: { id: 'T~' + t.id, parent: parentId, label: sh.head, w: sh.w, h: 40, tw: sh.w - 12 },
          position: { x: ax + sh.w / 2, y: ay + 20 }, classes: 'typePlain ' + kindCls + extra,
        });
        return sh;
      }
      eles.push({ data: { id: 'T~' + t.id, parent: parentId, label: '' }, classes: 'typeBox ' + kindCls + extra });
      eles.push({
        data: { id: 'TH~' + t.id, parent: 'T~' + t.id, label: sh.head, w: sh.w, h: TH_H, tw: sh.w - 12 },
        position: { x: ax + sh.w / 2, y: ay + TH_H / 2 }, classes: 'typeHead ' + kindCls + (dim ? ' dimmed' : ''), grabbable: false,
      });
      var ry = ay + TH_H;
      sh.fields.forEach(function (f) {
        var rid = 'TF~' + t.id + '~' + f.name;
        rowIds[rid] = 1;
        eles.push({
          data: { id: rid, parent: 'T~' + t.id, label: rowText(t, f), w: sh.w, h: ROW_H, tw: sh.w - 14 },
          position: { x: ax + sh.w / 2, y: ry + ROW_H / 2 }, classes: 'typeRow' + (fkBy[t.id] && fkBy[t.id][f.name] ? ' fkRow' : '') + (dim ? ' dimmed' : ''), grabbable: false,
        });
        ry += ROW_H;
      });
      sh.meths.forEach(function (m, mi) {
        eles.push({
          data: { id: 'TM~' + t.id + '~' + mi, parent: 'T~' + t.id, label: '\\u0192 ' + m.name + '(): ' + m.returns, w: sh.w, h: ROW_H, tw: sh.w - 14 },
          position: { x: ax + sh.w / 2, y: ry + ROW_H / 2 }, classes: 'typeRow methRow' + (dim ? ' dimmed' : ''), grabbable: false,
        });
        ry += ROW_H;
      });
      return sh;
    }

    // ERD placement follows the layout picker: Layered keeps the grouped
    // dependency columns; Grid wraps tables into rows (no single giant column);
    // Concentric rings the most-referenced types toward the centre.
    var deg = {};
    list.forEach(function (t) { deg[t.id] = 0; });
    Object.keys(aggRefs).forEach(function (k) { var r = aggRefs[k]; if (deg[r.from] !== undefined) deg[r.from]++; if (deg[r.to] !== undefined) deg[r.to]++; });
    var byDegree = function (a, b) { return (deg[b.id] - deg[a.id]) || (a.id < b.id ? -1 : 1); };
    var erdLayout = state.layout === 'grid' ? 'grid' : (state.layout === 'concentric' || state.layout === 'force') ? 'concentric' : 'layered';

    if (erdLayout === 'grid') {
      var target = Math.max(1000, Math.ceil(Math.sqrt(list.length)) * 300);
      var gx = 0, gy = 0, rowH = 0;
      list.slice().sort(byDegree).forEach(function (t) {
        var s = tableShape(t);
        if (gx > 0 && gx + s.w > target) { gx = 0; gy += rowH + Y_GAP; rowH = 0; }
        emitTable(t, gx, gy, undefined);
        gx += s.w + X_GAP;
        if (s.h > rowH) rowH = s.h;
      });
    } else if (erdLayout === 'concentric') {
      var sizeById = {};
      list.forEach(function (t) { sizeById[t.id] = tableShape(t); });
      var cpos = concentricPositions(
        list.map(function (t) { return t.id; }),
        function (id) { return deg[id] || 0; },
        function (id) { return sizeById[id]; },
        1.7, // widen into a landscape ellipse — screens are horizontal
        function (id) { return layer[id] || 0; } // upstream types toward the top
      );
      list.forEach(function (t) {
        var s = sizeById[t.id], p = cpos[t.id] || { x: 0, y: 0 };
        emitTable(t, p.x - s.w / 2, p.y - s.h / 2, undefined);
      });
    } else {
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
            var s = emitTable(t, x, y, multi ? gid : undefined);
            y += s.h + Y_GAP;
            if (s.w > colW) colW = s.w;
          });
          groupH = Math.max(groupH, y - groupY);
          x += colW + X_GAP;
        });
        groupY += groupH + GROUP_GAP;
      });
    }

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
    if (scope.kind === 'types' || scope.kind === 'databases') return buildTypeElements();
    var entries = childrenOf(scope);
    var eles = [];
    var ve = viewEdges(scope, entries);
    // Data-coupling overlay: same scoping pipeline, a different edge source.
    var vd = state.dataCoupling ? viewEdges(scope, entries, MODEL.dataEdges) : { agg: {}, ghosts: {} };
    Object.keys(vd.ghosts).forEach(function (g) { if (!ve.ghosts[g]) ve.ghosts[g] = vd.ghosts[g]; });
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
    // Anchor sizes + reference degree, for the layout strategies.
    var sizeByAnchor = {}, degByAnchor = {};
    entries.forEach(function (e) { var aid = anchorNodeId(e); sizeByAnchor[aid] = sizeOf(e, inners[aid]); degByAnchor[aid] = 0; });
    Object.keys(ve.agg).forEach(function (k) {
      var edge = ve.agg[k];
      if (degByAnchor[edge.src] !== undefined) degByAnchor[edge.src]++;
      if (degByAnchor[edge.tgt] !== undefined) degByAnchor[edge.tgt]++;
    });

    // Top-level anchor placement follows the layout picker. Concentric and Grid
    // are computed here (as presets); Force seeds from Layered and is relaxed by
    // cytoscape's physics layout afterwards in positionView().
    var posByAnchor = {}, x = 0;
    if (state.layout === 'concentric') {
      entries.forEach(function (e) { calcLayer(e, {}); }); // dependency depth → flow rank
      var cpos = concentricPositions(
        entries.map(function (e) { return anchorNodeId(e); }),
        function (id) { return degByAnchor[id] || 0; },
        function (id) { return sizeByAnchor[id]; },
        1.7, // widen into a landscape ellipse — screens are horizontal
        function (id) { return layerOf[id] || 0; } // entrypoints (layer 0) toward the top
      );
      entries.forEach(function (e) {
        var aid = anchorNodeId(e), s = sizeByAnchor[aid], p = cpos[aid] || { x: 0, y: 0 };
        posByAnchor[aid] = { x: p.x, y: p.y, w: s.w, h: s.h };
        if (p.x + s.w / 2 > x) x = p.x + s.w / 2;
      });
    } else if (state.layout === 'grid') {
      var gsorted = entries.slice().sort(function (a, b) { return (degByAnchor[anchorNodeId(b)] - degByAnchor[anchorNodeId(a)]) || (a.id < b.id ? -1 : 1); });
      var target = Math.max(900, Math.ceil(Math.sqrt(entries.length)) * 320);
      var gx = 0, gy = 0, rowH = 0;
      gsorted.forEach(function (e) {
        var aid = anchorNodeId(e), s = sizeByAnchor[aid];
        if (gx > 0 && gx + s.w > target) { gx = 0; gy += rowH + GAP_Y; rowH = 0; }
        posByAnchor[aid] = { x: gx + s.w / 2, y: gy + s.h / 2, w: s.w, h: s.h };
        gx += s.w + GAP_X; if (s.h > rowH) rowH = s.h;
        if (gx > x) x = gx;
      });
    } else {
      entries.forEach(function (e) { calcLayer(e, {}); });
      var cols = {};
      entries.forEach(function (e) { var l = layerOf[anchorNodeId(e)] || 0; (cols[l] = cols[l] || []).push(e); });
      var colKeys = Object.keys(cols).map(Number).sort(function (a, b) { return a - b; });
      // Force seeds from a DIAGONAL cascade — each dependency layer starts lower,
      // so cose relaxes from an entrypoints-top-left → leaves-bottom-right flow.
      // Layered stays a pure left-to-right grid (cascade 0), unchanged.
      var cascade = state.layout === 'force' ? 130 : 0, colIdx = 0;
      colKeys.forEach(function (ck) {
        var col = cols[ck].sort(function (a, b) { return a.id < b.id ? -1 : 1; });
        var colW = 0, y = colIdx * cascade;
        col.forEach(function (e) { colW = Math.max(colW, sizeByAnchor[anchorNodeId(e)].w); });
        col.forEach(function (e) {
          var aid = anchorNodeId(e), s = sizeByAnchor[aid];
          posByAnchor[aid] = { x: x + colW / 2, y: y + s.h / 2, w: s.w, h: s.h };
          y += s.h + GAP_Y;
        });
        x += colW + GAP_X;
        colIdx++;
      });
    }

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

    // Externals are placed TOWARD the in-scope node(s) they connect to — on the
    // perimeter of the graph bounds in that direction — so the connecting line is
    // short and doesn't cut across the diagram. Falls back to left(incoming) /
    // right(outgoing) when the connection is dead-centre or unknown.
    var ghostDir = {}, ghostConn = {};
    var conn = function (gid, other) {
      var p = posByAnchor[other];
      if (!p) return;
      var gc = ghostConn[gid] = ghostConn[gid] || { sx: 0, sy: 0, n: 0 };
      gc.sx += p.x; gc.sy += p.y; gc.n++;
    };
    [ve.agg, vd.agg].forEach(function (aggMap) {
      Object.keys(aggMap).forEach(function (k) {
        var e = aggMap[k];
        if (ve.ghosts[e.src]) { ghostDir[e.src] = (ghostDir[e.src] || 0) | 1; conn(e.src, e.tgt); }
        if (ve.ghosts[e.tgt]) { ghostDir[e.tgt] = (ghostDir[e.tgt] || 0) | 2; conn(e.tgt, e.src); }
      });
    });
    var bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
    Object.keys(posByAnchor).forEach(function (aid) {
      var p = posByAnchor[aid];
      if (p.x - p.w / 2 < bMinX) bMinX = p.x - p.w / 2;
      if (p.x + p.w / 2 > bMaxX) bMaxX = p.x + p.w / 2;
      if (p.y - p.h / 2 < bMinY) bMinY = p.y - p.h / 2;
      if (p.y + p.h / 2 > bMaxY) bMaxY = p.y + p.h / 2;
    });
    if (bMinX === Infinity) { bMinX = 0; bMaxX = 0; bMinY = 0; bMaxY = 0; }
    var GHW = 170, GHH = 46, GH_GAP = 90;
    var ccx = (bMinX + bMaxX) / 2, ccy = (bMinY + bMaxY) / 2;
    var halfW = (bMaxX - bMinX) / 2 + GHW / 2 + GH_GAP, halfH = (bMaxY - bMinY) / 2 + GHH / 2 + GH_GAP;
    var placedGhosts = [];
    Object.keys(ve.ghosts).sort().forEach(function (gid) {
      var g = ve.ghosts[gid], incoming = (ghostDir[gid] || 2) & 1, gc = ghostConn[gid];
      var dx = gc && gc.n ? gc.sx / gc.n - ccx : 0, dy = gc && gc.n ? gc.sy / gc.n - ccy : 0;
      if (dx === 0 && dy === 0) { dx = incoming ? -1 : 1; dy = 0; } // fallback: in=left, out=right
      var len = Math.sqrt(dx * dx + dy * dy) || 1, ux = dx / len, uy = dy / len;
      var t = Math.min(ux !== 0 ? halfW / Math.abs(ux) : Infinity, uy !== 0 ? halfH / Math.abs(uy) : Infinity);
      placedGhosts.push({ gid: gid, g: g, x: ccx + ux * t, y: ccy + uy * t });
    });
    // Separate any externals that landed on top of each other.
    for (var gIter = 0; gIter < 40; gIter++) {
      var gMoved = false;
      for (var ga = 0; ga < placedGhosts.length; ga++) {
        for (var gb = ga + 1; gb < placedGhosts.length; gb++) {
          var pa = placedGhosts[ga], pb = placedGhosts[gb];
          var ddx = pb.x - pa.x, ddy = pb.y - pa.y;
          var ox = (GHW + 24) - Math.abs(ddx), oy = (GHH + 14) - Math.abs(ddy);
          if (ox > 0 && oy > 0) {
            if (ox <= oy) { var sx = (ddx === 0 ? (ga < gb ? -1 : 1) : (ddx > 0 ? 1 : -1)) * ox / 2; pa.x -= sx; pb.x += sx; }
            else { var sy = (ddy === 0 ? -1 : (ddy > 0 ? 1 : -1)) * oy / 2; pa.y -= sy; pb.y += sy; }
            gMoved = true;
          }
        }
      }
      if (!gMoved) break;
    }
    placedGhosts.forEach(function (pp) {
      posByAnchor[pp.gid] = { x: pp.x, y: pp.y, w: GHW, h: GHH };
      eles.push({
        data: { id: pp.gid, label: pp.g.label + '\\n(external)', w: GHW, h: GHH, tw: GHW - 14, extKind: pp.g.kind, extId: pp.g.id },
        position: { x: pp.x, y: pp.y },
        classes: 'ghost',
      });
    });

    function pointInRect(p, r) {
      return p.x >= r.l && p.x <= r.r && p.y >= r.t && p.y <= r.b;
    }
    function orient(a, b, c) {
      var v = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
      return Math.abs(v) < 0.0001 ? 0 : (v > 0 ? 1 : 2);
    }
    function onSeg(a, b, c) {
      return b.x <= Math.max(a.x, c.x) && b.x >= Math.min(a.x, c.x)
        && b.y <= Math.max(a.y, c.y) && b.y >= Math.min(a.y, c.y);
    }
    function segsCross(a, b, c, d) {
      var o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
      if (o1 !== o2 && o3 !== o4) return true;
      return (o1 === 0 && onSeg(a, c, b)) || (o2 === 0 && onSeg(a, d, b))
        || (o3 === 0 && onSeg(c, a, d)) || (o4 === 0 && onSeg(c, b, d));
    }
    function segmentHitsRect(a, b, rect) {
      if (pointInRect(a, rect) || pointInRect(b, rect)) return true;
      var tl = { x: rect.l, y: rect.t }, tr = { x: rect.r, y: rect.t };
      var br = { x: rect.r, y: rect.b }, bl = { x: rect.l, y: rect.b };
      return segsCross(a, b, tl, tr) || segsCross(a, b, tr, br)
        || segsCross(a, b, br, bl) || segsCross(a, b, bl, tl);
    }
    function routeHash(s) {
      var h = 0;
      for (var hi = 0; hi < s.length; hi++) h = ((h << 5) - h + s.charCodeAt(hi)) | 0;
      return Math.abs(h);
    }
    function routeData(src, tgt, routeKey) {
      var a = posByAnchor[src], b = posByAnchor[tgt];
      var hash = routeHash(routeKey || (src + '>' + tgt));
      var laneStep = hash % 4;
      var laneSign = (hash % 8) < 4 ? 1 : -1;
      if (!a || !b) {
        return { cpDist: laneSign * (78 + laneStep * 8), cpWeight: 0.48, taxiTurn: laneSign * (54 + laneStep * 20) };
      }
      var dx = b.x - a.x, dy = b.y - a.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = -dy / len, ny = dx / len;
      var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      var hits = 0, side = 0, margin = 54;
      Object.keys(posByAnchor).forEach(function (id) {
        if (id === src || id === tgt) return;
        var p = posByAnchor[id];
        var rect = { l: p.x - p.w / 2 - margin, r: p.x + p.w / 2 + margin, t: p.y - p.h / 2 - margin, b: p.y + p.h / 2 + margin };
        if (!segmentHitsRect({ x: a.x, y: a.y }, { x: b.x, y: b.y }, rect)) return;
        hits++;
        var obstacleSide = ((p.x - mid.x) * nx + (p.y - mid.y) * ny) >= 0 ? -1 : 1;
        side += obstacleSide;
      });
      if (!hits) {
        return { cpDist: laneSign * (78 + laneStep * 8), cpWeight: 0.48, taxiTurn: laneSign * (54 + laneStep * 20) };
      }
      var sign = side === 0 ? laneSign : (side > 0 ? 1 : -1);
      return {
        cpDist: sign * Math.min(280, 132 + hits * 44 + laneStep * 10),
        cpWeight: 0.5,
        taxiTurn: sign * Math.min(170, 74 + hits * 22 + laneStep * 20),
      };
    }

    var dimmedAnchors = {};
    entries.forEach(function (e) { if (state.query && !matches(e)) dimmedAnchors[anchorNodeId(e)] = true; });
    var i = 0;
    Object.keys(ve.agg).forEach(function (key) {
      var e = ve.agg[key];
      var bundle = e.n > 1;
      var dim = state.query && (dimmedAnchors[e.src] || dimmedAnchors[e.tgt]);
      var route = routeData(e.src, e.tgt, key);
      eles.push({
        data: { id: 'e' + (i++), source: e.src, target: e.tgt, lbl: bundle ? e.n + ' links' : '', cpDist: route.cpDist, cpWeight: route.cpWeight, taxiTurn: route.taxiTurn },
        classes: 'routed ' + (e.cross ? 'cross ' : '') + (bundle ? 'bundle ' : '') + (e.ghost ? 'toghost ' : '') + (dim ? 'dimmed' : ''),
      });
    });

    // Data-coupling overlay edges (dashed, distinct) — only where there is NO
    // logical dependency already, so it reveals the otherwise-hidden coupling.
    if (state.dataCoupling) {
      var di = 0;
      Object.keys(vd.agg).forEach(function (key) {
        if (ve.agg[key]) return;
        var e = vd.agg[key];
        var dim = state.query && (dimmedAnchors[e.src] || dimmedAnchors[e.tgt]);
        var route = routeData(e.src, e.tgt, key);
        eles.push({
          data: { id: 'de' + (di++), source: e.src, target: e.tgt, lbl: e.n > 1 ? e.n + ' \\u00d7 models' : 'models', cpDist: route.cpDist, cpWeight: route.cpWeight, taxiTurn: route.taxiTurn },
          classes: 'routed datacoupling' + (e.ghost ? ' toghost' : '') + (dim ? ' dimmed' : ''),
        });
      });
    }

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
  positionView(true);
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
  // Cytoscape's built-in layouts for the component view (self-contained — no
  // layout extension). Force is seeded from the layered positions so it
  // untangles crossings deterministically instead of reshuffling each rebuild.
  // Only Force (cose) is a native cytoscape layout now — Concentric and Grid are
  // computed as size-aware presets in buildElements. Cose is tuned to account for
  // the large box sizes (nodeDimensionsIncludeLabels + high repulsion/overlap and
  // long ideal edges) so nodes spread out instead of clumping and overlapping.
  function nativeLayoutOptions() {
    return {
      name: 'cose', animate: false, randomize: false, padding: 60,
      nodeDimensionsIncludeLabels: true,
      nodeRepulsion: function () { return 400000; },
      nodeOverlap: 80,
      idealEdgeLength: function () { return 200; },
      edgeElasticity: function () { return 120; },
      gravity: 0.15, componentSpacing: 200, nestingFactor: 1.2,
      numIter: 1500, coolingFactor: 0.96, initialTemp: 240,
    };
  }
  // Post-layout overlap removal: cose is isotropic, so wide-but-short boxes still
  // overlap horizontally even when vertically clear. Separate every overlapping
  // pair along its axis of LEAST overlap (horizontal overlaps resolve
  // horizontally), honouring per-axis gaps — so wide nodes get real horizontal
  // clearance without inflating the (already fine) vertical spacing.
  function resolveOverlaps(gapX, gapY) {
    var arr = cy.nodes().orphans().toArray();
    for (var iter = 0; iter < 80; iter++) {
      var moved = false;
      for (var i = 0; i < arr.length; i++) {
        for (var j = i + 1; j < arr.length; j++) {
          var a = arr[i], b = arr[j];
          var ba = a.boundingBox(), bb = b.boundingBox();
          var dx = (bb.x1 + bb.x2) / 2 - (ba.x1 + ba.x2) / 2;
          var dy = (bb.y1 + bb.y2) / 2 - (ba.y1 + ba.y2) / 2;
          var ox = (ba.w + bb.w) / 2 + gapX - Math.abs(dx);
          var oy = (ba.h + bb.h) / 2 + gapY - Math.abs(dy);
          if (ox > 0 && oy > 0) {
            if (ox <= oy) {
              var sx = (dx === 0 ? (i < j ? -1 : 1) : (dx > 0 ? 1 : -1)) * ox / 2;
              a.position('x', a.position('x') - sx); b.position('x', b.position('x') + sx);
            } else {
              var sy = (dy === 0 ? -1 : (dy > 0 ? 1 : -1)) * oy / 2;
              a.position('y', a.position('y') - sy); b.position('y', b.position('y') + sy);
            }
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
  }
  function runNativeLayout() {
    if (state.layout !== 'force') return; // concentric/grid are presets from buildElements
    var wasAuto = cy.autolock();
    if (wasAuto) cy.autolock(false);
    try {
      cy.layout(nativeLayoutOptions()).run();
      resolveOverlaps(56, 20);
      // Widen the result into landscape (screens are horizontal). Stretching only
      // x, around the centre, after overlap removal never re-introduces overlaps.
      var ns = cy.nodes().orphans();
      if (ns.length > 1) {
        var bb = ns.boundingBox(), cx = (bb.x1 + bb.x2) / 2;
        ns.forEach(function (n) { n.position('x', cx + (n.position('x') - cx) * 1.6); });
      }
    } catch (e) { /* layout unavailable */ }
    if (wasAuto) cy.autolock(true);
  }
  // Position the current view: run the chosen algorithm for a fresh component
  // view (the ERD is pre-anchored by buildElements per strategy), then let any
  // saved manual rearrangement win on top.
  function positionView(fit) {
    var sv = (saved.positionsByView || {})[viewKey()];
    var hasSaved = sv && Object.keys(sv).length > 0;
    if (state.view.kind !== 'types' && state.layout !== 'layered' && !hasSaved) runNativeLayout();
    applySavedPositions();
    if (fit) cy.fit(undefined, 60);
  }
  function rebuild(fit) {
    pinnedProxy = null;
    cy.batch(function () {
      cy.elements().remove();
      cy.add(buildElements());
    });
    positionView(fit);
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
    if (v.kind === 'databases') {
      var dpath = [{ kind: 'databases', id: null, label: MODEL.system.name }];
      if (v.id) {
        var dsegs = v.id.split('::');
        for (var di = 1; di <= dsegs.length; di++) {
          var dsid = dsegs.slice(0, di).join('::');
          dpath.push({ kind: 'databases', id: dsid, label: nameOf({ kind: 'subsystem', id: dsid }) });
        }
      }
      dpath[dpath.length - 1].label += ' \\u00B7 Databases';
      return dpath;
    }
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
    if (state.view.kind === 'types' || state.view.kind === 'databases') {
      var scoped = typesInScope().length;
      var label = state.view.kind === 'databases' ? 'database tables' : 'types (ERD';
      document.getElementById('viewHint').textContent = 'View: ' + scoped + ' ' + label
        + (state.view.id ? ', ' + state.view.id + ' + shared' : '') + (state.view.kind === 'databases' ? '' : ')') + ' \\u00B7 '
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
    notifyViewChange();
  }

  // ---- Stage J: URL <-> view routing ----------------------------------------
  // The canvas navigation lives in the URL path (refresh-safe + shareable). A
  // route is the string AFTER /canvas/<project>: '' = system root; a '/'-joined
  // NAMESPACE (e.g. 'a/b') that resolves against the model to a subsystem or a
  // component; or the 'types'/'databases' view modes with an optional scope.
  // A segment is the '::' namespace with '/' as separator, each part encoded.
  function encSeg(s) { return encodeURIComponent(String(s)); }
  function routeOf(view) {
    if (!view) return '';
    var k = view.kind;
    if (k === 'system') return '';
    if (k === 'types' || k === 'databases') {
      return view.id ? k + '/' + view.id.split('::').map(encSeg).join('/') : k;
    }
    if (k === 'subsystem') {
      return view.id ? view.id.split('::').map(encSeg).join('/') : '';
    }
    if (k === 'component') {
      // A component's full namespace path IS its id: a chained subproject carries
      // the subsystem prefix in the id (a::b::comp), a flat project uses the bare
      // id (comp). Serializing comp.id split on '::' round-trips exactly via the
      // compById lookup in resolveRoute. Owner-pattern nesting is deliberately NOT
      // encoded (ownership is a separate axis; comp.id does not embed the owner).
      var c = compById[view.id];
      var full = c ? c.id : view.id;
      return full.split('::').map(encSeg).join('/');
    }
    return '';
  }
  function resolveRoute(routeStr) {
    var parts = String(routeStr || '').split('/').filter(function (s) { return s.length > 0; }).map(decodeURIComponent);
    if (!parts.length) return { kind: 'system', id: null };
    // NOTE: a subsystem literally named 'types'/'databases' is SHADOWED by these
    // view-mode routes (acceptable — the modes own those first segments).
    if (parts[0] === 'types') {
      return { kind: 'types', id: parts.length > 1 ? parts.slice(1).join('::') : null };
    }
    if (parts[0] === 'databases') {
      if (!showDatabaseTab) return { kind: 'system', id: null };
      return { kind: 'databases', id: parts.length > 1 ? parts.slice(1).join('::') : null };
    }
    var joined = parts.join('::');
    if (subById[joined]) return { kind: 'subsystem', id: joined };
    if (compById[joined]) return { kind: 'component', id: joined };
    return { kind: 'system', id: null }; // unknown id -> fall back to the root
  }
  // Apply a route (URL -> engine) WITHOUT echoing back through onViewChange.
  function openRoute(routeStr) {
    var v = resolveRoute(routeStr);
    if (state.view.kind === v.kind && state.view.id === v.id) return;
    applyingRoute = true;
    try {
      state.view = { kind: v.kind, id: v.id };
      state.selected = null;
      state.selectedKind = null;
      state.typesRenderAll = false;
      rebuild(true);
      renderPanel();
    } finally {
      applyingRoute = false;
    }
  }
  // Notify the embedder (engine -> URL) of the current view; suppressed while a
  // route is being applied so the URL is not driven in a loop.
  function notifyViewChange() {
    if (applyingRoute) return;
    if (typeof opts !== 'undefined' && opts && typeof opts.onViewChange === 'function') {
      try { opts.onViewChange(routeOf(state.view)); } catch (e) { /* ignore */ }
    }
  }
  // Explain (and offer to override) a performance-degraded ERD.
  function renderTypesNotice() {
    var el = document.getElementById('typesWarn');
    if (!el) return;
    if ((state.view.kind !== 'types' && state.view.kind !== 'databases') || !typesNotice) { el.style.display = 'none'; el.innerHTML = ''; return; }
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
  // Port hover reveals the cross-boundary line; the general node-hover below
  // handles the per-node highlight and stub edges.
  cy.on('mouseover', 'node.proxyExt', function (ev) {
    cy.remove('.revealHover');
    if (ev.target.id() !== pinnedProxy) revealEdgesFor(ev.target, 'revealHover');
  });
  cy.on('mouseout', 'node.proxyExt', function () { cy.remove('.revealHover'); });

  // Hover-highlight the SPECIFIC node under the cursor (inner tiles/ports
  // included), GUARDED so a stationary/oscillating pointer over the same node
  // doesn't re-thrash classes (which flickered). Container boxes are skipped —
  // you hover their children, not the box — and it never touches the selection.
  var hoveredNode = null;
  function setHover(n) {
    var nid = n && n.length ? n.id() : null;
    if ((hoveredNode ? hoveredNode.id() : null) === nid) return; // unchanged — no churn
    if (hoveredNode && hoveredNode.length) { hoveredNode.removeClass('hoverhl'); hoveredNode.connectedEdges('.inneredge').removeClass('stubHover'); }
    hoveredNode = null;
    if (n && n.length && !n.isParent()) {
      var t = idOf(n);
      if (!(t.group || t.cluster)) {
        n.addClass('hoverhl');
        n.connectedEdges('.inneredge').addClass('stubHover');
        hoveredNode = n;
      }
    }
  }
  cy.on('mouseover', 'node', function (ev) { setHover(ev.target); });
  cy.on('mouseout', 'node', function (ev) { if (hoveredNode && hoveredNode.id() === ev.target.id()) setHover(null); });

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
    // Optional host hook (web UI): double-clicking a leaf component node hands the
    // id back to the embedder (e.g. the environment view opens that project's
    // canvas). The opts object only exists when the engine is mounted as a module;
    // in the standalone export it is undefined, so this is inert there.
    if (typeof opts !== 'undefined' && opts && opts.onNodeOpen && t.kind === 'component') {
      opts.onNodeOpen('component', t.id);
      return;
    }
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
      notifyViewChange();
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
  // Sync each View toggle's checkbox from the (possibly persisted) state, then
  // persist on change so the choices survive a refresh (see persist()/saved).
  document.getElementById('internalsToggle').checked = state.internals;
  document.getElementById('internalsToggle').addEventListener('change', function (ev) { state.internals = ev.target.checked; persist(); rebuild(true); });
  document.getElementById('externalsToggle').checked = state.externals;
  document.getElementById('externalsToggle').addEventListener('change', function (ev) { state.externals = ev.target.checked; persist(); rebuild(true); });
  document.getElementById('dataCouplingToggle').checked = state.dataCoupling;
  document.getElementById('dataCouplingToggle').addEventListener('change', function (ev) { state.dataCoupling = ev.target.checked; persist(); renderLegend(); rebuild(true); });
  document.getElementById('issuesToggle').checked = state.showIssues;
  document.getElementById('issuesToggle').addEventListener('change', function (ev) { state.showIssues = ev.target.checked; persist(); rebuild(false); renderPanel(); });
  document.getElementById('dragToggle').addEventListener('change', function (ev) { cy.autolock(!ev.target.checked); });
  // Mode seg: Components ⇄ Types. Entering Types keeps the current subsystem
  // scope, so a subsystem's own types (plus shared ones) show scoped.
  function typesScopeFromView() {
    if (state.view.kind === 'subsystem') return state.view.id;
    if (state.view.kind === 'component') {
      var c = compById[state.view.id];
      return c ? c.subsystem : null;
    }
    if (state.view.kind === 'types' || state.view.kind === 'databases') return state.view.id;
    return null;
  }
  (function () {
    var seg = document.getElementById('modeSeg');
    var btns = seg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        if (b.getAttribute('data-vm') === 'databases' && !showDatabaseTab) {
          b.style.display = 'none';
        }
        b.addEventListener('click', function () {
          var vm = b.getAttribute('data-vm');
          if (vm === 'databases' && showDatabaseTab) navigateTo('databases', typesScopeFromView());
          else if (vm === 'types') navigateTo('types', typesScopeFromView());
          else if (vm === 'components') navigateTo(state.view.id ? 'subsystem' : 'system', state.view.id || null);
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
          if (state.view.kind === 'types' || state.view.kind === 'databases') rebuild(true);
          else updateHeaderSegs();
        });
      })(btns[i]);
    }
  })();
  function updateHeaderSegs() {
    var seg = document.getElementById('modeSeg');
    var btns = seg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var vm = btns[i].getAttribute('data-vm');
      var active = vm === 'components'
        ? (state.view.kind !== 'types' && state.view.kind !== 'databases')
        : vm === state.view.kind;
      if (btns[i].classList) btns[i].classList[active ? 'add' : 'remove']('active');
    }
    var td = document.getElementById('typesDetailSeg');
    td.style.display = (state.view.kind === 'types' || state.view.kind === 'databases') ? '' : 'none';
    var tbs = td.querySelectorAll('button');
    for (var j = 0; j < tbs.length; j++) {
      if (tbs[j].classList) tbs[j].classList[tbs[j].getAttribute('data-td') === state.typesDetail ? 'add' : 'remove']('active');
    }
  }
  (function () {
    var lSelect = document.getElementById('lineStyleSelect');
    if (lSelect) {
      lSelect.value = state.lineStyle;
      lSelect.addEventListener('change', function (ev) {
        state.lineStyle = ev.target.value;
        persist();
        cy.style(buildStyle(THEMES[state.theme]));
      });
    }
  })();
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

  // Presentation mode is CSS-only — it does NOT trigger browser F11 fullscreen,
  // so exiting is a single step (the ✕ button), not "exit F11 then exit
  // presentation". The details panel stays reachable via a floating toggle, so
  // presentation is "the canvas focused with the current settings", not a
  // stripped view.
  function setPresentation(on) {
    if (document.body.classList) {
      document.body.classList[on ? 'add' : 'remove']('presentation');
      if (!on) document.body.classList.remove('show-details');
    }
    setTimeout(function () { cy.resize(); cy.fit(undefined, 40); }, 60);
  }
  document.getElementById('presentBtn').addEventListener('click', function () { setPresentation(true); });
  document.getElementById('exitPresent').addEventListener('click', function () { setPresentation(false); });
  document.getElementById('presentDetails').addEventListener('click', function () {
    if (document.body.classList) document.body.classList.toggle('show-details');
    setTimeout(function () { cy.resize(); cy.fit(undefined, 40); }, 60);
  });

  // Anchor a fixed dropdown menu just under its button, right-aligned, clamped to
  // the viewport. Fixed positioning means it floats over the whole page and is
  // never clipped by the header's overflow (or the embedded canvas's scroll box).
  function positionDropdownMenu(dd, btn) {
    var menu = dd.querySelector ? dd.querySelector('.menu') : null;
    if (!menu || !btn.getBoundingClientRect || typeof window === 'undefined') return;
    var r = btn.getBoundingClientRect();
    menu.style.top = (r.bottom + 6) + 'px';
    menu.style.left = 'auto';
    menu.style.right = Math.max(6, window.innerWidth - r.right) + 'px';
  }
  function wireDropdown(ddId, btnId) {
    var dd = document.getElementById(ddId);
    var btn = document.getElementById(btnId);
    btn.addEventListener('click', function (ev) {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      if (!dd.classList) return;
      var opening = !dd.classList.contains('open');
      dd.classList.toggle('open');
      if (opening) positionDropdownMenu(dd, btn);
    });
    return dd;
  }
  var dd = wireDropdown('exportDd', 'exportBtn');
  var fdd = wireDropdown('flowExportDd', 'flowExportBtn');
  var ldd = wireDropdown('layoutDd', 'layoutBtn');
  var sdd = wireDropdown('settingsDd', 'settingsBtn');
  var mdd = wireDropdown('moreDd', 'moreBtn');
  // Keep the settings panel open while flipping switches (clicks inside it don't
  // bubble to the document-level close handler).
  (function () {
    var m = document.getElementById('settingsMenu');
    if (m && m.addEventListener) m.addEventListener('click', function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); });
  })();

  // Layout picker: choose the auto-layout algorithm. Components use cytoscape's
  // native layouts; the ERD maps them onto its table-anchor strategies.
  var LAYOUT_LABEL = { layered: 'Layered', force: 'Force', concentric: 'Concentric', grid: 'Grid' };
  function updateLayoutBtn() {
    var b = document.getElementById('layoutBtn');
    if (b) b.textContent = 'Layout: ' + (LAYOUT_LABEL[state.layout] || 'Layered') + ' \\u25BE';
  }
  function setLayout(name) {
    if (!LAYOUT_LABEL[name] || state.layout === name) { if (ldd.classList) ldd.classList.remove('open'); return; }
    state.layout = name;
    persist();
    updateLayoutBtn();
    if (ldd.classList) ldd.classList.remove('open');
    rebuild(true);
  }
  Object.keys(LAYOUT_LABEL).forEach(function (name) {
    var b = document.getElementById('layout' + name.charAt(0).toUpperCase() + name.slice(1));
    if (b && b.addEventListener) b.addEventListener('click', function () { setLayout(name); });
  });
  updateLayoutBtn();

  if (document.addEventListener) {
    document.addEventListener('click', function () {
      if (dd.classList) dd.classList.remove('open');
      if (fdd.classList) fdd.classList.remove('open');
      if (ldd.classList) ldd.classList.remove('open');
      if (sdd.classList) sdd.classList.remove('open');
      if (mdd && mdd.classList) mdd.classList.remove('open');
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

  // ── Responsive header overflow → "⋯" dropdown ─────────────────────────────
  // When the floating header no longer fits its controls, trailing items
  // COLLAPSE into the More menu instead of relying on horizontal scroll —
  // every control stays one click away. Whole items move (listeners survive
  // reparenting); a hidden placeholder pins each item's original position so
  // restoring keeps the exact order. Collapse order = least-used first.
  (function () {
    if (typeof window === 'undefined') return;
    var hdr = document.getElementById('hdr');
    var moreDd = document.getElementById('moreDd');
    var moreMenu = document.getElementById('moreMenu');
    if (!hdr || !moreDd || !moreMenu || !hdr.getBoundingClientRect) return;
    // Collapse order = least-used first. A dropdown trigger moves with its
    // WRAPPER (the .dropdown div) so its own menu keeps working from the More
    // menu (menus are fixed-positioned at the trigger's rect).
    var COLLAPSE = ['themeBtn', 'resetBtn', 'exportBtn', 'layoutBtn', 'presentBtn', 'fitBtn', 'panelToggle'];
    var markers = {};
    function movableFor(id) {
      var el = document.getElementById(id);
      if (!el) return null;
      var p = el.parentNode;
      if (p && p.className && String(p.className).indexOf('dropdown') >= 0 && p !== moreMenu) return p;
      return el;
    }
    function markerFor(id, el) {
      if (!markers[id]) {
        var m = document.createElement('span');
        m.style.display = 'none';
        el.parentNode.insertBefore(m, el);
        markers[id] = m;
      }
      return markers[id];
    }
    var collapsed = [];
    // Signed fit measure in px: positive = overflowing, negative = headroom.
    // The header is a flex row whose ONLY flex:1 child is the .spacer, so the
    // spacer's rendered width IS the free space -- it grows to absorb all slack
    // and collapses to 0 the instant the row is full. That makes a right-edge
    // measurement useless (the spacer keeps the trailing controls pinned to the
    // right padding at every width, so their edge always reads as a bare fit),
    // and scrollWidth clamps at clientWidth so it can't report headroom either.
    // So take headroom from the spacer's own (fractional) width, and true
    // overflow from scrollWidth - clientWidth (only ever > 0 once the spacer has
    // already collapsed to 0). The two terms are mutually exclusive.
    function overflowPx() {
      var spacer = hdr.querySelector('.spacer');
      var slack = spacer ? spacer.getBoundingClientRect().width : 0;
      return (hdr.scrollWidth - hdr.clientWidth) - slack;
    }
    function reflow() {
      // Not laid out (hidden tab, non-browser DOM) — measuring would misfire.
      var box = hdr.getBoundingClientRect();
      if (!box || box.width <= 0) return;
      // Restore everything, then collapse until the row fits (idempotent).
      for (var i = collapsed.length - 1; i >= 0; i--) {
        var it = collapsed[i];
        if (it.el && it.marker && it.marker.parentNode) it.marker.parentNode.insertBefore(it.el, it.marker);
      }
      collapsed = [];
      moreDd.style.display = 'none';
      hdr.scrollLeft = 0;
      var guard = 0;
      // Demand a few px of headroom, not a bare fit — the marginal-fit widths
      // are exactly where the phantom scrollbar appeared.
      while (overflowPx() > -8 && guard < COLLAPSE.length) {
        var id = COLLAPSE[guard++];
        var el = movableFor(id);
        if (!el || el === moreDd || el.parentNode === moreMenu) continue;
        var m = markerFor(id, el);
        // A dropdown moved while open would strand its fixed-positioned menu.
        if (el.classList) el.classList.remove('open');
        moreDd.style.display = '';
        moreMenu.appendChild(el);
        collapsed.push({ el: el, marker: m });
      }
      if (collapsed.length === 0) moreDd.style.display = 'none';
    }
    var raf = null;
    var defer = window.requestAnimationFrame
      ? window.requestAnimationFrame.bind(window)
      : window.setTimeout.bind(window);
    function schedule() {
      if (raf !== null) return;
      raf = defer(function () { raf = null; reflow(); });
    }
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(schedule).observe(hdr);
    } else if (window.addEventListener) {
      window.addEventListener('resize', schedule);
    }
    schedule();
  })();
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
  // Intent prose (the detail dial's alternative to a step narrative).
  function intentFor(compId, method) {
    var c = compById[compId];
    if (!c || !c.intents) return null;
    for (var i = 0; i < c.intents.length; i++) {
      if (c.intents[i].method === method) return c.intents[i].text;
    }
    return null;
  }
  // The method's L3 contract (signature/description/returns) if declared.
  function methodInfo(compId, method) {
    var c = compById[compId];
    if (!c) return null;
    for (var i = 0; i < c.interfaces.length; i++) {
      var ms = c.interfaces[i].methods;
      for (var j = 0; j < ms.length; j++) {
        if (ms[j].name === method) return { intf: c.interfaces[i], m: ms[j] };
      }
    }
    return null;
  }
  // A call target is "openable" when we can show SOMETHING for it: a step
  // narrative, an intent paragraph, or at least its contract. This lets the user
  // drill into intent-only / contract-only methods (see the explanation there),
  // not just fully-narrated ones.
  function openable(compId, method) {
    return !!(narrativeFor(compId, method) || intentFor(compId, method) || methodInfo(compId, method));
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

    // Region depth (loop/try/parallel bodies) → indentation; loop body ends
    // flow back to their header instead of falling through.
    var depth = {}, open = [], loopEnd = {};
    steps.forEach(function (s) {
      while (open.length && open[open.length - 1] < s.n) open.pop();
      depth[s.n] = open.length;
      if ((s.kind === 'loop' || s.kind === 'try' || s.kind === 'parallel') && s.end !== undefined) open.push(s.end);
      if (s.kind === 'loop' && s.end !== undefined) loopEnd[s.end] = s.n;
    });

    // Parallel fan-out/join: arms are contiguous ordered sub-regions of the
    // body; an arm's LAST step continues at the region's JOIN bar (a virtual
    // node, id 'j'+header), never into its neighbor arm. Built outermost-first
    // (ascending header) so a nested parallel whose endStep is an outer arm
    // end resolves its continuation through the outer mapping — mirrors the
    // validator's stepGraph() fallNext generalization.
    var joins = [];         // [{id, header, end, arms}] — virtual join-bar nodes
    var virtualNode = {};   // non-step node ids (join bars, detached ghosts)
    var armEndJoin = {};    // arm-end step → the join id it flows into
    var joinCont = {};      // join id → what runs after the region (step or outer join)
    function fallNext(n) { return armEndJoin[n] !== undefined ? armEndJoin[n] : nextOf(n); }
    steps.forEach(function (p) {
      if (p.kind !== 'parallel' || p.end === undefined || !(p.branches && p.branches.length >= 2)) return;
      var jid = 'j' + p.n;
      var pEntries = p.branches.map(function (b) { return b.step; }).sort(function (a, b) { return a - b; });
      joinCont[jid] = fallNext(p.end);
      joins.push({ id: jid, header: p.n, end: p.end, arms: pEntries.length });
      virtualNode[jid] = 1;
      for (var ai = 0; ai < pEntries.length; ai++) {
        var armEnd = ai + 1 < pEntries.length ? prevOf(pEntries[ai + 1]) : p.end;
        if (armEnd !== null && armEnd >= pEntries[ai]) armEndJoin[armEnd] = jid;
      }
    });

    // Detached (fire-and-forget) calls: the callee hangs OFF the flow as a
    // ghost node reached by a dashed open arrow, while the caller's own lane
    // continues immediately — failure does not propagate back.
    var detached = [];
    steps.forEach(function (s) {
      if (!s.detach || !(s.kind === 'call' || s.kind === 'dispatch') || !s.call) return;
      var did = 'd' + s.n;
      detached.push({ id: did, from: s.n, comp: s.call.component, method: s.call.method });
      virtualNode[did] = 1;
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
      if (s.kind === 'parallel' && s.end !== undefined && s.branches && s.branches.length >= 2) {
        // One lane per arm: arm 0 stays under the fan-out bar; each further
        // arm shifts into its own lane, side by side (like case blocks).
        var armStarts = s.branches.map(function (b) { return b.step; })
          .filter(function (n2) { return byN[n2]; })
          .sort(function (a, b) { return a - b; });
        armStarts.forEach(function (as2, ai) {
          if (ai === 0) return;
          var aEnd = ai + 1 < armStarts.length ? prevOf(armStarts[ai + 1]) : s.end;
          if (aEnd !== null && aEnd >= as2) shiftSpan(as2, aEnd, ai);
        });
      }
    });
    var lane = {};
    nums.forEach(function (n, i) { lane[n] = laneAdd[i]; });

    var edges = [];
    function E(a, b, kind, label) { if (b !== null && b !== undefined && (byN[b] || virtualNode[b])) edges.push({ from: a, to: b, kind: kind, label: label || '' }); }
    steps.forEach(function (s) {
      var n = s.n;
      switch (s.kind) {
        case 'branch':
          E(n, s.onTrue !== undefined ? s.onTrue : fallNext(n), 'true', 'true');
          E(n, s.onFalse, 'false', 'false');
          break;
        case 'switch':
          (s.cases || []).forEach(function (cse) { E(n, cse.step, 'case', cse.value); });
          E(n, s.defaultStep !== undefined ? s.defaultStep : fallNext(n), 'default', 'default');
          break;
        case 'loop':
          E(n, nextOf(n), 'enter', s.loopKind === 'doWhile' ? 'do' : '');
          if (s.end !== undefined) {
            E(s.end, n, 'back', s.loopKind === 'doWhile' ? 'while ' + (s.cond || '') : '\\u27F3');
            E(n, fallNext(s.end), 'exit', 'done');
          }
          break;
        case 'try':
          E(n, nextOf(n), 'seq');
          (s.catches || []).forEach(function (cc) { E(n, cc.step, 'error', cc.error); });
          if (s.fin !== undefined) E(n, s.fin, 'finally', 'finally');
          break;
        case 'parallel':
          // Fan-out: the header bar forks to EVERY arm entry; the implicit
          // join (all arms complete) is the virtual bar wired up below.
          (s.branches || []).forEach(function (br) { E(n, br.step, 'fork', br.name || ''); });
          break;
        case 'jump':
          E(n, s.to, 'jump');
          break;
        case 'return':
        case 'throw':
          break;
        default:
          // Fall-through — except a loop body end (flows back to its header)
          // and an arm end (flows into the join bar, never the neighbor arm).
          if (loopEnd[n] === undefined) E(n, fallNext(n), armEndJoin[n] !== undefined ? 'join' : 'seq');
      }
    });
    // Join bars continue at the step after the region (or the outer join);
    // detached ghosts hang off their firing step with an annotated open arrow.
    joins.forEach(function (j) { E(j.id, joinCont[j.id], 'seq'); });
    detached.forEach(function (d) { E(d.from, d.id, 'detached', 'detached'); });
    return { steps: steps, edges: edges, depth: depth, lane: lane, first: nums.length ? nums[0] : null, joins: joins, detached: detached };
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
      // Join bars and detached ghosts are NOT error paths — they survive the
      // toggle whenever their region/firing step does.
      joins: (graph.joins || []).filter(function (j) { return keep[j.id]; }),
      detached: (graph.detached || []).filter(function (d) { return keep[d.id]; }),
    };
  }

  function flowStepLabel(s) {
    switch (s.kind) {
      case 'branch': return s.n + '. \\u25C7 ' + (s.cond || s.text);
      case 'switch': return s.n + '. \\u25C7 switch ' + (s.on || s.text);
      case 'loop': return s.n + '. \\u27F3 ' + (s.loopKind === 'doWhile' ? 'do' : (s.loopKind || 'forEach')) + (s.over ? ' ' + s.over : s.cond ? ' while ' + s.cond : '');
      case 'try': return s.n + '. \\u26E8 try \\u2014 ' + s.text;
      case 'parallel': return s.n + '. \\u2225 ' + s.text;
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
    var rowOf = {};
    graph.steps.forEach(function (s2, i2) { rowOf[s2.n] = i2 + 1; });
    var joinByHeader = {};
    (graph.joins || []).forEach(function (j2) { joinByHeader[j2.header] = j2; });
    graph.steps.forEach(function (s, i) {
      var id = 'n' + s.n;
      var isCall = (s.kind === 'call' || s.kind === 'dispatch') && !!s.call;
      // A detached call's target renders as a separate ghost node (below), so
      // the step node itself stays plain and undrillable.
      var isDetached = isCall && !!s.detach;
      var callable = isCall && !isDetached && openable(s.call.component, s.call.method);
      var isCond = s.kind === 'branch' || s.kind === 'switch' || s.kind === 'loop';
      var label = flowStepLabel(s) + (isCall && !isDetached ? '\\n\\u2192 ' + s.call.component + '.' + s.call.method + '()' + (callable ? '  \\u21B4' : '') : '');
      var cls = s.kind === 'branch' || s.kind === 'switch' ? 'flowcond'
        : s.kind === 'loop' ? 'flowloop'
        : s.kind === 'try' ? 'flowtry'
        : s.kind === 'parallel' ? 'flowfork'
        : s.kind === 'return' ? 'flowend'
        : s.kind === 'throw' ? 'flowthrow'
        : s.kind === 'jump' ? 'flowjumpn'
        : isCall ? 'flowcall' : 'flowlocal';
      // A parallel header renders as a fan-out BAR spanning its arm lanes
      // (label above); its implicit join bar is added after the loop.
      var jinfo = s.kind === 'parallel' ? joinByHeader[s.n] : undefined;
      var laneN = graph.lane[s.n] || 0;
      eles.push({
        data: {
          id: id, label: label,
          w: jinfo ? 344 * (jinfo.arms - 1) + 320 : isCond ? 320 : 300,
          h: jinfo ? 16 : isCall ? 58 : isCond ? 64 : 46,
          tw: jinfo ? 344 * (jinfo.arms - 1) + 280 : isCond ? 210 : 280,
          callComp: isCall ? s.call.component : '', callMethod: isCall ? s.call.method : '',
        },
        // Rows keep code order (Y); lanes give branches/cases/arms their own
        // column (X), wide enough that side-by-side nodes never overlap.
        position: { x: jinfo ? (laneN + (jinfo.arms - 1) / 2) * 344 : laneN * 344, y: (i + 1) * 92 },
        classes: cls + (callable ? ' drill' : ''),
      });
    });
    // Implicit join bars: one per parallel region, spanning the arm lanes just
    // below the body's last row — all arms complete before flow continues.
    (graph.joins || []).forEach(function (j) {
      // A pruned/dangling endStep must not orphan the bar's edges — park it
      // after the last kept row instead of dropping it.
      var rEnd = rowOf[j.end] !== undefined ? rowOf[j.end] : graph.steps.length;
      var laneJ = graph.lane[j.header] || 0;
      var barW = 344 * (j.arms - 1) + 320;
      eles.push({
        data: { id: 'n' + j.id, label: 'join \\u2014 all ' + j.arms + ' arms', w: barW, h: 16, tw: barW - 40 },
        position: { x: (laneJ + (j.arms - 1) / 2) * 344, y: rEnd * 92 + 46 },
        classes: 'flowjoin',
      });
    });
    // Detached-call ghosts: the callee sits OFF the flow lane, reached by a
    // dashed open arrow labeled "detached" — failure does not propagate back.
    (graph.detached || []).forEach(function (d) {
      if (rowOf[d.from] === undefined) return;
      var dCallable = openable(d.comp, d.method);
      eles.push({
        data: {
          id: 'n' + d.id,
          label: d.comp + '.' + d.method + '()' + (dCallable ? '  \\u21B4' : '') + '\\ndetached \\u2014 fire & forget',
          w: 260, h: 52, tw: 240, callComp: d.comp, callMethod: d.method,
        },
        position: { x: ((graph.lane[d.from] || 0)) * 344 + 330, y: rowOf[d.from] * 92 },
        classes: 'flowdetach' + (dCallable ? ' drill' : ''),
      });
    });
    // No L5 narrative for the opened method: instead of an empty chart, show
    // its intent paragraph (or contract description) as a single note node, so a
    // drilled-in intent-only / contract-only method still explains itself.
    if (!narrative) {
      var noteText = intentFor(top.comp, top.method);
      var miN = methodInfo(top.comp, top.method);
      if (!noteText && miN) noteText = miN.m.description + (miN.m.returns ? '  \\u2192 returns ' + miN.m.returns : '');
      eles.push({ data: { id: 'intentNote', label: noteText || 'No narrative or intent recorded for this method.', w: 380, h: 120, tw: 340 }, position: { x: 0, y: 120 }, classes: 'flowintent' });
      eles.push({ data: { id: 'fe-intent', source: 'start', target: 'intentNote', lbl: '' } });
    }
    if (graph.first !== null) eles.push({ data: { id: 'fe-start', source: 'start', target: 'n' + graph.first, lbl: '' } });
    graph.edges.forEach(function (e, i) {
      var cls = e.kind === 'error' ? 'fErr'
        : e.kind === 'back' ? 'fBack'
        : e.kind === 'false' ? 'fAlt'
        : e.kind === 'jump' || e.kind === 'finally' ? 'fJump'
        : e.kind === 'case' || e.kind === 'default' ? 'fAlt'
        : e.kind === 'fork' ? 'fFork'
        : e.kind === 'join' ? 'fJoin'
        : e.kind === 'detached' ? 'fDetach'
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
      // Parallel fan-out/join bars (UML activity style): solid slim bars; the
      // fork carries the step label above it, the join a small caption below.
      { selector: '.flowfork', style: { 'background-color': t.ink, 'border-color': t.ink, color: t.ink, 'text-valign': 'top', 'text-margin-y': -6, 'font-weight': 'bold' } },
      { selector: '.flowjoin', style: { 'background-color': t.ink, 'border-color': t.ink, color: t.edgeText, 'text-valign': 'bottom', 'text-margin-y': 6, 'font-size': 9.5 } },
      // Detached-call ghost: visibly off the flow, no failure propagation.
      { selector: '.flowdetach', style: { 'background-color': t.ghostFill, 'border-color': t.ghostStroke, 'border-style': 'dashed', color: t.ghostText, 'font-style': 'italic' } },
      { selector: '.flowintent', style: { shape: 'round-rectangle', width: 'label', height: 'label', padding: '16px', 'background-color': t.ghostFill, 'border-color': t.ghostStroke, 'border-style': 'dashed', color: t.innerText, 'text-max-width': 340, 'text-wrap': 'wrap', 'font-size': 11.5, 'text-valign': 'center', 'text-halign': 'center', 'font-style': 'italic' } },
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
      // Fork fan-out is a first-class flow edge (slightly heavier); the join
      // collectors route orthogonally down their own (empty) lane corridor.
      { selector: 'edge.fFork', style: { width: 2.2 } },
      { selector: 'edge.fJoin', style: { width: 2.2, 'curve-style': 'taxi', 'taxi-direction': 'downward', 'taxi-turn': -34, 'taxi-turn-min-distance': 10 } },
      // Detached: dashed OPEN arrow — fire-and-forget, no failure propagation.
      { selector: 'edge.fDetach', style: { 'line-style': 'dashed', 'target-arrow-shape': 'vee' } },
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
      case 'parallel': return '\\u2225 parallel \\u2014 arms ' + (s.branches || []).map(function (b) { return (b.name ? b.name + ' ' : '') + '\\u2192 ' + b.step; }).join(', ') + (s.end !== undefined ? ' (join after ' + s.end + ')' : '');
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
    if (!narrative) {
      // No step-by-step narrative — show the method's contract + intent prose so
      // a drilled-in intent-only / contract-only method still explains itself.
      var intent = intentFor(top.comp, top.method);
      var mi = methodInfo(top.comp, top.method);
      var parts = ['<div class="fstep" style="opacity:.7">No step-by-step narrative \\u2014 showing intent / contract:</div>'];
      if (mi) {
        parts.push('<div class="fstep"><code>' + escText(mi.m.signature) + '</code></div>');
        parts.push('<div class="fstep">' + escText(mi.m.description) + (mi.m.returns ? ' \\u2014 returns ' + escText(mi.m.returns) : '') + '</div>');
      }
      if (intent) parts.push('<div class="fstep" style="font-style:italic">' + escText(intent) + '</div>');
      if (!mi && !intent) parts.push('<div class="fstep">No intent or contract recorded for this method.</div>');
      el.innerHTML = parts.join('');
      return;
    }
    var html = narrative.steps.map(function (s) {
      var callHtml = '';
      if (s.call) {
        var callable = openable(s.call.component, s.call.method);
        callHtml = ' \\u2192 <span class="call' + (callable ? ' drillstep' : '') + '" data-dc="' + s.call.component + '" data-dm="' + s.call.method + '">'
          + s.call.component + '.' + s.call.method + '()' + (callable ? ' \\u21B4' : '') + '</span>'
          + (s.detach ? ' <span style="opacity:.72">\\u21E2 detached \\u2014 fire &amp; forget</span>' : '');
      }
      return '<div class="fstep"><span class="num">' + s.n + '.</span> ' + escText(flowStepText(s)) + callHtml + '</div>';
    }).join('');
    el.innerHTML = html;
    // Single click on the styled step link drills in (it looks like a hyperlink,
    // so it behaves like one). The flowchart graph keeps double-click, since a
    // single tap in a dense chart is too easy to land accidentally.
    var drills = el.querySelectorAll('.drillstep');
    for (var i = 0; i < drills.length; i++) {
      (function (d) {
        d.addEventListener('click', function () { drillFlow(d.getAttribute('data-dc'), d.getAttribute('data-dm')); });
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
      var name = flowStepLabel(s) + (s.call && !s.detach ? ' \\u2192 ' + s.call.component + '.' + s.call.method + '()' : '');
      comps.push({ id: 'n' + s.n, name: name, subsystem: 'flow', componentType: (s.kind === 'call' || s.kind === 'dispatch') ? 'Call' : 'Step', public: false, owns: [] });
    });
    // Virtual flow nodes (join bars, detached-call ghosts) export as plain
    // steps so the editable diagrams keep the fan-out/join and detachment.
    (graph.joins || []).forEach(function (j) {
      comps.push({ id: 'n' + j.id, name: '\\u2225 join \\u2014 all ' + j.arms + ' arms', subsystem: 'flow', componentType: 'Step', public: false, owns: [] });
    });
    (graph.detached || []).forEach(function (d) {
      comps.push({ id: 'n' + d.id, name: d.comp + '.' + d.method + '() \\u2014 detached', subsystem: 'flow', componentType: 'Call', public: false, owns: [] });
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
  function clearFocus() { cy.elements().removeClass('defocus edgeFocus edgeOut edgeIn'); }
  function applyFocus(node) {
    clearFocus();
    if (!node || !node.length) return;
    var core = node;
    if (node.isParent && node.isParent()) core = core.union(node.descendants());
    var edges = core.connectedEdges();
    // A top-level box focuses its EXTERNAL relations (not its own internal
    // wiring); an inner tile or a port focuses the edges WITHIN its boundary too.
    if (!(node.isChild && node.isChild())) edges = edges.not('.inneredge');
    if (!edges.length) return; // isolated node — nothing to spotlight
    var reveal = edges.filter('.revealEdge');   // keep visible, keep its own style
    var colorable = edges.not('.revealEdge');
    var keep = core.union(edges).union(edges.connectedNodes());
    keep = keep.union(keep.ancestors());
    cy.elements().addClass('defocus');
    keep.removeClass('defocus');
    // Colour by direction: outgoing (this → dependency) vs incoming (← dependent).
    var outE = colorable.filter(function (e) { return core.contains(e.source()) && !core.contains(e.target()); });
    var inE = colorable.filter(function (e) { return core.contains(e.target()) && !core.contains(e.source()); });
    outE.addClass('edgeOut').removeClass('defocus');
    inE.addClass('edgeIn').removeClass('defocus');
    colorable.not(outE).not(inE).addClass('edgeFocus').removeClass('defocus');
    reveal.removeClass('defocus');
  }

  function select(kind, id, focus) {
    // Selecting a type from a component view (param chip, "Used by" chip…)
    // switches into the ERD first, keeping the current subsystem scope.
    if (kind === 'type' && state.view.kind !== 'types' && state.view.kind !== 'databases') {
      state.view = { kind: 'types', id: typesScopeFromView() };
      rebuild(true);
      notifyViewChange();
    } else if (kind === 'component' && (state.view.kind === 'types' || state.view.kind === 'databases')) {
      var c = compById[id];
      state.view = { kind: 'subsystem', id: c ? c.subsystem : null };
      rebuild(true);
      notifyViewChange();
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

  // ---- OpenAPI affordance ---------------------------------------------------
  // A component "exposes an API" when any of its contract methods carries an HTTP
  // endpoint. The details panel offers a "View OpenAPI" button that opens the
  // project's rendered surface: in the web app via the host hook (opts.onOpenApi),
  // on a served shared page as a sibling path (/share/<token>/openapi). In a
  // downloaded standalone file (file://) there is no server, so it is hidden.
  function componentExposesApi(c) {
    return (c.interfaces || []).some(function (i) {
      return (i.methods || []).some(function (m) { return m.endpoint && m.endpoint.transport === 'HTTP'; });
    });
  }
  function openApiSiblingHref() {
    if (typeof window === 'undefined' || !/^https?:$/.test(window.location.protocol)) return null;
    return window.location.pathname.replace(/\\/$/, '') + '/openapi';
  }
  function openApiAllowed() {
    return (typeof opts !== 'undefined' && opts && opts.onOpenApi) || openApiSiblingHref() !== null;
  }
  // The OpenAPI document is a PROJECT-level artifact (the whole project's external
  // gateway surface), so the affordance is offered up the whole hierarchy where
  // it is contextually relevant: a portal that exposes HTTP, its subsystem, and
  // the project root — each opens the same project surface.
  function subsystemExposesApi(sid) {
    return MODEL.components.some(function (x) {
      return (x.subsystem === sid || (x.subsystem || '').indexOf(sid + '::') === 0) && componentExposesApi(x);
    });
  }
  function projectExposesApi() {
    return MODEL.components.some(componentExposesApi);
  }
  // tag = the component's L0 gateway entry id (its section in the combined spec),
  // so a portal deep-links straight to its own operations; a subsystem/project
  // passes '' and opens the whole combined document.
  function openApiButton(exposes, tag) {
    if (!exposes || !openApiAllowed()) return '';
    return '<div class="openbtn"><button class="tbtn" data-openapi-tag="' + esc(tag || '') + '">\\u25A4 View OpenAPI \\u2197</button></div>';
  }
  // "Open in Specs" — deep-links the focused spec into the hosted Specs value
  // editor via a host hook (opts.onOpenSpec). Hidden when no host provides it
  // (standalone file, shared page): those have no editor to open. kind is the
  // spec layer, id its qualified spec id.
  function openSpecButton(kind, id) {
    if (typeof opts === 'undefined' || !opts || typeof opts.onOpenSpec !== 'function') return '';
    return '<div class="openbtn"><button class="tbtn" data-openspec-kind="' + kind + '" data-openspec-id="' + esc(id) + '">\\u270E Open in Specs \\u2197</button></div>';
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
        + (scopeFocus ? '' : openViewButton('component', c.id, c.owns.length > 0))
        + openApiButton(componentExposesApi(c), c.apiTag)
        + openSpecButton('component', c.id);
      
      var linkedTypes = MODEL.types.filter(function (t) { return t.componentClass === c.id; });
      if (linkedTypes.length) {
        head += '<div style="margin-top:6px"><b style="font-size:11px">Linked System Entity:</b> '
          + linkedTypes.map(function (t) { return chip(t.id, 'type', t.id); }).join(' ')
          + '</div>';
      }
      body += '<p class="desc">' + esc(c.description) + '</p>';

      if (c.externalLinks && c.externalLinks.length) {
        body += section('External links', c.externalLinks.length, c.externalLinks.map(function (l) {
          var label = l.label || l.url;
          var tag = l.type === 'implementation' ? staticChip('source') : '';
          return '<div class="method">' + tag + '<a href="' + esc(l.url) + '" target="_blank" rel="noopener" style="color:var(--accent);word-break:break-all">' + esc(label) + ' \\u2197</a></div>';
        }).join(''), true);
      }

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
          + (ty.subsystem ? chip(ty.subsystem, 'subsystem', ty.subsystem) : staticChip('system-level shared'))
          + openSpecButton('type', ty.id);
        
        if (ty.componentClass) {
          head += '<div style="margin-top:6px"><b style="font-size:11px">Class Component:</b> ' + chip(ty.componentClass, 'component', ty.componentClass) + '</div>';
        }
        if (ty.database) {
          var dbName = ty.database;
          if (MODEL.system.databases) {
            var dbSpec = MODEL.system.databases.find(function(d) { return d.id === ty.database; });
            if (dbSpec) dbName = dbSpec.name;
          }
          head += '<div style="margin-top:6px"><b style="font-size:11px">Database Table:</b> ' + staticChip(dbName + '.' + (ty.table || ty.id)) + '</div>';
        }
        if (ty.linkedEntity) {
          head += '<div style="margin-top:6px"><b style="font-size:11px">Linked System Entity:</b> ' + chip(ty.linkedEntity, 'type', ty.linkedEntity) + '</div>';
        }
        var mappingTables = MODEL.types.filter(function (t) { return t.linkedEntity === ty.id; });
        if (mappingTables.length) {
          head += '<div style="margin-top:6px"><b style="font-size:11px">Database Table Mapping:</b> '
            + mappingTables.map(function (t) { return chip(t.id, 'type', t.id); }).join(' ')
            + '</div>';
        }

        var fieldsInner = ty.fields.length
          ? ty.fields.map(function (f) {
              var fk = null;
              MODEL.typeEdges.forEach(function (e2) { if (!fk && e2.from === ty.id && e2.field === f.name) fk = e2; });
              var keyLabel = f.key === 'primary' ? 'PK' : f.key === 'unique' ? 'unique' : f.key === 'foreign' ? 'FK' : '';
              if (!keyLabel && f.references) keyLabel = 'FK';
              
              var refHtml = '';
              if (f.references) {
                var targetTypeId = f.references.split('.')[0];
                var targetExists = MODEL.types.some(function(t) { return t.id === targetTypeId; });
                refHtml = '<div class="mdesc">References: ' + (targetExists ? chip(f.references, 'type', targetTypeId) : esc(f.references)) + '</div>';
              } else if (fk) {
                refHtml = '<div class="mdesc">FK \\u2192 ' + chip(fk.to + ' [' + (fk.card || '1') + ']', 'type', fk.to) + '</div>';
              }

              return '<div class="method"><div class="mname">' + esc(f.name)
                + (keyLabel ? ' <span class="chip">' + keyLabel + '</span>' : '')
                + (f.optional ? ' <span class="chip" style="opacity:.7">optional</span>' : '')
                + '</div><code>' + esc(f.type) + '</code>'
                + refHtml
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
        + (scopeFocus ? '' : openViewButton('subsystem', s.id, subKids > 0))
        + openApiButton(subsystemExposesApi(s.id), '')
        + openSpecButton('subsystem', s.id);
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
        + (MODEL.types.length ? '<div class="openbtn"><button class="tbtn" id="openTypesBtn">\\u25B8 Types (ERD) \\u2014 ' + MODEL.types.length + '</button></div>' : '')
        + openApiButton(projectExposesApi(), '');
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
    var oapis = panel.querySelectorAll('[data-openapi-tag]');
    for (var oi = 0; oi < oapis.length; oi++) {
      (function (b) {
        b.addEventListener('click', function () {
          var tag = b.getAttribute('data-openapi-tag') || '';
          if (typeof opts !== 'undefined' && opts && opts.onOpenApi) { opts.onOpenApi(tag); return; }
          var href = openApiSiblingHref();
          if (href) window.open(href + (tag ? '#/' + tag : ''), '_blank', 'noopener');
        });
      })(oapis[oi]);
    }
    var ospecs = panel.querySelectorAll('[data-openspec-kind]');
    for (var si = 0; si < ospecs.length; si++) {
      (function (b) {
        b.addEventListener('click', function () {
          if (typeof opts !== 'undefined' && opts && typeof opts.onOpenSpec === 'function') {
            opts.onOpenSpec(b.getAttribute('data-openspec-kind'), b.getAttribute('data-openspec-id') || '');
          }
        });
      })(ospecs[si]);
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
  // Stage G: a deep link may focus a component and/or open a method's narrative
  // modal once the seeded view + DOM + cy graph exist. The host parses the URL hash
  // into opts.initialSelect / opts.initialFlow — both carry the component id, so this
  // works whether the seeded view is the component itself or its parent subsystem
  // (a leaf component has no meaningful "inside", so Specs deep-links open the parent
  // and focus the component here).
  (function () {
    if (typeof opts === 'undefined' || !opts) return;
    var f = opts.initialFlow, s = opts.initialSelect;
    var focusComp = (f && f.comp) || (s && s.comp);
    if (focusComp && compById[focusComp]) {
      try { select('component', focusComp, true); } catch (e) { /* ignore */ }
    }
    if (f && f.comp && f.method && compById[f.comp]) {
      try { openFlow(f.comp, f.method, f.mode === 'steps' ? 'steps' : 'flow'); } catch (e) { /* ignore */ }
    }
  })();
})();
</script>
</body>
</html>
`;
