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
  // A unit node id is 'unit:<qualified.dot.id>'; map the dot-path onto the
  // engine's '::' subsystem nesting but KEEP the 'unit:' prefix as an id
  // namespace — subsystem frames and project components share one cytoscape id
  // space, so a unit and a project with the same name (the demo seed's 'demo'
  // unit + 'demo' project) would otherwise collide and silently drop the
  // project node from the root view, leaving an "empty" unit frame.
  const toColons = (unitNodeId: string) => unitNodeId.replace(/\./g, '::');
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
export function Environment({ initialUnitRoute = '' }: { initialUnitRoute?: string }) {
  const state = useAsync<Graph>(() => get('/web/graph?tier=landscape&level=1'), [], ['landscape']);
  const { themeId, appearance } = useSettings();
  const nav = useNavigate();
  const canvasTheme = engineTheme(appearance);
  const canvasVars = useMemo(() => engineVars(themeId, appearance), [themeId, appearance]);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<CanvasHandle | null>(null);
  const g = state.data;

  // The UNIT namespace lives in the URL under /canvas/<unit>/<subunit>… (the CLEAN
  // dot-path flattened to '/'). The engine addresses the same frames as subsystem
  // routes with a leading 'unit' segment (a unit node id 'unit:a.b' → engine route
  // 'unit/a/b'), so we translate between the two spaces here. Mirrors CanvasView's
  // Stage-J URL↔engine wiring, one namespace level up.
  // Inverse of the onViewChange serialization below, so unit paths AND the two
  // non-unit frames (the synthetic '(unassigned)' bucket, and the empty Types/
  // Databases mode tabs) round-trip on reload/deep-link — not just real units.
  const toEngineRoute = (clean: string) => {
    if (!clean) return '';
    if (clean === 'unassigned') return '__unassigned__';
    const head = clean.split('/')[0];
    if (head === 'types' || head === 'databases') return clean; // engine mode routes pass through
    return 'unit/' + clean;
  };
  // The engine route we last synced with the canvas (seeded at mount, pushed from
  // an in-canvas drill, or applied from the URL) — skips redundant openRoute calls
  // and history pushes, exactly like CanvasView.lastRouteRef.
  const lastUnitRouteRef = useRef<string>(toEngineRoute(initialUnitRoute));
  // Freshest initialUnitRoute reachable from the mount-only engine callback without
  // remounting the graph on every unit-route change.
  const initialUnitRouteRef = useRef<string>(initialUnitRoute);
  initialUnitRouteRef.current = initialUnitRoute;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !g || g.nodes.length === 0) return;
    lastUnitRouteRef.current = toEngineRoute(initialUnitRouteRef.current);
    const kindOf = new Map(g.nodes.map((n) => [n.id, n.kind]));
    const realProjectId = (n: GNode) => n.projectId ?? n.id.replace(/^project:/, '');
    // Every real project id (used to tell a unit route from a project drill).
    const projectIds = new Set(g.nodes.filter((n) => n.kind === 'project').map(realProjectId));
    // Project node id → its owning unit node id (prefer the owner placement).
    const unitOfProjectNode = new Map<string, string>();
    for (const e of g.edges) {
      if (kindOf.get(e.from) === 'unit' && kindOf.get(e.to) === 'project') {
        if (!unitOfProjectNode.has(e.to) || e.edgeKind === 'owns') unitOfProjectNode.set(e.to, e.from);
      }
    }
    // Real project id → owning unit DOT-path ('unit:a.b.c' → 'a.b.c'), for stamping
    // the unit ancestry into a project's URL when it is opened.
    const unitDotOfProject = new Map<string, string>();
    for (const n of g.nodes) {
      if (n.kind !== 'project') continue;
      const owner = unitOfProjectNode.get(n.id);
      if (owner) unitDotOfProject.set(realProjectId(n), owner.replace(/^unit:/, ''));
    }
    // Double-clicking a project node (a "component" in the adapted model) opens
    // that project's canvas.
    // Only actionable projects navigate into their spec canvas (the server only
    // ships actionable projects today — belt and braces should that change).
    const openable = new Set(
      g.nodes.filter((n) => n.kind === 'project' && n.actionable !== false).map(realProjectId),
    );
    const handle = mountCanvas(host, landscapeToCanvasModel(g), {
      shadow: true,
      theme: canvasTheme,
      vars: canvasVars,
      embed: true,
      // Seed the initial view from the URL unit path so a deep link renders its
      // scope immediately (no root-first flash).
      initialRoute: toEngineRoute(initialUnitRouteRef.current),
      // Push in-canvas unit navigation into the URL path. A project drill is NOT a
      // unit route — it is handled by onNodeOpen — so ignore an engine route that
      // starts with a known project id.
      onViewChange: (r: string) => {
        if (projectIds.has(r.split('/')[0])) return;
        let clean = r;
        if (clean === 'unit') clean = '';
        else if (clean.startsWith('unit/')) clean = clean.slice('unit/'.length);
        // The synthetic unplaced frame serializes as '__unassigned__'.
        if (clean === '__unassigned__') clean = 'unassigned';
        const target = '/canvas' + (clean ? '/' + clean : '');
        lastUnitRouteRef.current = r;
        if (target !== window.location.pathname) nav(target);
      },
      onNodeOpen: (_kind: string, id: string) => {
        if (!openable.has(id)) return;
        const dot = unitDotOfProject.get(id);
        const prefix = dot ? dot.split('.').map(encodeURIComponent).join('/') + '/' : '';
        nav('/canvas/' + prefix + encodeURIComponent(id));
      },
    });
    handleRef.current = handle;
    return () => {
      handle.destroy();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g]);

  // When the unit route changes from OUTSIDE the engine (browser back/forward, an
  // external link), drive the mounted engine to it. Skipped when it already matches
  // what the engine reported (guarded by lastUnitRouteRef, like CanvasView) so the
  // mount seed and the onViewChange echo do not double-fire.
  useEffect(() => {
    const engineRoute = toEngineRoute(initialUnitRoute);
    if (engineRoute === lastUnitRouteRef.current) return;
    lastUnitRouteRef.current = engineRoute;
    handleRef.current?.openRoute(engineRoute);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUnitRoute]);

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
