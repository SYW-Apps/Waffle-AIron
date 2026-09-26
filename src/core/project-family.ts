import * as path from 'path';
import {
  declaredExternals,
  effectiveProjectId,
  extractTypeIdentifiers,
  parseDeclaredCall,
  qualifyReference,
  producerOf,
  type ComponentSpec,
  type CrossProjectReference,
  type ImplementationSpec,
  type InterfaceSpec,
  type ProjectFamily,
  type ProjectFamilyProblem,
  type ProjectNode,
  type ResolvedExternal,
  type SubsystemSpec,
  type TypeSpec,
} from '../models/index.js';
// project_family_index projects the scan the Spec Index holds — the sanctioned
// case of an Index over another Index of the same Repository.
import {
  listProjectRoots,
  loadComponentSpecs,
  loadImplementationSpecs,
  loadInterfaceSpecs,
  loadSubsystemSpecs,
  loadTypeSpecs,
  type ScannedProjectRoot,
} from './specs.js';

// ---------------------------------------------------------------------------
// project_family_index — the project graph of one scan.
//
// The scan already walked every mount and recorded each project root it read
// (namespace, parent, mount alias, directory, configuration, the ids its files
// declared, the leading-`::` references authors wrote). This Index projects
// those roots and the scanned specs into one node per project, an owner for
// every spec id, the references that leave the project making them, and the
// family's identity problems — once per scan, memoized on it and dropped with
// it, so it is never stale. The lookups (node, ownerOf, producerOf, declares)
// are pure methods of the ProjectFamily value, so the Index publishes the graph
// alone. It does no I/O of its own and judges nothing.
// ---------------------------------------------------------------------------

/** The `auth.from` prefix that makes a credential source a component reference. */
const COMPONENT_AUTH_SOURCE = 'component:';

/** The graph a scan projected, dropped with the scan's root list. */
const memo = new WeakMap<ScannedProjectRoot[], ProjectFamily>();

/** A directory as a comparable key: resolved, and case-folded where the filesystem folds case. */
function dirKey(dir: string): string {
  const resolved = path.resolve(dir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** One node per root: id from project_config.effectiveId(), members from the walk. */
function makeNodes(roots: ScannedProjectRoot[]): ProjectNode[] {
  return roots.map((root) => {
    const id = root.config ? effectiveProjectId(root.config) : null;
    const idSource: ProjectNode['idSource'] = root.config?.id !== undefined ? 'declared' : id !== null ? 'name' : 'none';
    return {
      namespace: root.namespace,
      ...(id !== null ? { id } : {}),
      idSource,
      ...(root.config ? { name: root.config.name } : {}),
      ...(root.parent !== undefined ? { parent: root.parent } : {}),
      ...(root.mountAlias !== undefined ? { mountAlias: root.mountAlias } : {}),
      directory: root.directory,
      members: roots.filter((r) => r.parent === root.namespace && r.namespace !== root.namespace).map((r) => r.namespace),
      externals: [],
    };
  });
}

/** The name a namespace reads as in a finding: the bound root, or the member at a mount. */
function describe(node: ProjectNode): string {
  const label = node.id ?? node.name ?? '(no id)';
  return node.namespace === '' ? `"${label}" (the bound root)` : `"${label}" (mounted at "${node.namespace}")`;
}

/** The family's identity problems: collisions, id-less members, defaulted members. */
function identityProblems(nodes: ProjectNode[]): ProjectFamilyProblem[] {
  const problems: ProjectFamilyProblem[] = [];
  const byId = new Map<string, ProjectNode[]>();
  for (const node of nodes) {
    if (node.id !== undefined) byId.set(node.id, [...(byId.get(node.id) ?? []), node]);
  }
  for (const [id, holders] of byId) {
    if (holders.length < 2) continue;
    problems.push({
      kind: 'id-collision',
      id,
      projects: holders.map((n) => n.namespace),
      detail: `${holders.map((n) => `${describe(n)} (id from its ${n.idSource === 'declared' ? 'declaration' : 'name'})`).join(' and ')} all resolve to "${id}"`,
    });
  }
  for (const node of nodes) {
    if (node.namespace === '') continue; // the bound root's own identity is judged from its configuration and lock
    if (node.idSource === 'none') {
      problems.push({ kind: 'no-id', projects: [node.namespace], detail: `the member mounted at "${node.namespace}" has no id: it declares none${node.name !== undefined ? ` and its name "${node.name}" yields none` : ', and has no readable configuration'}` });
    } else if (node.idSource === 'name') {
      problems.push({ kind: 'defaulted', id: node.mountAlias, projects: [node.namespace], detail: `the member mounted at "${node.namespace}" declares no id, so it answers to "${node.id}", its name slug` });
    }
  }
  return problems;
}

/** How a family producer stands to its consumer. */
function relationOf(consumer: ProjectNode, producer: ProjectNode): ResolvedExternal['relation'] {
  if (consumer.parent === producer.namespace) return 'parent';
  if (producer.parent === consumer.namespace) return 'member';
  if (consumer.parent !== undefined && consumer.parent === producer.parent) return 'sibling';
  return 'family';
}

/** A family producer: the consumer sees `project`. */
function familyExternal(alias: string, project: string, consumer: ProjectNode, producer: ProjectNode): ResolvedExternal {
  return { alias, project, sourceKind: 'family', relation: relationOf(consumer, producer), producer: producer.namespace, directory: producer.directory, audience: 'project' };
}

/** Bind each of the node's declared externals to its producer. */
function bindExternals(node: ProjectNode, root: ScannedProjectRoot, nodes: ProjectNode[]): ResolvedExternal[] {
  if (!root.config) return [];
  return declaredExternals(root.config).map((decl): ResolvedExternal => {
    const unresolved = (problem: string): ResolvedExternal => ({ alias: decl.alias, project: decl.project, sourceKind: 'unresolved', audience: 'instance', problem });
    if (decl.problem) return unresolved(decl.problem);
    if (decl.sourcePath !== undefined) {
      const directory = path.resolve(node.directory, decl.sourcePath);
      const found = nodes.find((n) => dirKey(n.directory) === dirKey(directory));
      if (!found) return { alias: decl.alias, project: decl.project, sourceKind: 'path', directory, audience: 'instance' };
      if (found.id !== decl.project) {
        return unresolved(`the family project at source.path "${decl.sourcePath}" answers to ${found.id === undefined ? 'no id' : `"${found.id}"`}, not "${decl.project}"`);
      }
      return familyExternal(decl.alias, decl.project, node, found);
    }
    const holders = nodes.filter((n) => n.id === decl.project && n !== node);
    if (holders.length === 0) return unresolved(`no project of the family answers to "${decl.project}", and no source.path says where to find it`);
    if (holders.length > 1) return unresolved(`${holders.length} projects of the family answer to "${decl.project}" (${holders.map((n) => `"${n.namespace || '(the bound root)'}"`).join(', ')}), so the declaration could mean either`);
    return familyExternal(decl.alias, decl.project, node, holders[0]);
  });
}

/** The specs a reference collection reads, loaded once. */
interface ScannedSpecs {
  subsystems: SubsystemSpec[];
  components: ComponentSpec[];
  interfaces: InterfaceSpec[];
  implementations: ImplementationSpec[];
  types: TypeSpec[];
}

/**
 * Collect every reference in a counted position whose producer is known and
 * differs from the owner of the referring spec. Positions the loader leaves
 * raw (declared calls, auth sources, type names) are qualified from the
 * referring spec's project first.
 */
function crossReferences(family: ProjectFamily, specs: ScannedSpecs): CrossProjectReference[] {
  const out: CrossProjectReference[] = [];
  const seen = new Set<string>();
  const add = (specId: string, position: string, raw: string | undefined, member?: string, qualify = false): void => {
    if (!raw) return;
    const consumer = family.owners.get(specId);
    if (consumer === undefined) return;
    const target = qualify ? qualifyReference(family, raw, consumer) : raw.startsWith('::') ? raw.slice(2) : raw;
    if (target === null) return;
    const producer = producerOf(family, target);
    if (!producer || producer.namespace === consumer) return;
    const key = `${specId}|${position}|${target}|${member ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ specId, position, target, ...(member !== undefined ? { member } : {}), consumer, producer: producer.namespace });
  };
  const addTypes = (specId: string, typeStr: string | undefined): void => {
    for (const ref of extractTypeIdentifiers(typeStr ?? '')) {
      if (ref.includes('::')) add(specId, 'type', ref, undefined, true);
    }
  };
  for (const sub of specs.subsystems) {
    for (const le of sub.lifecycle ?? []) add(sub.id, 'lifecycle', le.component, le.method);
    for (const pi of sub.publicInterfaces) {
      if (pi.from === undefined) continue;
      add(sub.id, 'reexport', pi.from);
      add(sub.id, 'reexport', pi.component);
      add(sub.id, 'reexport', pi.typeDef);
    }
  }
  for (const comp of specs.components) {
    comp.dependsOn.forEach((d) => add(comp.id, 'dependsOn', d));
    comp.dispatch?.forEach((b) => add(comp.id, 'dispatch-table', b.component, b.method));
    comp.mounts?.forEach((m) => add(comp.id, 'mounts', m.portal));
  }
  for (const intf of specs.interfaces) {
    for (const m of intf.methods) {
      addTypes(intf.id, m.returns);
      m.params?.forEach((p) => addTypes(intf.id, p.type));
    }
  }
  for (const impl of specs.implementations) {
    for (const method of impl.methods) {
      for (const step of method.narrative) {
        if (step.type === 'call' || step.type === 'register') add(impl.id, step.type, step.targetComponent, step.targetMethod);
        if (step.type === 'dispatch') add(impl.id, 'dispatch', step.targetComponent, step.capability ? `capability:${step.capability}` : undefined);
        const source = (step as { auth?: { from?: string } }).auth?.from;
        if (typeof source === 'string' && source.startsWith(COMPONENT_AUTH_SOURCE)) {
          add(impl.id, 'auth', source.slice(COMPONENT_AUTH_SOURCE.length), undefined, true);
        }
      }
      for (const entry of method.calls ?? []) {
        const call = parseDeclaredCall(entry);
        if (call) add(impl.id, 'calls', call.compId, call.methodName, true);
      }
    }
  }
  for (const t of specs.types) t.fields.forEach((f) => addTypes(t.id, f.type));
  return out;
}

/** iproject_family_index.graph — the whole project graph of the current scan. */
export function projectFamilyGraph(): ProjectFamily {
  // Step 1: the roots the current scan read — the scan the graph is memoized on.
  const roots = listProjectRoots();
  // Step 2: memoized for this scan?
  const cached = memo.get(roots);
  if (cached) return cached;
  // Steps 3-7: the scanned specs the references are read from.
  const specs: ScannedSpecs = {
    subsystems: loadSubsystemSpecs(),
    components: loadComponentSpecs(),
    interfaces: loadInterfaceSpecs(),
    implementations: loadImplementationSpecs(),
    types: loadTypeSpecs(),
  };
  // Step 8: one node per root.
  const nodes = makeNodes(roots);
  // Step 9: the owner of every spec id — the root whose files declared it (a
  // later root wins, so a member owns the mount that realizes it).
  const owners = new Map<string, string>();
  for (const root of roots) for (const id of root.specIds) owners.set(id, root.namespace);
  // Step 10: the family's identity problems.
  const family: ProjectFamily = { nodes, owners, authoredReferences: [], problems: identityProblems(nodes), references: [] };
  // Steps 11-12: each node's externals, bound to their producers.
  nodes.forEach((node, i) => { node.externals = bindExternals(node, roots[i], nodes); });
  // Step 13: the references that leave the project making them.
  family.references = crossReferences(family, specs);
  // Step 14: every root's leading-`::` references.
  family.authoredReferences = roots.flatMap((r) => r.authoredReferences);
  // Step 15: memoized on this scan.
  memo.set(roots, family);
  // Step 16: the graph.
  return family;
}
