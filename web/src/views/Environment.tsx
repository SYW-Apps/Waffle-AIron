import { useEffect, useRef } from 'react';
import { get } from '../api';
import { AsyncView, useAsync } from '../ui';
import { useSettings } from '../settings';
import { resolveMode } from '../theme/themes';
import { mountCanvas, type CanvasHandle } from '../canvas/engine';

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

/**
 * Adapt the landscape graph into the SAME CanvasModel the per-project canvas
 * renders — so the environment looks and drills EXACTLY like the component view:
 * organization units → subsystem frames (nested via their qualified dot-path,
 * mapped onto the engine's `::` nesting), projects → nodes inside their owning
 * unit (or an "(unassigned)" frame when not placed), cross-project relations →
 * dependency edges. Reuses the classic engine — not a second renderer.
 */
function landscapeToCanvasModel(g: Graph): unknown {
  const toColons = (id: string) => id.replace(/\./g, '::');
  const parentUnit = new Map<string, string>(); // projectNodeId → unit id (from placement edges)
  for (const e of g.edges) if (e.edgeKind === 'placement') parentUnit.set(e.to, e.from);

  const units = g.nodes.filter((n) => n.kind === 'unit');
  const projects = g.nodes.filter((n) => n.kind === 'project');
  const unplaced = projects.some((p) => !parentUnit.get(p.id));

  const subsystems = units.map((u) => ({
    id: toColons(u.id),
    name: u.label,
    description: 'Organization unit',
    trustedLinks: [] as { subsystem: string; reason: string }[],
  }));
  if (unplaced) {
    subsystems.push({ id: '__unassigned__', name: '(unassigned)', description: 'Projects not placed in a unit', trustedLinks: [] });
  }

  // Relation edges (project → project) become dependsOn + model edges.
  const depsOf = new Map<string, string[]>();
  for (const e of g.edges) {
    if (e.edgeKind !== 'relation') continue;
    (depsOf.get(e.from) ?? depsOf.set(e.from, []).get(e.from)!).push(e.to);
  }

  const components = projects.map((p) => {
    const unit = parentUnit.get(p.id);
    return {
      id: p.id,
      name: p.label,
      description: p.status ? 'Project · ' + p.status : 'Project',
      subsystem: unit ? toColons(unit) : '__unassigned__',
      componentType: 'project',
      public: false,
      owns: [] as string[],
      dependsOn: depsOf.get(p.id) ?? [],
      interfaces: [] as unknown[],
      narratives: [] as unknown[],
      intents: [] as unknown[],
    };
  });

  const projById = new Map(projects.map((p) => [p.id, p]));
  const edges: { from: string; to: string; cross: boolean }[] = [];
  for (const e of g.edges) {
    if (e.edgeKind !== 'relation') continue;
    if (!projById.has(e.from) || !projById.has(e.to)) continue;
    edges.push({ from: e.from, to: e.to, cross: parentUnit.get(e.from) !== parentUnit.get(e.to) });
  }

  return {
    system: { name: 'Environment', diagram: { defaultView: 'architecture', showDatabases: false } },
    generatedAt: new Date().toISOString(),
    subsystems,
    components,
    edges,
    types: [],
    typeEdges: [],
    dataEdges: [],
    issues: [],
  };
}

/**
 * The environment canvas: the org hierarchy rendered with the SAME engine as the
 * per-project canvas (units as frames, projects as nodes, drill-down, proper
 * layout) via a landscape→CanvasModel adapter. Data is the permission-filtered
 * landscape graph.
 */
export function Environment() {
  const state = useAsync<Graph>(() => get('/web/graph?tier=landscape&level=1'), []);
  const { appearance } = useSettings();
  const canvasTheme = resolveMode(appearance) === 'light' ? 'light' : 'syw';

  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<CanvasHandle | null>(null);
  const g = state.data;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !g || g.nodes.length === 0) return;
    const handle = mountCanvas(host, landscapeToCanvasModel(g), { shadow: true, theme: canvasTheme, embed: true });
    handleRef.current = handle;
    return () => {
      handle.destroy();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g]);

  useEffect(() => {
    handleRef.current?.setTheme(canvasTheme);
  }, [canvasTheme]);

  return (
    <AsyncView state={state}>
      {(d) =>
        d.nodes.length === 0 ? (
          <div className="empty-state">No organization units or projects in your scope yet.</div>
        ) : (
          <div ref={hostRef} className="canvas-host" />
        )
      }
    </AsyncView>
  );
}
