/**
 * Framework-agnostic architecture-canvas renderer.
 *
 * `mountCanvas` builds a cytoscape graph from a {@link CanvasModel} and renders
 * the component ARCHITECTURE view — the first parity slice of the in-React
 * canvas that replaces iframing the server-generated HTML. It mirrors the visual
 * language of the standalone renderer in `src/core/canvas.ts` (do NOT edit that
 * file): components are nodes coloured by stereotype, subsystems are compound
 * parent frames, `owns` are dashed containment edges, `dependsOn` are solid
 * edges (thicker + red when they cross a subsystem boundary), and public
 * components carry a thick highlighted border.
 *
 * No React here on purpose: this is the shared, reusable seam. `applyModel`
 * rebuilds the elements in place — the clean re-apply point future WebSocket
 * scope-slice patches will drive.
 */
import cytoscape from 'cytoscape';
import type { CanvasComponent, CanvasModel } from './model';

/** Component types treated as composable "patterns" (mirrors PATTERN_TYPES /
 *  `stereoClass` in src/core/canvas.ts + src/core/diagram.ts). */
const PATTERN_TYPES = new Set(['Repository', 'Gateway', 'FeatureComponent', 'RouterComponent']);

type Stereo = 'entry' | 'logic' | 'data' | 'adapter' | 'pattern';

/** Map a component type to its stereotype group (colour/shape bucket). */
function stereoOf(componentType: string): Stereo {
  if (componentType === 'Portal' || componentType === 'Observer') return 'entry';
  if (componentType === 'Store' || componentType === 'Index' || componentType === 'Registry') return 'data';
  if (componentType === 'Adapter') return 'adapter';
  if (PATTERN_TYPES.has(componentType)) return 'pattern';
  return 'logic';
}

export interface CanvasOptions {
  /** Fired when a component node is selected (null when the selection clears). */
  onSelect?: (component: CanvasComponent | null) => void;
}

export interface CanvasHandle {
  /** The underlying cytoscape core (escape hatch for advanced callers). */
  readonly cy: cytoscape.Core;
  /** Fit the whole graph into view. */
  fit(): void;
  /** Rebuild the graph from a fresh model (the WS-patch re-apply seam). */
  applyModel(next: CanvasModel): void;
  /** Highlight nodes whose name/id contains `query` and dim the rest. */
  setQuery(query: string): void;
  /** Programmatically select a component node by id (null clears). */
  select(id: string | null): void;
  /** Tear down the cytoscape instance and release the container. */
  destroy(): void;
}

const FIT_PADDING = 42;

/** Resolve a design-token colour from the container, falling back to the SYW
 *  dark palette when the CSS variable is unset or still an unresolved `var()`. */
function readPalette(el: HTMLElement) {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string): string => {
    const raw = cs.getPropertyValue(name).trim();
    return raw && !raw.includes('var(') ? raw : fallback;
  };
  return {
    bg: v('--bg', '#0a0a0f'),
    panel: v('--panel', '#14141d'),
    border: v('--border', '#23232e'),
    borderStrong: v('--border-strong', 'rgba(34, 221, 255, 0.5)'),
    ink: v('--ink', '#e8e8f0'),
    inkDim: v('--ink-dim', '#9a9aab'),
    accent: v('--accent', '#22ddff'),
    purple: v('--accent-purple', '#8b5cf6'),
    warn: v('--warn', '#fbbf24'),
    ok: v('--ok', '#34d399'),
    bad: v('--bad', '#f43f5e'),
  };
}

type Palette = ReturnType<typeof readPalette>;

/** Stroke (and tint) colour per stereotype, derived from theme tokens. */
function stereoColor(pal: Palette, s: Stereo): string {
  switch (s) {
    case 'entry': return pal.accent;
    case 'logic': return pal.purple;
    case 'data': return pal.warn;
    case 'adapter': return pal.ok;
    case 'pattern': return pal.inkDim;
  }
}

/** Build the cytoscape stylesheet for the architecture view. */
function buildStyle(pal: Palette): cytoscape.StylesheetStyle[] {
  const stereoStyle = (s: Stereo): cytoscape.StylesheetStyle => ({
    selector: `.stereo-${s}`,
    style: {
      'background-color': stereoColor(pal, s),
      'border-color': stereoColor(pal, s),
    },
  });

  const frameStyle: cytoscape.Css.Node = {
    'background-color': pal.accent,
    'background-opacity': 0.05,
    'border-color': pal.borderStrong,
    'border-width': 1.4,
    'border-style': 'solid',
    shape: 'round-rectangle',
    color: pal.accent,
    label: 'data(label)',
    'font-size': 12.5,
    'font-weight': 'bold',
    'text-valign': 'top',
    'text-halign': 'center',
    'text-margin-y': 4,
  };

  return [
    {
      selector: 'node',
      style: {
        shape: 'round-rectangle',
        width: 'label',
        height: 'label',
        'padding-left': '14px',
        'padding-right': '14px',
        'padding-top': '10px',
        'padding-bottom': '10px',
        label: 'data(label)',
        'text-wrap': 'wrap',
        'text-max-width': '150px',
        'font-family': 'Inter, system-ui, sans-serif',
        'font-size': 11,
        color: pal.ink,
        'text-valign': 'center',
        'text-halign': 'center',
        'border-width': 1.6,
        'background-opacity': 0.16,
      },
    },
    stereoStyle('entry'),
    stereoStyle('logic'),
    stereoStyle('data'),
    stereoStyle('adapter'),
    { selector: '.stereo-pattern', style: { 'background-color': pal.inkDim, 'border-color': pal.inkDim, 'border-style': 'dashed' } },
    { selector: 'node.public', style: { 'border-width': 3.5, 'background-opacity': 0.24 } },
    // Compound subsystem frames.
    { selector: '$node > node', style: Object.assign({}, frameStyle, { padding: 16 }) },
    { selector: 'node.frame', style: Object.assign({}, frameStyle, { padding: 16 }) },
    // Edges — base dependency link.
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        width: 1.7,
        'line-color': pal.inkDim,
        'target-arrow-shape': 'triangle',
        'target-arrow-color': pal.inkDim,
        'arrow-scale': 0.9,
        opacity: 0.9,
      },
    },
    // `owns` containment — dashed.
    {
      selector: 'edge.owns',
      style: {
        'line-style': 'dashed',
        'line-color': pal.border,
        'target-arrow-color': pal.border,
        width: 1.3,
        opacity: 0.8,
      },
    },
    // Cross-subsystem dependency — thicker + red.
    {
      selector: 'edge.cross',
      style: {
        'line-color': pal.bad,
        'target-arrow-color': pal.bad,
        width: 2.7,
        opacity: 1,
      },
    },
    // Selection + search states.
    { selector: 'node.sel', style: { 'overlay-color': pal.accent, 'overlay-opacity': 0.34, 'overlay-padding': 6 } },
    { selector: '.match', style: { 'border-color': pal.accent, 'border-width': 3 } },
    { selector: '.dim', style: { opacity: 0.12 } },
  ];
}

/** Deterministic, collision-free element id maker. */
function makeIdGen() {
  let n = 0;
  return () => `e${n++}`;
}

/** Project the model into cytoscape elements for the architecture view:
 *  subsystem frames (compound parents), component nodes, owns + dependsOn edges. */
function buildElements(model: CanvasModel): cytoscape.ElementDefinition[] {
  const els: cytoscape.ElementDefinition[] = [];
  const eid = makeIdGen();

  const componentIds = new Set(model.components.map((c) => c.id));
  const subsystemName = new Map(model.subsystems.map((s) => [s.id, s.name] as const));

  // Every subsystem a component actually lives in needs a frame; pull in the
  // full `::` ancestor chain so nested frames have their parents present.
  const frameIds = new Set<string>();
  const addFrameChain = (subId: string): void => {
    let cur: string | undefined = subId;
    while (cur && !frameIds.has(cur)) {
      frameIds.add(cur);
      const cut = cur.lastIndexOf('::');
      cur = cut >= 0 ? cur.slice(0, cut) : undefined;
    }
  };
  for (const c of model.components) addFrameChain(c.subsystem);

  // Frame (compound parent) nodes, each nested under its parent subsystem frame.
  for (const id of frameIds) {
    const cut = id.lastIndexOf('::');
    const parent = cut >= 0 ? id.slice(0, cut) : undefined;
    els.push({
      data: {
        id: `frame:${id}`,
        label: subsystemName.get(id) ?? id.split('::').pop() ?? id,
        ...(parent ? { parent: `frame:${parent}` } : {}),
      },
      classes: 'frame',
    });
  }

  // Component nodes.
  for (const c of model.components) {
    els.push({
      data: {
        id: c.id,
        label: `${c.name}\n«${c.componentType}»`,
        parent: `frame:${c.subsystem}`,
      },
      classes: `comp stereo-${stereoOf(c.componentType)}${c.public ? ' public' : ''}`,
    });
  }

  // `owns` containment edges (dashed) — both endpoints are components.
  for (const c of model.components) {
    for (const memberId of c.owns) {
      if (!componentIds.has(memberId)) continue;
      els.push({ data: { id: eid(), source: c.id, target: memberId }, classes: 'owns' });
    }
  }

  // `dependsOn` edges (solid; red + thick when crossing a subsystem boundary).
  for (const e of model.edges) {
    if (!componentIds.has(e.from) || !componentIds.has(e.to)) continue;
    els.push({ data: { id: eid(), source: e.from, target: e.to }, classes: `depends${e.cross ? ' cross' : ''}` });
  }

  return els;
}

/**
 * Mount the architecture canvas into `container`. The container should be a
 * sized block element; the caller owns its lifecycle and must call
 * `handle.destroy()` on unmount.
 */
export function mountCanvas(container: HTMLElement, model: CanvasModel, opts: CanvasOptions = {}): CanvasHandle {
  const pal = readPalette(container);

  const cy = cytoscape({
    container,
    elements: buildElements(model),
    style: buildStyle(pal),
    layout: { name: 'preset' },
    minZoom: 0.1,
    maxZoom: 3,
    wheelSensitivity: 0.2,
    boxSelectionEnabled: false,
    autounselectify: true,
  });

  // Component lookup for detail callbacks + selection state.
  let byId = new Map<string, CanvasComponent>(model.components.map((c) => [c.id, c]));
  let query = '';
  let selectedId: string | null = null;

  function runLayout(): void {
    const layout = cy.layout({
      name: 'cose',
      animate: false,
      fit: true,
      padding: FIT_PADDING,
      nodeDimensionsIncludeLabels: true,
      idealEdgeLength: 120,
      nodeRepulsion: 9000,
      nestingFactor: 1.1,
      gravity: 0.7,
      componentSpacing: 120,
      randomize: false,
    } as cytoscape.LayoutOptions);
    cy.one('layoutstop', () => cy.fit(undefined, FIT_PADDING));
    layout.run();
  }

  function applyQuery(): void {
    cy.batch(() => {
      cy.elements().removeClass('dim match');
      const q = query.trim().toLowerCase();
      if (!q) return;
      const comps = cy.nodes('.comp');
      comps.forEach((n) => {
        const c = byId.get(n.id());
        const hit = !!c && (c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
        n.addClass(hit ? 'match' : 'dim');
      });
      // A frame stays lit if any of its descendant components matched.
      cy.nodes('.frame').forEach((f) => {
        if (f.descendants('.match').length === 0) f.addClass('dim');
      });
      // Dim an edge whenever either endpoint is dimmed.
      cy.edges().forEach((e) => {
        if (e.source().hasClass('dim') || e.target().hasClass('dim')) e.addClass('dim');
      });
    });
  }

  function applySelection(): void {
    cy.nodes('.sel').removeClass('sel');
    if (selectedId) cy.getElementById(selectedId).addClass('sel');
  }

  cy.on('tap', 'node.comp', (evt: cytoscape.EventObject) => {
    const id: string = evt.target.id();
    selectedId = id;
    applySelection();
    opts.onSelect?.(byId.get(id) ?? null);
  });
  cy.on('tap', (evt: cytoscape.EventObject) => {
    if (evt.target === cy) {
      selectedId = null;
      applySelection();
      opts.onSelect?.(null);
    }
  });

  runLayout();

  return {
    cy,
    fit: () => cy.fit(undefined, FIT_PADDING),
    applyModel: (next: CanvasModel) => {
      byId = new Map(next.components.map((c) => [c.id, c]));
      cy.batch(() => {
        cy.elements().remove();
        cy.add(buildElements(next));
      });
      // Preserve selection only if the node still exists.
      if (selectedId && cy.getElementById(selectedId).empty()) {
        selectedId = null;
        opts.onSelect?.(null);
      }
      runLayout();
      applyQuery();
      applySelection();
    },
    setQuery: (q: string) => {
      query = q;
      applyQuery();
    },
    select: (id: string | null) => {
      selectedId = id;
      applySelection();
      opts.onSelect?.(id ? byId.get(id) ?? null : null);
    },
    destroy: () => cy.destroy(),
  };
}
