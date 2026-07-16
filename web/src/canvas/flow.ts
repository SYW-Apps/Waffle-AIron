/**
 * Framework-agnostic narrative-flow renderer.
 *
 * `mountFlow` builds a cytoscape flowchart from a component method's L5
 * narrative `steps[]` and renders the FLOW view of the in-React "Beta" canvas —
 * the sibling modal to {@link mountCanvas} (renderer.ts) and {@link mountErd}
 * (erd.ts). It mirrors the visual language of the standalone renderer's flow
 * modal in `src/core/canvas.ts` (do NOT edit that file): one node per step,
 * shaped + coloured by `kind` (branch/switch as diamonds, loop as a diamond,
 * try dashed, return/throw as terminals, call/dispatch highlighted), wired by
 * control-flow edges (sequential n→n+1 except after terminal steps; branch →
 * onTrue/onFalse; switch → each case + default; loop/try body region back/exit
 * around an `end`; jump → `to`; try catches → their step).
 *
 * Layout is deterministic `preset` placement — code order gives the Y (rows),
 * a structured-flowchart "lane" gives the X (branch/case/loop bodies shift into
 * their own column so the alternate path continues straight down an empty main
 * lane). No physics, no randomness — the same flow renders identically every
 * time and stays headless-safe. No React here on purpose: this is the shared,
 * reusable seam the FlowModal drives.
 */
import cytoscape from 'cytoscape';
import type { CanvasNarrativeStep } from './model';

/** A `call`/`dispatch` step's target — the drill-in coordinate. */
export interface FlowTarget {
  component: string;
  method: string;
}

export interface FlowOptions {
  /** Label for the synthetic start node (defaults to `method()`). */
  title?: string;
  /** Whether a call target resolves to a drillable narrative — marks the node
   *  with the drill affordance and enables double-click drill-in. */
  isDrillable?: (target: FlowTarget) => boolean;
  /** Fired when a drillable `call`/`dispatch` step is double-clicked. */
  onDrill?: (target: FlowTarget) => void;
}

export interface FlowHandle {
  /** The underlying cytoscape core (escape hatch for advanced callers). */
  readonly cy: cytoscape.Core;
  /** Fit the whole flowchart into view. */
  fit(): void;
  /** Tear down the cytoscape instance and release the container. */
  destroy(): void;
}

const FIT_PADDING = 30;
/** Row pitch (Y) and lane pitch (X) — wide enough that side-by-side nodes in
 *  adjacent lanes never overlap. Mirrors the standalone flow modal. */
const ROW_Y = 92;
const LANE_X = 344;

/** Resolve a design-token colour from the container, falling back to the SYW
 *  dark palette when the CSS variable is unset or still an unresolved `var()`.
 *  (Kept in lockstep with `readPalette` in renderer.ts / erd.ts so every canvas
 *  view themes identically.) */
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

/** Control-flow edge kinds — drive stroke style + colour (mirrors the
 *  standalone: seq | true | false | case | default | enter | back | exit |
 *  error | finally | jump). */
type EdgeKind =
  | 'seq'
  | 'true'
  | 'false'
  | 'case'
  | 'default'
  | 'enter'
  | 'back'
  | 'exit'
  | 'error'
  | 'finally'
  | 'jump';

interface FlowEdge {
  from: number;
  to: number;
  kind: EdgeKind;
  label: string;
}

interface FlowGraph {
  steps: CanvasNarrativeStep[];
  edges: FlowEdge[];
  /** Step number → structured-flowchart lane index (0 = main lane). */
  lane: Map<number, number>;
  /** The first step number (entry), or null for an empty narrative. */
  first: number | null;
}

/**
 * Derive the flow graph from a narrative's steps: one node per step plus the
 * semantic control-flow edges, and a lane assignment for each step so branch /
 * case / loop-body blocks occupy their own column. Pure + deterministic — a
 * faithful port of `buildFlowGraph` in src/core/canvas.ts.
 */
function buildFlowGraph(rawSteps: CanvasNarrativeStep[]): FlowGraph {
  const steps = rawSteps.slice().sort((a, b) => a.n - b.n);
  const present = new Set<number>();
  const nums: number[] = [];
  for (const s of steps) {
    present.add(s.n);
    nums.push(s.n);
  }
  const idx = new Map<number, number>();
  nums.forEach((n, i) => idx.set(n, i));
  const nextOf = (n: number): number | null => {
    const i = idx.get(n);
    return i !== undefined && i + 1 < nums.length ? nums[i + 1] : null;
  };
  const prevOf = (n: number): number | null => {
    const i = idx.get(n);
    return i !== undefined && i > 0 ? nums[i - 1] : null;
  };

  // Region tracking: loop-body ends flow back to their header instead of
  // falling through, so their fall-through seq edge is suppressed.
  const loopEnd = new Map<number, number>();
  const open: number[] = [];
  for (const s of steps) {
    while (open.length && open[open.length - 1] < s.n) open.pop();
    if ((s.kind === 'loop' || s.kind === 'try') && s.end !== undefined) open.push(s.end);
    if (s.kind === 'loop' && s.end !== undefined) loopEnd.set(s.end, s.n);
  }

  // Lanes: structured-flowchart X assignment. Loop/try bodies, branch
  // then-blocks, and switch case blocks shift into their own lane, so the
  // alternate path (false / default / loop-exit) continues straight down an
  // EMPTY main lane instead of cutting through the block's nodes. Nested
  // structures shift additively.
  const laneAdd = nums.map(() => 0);
  const shiftSpan = (a: number | null, b: number | null, amt: number): void => {
    if (a === null || b === null) return;
    const i = idx.get(a);
    const j = idx.get(b);
    if (i === undefined || j === undefined || j < i) return;
    for (let k = i; k <= j; k++) laneAdd[k] += amt;
  };
  for (const s of steps) {
    if ((s.kind === 'loop' || s.kind === 'try') && s.end !== undefined) {
      shiftSpan(nextOf(s.n), s.end, 1);
    }
    if (s.kind === 'branch' && s.onFalse !== undefined && s.onFalse > s.n) {
      const thenStart = s.onTrue !== undefined ? s.onTrue : nextOf(s.n);
      if (thenStart !== null && thenStart > s.n && thenStart < s.onFalse) {
        shiftSpan(thenStart, prevOf(s.onFalse), 1);
      }
    }
    if (s.kind === 'switch') {
      const starts = (s.cases ?? [])
        .map((cse) => cse.step)
        .filter((n2) => n2 > s.n && present.has(n2))
        .sort((a, b) => a - b);
      // Each case block gets its own lane (a staircase); a block ends where the
      // next case (or the default target) starts. The default path stays in the
      // main lane — the straight-down continuation.
      const bound = s.defaultStep !== undefined && s.defaultStep > s.n ? s.defaultStep : null;
      starts.forEach((cs, ci) => {
        const endN =
          ci + 1 < starts.length
            ? prevOf(starts[ci + 1])
            : bound !== null && bound > cs
              ? prevOf(bound)
              : null;
        if (endN !== null && endN >= cs) shiftSpan(cs, endN, ci + 1);
      });
    }
  }
  const lane = new Map<number, number>();
  nums.forEach((n, i) => lane.set(n, laneAdd[i]));

  const edges: FlowEdge[] = [];
  const E = (a: number, b: number | null | undefined, kind: EdgeKind, label = ''): void => {
    if (b !== null && b !== undefined && present.has(b)) edges.push({ from: a, to: b, kind, label });
  };
  for (const s of steps) {
    const n = s.n;
    switch (s.kind) {
      case 'branch':
        E(n, s.onTrue !== undefined ? s.onTrue : nextOf(n), 'true', 'true');
        E(n, s.onFalse, 'false', 'false');
        break;
      case 'switch':
        for (const cse of s.cases ?? []) E(n, cse.step, 'case', cse.value);
        E(n, s.defaultStep !== undefined ? s.defaultStep : nextOf(n), 'default', 'default');
        break;
      case 'loop':
        E(n, nextOf(n), 'enter', s.loopKind === 'doWhile' ? 'do' : '');
        if (s.end !== undefined) {
          E(s.end, n, 'back', s.loopKind === 'doWhile' ? 'while ' + (s.cond ?? '') : '⟳');
          E(n, nextOf(s.end), 'exit', 'done');
        }
        break;
      case 'try':
        E(n, nextOf(n), 'seq');
        for (const cc of s.catches ?? []) E(n, cc.step, 'error', cc.error);
        if (s.fin !== undefined) E(n, s.fin, 'finally', 'finally');
        break;
      case 'jump':
        E(n, s.to, 'jump');
        break;
      case 'return':
      case 'throw':
        break;
      default:
        if (!loopEnd.has(n)) E(n, nextOf(n), 'seq');
    }
  }

  return { steps, edges, lane, first: nums.length ? nums[0] : null };
}

/** One-line node label for a step, prefixed with a kind glyph (mirrors
 *  `flowStepLabel` in src/core/canvas.ts). */
function flowStepLabel(s: CanvasNarrativeStep): string {
  switch (s.kind) {
    case 'branch':
      return s.n + '. ◇ ' + (s.cond ?? s.text);
    case 'switch':
      return s.n + '. ◇ switch ' + (s.on ?? s.text);
    case 'loop':
      return (
        s.n +
        '. ⟳ ' +
        (s.loopKind === 'doWhile' ? 'do' : s.loopKind ?? 'forEach') +
        (s.over ? ' ' + s.over : s.cond ? ' while ' + s.cond : '')
      );
    case 'try':
      return s.n + '. ⛨ try — ' + s.text;
    case 'jump':
      return s.n + '. ↷ ' + s.text;
    case 'return':
      return s.n + '. ⏎ return' + (s.outcome ? ' — ' + s.outcome : '');
    case 'throw':
      return s.n + '. ⚡ throw' + (s.err ? ' ' + s.err : '');
    default:
      return s.n + '. ' + s.text;
  }
}

/** Is this step a component call (call | dispatch with a resolved target)? */
function callTarget(s: CanvasNarrativeStep): FlowTarget | null {
  if ((s.kind === 'call' || s.kind === 'dispatch') && s.call) {
    return { component: s.call.component, method: s.call.method };
  }
  return null;
}

/** Node stereotype class per step kind (drives shape + colour below). */
function stepClass(s: CanvasNarrativeStep): string {
  switch (s.kind) {
    case 'branch':
    case 'switch':
      return 'flowcond';
    case 'loop':
      return 'flowloop';
    case 'try':
      return 'flowtry';
    case 'return':
      return 'flowend';
    case 'throw':
      return 'flowthrow';
    case 'jump':
      return 'flowjumpn';
    default:
      return callTarget(s) ? 'flowcall' : 'flowlocal';
  }
}

/** Build the cytoscape elements for a narrative flow — a synthetic start node,
 *  one node per step (preset-positioned by lane × row), and the control-flow
 *  edges. Call/dispatch nodes carry their drill target in node data. */
function buildElements(graph: FlowGraph, opts: FlowOptions): cytoscape.ElementDefinition[] {
  const els: cytoscape.ElementDefinition[] = [];
  els.push({
    data: { id: 'start', label: opts.title ?? 'method()', w: 280, h: 44, tw: 260 },
    position: { x: 0, y: 0 },
    classes: 'flowstart',
  });

  graph.steps.forEach((s, i) => {
    const target = callTarget(s);
    const drillable = !!target && !!opts.isDrillable?.(target);
    const isCond = s.kind === 'branch' || s.kind === 'switch' || s.kind === 'loop';
    const label =
      flowStepLabel(s) +
      (target ? '\n→ ' + target.component + '.' + target.method + '()' + (drillable ? '  ↴' : '') : '');
    els.push({
      data: {
        id: 'n' + s.n,
        label,
        w: isCond ? 320 : 300,
        h: target ? 58 : isCond ? 64 : 46,
        tw: isCond ? 210 : 280,
        callComp: target ? target.component : '',
        callMethod: target ? target.method : '',
      },
      // Rows keep code order (Y); lanes give branches/cases their own column (X).
      position: { x: (graph.lane.get(s.n) ?? 0) * LANE_X, y: (i + 1) * ROW_Y },
      classes: stepClass(s) + (target ? ' flowcallnode' : '') + (drillable ? ' drill' : ''),
    });
  });

  if (graph.first !== null) {
    els.push({ data: { id: 'fe-start', source: 'start', target: 'n' + graph.first, lbl: '' } });
  }
  graph.edges.forEach((e, i) => {
    const cls =
      e.kind === 'error'
        ? 'fErr'
        : e.kind === 'back'
          ? 'fBack'
          : e.kind === 'jump' || e.kind === 'finally'
            ? 'fJump'
            : e.kind === 'false' || e.kind === 'case' || e.kind === 'default' || e.kind === 'exit'
              ? 'fAlt'
              : '';
    els.push({ data: { id: 'fe' + i, source: 'n' + e.from, target: 'n' + e.to, lbl: e.label }, classes: cls });
  });

  return els;
}

/** Build the cytoscape stylesheet for the flow view, derived from theme tokens.
 *  Kinds map onto the same stereotype palette the arch view uses: entry=accent
 *  (start/return), logic=purple (calls), data=warn (branch/switch), adapter=ok
 *  (loops); errors + throws read in `--bad`. */
function buildStyle(pal: Palette): cytoscape.StylesheetStyle[] {
  const styles = [
    {
      selector: 'node',
      style: {
        shape: 'round-rectangle',
        width: 'data(w)',
        height: 'data(h)',
        label: 'data(label)',
        'text-wrap': 'wrap',
        'text-max-width': 'data(tw)',
        'font-size': 11,
        'font-family': 'Inter, system-ui, sans-serif',
        color: pal.ink,
        'text-valign': 'center',
        'text-halign': 'center',
        'border-width': 1.5,
        'background-opacity': 0.18,
      },
    },
    // Entry (start) + return terminal — accent.
    {
      selector: '.flowstart',
      style: { 'background-color': pal.accent, 'border-color': pal.accent, color: pal.ink, 'font-weight': 'bold', 'background-opacity': 0.22 },
    },
    { selector: '.flowlocal', style: { 'background-color': pal.panel, 'border-color': pal.border, 'background-opacity': 0.9 } },
    { selector: '.flowcall', style: { 'background-color': pal.purple, 'border-color': pal.purple } },
    // Branch / switch decisions — diamonds, warn tint.
    { selector: '.flowcond', style: { shape: 'round-diamond', 'background-color': pal.warn, 'border-color': pal.warn } },
    // Loops — diamonds, ok tint.
    { selector: '.flowloop', style: { shape: 'round-diamond', 'background-color': pal.ok, 'border-color': pal.ok } },
    // Try regions — dashed, bad-tinted border.
    { selector: '.flowtry', style: { 'background-color': pal.panel, 'border-color': pal.bad, 'border-style': 'dashed', 'background-opacity': 0.6 } },
    // Return terminal — accent, thick border.
    { selector: '.flowend', style: { 'background-color': pal.accent, 'border-color': pal.accent, 'border-width': 2.5 } },
    // Throw terminal — bad, thick border.
    { selector: '.flowthrow', style: { 'background-color': pal.bad, 'border-color': pal.bad, color: pal.ink, 'border-width': 2.5 } },
    // Jump marker — dotted, dim.
    { selector: '.flowjumpn', style: { 'background-color': pal.inkDim, 'border-color': pal.inkDim, 'border-style': 'dotted', 'background-opacity': 0.14 } },
    // Drillable call — thicker highlighted border + pointer affordance.
    { selector: '.drill', style: { 'border-width': 2.6, 'border-color': pal.accent } },
    // Edges — base sequential link.
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        width: 1.6,
        'line-color': pal.inkDim,
        'target-arrow-shape': 'triangle',
        'target-arrow-color': pal.inkDim,
        'arrow-scale': 0.9,
        label: 'data(lbl)',
        'font-size': 9.5,
        'font-family': 'Inter, system-ui, sans-serif',
        color: pal.inkDim,
        'text-background-color': pal.bg,
        'text-background-opacity': 0.85,
        'text-background-padding': 2,
        'text-rotation': 'autorotate',
      },
    },
    // Long alternate edges (false / case / default / loop-exit) route
    // orthogonally: down the source's lane, one turn in the free corridor just
    // above the target row, then in — instead of a straight cut through the
    // nodes stacked between.
    {
      selector: 'edge.fAlt',
      style: { 'line-style': 'dashed', 'curve-style': 'taxi', 'taxi-direction': 'downward', 'taxi-turn': -34, 'taxi-turn-min-distance': 10 },
    },
    // Loop back-edge — curves left around the body.
    {
      selector: 'edge.fBack',
      style: { 'line-style': 'dashed', 'curve-style': 'unbundled-bezier', 'control-point-distances': [-70], 'control-point-weights': [0.5] },
    },
    // Error (catch) edges — dashed taxi in `--bad`.
    {
      selector: 'edge.fErr',
      style: {
        'line-style': 'dashed',
        'curve-style': 'taxi',
        'taxi-direction': 'downward',
        'taxi-turn': -34,
        'taxi-turn-min-distance': 10,
        'line-color': pal.bad,
        'target-arrow-color': pal.bad,
        color: pal.bad,
      },
    },
    // Jump + finally edges — dotted taxi.
    {
      selector: 'edge.fJump',
      style: { 'line-style': 'dotted', 'curve-style': 'taxi', 'taxi-direction': 'downward', 'taxi-turn': -34, 'taxi-turn-min-distance': 10 },
    },
  ];
  return styles as cytoscape.StylesheetStyle[];
}

/**
 * Mount a narrative-flow flowchart into `container`. The container should be a
 * sized block element; the caller owns its lifecycle and must call
 * `handle.destroy()` on unmount. Double-clicking a drillable call/dispatch step
 * fires `opts.onDrill` with its target so the caller can push a new flow.
 */
export function mountFlow(container: HTMLElement, steps: CanvasNarrativeStep[], opts: FlowOptions = {}): FlowHandle {
  const pal = readPalette(container);
  const graph = buildFlowGraph(steps);

  const cy = cytoscape({
    container,
    elements: buildElements(graph, opts),
    style: buildStyle(pal),
    layout: { name: 'preset' },
    minZoom: 0.1,
    maxZoom: 3,
    wheelSensitivity: 0.2,
    boxSelectionEnabled: false,
    autounselectify: true,
  });
  // Flowcharts are fixed documentation — never rearrangeable.
  cy.autolock(true);

  // Drill on DOUBLE-click only — single taps in a dense flowchart are too easy
  // to land accidentally.
  cy.on('dbltap', 'node.drill', (evt: cytoscape.EventObject) => {
    const d = evt.target.data() as { callComp?: string; callMethod?: string };
    if (d.callComp && d.callMethod) opts.onDrill?.({ component: d.callComp, method: d.callMethod });
  });

  cy.fit(undefined, FIT_PADDING);

  return {
    cy,
    fit: () => cy.fit(undefined, FIT_PADDING),
    destroy: () => cy.destroy(),
  };
}
