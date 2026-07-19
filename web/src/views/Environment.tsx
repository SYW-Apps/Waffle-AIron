import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../api';
import { AsyncView, useAsync } from '../ui';
import { useSettings } from '../settings';
import { engineTheme, engineVars } from '../theme/canvasBridge';
import { mountCanvas, type CanvasHandle } from '../canvas/engine';

interface GNode {
  id: string;
  label: string;
  kind: string; // 'unit' | 'project' | 'interface'
  projectId?: string;
  status?: string;
  /** False on an ancestor breadcrumb shown read-only for navigation only. */
  actionable?: boolean;
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
  // Classify edges by their ENDPOINT KINDS (robust) rather than the edgeKind
  // string, which the landscape sets from the placement role ('owns'/'shared_with'
  // /'contains') and relation kind — not literal 'placement'/'relation'.
  const kindOf = new Map(g.nodes.map((n) => [n.id, n.kind]));
  // A unit node id is 'unit:<qualified.dot.id>'; strip the prefix and map the
  // dot-path onto the engine's '::' subsystem nesting.
  const toColons = (unitNodeId: string) => unitNodeId.replace(/^unit:/, '').replace(/\./g, '::');
  const realProjectId = (n: GNode) => n.projectId ?? n.id.replace(/^project:/, '');

  const units = g.nodes.filter((n) => n.kind === 'unit');
  const projects = g.nodes.filter((n) => n.kind === 'project');
  const projById = new Map(projects.map((p) => [p.id, p]));

  // Project node id → its owning unit node id (a unit→project edge; prefer the
  // owner placement, edgeKind 'owns').
  const unitOfProject = new Map<string, string>();
  for (const e of g.edges) {
    if (kindOf.get(e.from) === 'unit' && kindOf.get(e.to) === 'project') {
      if (!unitOfProject.has(e.to) || e.edgeKind === 'owns') unitOfProject.set(e.to, e.from);
    }
  }

  // A breadcrumb ancestor (actionable === false) is included only so the
  // hierarchy stays navigable — label and describe it as browse-only.
  const subsystems = units.map((u) => ({
    id: toColons(u.id),
    name: u.actionable === false ? u.label + ' ◇' : u.label,
    description:
      u.actionable === false
        ? 'Organization unit (browse-only — shown as the path to a scope you can act on)'
        : 'Organization unit',
    trustedLinks: [] as { subsystem: string; reason: string }[],
  }));
  const unplaced = projects.some((p) => !unitOfProject.has(p.id));
  if (unplaced) {
    subsystems.push({ id: '__unassigned__', name: '(unassigned)', description: 'Projects not placed in a unit', trustedLinks: [] });
  }

  // Relations = project→project edges (any edgeKind). Map to real project ids.
  const depsOf = new Map<string, string[]>();
  const edges: { from: string; to: string; cross: boolean }[] = [];
  for (const e of g.edges) {
    if (kindOf.get(e.from) !== 'project' || kindOf.get(e.to) !== 'project') continue;
    const from = realProjectId(projById.get(e.from)!);
    const to = realProjectId(projById.get(e.to)!);
    (depsOf.get(from) ?? depsOf.set(from, []).get(from)!).push(to);
    edges.push({ from, to, cross: unitOfProject.get(e.from) !== unitOfProject.get(e.to) });
  }

  const components = projects.map((p) => {
    const unitNode = unitOfProject.get(p.id);
    const pid = realProjectId(p);
    return {
      id: pid,
      name: p.label,
      description: p.status ? 'Project · ' + p.status : 'Project',
      subsystem: unitNode ? toColons(unitNode) : '__unassigned__',
      componentType: 'project',
      public: false,
      owns: [] as string[],
      dependsOn: depsOf.get(pid) ?? [],
      interfaces: [] as unknown[],
      narratives: [] as unknown[],
      intents: [] as unknown[],
    };
  });

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
  const state = useAsync<Graph>(() => get('/web/graph?tier=landscape&level=1'), [], ['landscape']);
  const { themeId, appearance } = useSettings();
  const nav = useNavigate();
  const canvasTheme = engineTheme(appearance);
  const canvasVars = useMemo(() => engineVars(themeId, appearance), [themeId, appearance]);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<CanvasHandle | null>(null);
  const g = state.data;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !g || g.nodes.length === 0) return;
    // Double-clicking a project node (a "component" in the adapted model) opens
    // that project's canvas.
    // Only actionable projects navigate into their spec canvas (the server only
    // ships actionable projects today — belt and braces should that change).
    const openable = new Set(
      g.nodes.filter((n) => n.kind === 'project' && n.actionable !== false).map((n) => n.projectId ?? n.id.replace(/^project:/, '')),
    );
    const handle = mountCanvas(host, landscapeToCanvasModel(g), {
      shadow: true,
      theme: canvasTheme,
      vars: canvasVars,
      embed: true,
      onNodeOpen: (_kind: string, id: string) => {
        if (openable.has(id)) nav('/?project=' + encodeURIComponent(id));
      },
    });
    handleRef.current = handle;
    return () => {
      handle.destroy();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g]);

  useEffect(() => {
    handleRef.current?.setTheme(canvasTheme, canvasVars);
  }, [canvasTheme, canvasVars]);

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
