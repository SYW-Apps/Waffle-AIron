import {
  SURFACE_AUDIENCES,
  nameKey,
  parseDeclaredCall,
  type AuthoredReference,
  type ComponentSpec,
  type CrossProjectReference,
  type InterfaceSpec,
  type PublicInterface,
  type SubsystemSpec,
  type SystemPublicInterface,
  type SystemSpec,
  type TypeSpec,
} from '../models/index.js';
import {
  PUBLIC_NAME_RE,
  exportTargetKey,
  type ExportProblem,
  type ExportUsage,
  type ResolvedExport,
  type ResolvedExportTable,
} from '../models/exports.js';
// export_index projects the tables the Spec Index's scan resolved — the one
// sanctioned case of an Index over another Index of the same Repository.
import { listProjectRoots, loadComponentSpecs, loadImplementationSpecs } from './specs.js';
// ...and over the Project Family Index of the same Repository, for the
// the references the scan bound, counted into each consumer's usage (never in
// a cycle: the family index depends on the Spec Index alone).
import { projectFamilyGraph } from './project-family.js';

// ---------------------------------------------------------------------------
// export_resolver and export_index — export tables, resolved the way a module
// resolver resolves `export … from`.
//
// The resolver (resolveSubsystemTables, resolveProjectTable) is pure logic over
// the specs it is handed: the Spec Index's scan calls it for every project, in
// dependency order, before it binds any `alias::name`. The Index
// (resolveSubsystemExportTable, resolveProjectExportTable, exportUsageOf) only
// projects what that scan recorded.
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
  // Two public names bound to different targets that share one nameKey
  // (`shared-error`, `shared_error`) are a duplicate too: a consumer's bare
  // `use` import compares by that key and could not tell them apart.
  const byKey = new Map<string, ResolvedExport[]>();
  for (const e of entries) byKey.set(nameKey(e.publicName), [...(byKey.get(nameKey(e.publicName)) ?? []), e]);
  const clashing = new Set<ResolvedExport>();
  for (const group of byKey.values()) {
    const targets = [...new Set(group.map((e) => exportTargetKey(e)))];
    if (group.length < 2 || targets.length < 2) continue;
    group.forEach((e) => clashing.add(e));
    problems.push({
      kind: 'duplicate',
      owner,
      publicName: group.map((e) => e.publicName).join(', '),
      targets,
      detail: `the public names ${group.map((e) => `"${e.publicName}"`).join(' and ')} share one name key and bind different targets (${targets.join(', ')}), so a bare \`use\` import could not tell them apart; both are left out of the table`,
    });
  }
  return { owner, level, entries: entries.filter((e) => !clashing.has(e)), problems };
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

/**
 * export_sources — what a project's L0 table may re-export from beyond its own
 * subsystems, handed to the pure resolver so it never reaches back into the
 * scan: the project's key, its alias table, and the already-resolved tables of
 * the producers those aliases name (null for one still on this path).
 */
export interface ExportSources {
  /** The key of the project whose table is resolved ('' for the bound root). */
  namespace: string;
  /** Each member or declared external alias → the key of the project it names in the scan. */
  aliases: Map<string, string>;
  /** Each named producer's resolved project table by key; null for one still being resolved (a cycle). */
  producerTables: Map<string, ResolvedExportTable | null>;
  /** For each producer key, the audience it shows this project. */
  audienceOf: Map<string, string>;
}

/** Where an L0 entry re-exports from: `from`, `subsystem`, else its item's owner; `own` for a project-level type. */
function sourceOf(world: ExportWorld, e: SystemPublicInterface): string | 'own' | undefined {
  if (e.from ?? e.subsystem) return e.from ?? e.subsystem;
  if (e.component) return world.components.get(e.component)?.subsystem;
  if (e.interface) {
    const intf = world.interfaces.get(e.interface);
    return intf ? world.components.get(intf.component)?.subsystem : undefined;
  }
  if (e.typeDef) {
    const candidates = world.types.get(e.typeDef) ?? [];
    if (candidates.some((t) => !t.subsystem)) return 'own';
    return candidates[0]?.subsystem;
  }
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

/** Ascending reach rank of an audience; unknown levels rank as instance. */
function reach(audience: string | undefined): number {
  const idx = (SURFACE_AUDIENCES as readonly string[]).indexOf(audience ?? 'instance');
  return idx === -1 ? (SURFACE_AUDIENCES as readonly string[]).indexOf('instance') : idx;
}

/** An L0 entry's source, classified. */
type EntrySource =
  | { kind: 'own' }
  | { kind: 'subsystem'; subsystem: SubsystemSpec }
  | { kind: 'project'; namespace: string; label: string }
  | { kind: 'unresolvable'; detail: string };

/** Classify a source: an own project-level type, one of the project's subsystems, a member or external by alias, else unresolvable. */
function classifySource(world: ExportWorld, sourceId: string | 'own' | undefined, label: string, sources: ExportSources): EntrySource {
  if (sourceId === 'own') return { kind: 'own' };
  if (!sourceId) return { kind: 'unresolvable', detail: `"${label}" names no source and no item whose owner could supply one` };
  const sub = world.subsystems.get(sourceId);
  if (sub) return { kind: 'subsystem', subsystem: sub };
  const producer = sources.aliases.get(sourceId);
  if (producer !== undefined) return { kind: 'project', namespace: producer, label: `"${sourceId}"` };
  return {
    kind: 'unresolvable',
    detail: `"${label}" re-exports from "${sourceId}", which is neither a subsystem of this project, a member nor a declared external the scan read — a project re-exports only from its subsystems, members and externals of its family`,
  };
}

/**
 * Step 10 for an entry with no source at all whose public name another entry
 * of the table also declares: what it most likely is — a stray copy of that
 * entry — said with both entry numbers, so the remedy is in the finding. Null
 * when the entry names a source, or no other entry shares its name.
 */
function duplicateDetail(entries: SystemPublicInterface[], index: number): string | null {
  const e = entries[index];
  if (e.from !== undefined || e.component !== undefined || e.interface !== undefined || e.typeDef !== undefined) return null;
  const name = e.as ?? e.id;
  if (name === undefined) return null;
  const other = entries.findIndex((x, i) => i !== index && (x.as ?? x.id) === name);
  if (other === -1) return null;
  return `has a duplicate entry "${name}": entry #${index + 1} names no source and no item, while entry #${other + 1} declares the same id — delete the copy (entry #${index + 1}), or give it a source and an item under an id of its own`;
}

/** Bind an own project-level type: the crate-root `pub struct`. */
function bindOwnType(world: ExportWorld, owner: string, e: SystemPublicInterface, problems: ExportProblem[]): ResolvedExport | undefined {
  const type = (world.types.get(e.typeDef!) ?? []).find((t) => !t.subsystem);
  if (!type) {
    problems.push({ kind: 'invalid', owner, publicName: e.as ?? e.id ?? localName(e.typeDef!), detail: `exports type "${e.typeDef}" as its own, but the project owns no project-level type of that id` });
    return undefined;
  }
  const name = e.as ?? e.id ?? localName(type.id);
  checkPublicName(name, owner, problems);
  return { publicName: name, kind: 'type', source: owner, typeDef: type.id, via: [] };
}

/**
 * Bind one L0 entry against another project's table: only its public names can
 * be bound, and an entry declaring a wider audience than the export it
 * re-exports is a widening — bound at the source's reach, since a re-export can
 * narrow reach, never widen it.
 */
function bindFromProject(
  owner: string,
  e: SystemPublicInterface,
  source: { namespace: string; label: string },
  table: ResolvedExportTable,
  index: number,
  problems: ExportProblem[],
): Candidate[] {
  const named = e.component !== undefined || e.typeDef !== undefined || e.interface !== undefined;
  const requested = named ? localName(e.interface ?? e.component ?? e.typeDef!) : undefined;
  const picked = named ? table.entries.filter((x) => x.publicName === requested) : table.entries;
  if (named && picked.length === 0) {
    problems.push({ kind: 'invalid', owner, publicName: e.as ?? e.id ?? requested, detail: `re-exports "${requested}" from ${source.label}, whose export table has no such public name — another project is reached only through its L0 exports` });
    return [];
  }
  const declared = e.audience ?? 'instance';
  return picked.map((found) => {
    const publicName = named ? (e.as ?? e.id ?? found.publicName) : found.publicName;
    const bound = withEntryMetadata({ ...found, publicName, via: [source.namespace, ...found.via] }, e);
    if (reach(declared) > reach(found.audience)) {
      problems.push({
        kind: 'widens',
        owner,
        publicName,
        targets: [declared, found.audience ?? 'instance'],
        detail: `"${publicName}" is re-exported from ${source.label} at audience ${declared}, wider than the ${found.audience ?? 'instance'} it is exported at there`,
      });
      bound.audience = found.audience ?? 'instance';
    }
    checkPublicName(publicName, owner, problems);
    checkConsumable(bound, owner, problems);
    return { entry: bound, explicit: named, from: index };
  });
}

/** Bind one L0 entry through its source subsystem's table. */
function bindFromSubsystem(
  world: ExportWorld,
  owner: string,
  e: SystemPublicInterface,
  subsystem: SubsystemSpec,
  subsystemTables: Map<string, ResolvedExportTable>,
  index: number,
  problems: ExportProblem[],
): Candidate[] {
  const sourceTable = subsystemTables.get(subsystem.id) ?? emptyTable(subsystem.id, 'subsystem');
  if (e.component !== undefined || e.typeDef !== undefined || e.interface !== undefined) {
    const bound = bindNamed(world, owner, subsystem, sourceTable,
      { component: e.component, interface: e.interface, typeDef: e.typeDef },
      // The default public name is the item's own LOCAL id: a member's L0 is
      // read with its ids keyed under its project, and its entry names the
      // item as the member wrote it.
      () => e.as ?? e.id ?? localName(e.interface ?? e.component ?? e.typeDef!),
      false, problems);
    if (!bound) return [];
    checkPublicName(bound.publicName, owner, problems);
    const entry = withEntryMetadata(bound, e);
    checkConsumable(entry, owner, problems);
    return [{ entry, explicit: true, from: index }];
  }
  return sourceTable.entries.map((found) => {
    const entry = withEntryMetadata({ ...found, via: [subsystem.id, ...found.via] }, e);
    checkConsumable(entry, owner, problems);
    return { entry, explicit: false, from: index };
  });
}

/**
 * iexport_resolver.projectTable — resolve a project's L0 table through its
 * subsystem tables, its own project-level types and the tables of the members
 * and externals its aliases name. The public name is `as ?? id ?? interface ??
 * component ?? typeDef` exactly as the entry writes it; each entry's audience
 * (default instance) applies to every name it brings in. A project with no L0
 * answers an empty table.
 */
export function resolveProjectTable(
  system: SystemSpec | null,
  subsystems: SubsystemSpec[],
  components: ComponentSpec[],
  interfaces: InterfaceSpec[],
  types: TypeSpec[],
  subsystemTables: Map<string, ResolvedExportTable>,
  sources: ExportSources,
): ResolvedExportTable {
  // Steps 1-2: no L0, nothing exported.
  if (!system) return emptyTable(sources.namespace, 'project');
  // Step 3: the handed specs, indexed once.
  const world = worldOf(subsystems, components, interfaces, types);
  const owner = sources.namespace ? sources.namespace : system.name;
  const problems: ExportProblem[] = [];
  const candidates: Candidate[] = [];
  // Steps 4-11: each entry, followed by its source's kind.
  const entries = system.publicInterfaces ?? [];
  entries.forEach((e, index) => {
    const label = e.as ?? e.id ?? e.interface ?? e.component ?? e.typeDef ?? `#${index + 1}`;
    const source = classifySource(world, sourceOf(world, e), label, sources);
    switch (source.kind) {
      case 'own': {
        const own = bindOwnType(world, owner, e, problems);
        if (own) candidates.push({ entry: withEntryMetadata(own, e), explicit: true, from: index });
        return;
      }
      case 'subsystem':
        candidates.push(...bindFromSubsystem(world, owner, e, source.subsystem, subsystemTables, index, problems));
        return;
      case 'project': {
        const table = sources.producerTables.get(source.namespace);
        if (table === null) {
          problems.push({ kind: 'named-cycle', owner, publicName: label, targets: [owner, source.namespace], detail: `re-exports "${label}" from ${source.label}, whose table leads back to this project without reaching the item` });
          return;
        }
        if (table === undefined) {
          problems.push({ kind: 'invalid', owner, publicName: label, detail: `re-exports "${label}" from ${source.label}, whose table the scan did not resolve` });
          return;
        }
        candidates.push(...bindFromProject(owner, e, source, table, index, problems));
        return;
      }
      default:
        problems.push({ kind: 'invalid', owner, publicName: label, detail: duplicateDetail(entries, index) ?? source.detail });
    }
  });
  // Steps 12-13: settled as a subsystem table is settled.
  return settle(owner, 'project', candidates, problems);
}

// ---- the Index: projections of what the scan resolved -------------------------

/** iexport_index.resolveSubsystemExports — one subsystem's table, as the scan resolved it. */
export function resolveSubsystemExportTable(subsystemId: string): ResolvedExportTable {
  // Step 1: the roots the current scan recorded, with their subsystem tables.
  const roots = listProjectRoots();
  // Step 2: a subsystem key is unique to the root that declares it.
  for (const root of roots) {
    const table = root.subsystemExports.get(subsystemId);
    // Step 3: that table.
    if (table) return table;
  }
  return emptyTable(subsystemId, 'subsystem');
}

/** iexport_index.resolveProjectExports — a project's L0 table, as the scan resolved it. */
export function resolveProjectExportTable(project?: string): ResolvedExportTable {
  const namespace = project ?? '';
  // Step 1: the roots the current scan recorded, with their L0 tables.
  const roots = listProjectRoots();
  // Step 2: the root with the key — the bound root when none is given.
  const root = roots.find((r) => r.namespace === namespace);
  // Step 3: its table, or an empty one.
  return root?.exports ?? emptyTable(namespace, 'project');
}

/**
 * iexport_index.usage — one consumer's references into one producer, as the
 * scan bound them: each reference bound to a public name counts that name, with
 * the member it reaches; every other reference is unexported.
 */
export function exportUsageOf(consumer: string, producer: string): ExportUsage {
  // Steps 1-2: the consumer's references into the producer.
  const references = projectFamilyGraph().references.filter((r) => r.consumer === consumer && r.producer === producer);
  // Steps 3-4: none, an empty usage.
  if (references.length === 0) return { consumer, producer, used: [], unexported: [] };
  const table = resolveProjectExportTable(producer || undefined);
  const used = new Map<string, { kind: 'component' | 'type'; members: Set<string> }>();
  const unexported: CrossProjectReference[] = [];
  // Step 5: each reference counted under the name it bound to.
  for (const ref of references) {
    const entry = ref.publicName !== undefined ? table.entries.find((e) => e.publicName === ref.publicName) : undefined;
    if (!entry) {
      unexported.push(ref);
      continue;
    }
    const slot = used.get(entry.publicName) ?? { kind: entry.kind, members: new Set<string>() };
    if (entry.kind === 'type') slot.members.add('type');
    else if (ref.member !== undefined) slot.members.add(ref.member);
    used.set(entry.publicName, slot);
  }
  // Step 6: names sorted, each name's members sorted.
  return {
    consumer,
    producer,
    used: [...used.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([publicName, u]) => ({ publicName, kind: u.kind, members: [...u.members].sort() })),
    unexported,
  };
}

/** The public name a bare import spells, as the consumer's `use` on the alias writes it. */
function importedName(authored: string, use: string[]): string {
  const key = nameKey(authored);
  return use.find((u) => u !== '*' && nameKey(u) === key) ?? authored;
}

/**
 * The members one outside reference reaches, read off the position it stands
 * at: each call or register step's method and each dispatch step's capability
 * naming it, a declared call's method, a dispatch binding's method, `type` at a
 * type position — nothing for a bare dependsOn or mount.
 */
function membersAt(ref: AuthoredReference): string[] {
  if (ref.position === 'type') return ['type'];
  if (ref.position === 'narrative' || ref.position === 'calls') {
    const impl = loadImplementationSpecs().find((i) => i.id === ref.specId);
    const out: string[] = [];
    for (const method of impl?.methods ?? []) {
      if (ref.position === 'calls') {
        for (const entry of method.calls ?? []) {
          const call = parseDeclaredCall(entry);
          if (call && call.compId === ref.authored) out.push(call.methodName);
        }
        continue;
      }
      for (const step of method.narrative) {
        if (step.targetComponent !== ref.authored && step.targetComponent !== ref.resolved) continue;
        if ((step.type === 'call' || step.type === 'register') && step.targetMethod) out.push(step.targetMethod);
        if (step.type === 'dispatch' && step.capability) out.push(`capability:${step.capability}`);
      }
    }
    return out;
  }
  if (ref.position === 'dispatch') {
    const comp = loadComponentSpecs().find((c) => c.id === ref.specId);
    return (comp?.dispatch ?? []).filter((b) => b.component === ref.authored && b.method).map((b) => b.method!);
  }
  return [];
}

/**
 * iexport_index.pinnedUsage — one consumer's references into a producer the
 * scan did NOT read (an external outside the family, or a referenced project
 * member), counted by the public name they spell (stage 8): each `alias::name`
 * through the alias counts `name`, each bare name the consumer's `use` on the
 * alias imports counts that name, each with the member its position reaches.
 * Nothing is unexported here: what the producer exports is the pin's and the
 * status's to compare.
 */
export function pinnedUsageOf(consumer: string, alias: string): ExportUsage {
  // Step 1: the graph, whose authored references keep each reference's form, binding and position.
  const family = projectFamilyGraph();
  const use = family.nodes.find((n) => n.namespace === consumer)?.imports.find((i) => i.alias === alias)?.use ?? [];
  // Step 2: the consumer's references bound outside through the alias.
  const through = family.authoredReferences.filter((r) => (family.owners.get(r.specId) ?? '') === consumer && r.binding === 'outside'
    && ((r.form === 'alias' && r.authored.split('::').length === 2 && r.authored.startsWith(`${alias}::`))
      || (r.form === 'import' && (r.importedVia ?? '').split(', ').includes(alias))));
  // Step 3: each counted under the public name it spells, with the members its position reaches.
  const used = new Map<string, { kind: 'component' | 'type'; members: Set<string> }>();
  for (const ref of through) {
    const publicName = ref.form === 'import' ? importedName(ref.authored, use) : ref.authored.slice(alias.length + 2);
    const slot = used.get(publicName) ?? { kind: ref.position === 'type' ? 'type' as const : 'component' as const, members: new Set<string>() };
    for (const member of membersAt(ref)) slot.members.add(member);
    used.set(publicName, slot);
  }
  // Step 4: no unexported references; names sorted, each name's members sorted.
  return {
    consumer,
    producer: alias,
    used: [...used.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([publicName, u]) => ({ publicName, kind: u.kind, members: [...u.members].sort() })),
    unexported: [],
  };
}
