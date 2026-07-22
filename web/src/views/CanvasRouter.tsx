import { useNavigate, useParams } from 'react-router-dom';
import { get } from '../api';
import { AsyncView, useAsync } from '../ui';
import { CanvasView } from './CanvasView';
import { Environment } from './Environment';

interface GNode {
  id: string;
  label: string;
  kind: string; // 'unit' | 'project' | 'interface'
  projectId?: string;
  actionable?: boolean;
}
interface GEdge {
  from: string;
  to: string;
  edgeKind: string;
}
interface Graph {
  nodes: GNode[];
  edges: GEdge[];
}

/**
 * The unified canvas router at /canvas/*. The splat is ONE namespace path that
 * folds the ORG-UNIT hierarchy and the per-project drill-down into a single URL:
 *
 *   /canvas/<unit>/<subunit>…/<project>/<subsystem>…/<component>
 *
 * The org units are a `.`-dotted hierarchy flattened to `/` segments; the project
 * is the boundary between "environment" (unit) space and "component" (in-project)
 * space. We resolve that boundary by finding the FIRST segment that names a known
 * project:
 *   - before it  → the owning-unit path prefix (drives the "← Environment" back
 *     target + is echoed back into per-project URLs so ancestry is never lost);
 *   - it         → the project id (mounts the per-project canvas);
 *   - after it   → the in-project engine route (namespace / types / databases).
 * No project segment at all → a pure unit path (or empty), which scopes the
 * Environment canvas to that unit.
 *
 * COLLISION NOTE: if a unit and a project share an id at the same depth (e.g. the
 * demo seed's 'demo' unit + 'demo' project), first-project-id-wins resolves to the
 * PROJECT — the like-named unit is not reachable as a pure-unit URL past that
 * point. Accepted: the project canvas is the more specific, more useful target.
 */
export function CanvasRouter() {
  const splat = useParams()['*'] ?? '';
  const segments = splat.split('/').filter(Boolean).map(decodeURIComponent);
  const navigate = useNavigate();
  const state = useAsync<Graph>(() => get('/web/graph?tier=landscape&level=1'), [], ['landscape']);

  return (
    <AsyncView state={state}>
      {(g) => {
        const realProjectId = (n: GNode) => n.projectId ?? n.id.replace(/^project:/, '');
        const projectIds = new Set(g.nodes.filter((n) => n.kind === 'project').map(realProjectId));

        // The project boundary: the first segment that names a known project.
        let boundary = -1;
        for (let i = 0; i < segments.length; i++) {
          if (projectIds.has(segments[i])) {
            boundary = i;
            break;
          }
        }

        if (boundary === -1) {
          // Pure unit path (or empty) → the environment scoped to that unit.
          return <Environment initialUnitRoute={segments.join('/')} />;
        }

        const unitPrefix = segments.slice(0, boundary).join('/');
        const projectId = segments[boundary];
        const internal = segments.slice(boundary + 1).join('/');
        return (
          <div className="canvas-view">
            <div className="canvas-bar">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => navigate('/canvas' + (unitPrefix ? '/' + unitPrefix : ''))}
                title="Back to the environment"
              >
                ← Environment
              </button>
              <span className="crumb-sep">/</span>
              <strong>{projectId}</strong>
            </div>
            <CanvasView key={projectId} projectId={projectId} route={internal} unitPrefix={unitPrefix} />
          </div>
        );
      }}
    </AsyncView>
  );
}
