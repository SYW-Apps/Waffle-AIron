/**
 * Framework-agnostic DATABASES / schema-canvas renderer.
 *
 * `mountDatabases` builds a cytoscape graph from a {@link CanvasModel} and renders
 * the DATABASE-SCHEMA view — the third view mode of the in-React "Beta" canvas, a
 * sibling to {@link mountCanvas} in `renderer.ts` and {@link mountErd} in `erd.ts`.
 * It mirrors the visual language of the standalone renderer's databases view in
 * `src/core/canvas.ts` (do NOT edit that file): every `system.databases[]` entry
 * becomes a compound "database" frame (labelled `name «engine»`) that contains one
 * compound "table" per type persisted in it — the types whose `database` pointer
 * matches (subject to the db's optional `tables` allow-list), plus any type a db
 * claims by id / `table` name. Each table is a header row + one child row per
 * field, and `model.typeEdges` become foreign-key relationship edges from the
 * referencing table to the referenced one, labelled with the cardinality (edges
 * cross frames freely, so a cross-database FK still draws).
 *
 * Types not mapped to any database are omitted from this view. Field rows carry a
 * PK / FK / U marker (from `field.key`, a type edge, or `field.references`), and
 * tables are tinted by `kind` (entity vs value/enum/…), value-shaped kinds getting
 * a dashed border — kept in lockstep with `erd.ts` so both views read identically.
 *
 * Layout is deterministic `preset` placement — dependency-layered columns within
 * each database frame, frames stacked vertically — so the schema renders the same
 * every time with no physics and no overlap surprises. `applyModel` rebuilds the
 * elements in place (the same WS-patch re-apply seam as its siblings). No React
 * here on purpose: this is the shared, reusable seam. The table-rendering helpers
 * are copied from `erd.ts` rather than imported (that file exports no seam and must
 * not be edited); the two stay visually in lockstep by construction.
 */
import cytoscape from 'cytoscape';
import type { CanvasModel, CanvasType } from './model';

/** The database descriptor carried on the system model. */
export type CanvasDatabase = NonNullable<CanvasModel['system']['databases']>[number];

/** A databases-view selection is either a database frame or one of its tables. */
export type DbSelection =
  | { kind: 'database'; database: CanvasDatabase }
  | { kind: 'table'; type: CanvasType };

/** Type kinds treated as "entity" (solid, primary tint); everything else is a
 *  value-shaped kind (dashed border, secondary tint). Kept in lockstep with
 *  `isEntityKind` in erd.ts. */
function isEntityKind(kind: string): boolean {
  return kind === 'entity' || kind === 'aggregate' || kind === 'table';
}

export interface DatabasesOptions {
  /** Fired when a database frame or a table is selected (null clears). */
  onSelect?: (selection: DbSelection | null) => void;
}

export interface DbHandle {
  /** The underlying cytoscape core (escape hatch for advanced callers). */
  readonly cy: cytoscape.Core;
  /** Fit the whole graph into view. */
  fit(): void;
  /** Rebuild the graph from a fresh model (the WS-patch re-apply seam). */
  applyModel(next: CanvasModel): void;
  /** Highlight tables / databases whose name/id contains `query`; dim the rest. */
  setQuery(query: string): void;
  /** Programmatically select a table (type id) or a database (db id); null clears. */
  select(id: string | null): void;
  /** Tear down the cytoscape instance and release the container. */
  destroy(): void;
}

const FIT_PADDING = 42;

/** Resolve a design-token colour from the container, falling back to the SYW
 *  dark palette when the CSS variable is unset or still an unresolved `var()`.
 *  (Kept in lockstep with `readPalette` in renderer.ts / erd.ts so all three
 *  views theme identically.) */
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

/** Tint colour per type kind, derived from theme tokens. Lockstep with erd.ts. */
function kindColor(pal: Palette, kind: string): string {
  if (isEntityKind(kind)) return pal.accent;
  switch (kind) {
    case 'enum': return pal.warn;
    case 'external': return pal.ok;
    case 'union': return pal.bad;
    default: return pal.purple; // value + anything else
  }
}

/** Build the cytoscape stylesheet for the databases view. The table styling is
 *  the ERD's (typeBox / typeHead / typeRow / …); the compound container is a
 *  `dbFrame` — a persistence-tinted frame (warn) distinct from the ERD's accent
 *  subsystem frames, so a database reads unmistakably as a data store. */
function buildStyle(pal: Palette): cytoscape.StylesheetStyle[] {
  const styles = [
    // Leaf-node defaults (header rows, field rows, plain tables). Compound
    // parents (tables + db frames) auto-size and are styled separately below.
    {
      selector: 'node',
      style: {
        shape: 'round-rectangle',
        'font-family': 'Inter, system-ui, sans-serif',
        'font-size': 11,
        color: pal.ink,
        'text-valign': 'center',
        'text-halign': 'center',
        'border-width': 1.4,
      },
    },
    {
      selector: 'node.leaf',
      style: {
        width: 'data(w)',
        height: 'data(h)',
        label: 'data(label)',
        'text-wrap': 'wrap',
        'text-max-width': 'data(tw)',
      },
    },
    // Compound "database" frame — the persistence container (warn-tinted).
    {
      selector: 'node.dbFrame',
      style: {
        shape: 'round-rectangle',
        'background-color': pal.warn,
        'background-opacity': 0.06,
        'border-color': pal.warn,
        'border-width': 1.6,
        'border-style': 'solid',
        color: pal.warn,
        label: 'data(label)',
        'font-size': 12.5,
        'font-weight': 'bold',
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': 4,
        padding: 18,
      },
    },
    // Compound "table" box — tinted by kind, hugging its rows.
    {
      selector: 'node.typeBox',
      style: {
        'background-color': 'data(color)',
        'border-color': 'data(color)',
        'background-opacity': 0.14,
        'border-width': 1.8,
        padding: 0,
      },
    },
    // Header row of a table (type name + «kind»).
    {
      selector: 'node.typeHead',
      style: {
        'background-color': 'data(color)',
        'background-opacity': 0.28,
        'border-color': 'data(color)',
        'border-width': 0,
        'font-weight': 'bold',
        'font-size': 11,
        color: pal.ink,
      },
    },
    // Field rows.
    {
      selector: 'node.typeRow',
      style: {
        'background-color': pal.panel,
        'background-opacity': 0.9,
        'border-color': pal.border,
        'border-width': 0.6,
        'font-size': 10,
        color: pal.inkDim,
        'text-justification': 'left',
      },
    },
    // Foreign-key rows read a touch stronger (they anchor a relation edge).
    { selector: 'node.fkRow', style: { color: pal.ink } },
    // Plain (field-less) tables render as a single header box.
    {
      selector: 'node.typePlain',
      style: {
        'background-color': 'data(color)',
        'border-color': 'data(color)',
        'background-opacity': 0.2,
        'font-weight': 'bold',
      },
    },
    // Value-shaped kinds get a dashed border (entities stay solid).
    { selector: 'node.val', style: { 'border-style': 'dashed' } },
    // Foreign-key edges — referencing table → referenced table, card at the head.
    {
      selector: 'edge.erd',
      style: {
        'curve-style': 'bezier',
        width: 1.6,
        'line-color': pal.inkDim,
        'target-arrow-shape': 'triangle',
        'target-arrow-color': pal.inkDim,
        'arrow-scale': 0.9,
        opacity: 0.9,
        label: 'data(card)',
        'font-size': 9,
        color: pal.inkDim,
        'text-background-color': pal.bg,
        'text-background-opacity': 0.85,
        'text-background-padding': 2,
        'text-rotation': 'autorotate',
      },
    },
    // Selection + search states (mirrors the ERD view).
    { selector: 'node.sel', style: { 'overlay-color': pal.accent, 'overlay-opacity': 0.34, 'overlay-padding': 6 } },
    { selector: 'node.match', style: { 'border-color': pal.accent, 'border-width': 3 } },
    { selector: 'node.dbFrame.match', style: { 'border-color': pal.accent, 'border-width': 2.6 } },
    { selector: '.dim', style: { opacity: 0.12 } },
  ];
  return styles as cytoscape.StylesheetStyle[];
}

interface TableShape {
  fields: CanvasType['fields'];
  head: string;
  plain: boolean;
  w: number;
  h: number;
}

const ROW_H = 20;
const TH_H = 26;
const COL_GAP = 60;
const TABLE_GAP_Y = 40;
const GROUP_GAP = 120;

/** The per-model projection the databases view is built from: the ordered list of
 *  database frames (declared first, then any referenced-but-undeclared db a type
 *  points at — kept so no persisted type is silently dropped), a db lookup, and a
 *  type-id → db-id map of every table that lands in this view. */
interface DbMapping {
  dbFrames: CanvasDatabase[];
  dbById: Map<string, CanvasDatabase>;
  typeDb: Map<string, string>;
}

/** Resolve which database a type is persisted in, mirroring `databaseAllowsType`
 *  in src/core/canvas.ts: a type maps to a db via its `database` pointer, and — if
 *  that db enumerates its own `tables` — only when the type's id or `table` name is
 *  listed there. A type with no `database` pointer can still be claimed by a db
 *  that lists it in `tables`. Returns null for types that map to no database. */
function dbIdOfType(t: CanvasType, byId: Map<string, CanvasDatabase>, declared: CanvasDatabase[]): string | null {
  if (t.database) {
    const db = byId.get(t.database);
    if (!db) return t.database; // referenced db not declared — keep it (faithful to databaseAllowsType)
    if (!db.tables || db.tables.length === 0) return db.id;
    return db.tables.includes(t.id) || db.tables.includes(t.table ?? t.id) ? db.id : null;
  }
  for (const db of declared) {
    if (db.tables && (db.tables.includes(t.id) || db.tables.includes(t.table ?? t.id))) return db.id;
  }
  return null;
}

/** Project the model into the databases-view mapping. Deterministic ordering:
 *  declared databases keep their spec order, synthesized frames append after. */
function computeMapping(model: CanvasModel): DbMapping {
  const declared = model.system.databases ?? [];
  const dbById = new Map<string, CanvasDatabase>(declared.map((d) => [d.id, d]));

  const typeDb = new Map<string, string>();
  for (const t of model.types) {
    const dbId = dbIdOfType(t, dbById, declared);
    if (dbId) typeDb.set(t.id, dbId);
  }

  // Frame order: declared first, then any db a type references but which was not
  // declared on the system (synthesized with an unknown engine).
  const dbFrames: CanvasDatabase[] = declared.slice();
  for (const dbId of typeDb.values()) {
    if (!dbById.has(dbId)) {
      const synth: CanvasDatabase = { id: dbId, name: dbId, engine: 'unknown' };
      dbById.set(dbId, synth);
      dbFrames.push(synth);
    }
  }
  return { dbFrames, dbById, typeDb };
}

/** Label for a database frame — `name  «engine»`. */
function frameLabel(db: CanvasDatabase): string {
  return `${db.name}  «${db.engine}»`;
}

/** The tables (types) persisted in a given database, in the model's type order —
 *  the exact set the matching frame renders. Exposed so the React details panel
 *  reuses the one mapping rule rather than re-deriving it. */
export function databaseTables(model: CanvasModel, dbId: string): CanvasType[] {
  const { typeDb } = computeMapping(model);
  return model.types.filter((t) => typeDb.get(t.id) === dbId);
}

/** Project the model into cytoscape elements for the databases view: one compound
 *  frame per database, one compound "table" per persisted type (header + field
 *  rows) nested in its frame, and FK edges labelled with cardinality. Fully
 *  preset-positioned. */
function buildElements(model: CanvasModel, mapping: DbMapping): cytoscape.ElementDefinition[] {
  const els: cytoscape.ElementDefinition[] = [];
  const { dbFrames, typeDb } = mapping;
  if (dbFrames.length === 0) return els;

  // The tables in scope: every type mapped to a database, indexed by id.
  const tables = model.types.filter((t) => typeDb.has(t.id));
  const tableIds = new Set(tables.map((t) => t.id));

  // Foreign keys: any type edge FROM a table on a given field marks that field as
  // an FK (drives per-field edge anchoring + row markers). Both ends must be
  // in-scope tables.
  const fkFields = new Map<string, Set<string>>();
  for (const e of model.typeEdges) {
    if (!tableIds.has(e.from) || !tableIds.has(e.to)) continue;
    let set = fkFields.get(e.from);
    if (!set) fkFields.set(e.from, (set = new Set()));
    set.add(e.field);
  }

  // Aggregated reference graph (to→from) for dependency layering within a frame.
  const refTo = new Map<string, Set<string>>();
  for (const e of model.typeEdges) {
    if (!tableIds.has(e.from) || !tableIds.has(e.to) || e.from === e.to) continue;
    (refTo.get(e.to) ?? refTo.set(e.to, new Set()).get(e.to)!).add(e.from);
  }

  const markerOf = (t: CanvasType, f: CanvasType['fields'][number]): string => {
    if (f.key === 'primary') return 'PK';
    if (f.key === 'unique') return 'U';
    if (f.key === 'foreign') return 'FK';
    if (fkFields.get(t.id)?.has(f.name)) return 'FK';
    if (f.references) return 'FK';
    return '';
  };
  const rowText = (t: CanvasType, f: CanvasType['fields'][number]): string => {
    const m = markerOf(t, f);
    return (m ? `[${m}] ` : '') + f.name + (f.optional ? '?' : '') + ': ' + f.type;
  };

  const shapeOf = (t: CanvasType): TableShape => {
    const head = `${t.name}  «${t.kind}»`;
    const rows = t.fields.map((f) => rowText(t, f));
    let longest = head.length + 4;
    for (const r of rows) if (r.length > longest) longest = r.length;
    const plain = rows.length === 0;
    const w = plain ? Math.max(170, head.length * 6.8 + 26) : Math.max(210, Math.min(400, longest * 6.6 + 30));
    const h = plain ? 40 : TH_H + t.fields.length * ROW_H;
    return { fields: t.fields, head, plain, w, h };
  };
  const shapes = new Map<string, TableShape>(tables.map((t) => [t.id, shapeOf(t)]));

  // Longest-path layer (0 = no incoming refs) — upstream tables sit left. Layers
  // are computed globally (edges may cross frames) so a referenced table sits left
  // of its referrer even across a database boundary.
  const layer = new Map<string, number>();
  const calc = (id: string, stack: Set<string>): number => {
    const memo = layer.get(id);
    if (memo !== undefined) return memo;
    if (stack.has(id)) return 0; // break reference cycles
    stack.add(id);
    let l = 0;
    for (const from of refTo.get(id) ?? []) l = Math.max(l, calc(from, stack) + 1);
    stack.delete(id);
    layer.set(id, l);
    return l;
  };
  for (const t of tables) calc(t.id, new Set());

  // Group tables by database frame (spec order preserved via dbFrames).
  const groups = new Map<string, CanvasType[]>();
  for (const t of tables) {
    const dbId = typeDb.get(t.id)!;
    (groups.get(dbId) ?? groups.set(dbId, []).get(dbId)!).push(t);
  }

  const rowIds = new Set<string>();

  // Emit one table with its top-left at (ax, ay); returns its rendered size.
  const emitTable = (t: CanvasType, ax: number, ay: number, parentId: string): TableShape => {
    const sh = shapes.get(t.id)!;
    const cls = isEntityKind(t.kind) ? '' : ' val';
    if (sh.plain) {
      els.push({
        data: { id: `T~${t.id}`, typeId: t.id, parent: parentId, label: sh.head, w: sh.w, h: 40, tw: sh.w - 12, color: 'PAL' },
        position: { x: ax + sh.w / 2, y: ay + 20 },
        classes: `leaf typePlain${cls}`,
      });
      return sh;
    }
    els.push({ data: { id: `T~${t.id}`, typeId: t.id, parent: parentId, color: 'PAL' }, classes: `typeBox${cls}` });
    els.push({
      data: { id: `TH~${t.id}`, typeId: t.id, parent: `T~${t.id}`, label: sh.head, w: sh.w, h: TH_H, tw: sh.w - 12, color: 'PAL' },
      position: { x: ax + sh.w / 2, y: ay + TH_H / 2 },
      classes: 'leaf typeHead',
      grabbable: false,
    });
    let ry = ay + TH_H;
    for (const f of sh.fields) {
      const isFk = markerOf(t, f) === 'FK';
      const rid = `TF~${t.id}~${f.name}`;
      rowIds.add(rid);
      els.push({
        data: { id: rid, typeId: t.id, parent: `T~${t.id}`, label: rowText(t, f), w: sh.w, h: ROW_H, tw: sh.w - 14 },
        position: { x: ax + sh.w / 2, y: ry + ROW_H / 2 },
        classes: `leaf typeRow${isFk ? ' fkRow' : ''}`,
        grabbable: false,
      });
      ry += ROW_H;
    }
    return sh;
  };

  // Place each database as a band of dependency-layered columns, stacked top→down.
  // An empty database still renders its (labelled) frame so the schema is honest.
  let groupY = 0;
  for (const db of dbFrames) {
    const frameId = `D~${db.id}`;
    els.push({ data: { id: frameId, dbId: db.id, label: frameLabel(db) }, classes: 'dbFrame' });

    const members = groups.get(db.id) ?? [];
    // Columns keyed by dependency layer.
    const cols = new Map<number, CanvasType[]>();
    for (const t of members) {
      const l = layer.get(t.id) ?? 0;
      (cols.get(l) ?? cols.set(l, []).get(l)!).push(t);
    }
    const colKeys = [...cols.keys()].sort((a, b) => a - b);
    let x = 0;
    let groupH = 0;
    for (const ck of colKeys) {
      const col = cols.get(ck)!.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
      let y = groupY;
      let colW = 210;
      for (const t of col) {
        const sh = emitTable(t, x, y, frameId);
        y += sh.h + TABLE_GAP_Y;
        if (sh.w > colW) colW = sh.w;
      }
      groupH = Math.max(groupH, y - groupY);
      x += colW + COL_GAP;
    }
    // Reserve a minimum band height so an empty frame still shows its label.
    groupY += Math.max(groupH, 70) + GROUP_GAP;
  }

  // FK relationship edges. Anchor at the originating field row when present so the
  // line leaves the exact FK, mirroring the standalone ERD. Both endpoints must be
  // in-scope tables (edges may cross database frames).
  let ei = 0;
  for (const e of model.typeEdges) {
    if (!tableIds.has(e.from) || !tableIds.has(e.to)) continue;
    const rowId = `TF~${e.from}~${e.field}`;
    els.push({
      data: {
        id: `de${ei++}`,
        source: rowIds.has(rowId) ? rowId : `T~${e.from}`,
        target: `T~${e.to}`,
        card: e.card,
        fromType: e.from,
        toType: e.to,
      },
      classes: 'erd',
    });
  }

  return els;
}

/**
 * Mount the databases canvas into `container`. The container should be a sized
 * block element; the caller owns its lifecycle and must call `handle.destroy()`
 * on unmount.
 */
export function mountDatabases(container: HTMLElement, model: CanvasModel, opts: DatabasesOptions = {}): DbHandle {
  const pal = readPalette(container);

  let mapping = computeMapping(model);

  // Bake per-type kind colours into the elements (cytoscape reads `data(color)`).
  function coloredElements(m: CanvasModel, map: DbMapping): cytoscape.ElementDefinition[] {
    const kindById = new Map(m.types.map((t) => [t.id, t.kind] as const));
    const els = buildElements(m, map);
    for (const el of els) {
      const d = el.data as Record<string, unknown>;
      if (d && d.color === 'PAL' && typeof d.typeId === 'string') {
        d.color = kindColor(pal, kindById.get(d.typeId) ?? 'value');
      }
    }
    return els;
  }

  const cy = cytoscape({
    container,
    elements: coloredElements(model, mapping),
    style: buildStyle(pal),
    layout: { name: 'preset' },
    minZoom: 0.1,
    maxZoom: 3,
    wheelSensitivity: 0.2,
    boxSelectionEnabled: false,
    autounselectify: true,
  });

  let byId = new Map<string, CanvasType>(model.types.map((t) => [t.id, t]));
  // The current selection: a table (type id) via `T~…` or a database via `D~…`.
  let selectedNode: string | null = null;
  let query = '';

  function applyQuery(): void {
    cy.batch(() => {
      cy.elements().removeClass('dim match');
      const q = query.trim().toLowerCase();
      if (!q) return;
      // A database whose name/id matches lights its whole schema.
      const dbHit = new Set<string>();
      for (const d of mapping.dbFrames) {
        if (d.name.toLowerCase().includes(q) || d.id.toLowerCase().includes(q)) dbHit.add(d.id);
      }
      const hit = new Set<string>();
      for (const [tid, dbId] of mapping.typeDb) {
        const t = byId.get(tid);
        if (!t) continue;
        if (t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q) || dbHit.has(dbId)) hit.add(tid);
      }
      cy.nodes().forEach((n) => {
        const tid = n.data('typeId') as string | undefined;
        if (!tid) return;
        if (hit.has(tid)) {
          if (n.hasClass('typeBox') || n.hasClass('typePlain')) n.addClass('match');
        } else {
          n.addClass('dim');
        }
      });
      // A db frame lights if its name matched, else stays lit only if a table did.
      cy.nodes('.dbFrame').forEach((f) => {
        const dbId = f.data('dbId') as string;
        if (dbHit.has(dbId)) f.addClass('match');
        else if (f.descendants('.match').length === 0) f.addClass('dim');
      });
      // Dim an edge whenever either endpoint table is dimmed.
      cy.edges().forEach((e) => {
        const ft = e.data('fromType') as string | undefined;
        const tt = e.data('toType') as string | undefined;
        if ((ft && !hit.has(ft)) || (tt && !hit.has(tt))) e.addClass('dim');
      });
    });
  }

  function applySelection(): void {
    cy.nodes('.sel').removeClass('sel');
    if (selectedNode) cy.getElementById(selectedNode).addClass('sel');
  }

  /** Resolve a caller-supplied id (table type id or database id) to its node id. */
  function nodeIdFor(id: string): string | null {
    if (mapping.typeDb.has(id)) return `T~${id}`;
    if (mapping.dbById.has(id)) return `D~${id}`;
    return null;
  }

  /** Build the selection payload for a node id (or null when it maps to nothing). */
  function selectionFor(nodeId: string | null): DbSelection | null {
    if (!nodeId) return null;
    if (nodeId.startsWith('D~')) {
      const db = mapping.dbById.get(nodeId.slice(2));
      return db ? { kind: 'database', database: db } : null;
    }
    if (nodeId.startsWith('T~')) {
      const t = byId.get(nodeId.slice(2));
      return t ? { kind: 'table', type: t } : null;
    }
    return null;
  }

  cy.on('tap', 'node.dbFrame', (evt: cytoscape.EventObject) => {
    selectedNode = evt.target.id();
    applySelection();
    opts.onSelect?.(selectionFor(selectedNode));
  });
  cy.on('tap', 'node[typeId]', (evt: cytoscape.EventObject) => {
    const tid = evt.target.data('typeId') as string | undefined;
    if (!tid) return;
    selectedNode = `T~${tid}`;
    applySelection();
    opts.onSelect?.(selectionFor(selectedNode));
  });
  cy.on('tap', (evt: cytoscape.EventObject) => {
    if (evt.target === cy) {
      selectedNode = null;
      applySelection();
      opts.onSelect?.(null);
    }
  });

  cy.fit(undefined, FIT_PADDING);

  return {
    cy,
    fit: () => cy.fit(undefined, FIT_PADDING),
    applyModel: (next: CanvasModel) => {
      mapping = computeMapping(next);
      byId = new Map(next.types.map((t) => [t.id, t]));
      cy.batch(() => {
        cy.elements().remove();
        cy.add(coloredElements(next, mapping));
      });
      if (selectedNode && cy.getElementById(selectedNode).empty()) {
        selectedNode = null;
        opts.onSelect?.(null);
      }
      cy.fit(undefined, FIT_PADDING);
      applyQuery();
      applySelection();
    },
    setQuery: (q: string) => {
      query = q;
      applyQuery();
    },
    select: (id: string | null) => {
      selectedNode = id ? nodeIdFor(id) : null;
      applySelection();
      opts.onSelect?.(selectionFor(selectedNode));
    },
    destroy: () => cy.destroy(),
  };
}
