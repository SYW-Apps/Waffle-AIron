import {
  declares,
  familyNode,
  nameKey,
  type AuthoredReference,
  type ProjectFamily,
  type ResolvedExportTable,
  type TypeSpec,
} from '../models/index.js';

// ---------------------------------------------------------------------------
// position_reader — the positional match (stage 4).
//
// Reads the references stage 4's owner-scoped resolution leaves unresolved the
// way the retired reading did — by position, across the family top's scan —
// and says what explicit form replaces each: an import (with the export and
// the external it needs), a rewrite of a self-prefixed reference to the bare
// local id, an ambiguity for a person, or nothing. It is the ONE place the old
// family-wide suffix match survives, and only as a migration aid: it never
// resolves a reference for validation. Pure: it is handed the family's graph,
// its export tables and its types, and computes. The upgrade report
// (verdict_changes) and the positional migration step both read it, so the
// report explains exactly what the migration writes.
//
// It decides in rounds, each over what the rounds before left ambiguous: a
// producer the referring project will declare once the migration applies — one
// it already reaches by `alias::name`, or one an import decided in an earlier
// round declares — is a declared producer, and a name an earlier round's
// import makes a producer export is already exported. That is exactly what a
// re-run after apply decides, so the migration it plans is idempotent.
// ---------------------------------------------------------------------------

/**
 * positional_match — what one unresolved reference matched by position, and
 * the explicit form that replaces it.
 */
export interface PositionalMatch {
  /** The key of the project whose spec holds the reference. */
  consumer: string;
  /** The spec holding it. */
  specId: string;
  /** Where in the spec (as AuthoredReference.position). */
  position: string;
  /** The reference as written. */
  authored: string;
  /** import | self-prefix | ambiguous | none */
  kind: 'import' | 'self-prefix' | 'ambiguous' | 'none';
  /** For import: the producer's key. */
  producer?: string;
  /** For import: `<producer id>::<local id>`; for self-prefix: the local id. */
  target?: string;
  /** For import: the producer's existing public name for the target, when it has one. */
  publicName?: string;
  /** For ambiguous: every `<producer id>::<id>` the name keyed onto. */
  candidates?: string[];
  /** For import, why this producer was chosen; for ambiguous, why no rule chose. */
  reason?: string;
}

/** One project's claim on a name key: its public name for it, or a type it owns that no table exports. */
interface Claim {
  project: string;
  /** The local id of the target in that project. */
  localId: string;
  publicName?: string;
}

/** The family indexed once by name key: public names first, owned-but-unexported types apart. */
interface NameIndex {
  exported: Map<string, Claim[]>;
  owned: Map<string, Claim[]>;
}

/** The local id of an in-memory key within its project. */
function localOf(key: string, project: string): string {
  return project && key.startsWith(`${project}::`) ? key.slice(project.length + 2) : key;
}

/** Which project a resolved table belongs to: a member's namespace, else the root. */
function tableProject(family: ProjectFamily, table: ResolvedExportTable): string {
  return family.nodes.some((n) => n.namespace !== '' && n.namespace === table.owner) ? table.owner : '';
}

function add(map: Map<string, Claim[]>, key: string, claim: Claim): void {
  const list = map.get(key) ?? [];
  if (!list.some((c) => c.project === claim.project && c.localId === claim.localId)) list.push(claim);
  map.set(key, list);
}

/** Step 1: index the family once by nameKey. */
function indexFamily(family: ProjectFamily, tables: ResolvedExportTable[], types: TypeSpec[]): NameIndex {
  const exported = new Map<string, Claim[]>();
  const exportedTargets = new Set<string>();
  for (const table of tables) {
    if (table.level !== 'project') continue;
    const project = tableProject(family, table);
    for (const entry of table.entries) {
      const target = entry.kind === 'type' ? entry.typeDef : entry.component;
      if (!target) continue;
      exportedTargets.add(target);
      add(exported, nameKey(entry.publicName), { project, localId: localOf(target, project), publicName: entry.publicName });
    }
  }
  const owned = new Map<string, Claim[]>();
  for (const type of types) {
    if (exportedTargets.has(type.id)) continue;
    const project = family.owners.get(type.id) ?? '';
    const localId = localOf(type.id, project);
    add(owned, nameKey(localId), { project, localId });
  }
  return { exported, owned };
}

/** The canonical `<producer id>::<local id>` of a claim. */
function canonical(family: ProjectFamily, claim: Claim): string {
  const id = familyNode(family, claim.project)?.id ?? claim.project;
  return `${id}::${claim.localId}`;
}

/** Steps 4-5: a self-prefixed reference — the referring project's own id as its first segment. */
function selfPrefix(family: ProjectFamily, ref: AuthoredReference, consumer: string): PositionalMatch | null {
  const ownId = familyNode(family, consumer)?.id;
  const [first, ...rest] = ref.authored.split(/::|\./);
  if (!ownId || rest.length === 0 || nameKey(first) !== nameKey(ownId)) return null;
  const local = rest.join('::');
  const base = { consumer, specId: ref.specId, position: ref.position, authored: ref.authored };
  const held = [...family.owners].find(([key, owner]) => owner === consumer && nameKey(localOf(key, consumer)) === nameKey(local));
  return held
    ? { ...base, kind: 'self-prefix', target: localOf(held[0], consumer), reason: 'the project\'s own id used as a prefix names its own spec' }
    : { ...base, kind: 'none', reason: `the project's own id prefixes "${local}", which it does not hold` };
}

/**
 * The producers each project declares or will declare once the migration
 * applies: its members and externals, the projects its `alias::name`
 * references already reach, and what earlier rounds' imports declare.
 */
class Declarations {
  private readonly extra = new Map<string, Set<string>>();

  constructor(private readonly family: ProjectFamily) {
    for (const ref of family.references) this.add(ref.consumer, ref.producer);
  }

  add(consumer: string, producer: string): boolean {
    const set = this.extra.get(consumer) ?? new Set<string>();
    if (set.has(producer)) return false;
    set.add(producer);
    this.extra.set(consumer, set);
    return true;
  }

  has(consumer: string, producer: string): boolean {
    return declares(this.family, consumer, producer) || (this.extra.get(consumer)?.has(producer) ?? false);
  }
}

/** Step 8: classify the projects a bare name matched. */
function classify(family: ProjectFamily, base: Omit<PositionalMatch, 'kind'>, consumer: string, claims: Claim[], index: NameIndex, key: string, declared_: Declarations): PositionalMatch {
  const byProject = [...new Set(claims.map((c) => c.project))];
  const pick = (project: string, reason: string): PositionalMatch => {
    const claim = claims.find((c) => c.project === project)!;
    const exported = index.exported.get(key)?.find((c) => c.project === project);
    return {
      ...base, kind: 'import', producer: project, target: canonical(family, claim),
      ...(exported?.publicName ? { publicName: exported.publicName } : {}), reason,
    };
  };
  if (byProject.length === 0) return { ...base, kind: 'none', reason: 'nothing in the family matches the name' };
  if (byProject.length === 1) return pick(byProject[0], 'only-match');
  const declared = byProject.filter((p) => declared_.has(consumer, p));
  if (declared.length === 1) return pick(declared[0], 'declared-producer');
  const left = declared.length > 0 ? declared : byProject;
  const exporting = left.filter((p) => index.exported.get(key)?.some((c) => c.project === p));
  if (exporting.length === 1) return pick(exporting[0], 'already-exported');
  const name = (p: string): string => familyNode(family, p)?.id ?? (p || '(root)');
  return {
    ...base, kind: 'ambiguous',
    candidates: claims.map((c) => canonical(family, c)),
    reason: `declared-producer left ${declared.length === 0 ? 'none' : declared.map(name).join(', ')}; already-exported left ${exporting.length === 0 ? 'none' : exporting.map(name).join(', ')} — a person picks`,
  };
}

/**
 * iposition_reader.match — for each unresolved reference: a self-prefixed one
 * is self-prefix; a bare name is compared by nameKey against every OTHER
 * project's public names, then the types they own that no table exports, and
 * is import (only-match, declared-producer or already-exported), ambiguous or
 * none. Every automatic choice carries its reason. Never resolves for
 * validation.
 */
export function match(
  unresolved: AuthoredReference[],
  family: ProjectFamily,
  tables: ResolvedExportTable[],
  types: TypeSpec[],
): PositionalMatch[] {
  // Step 1: index the family once, and what each project declares.
  const index = indexFamily(family, tables, types);
  const declared = new Declarations(family);
  const out = new Map<AuthoredReference, PositionalMatch>();
  let open = unresolved;
  // Step 2: in rounds, while the last one declared or exported something new.
  for (;;) {
    // Steps 3-9: each reference still open, in scan order.
    for (const ref of open) out.set(ref, matchOne(ref, family, index, declared));
    // Step 10: what this round's imports declare and export.
    const decided = open.map((ref) => out.get(ref)!).filter((m) => m.kind === 'import');
    const grew = decided.reduce((g, m) => learn(m, family, index, declared) || g, false);
    open = open.filter((ref) => out.get(ref)!.kind === 'ambiguous');
    if (!grew || open.length === 0) break;
  }
  // Step 11.
  return unresolved.map((ref) => out.get(ref)!);
}

/** Steps 4-9 for one reference. */
function matchOne(ref: AuthoredReference, family: ProjectFamily, index: NameIndex, declared: Declarations): PositionalMatch {
  const consumer = family.owners.get(ref.specId) ?? '';
  // Steps 4-6: a self-prefix.
  const self = selfPrefix(family, ref, consumer);
  if (self) return self;
  // Step 7: the name's key among the OTHER projects' public names, and the
  // types they own that no table exports (a project's public name first).
  const segments = ref.authored.split(/::|\./);
  const key = nameKey(segments[segments.length - 1]);
  const others = (claims: Claim[] | undefined): Claim[] => (claims ?? []).filter((c) => c.project !== consumer);
  const exported = others(index.exported.get(key));
  const claims = [...exported, ...others(index.owned.get(key)).filter((c) => !exported.some((e) => e.project === c.project))];
  // Steps 8-9: classify.
  const base = { consumer, specId: ref.specId, position: ref.position, authored: ref.authored };
  return classify(family, base, consumer, claims, index, key, declared);
}

/**
 * Step 10: what one decided import leaves behind once applied — its producer
 * declared by its consumer, and a name exported under its default public name
 * where the producer exported none. An import a spec of the consumer would
 * shadow is never written, so it teaches nothing. True when something is new.
 */
function learn(m: PositionalMatch, family: ProjectFamily, index: NameIndex, declared: Declarations): boolean {
  const localId = m.target!.slice(m.target!.indexOf('::') + 2);
  const name = m.publicName ?? localId.split('::').pop()!;
  const key = nameKey(name);
  const shadowed = [...family.owners].some(([id, owner]) => owner === m.consumer && nameKey(id.split('::').pop()!) === key);
  if (shadowed) return false;
  let grew = declared.add(m.consumer, m.producer!);
  if (m.publicName === undefined && !(index.exported.get(key) ?? []).some((c) => c.project === m.producer)) {
    add(index.exported, key, { project: m.producer!, localId, publicName: name });
    grew = true;
  }
  return grew;
}

