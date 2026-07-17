import { useEffect, useRef, useState } from 'react';
import { get } from '../api';
import { Badge, Button, EmptyState, ErrorNote, Spinner, TextInput, useAsync } from '../ui';
import type { CanvasComponent, CanvasModel, CanvasType } from '../canvas/model';
import { mountCanvas, type CanvasHandle } from '../canvas/renderer';
import { mountErd, type ErdHandle } from '../canvas/erd';
import { mountDatabases, databaseTables, type DbHandle, type DbSelection, type CanvasDatabase } from '../canvas/databases';
import { FlowModal } from './FlowModal';

/**
 * In-React canvas (the "Beta" renderer). Fetches a project's {@link CanvasModel}
 * from `/web/canvas-model` and mounts the shared, framework-agnostic cytoscape
 * renderers directly — no iframe. Three view modes share one stage, one search box
 * and one Fit button:
 *   • Components — the architecture graph ({@link mountCanvas}).
 *   • Types — the ERD / entity-relationship view ({@link mountErd}).
 *   • Databases — the per-database schema view ({@link mountDatabases}).
 * Selecting a node opens a details side panel; the search box highlights matches
 * and dims the rest. Exactly one cytoscape instance is mounted at a time — it is
 * destroyed on unmount, project change, or view-mode change.
 */
type ViewMode = 'components' | 'types' | 'databases';

/** All three renderer handles expose the same control surface; the view only ever
 *  touches this shared slice. */
type AnyHandle = Pick<CanvasHandle & ErdHandle & DbHandle, 'fit' | 'setQuery' | 'select' | 'destroy' | 'cy'>;

/** Whether the active view has nothing to render for `mode` (drives the empty
 *  overlay + skips mounting). Databases mode is empty only when the system
 *  declares no databases AND no type points at one (so a synthesized frame for a
 *  referenced-but-undeclared db still counts as content). */
function modeIsEmpty(m: CanvasModel, mode: ViewMode): boolean {
  if (mode === 'components') return m.components.length === 0;
  if (mode === 'types') return m.types.length === 0;
  return (m.system.databases?.length ?? 0) === 0 && !m.types.some((t) => !!t.database);
}

export function CanvasView({ projectId }: { projectId: string }) {
  const state = useAsync<CanvasModel>(
    () => get<CanvasModel>('/web/canvas-model?projectId=' + encodeURIComponent(projectId)),
    [projectId],
  );

  const stageRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<AnyHandle | null>(null);
  const [mode, setMode] = useState<ViewMode>('components');
  const [selectedComponent, setSelectedComponent] = useState<CanvasComponent | null>(null);
  const [selectedType, setSelectedType] = useState<CanvasType | null>(null);
  // The databases view selects either a database frame or one of its tables.
  const [selectedDb, setSelectedDb] = useState<DbSelection | null>(null);
  const [query, setQuery] = useState('');
  // The method whose L5 narrative flow the FlowModal is showing (null = closed).
  const [flowTarget, setFlowTarget] = useState<{ component: string; method: string } | null>(null);

  const model = state.data;
  const emptyForMode = !!model && modeIsEmpty(model, mode);
  const mounted = !!model && !emptyForMode;

  // Mount / remount the active renderer whenever a fresh model arrives (new
  // project or reload) or the view mode changes. Only one cytoscape instance is
  // ever live; cleanup destroys it and clears the matching selection.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !model || modeIsEmpty(model, mode)) return;

    let handle: AnyHandle;
    if (mode === 'components') {
      handle = mountCanvas(el, model, { onSelect: setSelectedComponent });
    } else if (mode === 'types') {
      handle = mountErd(el, model, { onSelect: setSelectedType });
    } else {
      handle = mountDatabases(el, model, { onSelect: setSelectedDb });
    }
    handleRef.current = handle;

    // Keep the graph fitted when the stage resizes (e.g. the details panel opens).
    const ro = new ResizeObserver(() => handle.cy.resize());
    ro.observe(el);

    return () => {
      ro.disconnect();
      handle.destroy();
      handleRef.current = null;
      setSelectedComponent(null);
      setSelectedType(null);
      setSelectedDb(null);
    };
  }, [model, mode]);

  // Push the live search query into whichever renderer is active (re-applied on
  // remount so a mode/project switch keeps the current filter).
  useEffect(() => {
    handleRef.current?.setQuery(query);
  }, [query, mode, model]);

  // Dismiss the flow modal on a project reload or view-mode switch — a stale
  // target could point at a component that is no longer in scope.
  useEffect(() => {
    setFlowTarget(null);
  }, [model, mode]);

  function clearSelection() {
    handleRef.current?.select(null);
    setSelectedComponent(null);
    setSelectedType(null);
    setSelectedDb(null);
  }

  return (
    <div className="beta-canvas">
      <div className="beta-canvas-stage">
        <div ref={stageRef} className="beta-canvas-cy" />

        {model && (
          <div className="beta-canvas-toolbar">
            <div className="seg beta-canvas-modeseg" role="tablist" aria-label="Canvas view mode">
              <button
                role="tab"
                aria-selected={mode === 'components'}
                className={`seg-btn ${mode === 'components' ? 'is-active' : ''}`}
                onClick={() => setMode('components')}
                title="Component architecture graph"
              >
                Components
              </button>
              <button
                role="tab"
                aria-selected={mode === 'types'}
                className={`seg-btn ${mode === 'types' ? 'is-active' : ''}`}
                onClick={() => setMode('types')}
                title="Type / entity-relationship view"
              >
                Types
              </button>
              <button
                role="tab"
                aria-selected={mode === 'databases'}
                className={`seg-btn ${mode === 'databases' ? 'is-active' : ''}`}
                onClick={() => setMode('databases')}
                title="Database schema view"
              >
                Databases
              </button>
            </div>
            {mounted && (
              <div className="beta-canvas-search">
                <TextInput
                  value={query}
                  onChange={setQuery}
                  placeholder={
                    mode === 'components'
                      ? 'Search components…'
                      : mode === 'types'
                        ? 'Search types…'
                        : 'Search databases…'
                  }
                />
              </div>
            )}
            <span className="spacer" />
            {mounted && (
              <Button size="sm" variant="ghost" onClick={() => handleRef.current?.fit()} title="Fit graph to view">
                Fit
              </Button>
            )}
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
        {emptyForMode && (
          <div className="beta-canvas-overlay">
            <EmptyState>
              {mode === 'components'
                ? 'This project has no components yet — design its spec tree to see the canvas.'
                : mode === 'types'
                  ? 'This project has no types yet — add types to see the ERD.'
                  : 'This project defines no databases yet — map types to a database to see the schema.'}
            </EmptyState>
          </div>
        )}
      </div>

      {mode === 'components' && selectedComponent && (
        <DetailsPanel
          component={selectedComponent}
          onClose={clearSelection}
          onViewFlow={(method) => setFlowTarget({ component: selectedComponent.id, method })}
        />
      )}
      {mode === 'types' && selectedType && model && (
        <TypeDetailsPanel type={selectedType} model={model} onClose={clearSelection} />
      )}
      {mode === 'databases' && selectedDb && model && (
        selectedDb.kind === 'table' ? (
          <TypeDetailsPanel type={selectedDb.type} model={model} onClose={clearSelection} />
        ) : (
          <DbDetailsPanel database={selectedDb.database} model={model} onClose={clearSelection} />
        )
      )}

      {flowTarget && model && (
        <FlowModal
          model={model}
          component={flowTarget.component}
          method={flowTarget.method}
          onClose={() => setFlowTarget(null)}
        />
      )}
    </div>
  );
}

/** Right-hand side panel describing the selected component. Each interface
 *  method that has an L5 narrative gets a "View flow" affordance; methods
 *  specified only as an intent (prose, no steps) show that prose inline. Any
 *  narrative without a matching contract method is listed under "Flows". */
function DetailsPanel({
  component,
  onClose,
  onViewFlow,
}: {
  component: CanvasComponent;
  onClose: () => void;
  onViewFlow: (method: string) => void;
}) {
  const c = component;
  const narrMethods = new Set(c.narratives.map((n) => n.method));
  const intentByMethod = new Map(c.intents.map((i) => [i.method, i.text]));
  const ifaceMethods = new Set(c.interfaces.flatMap((i) => i.methods.map((m) => m.name)));
  const orphanNarrs = c.narratives.filter((n) => !ifaceMethods.has(n.method));
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
                    {iface.methods.map((m) => {
                      const hasFlow = narrMethods.has(m.name);
                      const intent = !hasFlow ? intentByMethod.get(m.name) : undefined;
                      return (
                        <li key={m.name} className="beta-method">
                          <div className="beta-method-row">
                            <code>{m.name}</code>
                            {m.returns && <span className="beta-method-returns"> → {m.returns}</span>}
                            {hasFlow && (
                              <button
                                className="beta-flow-btn"
                                onClick={() => onViewFlow(m.name)}
                                title="View the L5 narrative flow"
                              >
                                View flow
                              </button>
                            )}
                          </div>
                          {intent && <p className="beta-method-intent">“{intent}”</p>}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {orphanNarrs.length > 0 && (
        <div className="beta-details-section">
          <div className="beta-details-label">Flows</div>
          <ul className="beta-method-list beta-method-list-flush">
            {orphanNarrs.map((n) => (
              <li key={n.method} className="beta-method beta-method-row">
                <code>{n.method}</code>
                <button
                  className="beta-flow-btn"
                  onClick={() => onViewFlow(n.method)}
                  title="View the L5 narrative flow"
                >
                  View flow
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

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

/** The marker shown for a field row in the ERD panel (PK / U / FK), derived the
 *  same way the canvas derives it. */
function fieldMarker(type: CanvasType, field: CanvasType['fields'][number], model: CanvasModel): string {
  if (field.key === 'primary') return 'PK';
  if (field.key === 'unique') return 'U';
  if (field.key === 'foreign') return 'FK';
  if (model.typeEdges.some((e) => e.from === type.id && e.field === field.name)) return 'FK';
  if (field.references) return 'FK';
  return '';
}

/** Right-hand side panel describing the selected type: its fields (name, type,
 *  key, references), relationships, methods, and where it is used. */
function TypeDetailsPanel({
  type,
  model,
  onClose,
}: {
  type: CanvasType;
  model: CanvasModel;
  onClose: () => void;
}) {
  const t = type;
  const refsOut = model.typeEdges.filter((e) => e.from === t.id);
  const refsIn = model.typeEdges.filter((e) => e.to === t.id);
  return (
    <aside className="beta-details">
      <div className="beta-details-head">
        <div className="cell-stack">
          <h3>{t.name}</h3>
          <span className="beta-stereo">«{t.kind}»</span>
        </div>
        <button className="icon-btn" aria-label="Close details" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="chip-row beta-details-badges">
        {t.subsystem && <Badge tone="neutral">{t.subsystem}</Badge>}
        {t.database && <Badge tone="accent">{t.database}</Badge>}
        {t.table && <Badge tone="neutral">table: {t.table}</Badge>}
      </div>

      <div className="beta-details-section">
        <div className="beta-details-label">Fields</div>
        {t.fields.length === 0 ? (
          <p className="hint">No fields.</p>
        ) : (
          <ul className="beta-field-list">
            {t.fields.map((f) => {
              const marker = fieldMarker(t, f, model);
              return (
                <li key={f.name} className="beta-field">
                  {marker && <span className={`beta-key beta-key-${marker.toLowerCase()}`}>{marker}</span>}
                  <code className="beta-field-name">
                    {f.name}
                    {f.optional ? '?' : ''}
                  </code>
                  <span className="beta-field-type">: {f.type}</span>
                  {f.references && <span className="beta-field-ref">→ {f.references}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {(refsOut.length > 0 || refsIn.length > 0) && (
        <div className="beta-details-section">
          <div className="beta-details-label">Relationships</div>
          {refsOut.map((e, i) => (
            <p key={`o${i}`} className="hint">
              <b>{e.field}</b> → {e.to} <span className="beta-card">[{e.card}]</span>
            </p>
          ))}
          {refsIn.map((e, i) => (
            <p key={`i${i}`} className="hint">
              {e.from}.<b>{e.field}</b> → this <span className="beta-card">[{e.card}]</span>
            </p>
          ))}
        </div>
      )}

      {t.methods.length > 0 && (
        <div className="beta-details-section">
          <div className="beta-details-label">Methods</div>
          <ul className="beta-method-list beta-method-list-flush">
            {t.methods.map((m) => (
              <li key={m.name} className="beta-method">
                <code>{m.name}</code>
                {m.returns && <span className="beta-method-returns"> → {m.returns}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="beta-details-section">
        <div className="beta-details-label">Used by</div>
        {t.usedBy.length === 0 ? (
          <p className="hint">Not referenced by any interface method.</p>
        ) : (
          <ul className="beta-usedby-list">
            {t.usedBy.map((u, i) => (
              <li key={i} className="beta-method">
                <code>{u.component}</code>
                <span className="beta-method-returns"> · {u.method}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

/** Right-hand side panel describing the selected database: its engine, optional
 *  description, and the tables persisted in it (each with a compact field count
 *  and PK/FK column count). Mirrors the language of the type/component panels. */
function DbDetailsPanel({
  database,
  model,
  onClose,
}: {
  database: CanvasDatabase;
  model: CanvasModel;
  onClose: () => void;
}) {
  const db = database;
  const tables = databaseTables(model, db.id);
  return (
    <aside className="beta-details">
      <div className="beta-details-head">
        <div className="cell-stack">
          <h3>{db.name}</h3>
          <span className="beta-stereo">«{db.engine}»</span>
        </div>
        <button className="icon-btn" aria-label="Close details" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="chip-row beta-details-badges">
        <Badge tone="warn">database</Badge>
        <Badge tone="neutral">{tables.length} {tables.length === 1 ? 'table' : 'tables'}</Badge>
      </div>

      {db.description && <p className="beta-details-desc">{db.description}</p>}

      <div className="beta-details-section">
        <div className="beta-details-label">Tables</div>
        {tables.length === 0 ? (
          <p className="hint">No types are mapped to this database yet.</p>
        ) : (
          <ul className="beta-db-table-list">
            {tables.map((t) => {
              const keyCount = t.fields.filter((f) => fieldMarker(t, f, model) !== '').length;
              return (
                <li key={t.id} className="beta-db-table">
                  <code className="beta-db-table-name">{t.table || t.name}</code>
                  <span className="beta-stereo beta-db-table-kind">«{t.kind}»</span>
                  <span className="beta-db-table-meta">
                    {t.fields.length} {t.fields.length === 1 ? 'field' : 'fields'}
                    {keyCount > 0 && <> · {keyCount} keyed</>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
