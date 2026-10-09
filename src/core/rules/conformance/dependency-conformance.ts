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

/** How deep a chain of unowned modules is followed for the technology packages they import — the same bound unowned calls are read to. */
const UNOWNED_IMPORT_DEPTH = 8;

export const dependencyConformanceRule: SddRule = {
  name: 'dependency-conformance',
  judges: 'code',
  description:
    'Code↔spec Level 2: runtime import edges between component-mapped source files (a component maps to every file its implementations and their methods name) must be justified by declared relations — a direct dependsOn/owns pair, a shared component, membership in a depended-on pattern, or (across subsystems) a declared edge to the target subsystem\'s published surface (UNDECLARED_DEPENDENCY). A type-only import alone never accuses — type coupling is allowed — but a CALL of a modelled contract method through a collaborator whose declared type comes from another component\'s file is runtime collaboration whatever the import\'s form, and the same justification is owed (UNDECLARED_DEPENDENCY on that edge). Conversely, a declared dependsOn/owns edge between components realized in different files should be visible as an import between any file of the source and any file of the target, or — where the type checker read a file of the source — as a call or reference the checker lands in a file of the target, through every barrel, port declaration, dependency bag and unowned helper (UNREALIZED_DEPENDENCY — DI indirection can defeat the import reading, hence warning); a type-only import realizes it, since `import type` is what dependency injection writes down. An Adapter\'s edge to a Portal reached over an out-of-process transport (HTTP, gRPC, a bus, a CLI…) is the link the design models: the Adapter\'s transport client realizes it, never an import, so it is never UNREALIZED_DEPENDENCY — and nothing asks for an import across that boundary, which would couple two deployables\' builds. Two twins of design rules are judged on the same code: a Portal file calling a write- or lifecycle-effect contract method of a Repository, Index, Store or Registry is the persistence shortcut the design rule PORTAL_WRITE_SHORTCUT refuses, unless the Portal\'s own narrative already claims that call (the design rule\'s finding then) (PORTAL_WRITE_SHORTCUT_IN_CODE). A Portal\'s calls are resolved by the TypeScript type checker: every call written in a file realizing only Portals — in a file shared with other components, every call in a body the Portal\'s own methods reach — and every reference there to a function or method the code takes as a value (passed as an argument, assigned, returned, bound, handed to Reflect.apply), together with every call the UNOWNED code they reach makes (a function in a file no component realizes, or one that is none of its file\'s components\' modelled methods, read as if inlined at the call site, transitively to a bounded depth, the finding naming the hops), lands on the declaration its signature resolves to, whatever the receiver\'s spelling, and a declaration in an interface or type shape, a port the Portal declares for itself included, lands on each class of the project that realizes it (the classes whose implements clause names it when any does, else every class the checker finds assignable to it); such a landing on a component the file neither imports at runtime nor is justified to reach is UNDECLARED_DEPENDENCY on that edge. Where no type checker could be loaded, the receiver is followed through the shape facts instead: a non-null assertion, parentheses, `satisfies`, a cast to a named type and a local alias or destructuring of a field exactly as through the field itself. A call in a Portal\'s own code the analysis cannot resolve at all — its receiver typed any or unknown however it came to be (a cast, an untyped or any-typed parameter of a closure, a local typed any, a function result typed any), cast to either or to an index signature, its member picked by a computed key, or typed nothing — under the name of a write- or lifecycle-effect method of a data component, or reading a member by a key that names no single member off a receiver that was a data component before any cast — invoked on the spot or taken as a value, however the receiver or the key is cast (where the checker recorded the receiver\'s ORIGINAL type, before any cast — an `await (x)` written outside an async function read as the x it means, nullability set aside, a name bound once by a const read through its initializer, an interface no class realizes landing on the file declaring it — a write of the data component that type lands on — any of its writes when a computed key names none; else one in the Portal\'s own subsystem or one it depends into — the design\'s write set, which a data component whose code is still planned has too, and what a receiver landing only on the Portal\'s own file, a port it declares for itself, is judged by), which the Portal does not already claim, fails closed — one finding per site and per function it is written in, so one shortcut never hides another of the same name: it is neither proven a shortcut nor cleared, and it is a warning, so a CI gate never passes what it could not read (PORTAL_CALL_UNRESOLVED). So does a call landing only on a PORT no written class realizes — a member of an interface or shape declared where no component\'s contract answers for it — under the name of such a write the Portal claims nowhere and no narrative of the Portal names on any component: the design says what that port will be before the code realizing it is written, and the finding says when the data component has no code yet. And an import, runtime or type-only, from ANOTHER project\'s source — a folder holding its own .wai/project.yaml that is not this project\'s root — that the type checker resolves to nothing, the module gone or the name no longer exported, is CROSS_PROJECT_IMPORT_UNRESOLVED: another project\'s code moves on its own release, and a type-only import of it is erased at run time, so only a compiler would notice. One that DOES resolve is judged like any other edge, because it is one: a name it imports that the other project does not publish — not in its L0 export table as a member exports it now, nor in the pinned snapshot of the external it is (an exported type by its id or code name, an exported component by its contract methods and their code symbols; a project that is neither publishes nothing to this one) — is code reaching into that project\'s internals past its surface, which no pin and no binding compares (CROSS_PROJECT_SOURCE_IMPORT, a warning; the finding says when the module it lands in realizes a data component of that project, since a write through it is the persistence shortcut past the other project\'s surface). A binding module an implementation declares is the sanctioned place for exactly that reach, compared by binding conformance, so an import written in one is never reported here. And a file importing a technology\'s package — itself, or through the UNOWNED modules it imports (a module no component realizes, read as if inlined in its importer, transitively to a bounded depth, the finding naming the hops; a module a component realizes is judged as its own) — while no component it realizes is that technology\'s home is the leak TECH_LEAKAGE refuses in the design (TECH_LEAKAGE_IN_CODE): a technology\'s packages are its declared tokens (its name, or its `matches`), the curated built-in table of the common packages its name is known by (postgres: pg, postgres, @neondatabase/serverless, @vercel/postgres; mysql: mysql2, mysql; redis: redis, ioredis; mongodb: mongodb, mongoose; sqlite: better-sqlite3, sqlite3; kafka: kafkajs; rabbitmq: amqplib — an HTTP client is never a technology leak), and the packages a loaded pack contributes for it, each compared exactly with an import\'s package name. A package of the built-in table or of a loaded pack whose technology NO implementation binds is reported too, since the design never says where that technology lives: bind it on the data-layer component that owns the vendor call. Only exact-grade analyzed files participate; chained subprojects validate standalone.',
  codes: [
    { code: 'UNDECLARED_DEPENDENCY', defaultSeverity: 'warning', summary: 'A runtime import, a call through a type-only-imported collaborator, or a Portal\'s call the type checker resolves into another component\'s file, between component-mapped files has no declared dependsOn/owns (or published-surface) justification' },
    { code: 'PORTAL_WRITE_SHORTCUT_IN_CODE', defaultSeverity: 'error', summary: 'A Portal\'s code calls, or takes as a value, a write- or lifecycle-effect method of a data component (Repository, Index, Store, Registry) — directly or through unowned code it calls — the code twin of PORTAL_WRITE_SHORTCUT: mutations route through an Orchestrator' },
    { code: 'TECH_LEAKAGE_IN_CODE', defaultSeverity: 'warning', summary: 'A source file imports a technology\'s package although no component it realizes binds that technology — the code twin of TECH_LEAKAGE' },
    { code: 'UNREALIZED_DEPENDENCY', defaultSeverity: 'warning', summary: 'A declared dependsOn/owns edge between components in different files is realized by no import between any of their files, nor by any call the type checker lands across it' },
    { code: 'PORTAL_CALL_UNRESOLVED', defaultSeverity: 'warning', summary: 'A call in a Portal\'s own code, under the name of a data component\'s write- or lifecycle-effect method — or with its member picked by a computed key on a receiver that was a data component before a cast — goes through a receiver the analysis cannot resolve (typed any or unknown, cast to either or to an index signature, or typed nothing), or lands only on a port no written class realizes — neither proven a shortcut nor cleared, so it fails closed until the receiver carries its type' },
    { code: 'CROSS_PROJECT_SOURCE_IMPORT', defaultSeverity: 'warning', summary: 'A source file imports a name from ANOTHER project\'s source that the project does not export — code reaching into its internals past its surface, which no pin and no binding compares (a write into its Store through it included); a declared binding module is the sanctioned place for that reach', carryable: true },
    { code: 'CROSS_PROJECT_IMPORT_UNRESOLVED', defaultSeverity: 'warning', summary: 'A source file imports from ANOTHER project\'s source — a folder holding its own .wai/project.yaml — a module that is gone or a name it no longer exports: a type-only import is erased at run time, so only a compiler would notice, and the gate reads the file with one', carryable: true },
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
    /** Every method name a Portal's implementations claim a call to, on any component: what a port call may be realizing. */
    const claimedMethodNames = (portalId: string): Set<string> => {
      const names = new Set<string>();
      for (const impl of realization.implementationsOf(portalId)) {
        for (const m of impl.methods) {
          for (const step of m.narrative) if (step.targetMethod) names.add(step.targetMethod);
          for (const ref of m.calls ?? []) names.add(ref.slice(ref.lastIndexOf('.') + 1));
        }
      }
      return names;
    };
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
            // One finding per site AND per body it is written in: the same
            // name reached two ways in two functions is two shortcuts, and the
            // first must never be what hides the second.
            if (candidates.length > 0 && !reportedUnresolved.has(`${at}|${call.where}`)) {
              reportedUnresolved.add(`${at}|${call.where}`);
              ctx.addIssue(
                'warning',
                'PORTAL_CALL_UNRESOLVED',
                `Portal "${portal.id}": ${call.where} in "${fromPath}" calls ${call.written} through a receiver this analysis cannot follow (its type is any or unknown, it is cast to either or to an index signature, a computed key picks the member, or nothing declares it), and ${candidates.map(w => `${w.component}.${w.method}`).join(', ')} — a data component's write — ${call.name ? `carries that name${call.call?.receivers?.length ? ', on what its receiver was before the cast' : ''}` : 'is what its receiver was before the cast'}. Neither proven a persistence shortcut nor cleared, so it fails closed: give the receiver its declared type (a field or parameter annotation, no cast to any, unknown or an index signature, a member named in the code) so the call can be judged.`,
                impl.id,
                draftAt(fromPath),
                undefined,
                { at },
              );
            }
          }
          // A call landing only on a PORT no written class realizes — declared
          // where no component's contract answers for it — under the name of a
          // data component's write the Portal claims nowhere: the design names
          // what that port will be, even before the code that realizes it is
          // written, and it is not a workflow the Portal narrates. Judged by
          // the design, it fails closed exactly as an unfollowable receiver.
          else if (call.call?.port && !call.landings.some(l => l.toPath !== fromPath && calledAt(l.toPath, l.member, l.container === undefined).length > 0)) {
            const near = new Set([portal.subsystem, ...portal.dependsOn.map(d => ctx.componentMap.get(d)?.subsystem)]);
            const claimedNames = claimedMethodNames(portal.id);
            const candidates = claimedNames.has(call.name) ? [] : (dataWrites.get(call.name) ?? [])
              .filter(w => near.has(ctx.componentMap.get(w.component)?.subsystem))
              .filter(w => !claims(portal.id, w.component, w.method));
            const at = `${fromPath} -> ${call.name}`;
            if (candidates.length > 0 && !reportedUnresolved.has(at)) {
              reportedUnresolved.add(at);
              const planned = candidates.filter(w => !code.holdsAny(realization.implementationsOf(w.component).flatMap(i => implementationSourceFiles(i))));
              const port = call.landings.map(l => `${l.container ? `${l.container}.` : ''}${l.member}`).join(', ');
              ctx.addIssue(
                'warning',
                'PORTAL_CALL_UNRESOLVED',
                `Portal "${portal.id}": ${call.where} in "${fromPath}" calls ${call.written} through a port no written class realizes (${port}), and ${candidates.map(w => `${w.component}.${w.method}`).join(', ')} — a data component's write that no narrative of the Portal claims — carries that name${planned.length ? `; ${planned.map(w => w.component).join(', ')} has no code yet, so nothing will realize the port but the data component the design names` : ''}. Neither proven a persistence shortcut nor cleared, so it fails closed: route the write through an Orchestrator the Portal narrates, or type the port by the component that realizes it so the call can be judged.`,
                call.impl.id,
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
      const reachedImports = ctx.codeModel.reachedImports ?? {};
      /**
       * The bare package specifiers the UNOWNED modules a file imports go on
       * to import — a module no component realizes is read as if inlined in
       * its importer, transitively to a bounded depth, each specifier with
       * the hops it was reached through; a module a component realizes stops
       * the walk, its imports judged as its own.
       */
      const unownedImports = (file: string): Array<{ specifier: string; through: string[] }> => {
        const out: Array<{ specifier: string; through: string[] }> = [];
        const visited = new Set<string>([file]);
        const queue: Array<{ path: string; through: string[] }> = (reachedImports[file]?.files ?? []).map(p => ({ path: p, through: [p] }));
        while (queue.length) {
          const { path: at, through } = queue.shift()!;
          if (visited.has(at)) continue;
          visited.add(at);
          if (realization.componentsAt(at).length > 0) continue;
          const imported = reachedImports[at];
          if (!imported) continue;
          for (const specifier of imported.packages) out.push({ specifier, through });
          if (through.length >= UNOWNED_IMPORT_DEPTH) continue;
          for (const next of imported.files) queue.push({ path: next, through: [...through, next] });
        }
        return out;
      };
      for (const file of mappedPaths) {
        const facts = code.factsAt(file);
        if (!facts) continue;
        const atFile = realization.componentsAt(file);
        const specifiers: Array<{ specifier: string; through: string[] }> = [
          ...[...new Set([...facts.imports, ...Object.values(facts.typeOnlyBindings ?? {})])].map(specifier => ({ specifier, through: [] as string[] })),
          ...unownedImports(file),
        ];
        const reported = new Set<string>();
        for (const { specifier, through } of specifiers) {
          if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue;
          // A package of this repository is local code, never a vendor.
          if (resolveImport(file, specifier, code.paths, code.packages)) continue;
          const parts = specifier.split('/');
          const pkg = (specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]).toLowerCase();
          const tech = homes.get(pkg);
          if (!tech || reported.has(pkg) || atFile.some(c => tech.home.has(c.id))) continue;
          reported.add(pkg);
          const via = through.length ? ` through ${through.map(p => `"${p}"`).join(' → ')} (unowned code it imports, read as its own)` : '';
          ctx.addIssue(
            'warning',
            'TECH_LEAKAGE_IN_CODE',
            tech.home.size === 0
              ? `"${file}" (realizing ${atFile.map(c => c.id).join(', ')}) imports "${specifier}"${via}, the package of technology "${tech.label}", which no implementation binds — the design never says where that technology lives (the code twin of TECH_LEAKAGE). Bind it (technologies: [${tech.label}]) on the data-layer component that owns the vendor call, which then is its home.`
              : `"${file}" (realizing ${atFile.map(c => c.id).join(', ')}) imports "${specifier}"${via}, the package of technology "${tech.label}", whose home is ${[...tech.home].join(', ')} — the code twin of TECH_LEAKAGE. Move the vendor call behind the component that binds it, or bind the technology where it is really used.`,
            realization.implementationsAt(file)[0]?.id,
            draftAt(file),
            undefined,
            { at: `${file} -> ${pkg}` },
          );
        }
      }
    }

    // ---- an import from another project's source that resolves to nothing ----
    // Another project's code moves on its own release. A type-only import of
    // it is erased at run time, so no test run notices it is gone; the gate
    // reads the file with a type checker, and an unresolvable import is the
    // one thing that checker says for free.
    for (const facts of ctx.codeModel.files) {
      for (const broken of facts.crossProjectImports ?? []) {
        if (broken.resolved) continue;
        const file = pathKey(facts.path);
        const what = broken.name !== undefined ? `"${broken.name}" from "${broken.specifier}"` : `"${broken.specifier}"`;
        ctx.addIssue(
          'warning',
          'CROSS_PROJECT_IMPORT_UNRESOLVED',
          `"${file}" imports ${what} (line ${broken.line}) from the source of another project, "${broken.project}", which ${broken.name !== undefined ? 'does not export that name' : 'has no such module'} — the import resolves to nothing.${broken.typeOnly ? ' The import is type-only, so it is erased at run time and no test notices: only a compiler would.' : ''} The other project's code moves on its own release: follow its rename (its surface diff, or the pinned contract's rename trace, names the new name), or reach it through a binding module the implementation declares, which is compared with the pin.`,
          realization.implementationsAt(file)[0]?.id,
          draftAt(file),
          undefined,
          { at: `${file} -> ${broken.specifier}${broken.name !== undefined ? `#${broken.name}` : ''}` },
        );
      }
    }

    // ---- an import that DOES land in another project's source ----
    // Judged like any other edge, because it is one: code reaching into
    // another project's internals past what that project exports, which no
    // pin and no binding compares — the commonest shortcut in a mono-repo,
    // and the one through which a write into the other project's Store is
    // invisible to every other rule. A name that project publishes (its L0
    // export table, as a member exports it now or a pin recorded it) is its
    // surface and passes; and a declared binding module is the sanctioned
    // place for exactly this reach, compared by binding conformance, so it is
    // never reported here.
    const bindingFiles = new Set(ctx.implementations.flatMap(impl => impl.bindings ?? []).map(pathKey));
    const surfaces = new Map<string, { label: string; names: Set<string>; data: Map<string, string> } | null>();
    const surfaceOf = (project: string): { label: string; names: Set<string>; data: Map<string, string> } | null => {
      if (surfaces.has(project)) return surfaces.get(project)!;
      const answer = projectSurface(ctx, project);
      surfaces.set(project, answer);
      return answer;
    };
    for (const facts of ctx.codeModel.files) {
      const file = pathKey(facts.path);
      if (bindingFiles.has(file)) continue;
      const reaches = (facts.crossProjectImports ?? []).filter(fact => fact.resolved);
      const bySpecifier = new Map<string, typeof reaches>();
      for (const reach of reaches) bySpecifier.set(reach.specifier, [...(bySpecifier.get(reach.specifier) ?? []), reach]);
      for (const [specifier, list] of bySpecifier) {
        const first = list[0];
        const surface = surfaceOf(first.project);
        const internal = list.filter(reach => !(surface && reach.name !== undefined && reach.name !== '*' && surface.names.has(nameKey(reach.name))));
        if (internal.length === 0) continue;
        const names = internal.map(reach => (reach.name === undefined ? 'the module itself' : reach.name === '*' ? 'the whole module' : `"${reach.name}"`));
        const owner = first.module !== undefined ? surface?.data.get(first.module) : undefined;
        const writes = owner !== undefined ? ` "${first.module}" realizes ${owner} of that project: a write through it is the persistence shortcut past the other project's surface, and at least as serious as an undeclared dependency.` : '';
        const label = surface?.label ?? `"${first.project}"`;
        ctx.addIssue(
          'warning',
          'CROSS_PROJECT_SOURCE_IMPORT',
          `"${file}" imports ${names.join(', ')} from "${specifier}" (line ${first.line}), the SOURCE of another project, ${label}, which ${surface ? 'does not export that name' : 'exports nothing this project can reach'} — code reaching into that project's internals past its surface, which no pin and no binding compares.${writes} Reach what the project exports (its L0 export table: declare it there, then use it through the member alias or a pinned external), or carry the reach in a binding module the implementation declares (\`bindings\`), which is compared with what the project exports.`,
          realization.implementationsAt(file)[0]?.id,
          draftAt(file),
          undefined,
          { at: `${file} -> ${specifier}`, covers: internal.map(reach => reach.name ?? '<module>') },
        );
      }
    }
  },
};

/** A name as a cross-project import is compared with a published one: case and separators set aside. */
const nameKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * What another project — named by its root, relative to this one's — publishes
 * to this one, as the code names it: each exported type's code name and id,
 * and each exported component's contract methods (and their code symbols),
 * read from a member's L0 export table as it stands now, or from the pinned
 * snapshot of the external it is; and which of its source files realize a data
 * component. Null when the project is neither a member nor a pinned external:
 * nothing it holds is published to this project.
 */
function projectSurface(ctx: RuleContext, project: string): { label: string; names: Set<string>; data: Map<string, string> } | null {
  const root = posix.normalize(ctx.codeModel.projectRoot.replace(/\\/g, '/'));
  const directory = posix.normalize(posix.join(root, project));
  const same = (dir: string | undefined): boolean => !!dir && posix.normalize(dir.replace(/\\/g, '/')).toLowerCase() === directory.toLowerCase();
  const names = new Set<string>();
  const data = new Map<string, string>();
  const DATA = new Set(['Repository', 'Index', 'Store', 'Registry']);
  const family = ctx.projectFamily?.nodes ?? [];
  const member = family.find(node => node.namespace !== '' && same(node.directory));
  if (member) {
    const ns = member.namespace;
    const table = (ctx.exportTables ?? []).find(t => t.level === 'project' && t.owner === ns);
    const local = (id: string): string => id.slice(id.lastIndexOf(':') + 1).replace(/^.*\./, '');
    for (const entry of table?.entries ?? []) {
      names.add(nameKey(entry.publicName));
      if (entry.kind === 'type' && entry.typeDef) {
        const type = ctx.types.find(t => t.id === entry.typeDef || local(t.id) === local(entry.typeDef as string));
        if (type) { names.add(nameKey(type.name)); names.add(nameKey(type.symbol ?? type.name)); names.add(nameKey(local(type.id))); }
      } else if (entry.component) {
        for (const contract of ctx.interfacesByComponent.get(entry.component) ?? []) {
          for (const method of contract.methods) names.add(nameKey(method.name));
        }
        for (const impl of ctx.implementations) {
          if (ctx.interfaceMap.get(impl.contract)?.component !== entry.component) continue;
          for (const method of impl.methods) if (method.symbol) names.add(nameKey(method.symbol));
        }
      }
    }
    // A member's implementations stand outside this project's realization
    // index (their paths are the member's own), so they are read directly.
    for (const impl of ctx.implementations) {
      const component = ctx.componentMap.get(ctx.interfaceMap.get(impl.contract)?.component ?? '');
      if (!component || !component.id.startsWith(`${ns}::`) || !DATA.has(component.componentType)) continue;
      for (const file of implementationSourceFiles(impl)) data.set(pathKey(file), `${component.id} (a ${component.componentType})`);
    }
    return { label: `the member "${member.mountAlias ?? ns}"`, names, data };
  }
  const bound = family.find(node => node.namespace === '');
  const external = bound?.externals.find(e => same(e.directory));
  const pin = external ? ctx.pinnedExternals.find(p => p.alias === external.alias) : undefined;
  if (!external || !pin?.snapshot) return null;
  for (const type of pin.snapshot.types) { names.add(nameKey(type.id)); names.add(nameKey(type.name)); }
  for (const exported of pin.snapshot.exportedTypes ?? []) names.add(nameKey(exported.id));
  for (const entry of pin.snapshot.interfaces) {
    names.add(nameKey(entry.id));
    for (const method of entry.methods) names.add(nameKey(method.name));
  }
  return { label: `the external "${external.alias}"`, names, data };
}
