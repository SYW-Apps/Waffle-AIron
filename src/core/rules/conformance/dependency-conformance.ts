import { posix } from 'path';
import {
  fieldTypesOf, implementationSourceFiles, importBindingOf, localTypesOf, methodSourceFile, pathKey, resolveImport,
  technologyName, technologyPackages, TECHNOLOGY_PACKAGES, type CallSiteFact, type ComponentSpec, type ImplementationSpec, type ResolvedCallFact,
} from '../../../models/index.js';
import { closedCallSites, throughText, unownedReach, writeCandidates } from './call-conformance.js';
import { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Dependency conformance (code↔spec Level 2)
//
// The spec declares who collaborates (dependsOn/owns); the code's runtime
// import graph is the physical record of who ACTUALLY collaborates. This rule
// lifts file→file import edges (between component-mapped files only) to
// component sets — a component maps to every file its implementations name,
// each implementation's sourcePath and each method's own sourcePath — and
// checks both directions:
//
//   UNDECLARED_DEPENDENCY — an import edge no declared relation justifies.
//     Justified when the two files share a component, any component pair has
//     a direct dependsOn/owns edge, the target is a member of a pattern the
//     importer depends on, or — across subsystems — the importer declares an
//     edge to the target subsystem's PUBLISHED surface. This rule asks only
//     whether the hop is declared; WHERE the import lands (the portal file
//     or past it) is portal-imports' question.
//
//   UNREALIZED_DEPENDENCY — a declared dependsOn/owns edge between components
//     realized in different files with NO import edge between any file of the
//     source and any file of the target (for a cross-subsystem portal edge: no
//     import landing anywhere in the target subsystem). Skipped when either
//     side shares a file (N:1 collapse) — dependency-injection indirection can
//     also produce false positives, which is why this stays a warning.
//
// Who realizes what comes from the shared realization index; the edges come
// from the shared import graph, built over the component-mapped exact-grade
// files ALONE. That closed set is part of the graph's identity: resolution is
// pure string matching against it (.js→.ts swaps, index files), so widening it
// would resolve specifiers differently. Only exact-grade (AST) analyzed files
// participate; pattern/generic imports are too coarse to accuse anyone with.
// Type-only imports never ACCUSE (they are no runtime edge, and type coupling
// is allowed), but they do REALIZE a declared edge: a collaborator injected
// through its constructor is reached through its type, and `import type` is
// the whole of what dependency injection writes down in the consumer's file.
// Chained-subproject implementations validate standalone in their own run and
// are absent from the realization index, as in Level 1.
// ---------------------------------------------------------------------------

/**
 * How a finding quotes a Portal's call: as written — a reference without the
 * call parentheses — and, for one reached through unowned code, the site in
 * the Portal's own code, the call it reaches there and the hops between.
 */
function quoteCall(call: ResolvedCallFact, site: ResolvedCallFact, through: readonly string[]): string {
  const as = (c: ResolvedCallFact): string => (c.reference ? `\`${c.written}\` (taken as a value)` : `\`${c.written}(…)\``);
  return through.length ? `${as(site)}, which reaches ${as(call)}${throughText(through)}` : as(call);
}

export const dependencyConformanceRule: SddRule = {
  name: 'dependency-conformance',
  judges: 'code',
  description:
    'Code↔spec Level 2: runtime import edges between component-mapped source files (a component maps to every file its implementations and their methods name) must be justified by declared relations — a direct dependsOn/owns pair, a shared component, membership in a depended-on pattern, or (across subsystems) a declared edge to the target subsystem\'s published surface (UNDECLARED_DEPENDENCY). A type-only import alone never accuses — type coupling is allowed — but a CALL of a modelled contract method through a collaborator whose declared type comes from another component\'s file is runtime collaboration whatever the import\'s form, and the same justification is owed (UNDECLARED_DEPENDENCY on that edge). Conversely, a declared dependsOn/owns edge between components realized in different files should be visible as an import between any file of the source and any file of the target, or — where the type checker read a file of the source — as a call or reference the checker lands in a file of the target, through every barrel, port declaration, dependency bag and unowned helper (UNREALIZED_DEPENDENCY — DI indirection can defeat the import reading, hence warning); a type-only import realizes it, since `import type` is what dependency injection writes down. An Adapter\'s edge to a Portal reached over an out-of-process transport (HTTP, gRPC, a bus, a CLI…) is the link the design models: the Adapter\'s transport client realizes it, never an import, so it is never UNREALIZED_DEPENDENCY — and nothing asks for an import across that boundary, which would couple two deployables\' builds. Two twins of design rules are judged on the same code: a Portal file calling a write- or lifecycle-effect contract method of a Repository, Index, Store or Registry is the persistence shortcut the design rule PORTAL_WRITE_SHORTCUT refuses, unless the Portal\'s own narrative already claims that call (the design rule\'s finding then) (PORTAL_WRITE_SHORTCUT_IN_CODE). A Portal\'s calls are resolved by the TypeScript type checker: every call written in a file realizing only Portals — in a file shared with other components, every call in a body the Portal\'s own methods reach — and every reference there to a function or method the code takes as a value (passed as an argument, assigned, returned, bound, handed to Reflect.apply), together with every call the UNOWNED code they reach makes (a function in a file no component realizes, or one that is none of its file\'s components\' modelled methods, read as if inlined at the call site, transitively to a bounded depth, the finding naming the hops), lands on the declaration its signature resolves to, whatever the receiver\'s spelling, and a declaration in an interface or type shape, a port the Portal declares for itself included, lands on each class of the project that realizes it (the classes whose implements clause names it when any does, else every class the checker finds assignable to it); such a landing on a component the file neither imports at runtime nor is justified to reach is UNDECLARED_DEPENDENCY on that edge. Where no type checker could be loaded, the receiver is followed through the shape facts instead: a non-null assertion, parentheses, `satisfies`, a cast to a named type and a local alias or destructuring of a field exactly as through the field itself. A call in a Portal\'s own code the analysis cannot resolve at all — its receiver typed any or unknown, cast to either or to an index signature, its member picked by a computed key, or typed nothing — under the name of a write- or lifecycle-effect method of a data component (where the checker recorded the receiver\'s ORIGINAL type, before any cast, a write of the data component that type lands on — any of its writes when a computed key names none; else one in the Portal\'s own subsystem or one it depends into), which the Portal does not already claim, fails closed: it is neither proven a shortcut nor cleared, and it is a warning, so a CI gate never passes what it could not read (PORTAL_CALL_UNRESOLVED). And a file importing a technology\'s package while no component it realizes is that technology\'s home is the leak TECH_LEAKAGE refuses in the design (TECH_LEAKAGE_IN_CODE): a technology\'s packages are its declared tokens (its name, or its `matches`), the curated built-in table of the common packages its name is known by (postgres: pg, postgres, @neondatabase/serverless, @vercel/postgres; mysql: mysql2, mysql; redis: redis, ioredis; mongodb: mongodb, mongoose; sqlite: better-sqlite3, sqlite3; kafka: kafkajs; rabbitmq: amqplib — an HTTP client is never a technology leak), and the packages a loaded pack contributes for it, each compared exactly with an import\'s package name. A package of the built-in table or of a loaded pack whose technology NO implementation binds is reported too, since the design never says where that technology lives: bind it on the data-layer component that owns the vendor call. Only exact-grade analyzed files participate; chained subprojects validate standalone.',
  codes: [
    { code: 'UNDECLARED_DEPENDENCY', defaultSeverity: 'warning', summary: 'A runtime import, a call through a type-only-imported collaborator, or a Portal\'s call the type checker resolves into another component\'s file, between component-mapped files has no declared dependsOn/owns (or published-surface) justification' },
    { code: 'PORTAL_WRITE_SHORTCUT_IN_CODE', defaultSeverity: 'error', summary: 'A Portal\'s code calls, or takes as a value, a write- or lifecycle-effect method of a data component (Repository, Index, Store, Registry) — directly or through unowned code it calls — the code twin of PORTAL_WRITE_SHORTCUT: mutations route through an Orchestrator' },
    { code: 'TECH_LEAKAGE_IN_CODE', defaultSeverity: 'warning', summary: 'A source file imports a technology\'s package although no component it realizes binds that technology — the code twin of TECH_LEAKAGE' },
    { code: 'UNREALIZED_DEPENDENCY', defaultSeverity: 'warning', summary: 'A declared dependsOn/owns edge between components in different files is realized by no import between any of their files, nor by any call the type checker lands across it' },
    { code: 'PORTAL_CALL_UNRESOLVED', defaultSeverity: 'warning', summary: 'A call in a Portal\'s own code, under the name of a data component\'s write- or lifecycle-effect method — or with its member picked by a computed key on a receiver that was a data component before a cast — goes through a receiver the analysis cannot resolve (typed any or unknown, cast to either or to an index signature, or typed nothing) — neither proven a shortcut nor cleared, so it fails closed until the receiver carries its type' },
  ],

  check(ctx: RuleContext): void {
    // ---- the mapped files, and the import graph closed over exactly them ----
    const code = ctx.codeIndex();
    const realization = ctx.realizationIndex();
    const reach = unownedReach(ctx);
    const candidatesOf = writeCandidates(ctx);
    const isExact = (p: string): boolean => code.exactPaths.has(p);
    const mappedPaths = new Set(realization.paths.filter(isExact));
    const graph = ctx.importGraph(mappedPaths);

    const exactFiles = new Map<string, string[]>();
    const filesOf = (compId: string): string[] => {
      let files = exactFiles.get(compId);
      if (!files) {
        files = realization.filesOf(compId).filter(isExact);
        exactFiles.set(compId, files);
      }
      return files;
    };
    const mappedImplsOf = (compId: string): ImplementationSpec[] =>
      realization.implementationsOf(compId)
        .filter(impl => implementationSourceFiles(impl).some(f => isExact(pathKey(f))));

    // ---- justification helpers ----
    const dependsOrOwns = (from: ComponentSpec, toId: string): boolean =>
      from.dependsOn.includes(toId) || (from.owns ?? []).includes(toId);

    // Pattern facade ownership, one hop, both directions. This is the PLAIN
    // reading — every owns claim, last claimant winning — deliberately NOT the
    // shared ownership index, which records nothing for an illegal claim. The
    // two differ only on trees that already carry an ownership ERROR, and
    // narrowing this map there would turn one finding into two; adopting the
    // strict reading here is a doctrine decision, not a refactor.
    const ownerOf = new Map<string, ComponentSpec>();
    for (const c of ctx.components) {
      for (const member of c.owns ?? []) ownerOf.set(member, c);
    }

    // Does `from` declare an edge to the published surface of `subsystemId`?
    const declaresSurfaceEdge = (from: ComponentSpec, subsystemId: string): boolean => {
      const published = ctx.publicSet.get(subsystemId);
      if (!published || published.size === 0) return false;
      return from.dependsOn.some(d => published.has(d));
    };

    const edgeJustified = (from: ComponentSpec[], to: ComponentSpec[]): boolean => {
      for (const cf of from) {
        for (const cg of to) {
          if (cf.id === cg.id) return true;
          if (dependsOrOwns(cf, cg.id)) return true;
          // mutual wiring collapsed to one file direction: a portal declares
          // it mounts ONTO the server (portal → supervisor), while the server
          // file physically imports the portal's file to dispatch inward —
          // the declared relation exists, code chose the other direction.
          // ONLY the mounting shape (the reverse-declarer is an inbound
          // Portal/Observer) is forgiven; a Store importing the orchestrator
          // that depends on it stays a violation.
          if (
            cf.subsystem === cg.subsystem
            && dependsOrOwns(cg, cf.id)
            && (cg.componentType === 'Portal' || cg.componentType === 'Observer')
          ) return true;
          // facade hops, both directions: the target is a member of a pattern
          // the importer depends on/is; OR the importer is itself an owned
          // member whose FACADE declares the collaborator (a Repository's
          // Store does the physical I/O the Repository declared) — and two
          // members of the same pattern collaborate by construction.
          const ownerG = ownerOf.get(cg.id);
          if (ownerG && (dependsOrOwns(cf, ownerG.id) || cf.id === ownerG.id)) return true;
          const ownerF = ownerOf.get(cf.id);
          if (ownerF && (dependsOrOwns(ownerF, cg.id) || ownerF.id === cg.id)) return true;
          if (ownerF && ownerG && ownerF.id === ownerG.id) return true;
          // cross-subsystem: declared edge to the target subsystem's surface
          if (cf.subsystem !== cg.subsystem && declaresSurfaceEdge(cf, cg.subsystem)) return true;
        }
      }
      return false;
    };

    // ---- UNDECLARED_DEPENDENCY: every import edge needs a justification ----
    // Runtime imports are collaboration (checked); export-from re-exports are
    // surface republication (never accused, but they DO realize a declared
    // forwarding edge — a portal barrel republishing its orchestrator).
    const draftAt = (path: string): boolean =>
      realization.implementationsAt(path).some(impl => ctx.isImplementationDraft(impl));
    for (const fromPath of mappedPaths) {
      const fromComponents = realization.componentsAt(fromPath);
      for (const toPath of graph.importsOf(fromPath)) {
        const toComponents = realization.componentsAt(toPath);
        if (edgeJustified(fromComponents, toComponents)) continue;
        ctx.addIssue(
          'warning',
          'UNDECLARED_DEPENDENCY',
          `"${fromPath}" (realizing ${fromComponents.map(c => c.id).join(', ')}) imports "${toPath}" (realizing ${toComponents.map(c => c.id).join(', ')}) but no declared dependsOn/owns edge justifies it — declare the collaboration on the component that actually uses it, or route the cross-subsystem hop through the target's published surface.`,
          realization.implementationsAt(fromPath)[0]?.id,
          draftAt(fromPath) || draftAt(toPath),
          undefined,
          // One import edge, one indivisible fact — but one implementation
          // maps many files and many edges, so the EDGE is the site, not the
          // spec. Without it a single allow on the spec covers every crossing
          // that file ever grows.
          { at: `${fromPath} -> ${toPath}` },
        );
      }
    }

    // ---- UNREALIZED_DEPENDENCY: every declared edge should leave a trace ----
    // A trace is a runtime import, a re-export (barrel forwarding), or — for a
    // mounting declarer (Portal/Observer) — the REVERSE import (the server
    // file imports the portal's file; mutual wiring, one file direction).
    // The files a file's TYPE-ONLY imports land in, among the mapped ones —
    // resolved against the same closed set the graph is, so a type import
    // can realize an edge exactly where a runtime import could.
    const typeTraces = new Map<string, Set<string>>();
    const typeTracesOf = (path: string): Set<string> => {
      let out = typeTraces.get(path);
      if (out) return out;
      out = new Set<string>();
      const facts = code.factsAt(path);
      for (const specifier of new Set(Object.values(facts?.typeOnlyBindings ?? {}))) {
        const to = resolveImport(path, specifier, mappedPaths, code.packages);
        if (to && to !== path) out.add(to);
      }
      typeTraces.set(path, out);
      return out;
    };
    const typeConnects = (from: string[], to: string[]): boolean =>
      from.some(f => { const traces = typeTracesOf(f); return to.some(t => traces.has(t)); });
    // The files a file's code CALLS into, as the type checker resolves each
    // call and reference — through a barrel, an `export *`, a port declared
    // in a shared module, a dependency bag typed inline — and through every
    // unowned helper it reaches. Where the checker read the file this is the
    // judge, and the import graph above only accepts what it can on its own.
    const callTraces = new Map<string, Set<string>>();
    const callTracesOf = (file: string): Set<string> => {
      let out = callTraces.get(file);
      if (out) return out;
      out = new Set<string>();
      const calls = code.factsAt(file)?.resolvedCalls ?? [];
      for (const { call } of reach(calls, file)) for (const t of call.targets) if (t.path !== file) out.add(t.path);
      callTraces.set(file, out);
      return out;
    };
    const callConnects = (from: string[], to: string[]): boolean =>
      from.some(f => { const traces = callTracesOf(f); return to.some(t => traces.has(t)); });

    for (const component of ctx.components) {
      const fromFiles = filesOf(component.id);
      if (fromFiles.length === 0) continue;

      const isMountingDeclarer = component.componentType === 'Portal' || component.componentType === 'Observer';
      // One edge per distinct target: a pattern may both own a member and
      // depend on it (the visibility rule sanctions it), still one declared
      // collaboration.
      const declaredTargets = [...new Set([...component.dependsOn, ...(component.owns ?? [])])];
      for (const targetId of declaredTargets) {
        const target = ctx.componentMap.get(targetId);
        if (!target) continue;
        // An Adapter's edge to a Portal reached over an out-of-process
        // transport is the LINK the design models: the Adapter's transport
        // client realizes it, never an import — and asking for one would tell
        // the author to couple two deployables' builds across the wire.
        if (
          component.componentType === 'Adapter' && target.componentType === 'Portal'
          && target.transport !== undefined && target.transport !== 'InProcess'
        ) continue;

        // Across subsystems ANY mapped file of the target subsystem proves the
        // hop EXISTS (where it lands is portal-imports' question), minus the
        // ones shared with the
        // source (those satisfy trivially). Within one subsystem the target's
        // own files are the trace targets.
        const crossSubsystem = component.subsystem !== target.subsystem;
        const toFiles = crossSubsystem
          ? realization.filesIn(target.subsystem).filter(p => isExact(p) && !fromFiles.includes(p))
          : filesOf(targetId);
        // An empty set is Level 1 territory (an unmapped target, or a target
        // subsystem whose every mapped file is shared with the source), a
        // shared file is the N:1 same-file collapse, and a trace realizes the
        // edge.
        if (toFiles.length === 0) continue;
        if (fromFiles.some(f => toFiles.includes(f))) continue;
        if (graph.connects(fromFiles, toFiles, isMountingDeclarer)) continue;
        // A type-only import realizes the edge too: DI writes nothing else.
        if (typeConnects(fromFiles, toFiles)) continue;
        // A call the type checker lands in the target's files realizes it, whatever the imports look like.
        if (callConnects(fromFiles, toFiles)) continue;

        const impls = mappedImplsOf(component.id);
        const declaredDependsOn = component.dependsOn.includes(targetId);
        const declaredOwns = (component.owns ?? []).includes(targetId);
        const relation = declaredDependsOn && declaredOwns ? 'dependsOn and owns' : declaredDependsOn ? 'dependsOn' : 'owns';
        const draft = ctx.isComponentDraft(component.id) || ctx.isComponentDraft(targetId)
          || impls.some(i => ctx.isImplementationDraft(i));
        ctx.addIssue(
          'warning',
          'UNREALIZED_DEPENDENCY',
          `Component "${component.id}" declares ${relation} "${targetId}", but no import — runtime or type-only — connects their source files (${fromFiles.join(', ')} ↛ ${crossSubsystem ? `subsystem ${target.subsystem}` : filesOf(targetId).join(', ')}) — either the collaboration is wired indirectly (DI) or the declared edge is stale.`,
          impls[0]?.id ?? component.id,
          draft,
          undefined,
          // One declared edge, one indivisible fact. A component declares many,
          // and they all anchor on its one implementation spec, so the EDGE is
          // the site.
          { at: `${component.id} -> ${targetId}` },
        );
      }
    }

    // ---- calls through a collaborator: collaboration whatever the import ----
    // A type-only import never accuses by itself: type coupling is allowed. A
    // CALL of a modelled contract method through a collaborator the file
    // types with another component's declaration is runtime collaboration all
    // the same — dependency injection writes `import type` and then calls —
    // so the edge it crosses is owed the same justification a runtime import
    // is. And a Portal calling a write- or lifecycle-effect method of a data
    // component that way is the persistence shortcut PORTAL_WRITE_SHORTCUT
    // refuses in the design, written in code instead.
    const DATA_COMPONENTS = new Set(['Repository', 'Index', 'Store', 'Registry']);
    /** The contract method a call's name is, per component at a file: its name, or a per-method symbol. */
    const calledMethodOf = (componentId: string, name: string): { name: string; effect?: string } | undefined => {
      const methods = ctx.interfaceMethodsOf(componentId);
      const direct = methods.find(m => m.name === name);
      if (direct) return { name: direct.name, effect: direct.effect };
      for (const impl of realization.implementationsOf(componentId)) {
        const bound = impl.methods.find(m => m.symbol === name);
        if (bound) {
          const contract = methods.find(m => m.name === bound.name);
          return { name: bound.name, effect: contract?.effect };
        }
      }
      return undefined;
    };
    /** Whether a Portal's implementations already claim a call (the design rule then reports it). */
    const claims = (portalId: string, target: string, method: string): boolean =>
      realization.implementationsOf(portalId).some(impl => impl.methods.some(m =>
        m.narrative.some(step => step.targetComponent === target && step.targetMethod === method)
        || (m.calls ?? []).includes(`${target}.${method}`)));
    /**
     * The files a member call's receiver is TYPED from: the type a `this.<field>`
     * receiver's field, or a plain `<name>` receiver, is declared with, each
     * resolved through the import that binds that type name — type-only or
     * runtime — against the mapped files. A receiver the file types with
     * nothing, or a namespace import (its calls are the proven tier's), answers
     * nothing: only a type the code writes down says what a collaborator is.
     */
    const typedLandings = (site: CallSiteFact, file: string): Array<{ toPath: string; typeOnly: boolean }> => {
      const scope = pathKey(site.from ?? file);
      const facts = code.factsAt(scope);
      if (!facts || !site.member) return [];
      let typeNames: string[] = [];
      if (site.field) typeNames = fieldTypesOf(facts, site.field);
      else if (site.via && !importBindingOf(facts, site.via)) typeNames = localTypesOf(facts, site.via);
      const out: Array<{ toPath: string; typeOnly: boolean }> = [];
      for (const typeName of typeNames) {
        const typeOnly = facts.typeOnlyBindings?.[typeName];
        const runtime = typeOnly === undefined ? importBindingOf(facts, typeName) : undefined;
        const specifier = typeOnly ?? (runtime && !runtime.namespace ? runtime.from : undefined);
        if (!specifier) continue;
        const toPath = resolveImport(scope, specifier, mappedPaths, code.packages);
        if (toPath && toPath !== scope) out.push({ toPath, typeOnly: typeOnly !== undefined });
        // An interface declared in a shared contracts file, apart from the
        // class that realizes it: the call can land in every implementor.
        // Resolved by path whether or not the run analyzed it: a shared
        // contracts file is one no spec need name.
        const declaredAt = resolveImport(scope, specifier, code.paths, code.packages)
          ?? (specifier.startsWith('.') ? posix.join(posix.dirname(scope), specifier) : undefined);
        const published = importBindingOf(facts, typeName)?.imported ?? typeName;
        if (declaredAt) {
          for (const implementor of code.implementorsOf(declaredAt, published)) {
            if (mappedPaths.has(implementor) && implementor !== scope) out.push({ toPath: implementor, typeOnly: typeOnly !== undefined });
          }
        }
      }
      return out;
    };
    /**
     * Whether a member call's receiver is one nothing in the file says
     * anything about — no field type, no annotation, no import binding, none
     * of the receiver shapes the analysis follows — so neither a landing nor
     * its absence means anything.
     */
    const unfollowable = (site: CallSiteFact, file: string): boolean => {
      const facts = code.factsAt(pathKey(site.from ?? file));
      if (!facts || facts.status !== 'analyzed' || facts.analysisGrade !== 'exact') return false;
      if (site.field) return fieldTypesOf(facts, site.field).length === 0;
      if (site.via) return !importBindingOf(facts, site.via) && localTypesOf(facts, site.via).length === 0;
      return !site.constructed && !site.returnedBy && !site.enclosingClass && !site.receiverPath;
    };
    /** Every write- or lifecycle-effect contract method of a data component, by the name code calls it under. */
    const dataWrites = new Map<string, Array<{ component: string; method: string }>>();
    for (const c of ctx.components) {
      if (!DATA_COMPONENTS.has(c.componentType)) continue;
      for (const m of ctx.interfaceMethodsOf(c.id)) {
        if (m.effect !== 'write' && m.effect !== 'lifecycle') continue;
        const names = new Set([m.name]);
        for (const impl of realization.implementationsOf(c.id)) {
          const bound = impl.methods.find(x => x.name === m.name)?.symbol;
          if (bound) names.add(bound);
        }
        for (const name of names) {
          const list = dataWrites.get(name) ?? [];
          list.push({ component: c.id, method: m.name });
          dataWrites.set(name, list);
        }
      }
    }
    /** The contract methods a call reaches at a file: each component realized there whose contract names it. */
    // A landing the type checker resolved to a MODULE function (no container)
    // is never a method a component reaches through an exportedVia handle —
    // that one is a member of the object — so in a shared file the two
    // same-named methods are told apart.
    const calledAt = (toPath: string, name: string, moduleFunction = false): Array<{ component: ComponentSpec; method: { name: string; effect?: string } }> =>
      realization.componentsAt(toPath)
        .map(c => ({ component: c, method: calledMethodOf(c.id, name) }))
        .filter((c): c is { component: ComponentSpec; method: { name: string; effect?: string } } => {
          if (c.method === undefined) return false;
          if (!moduleFunction) return true;
          const via = realization.implementationsOf(c.component.id)
            .map(impl => impl.methods.find(m => m.name === c.method!.name)?.exportedVia)
            .find(v => v !== undefined);
          return via === undefined;
        });

    /** One call of a Portal's own code, read off the type checker's answer or, without one, the shape facts. */
    interface PortalCall {
      impl: ImplementationSpec;
      /** How a finding names where the call sits: the Portal method, or the function it is written in. */
      where: string;
      name: string;
      written: string;
      /** Each place the call lands, with the container the checker named (null where the shape facts read it, which name none). */
      landings: Array<{ toPath: string; member: string; container: string | null | undefined }>;
      unresolved: boolean;
      /** True when the landings are the type checker's — what lets a call accuse an edge no import connects. */
      resolved: boolean;
      /** The type checker's fact behind a resolved call: what a fail-closed finding reads the receiver's original type from. */
      call?: ResolvedCallFact;
    }
    const portalCalls = (
      impls: ImplementationSpec[],
      fromPath: string,
      fromComponents: ComponentSpec[],
    ): PortalCall[] => {
      const facts = code.factsAt(fromPath);
      const own = impls.flatMap(impl => impl.methods
        .filter(method => pathKey(methodSourceFile(method, impl.sourcePath) ?? '') === fromPath)
        .map(method => ({ impl, method })));
      const anchorImpl = own[0]?.impl ?? impls.find(impl => implementationSourceFiles(impl).some(f => pathKey(f) === fromPath));
      if (!facts || !anchorImpl) return [];
      const out: PortalCall[] = [];
      if (facts.resolvedCalls) {
        // A file realizing only Portals is the Portal's code throughout; a
        // file it shares with other components is the Portal's only in the
        // bodies its own methods reach — their symbols and the helpers the
        // shape walk follows from them.
        const onlyPortals = fromComponents.every(c => c.componentType === 'Portal');
        // The bodies other components' modelled methods are anchored to here.
        // A Portal method realized by the SAME body as one of them (N:1
        // identity) is that component's code, and so is everything such a
        // body goes on to call: it answers to its own narrative.
        const othersAnchors = new Set<string>();
        for (const other of fromComponents) {
          if (other.componentType === 'Portal') continue;
          for (const impl of realization.implementationsOf(other.id)) {
            for (const method of impl.methods) {
              if (pathKey(methodSourceFile(method, impl.sourcePath) ?? '') === fromPath) othersAnchors.add(method.symbol ?? method.name);
            }
          }
        }
        const bodies = new Map<string, string>();
        for (const { method } of own) {
          const symbol = method.symbol ?? method.name;
          if (!onlyPortals && othersAnchors.has(symbol)) continue;
          bodies.set(symbol, method.name);
          const stopAt = (site: CallSiteFact): boolean => othersAnchors.has(site.name);
          for (const site of closedCallSites(code, fromPath, symbol, stopAt, method.exportedVia) ?? []) {
            if (pathKey(site.from ?? fromPath) !== fromPath || (site.member && !site.enclosingClass)) continue;
            if (othersAnchors.has(site.name)) continue;
            if (!bodies.has(site.name)) bodies.set(site.name, method.name);
          }
        }
        const mine = facts.resolvedCalls.filter(rc => onlyPortals || (rc.enclosing !== undefined && bodies.has(rc.enclosing)));
        // Each call is read where it was written AND, through every unowned
        // function it reaches, as the calls that function's body makes — a
        // persistence helper in a module no spec names is the Portal's code.
        for (const site of mine) {
          const contractMethod = site.enclosing !== undefined ? bodies.get(site.enclosing) : undefined;
          for (const { call: rc, through } of reach([site], fromPath)) {
            out.push({
              impl: own.find(o => o.method.name === contractMethod)?.impl ?? anchorImpl,
              where: contractMethod !== undefined ? `its method "${contractMethod}"`
                : site.enclosing !== undefined ? `its code (function "${site.enclosing}")` : 'its module-scope code',
              name: rc.name,
              written: quoteCall(rc, site, through),
              landings: rc.targets.map(t => ({ toPath: t.path, member: t.member, container: t.container })),
              unresolved: rc.unresolved === true,
              resolved: true,
              call: rc,
            });
          }
        }
        return out;
      }
      // No type checker read this file: the Portal's realized methods, closed
      // over their helpers, through a typed collaborator or a proven binding.
      for (const { impl, method } of own) {
        const sites = closedCallSites(code, fromPath, method.symbol ?? method.name, undefined, method.exportedVia) ?? [];
        for (const site of sites) {
          // Only a call written in the Portal's own file: a body it forwards
          // to by identity is the other component's to answer for.
          if (!site.member || pathKey(site.from ?? fromPath) !== fromPath) continue;
          const landings = new Set([...typedLandings(site, fromPath).map(l => l.toPath), ...code.originOf(site, fromPath)]);
          out.push({
            impl,
            where: `its method "${method.name}"`,
            name: site.name,
            written: `\`${site.via ?? (site.field ? `this.${site.field}` : '<receiver>')}.${site.name}(…)\``,
            landings: [...landings].map(toPath => ({ toPath, member: site.name, container: null })),
            unresolved: landings.size === 0 && unfollowable(site, fromPath),
            resolved: false,
          });
        }
      }
      return out;
    };

    const reportedEdges = new Set<string>();
    const reportedWrites = new Set<string>();
    const reportedUnresolved = new Set<string>();
    for (const fromPath of mappedPaths) {
      const facts = code.factsAt(fromPath);
      const fromComponents = realization.componentsAt(fromPath);
      if (!facts || fromComponents.length === 0) continue;

      // The persistence shortcut, written in code: what each Portal's OWN
      // code calls on a data component. Where the type checker read the file,
      // each call lands where the checker resolved it, whatever its spelling;
      // otherwise the shape facts' typed collaborator or proven binding.
      const runtimeHere = graph.importsOf(fromPath);
      for (const portal of fromComponents.filter(c => c.componentType === 'Portal')) {
        const impls = realization.implementationsOf(portal.id);
        for (const call of portalCalls(impls, fromPath, fromComponents)) {
          const impl = call.impl;
          // A call the analysis cannot follow at all, under the name of a data
          // component's write: it fails closed, never passes in silence.
          if (call.unresolved) {
            // Only a data component the Portal could plausibly be handed:
            // one in its own subsystem, or in a subsystem it depends into.
            // Where the type checker recorded the receiver's original type,
            // the data components it lands on — every write of theirs when a
            // computed key names no member.
            const near = new Set([portal.subsystem, ...portal.dependsOn.map(d => ctx.componentMap.get(d)?.subsystem)]);
            const candidates = (call.call
              ? candidatesOf(call.call, portal, callee => DATA_COMPONENTS.has(callee.componentType))
              : (dataWrites.get(call.name) ?? []).filter(w => near.has(ctx.componentMap.get(w.component)?.subsystem)))
              .filter(w => !claims(portal.id, w.component, w.method));
            const at = `${fromPath} -> ${call.name || candidates.map(w => `${w.component}.${w.method}`).join(', ')}`;
            if (candidates.length > 0 && !reportedUnresolved.has(at)) {
              reportedUnresolved.add(at);
              ctx.addIssue(
                'warning',
                'PORTAL_CALL_UNRESOLVED',
                `Portal "${portal.id}": ${call.where} in "${fromPath}" calls ${call.written} through a receiver this analysis cannot follow (its type is any or unknown, it is cast to either or to an index signature, a computed key picks the member, or nothing declares it), and ${candidates.map(w => `${w.component}.${w.method}`).join(', ')} — a data component's write — ${call.name ? 'carries that name' : 'is what its receiver was before the cast'}. Neither proven a persistence shortcut nor cleared, so it fails closed: give the receiver its declared type (a field or parameter annotation, no cast to any, unknown or an index signature, a member named in the code) so the call can be judged.`,
                impl.id,
                draftAt(fromPath),
                undefined,
                { at },
              );
            }
          }
          for (const { toPath, member, container } of call.landings) {
            if (toPath === fromPath) continue;
            const called = calledAt(toPath, member, container === undefined);
            for (const { component: target, method } of called) {
              if (!DATA_COMPONENTS.has(target.componentType)) continue;
              if (method.effect !== 'write' && method.effect !== 'lifecycle') continue;
              if (claims(portal.id, target.id, method.name)) continue;
              const at = `${fromPath} -> ${target.id}.${method.name}`;
              if (reportedWrites.has(at)) continue;
              reportedWrites.add(at);
              ctx.addIssue(
                'error',
                'PORTAL_WRITE_SHORTCUT_IN_CODE',
                `Portal "${portal.id}": ${call.where} in "${fromPath}" calls ${method.effect}-effect method ${target.id}.${method.name} directly (${call.written}), which its design never narrates — the code twin of PORTAL_WRITE_SHORTCUT. A Portal may reach a data component for READS only: route the ${method.effect === 'write' ? 'write' : 'lifecycle change'} through an Orchestrator that owns the workflow.`,
                impl.id,
                draftAt(fromPath) || draftAt(toPath),
                undefined,
                { at },
              );
            }
            // The edge the call crosses, owed the justification a runtime
            // import is — whatever connects the files: a type-only import, or
            // nothing at all (a port the Portal declares for itself).
            // Only a landing on a data component is accused this way: the
            // checker resolves a call through every re-export to the module
            // that declares it, past the forwarding module a file imports on
            // purpose, so for anything else the import graph stays the judge.
            if (!call.resolved || runtimeHere.has(toPath)) continue;
            if (!called.some(c => DATA_COMPONENTS.has(c.component.componentType))) continue;
            const toComponents = realization.componentsAt(toPath);
            if (edgeJustified(fromComponents, toComponents)) continue;
            const edge = `${fromPath} -> ${toPath}`;
            if (reportedEdges.has(edge)) continue;
            reportedEdges.add(edge);
            ctx.addIssue(
              'warning',
              'UNDECLARED_DEPENDENCY',
              `"${fromPath}" (realizing ${fromComponents.map(c => c.id).join(', ')}) calls ${called.map(c => `${c.component.id}.${c.method.name}`).join(', ')} (${call.written}, as the type checker resolves it) in "${toPath}" (realizing ${toComponents.map(c => c.id).join(', ')}), but no declared dependsOn/owns edge justifies it — a call is runtime collaboration whatever the import's form. Declare the collaboration on the component that uses it, or route the cross-subsystem hop through the target's published surface.`,
              realization.implementationsAt(fromPath)[0]?.id,
              draftAt(fromPath) || draftAt(toPath),
              undefined,
              { at: edge },
            );
          }
        }
      }

      // The undeclared edge a type-only import hid: a call through a
      // collaborator typed by a type-only import of another component's file.
      // A runtime import of that file was judged above.
      const runtime = graph.importsOf(fromPath);
      for (const sites of Object.values(facts.functionCallSites ?? {})) {
        for (const site of sites) {
          for (const { toPath, typeOnly } of typedLandings(site, fromPath)) {
            if (!typeOnly || runtime.has(toPath)) continue;
            const called = calledAt(toPath, site.name);
            if (called.length === 0) continue;
            const toComponents = realization.componentsAt(toPath);
            if (edgeJustified(fromComponents, toComponents)) continue;
            const edge = `${fromPath} -> ${toPath}`;
            if (reportedEdges.has(edge)) continue;
            reportedEdges.add(edge);
            ctx.addIssue(
              'warning',
              'UNDECLARED_DEPENDENCY',
              `"${fromPath}" (realizing ${fromComponents.map(c => c.id).join(', ')}) calls ${called.map(c => `${c.component.id}.${c.method.name}`).join(', ')} through a collaborator typed by a type-only import of "${toPath}" (realizing ${toComponents.map(c => c.id).join(', ')}), but no declared dependsOn/owns edge justifies it — a call through an injected collaborator is runtime collaboration whatever the import's form. Declare the collaboration on the component that uses it, or route the cross-subsystem hop through the target's published surface.`,
              realization.implementationsAt(fromPath)[0]?.id,
              draftAt(fromPath) || draftAt(toPath),
              undefined,
              { at: edge },
            );
          }
        }
      }
    }

    // ---- a technology's package imported outside its home ----------------
    // The design rule TECH_LEAKAGE reads the spec tree; this reads the code's
    // imports. A technology's package names are its declared tokens — its
    // name, or its `matches` — compared to a bare specifier's package name
    // exactly: what the design wrote down, never a guessed vendor list.
    const homes = new Map<string, { label: string; home: Set<string> }>();
    for (const impl of ctx.implementations) {
      const technologies = impl.technologies ?? [];
      if (technologies.length === 0) continue;
      const contract = ctx.interfaceMap.get(impl.contract);
      const owner = contract ? ctx.componentMap.get(contract.component) : undefined;
      if (!owner) continue;
      const members = new Set<string>([owner.id, ...(owner.owns ?? [])]);
      const facade = ownerOf.get(owner.id);
      if (facade) members.add(facade.id);
      for (const technology of technologies) {
        for (const token of technologyPackages(technology, ctx.ext.technologyPackages)) {
          const key = token.toLowerCase();
          const entry = homes.get(key) ?? { label: technologyName(technology), home: new Set<string>() };
          for (const id of members) entry.home.add(id);
          homes.set(key, entry);
        }
      }
    }
    // A technology the code imports that NO implementation binds has no home
    // at all: the design never says where it lives, so every importer is
    // outside it. Only a package the curated table or a loaded pack names is
    // read this way — an arbitrary package is no technology.
    const unbound = (label: string, packages: readonly string[]): void => {
      const keys = packages.map(p => p.toLowerCase());
      if (keys.some(k => homes.has(k))) return;
      for (const key of keys) homes.set(key, { label, home: new Set<string>() });
    };
    for (const entry of TECHNOLOGY_PACKAGES) unbound(entry.names[0], entry.packages);
    for (const [name, packages] of Object.entries(ctx.ext.technologyPackages ?? {})) unbound(name, packages);
    if (homes.size > 0) {
      for (const file of mappedPaths) {
        const facts = code.factsAt(file);
        if (!facts) continue;
        const atFile = realization.componentsAt(file);
        const specifiers = new Set([...facts.imports, ...Object.values(facts.typeOnlyBindings ?? {})]);
        const reported = new Set<string>();
        for (const specifier of specifiers) {
          if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue;
          // A package of this repository is local code, never a vendor.
          if (resolveImport(file, specifier, code.paths, code.packages)) continue;
          const parts = specifier.split('/');
          const pkg = (specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]).toLowerCase();
          const tech = homes.get(pkg);
          if (!tech || reported.has(pkg) || atFile.some(c => tech.home.has(c.id))) continue;
          reported.add(pkg);
          ctx.addIssue(
            'warning',
            'TECH_LEAKAGE_IN_CODE',
            tech.home.size === 0
              ? `"${file}" (realizing ${atFile.map(c => c.id).join(', ')}) imports "${specifier}", the package of technology "${tech.label}", which no implementation binds — the design never says where that technology lives (the code twin of TECH_LEAKAGE). Bind it (technologies: [${tech.label}]) on the data-layer component that owns the vendor call, which then is its home.`
              : `"${file}" (realizing ${atFile.map(c => c.id).join(', ')}) imports "${specifier}", the package of technology "${tech.label}", whose home is ${[...tech.home].join(', ')} — the code twin of TECH_LEAKAGE. Move the vendor call behind the component that binds it, or bind the technology where it is really used.`,
            realization.implementationsAt(file)[0]?.id,
            draftAt(file),
            undefined,
            { at: `${file} -> ${pkg}` },
          );
        }
      }
    }
  },
};
