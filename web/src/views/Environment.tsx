import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import cytoscape from 'cytoscape';
import { get } from '../api';
import { AsyncView, useAsync } from '../ui';
import { useSettings } from '../settings';

/** One node of the environment (landscape) graph from /web/graph?tier=landscape. */
interface GNode {
  id: string;
  label: string;
  kind: string; // 'unit' | 'project' | 'interface'
  projectId?: string;
  status?: string;
}
interface GEdge {
  from: string;
  to: string;
  edgeKind: string; // 'hierarchy' | 'placement' | 'relation'
  label?: string;
}
interface Graph {
  nodes: GNode[];
  edges: GEdge[];
}

/** Read a theme token off the document root (the app's --wairon-* palette), with
 *  a dark fallback — so the environment graph follows the app theme. */
function palette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, f: string) => cs.getPropertyValue(n).trim() || f;
  return {
    accent: v('--wairon-primary', '#22ddff'),
    ink: v('--wairon-text', '#e8e8f0'),
    dim: v('--wairon-text-muted', '#9a9aab'),
    panel: v('--wairon-panel-bg', '#14141d'),
    border: v('--wairon-border', '#23232e'),
    borderStrong: v('--wairon-border-strong', 'rgba(34,221,255,0.5)'),
    ok: v('--wairon-ok', '#34d399'),
    warn: v('--wairon-warn', '#fbbf24'),
  };
}

/**
 * The environment canvas: the org hierarchy rendered as a graph — organization
 * units as compound frames (nested), projects as nodes inside their owning unit,
 * and cross-project relations as edges. Clicking a project opens its architecture
 * canvas. Data is the permission-filtered landscape graph. This is a NEW view for
 * a genuinely different graph than the per-project spec canvas.
 */
export function Environment() {
  const state = useAsync<Graph>(() => get('/web/graph?tier=landscape&level=1'), []);
  const { appearance } = useSettings();
  const nav = useNavigate();
  const ref = useRef<HTMLDivElement | null>(null);
  const g = state.data;

  useEffect(() => {
    const el = ref.current;
    if (!el || !g) return;
    const pal = palette();

    // Containment: a 'hierarchy' (unit→unit) or 'placement' (unit→project) edge
    // makes the source the parent of the target (compound nesting).
    const parentOf = new Map<string, string>();
    for (const e of g.edges) {
      if (e.edgeKind === 'hierarchy' || e.edgeKind === 'placement') parentOf.set(e.to, e.from);
    }
    const byId = new Map(g.nodes.map((n) => [n.id, n]));

    const els: cytoscape.ElementDefinition[] = [];
    for (const n of g.nodes) {
      const parent = parentOf.get(n.id);
      els.push({
        data: { id: n.id, label: n.label, projectId: n.projectId ?? '', ...(parent ? { parent } : {}) },
        classes: n.kind + (n.status ? ' status-' + n.status : ''),
      });
    }
    // Cross-project relation edges only (containment is expressed by nesting).
    let ei = 0;
    for (const e of g.edges) {
      if (e.edgeKind !== 'relation') continue;
      if (!byId.has(e.from) || !byId.has(e.to)) continue;
      els.push({ data: { id: 'r' + ei++, source: e.from, target: e.to, label: e.label || '' }, classes: 'rel' });
    }

    const cy = cytoscape({
      container: el,
      elements: els,
      minZoom: 0.15,
      maxZoom: 2.5,
      wheelSensitivity: 0.2,
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            color: pal.ink,
            'font-family': 'Inter, system-ui, sans-serif',
            'font-size': 12,
            'text-valign': 'center',
            'text-halign': 'center',
            'text-wrap': 'wrap',
            'text-max-width': '150px',
          },
        },
        // Unit compound frames.
        {
          selector: 'node.unit',
          style: {
            shape: 'round-rectangle',
            'background-color': pal.accent,
            'background-opacity': 0.05,
            'border-color': pal.borderStrong,
            'border-width': 1.4,
            color: pal.accent,
            'font-weight': 'bold',
            'text-valign': 'top',
            'text-margin-y': 6,
            padding: '18px',
          },
        },
        // Project nodes.
        {
          selector: 'node.project',
          style: {
            shape: 'round-rectangle',
            'background-color': pal.panel,
            'background-opacity': 0.9,
            'border-color': pal.border,
            'border-width': 1.6,
            width: 'label',
            height: 'label',
            padding: '12px',
          },
        },
        { selector: 'node.project:hover', style: { 'border-color': pal.accent, 'border-width': 2.4 } },
        { selector: 'node.status-ready, node.status-promoted', style: { 'border-color': pal.ok } },
        {
          selector: 'edge.rel',
          style: {
            'curve-style': 'bezier',
            width: 1.6,
            'line-color': pal.dim,
            'target-arrow-shape': 'triangle',
            'target-arrow-color': pal.dim,
            'arrow-scale': 0.9,
            label: 'data(label)',
            'font-size': 9,
            color: pal.dim,
            'text-background-color': pal.panel,
            'text-background-opacity': 0.85,
            'text-background-padding': '2px',
          },
        },
      ],
      layout: {
        name: 'cose',
        animate: false,
        fit: true,
        padding: 40,
        nodeDimensionsIncludeLabels: true,
        idealEdgeLength: 140,
        nodeRepulsion: 12000,
        nestingFactor: 1.2,
        gravity: 0.6,
        randomize: false,
      } as cytoscape.LayoutOptions,
    });

    cy.on('tap', 'node.project', (evt: cytoscape.EventObject) => {
      const pid = evt.target.data('projectId') as string;
      if (pid) nav('/?project=' + encodeURIComponent(pid));
    });

    return () => cy.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g, appearance]);

  return (
    <div className="env-view">
      <div className="canvas-bar">
        <strong>Environment</strong>
        <span className="hint">Organization units and their projects — click a project to open its canvas.</span>
      </div>
      <AsyncView state={state}>
        {(d) =>
          d.nodes.length === 0 ? (
            <div className="empty-state">No organization units or projects in your scope yet.</div>
          ) : (
            <div ref={ref} className="env-canvas" />
          )
        }
      </AsyncView>
    </div>
  );
}
