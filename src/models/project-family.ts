import type { ExportUsage } from './exports.js';

// ---------------------------------------------------------------------------
// The project graph: every project root one scan read, the project that owns
// each spec id, and the references that leave the project making them.
//
// Every project is a crate of its own (decision 9): another project reaches it
// only through its L0 exports, and only as a dependency it declared — a member
// it mounts, or an external it names in project.yaml. These are the shapes the
// project family index answers with, and the pure lookups every consumer of
// the graph asks it. Nothing here does I/O, and nothing here judges.
// ---------------------------------------------------------------------------

/**
 * authored_reference — a reference as its author wrote it, recorded by the scan
 * before qualification erases the form. Only the leading-`::` form is recorded:
 * `super::` has no alternative before stage 3, and wairon's own writer emits it.
 */
export interface AuthoredReference {
  /** The qualified id of the spec that holds the reference. */
  specId: string;
  /** Where in that spec (dependsOn, owns, dispatch, mounts, lifecycle, publicInterfaces, trustedLinks, contract, narrative, type). */
  position: string;
  /** The reference exactly as written. */
  authored: string;
  /** The absolute id it qualified to — the form to write instead. */
  resolved: string;
}

/** cross_project_reference — one reference that leaves the project that makes it. */
export interface CrossProjectReference {
  /** The qualified id of the referring spec. */
  specId: string;
  /** dependsOn | call | register | dispatch | calls | dispatch-table | mounts | lifecycle | auth | reexport | type */
  position: string;
  /** The qualified id the reference names: a component, a subsystem (a re-export source) or a type. */
  target: string;
  /** The contract method it reaches, or `capability:<name>`; absent for the component or type as a whole. */
  member?: string;
  /** The namespace of the project that owns the referring spec. */
  consumer: string;
  /** The namespace of the project the reference lands in. */
  producer: string;
}

/**
 * resolved_external — one declared external of a project, bound to its
 * producer. The family sees `project`, any other source sees `instance`.
 */
export interface ResolvedExternal {
  alias: string;
  /** The producer id the declaration names (its `project`, else the alias). */
  project: string;
  /** family | path | unresolved */
  sourceKind: 'family' | 'path' | 'unresolved';
  /** For a family producer: parent | sibling | member | family. */
  relation?: 'parent' | 'sibling' | 'member' | 'family';
  /** The producer's namespace in the family graph, for a family producer. */
  producer?: string;
  /** The producer's root directory, absolute. */
  directory?: string;
  /** The audience ceiling the consumer sees. */
  audience: string;
  /** Why the external is unresolved or unusable. */
  problem?: string;
}

/** project_node — one project root of the family the scan read, keyed by its mount namespace. */
export interface ProjectNode {
  /** '' for the bound root, else the qualified id of the subsystem that mounts it. */
  namespace: string;
  /** The effective project id (declared, else the name slug); absent when none can be made. */
  id?: string;
  /** declared | name | none */
  idSource: 'declared' | 'name' | 'none';
  /** The display name, absent when the root has no readable configuration. */
  name?: string;
  /** The namespace of the project that mounts this one; absent for the bound root. */
  parent?: string;
  /** The local id of the mounting subsystem; absent for the bound root. */
  mountAlias?: string;
  /** The project's root directory, absolute. */
  directory: string;
  /** The namespaces of the projects this one mounts directly. */
  members: string[];
  /** The project's declared externals, each bound to its producer. */
  externals: ResolvedExternal[];
}

/**
 * project_family_problem — a fact about the family's identities no single
 * project can see alone. Reported, never judged.
 */
export interface ProjectFamilyProblem {
  /** id-collision | no-id | defaulted */
  kind: 'id-collision' | 'no-id' | 'defaulted';
  /** The id two or more projects resolve to; the mount's subsystem id to declare, for a defaulted member. */
  id?: string;
  /** The namespaces of the projects concerned ('' is the bound root). */
  projects: string[];
  /** What is wrong, in words a finding can quote. */
  detail: string;
}

/** project_family — the project graph of one scan. */
export interface ProjectFamily {
  /** Every project root the scan read, bound root first, then members in walk order. */
  nodes: ProjectNode[];
  /** Spec id → the namespace of the project that declares it. */
  owners: Map<string, string>;
  /** Every leading-`::` reference across the family. */
  authoredReferences: AuthoredReference[];
  /** Id collisions and id-less projects across the family. */
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

// ---- project_family behaviour ----------------------------------------------

/** project_family.node — the node with that namespace, or null. */
export function familyNode(family: ProjectFamily, namespace: string): ProjectNode | null {
  return family.nodes.find((n) => n.namespace === namespace) ?? null;
}

/**
 * Qualify a reference as the loader would from the project at `from`: a
 * leading `::` is absolute, each `super::` climbs one mount, a first segment
 * naming a bound-root subsystem is absolute, anything else is prefixed with
 * `from`. A bound-root subsystem is recognized by its bare id among the owned
 * specs. Null when `super::` climbs above the bound root.
 */
export function qualifyReference(family: ProjectFamily, reference: string, from: string): string | null {
  if (reference.startsWith('::')) return reference.slice(2);
  if (reference.startsWith('super::')) {
    const scope = from ? from.split('::') : [];
    const parts = reference.split('::');
    while (parts[0] === 'super') {
      if (scope.length === 0) return null;
      parts.shift();
      scope.pop();
    }
    return [...scope, ...parts].join('::');
  }
  const first = reference.split('::')[0];
  if (!from || family.owners.has(first) && !first.includes('::') && ownedAtRoot(family, first)) return reference;
  return `${from}::${reference}`;
}

/** Whether a bare id is a bound-root subsystem (a root-level spec, or a mount — whose namespace it is). */
function ownedAtRoot(family: ProjectFamily, id: string): boolean {
  const owner = family.owners.get(id);
  return owner === '' || owner === id;
}

/** project_family.ownerOf — the project that declares the spec, or null for an id the scan did not read. */
export function ownerOf(family: ProjectFamily, specId: string): ProjectNode | null {
  const ns = family.owners.get(specId);
  return ns === undefined ? null : familyNode(family, ns);
}

/**
 * project_family.producerOf — the project a reference lands in: the owner of
 * the spec it names, else the node whose namespace is the longest prefix of
 * it. With `from`, the reference is first qualified from that project. Null
 * for a reference that climbs above the bound root.
 */
export function producerOf(family: ProjectFamily, reference: string, from?: string): ProjectNode | null {
  const target = from === undefined ? reference : qualifyReference(family, reference, from);
  if (target === null || target.startsWith('super::')) return null;
  const owned = ownerOf(family, target.startsWith('::') ? target.slice(2) : target);
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
 * declared dependency: a direct member (the mount is the alias), or one of the
 * consumer's externals resolves to it.
 */
export function declares(family: ProjectFamily, consumer: string, producer: string): boolean {
  const node = familyNode(family, consumer);
  if (!node) return false;
  return node.members.includes(producer)
    || node.externals.some((e) => e.sourceKind === 'family' && e.producer === producer);
}
