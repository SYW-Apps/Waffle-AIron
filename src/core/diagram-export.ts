import { CanvasModel } from './canvas.js';
import { computeLayout, LayoutResult } from './canvas-layout.js';

// ---------------------------------------------------------------------------
// Editable diagram exports: draw.io (mxGraph XML) and Excalidraw (scene JSON).
//
// Both builders are SELF-CONTAINED BY DESIGN (no references to module scope):
// the interactive canvas serializes them via Function.prototype.toString into
// its HTML, so in-browser exports use the user's CURRENT (possibly rearranged)
// node positions — while the CLI exporters below call them with the computed
// blueprint layout. One implementation, both worlds.
// ---------------------------------------------------------------------------

/** Minimal model surface the builders need (structural subset of CanvasModel). */
export interface ExportModel {
  system: { name: string };
  generatedAt: string;
  subsystems: { id: string; name: string }[];
  components: {
    id: string;
    name: string;
    subsystem: string;
    componentType: string;
    portalType?: string;
    public: boolean;
    owner?: string;
    owns: string[];
  }[];
  edges: { from: string; to: string; cross: boolean }[];
}

export function buildDrawioXml(model: ExportModel, L: LayoutResult): string {
  const PATTERN_TYPES: Record<string, number> = { Repository: 1, Gateway: 1, FeatureComponent: 1, RouterComponent: 1 };
  const COLORS: Record<string, { fill: string; stroke: string }> = {
    entry: { fill: '#eef4ff', stroke: '#4a7dcf' },
    logic: { fill: '#f4effd', stroke: '#8a5cf6' },
    data: { fill: '#fdf6e3', stroke: '#c9963f' },
    adapter: { fill: '#eef8f1', stroke: '#4f9e6b' },
    pattern: { fill: '#f6f8fa', stroke: '#6a737d' },
  };
  function stereo(t: string): string {
    if (t === 'Portal' || t === 'Observer') return 'entry';
    if (t === 'Store' || t === 'Index' || t === 'Registry') return 'data';
    if (t === 'Adapter') return 'adapter';
    if (PATTERN_TYPES[t]) return 'pattern';
    return 'logic';
  }
  function esc(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const cells: string[] = [];
  const compById: Record<string, ExportModel['components'][number]> = {};
  model.components.forEach(function (c) { compById[c.id] = c; });

  function vertex(id: string, parent: string, value: string, style: string, box: { x: number; y: number; w: number; h: number }, parentBox?: { x: number; y: number }): void {
    const x = parentBox ? box.x - parentBox.x : box.x;
    const y = parentBox ? box.y - parentBox.y : box.y;
    cells.push(
      '        <mxCell id="' + esc(id) + '" value="' + esc(value) + '" style="' + esc(style) + '" vertex="1" parent="' + esc(parent) + '">' +
      '<mxGeometry x="' + x + '" y="' + y + '" width="' + box.w + '" height="' + box.h + '" as="geometry"/></mxCell>',
    );
  }

  model.subsystems.forEach(function (sub) {
    const box = L.subs[sub.id];
    if (!box) return;
    vertex('sub_' + sub.id, '1', sub.name,
      'rounded=1;arcSize=4;fillColor=#ffffff;strokeColor=#b6c0cc;verticalAlign=top;fontStyle=1;fontSize=13;container=1;collapsible=1;whiteSpace=wrap;',
      box);
  });

  model.components.forEach(function (comp) {
    const box = L.boxes[comp.id];
    if (!box) return;
    const isPattern = !!PATTERN_TYPES[comp.componentType] && comp.owns.length > 0;
    const owner = comp.owner ? compById[comp.owner] : undefined;
    const nestInPattern = !!(owner && L.boxes[owner.id]);
    const parentId = nestInPattern ? 'comp_' + owner!.id : 'sub_' + comp.subsystem;
    const parentBox = nestInPattern ? L.boxes[owner!.id] : L.subs[comp.subsystem];
    const colors = COLORS[stereo(comp.componentType)];
    const label = comp.name + '\n«' + comp.componentType + (comp.portalType ? '/' + comp.portalType : '') + '»';
    const style = isPattern
      ? 'rounded=1;fillColor=' + colors.fill + ';strokeColor=' + colors.stroke + ';dashed=1;verticalAlign=top;fontStyle=1;container=1;collapsible=1;whiteSpace=wrap;'
      : 'rounded=1;fillColor=' + colors.fill + ';strokeColor=' + colors.stroke + ';whiteSpace=wrap;fontSize=11;' + (comp.public ? 'strokeWidth=3;' : '');
    vertex('comp_' + comp.id, parentId, label, style, box, parentBox);
  });

  let edgeN = 0;
  model.edges.forEach(function (edge) {
    if (!L.boxes[edge.from] || !L.boxes[edge.to]) return;
    const style = edge.cross
      ? 'edgeStyle=orthogonalEdgeStyle;rounded=1;strokeColor=#c26767;strokeWidth=2;endArrow=block;endFill=1;'
      : 'edgeStyle=orthogonalEdgeStyle;rounded=1;strokeColor=#8d97a5;endArrow=block;endFill=1;';
    cells.push(
      '        <mxCell id="edge_' + (edgeN++) + '" style="' + esc(style) + '" edge="1" parent="1" ' +
      'source="' + esc('comp_' + edge.from) + '" target="' + esc('comp_' + edge.to) + '">' +
      '<mxGeometry relative="1" as="geometry"/></mxCell>',
    );
  });

  return [
    '<mxfile host="wairon" agent="wairon" modified="' + esc(model.generatedAt) + '">',
    '  <diagram id="architecture" name="' + esc(model.system.name) + ' architecture">',
    '    <mxGraphModel dx="1000" dy="700" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0">',
    '      <root>',
    '        <mxCell id="0"/>',
    '        <mxCell id="1" parent="0"/>',
  ].concat(cells, [
    '      </root>',
    '    </mxGraphModel>',
    '  </diagram>',
    '</mxfile>',
    '',
  ]).join('\n');
}

export function buildExcalidrawScene(model: ExportModel, L: LayoutResult): string {
  const PATTERN_TYPES: Record<string, number> = { Repository: 1, Gateway: 1, FeatureComponent: 1, RouterComponent: 1 };
  const COLORS: Record<string, { fill: string; stroke: string }> = {
    entry: { fill: '#eef4ff', stroke: '#4a7dcf' },
    logic: { fill: '#f4effd', stroke: '#8a5cf6' },
    data: { fill: '#fdf6e3', stroke: '#c9963f' },
    adapter: { fill: '#eef8f1', stroke: '#4f9e6b' },
    pattern: { fill: '#f6f8fa', stroke: '#6a737d' },
  };
  function stereo(t: string): string {
    if (t === 'Portal' || t === 'Observer') return 'entry';
    if (t === 'Store' || t === 'Index' || t === 'Registry') return 'data';
    if (t === 'Adapter') return 'adapter';
    if (PATTERN_TYPES[t]) return 'pattern';
    return 'logic';
  }
  function seedFor(id: string): number {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h) || 1;
  }
  function base(id: string, type: string, box: { x: number; y: number; w: number; h: number }): any {
    return {
      id: id, type: type, x: box.x, y: box.y, width: box.w, height: box.h,
      angle: 0, strokeColor: '#1f2328', backgroundColor: 'transparent',
      fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0,
      opacity: 100, groupIds: [], frameId: null, roundness: { type: 3 },
      seed: seedFor(id), version: 1, versionNonce: seedFor(id + '#n'),
      isDeleted: false, boundElements: [], updated: 1, link: null, locked: false,
    };
  }
  function boundLabel(rect: any, text: string, fontSize: number, verticalAlign: string): any {
    const id = rect.id + '-label';
    const label = base(id, 'text', { x: rect.x + 8, y: rect.y + 6, w: rect.width - 16, h: 20 });
    label.roundness = null;
    label.text = text;
    label.originalText = text;
    label.fontSize = fontSize;
    label.fontFamily = 1;
    label.textAlign = 'center';
    label.verticalAlign = verticalAlign;
    label.containerId = rect.id;
    label.autoResize = true;
    label.lineHeight = 1.25;
    rect.boundElements.push({ id: id, type: 'text' });
    return label;
  }

  const elements: any[] = [];
  const rectById: Record<string, any> = {};

  model.subsystems.forEach(function (sub) {
    const box = L.subs[sub.id];
    if (!box) return;
    const rect = base('sub-' + sub.id, 'rectangle', box);
    rect.backgroundColor = '#ffffff';
    rect.strokeColor = '#b6c0cc';
    elements.push(rect);
    elements.push(boundLabel(rect, sub.name, 14, 'top'));
  });

  model.components.forEach(function (comp) {
    const box = L.boxes[comp.id];
    if (!box) return;
    const isPattern = !!PATTERN_TYPES[comp.componentType] && comp.owns.length > 0;
    const colors = COLORS[stereo(comp.componentType)];
    const rect = base('comp-' + comp.id, 'rectangle', box);
    rect.backgroundColor = colors.fill;
    rect.strokeColor = colors.stroke;
    rect.strokeWidth = comp.public ? 3 : 1;
    rect.strokeStyle = (isPattern || stereo(comp.componentType) === 'pattern') ? 'dashed' : 'solid';
    elements.push(rect);
    rectById[comp.id] = rect;
    const label = comp.name + '\n«' + comp.componentType + (comp.portalType ? '/' + comp.portalType : '') + '»';
    elements.push(boundLabel(rect, label, 11, isPattern ? 'top' : 'middle'));
  });

  let edgeN = 0;
  model.edges.forEach(function (edge) {
    const a = L.boxes[edge.from], b = L.boxes[edge.to];
    const src = rectById[edge.from], tgt = rectById[edge.to];
    if (!a || !b || !src || !tgt) return;
    const leftToRight = b.x >= a.x + a.w;
    const start = leftToRight ? { x: a.x + a.w, y: a.y + a.h / 2 } : { x: a.x, y: a.y + a.h / 2 };
    const end = leftToRight ? { x: b.x, y: b.y + b.h / 2 } : { x: b.x + b.w, y: b.y + b.h / 2 };
    const id = 'edge-' + (edgeN++);
    const arrow = base(id, 'arrow', { x: start.x, y: start.y, w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) });
    arrow.roundness = { type: 2 };
    arrow.strokeColor = edge.cross ? '#c26767' : '#8d97a5';
    arrow.strokeWidth = edge.cross ? 2 : 1;
    arrow.points = [[0, 0], [end.x - start.x, end.y - start.y]];
    arrow.lastCommittedPoint = null;
    arrow.startBinding = { elementId: src.id, focus: 0, gap: 4 };
    arrow.endBinding = { elementId: tgt.id, focus: 0, gap: 4 };
    arrow.startArrowhead = null;
    arrow.endArrowhead = 'arrow';
    src.boundElements.push({ id: id, type: 'arrow' });
    tgt.boundElements.push({ id: id, type: 'arrow' });
    elements.push(arrow);
  });

  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'wairon',
    elements: elements,
    appState: { viewBackgroundColor: '#fafbfc', gridSize: null },
    files: {},
  }, null, 2);
}

// ---------------------------------------------------------------------------
// CLI-facing wrappers (blueprint layout)
// ---------------------------------------------------------------------------

export function generateDrawioXml(model: CanvasModel): string {
  return buildDrawioXml(model, computeLayout(model, {}));
}

export function generateExcalidrawScene(model: CanvasModel): string {
  return buildExcalidrawScene(model, computeLayout(model, {}));
}
