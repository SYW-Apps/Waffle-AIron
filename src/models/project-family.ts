import * as path from 'path';
import type { ExportUsage } from './exports.js';
import type { SubsystemSpec } from './specs.js';
// TYPE-ONLY: a part is recorded by the scan that read it (spec_index), and the graph carries it as read.
import type { ScannedPart, WritableSpecKind } from '../core/specs.js';

// ---------------------------------------------------------------------------
// The project graph: every project root one scan read, the project that owns
// each spec key, and the references that leave the project making them.
//
// Every project is a crate of its own (decision 9): another project reaches it
// only through its L0 exports, and only as a dependency it declared — a member
// it declares, or an external it names in project.yaml. A cross-project
// reference is `alias::name` (stage 3); the leading `::`, `super::` and
// member-path forms still bind for one release. These are the shapes the
// project family index answers with, and the pure lookups every consumer of
// the graph asks it. Nothing here does I/O, and nothing here judges.
// ---------------------------------------------------------------------------

/**
 * How a reference was read. `alias` is the only `::` form stage 3 writes;
 * `import` is a bare name that names no spec of the referring project, looked
 * up among the names its `use` imports supply (stage 4).
 */
export type ReferenceForm = 'alias' | 'import' | 'leading' | 'super' | 'path';

/** What a reference bound to. `ambiguous`: two imports supply one bare name. */
export type ReferenceBinding = 'exported' | 'unexported' | 'undeclared' | 'outside' | 'unresolved' | 'local' | 'ambiguous';

/**
 * authored_reference — a reference as its author wrote it, recorded by the scan
 * before binding replaces it with the in-memory key of its target: every
 * reference that carries `::`, with the form it was read in, what it bound to,
 * and the text the writer emits for it now.
 */
export interface AuthoredReference {
  /** The in-memory key of the spec that holds the reference. */
  specId: string;
  /** Where in that spec (dependsOn, owns, dispatch, mounts, lifecycle, publicInterfaces, trustedLinks, contract, subsystem, narrative, calls, auth, type). */
  position: string;
  /** The reference exactly as written. */
  authored: string;
  /** alias | leading | super | path. */
  form: ReferenceForm;
  /** exported | unexported | undeclared | outside | unresolved | local. */
  binding: ReferenceBinding;
  /** The in-memory key it bound to; equal to `authored` for outside and unresolved. */
  resolved: string;
  /** The key of the project it lands in; absent for outside and unresolved. */
  producer?: string;
  /** The public name it bound to, for exported. */
  publicName?: string;
  /** The text the writer emits for `resolved` from the referring project; absent when none can be written. */
  rewrite?: string;
  /** For an import: the alias (or aliases, when ambiguous) whose `use` supplies the name. */
  importedVia?: string;
  /**
   * For an unresolved import: the declared external or member that exports a
   * name with the same key without importing it, and the `use` line that
   * would import it. Never a project the referrer does not declare.
   */
  hint?: string;
}

/** How the owner's gate resolved one cross-project reference. */
export type ResolutionOutcome = 'resolved' | 'missing' | 'ambiguous' | 'unavailable' | 'forbidden';

/**
 * reference_resolution — how one cross-project reference was resolved by the
 * owner's gate, decided BEFORE any severity, from the referring project's own
 * files only (its scan, its contained members' export tables, its externals
 * lock and its pinned snapshots).
 */
export interface ReferenceResolution {
  outcome: ResolutionOutcome;
  /** The referring project's id (its key when it has no usable id): the one project whose gate judges it. */
  owner: string;
  /** Where the reference is written: the referring spec id and the position in it. */
  callSite: string;
  /** The target in producer-id form, `<producer id>::<public name>`; the reference as written when it lands nowhere. */
  canonicalTarget?: string;
  /** The digest of the input it was judged against: the pin's content digest, or a contained member's live table's. */
  inputDigest?: string;
  /** One sentence saying why the outcome is what it is. */
  reason: string;
  /** For a bare name resolved through an import: the alias whose `use` supplied it, and whether by name or by `*`. */
  importedVia?: string;
}

/** cross_project_reference — one reference that leaves the project that makes it. */
export interface CrossProjectReference {
  /** The in-memory key of the referring spec. */
  specId: string;
  /** dependsOn | call | register | dispatch | calls | dispatch-table | mounts | lifecycle | auth | reexport | type */
  position: string;
  /** The in-memory key the reference names: a component, a subsystem (a re-export source) or a type. */
  target: string;
  /** The contract method it reaches, or `capability:<name>`; absent for the component or type as a whole. */
  member?: string;
  /** The key of the project that owns the referring spec. */
  consumer: string;
  /** The key of the project the reference lands in. */
  producer: string;
  /** The reference as its author wrote it. */
  authored: string;
  /** The producer's public name it bound to; absent when it bound to none. */
  publicName?: string;
}

/** Where a declared external's producer was found. */
export type ExternalSourceKind = 'family' | 'path' | 'git' | 'hosted' | 'unresolved';

/** How a family producer stands to its consumer. */
export type ExternalRelation = 'parent' | 'sibling' | 'member' | 'family';

/** How an external is declared: under externals, or as a referenced project member. */
export type ExternalRole = 'external' | 'member';

/**
 * resolved_external — one declared external of a project, bound to its
 * producer. The family sees `project`, any other source sees `instance`.
 */
export interface ResolvedExternal {
  alias: string;
  /** The producer id the declaration names (its `project`, else the alias). */
  project: string;
  sourceKind: ExternalSourceKind;
  /** For a family producer: how it stands to the consumer. */
  relation?: ExternalRelation;
  /** The producer's key in the family graph, for a family producer. */
  producer?: string;
  /** The producer's root directory, absolute. */
  directory?: string;
  /** The source.hosted record id the declaration names, resolved or not. */
  hosted?: string;
  /** The audience ceiling the consumer sees. */
  audience: string;
  /** Why the external is unresolved or unusable. */
  problem?: string;
  /**
   * external | member (stage 8): declared under `externals`, or a referenced
   * project member — declared under `members` with a `../`, git or hosted
   * source, its content a project's — bound and judged exactly as an external.
   */
  role: ExternalRole;
  /** git: the commit the directory holds — a member's pinned commit, an external's ref head when resolved. */
  commit?: string;
}

/** Where a family node's id came from. */
export type ProjectIdOrigin = 'declared' | 'name' | 'none';

/** How a parent declares a member root: a members entry, or a legacy L1 mount subsystem. */
export type MountForm = 'members' | 'mount';

/** project_node — one project root of the family the scan read, keyed by its in-memory key. */
export interface ProjectNode {
  /** '' for the bound root, else its effective project id (or its alias path when the id is taken or missing). */
  namespace: string;
  /** The effective project id (declared, else the name slug); absent when none can be made. */
  id?: string;
  idSource: ProjectIdOrigin;
  /** The display name, absent when the root has no readable configuration. */
  name?: string;
  /** The key of the project that declares this one as a member; absent for the bound root. */
  parent?: string;
  /** The alias the parent declares it under; absent for the bound root. */
  mountAlias?: string;
  /** How the parent declares it; absent for the bound root. */
  mountForm?: MountForm;
  /** The legacy L1 mount subsystem as its parent wrote it; null otherwise. */
  legacyMount: SubsystemSpec | null;
  /** What the parent's declaration says the member is (the `members` description, or a legacy mount's); shown on its canvas node. */
  memberDescription?: string;
  /** Whether the project has an L0 of its own. */
  hasSystem: boolean;
  /** The project's root directory, absolute. */
  directory: string;
  /** The keys of the projects this one declares as members, either form. */
  members: string[];
  /** The project's alias table: alias → the key of the project it names (members and family externals). */
  aliases: Map<string, string>;
  /** The project's declared externals, each bound to its producer. */
  externals: ResolvedExternal[];
  /**
   * The project's `use` imports: one per declared member and external alias,
   * in declaration order (members first), each with the names it imports as
   * written — empty when the alias imports nothing (stage 4).
   */
  imports: ProjectImport[];
  /**
   * The project's parts (stage 8): its subsystems stored in another directory
   * or repository, drawn as this project's own subsystems with the part's
   * storage badge; nothing about them is a project.
   */
  parts: ScannedPart[];
}

/** Which section of a project's configuration declares an alias. */
export type ImportSection = 'externals' | 'members';

/** project_import — one alias's `use` imports, as the project's configuration declares them. */
export interface ProjectImport {
  alias: string;
  /** Where the alias is declared. */
  section: ImportSection;
  /** The `use` entries, deduplicated in first-seen order; `*` stays `*`. */
  use: string[];
}

/** What a family identity or membership problem is. */
export type FamilyProblemKind = 'id-collision' | 'no-id' | 'defaulted' | 'member-absent' | 'alias-conflict' | 'duplicate-spec' | 'part-unavailable' | 'kind-mismatch';

/**
 * project_family_problem — a fact about the family's identities and membership
 * no single project can see alone. Reported, never judged.
 */
export interface ProjectFamilyProblem {
  kind: FamilyProblemKind;
  /** The colliding id; the alias to declare (defaulted); the alias (member-absent, alias-conflict); the key (duplicate-spec). */
  id?: string;
  /** The keys of the projects concerned ('' is the bound root). */
  projects: string[];
  /** What is wrong, in words a finding can quote. */
  detail: string;
}

/** project_family — the project graph of one scan. */
export interface ProjectFamily {
  /** Every project root the scan read, bound root first, then members in walk order. */
  nodes: ProjectNode[];
  /** Spec key → the key of the project that declares it. */
  owners: Map<string, string>;
  /** Every reference with `::` across the family, as written and as bound. */
  authoredReferences: AuthoredReference[];
  /** Identity and membership problems across the family. */
  problems: ProjectFamilyProblem[];
  /** Every reference in the family that leaves the project making it. */
  references: CrossProjectReference[];
}

/**
 * external_binding — one declared external of the bound project, bound to its
 * producer, with what the project's references reach in it.
 */
export interface ExternalBinding {
  external: ResolvedExternal;
  /** The consumer's references into a family producer, mapped onto its public names; absent otherwise. */
  usage?: ExportUsage;
  /** Whether the climb reached the whole family. */
  reachable: boolean;
}

// ---- reading a reference without position ----------------------------------

/** A project as reference reading sees it: its key, its parent, its alias table and its own subsystem ids. */
export interface ReadableProject {
  namespace: string;
  parent?: string;
  /** The effective project id, when it has one. */
  id?: string;
  /** alias → the key of the project it names, for every producer the scan read. */
  aliases: Map<string, string>;
  /** Every alias it declares, including externals whose producer the scan did not read. */
  declaredAliases: ReadonlySet<string>;
  /** Its own subsystem local ids — a subsystem segment qualifies a type, it names no project. */
  subsystems: ReadonlySet<string>;
}

/** Where a reference lands: the project and the local id in it, or why it lands nowhere. */
export type ReferenceLanding =
  | { kind: 'project'; form?: ReferenceForm; project: string; name: string }
  | { kind: 'outside'; form: ReferenceForm }
  | { kind: 'unresolved'; form: ReferenceForm };

/**
 * Walk a member path from `start`: every segment but the last is an alias of
 * the project reached so far (a subsystem segment qualifies the item and is
 * skipped), the last a local id.
 */
function walkMemberPath(
  byKey: Map<string, ReadableProject>,
  start: ReadableProject,
  segments: string[],
): { project: ReadableProject; name: string } | 'outside' | null {
  let node = start;
  for (const segment of segments.slice(0, -1)) {
    const next = node.aliases.get(segment);
    if (next !== undefined) {
      const found = byKey.get(next);
      if (!found) return null;
      node = found;
      continue;
    }
    if (node.declaredAliases.has(segment)) return 'outside';
    if (node.subsystems.has(segment)) continue;
    return null;
  }
  return { project: node, name: segments[segments.length - 1] };
}

/**
 * Read a reference from the project `from` the way the scan binds one, without
 * position: an id without `::` is local; `alias::name` goes through `from`'s
 * alias table; a first segment naming one of `from`'s own subsystems qualifies
 * a local item; the deprecated forms still bind for one release — a leading
 * `::` is a member path from the bound root, each `super::` climbs one
 * containing project and reads the rest there, and a first segment `from` does
 * not declare is a member path from the bound root, else a family project id.
 */
export function landReference(projects: ReadableProject[], reference: string, from: string): ReferenceLanding {
  const byKey = new Map(projects.map((p) => [p.namespace, p] as const));
  const origin = byKey.get(from);
  const root = byKey.get('');
  if (!reference.includes('::')) return { kind: 'project', project: from, name: reference };
  const land = (form: ReferenceForm, start: ReadableProject | undefined, segments: string[]): ReferenceLanding => {
    if (!start) return { kind: 'unresolved', form };
    const walked = walkMemberPath(byKey, start, segments);
    if (walked === 'outside') return { kind: 'outside', form };
    if (walked) return { kind: 'project', form, project: walked.project.namespace, name: walked.name };
    return { kind: 'unresolved', form };
  };
  if (reference.startsWith('::')) return land('leading', root, reference.slice(2).split('::'));
  const segments = reference.split('::');
  if (segments[0] === 'super') {
    let node = origin;
    while (segments[0] === 'super') {
      segments.shift();
      if (!node || node.parent === undefined) return { kind: 'outside', form: 'super' };
      node = byKey.get(node.parent);
    }
    if (segments.length === 0 || !node) return { kind: 'unresolved', form: 'super' };
    return land('super', node, segments);
  }
  if (!origin) return { kind: 'unresolved', form: 'path' };
  const [first] = segments;
  if (origin.aliases.has(first) || origin.declaredAliases.has(first)) {
    if (!origin.aliases.has(first)) return { kind: 'outside', form: 'alias' };
    return land(segments.length === 2 ? 'alias' : 'path', origin, segments);
  }
  if (origin.subsystems.has(first)) return { kind: 'project', project: from, name: segments[segments.length - 1] };
  const fromRoot = root ? walkMemberPath(byKey, root, segments) : null;
  if (fromRoot && fromRoot !== 'outside') return { kind: 'project', form: 'path', project: fromRoot.project.namespace, name: fromRoot.name };
  // A first segment naming a project of the family by its id (or key) — the
  // bound root itself included, as a path written from a root above it reads —
  // walks on from that project.
  const byId = projects.filter((p) => p.id === first || (p.namespace !== '' && p.namespace === first));
  if (byId.length === 1) {
    const walked = walkMemberPath(byKey, byId[0], segments.slice(1));
    if (walked === 'outside') return { kind: 'outside', form: 'path' };
    if (walked) return { kind: 'project', form: 'path', project: walked.project.namespace, name: walked.name };
  }
  return { kind: fromRoot === 'outside' ? 'outside' : 'unresolved', form: 'path' };
}

/** The in-memory key of a local id in a project. */
export function keyIn(project: string, localId: string): string {
  return project ? `${project}::${localId}` : localId;
}

/**
 * The key one spec file of a project is approved under (stage 8): its path
 * from the project's root, POSIX — or, for a file one of its parts holds,
 * `members/<alias>/<path inside the part>`, so moving a part between a
 * contained folder, a sibling checkout and a git repository changes no key.
 */
export function approvalKeyIn(file: string, root: string, parts: readonly ScannedPart[]): string {
  const resolved = path.resolve(file);
  for (const part of parts) {
    if (part.directory === undefined) continue;
    const rel = path.relative(part.directory, resolved);
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return `members/${part.alias}/${rel.split(path.sep).join('/')}`;
    }
  }
  return path.relative(root, resolved).split(path.sep).join('/');
}

// ---- project_family behaviour ----------------------------------------------

/** project_family.node — the node with that key, or null. */
export function familyNode(family: ProjectFamily, namespace: string): ProjectNode | null {
  return family.nodes.find((n) => n.namespace === namespace) ?? null;
}

/** The nodes as reference reading sees them. */
function readableProjects(family: ProjectFamily): ReadableProject[] {
  return family.nodes.map((node) => ({
    namespace: node.namespace,
    ...(node.parent !== undefined ? { parent: node.parent } : {}),
    ...(node.id !== undefined ? { id: node.id } : {}),
    aliases: node.aliases,
    declaredAliases: new Set([...node.aliases.keys(), ...node.externals.map((e) => e.alias)]),
    // The graph keeps no spec kinds; a reference the loader leaves raw is read
    // without the subsystem-qualifier reading, which only type names use.
    subsystems: new Set<string>(),
  }));
}

/** project_family.ownerOf — the project that declares the spec, or null for a key the scan did not read. */
export function ownerOf(family: ProjectFamily, specId: string): ProjectNode | null {
  const ns = family.owners.get(specId);
  return ns === undefined ? null : familyNode(family, ns);
}

/**
 * project_family.producerOf — the project a reference lands in. With `from`,
 * the reference is read from that project the way the scan binds one; then
 * the owner of the spec it names, else the node whose key is the longest
 * prefix of it. Null for a reference nothing binds.
 */
export function producerOf(family: ProjectFamily, reference: string, from?: string): ProjectNode | null {
  let target = reference;
  if (from !== undefined) {
    const landing = landReference(readableProjects(family), reference, from);
    if (landing.kind !== 'project') return null;
    target = keyIn(landing.project, landing.name);
  }
  const owned = ownerOf(family, target);
  if (owned) return owned;
  let best: ProjectNode | null = null;
  for (const node of family.nodes) {
    const covers = node.namespace === '' || target === node.namespace || target.startsWith(`${node.namespace}::`);
    if (covers && (!best || node.namespace.length > best.namespace.length)) best = node;
  }
  return best;
}

/**
 * project_family.declares — whether the consumer may reach the producer as a
 * declared dependency: a direct member (either form), or one of the consumer's
 * externals resolves to it.
 */
export function declares(family: ProjectFamily, consumer: string, producer: string): boolean {
  const node = familyNode(family, consumer);
  if (!node) return false;
  return node.members.includes(producer)
    || [...node.aliases.values()].includes(producer)
    || node.externals.some((e) => e.sourceKind === 'family' && e.producer === producer);
}

/**
 * project_family.dependencyCycles — the loops in the project dependency graph:
 * an edge from consumer to producer per cross-project reference (containment
 * is no edge). Each strongly connected set of two or more projects is answered
 * once, as the keys along one closed walk through every project of the set, in
 * walk order from its first project, which is repeated at the end.
 */
export function dependencyCycles(family: ProjectFamily): string[][] {
  const order = family.nodes.map((n) => n.namespace);
  const edges = new Map<string, Set<string>>(order.map((k) => [k, new Set<string>()]));
  for (const ref of family.references) {
    if (ref.consumer === ref.producer) continue;
    if (!edges.has(ref.consumer)) edges.set(ref.consumer, new Set());
    edges.get(ref.consumer)!.add(ref.producer);
  }
  const rank = (k: string): number => { const i = order.indexOf(k); return i === -1 ? order.length : i; };
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  let next = 0;
  const visit = (v: string): void => {
    index.set(v, next); low.set(v, next); next++;
    stack.push(v); onStack.add(v);
    for (const w of [...(edges.get(v) ?? [])].sort((a, b) => rank(a) - rank(b))) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const group: string[] = [];
      let w: string;
      do { w = stack.pop()!; onStack.delete(w); group.push(w); } while (w !== v);
      if (group.length > 1) groups.push(group);
    }
  };
  for (const k of [...edges.keys()].sort((a, b) => rank(a) - rank(b))) if (!index.has(k)) visit(k);
  // One closed walk through each group, in walk order from its first project.
  return groups
    .map((group) => {
      const members = new Set(group);
      const ordered = [...group].sort((a, b) => rank(a) - rank(b));
      const walk = [ordered[0]];
      for (const next of [...ordered.slice(1), ordered[0]]) {
        if (next !== ordered[0] && walk.includes(next)) continue;
        walk.push(...shortestPath(walk[walk.length - 1], next, members, edges, rank));
      }
      return walk;
    })
    .sort((a, b) => rank(a[0]) - rank(b[0]));
}

/** The keys after `from` on a shortest path to `to` inside one strongly connected group (breadth-first). */
function shortestPath(from: string, to: string, members: Set<string>, edges: Map<string, Set<string>>, rank: (k: string) => number): string[] {
  const prev = new Map<string, string>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length) {
    const v = queue.shift()!;
    for (const w of [...(edges.get(v) ?? [])].filter((x) => members.has(x)).sort((a, b) => rank(a) - rank(b))) {
      if (w === to) {
        const path = [w];
        for (let at = v; at !== from; at = prev.get(at)!) path.unshift(at);
        return path;
      }
      if (seen.has(w)) continue;
      seen.add(w);
      prev.set(w, v);
      queue.push(w);
    }
  }
  return [to];
}

/** reference_edit — one reference respelled at its parsed position (stage 6 family migrations). */
export interface ReferenceEdit {
  /** The kind of the spec holding the reference. */
  kind: WritableSpecKind;
  /** The spec's id. */
  specId: string;
  /** Where in the spec (as AuthoredReference.position). */
  position: string;
  /** The reference as written. */
  from: string;
  /** What it is respelled to. */
  to: string;
}
