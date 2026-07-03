// ---------------------------------------------------------------------------
// Deterministic blueprint layout for the architecture graph.
//
// SINGLE SOURCE OF TRUTH for placement: the TypeScript exporters (draw.io,
// Excalidraw) call computeLayout directly, and the interactive canvas embeds
// computeLayout.toString() into its HTML so the browser runs the exact same
// algorithm on collapse/expand. For that to work the function MUST stay fully
// self-contained: no imports, no references to module scope — everything it
// needs is defined inside its own body.
//
// The algorithm: subsystems in topological order (callers left of providers),
// components in dependency layers within each subsystem (entrypoints left →
// data right), barycenter sweeps to minimize edge crossings, pattern members
// nested inside their owning pattern's box.
// ---------------------------------------------------------------------------

export interface LayoutBox { x: number; y: number; w: number; h: number; }

export interface LayoutModel {
  subsystems: { id: string }[];
  components: {
    id: string;
    subsystem: string;
    componentType: string;
    owner?: string;
    owns: string[];
    dependsOn: string[];
  }[];
  edges: { from: string; to: string; cross: boolean }[];
}

export interface LayoutResult {
  /** Absolute boxes for every VISIBLE component (members inside patterns). */
  boxes: Record<string, LayoutBox>;
  /** Absolute boxes for every subsystem container. */
  subs: Record<string, LayoutBox & { collapsed: boolean }>;
}

export function computeLayout(model: LayoutModel, collapsed: Record<string, boolean>): LayoutResult {
  const BOX_W = 190, BOX_H = 52, GAP_X = 90, GAP_Y = 26, SUB_PAD = 30, SUB_HEAD = 44;
  const MEMBER_W = 168, MEMBER_H = 44, PAT_PAD = 16, PAT_HEAD = 34;
  const MAX_ROW = 2100;
  const PATTERN_TYPES: Record<string, number> = { Repository: 1, Gateway: 1, FeatureComponent: 1, RouterComponent: 1 };

  const compById: Record<string, LayoutModel['components'][number]> = {};
  model.components.forEach(function (c) { compById[c.id] = c; });
  const subIds: Record<string, number> = {};
  model.subsystems.forEach(function (s) { subIds[s.id] = 1; });

  // Subsystems ordered so callers sit left of the subsystems they depend on —
  // cross-boundary edges then flow consistently rightward. DFS post-order over
  // the subsystem dep graph, reversed; alphabetical tiebreak; cycle-guarded.
  function subsystemOrder(): string[] {
    const deps: Record<string, Record<string, number>> = {};
    model.edges.forEach(function (e) {
      if (!e.cross) return;
      const from = compById[e.from], to = compById[e.to];
      if (!from || !to) return;
      (deps[from.subsystem] = deps[from.subsystem] || {})[to.subsystem] = 1;
    });
    const ids = model.subsystems.map(function (s) { return s.id; }).sort();
    const order: string[] = [];
    const mark: Record<string, number> = {};
    function visit(id: string, stack: Record<string, number>): void {
      if (mark[id] || stack[id]) return;
      stack[id] = 1;
      Object.keys(deps[id] || {}).sort().forEach(function (d) { if (subIds[d]) visit(d, stack); });
      delete stack[id];
      mark[id] = 1;
      order.push(id);
    }
    ids.forEach(function (id) { visit(id, {}); });
    order.reverse();
    return order;
  }

  // Dependency layer of a top-level component within its subsystem: entrypoints
  // (Portal/Observer) at 0, everything else 1 + max layer of its callers.
  function layerOf(
    comp: LayoutModel['components'][number],
    topIds: Record<string, boolean>,
    memo: Record<string, number>,
    stack: Record<string, boolean>,
  ): number {
    if (memo[comp.id] !== undefined) return memo[comp.id];
    if (stack[comp.id]) return 0; // cycle guard
    stack[comp.id] = true;
    let l: number;
    if (comp.componentType === 'Portal' || comp.componentType === 'Observer') {
      l = 0;
    } else {
      l = 0;
      model.components.forEach(function (other) {
        if (other.subsystem !== comp.subsystem) return;
        if (!topIds[other.id]) return;
        if (other.dependsOn.indexOf(comp.id) >= 0) {
          l = Math.max(l, layerOf(other, topIds, memo, stack) + 1);
        }
      });
      if (l === 0) l = 1;
    }
    delete stack[comp.id];
    memo[comp.id] = l;
    return l;
  }

  function boxSizeFor(comp: LayoutModel['components'][number]): { w: number; h: number } {
    if (PATTERN_TYPES[comp.componentType] && comp.owns.length && !collapsed[comp.id]) {
      return { w: MEMBER_W + PAT_PAD * 2 + 24, h: PAT_HEAD + comp.owns.length * (MEMBER_H + 12) + PAT_PAD };
    }
    return { w: BOX_W, h: BOX_H };
  }

  // Barycenter crossing-reduction: order each column's components by the mean
  // row of their neighbors in the adjacent column (alternating sweeps).
  function refineColumns(colInfo: { comps: LayoutModel['components'][number][]; w: number; h: number }[]): void {
    function neighborsMean(c: LayoutModel['components'][number], refIds: Record<string, number>, fallback: number): number {
      const vals: number[] = [];
      c.dependsOn.forEach(function (d) { if (refIds[d] !== undefined) vals.push(refIds[d]); });
      model.components.forEach(function (o) {
        if (refIds[o.id] !== undefined && o.dependsOn.indexOf(c.id) >= 0) vals.push(refIds[o.id]);
      });
      if (!vals.length) return fallback;
      return vals.reduce(function (s, v) { return s + v; }, 0) / vals.length;
    }
    for (let iter = 0; iter < 4; iter++) {
      const forward = iter % 2 === 0;
      colInfo.forEach(function (col, k) {
        const refK = forward ? k - 1 : k + 1;
        if (refK < 0 || refK >= colInfo.length) return;
        const refIds: Record<string, number> = {};
        colInfo[refK].comps.forEach(function (c, i) { refIds[c.id] = i; });
        const keyed = col.comps.map(function (c, i) { return { c: c, key: neighborsMean(c, refIds, i) }; });
        keyed.sort(function (a, b) { return a.key - b.key || (a.c.id < b.c.id ? -1 : 1); });
        col.comps = keyed.map(function (x) { return x.c; });
      });
    }
  }

  const boxes: Record<string, LayoutBox> = {};
  const subs: Record<string, LayoutBox & { collapsed: boolean }> = {};
  const order = subsystemOrder();
  const sizes: Record<string, { w: number; h: number; cols: { comps: LayoutModel['components'][number][]; w: number; h: number }[] }> = {};

  order.forEach(function (subId) {
    if (collapsed[subId]) { sizes[subId] = { w: 240, h: 76, cols: [] }; return; }
    const comps = model.components.filter(function (c) { return c.subsystem === subId && !c.owner; });
    const topIds: Record<string, boolean> = {};
    comps.forEach(function (c) { topIds[c.id] = true; });
    const memo: Record<string, number> = {};
    comps.forEach(function (c) { layerOf(c, topIds, memo, {}); });
    const cols: Record<number, LayoutModel['components'][number][]> = {};
    comps.forEach(function (c) { (cols[memo[c.id]] = cols[memo[c.id]] || []).push(c); });
    const colKeys = Object.keys(cols).map(Number).sort(function (a, b) { return a - b; });
    const colInfo: { comps: LayoutModel['components'][number][]; w: number; h: number }[] = [];
    colKeys.forEach(function (k) {
      colInfo.push({ comps: cols[k].sort(function (a, b) { return a.id < b.id ? -1 : 1; }), w: 0, h: 0 });
    });
    refineColumns(colInfo);
    let width = SUB_PAD * 2, height = 0;
    colInfo.forEach(function (col) {
      let colW = 0, colH = 0;
      col.comps.forEach(function (c) { const s = boxSizeFor(c); colW = Math.max(colW, s.w); colH += s.h + GAP_Y; });
      col.w = colW; col.h = colH;
      width += colW + GAP_X;
      height = Math.max(height, colH);
    });
    if (colInfo.length) width -= GAP_X;
    sizes[subId] = { w: Math.max(width, 240), h: SUB_HEAD + height + SUB_PAD, cols: colInfo };
  });

  let x = 40, y = 40, rowH = 0;
  order.forEach(function (subId) {
    const s = sizes[subId];
    if (x + s.w > MAX_ROW && x > 40) { x = 40; y += rowH + 70; rowH = 0; }
    subs[subId] = { x: x, y: y, w: s.w, h: s.h, collapsed: !!collapsed[subId] };
    if (!collapsed[subId]) {
      let cx = x + SUB_PAD;
      s.cols.forEach(function (col) {
        let cy0 = y + SUB_HEAD + Math.max(0, (s.h - SUB_HEAD - SUB_PAD - col.h + GAP_Y) / 2);
        col.comps.forEach(function (c) {
          const bs = boxSizeFor(c);
          boxes[c.id] = { x: cx, y: cy0, w: bs.w, h: bs.h };
          if (PATTERN_TYPES[c.componentType] && c.owns.length && !collapsed[c.id]) {
            let my = cy0 + PAT_HEAD;
            c.owns.forEach(function (mid) {
              boxes[mid] = { x: cx + PAT_PAD + 12, y: my, w: MEMBER_W, h: MEMBER_H };
              my += MEMBER_H + 12;
            });
          }
          cy0 += bs.h + GAP_Y;
        });
        cx += col.w + GAP_X;
      });
    }
    x += s.w + 70;
    rowH = Math.max(rowH, s.h);
  });

  return { boxes: boxes, subs: subs };
}
