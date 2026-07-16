import { useEffect, useRef, useState } from 'react';
import { get } from '../api';
import { Badge, Button, EmptyState, ErrorNote, Spinner, TextInput, useAsync } from '../ui';
import type { CanvasComponent, CanvasModel } from '../canvas/model';
import { mountCanvas, type CanvasHandle } from '../canvas/renderer';

/**
 * In-React architecture canvas (the "Beta" renderer). Fetches a project's
 * {@link CanvasModel} from `/web/canvas-model` and mounts the shared,
 * framework-agnostic cytoscape renderer directly — no iframe. Selecting a node
 * opens a details side panel; the search box highlights matching components and
 * dims the rest. The cytoscape instance is destroyed on unmount / project
 * change. This is the first parity slice: architecture view only.
 */
export function CanvasView({ projectId }: { projectId: string }) {
  const state = useAsync<CanvasModel>(
    () => get<CanvasModel>('/web/canvas-model?projectId=' + encodeURIComponent(projectId)),
    [projectId],
  );

  const stageRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<CanvasHandle | null>(null);
  const [selected, setSelected] = useState<CanvasComponent | null>(null);
  const [query, setQuery] = useState('');

  const model = state.data;
  const isEmpty = !!model && model.components.length === 0;
  const mounted = !!model && !isEmpty;

  // Mount / remount the renderer whenever a fresh model arrives (new project or
  // reload). Cleanup destroys the cytoscape instance and clears selection.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !model || model.components.length === 0) return;

    const handle = mountCanvas(el, model, { onSelect: setSelected });
    handleRef.current = handle;

    // Keep the graph fitted when the stage resizes (e.g. the details panel opens).
    const ro = new ResizeObserver(() => handle.cy.resize());
    ro.observe(el);

    return () => {
      ro.disconnect();
      handle.destroy();
      handleRef.current = null;
      setSelected(null);
    };
  }, [model]);

  // Push the live search query into the renderer.
  useEffect(() => {
    handleRef.current?.setQuery(query);
  }, [query]);

  function clearSelection() {
    handleRef.current?.select(null);
    setSelected(null);
  }

  return (
    <div className="beta-canvas">
      <div className="beta-canvas-stage">
        <div ref={stageRef} className="beta-canvas-cy" />

        {mounted && (
          <div className="beta-canvas-toolbar">
            <div className="beta-canvas-search">
              <TextInput value={query} onChange={setQuery} placeholder="Search components…" />
            </div>
            <span className="spacer" />
            <Button size="sm" variant="ghost" onClick={() => handleRef.current?.fit()} title="Fit graph to view">
              Fit
            </Button>
          </div>
        )}

        {state.loading && model === undefined && (
          <div className="beta-canvas-overlay">
            <Spinner />
          </div>
        )}
        {state.error && model === undefined && (
          <div className="beta-canvas-overlay">
            <ErrorNote onRetry={state.reload}>{state.error}</ErrorNote>
          </div>
        )}
        {isEmpty && (
          <div className="beta-canvas-overlay">
            <EmptyState>This project has no components yet — design its spec tree to see the canvas.</EmptyState>
          </div>
        )}
      </div>

      {selected && <DetailsPanel component={selected} onClose={clearSelection} />}
    </div>
  );
}

/** Right-hand side panel describing the selected component. */
function DetailsPanel({ component, onClose }: { component: CanvasComponent; onClose: () => void }) {
  const c = component;
  return (
    <aside className="beta-details">
      <div className="beta-details-head">
        <div className="cell-stack">
          <h3>{c.name}</h3>
          <span className="beta-stereo">«{c.componentType}»</span>
        </div>
        <button className="icon-btn" aria-label="Close details" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="chip-row beta-details-badges">
        {c.public && <Badge tone="accent">published</Badge>}
        {c.status && <Badge tone="neutral">{c.status}</Badge>}
        <Badge tone="neutral">{c.subsystem}</Badge>
      </div>

      {c.description && <p className="beta-details-desc">{c.description}</p>}

      <div className="beta-details-section">
        <div className="beta-details-label">Interfaces</div>
        {c.interfaces.length === 0 ? (
          <p className="hint">No interfaces defined.</p>
        ) : (
          <ul className="beta-iface-list">
            {c.interfaces.map((iface) => (
              <li key={iface.id} className="beta-iface">
                <div className="beta-iface-name">{iface.name}</div>
                {iface.methods.length > 0 && (
                  <ul className="beta-method-list">
                    {iface.methods.map((m) => (
                      <li key={m.name} className="beta-method">
                        <code>{m.name}</code>
                        {m.returns && <span className="beta-method-returns"> → {m.returns}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {(c.dependsOn.length > 0 || c.owns.length > 0) && (
        <div className="beta-details-section">
          <div className="beta-details-label">Relations</div>
          {c.owns.length > 0 && (
            <p className="hint">
              <b>Owns:</b> {c.owns.join(', ')}
            </p>
          )}
          {c.dependsOn.length > 0 && (
            <p className="hint">
              <b>Depends on:</b> {c.dependsOn.join(', ')}
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
