import {
  fieldTypesOf,
  implementationSourceFiles,
  importBindingOf,
  isPattern,
  isRetired,
  localTypesOf,
  methodSourceFile,
  pathKey,
  resolveImport,
  typeBindingOf,
  type CallSiteFact,
  type CodeModel,
  type ComponentSpec,
  type ImplementationSpec,
  type SourceFileFacts,
} from '../../models/index.js';
import type {
  CodeIndex,
  ForwardedName,
  DependencyEdge,
  DependencyEdges,
  ImportGraph,
  OwnershipIndex,
  RealizationIndex,
  ResolvedMethod,
  RuleContext,
  SpecId,
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

  // What a module REPUBLISHES, transitively and itself included: a call
  // resolved to a barrel lands in the file the barrel re-exports from, so the
  // hop is part of resolution rather than something each reader re-walks.
  const republished = new Map<string, ReadonlySet<string>>();
  const republishedFrom = (path: string): ReadonlySet<string> => {
    const cached = republished.get(path);
    if (cached) return cached;
    const out = new Set<string>([path]);
    const queue = [path];
    while (queue.length) {
      const from = queue.pop()!;
      const f = facts.get(from);
      if (f?.status !== 'analyzed') continue;
      for (const specifier of f.reexports) {
        const to = resolveImport(from, specifier, paths);
        if (to && !out.has(to)) { out.add(to); queue.push(to); }
      }
    }
    republished.set(path, out);
    return out;
  };

  const NO_ORIGIN: ReadonlySet<string> = new Set<string>();

  /** Where a module specifier LANDS from a file: the module, widened by what it republishes. */
  const landingFrom = (scope: string, specifier: string): ReadonlySet<string> => {
    const to = resolveImport(scope, specifier, paths);
    return to ? republishedFrom(to) : NO_ORIGIN;
  };

  /**
   * The file a site's names resolve in, and its facts — but only at EXACT
   * grade, since a weaker grade records no bindings to resolve WITH. A carried
   * site names the file it was READ in; its names resolve in that file's
   * scope, never in the barrel that republished it.
   */
  const scopeOf = (site: CallSiteFact, from: string): { path: string; facts: SourceFileFacts } | undefined => {
    const path = pathKey(site.from ?? from);
    const f = facts.get(path);
    return f?.status === 'analyzed' && f.analysisGrade === 'exact' ? { path, facts: f } : undefined;
  };

  const originOf = (site: CallSiteFact, from: string): ReadonlySet<string> => {
    const resolved = scopeOf(site, from);
    // An empty answer says exactly that a pure model cannot say — never that
    // the call is absent.
    if (!resolved) return NO_ORIGIN;
    const { path: scope, facts: f } = resolved;
    const landing = (specifier: string): ReadonlySet<string> => landingFrom(scope, specifier);
    if (!site.member) {
      const binding = importBindingOf(f, site.name);
      if (binding) return landing(binding.from);
      // Declared here and imported from nowhere: the function is this file's
      // own. Anything else is a global, an ambient or an injected name.
      return declarationsAt(scope).has(site.name) ? republishedFrom(scope) : NO_ORIGIN;
    }
    // `ns.save()` is that module's own export whenever `ns` is a NAMESPACE
    // binding: its properties are that module's exports, nothing else.
    if (!site.via) return NO_ORIGIN;
    const receiver = importBindingOf(f, site.via);
    if (!receiver) return NO_ORIGIN;
    if (receiver.namespace) return landing(receiver.from);
    // Through a VALUE the module handed over (`hostCore.renderDiagram()`) the
    // property could have been attached anywhere, so the module alone is not
    // an answer — it becomes one only when that module declares the invoked
    // name as well (the object literal's own key, the function it holds).
    // Where it does not, the value was assembled elsewhere and this resolves
    // to nothing rather than to the nearest module in sight.
    const through = landing(receiver.from);
    for (const candidate of through) {
      if (declarationsAt(candidate).has(site.name)) return through;
    }
    return NO_ORIGIN;
  };

  /**
   * The same question, asked one tier weaker: every file the callee CAN have
   * been written in. Three receivers are followed, and every one of them
   * through a NAME the code writes down rather than through a value it holds.
   *
   *   `this.<field>.save()`  through the TYPE the class declares that field
   *                          with — its import binding (type-only or runtime
   *                          alike, since a declared type may be spelled
   *                          either way), else this file when it declares that
   *                          name itself.
   *   `new Class().save()`   through the module the CLASS NAME came from — its
   *                          RUNTIME import binding only, because a
   *                          constructed class is a value and a type-only
   *                          binding could never have built one — else this
   *                          file when it declares that class.
   *   `store.save()`         through the type the file ANNOTATES that name
   *                          with — a parameter's, or an annotated variable
   *                          declaration's — resolved exactly as a field's
   *                          declared type is. A module that wires its
   *                          collaborators as closures (`storeOver(adapter,
   *                          root)`) writes every one of its calls this way,
   *                          and the name it calls through is a plain
   *                          identifier the file declared what it is.
   *
   * All three are POSSIBILITIES and not facts. A declared type says what a
   * collaborator IS, never which class ships the body, so an interface's
   * implementor may live anywhere; a constructed class says where the CLASS
   * was written, never where a method it INHERITS was, and a base class lives
   * in whatever module it likes. The annotated name adds one more reason:
   * these facts are keyed per FILE, so same-named bindings in different
   * functions union their declared types and the answer is wider still. Which
   * is why this tier is separate rather than folded into originOf — a rule may
   * ACCEPT a call on it, and must never accuse one on it. A field or a name
   * the file annotates with nothing, and a class name it cannot place, resolve
   * to nothing, exactly as the proven tier does.
   *
   * What it deliberately does not do is follow the annotation's own
   * DECLARATION: the name leads to the module that declares it, and whether
   * that declaration is an interface, a class or a `Pick<…>` alias is not
   * read. Where the type is written is the question; what it expands to is
   * not, and expanding it would be inference rather than a record of what the
   * code says.
   */
  const possibleOriginsOf = (site: CallSiteFact, from: string): ReadonlySet<string> => {
    const proven = originOf(site, from);
    if (!site.field && !site.constructed && !site.via) return proven;
    const resolved = scopeOf(site, from);
    if (!resolved) return proven;
    const { path: scope, facts: f } = resolved;
    const out = new Set(proven);
    /** Where a NAME this file writes down leads: its module, else this file when it declares it. */
    const widenThrough = (name: string, specifier: string | undefined): void => {
      const landings = specifier !== undefined
        ? landingFrom(scope, specifier)
        : declarationsAt(scope).has(name) ? republishedFrom(scope) : NO_ORIGIN;
      for (const candidate of landings) out.add(candidate);
    };
    /** A declared type name, followed wherever it was written down. */
    const widenThroughType = (typeName: string): void => widenThrough(typeName, typeBindingOf(f, typeName));
    if (site.field) for (const typeName of fieldTypesOf(f, site.field)) widenThroughType(typeName);
    if (site.constructed) widenThrough(site.constructed, importBindingOf(f, site.constructed)?.from);
    // A receiver that is a plain identifier the file ANNOTATED. It is asked
    // on top of whatever originOf already proved through an import binding of
    // the same name, never instead of it: both readings are things the file
    // writes down, and this tier's question is what a call CAN have reached.
    if (site.via) for (const typeName of localTypesOf(f, site.via)) widenThroughType(typeName);
    return out;
  };

  const declarationsAt = (path: string): ReadonlySet<string> =>
    namesAt(declarations, pathKey(path), f => new Set([...f.declaredNames, ...f.exportedNames]));

  const forwardsOf = (start: string, name: string): ForwardedName[] => {
    const out: ForwardedName[] = [];
    const seen = new Set<string>();
    const queue: ForwardedName[] = [{ file: pathKey(start), name }];
    while (queue.length) {
      const at = queue.shift()!;
      const key = `${at.file}#${at.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(at);
      for (const binding of facts.get(at.file)?.reexportBindings ?? []) {
        const star = binding.exported === '*';
        if (!star && binding.exported !== at.name) continue;
        // A star re-export never republishes a module's default export.
        if (star && at.name === 'default') continue;
        const to = resolveImport(at.file, binding.from, paths);
        if (!to) continue;
        // A star forwards only the names its module actually publishes.
        if (star && !facts.get(to)?.exportedNames.includes(at.name)) continue;
        queue.push({ file: to, name: star ? at.name : binding.local });
      }
    }
    return out;
  };

  return {
    paths,
    exactPaths,
    factsAt: (path) => facts.get(pathKey(path)),
    declarationsAt,
    anchorsAt: (path) =>
      namesAt(anchors, pathKey(path), f => new Set([...f.declaredNames, ...f.exportedNames, ...f.anchoredNames])),
    findingAnchorsAt: (path) => namesAt(findingAnchors, pathKey(path), f => new Set(f.anchoredNames)),
    originOf,
    possibleOriginsOf,
    forwardsOf,
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

/**
 * spec_ids — every spec id in the tree, each carrying the kind label its
 * findings name it by, in subsystem, component, interface, implementation,
 * type order.
 *
 * The id hygiene rules judge ids and nothing else. Reaching them meant
 * unrolling the same check across five typed collections, once per rule — the
 * walk was most of what those narratives said. It is one list here, so each
 * rule is one loop over one question.
 *
 * Every id is returned, in scope or not: which specs a rule may ACCUSE is the
 * stance that rule states for itself (ctx.isSpecInScope), never a filter the
 * read model applies on its behalf.
 */
export function buildSpecIds(ctx: RuleContext): SpecId[] {
  const out: SpecId[] = [];
  for (const s of ctx.subsystems) out.push({ id: s.id, kind: 'Subsystem' });
  for (const c of ctx.components) out.push({ id: c.id, kind: 'Component' });
  for (const i of ctx.interfaces) out.push({ id: i.id, kind: 'Interface' });
  for (const im of ctx.implementations) out.push({ id: im.id, kind: 'Implementation' });
  for (const t of ctx.types) out.push({ id: t.id, kind: 'Type' });
  return out;
}

/**
 * resolved_methods — every implementation method whose descent resolves, in
 * implementation order then method order, each with the component it realizes,
 * the file that realizes it (the method's sourcePath, else the
 * implementation's) and the draft context a finding on it takes.
 *
 * The descent is the same six hops in rule after rule — implementation,
 * contract, component, chained-subproject skip, method, source file — and it
 * is plumbing in all of them: an implementation whose contract or component
 * does not resolve is a hierarchy finding, and a chained child's sourcePaths
 * are relative to its own root, so the child validates them in its own run.
 *
 * The file is handed over RAW, exactly as the spec names it, because that is
 * the string a finding quotes. Whether it exists, what grade it was analyzed
 * at and whether the conformance dial lets the method be judged at all are
 * NOT decided here: that is the honesty stance each rule owes its reader, and
 * it stays written where the reader reads the accusation.
 */
export function buildImplementationMethods(ctx: RuleContext): ResolvedMethod[] {
  const out: ResolvedMethod[] = [];
  for (const impl of ctx.implementations) {
    const contract = ctx.interfaceMap.get(impl.contract);
    if (!contract) continue;
    const component = ctx.componentMap.get(contract.component);
    if (!component) continue;
    if (ctx.isInChainedSubproject(component.subsystem)) continue;

    const draftContext = ctx.isImplementationDraft(impl);
    for (const method of impl.methods) {
      const sourceFile = methodSourceFile(method, impl.sourcePath);
      out.push({
        implementation: impl,
        method,
        component,
        ...(sourceFile !== undefined ? { sourceFile } : {}),
        draftContext,
      });
    }
  }
  return out;
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
