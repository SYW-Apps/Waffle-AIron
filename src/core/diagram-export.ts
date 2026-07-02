import { CanvasModel } from './canvas.js';
import { computeLayout, LayoutBox } from './canvas-layout.js';

// ---------------------------------------------------------------------------
// Editable diagram exports: draw.io (mxGraph XML) and Excalidraw (scene JSON).
//
// Both are open formats importable by draw.io/diagrams.net, Excalidraw, and
// tools that accept them (including whiteboard tools with drawio/excalidraw
// import). Positions come from the same computeLayout used by the interactive
// canvas, so every export shows the identical blueprint — subsystems as
// containers (draggable as groups in draw.io), pattern members nested,
// stereotype colors, thick red boundary-hop edges.
// ---------------------------------------------------------------------------

const STEREO_COLORS: Record<string, { fill: string; stroke: string }> = {
  entry: { fill: '#eef4ff', stroke: '#4a7dcf' },
  logic: { fill: '#f4effd', stroke: '#8a63c9' },
  data: { fill: '#fdf6e3', stroke: '#c9963f' },
  adapter: { fill: '#eef8f1', stroke: '#4f9e6b' },
  pattern: { fill: '#f6f8fa', stroke: '#6a737d' },
};

const PATTERN_TYPES = new Set(['Repository', 'Gateway', 'FeatureComponent', 'RouterComponent']);

function stereoKey(componentType: string): keyof typeof STEREO_COLORS {
  if (componentType === 'Portal' || componentType === 'Observer') return 'entry';
  if (componentType === 'Store' || componentType === 'Index' || componentType === 'Registry') return 'data';
  if (componentType === 'Adapter') return 'adapter';
  if (PATTERN_TYPES.has(componentType)) return 'pattern';
  return 'logic';
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// draw.io
// ---------------------------------------------------------------------------

export function generateDrawioXml(model: CanvasModel): string {
  const L = computeLayout(model, {});
  const cells: string[] = [];
  const subCell = (id: string) => `sub_${id}`;
  const compCell = (id: string) => `comp_${id}`;

  const vertex = (
    id: string,
    parent: string,
    value: string,
    style: string,
    box: LayoutBox,
    parentBox?: LayoutBox,
  ) => {
    const x = parentBox ? box.x - parentBox.x : box.x;
    const y = parentBox ? box.y - parentBox.y : box.y;
    cells.push(
      `        <mxCell id="${escapeXml(id)}" value="${escapeXml(value)}" style="${escapeXml(style)}" vertex="1" parent="${escapeXml(parent)}">` +
      `<mxGeometry x="${x}" y="${y}" width="${box.w}" height="${box.h}" as="geometry"/></mxCell>`,
    );
  };

  for (const sub of model.subsystems) {
    const box = L.subs[sub.id];
    if (!box) continue;
    vertex(
      subCell(sub.id),
      '1',
      sub.name,
      'rounded=1;arcSize=4;fillColor=#ffffff;strokeColor=#b6c0cc;verticalAlign=top;fontStyle=1;fontSize=13;container=1;collapsible=1;whiteSpace=wrap;',
      box,
    );
  }

  const componentById = new Map(model.components.map(c => [c.id, c]));
  for (const comp of model.components) {
    const box = L.boxes[comp.id];
    if (!box) continue;
    const isPattern = PATTERN_TYPES.has(comp.componentType) && comp.owns.length > 0;
    const owner = comp.owner ? componentById.get(comp.owner) : undefined;
    const parentId = owner && L.boxes[owner.id] ? compCell(owner.id) : subCell(comp.subsystem);
    const parentBox = owner && L.boxes[owner.id] ? L.boxes[owner.id] : L.subs[comp.subsystem];
    const colors = STEREO_COLORS[stereoKey(comp.componentType)];
    const label = `${comp.name}\n«${comp.componentType}${comp.portalType ? '/' + comp.portalType : ''}»`;
    const style = isPattern
      ? `rounded=1;fillColor=${colors.fill};strokeColor=${colors.stroke};dashed=1;verticalAlign=top;fontStyle=1;container=1;collapsible=1;whiteSpace=wrap;`
      : `rounded=1;fillColor=${colors.fill};strokeColor=${colors.stroke};whiteSpace=wrap;fontSize=11;` +
        (comp.public ? 'strokeWidth=3;' : '');
    vertex(compCell(comp.id), parentId, label, style, box, parentBox);
  }

  let edgeN = 0;
  for (const edge of model.edges) {
    if (!L.boxes[edge.from] || !L.boxes[edge.to]) continue;
    const style = edge.cross
      ? 'edgeStyle=orthogonalEdgeStyle;rounded=1;strokeColor=#c26767;strokeWidth=2;endArrow=block;endFill=1;'
      : 'edgeStyle=orthogonalEdgeStyle;rounded=1;strokeColor=#8d97a5;endArrow=block;endFill=1;';
    cells.push(
      `        <mxCell id="edge_${edgeN++}" style="${escapeXml(style)}" edge="1" parent="1" ` +
      `source="${escapeXml(compCell(edge.from))}" target="${escapeXml(compCell(edge.to))}">` +
      `<mxGeometry relative="1" as="geometry"/></mxCell>`,
    );
  }

  return [
    `<mxfile host="wairon" agent="wairon" modified="${escapeXml(model.generatedAt)}">`,
    `  <diagram id="architecture" name="${escapeXml(model.system.name)} architecture">`,
    '    <mxGraphModel dx="1000" dy="700" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0">',
    '      <root>',
    '        <mxCell id="0"/>',
    '        <mxCell id="1" parent="0"/>',
    ...cells,
    '      </root>',
    '    </mxGraphModel>',
    '  </diagram>',
    '</mxfile>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Excalidraw
// ---------------------------------------------------------------------------

/** Deterministic pseudo-random seed per element id, so exports diff cleanly. */
function seedFor(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) || 1;
}

interface ExElement {
  [key: string]: unknown;
}

function baseElement(id: string, type: string, box: LayoutBox): ExElement {
  return {
    id,
    type,
    x: box.x,
    y: box.y,
    width: box.w,
    height: box.h,
    angle: 0,
    strokeColor: '#1f2328',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    seed: seedFor(id),
    version: 1,
    versionNonce: seedFor(id + '#n'),
    isDeleted: false,
    boundElements: [] as { id: string; type: string }[],
    updated: 1,
    link: null,
    locked: false,
  };
}

function boundLabel(
  rect: ExElement,
  text: string,
  opts: { fontSize: number; verticalAlign: 'top' | 'middle'; color?: string },
): ExElement {
  const id = `${rect.id}-label`;
  const label: ExElement = {
    ...baseElement(id, 'text', { x: (rect.x as number) + 8, y: (rect.y as number) + 6, w: (rect.width as number) - 16, h: 20 }),
    roundness: null,
    text,
    originalText: text,
    fontSize: opts.fontSize,
    fontFamily: 1,
    textAlign: 'center',
    verticalAlign: opts.verticalAlign,
    containerId: rect.id,
    autoResize: true,
    lineHeight: 1.25,
    strokeColor: opts.color ?? '#1f2328',
  };
  (rect.boundElements as { id: string; type: string }[]).push({ id, type: 'text' });
  return label;
}

export function generateExcalidrawScene(model: CanvasModel): string {
  const L = computeLayout(model, {});
  const elements: ExElement[] = [];
  const rectById = new Map<string, ExElement>();

  for (const sub of model.subsystems) {
    const box = L.subs[sub.id];
    if (!box) continue;
    const rect = {
      ...baseElement(`sub-${sub.id}`, 'rectangle', box),
      backgroundColor: '#ffffff',
      strokeColor: '#b6c0cc',
    };
    elements.push(rect);
    elements.push(boundLabel(rect, sub.name, { fontSize: 14, verticalAlign: 'top', color: '#1f2328' }));
  }

  for (const comp of model.components) {
    const box = L.boxes[comp.id];
    if (!box) continue;
    const isPattern = PATTERN_TYPES.has(comp.componentType) && comp.owns.length > 0;
    const colors = STEREO_COLORS[stereoKey(comp.componentType)];
    const rect = {
      ...baseElement(`comp-${comp.id}`, 'rectangle', box),
      backgroundColor: colors.fill,
      strokeColor: colors.stroke,
      strokeWidth: comp.public ? 3 : 1,
      strokeStyle: isPattern || stereoKey(comp.componentType) === 'pattern' ? 'dashed' : 'solid',
    };
    elements.push(rect);
    rectById.set(comp.id, rect);
    const label = `${comp.name}\n«${comp.componentType}${comp.portalType ? '/' + comp.portalType : ''}»`;
    elements.push(boundLabel(rect, label, {
      fontSize: 11,
      verticalAlign: isPattern ? 'top' : 'middle',
    }));
  }

  let edgeN = 0;
  for (const edge of model.edges) {
    const a = L.boxes[edge.from], b = L.boxes[edge.to];
    const src = rectById.get(edge.from), tgt = rectById.get(edge.to);
    if (!a || !b || !src || !tgt) continue;
    const leftToRight = b.x >= a.x + a.w;
    const start = leftToRight
      ? { x: a.x + a.w, y: a.y + a.h / 2 }
      : { x: a.x, y: a.y + a.h / 2 };
    const end = leftToRight
      ? { x: b.x, y: b.y + b.h / 2 }
      : { x: b.x + b.w, y: b.y + b.h / 2 };
    const id = `edge-${edgeN++}`;
    const arrow: ExElement = {
      ...baseElement(id, 'arrow', { x: start.x, y: start.y, w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) }),
      roundness: { type: 2 },
      backgroundColor: 'transparent',
      strokeColor: edge.cross ? '#c26767' : '#8d97a5',
      strokeWidth: edge.cross ? 2 : 1,
      points: [[0, 0], [end.x - start.x, end.y - start.y]],
      lastCommittedPoint: null,
      startBinding: { elementId: src.id, focus: 0, gap: 4 },
      endBinding: { elementId: tgt.id, focus: 0, gap: 4 },
      startArrowhead: null,
      endArrowhead: 'arrow',
    };
    (src.boundElements as { id: string; type: string }[]).push({ id, type: 'arrow' });
    (tgt.boundElements as { id: string; type: string }[]).push({ id, type: 'arrow' });
    elements.push(arrow);
  }

  const scene = {
    type: 'excalidraw',
    version: 2,
    source: 'wairon',
    elements,
    appState: {
      viewBackgroundColor: '#fafbfc',
      gridSize: null,
    },
    files: {},
  };
  return JSON.stringify(scene, null, 2);
}
