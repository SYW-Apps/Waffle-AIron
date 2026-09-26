import type {
  ComponentSpec,
  InterfaceSpec,
  PublicInterface,
  SubsystemSpec,
  SystemPublicInterface,
  SystemSpec,
  TypeSpec,
} from '../models/index.js';
import {
  PUBLIC_NAME_RE,
  exportTargetKey,
  type ExportProblem,
  type ResolvedExport,
  type ResolvedExportTable,
} from '../models/exports.js';
// export_index projects the scanned specs the Spec Index holds — the one
// sanctioned case of an Index over another Index of the same Repository.
import { loadComponentSpecs, loadInterfaceSpecs, loadSubsystemSpecs, loadSystemSpec, loadTypeSpecs } from './specs.js';

// ---------------------------------------------------------------------------
// export_index — export tables, resolved the way a module resolver resolves
// `export … from`.
//
// A subsystem's table (its L1 publicInterfaces) holds OWN items — a component
// or type it owns — and RE-EXPORTS: `from` another subsystem, one component,
// interface narrowing or type (optionally renamed with `as`), or everything
// that subsystem exports (a wildcard). The project's table (L0) re-exports
// from its subsystems the same way. Every chain is followed to its canonical
// target once per scan and memoized on it, so however many consumers read a
// table, it is walked once.
//
// Nothing here judges: every problem is returned as a fact, and the
// export-tables rule decides what each one is worth. Two leniencies keep every
// existing published name where it is until stage 4 makes the problems
// errors: an item the source owns but does not export is still bound, and a
// malformed public name is still bound — each reported as EXPORT_INVALID.
// ---------------------------------------------------------------------------

/** The stereotypes a boundary caller may reach — a gateway is a Portal variant. */
const CONSUMABLE: ReadonlySet<string> = new Set(['Portal', 'Observer']);

/** The last segment of a possibly-qualified id. */
function localName(id: string): string {
  return id.split('::').pop() ?? id;
}

/** Whether the subsystem owns a spec declared in `declaringSubsystem` (itself, or a subsystem of its mount). */
function ownedBy(subsystemId: string, declaringSubsystem: string | undefined): boolean {
  return declaringSubsystem !== undefined
    && (declaringSubsystem === subsystemId || declaringSubsystem.startsWith(`${subsystemId}::`));
}

/** The scanned specs a resolution reads, indexed once. */
interface ExportWorld {
  subsystems: Map<string, SubsystemSpec>;
  components: Map<string, ComponentSpec>;
  interfaces: Map<string, InterfaceSpec>;
  /** Types by id — several when subsystems each own a type of one name. */
  types: Map<string, TypeSpec[]>;
}

function worldOf(
  subsystems: SubsystemSpec[],
  components: ComponentSpec[],
  interfaces: InterfaceSpec[],
  types: TypeSpec[],
): ExportWorld {
  return {
    subsystems: new Map(subsystems.map((s) => [s.id, s])),
    components: new Map(components.map((c) => [c.id, c])),
    interfaces: new Map(interfaces.map((i) => [i.id, i])),
    types: types.reduce((m, t) => m.set(t.id, [...(m.get(t.id) ?? []), t]), new Map<string, TypeSpec[]>()),
  };
}

/** A spec by its id as written, else qualified into the namespace it was written for. */
function lookup<T>(map: Map<string, T>, ref: string | undefined, namespace: string | undefined): T | undefined {
  if (!ref) return undefined;
  return map.get(ref) ?? (namespace ? map.get(`${namespace}::${ref}`) : undefined);
}

/**
 * A type by its id as written (else qualified into the subsystem's namespace),
 * preferring the one that subsystem owns when several share the id.
 */
function lookupType(world: ExportWorld, ref: string | undefined, subsystemId: string): TypeSpec | undefined {
  const candidates = lookup(world.types, ref, subsystemId);
  return candidates?.find((t) => ownedBy(subsystemId, t.subsystem)) ?? candidates?.[0];
}

/** One public name a level binds, before the table is settled. */
interface Candidate {
  entry: ResolvedExport;
  /** Own items and named re-exports shadow what a wildcard brings in. */
  explicit: boolean;
  /** The index of the declaring entry, so a clash names the entries it came from. */
  from: number;
}

/** Report a malformed public name — still bound, so no existing name moves. */
function checkPublicName(name: string, owner: string, problems: ExportProblem[]): void {
  if (!PUBLIC_NAME_RE.test(name)) {
    problems.push({
      kind: 'invalid',
      owner,
      publicName: name,
      detail: `public name "${name}" breaks [a-z0-9-_]+ — rename it with \`as\``,
    });
  }
}

/** Report a re-exported component no boundary caller can reach. */
function checkConsumable(entry: ResolvedExport, owner: string, problems: ExportProblem[]): void {
  if (entry.kind === 'component' && entry.componentType && !CONSUMABLE.has(entry.componentType)) {
    problems.push({
      kind: 'unconsumable',
      owner,
      publicName: entry.publicName,
      targets: [entry.component!],
      detail: `"${entry.publicName}" exports ${entry.componentType} "${entry.component}", which no caller across the boundary may reach — only a Portal (a gateway is a Portal variant) or an Observer can serve one`,
    });
  }
}

// ---- named re-exports -------------------------------------------------------

/** What a named re-export asks its source for. */
interface NamedRequest {
  component?: string;
  interface?: string;
  typeDef?: string;
}

/**
 * Find the item a named re-export names in its source's table: the component
 * (its whole export, or the narrowing asked for) or the type. A narrowing of
 * a component the source exports whole is a narrowing, not a miss.
 */
function findInSource(
  world: ExportWorld,
  source: SubsystemSpec,
  table: ResolvedExportTable,
  request: NamedRequest,
): { found?: ResolvedExport; item?: ResolvedExport } {
  if (request.typeDef) {
    const type = lookupType(world, request.typeDef, source.id);
    if (!type) return {};
    const item: ResolvedExport = { publicName: localName(type.id), kind: 'type', source: type.subsystem ?? source.id, typeDef: type.id, via: [] };
    return { item, found: table.entries.find((e) => e.kind === 'type' && e.typeDef === type.id && e.source === item.source) };
  }
  // A narrowing alone names its component: the interface's own.
  const intf = lookup(world.interfaces, request.interface, source.id);
  const comp = lookup(world.components, request.component ?? intf?.component, source.id);
  if (!comp) return {};
  const narrowed = intf?.id ?? request.interface;
  const item: ResolvedExport = {
    publicName: localName(narrowed ?? comp.id),
    kind: 'component',
    source: comp.subsystem,
    component: comp.id,
    ...(narrowed ? { interface: narrowed } : {}),
    componentType: comp.componentType,
    via: [],
  };
  const exported = table.entries.filter((e) => e.kind === 'component' && e.component === comp.id);
  const found = narrowed
    ? exported.find((e) => e.interface === narrowed) ?? exported.find((e) => e.interface === undefined)
    : exported.find((e) => e.interface === undefined) ?? exported[0];
  return { item, found: found && narrowed ? { ...found, interface: narrowed } : found };
}

/**
 * Bind one named re-export against its source's table. Not found there: in
 * a group of levels that re-export each other the chain never grounds (a
 * named cycle); elsewhere the source does not export it — bound anyway when
 * the source owns the item, so no existing name moves, and reported.
 */
function bindNamed(
  world: ExportWorld,
  owner: string,
  source: SubsystemSpec,
  sourceTable: ResolvedExportTable,
  request: NamedRequest,
  publicName: (item: ResolvedExport) => string,
  inCycle: boolean,
  problems: ExportProblem[],
): ResolvedExport | undefined {
  const { found, item } = findInSource(world, source, sourceTable, request);
  const what = request.typeDef ? `type "${request.typeDef}"` : `component "${request.component}"${request.interface ? ` (interface "${request.interface}")` : ''}`;
  if (!item) {
    problems.push({ kind: 'invalid', owner, detail: `re-exports ${what} from "${source.id}", which has no such item` });
    return undefined;
  }
  const name = publicName(item);
  if (found) return { ...found, publicName: name, via: [source.id, ...found.via] };
  if (inCycle) {
    problems.push({ kind: 'named-cycle', owner, publicName: name, targets: [owner, source.id], detail: `re-exports ${what} from "${source.id}", but the chain leads back to "${owner}" without reaching the item` });
    return undefined;
  }
  const declaring = item.source;
  if (!ownedBy(source.id, declaring)) {
    problems.push({ kind: 'invalid', owner, publicName: name, detail: `re-exports ${what} from "${source.id}", which neither exports nor owns it` });
    return undefined;
  }
  problems.push({ kind: 'invalid', owner, publicName: name, detail: `re-exports ${what} from "${source.id}", which does not export it — publish it there first` });
  return { ...item, publicName: name, via: [source.id] };
}

// ---- subsystem tables -------------------------------------------------------

/** Bind a subsystem's OWN items: a component or type it owns. */
function bindOwn(world: ExportWorld, sub: SubsystemSpec, pi: PublicInterface, problems: ExportProblem[]): ResolvedExport | undefined {
  if (pi.typeDef) {
    const type = lookupType(world, pi.typeDef, sub.id);
    if (!type || !ownedBy(sub.id, type.subsystem)) {
      problems.push({ kind: 'invalid', owner: sub.id, detail: `exports type "${pi.typeDef}" as its own, but ${type ? `it belongs to "${type.subsystem ?? 'the system'}"` : 'no such type exists'}` });
      return undefined;
    }
    const name = pi.as ?? localName(type.id);
    checkPublicName(name, sub.id, problems);
    return { publicName: name, kind: 'type', source: type.subsystem ?? sub.id, typeDef: type.id, via: [] };
  }
  // An unbound, unknown or foreign own component is the public-surface rules'
  // finding (PUBLIC_INTERFACE_*); it simply exports nothing here.
  const comp = lookup(world.components, pi.component, sub.id);
  if (!comp || !ownedBy(sub.id, comp.subsystem)) return undefined;
  const intf = lookup(world.interfaces, pi.interface, sub.id);
  const narrowed = intf?.id ?? pi.interface;
  const name = pi.as ?? localName(narrowed ?? comp.id);
  checkPublicName(name, sub.id, problems);
  return {
    publicName: name,
    kind: 'component',
    source: sub.id,
    component: comp.id,
    ...(narrowed ? { interface: narrowed } : {}),
    componentType: comp.componentType,
    ...(pi.type ? { type: pi.type } : {}),
    ...(pi.details !== undefined ? { details: pi.details } : {}),
    via: [],
  };
}

/** Compute one subsystem's candidates against the tables resolved so far. */
function subsystemCandidates(
  world: ExportWorld,
  sub: SubsystemSpec,
  tables: Map<string, ResolvedExportTable>,
  group: ReadonlySet<string>,
  problems: ExportProblem[],
): Candidate[] {
  const out: Candidate[] = [];
  sub.publicInterfaces.forEach((pi, index) => {
    if (pi.from === undefined) {
      const own = bindOwn(world, sub, pi, problems);
      if (own) out.push({ entry: own, explicit: true, from: index });
      return;
    }
    const source = world.subsystems.get(pi.from);
    if (!source || source.id === sub.id) {
      problems.push({ kind: 'invalid', owner: sub.id, detail: source ? `re-exports from itself` : `re-exports from "${pi.from}", which is not a subsystem of this project` });
      return;
    }
    const sourceTable = tables.get(source.id) ?? emptyTable(source.id, 'subsystem');
    if (pi.component !== undefined || pi.typeDef !== undefined || pi.interface !== undefined) {
      const bound = bindNamed(world, sub.id, source, sourceTable,
        { component: pi.component, interface: pi.interface, typeDef: pi.typeDef },
        (item) => pi.as ?? localName(pi.interface ?? item.typeDef ?? item.component ?? ''),
        group.has(source.id), problems);
      if (!bound) return;
      checkPublicName(bound.publicName, sub.id, problems);
      const entry = { ...bound, ...(pi.type ? { type: pi.type } : {}), ...(pi.details !== undefined ? { details: pi.details } : {}) };
      checkConsumable(entry, sub.id, problems);
      out.push({ entry, explicit: true, from: index });
      return;
    }
    for (const e of sourceTable.entries) {
      const entry = { ...e, via: [source.id, ...e.via] };
      checkConsumable(entry, sub.id, problems);
      out.push({ entry, explicit: false, from: index });
    }
  });
  return out;
}

function emptyTable(owner: string, level: 'subsystem' | 'project'): ResolvedExportTable {
  return { owner, level, entries: [], problems: [] };
}

/**
 * Settle a level's candidates into its table: an own or explicit entry
 * shadows what a wildcard brings in, the same target twice is one entry, and
 * one name bound to different targets — explicit against explicit, or
 * wildcard against wildcard — is a duplicate left out of the table.
 */
function settle(owner: string, level: 'subsystem' | 'project', candidates: Candidate[], problems: ExportProblem[]): ResolvedExportTable {
  const byName = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byName.get(c.entry.publicName) ?? [];
    list.push(c);
    byName.set(c.entry.publicName, list);
  }
  const entries: ResolvedExport[] = [];
  for (const [name, list] of byName) {
    const explicit = list.filter((c) => c.explicit);
    const pool = explicit.length ? explicit : list;
    const targets = [...new Set(pool.map((c) => exportTargetKey(c.entry)))];
    if (targets.length === 1) {
      entries.push(pool[0].entry);
      continue;
    }
    problems.push({
      kind: 'duplicate',
      owner,
      publicName: name,
      targets,
      detail: `"${name}" is bound to ${targets.length} different targets (${targets.join(', ')}) by ${explicit.length ? 'explicit entries' : 'wildcard re-exports'}; it is left out of the table`,
    });
  }
  return { owner, level, entries, problems };
}

/** The strongly connected groups of the `from` graph, sources before their readers. */
function groupsInDependencyOrder(world: ExportWorld): string[][] {
  const edges = new Map<string, string[]>();
  for (const sub of world.subsystems.values()) {
    edges.set(sub.id, sub.publicInterfaces
      .map((pi) => pi.from)
      .filter((f): f is string => f !== undefined && f !== sub.id && world.subsystems.has(f)));
  }
  // Tarjan: groups come out sources-first (a group is emitted after every group it reaches).
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  let next = 0;
  const visit = (v: string): void => {
    index.set(v, next); low.set(v, next); next++;
    stack.push(v); onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const group: string[] = [];
      let w: string;
      do { w = stack.pop()!; onStack.delete(w); group.push(w); } while (w !== v);
      groups.push(group.sort());
    }
  };
  for (const id of [...world.subsystems.keys()].sort()) if (!index.has(id)) visit(id);
  return groups;
}

/** The names-to-targets fingerprint of a table, for the fixpoint over a group. */
function fingerprint(table: ResolvedExportTable): string {
  return table.entries.map((e) => `${e.publicName}=${exportTargetKey(e)}`).sort().join('|');
}

/**
 * Resolve every subsystem's table, a group of mutually re-exporting
 * subsystems at a time. A group is iterated until its tables stop changing —
 * a wildcard cycle resolves to its union — and a group whose members
 * re-export each other through wildcards is recorded once as a wildcard
 * cycle on its first member.
 */
export function resolveSubsystemTables(
  subsystems: SubsystemSpec[],
  components: ComponentSpec[],
  interfaces: InterfaceSpec[],
  types: TypeSpec[],
): Map<string, ResolvedExportTable> {
  const world = worldOf(subsystems, components, interfaces, types);
  const tables = new Map<string, ResolvedExportTable>();
  for (const group of groupsInDependencyOrder(world)) {
    const members = new Set(group);
    const cyclic = group.length > 1;
    // A lone subsystem reads only settled sources, so one pass settles it;
    // a group reads its own members and is iterated to its union.
    for (let pass = 0, changed = true; changed && pass <= (cyclic ? group.length * 4 + 4 : 0); pass++) {
      changed = false;
      for (const id of group) {
        const problems: ExportProblem[] = [];
        const table = settle(id, 'subsystem', subsystemCandidates(world, world.subsystems.get(id)!, tables, cyclic ? members : new Set(), problems), problems);
        const before = tables.get(id);
        if (!before || fingerprint(before) !== fingerprint(table)) changed = true;
        tables.set(id, table);
      }
    }
    const wildcardLoop = cyclic && group.some((id) => world.subsystems.get(id)!.publicInterfaces
      .some((pi) => pi.from !== undefined && pi.component === undefined && pi.typeDef === undefined && pi.interface === undefined && members.has(pi.from)));
    if (wildcardLoop) {
      tables.get(group[0])!.problems.push({
        kind: 'wildcard-cycle',
        owner: group[0],
        targets: group,
        detail: `subsystems ${group.map((g) => `"${g}"`).join(', ')} re-export each other through wildcards; their tables resolve to the union, but they form one circular module surface`,
      });
    }
  }
  return tables;
}

// ---- the project table ------------------------------------------------------

/** Where a legacy or bare L0 entry re-exports from: `from`, `subsystem`, else its item's owner. */
function sourceOf(world: ExportWorld, e: SystemPublicInterface): string | undefined {
  if (e.from ?? e.subsystem) return e.from ?? e.subsystem;
  if (e.component) return world.components.get(e.component)?.subsystem;
  if (e.interface) {
    const intf = world.interfaces.get(e.interface);
    return intf ? world.components.get(intf.component)?.subsystem : undefined;
  }
  if (e.typeDef) return world.types.get(e.typeDef)?.[0]?.subsystem;
  return undefined;
}

/** Carry an L0 entry's own metadata onto every name it brings in. */
function withEntryMetadata(entry: ResolvedExport, e: SystemPublicInterface): ResolvedExport {
  return {
    ...entry,
    audience: e.audience ?? 'instance',
    ...(e.name ? { name: e.name } : {}),
    ...(e.type ? { type: e.type } : {}),
    ...(e.details !== undefined ? { details: e.details } : {}),
    ...(e.authPolicy ? { authPolicy: e.authPolicy } : {}),
    ...(e.version ? { version: e.version } : {}),
    ...(e.stability ? { stability: e.stability } : {}),
  };
}

/**
 * Resolve the project's L0 table through the subsystem tables. The public
 * name is `as ?? id ?? interface ?? component` (or the typeDef) exactly as the
 * entry writes it, so no existing name moves; each entry's audience (default
 * instance) applies to every name it brings in.
 */
export function resolveProjectTable(
  system: SystemSpec,
  subsystems: SubsystemSpec[],
  components: ComponentSpec[],
  interfaces: InterfaceSpec[],
  types: TypeSpec[],
  subsystemTables: Map<string, ResolvedExportTable>,
): ResolvedExportTable {
  const world = worldOf(subsystems, components, interfaces, types);
  const owner = system.name;
  const problems: ExportProblem[] = [];
  const candidates: Candidate[] = [];
  (system.publicInterfaces ?? []).forEach((e, index) => {
    const sourceId = sourceOf(world, e);
    const source = sourceId ? world.subsystems.get(sourceId) : undefined;
    if (!source) {
      const label = e.as ?? e.id ?? e.interface ?? e.component ?? e.typeDef ?? `#${index + 1}`;
      problems.push({ kind: 'invalid', owner, publicName: label, detail: sourceId ? `"${label}" re-exports from "${sourceId}", which is not a subsystem of this project` : `"${label}" names no source subsystem and no item whose owner could supply one` });
      return;
    }
    const sourceTable = subsystemTables.get(source.id) ?? emptyTable(source.id, 'subsystem');
    if (e.component !== undefined || e.typeDef !== undefined || e.interface !== undefined) {
      const bound = bindNamed(world, owner, source, sourceTable,
        { component: e.component, interface: e.interface, typeDef: e.typeDef },
        () => e.as ?? e.id ?? e.interface ?? e.component ?? e.typeDef!,
        false, problems);
      if (!bound) return;
      checkPublicName(bound.publicName, owner, problems);
      const entry = withEntryMetadata(bound, e);
      checkConsumable(entry, owner, problems);
      candidates.push({ entry, explicit: true, from: index });
      return;
    }
    for (const found of sourceTable.entries) {
      const entry = withEntryMetadata({ ...found, via: [source.id, ...found.via] }, e);
      checkConsumable(entry, owner, problems);
      candidates.push({ entry, explicit: false, from: index });
    }
  });
  return settle(owner, 'project', candidates, problems);
}

// ---- the Index: memoized on the scan ----------------------------------------

/** The tables a scan resolved to, dropped with the scan's subsystem list. */
const subsystemMemo = new WeakMap<SubsystemSpec[], Map<string, ResolvedExportTable>>();
/** The project table per scan, keyed again on the L0 entries it read (the L0 is read per call). */
const projectMemo = new WeakMap<SubsystemSpec[], { key: string; table: ResolvedExportTable }>();

/** The scan's subsystem tables, resolved once per scan. */
function scanTables(subsystems: SubsystemSpec[]): Map<string, ResolvedExportTable> {
  const memo = subsystemMemo.get(subsystems);
  if (memo) return memo;
  const tables = resolveSubsystemTables(subsystems, loadComponentSpecs(), loadInterfaceSpecs(), loadTypeSpecs());
  subsystemMemo.set(subsystems, tables);
  return tables;
}

/** iexport_index.resolveSubsystemExports — one subsystem's resolved export table. */
export function resolveSubsystemExportTable(subsystemId: string): ResolvedExportTable {
  // Steps 1-12: the scan's subsystems, and their tables resolved once per scan.
  const tables = scanTables(loadSubsystemSpecs());
  // Steps 13-14: the requested table, empty for a subsystem the tree does not have.
  return tables.get(subsystemId) ?? emptyTable(subsystemId, 'subsystem');
}

/** iexport_index.resolveProjectExports — the project's resolved L0 export table. */
export function resolveProjectExportTable(): ResolvedExportTable {
  // Steps 1-3: no L0, nothing exported.
  const system = loadSystemSpec();
  if (!system) return emptyTable('', 'project');
  // Steps 4-5: memoized on the scan and the L0 entries it read.
  const subsystems = loadSubsystemSpecs();
  const key = JSON.stringify([system.name, system.publicInterfaces ?? []]);
  const memo = projectMemo.get(subsystems);
  if (memo && memo.key === key) return memo.table;
  // Steps 6-12: each source's table (memoized with the scan), the entries
  // bound through them, and the settled table memoized.
  const subsystemTables = new Map(subsystems.map((sub) => [sub.id, resolveSubsystemExportTable(sub.id)] as const));
  const table = resolveProjectTable(system, subsystems, loadComponentSpecs(), loadInterfaceSpecs(), loadTypeSpecs(), subsystemTables);
  projectMemo.set(subsystems, { key, table });
  return table;
}
