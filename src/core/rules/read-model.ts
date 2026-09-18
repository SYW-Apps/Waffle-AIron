import {
  implementationSourceFiles,
  isPattern,
  isRetired,
  pathKey,
  resolveImport,
  type CodeModel,
  type ComponentSpec,
  type ImplementationSpec,
  type SourceFileFacts,
} from '../../models/index.js';
import type {
  CodeIndex,
  DependencyEdge,
  DependencyEdges,
  ImportGraph,
  OwnershipIndex,
  RealizationIndex,
  RuleContext,
} from './types.js';

// ---------------------------------------------------------------------------
// The validation run's shared derived read model.
//
// Four indexes were rebuilt inside individual rules — the same walk, in file
// after file, with subtly different shapes. They live here instead, behind the
// memoized rule_context methods that hand them out, so every rule reads ONE
// index and a rule can be split without rebuilding one twice.
//
// Everything here is PURE: it derives from the loaded specs and the code model
// and reports nothing. The semantics that decide findings (which ownership
// claims record an owner; which files an import may be resolved against) are
// stated once, here, rather than re-derived per rule.
// ---------------------------------------------------------------------------

/** The empty answer every "names at a path" accessor returns for a path the run never analyzed. */
const NO_NAMES: ReadonlySet<string> = new Set<string>();

function appendUnique<T>(map: Map<string, T[]>, key: string, value: T, same?: (a: T, b: T) => boolean): void {
  const list = map.get(key);
  if (!list) {
    map.set(key, [value]);
    return;
  }
  if (same ? list.some(v => same(v, value)) : list.includes(value)) return;
  list.push(value);
}

/**
 * code_index — the run's source-code model keyed for lookup: each analyzed
 * path's facts and its three anchor tiers, built once and read by every
 * conformance rule (and the narrative detail dial) instead of once per rule.
 */
export function buildCodeIndex(model: CodeModel): CodeIndex {
  const facts = new Map<string, SourceFileFacts>();
  const paths = new Set<string>();
  const exactPaths = new Set<string>();
  for (const f of model.files) {
    const key = pathKey(f.path);
    // The model holds one entry per key; were it to hold two, the later one
    // answers — exactly as the keyed maps the rules used to build did.
    facts.set(key, f);
    paths.add(key);
    if (f.status === 'analyzed' && f.analysisGrade === 'exact') exactPaths.add(key);
  }

  // The anchor tiers are built on first ask and kept: most runs read a handful
  // of paths, and a rule that reads them all pays for the walk once.
  const declarations = new Map<string, Set<string>>();
  const anchors = new Map<string, Set<string>>();
  const findingAnchors = new Map<string, Set<string>>();

  const namesAt = (
    cache: Map<string, Set<string>>,
    path: string,
    make: (f: SourceFileFacts) => Set<string>,
  ): ReadonlySet<string> => {
    const cached = cache.get(path);
    if (cached) return cached;
    const f = facts.get(path);
    if (!f) return NO_NAMES;
    const built = make(f);
    cache.set(path, built);
    return built;
  };

  return {
    paths,
    exactPaths,
    factsAt: (path) => facts.get(pathKey(path)),
    declarationsAt: (path) =>
      namesAt(declarations, pathKey(path), f => new Set([...f.declaredNames, ...f.exportedNames])),
    anchorsAt: (path) =>
      namesAt(anchors, pathKey(path), f => new Set([...f.declaredNames, ...f.exportedNames, ...f.anchoredNames])),
    findingAnchorsAt: (path) => namesAt(findingAnchors, pathKey(path), f => new Set(f.anchoredNames)),
  };
}

/**
 * realization_index — which source files realize which components, both ways.
 * ONE walk of the implementations whose contract and component resolve and
 * that do not sit in a chained subproject (a chained child's sourcePaths are
 * relative to its own root, and the child validates them in its own run).
 *
 * The relation is unfiltered on purpose: which files may ACCUSE (exact grade)
 * or count as present (analyzed or unreadable) is rule doctrine, applied by
 * the rule against the code index — not a property of who realizes what.
 */
export function buildRealizationIndex(ctx: RuleContext): RealizationIndex {
  const implsByComponent = new Map<string, ImplementationSpec[]>();
  const implsByPath = new Map<string, ImplementationSpec[]>();
  const filesByComponent = new Map<string, string[]>();
  const filesBySubsystem = new Map<string, string[]>();
  const componentsByPath = new Map<string, ComponentSpec[]>();
  const paths: string[] = [];
  const seenPaths = new Set<string>();

  for (const impl of ctx.implementations) {
    const contract = ctx.interfaceMap.get(impl.contract);
    if (!contract) continue;
    const component = ctx.componentMap.get(contract.component);
    if (!component) continue;
    if (ctx.isInChainedSubproject(component.subsystem)) continue;

    appendUnique(implsByComponent, component.id, impl);
    for (const file of implementationSourceFiles(impl)) {
      const p = pathKey(file);
      if (!seenPaths.has(p)) { seenPaths.add(p); paths.push(p); }
      appendUnique(implsByPath, p, impl);
      appendUnique(filesByComponent, component.id, p);
      appendUnique(filesBySubsystem, component.subsystem, p);
      appendUnique(componentsByPath, p, component, (a, b) => a.id === b.id);
    }
  }

  const NONE_IMPL: ImplementationSpec[] = [];
  const NONE_COMP: ComponentSpec[] = [];
  const NONE_PATH: string[] = [];
  return {
    paths,
    implementationsOf: (compId) => implsByComponent.get(compId) ?? NONE_IMPL,
    implementationsAt: (path) => implsByPath.get(pathKey(path)) ?? NONE_IMPL,
    filesOf: (compId) => filesByComponent.get(compId) ?? NONE_PATH,
    filesIn: (subsystemId) => filesBySubsystem.get(subsystemId) ?? NONE_PATH,
    componentsAt: (path) => componentsByPath.get(pathKey(path)) ?? NONE_COMP,
  };
}

/**
 * import_graph — the resolved import graph over a CLOSED set of source paths.
 * Resolution is pure string matching against that set, so the set is part of
 * the graph's identity: dependency conformance accuses only between
 * component-mapped exact-grade files, while an integration harness is walked
 * over every path the run analyzed.
 *
 * A file's runtime imports are collaboration; its export-from re-exports are
 * surface republication. Together they are the file's TRACES: never an
 * accusation on their own, but enough to realize a declared forwarding edge.
 */
export function buildImportGraph(index: CodeIndex, universe: Set<string>): ImportGraph {
  const imports = new Map<string, Set<string>>();
  const traces = new Map<string, Set<string>>();

  const resolveAll = (from: string, specifiers: string[], into: Set<string>): void => {
    for (const specifier of specifiers) {
      const to = resolveImport(from, specifier, universe);
      if (to && to !== from) into.add(to);
    }
  };

  const importsOf = (path: string): ReadonlySet<string> => {
    const cached = imports.get(path);
    if (cached) return cached;
    const facts = index.factsAt(path);
    const out = new Set<string>();
    if (facts?.status === 'analyzed') resolveAll(path, facts.imports, out);
    imports.set(path, out);
    return out;
  };

  const tracesOf = (path: string): ReadonlySet<string> => {
    const cached = traces.get(path);
    if (cached) return cached;
    const facts = index.factsAt(path);
    const out = new Set<string>(importsOf(path));
    if (facts?.status === 'analyzed') resolveAll(path, facts.reexports, out);
    traces.set(path, out);
    return out;
  };

  return {
    paths: [...universe],
    importsOf,
    tracesOf,
    connects: (from, to, allowReverse) => {
      for (const f of from) {
        const forward = tracesOf(f);
        for (const t of to) if (forward.has(t)) return true;
      }
      if (allowReverse) {
        for (const t of to) {
          const reverse = tracesOf(t);
          for (const f of from) if (reverse.has(f)) return true;
        }
      }
      return false;
    },
    reachFrom: (start) => {
      const seen = new Set<string>([start]);
      const stack = [start];
      while (stack.length) {
        const from = stack.pop()!;
        for (const to of tracesOf(from)) {
          if (seen.has(to)) continue;
          seen.add(to);
          stack.push(to);
        }
      }
      return seen;
    },
  };
}

/**
 * ownership_index — which pattern privately owns each member block, the tree's
 * ONE ownership reading.
 *
 * A claim records an owner only when it is a legal one, and each skip is a
 * finding somewhere else rather than a silent default:
 *  - a RETIRED component records nothing (its migration decides what its owns
 *    becomes, and retired-stereotypes reports it once);
 *  - a BLOCK's claim records nothing (BLOCK_OWNS_MEMBERS is the whole finding,
 *    so the member it named stays standalone and its dependants are judged as
 *    if the claim were absent);
 *  - an UNRESOLVED member records nothing (INVALID_OWNED_MEMBER);
 *  - an INNER PATTERN records nothing (PATTERN_OWNS_PATTERN — patterns compose
 *    at L1, so its dependants get no visibility finding on top);
 *  - and where two patterns claim one block the FIRST claimant stays the
 *    owner, so every later claim is reported against that first owner.
 */
export function buildOwnershipIndex(ctx: RuleContext): OwnershipIndex {
  const ownedBy = new Map<string, string>();
  for (const comp of ctx.components) {
    if (isRetired(comp) || !isPattern(comp)) continue;
    for (const memberId of comp.owns) {
      const member = ctx.componentMap.get(memberId);
      if (!member || isPattern(member)) continue;
      if (!ownedBy.has(memberId)) ownedBy.set(memberId, comp.id);
    }
  }
  return {
    ownedMembers: new Set(ownedBy.keys()),
    ownerOf: (memberId) => ownedBy.get(memberId),
  };
}

/**
 * dependency_edges — every dependsOn edge in the tree, resolved once.
 *
 * Five doctrine rules judge these edges, and each of them used to re-pay the
 * same prologue before it could judge anything: walk the components, walk
 * their dependsOn, resolve the id, decide what an unresolved one means, skip
 * an edge with a retired end, tell an intra-subsystem edge from a boundary
 * crossing, and let the governing pack profile license the pair. That prologue
 * is the edge, here, so each rule starts at its own question.
 *
 * The pack `allowedEdges` escape is why this must be ONE reading: it relaxes
 * the whole intra-subsystem matrix, and a matrix split five ways would
 * otherwise repeat the escape five times — where a licensed edge would escape
 * some parts of it and not others.
 */
export function buildDependencyEdges(ctx: RuleContext): DependencyEdges {
  const all: DependencyEdge[] = [];
  const matrix: (DependencyEdge & { to: ComponentSpec })[] = [];

  for (const from of ctx.components) {
    const fromDraft = ctx.isComponentDraft(from.id);
    // The governing profile is a property of the SOURCE component, so it is
    // read once per component rather than once per edge.
    const profile = ctx.ext.profiles[ctx.getComponentProfile(from.id)];

    for (const ref of from.dependsOn) {
      const to = ctx.componentMap.get(ref);
      if (!to) {
        all.push(offTreeEdge(ctx, from, ref, fromDraft));
        continue;
      }
      const edge = {
        from,
        ref,
        to,
        reach: (to.subsystem === from.subsystem ? 'internal' : 'cross-subsystem') as EdgeReachResolved,
        retired: isRetired(from) || isRetired(to),
        draftContext: fromDraft || ctx.isComponentDraft(to.id),
        licensed: profile?.allowedEdges?.some(
          e => e.from.includes(from.componentType) && e.to.includes(to.componentType),
        ) ?? false,
      };
      all.push(edge);
      if (edge.reach === 'internal' && !edge.retired && !edge.licensed) matrix.push(edge);
    }
  }

  return { all, matrix };
}

/** The two reaches a ref that resolved in this tree can have. */
type EdgeReachResolved = 'internal' | 'cross-subsystem';

/**
 * A ref that names no component in this tree. Only a ref authored to LEAVE the
 * tree — an explicit cross-tree form, or one the loader collapsed at this root
 * from inside a chained mount — is resolved against the stored surface
 * snapshots, and only a HIT changes anything: from this root the whole tree is
 * loaded, so a collapsed ref no snapshot covers is genuinely missing. Snapshots
 * that answer with different contracts decide nothing either way — the
 * ambiguity is the verdict.
 *
 * The edge is never marked retired: a reference finding stands whatever
 * declares it, retired or not.
 */
function offTreeEdge(ctx: RuleContext, from: ComponentSpec, ref: string, fromDraft: boolean): DependencyEdge {
  const base = { from, ref, retired: false, draftContext: fromDraft, licensed: false };
  const external = ctx.isExternalNamespaceRef(ref);
  if (external || ctx.isCollapsedCrossTreeRef(ref, from.subsystem)) {
    const surface = ctx.resolveSurfaceRef(ref, from.subsystem);
    if (surface.kind === 'ambiguous') return { ...base, reach: 'ambiguous', surface };
    if (surface.kind === 'resolved') return { ...base, reach: 'surface', surface };
    if (external) return { ...base, reach: 'unpinned' };
  }
  return { ...base, reach: 'missing' };
}
