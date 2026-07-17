import { useSearchParams } from 'react-router-dom';
import { CanvasView } from './CanvasView';
import { Environment } from './Environment';

/**
 * The canvas navigator. With no ?project= it shows the ENVIRONMENT — the org
 * hierarchy (units → projects) — and clicking a project drills into its
 * architecture canvas (setting ?project=, a shareable link). A back control
 * returns to the environment. There is no separate project selector: you
 * navigate by clicking in the canvas itself.
 */
export function Home() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('project') ?? '';

  if (!selected) return <Environment />;

  return (
    <div className="canvas-view">
      <div className="canvas-bar">
        <button className="btn btn-ghost btn-sm" onClick={() => setParams({})} title="Back to the environment">
          ← Environment
        </button>
        <span className="crumb-sep">/</span>
        <strong>{selected}</strong>
      </div>
      <CanvasView key={selected} projectId={selected} />
    </div>
  );
}
