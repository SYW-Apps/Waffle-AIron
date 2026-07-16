import { useEffect, useMemo, useRef, useState } from 'react';
import type { CanvasModel, CanvasNarrativeStep } from '../canvas/model';
import { mountFlow, type FlowHandle, type FlowTarget } from '../canvas/flow';

/**
 * The narrative-flow modal — the L5 flow graph for a component method, shown
 * over the Beta canvas. It mirrors the standalone flow modal in
 * `src/core/canvas.ts` (do NOT edit that file):
 *   • a title / breadcrumb (component.method), with a Back control once drilled;
 *   • a Flow | Steps toggle — Flow renders the cytoscape flowchart via
 *     {@link mountFlow}, Steps renders a simple ordered list of the steps;
 *   • drill-in — double-clicking a `call`/`dispatch` step in the graph (or the
 *     call button in Steps mode) opens the target `component.method`'s flow,
 *     pushing a breadcrumb frame; Back returns to the caller.
 * The target narrative is resolved from the full {@link CanvasModel}. Esc,
 * scrim-click and the close button all dismiss it (the app's modal conventions).
 */
export function FlowModal({
  model,
  component,
  method,
  onClose,
}: {
  model: CanvasModel;
  component: string;
  method: string;
  onClose: () => void;
}) {
  // Drill-in breadcrumb: the head is the flow currently shown; Back pops it.
  const [stack, setStack] = useState<FlowTarget[]>([{ component, method }]);
  const [mode, setMode] = useState<'flow' | 'steps'>('flow');
  const top = stack[stack.length - 1];

  const byId = useMemo(() => new Map(model.components.map((c) => [c.id, c])), [model]);
  const narrativeFor = useMemo(
    () =>
      (compId: string, m: string): CanvasNarrativeStep[] | null => {
        const c = byId.get(compId);
        const n = c?.narratives.find((nn) => nn.method === m);
        return n ? n.steps : null;
      },
    [byId],
  );

  const steps = narrativeFor(top.component, top.method) ?? [];
  const compName = byId.get(top.component)?.name ?? top.component;

  function drill(target: FlowTarget) {
    if (narrativeFor(target.component, target.method)) setStack((s) => [...s, target]);
  }
  function back() {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }

  // Esc closes; body scroll-locks while open (mirrors the shared Modal).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // Mount / remount the flowchart whenever the drilled-to method changes or the
  // view switches back to Flow. Only ever one cytoscape instance is live.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<FlowHandle | null>(null);
  useEffect(() => {
    if (mode !== 'flow') return;
    const el = stageRef.current;
    if (!el) return;
    const handle = mountFlow(el, steps, {
      title: compName + '.' + top.method + '()',
      isDrillable: (t) => !!narrativeFor(t.component, t.method),
      onDrill: drill,
    });
    handleRef.current = handle;
    // Keep the flow fitted as the modal (and stage) sizes settle / resize.
    const ro = new ResizeObserver(() => handle.cy.resize());
    ro.observe(el);
    const raf = requestAnimationFrame(() => {
      handle.cy.resize();
      handle.fit();
    });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      handle.destroy();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, top.component, top.method, model]);

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="flow-modal" role="dialog" aria-modal="true" aria-label="Narrative flow" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flow-modal-bar">
          {stack.length > 1 && (
            <button className="btn btn-ghost btn-sm" onClick={back} title="Back to the calling narrative">
              ← Back
            </button>
          )}
          <span className="flow-crumb">
            {stack.map((f, i) => {
              const label = (byId.get(f.component)?.name ?? f.component) + '.' + f.method + '()';
              const isHead = i === stack.length - 1;
              return (
                <span key={i} className={isHead ? 'flow-crumb-head' : 'flow-crumb-dim'}>
                  {label}
                  {isHead ? '' : ' → '}
                </span>
              );
            })}
          </span>
          <span className="spacer" />
          <div className="seg flow-modeseg" role="tablist" aria-label="Flow view mode">
            <button
              role="tab"
              aria-selected={mode === 'flow'}
              className={`seg-btn ${mode === 'flow' ? 'is-active' : ''}`}
              onClick={() => setMode('flow')}
            >
              Flow
            </button>
            <button
              role="tab"
              aria-selected={mode === 'steps'}
              className={`seg-btn ${mode === 'steps' ? 'is-active' : ''}`}
              onClick={() => setMode('steps')}
            >
              Steps
            </button>
          </div>
          {mode === 'flow' && (
            <button className="btn btn-ghost btn-sm" onClick={() => handleRef.current?.fit()} title="Fit flow to view">
              Fit
            </button>
          )}
          <button className="icon-btn" aria-label="Close flow" onClick={onClose}>
            ×
          </button>
        </div>

        {mode === 'flow' ? (
          <div ref={stageRef} className="flow-modal-cy" />
        ) : (
          <FlowSteps steps={steps} isDrillable={(t) => !!narrativeFor(t.component, t.method)} onDrill={drill} />
        )}

        <div className="flow-modal-hint">
          Narrative (L5) — {mode === 'flow' ? 'double-click' : 'click'} a call step to drill into the target method
          {stack.length > 1 ? '; Back returns to the caller.' : '.'}
        </div>
      </div>
    </div>
  );
}

/** One-line prose for a step in the Steps list (mirrors `flowStepText` in
 *  src/core/canvas.ts). */
function flowStepText(s: CanvasNarrativeStep): string {
  switch (s.kind) {
    case 'branch':
      return '◇ if ' + (s.cond ?? s.text) + (s.onFalse !== undefined ? ' — else → ' + s.onFalse : '');
    case 'switch':
      return (
        '◇ switch on ' +
        (s.on ?? s.text) +
        ' — ' +
        (s.cases ?? []).map((c) => c.value + ' → ' + c.step).join(', ') +
        (s.defaultStep !== undefined ? ', default → ' + s.defaultStep : '')
      );
    case 'loop':
      return (
        '⟳ ' +
        (s.loopKind ?? 'forEach') +
        (s.over ? ' ' + s.over : '') +
        (s.cond ? ' while ' + s.cond : '') +
        (s.end !== undefined ? ' (body → ' + s.end + ')' : '')
      );
    case 'try':
      return (
        '⛨ try' +
        (s.end !== undefined ? ' (body → ' + s.end + ')' : '') +
        (s.catches ?? []).map((c) => ' — on ' + c.error + ' → ' + c.step).join('') +
        (s.fin !== undefined ? ' — finally → ' + s.fin : '')
      );
    case 'jump':
      return '↷ → step ' + s.to + (s.text ? ' — ' + s.text : '');
    case 'return':
      return '⏎ return' + (s.outcome ? ' — ' + s.outcome : '') + (s.text ? ' (' + s.text + ')' : '');
    case 'throw':
      return '⚡ throw' + (s.err ? ' ' + s.err : '') + (s.text ? ' — ' + s.text : '');
    default:
      return s.text;
  }
}

/** The Steps mode — a simple ordered list of the narrative steps, with the call
 *  target rendered as a drill button when the target has its own narrative. */
function FlowSteps({
  steps,
  isDrillable,
  onDrill,
}: {
  steps: CanvasNarrativeStep[];
  isDrillable: (t: FlowTarget) => boolean;
  onDrill: (t: FlowTarget) => void;
}) {
  if (steps.length === 0) {
    return (
      <div className="flow-steps">
        <div className="flow-step">No narrative steps.</div>
      </div>
    );
  }
  return (
    <div className="flow-steps">
      {steps.map((s) => {
        const target = s.call ? { component: s.call.component, method: s.call.method } : null;
        const drillable = !!target && isDrillable(target);
        return (
          <div key={s.n} className="flow-step">
            <span className="flow-step-num">{s.n}.</span> {flowStepText(s)}
            {target &&
              (drillable ? (
                <button className="flow-step-call is-drill" onClick={() => onDrill(target)} title="Drill into this method's flow">
                  → {target.component}.{target.method}() ↴
                </button>
              ) : (
                <span className="flow-step-call">
                  {' → '}
                  {target.component}.{target.method}()
                </span>
              ))}
          </div>
        );
      })}
    </div>
  );
}
