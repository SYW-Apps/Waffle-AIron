import * as path from 'path';
import {
  bindDeclaredExternal,
  declaredExternals,
  declaredMembers,
  effectiveProjectId,
  parseDeclaredCall,
  producerOf,
  type AuthoredReference,
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
  retiredMountsOf,
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
// The scan already walked every member and bound every reference: it recorded
// each project root it read (key, parent, alias and form, legacy mount,
// directory, configuration, alias table, the keys its files declared, and every
// reference with `::` as bound). This Index projects those roots and the
// scanned specs into one node per project, an owner for every spec key, the
// references that leave the project making them, and the family's problems —
// once per scan, memoized on it and dropped with it, so it is never stale. It
// reads the bindings; it qualifies nothing itself. The lookups (node, ownerOf,
// producerOf, declares, dependencyCycles) are pure methods of the
// ProjectFamily value, so the Index publishes the graph alone. It does no I/O
// and judges nothing.
// ---------------------------------------------------------------------------

/** The graph a scan projected, dropped with the scan's root list. */
const memo = new WeakMap<ScannedProjectRoot[], ProjectFamily>();

/** One node per root: id from project_config.effectiveId(), members and alias table from the scan. */
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
      ...(root.mountForm !== undefined ? { mountForm: root.mountForm } : {}),
      legacyMount: root.legacyMount,
      ...(root.memberDescription !== undefined ? { memberDescription: root.memberDescription } : {}),
      hasSystem: root.system !== null,
      ...(root.system?.targetLanguage ? { targetLanguage: root.system.targetLanguage } : {}),
      directory: root.directory,
      members: roots.filter((r) => r.parent === root.namespace && r.namespace !== root.namespace).map((r) => r.namespace),
      aliases: root.aliases,
      externals: [],
      imports: root.config ? [
        ...declaredMembers(root.config).filter((m) => !m.problem && !root.parts.some((p) => p.alias === m.alias))
          .map((m) => ({ alias: m.alias, section: 'members' as const, use: m.use })),
        ...declaredExternals(root.config).filter((e) => !e.problem).map((e) => ({ alias: e.alias, section: 'externals' as const, use: e.use })),
      ] : [],
      // Stage 8: the root's parts as the scan recorded them — not nodes.
      parts: root.parts,
    };
  });
}

/** The name a key reads as in a finding: the bound root, or the member declared under an alias. */
function describe(node: ProjectNode): string {
  const label = node.id ?? node.name ?? '(no id)';
  return node.namespace === ''
    ? `"${label}" (the bound root)`
    : `"${label}" (member "${node.mountAlias ?? node.namespace}", keyed "${node.namespace}")`;
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
    const member = node.mountAlias ?? node.namespace;
    if (node.idSource === 'none') {
      problems.push({ kind: 'no-id', projects: [node.namespace], detail: `the member "${member}" has no id: it declares none${node.name !== undefined ? ` and its name "${node.name}" yields none` : ', and has no readable configuration'}` });
    } else if (node.idSource === 'name') {
      problems.push({ kind: 'defaulted', id: node.mountAlias, projects: [node.namespace], detail: `the member "${member}" declares no id, so it answers to "${node.id}", its name slug` });
    }
  }
  return problems;
}

/**
 * Bind each of the node's declared externals to its producer (role external),
 * then each of its referenced project members (role member, stage 8) exactly
 * the same way.
 */
function bindExternals(node: ProjectNode, root: ScannedProjectRoot, nodes: ProjectNode[]): ResolvedExternal[] {
  if (!root.config) return [];
  return [...declaredExternals(root.config).map((decl) => bindDeclaredExternal(decl, node, nodes)), ...bindReferencedMembers(node, root)];
}

/**
 * Stage 8: each referenced project member — a `../`, git or hosted source whose
 * content is a project's — bound as a producer outside the family at audience
 * instance: a sibling checkout or a git member at the root the scan located
 * (its pinned commit in the fetch cache), a hosted one left for the hosted
 * record lookup. A part is no producer: its specs are the node's own.
 */
function bindReferencedMembers(node: ProjectNode, root: ScannedProjectRoot): ResolvedExternal[] {
  const out: ResolvedExternal[] = [];
  for (const member of declaredMembers(root.config ?? {})) {
    if (member.problem || member.storage === 'contained' || root.parts.some((p) => p.alias === member.alias)) continue;
    const base = { alias: member.alias, project: member.alias, audience: 'instance', role: 'member' as const };
    if (member.storage === 'hosted') {
      out.push({ ...base, sourceKind: 'hosted', hosted: member.source.hosted });
      continue;
    }
    const located = root.referenced.find((r) => r.alias === member.alias);
    const sourceKind = member.storage === 'git' ? 'git' : 'path';
    const directory = located?.directory ?? (member.storage === 'path' ? path.resolve(node.directory, member.source.path ?? '') : undefined);
    const commit = located?.commit ?? member.source.commit;
    out.push({
      ...base, sourceKind,
      ...(directory !== undefined ? { directory } : {}),
      ...(commit !== undefined ? { commit } : {}),
      ...(located?.availability === 'unavailable' ? { problem: located.reason } : {}),
    });
  }
  return out;
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
 * Collect every reference in a counted position whose bound target lies in
 * another project than the referring spec's owner, from the bindings the scan
 * recorded: the rewritten positions carry the key the scan bound them to, the
 * raw ones (declared calls, auth sources, type names) are read off the authored
 * references. A reference the scan bound as outside or unresolved is not
 * counted — its producer is not in the scan.
 */
function crossReferences(family: ProjectFamily, specs: ScannedSpecs): CrossProjectReference[] {
  const out: CrossProjectReference[] = [];
  const seen = new Set<string>();
  // What the scan bound each reference with `::` to, by spec and bound key.
  const bound = new Map<string, AuthoredReference>();
  for (const ref of family.authoredReferences) {
    const k = `${ref.specId}|${ref.resolved}`;
    if (!bound.has(k)) bound.set(k, ref);
  }
  const push = (ref: CrossProjectReference): void => {
    const key = `${ref.specId}|${ref.position}|${ref.target}|${ref.member ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };
  // The component an implementation realizes: what makes a call its narrative writes.
  const componentOfContract = new Map(specs.interfaces.map((i) => [i.id, i.component] as const));
  const callerOf = new Map(specs.implementations.map((impl) => [impl.id, componentOfContract.get(impl.contract)] as const));
  const add = (specId: string, position: string, value: string | undefined, member?: string, caller?: string): void => {
    if (!value) return;
    const consumer = family.owners.get(specId);
    if (consumer === undefined) return;
    const authored = bound.get(`${specId}|${value}`);
    if (authored && (authored.binding === 'outside' || authored.binding === 'unresolved')) return;
    const producer = authored?.producer ?? producerOf(family, value)?.namespace;
    if (producer === undefined || producer === consumer) return;
    push({
      specId, position, target: value, ...(member !== undefined ? { member } : {}), consumer, producer,
      authored: authored?.authored ?? value, ...(authored?.publicName !== undefined ? { publicName: authored.publicName } : {}),
      ...(caller !== undefined ? { caller } : {}),
    });
  };
  // A raw position: read off the scan's authored reference.
  const addRaw = (ref: AuthoredReference, position: string, member?: string, caller?: string): void => {
    if (ref.binding === 'outside' || ref.binding === 'unresolved' || ref.producer === undefined) return;
    const consumer = family.owners.get(ref.specId);
    if (consumer === undefined || ref.producer === consumer) return;
    push({
      specId: ref.specId, position, target: ref.resolved, ...(member !== undefined ? { member } : {}), consumer, producer: ref.producer,
      authored: ref.authored, ...(ref.publicName !== undefined ? { publicName: ref.publicName } : {}),
      ...(caller !== undefined ? { caller } : {}),
    });
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
    retiredMountsOf(comp).mounts.forEach((m) => add(comp.id, 'mounts', m.portal));
  }
  const calledMethod = new Map<string, string>();
  for (const impl of specs.implementations) {
    for (const method of impl.methods) {
      for (const step of method.narrative) {
        if (step.type === 'call' || step.type === 'register') add(impl.id, step.type, step.targetComponent, step.targetMethod, callerOf.get(impl.id));
        if (step.type === 'dispatch') add(impl.id, 'dispatch', step.targetComponent, step.capability ? `capability:${step.capability}` : undefined, callerOf.get(impl.id));
      }
      for (const entry of method.calls ?? []) {
        const call = parseDeclaredCall(entry);
        if (call) calledMethod.set(`${impl.id}|${call.compId}`, call.methodName);
      }
    }
  }
  for (const ref of family.authoredReferences) {
    if (ref.position === 'type') addRaw(ref, 'type');
    else if (ref.position === 'auth') addRaw(ref, 'auth');
    else if (ref.position === 'implements') {
      // An implemented extension point is used method by method: each one a pin records.
      for (const method of implementedMethods(ref.specId, ref.authored)) addRaw(ref, 'implements', method);
    }
    else if (ref.position === 'calls') addRaw(ref, 'calls', calledMethod.get(`${ref.specId}|${ref.authored}`), callerOf.get(ref.specId));
  }
  return out;
}

/**
 * The methods of an extension point an implementing contract uses: each
 * method it declares, by the name it takes its signature from when that is a
 * method of the implemented export (`alias::name.method`), else by its own
 * name — an implementation declares every method of the point under its name.
 * What a pin records a digest for, so a producer renaming or changing a method
 * a consumer implements is a moved use like any call.
 */
export function implementedMethods(interfaceId: string, implemented: string): string[] {
  const intf = loadInterfaceSpecs().find((i) => i.id === interfaceId);
  const out = new Set<string>();
  for (const method of intf?.methods ?? []) {
    const source = method.signatureFrom;
    const dot = source?.lastIndexOf('.') ?? -1;
    out.add(source !== undefined && dot > 0 && source.slice(0, dot) === implemented ? source.slice(dot + 1) : method.name);
  }
  return [...out];
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
  // Step 9: the owner of every spec key — the root whose files declared it.
  const owners = new Map<string, string>();
  for (const root of roots) for (const id of root.specIds) if (!owners.has(id)) owners.set(id, root.namespace);
  // Step 10: the family's problems — identity from the nodes, membership and
  // duplicate keys as the scan met them.
  const family: ProjectFamily = {
    nodes,
    owners,
    authoredReferences: [],
    problems: [...identityProblems(nodes), ...roots.flatMap((r) => r.problems)],
    references: [],
  };
  // Steps 11-12: each node's externals, bound to their producers.
  nodes.forEach((node, i) => { node.externals = bindExternals(node, roots[i], nodes); });
  // Step 14: every root's authored references, each with its form, binding and rewrite.
  family.authoredReferences = roots.flatMap((r) => r.authoredReferences);
  // Step 13: the references that leave the project making them, from the bindings.
  family.references = crossReferences(family, specs);
  // Step 15: memoized on this scan.
  memo.set(roots, family);
  // Step 16: the graph.
  return family;
}
