import { posix } from 'path';
import {
  fieldTypesOf, implementationSourceFiles, importBindingOf, localTypesOf, methodSourceFile, pathKey, resolveImport,
  technologyName, technologyPackages, type CallSiteFact, type ComponentSpec, type ImplementationSpec,
} from '../../../models/index.js';
import { closedCallSites } from './call-conformance.js';
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

export const dependencyConformanceRule: SddRule = {
  name: 'dependency-conformance',
  judges: 'code',
  description:
    'Code↔spec Level 2: runtime import edges between component-mapped source files (a component maps to every file its implementations and their methods name) must be justified by declared relations — a direct dependsOn/owns pair, a shared component, membership in a depended-on pattern, or (across subsystems) a declared edge to the target subsystem\'s published surface (UNDECLARED_DEPENDENCY). A type-only import alone never accuses — type coupling is allowed — but a CALL of a modelled contract method through a collaborator whose declared type comes from another component\'s file is runtime collaboration whatever the import\'s form, and the same justification is owed (UNDECLARED_DEPENDENCY on that edge). Conversely, a declared dependsOn/owns edge between components realized in different files should be visible as an import between any file of the source and any file of the target (UNREALIZED_DEPENDENCY — DI indirection can defeat this, hence warning); a type-only import realizes it, since `import type` is what dependency injection writes down. An Adapter\'s edge to a Portal reached over an out-of-process transport (HTTP, gRPC, a bus, a CLI…) is the link the design models: the Adapter\'s transport client realizes it, never an import, so it is never UNREALIZED_DEPENDENCY — and nothing asks for an import across that boundary, which would couple two deployables\' builds. Two twins of design rules are judged on the same code: a Portal file calling a write- or lifecycle-effect contract method of a Repository, Index, Store or Registry is the persistence shortcut the design rule PORTAL_WRITE_SHORTCUT refuses, unless the Portal\'s own narrative already claims that call (the design rule\'s finding then) (PORTAL_WRITE_SHORTCUT_IN_CODE). A receiver is followed through a non-null assertion, parentheses, `satisfies`, a cast to a named type and a local alias or destructuring of a field exactly as through the field itself (a cast to any or unknown says nothing, and is not followed), and a call in a Portal\'s own file whose receiver the analysis cannot follow at all, under the name of a write- or lifecycle-effect method of a data component in the Portal\'s own subsystem or one it depends into, is said so rather than passed in silence (PORTAL_CALL_UNRESOLVED). And a file importing a technology\'s package while no component it realizes is that technology\'s home is the leak TECH_LEAKAGE refuses in the design (TECH_LEAKAGE_IN_CODE): a technology\'s packages are its declared tokens (its name, or its `matches`), the curated built-in table of the common packages its name is known by (postgres: pg, postgres, @neondatabase/serverless, @vercel/postgres; mysql: mysql2, mysql; redis: redis, ioredis; mongodb: mongodb, mongoose; sqlite: better-sqlite3, sqlite3; kafka: kafkajs; rabbitmq: amqplib — an HTTP client is never a technology leak), and the packages a loaded pack contributes for it, each compared exactly with an import\'s package name. Only exact-grade analyzed files participate; chained subprojects validate standalone.',
  codes: [
    { code: 'UNDECLARED_DEPENDENCY', defaultSeverity: 'warning', summary: 'A runtime import, or a call through a type-only-imported collaborator, between component-mapped files has no declared dependsOn/owns (or published-surface) justification' },
    { code: 'PORTAL_WRITE_SHORTCUT_IN_CODE', defaultSeverity: 'error', summary: 'A Portal\'s code calls a write- or lifecycle-effect method of a data component (Repository, Index, Store, Registry) directly — the code twin of PORTAL_WRITE_SHORTCUT: mutations route through an Orchestrator' },
    { code: 'TECH_LEAKAGE_IN_CODE', defaultSeverity: 'warning', summary: 'A source file imports a technology\'s package although no component it realizes binds that technology — the code twin of TECH_LEAKAGE' },
    { code: 'UNREALIZED_DEPENDENCY', defaultSeverity: 'warning', summary: 'A declared dependsOn/owns edge between components in different files is realized by no import between any of their files' },
    { code: 'PORTAL_CALL_UNRESOLVED', defaultSeverity: 'notice', summary: "A call in a Portal's own file, under the name of a data component's write- or lifecycle-effect method, goes through a receiver the analysis cannot follow at all — neither proven a shortcut nor cleared, and said so rather than passed in silence" },
  ],

  check(ctx: RuleContext): void {
    // ---- the mapped files, and the import graph closed over exactly them ----
    const code = ctx.codeIndex();
    const realization = ctx.realizationIndex();
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
    const calledAt = (toPath: string, name: string): Array<{ component: ComponentSpec; method: { name: string; effect?: string } }> =>
      realization.componentsAt(toPath)
        .map(c => ({ component: c, method: calledMethodOf(c.id, name) }))
        .filter((c): c is { component: ComponentSpec; method: { name: string; effect?: string } } => c.method !== undefined);

    const reportedEdges = new Set<string>();
    const reportedWrites = new Set<string>();
    const reportedUnresolved = new Set<string>();
    for (const fromPath of mappedPaths) {
      const facts = code.factsAt(fromPath);
      const fromComponents = realization.componentsAt(fromPath);
      if (!facts || fromComponents.length === 0) continue;

      // The persistence shortcut, written in code: what each Portal's OWN
      // realized methods in this file call — closed over their helpers — on
      // a data component, through a typed collaborator or a proven binding.
      for (const portal of fromComponents.filter(c => c.componentType === 'Portal')) {
        for (const impl of realization.implementationsOf(portal.id)) {
          for (const method of impl.methods) {
            if (pathKey(methodSourceFile(method, impl.sourcePath) ?? '') !== fromPath) continue;
            const sites = closedCallSites(code, fromPath, method.symbol ?? method.name, undefined, method.exportedVia) ?? [];
            for (const site of sites) {
              // Only a call written in the Portal's own file: a body it
              // forwards to by identity is the other component's to answer for.
              if (!site.member || pathKey(site.from ?? fromPath) !== fromPath) continue;
              const landings = new Set([...typedLandings(site, fromPath).map(l => l.toPath), ...code.originOf(site, fromPath)]);
              // A receiver the analysis cannot follow at all, under the name
              // of a data component's write: said so, never passed in silence.
              if (landings.size === 0 && unfollowable(site, fromPath)) {
                // Only a data component the Portal could plausibly be handed:
                // one in its own subsystem, or in a subsystem it depends into.
                const near = new Set([portal.subsystem, ...portal.dependsOn.map(d => ctx.componentMap.get(d)?.subsystem)]);
                const candidates = (dataWrites.get(site.name) ?? []).filter(w =>
                  near.has(ctx.componentMap.get(w.component)?.subsystem) && !claims(portal.id, w.component, w.method));
                const at = `${fromPath} -> ${site.name}`;
                if (candidates.length > 0 && !reportedUnresolved.has(at)) {
                  reportedUnresolved.add(at);
                  ctx.addIssue(
                    'notice',
                    'PORTAL_CALL_UNRESOLVED',
                    `Portal "${portal.id}": its method "${method.name}" in "${fromPath}" calls \`${site.via ?? (site.field ? `this.${site.field}` : '<receiver>')}.${site.name}(…)\` through a receiver this analysis cannot follow (nothing in the file declares its type), and ${candidates.map(w => `${w.component}.${w.method}`).join(', ')} — a data component's write — carries that name. Neither proven a persistence shortcut nor cleared: give the receiver a declared type (a field or parameter annotation) so the call can be judged.`,
                    impl.id,
                    draftAt(fromPath),
                    undefined,
                    { at },
                  );
                }
              }
              for (const toPath of landings) {
                if (toPath === fromPath) continue;
                for (const { component: target, method: called } of calledAt(toPath, site.name)) {
                  if (!DATA_COMPONENTS.has(target.componentType)) continue;
                  if (called.effect !== 'write' && called.effect !== 'lifecycle') continue;
                  if (claims(portal.id, target.id, called.name)) continue;
                  const at = `${fromPath} -> ${target.id}.${called.name}`;
                  if (reportedWrites.has(at)) continue;
                  reportedWrites.add(at);
                  ctx.addIssue(
                    'error',
                    'PORTAL_WRITE_SHORTCUT_IN_CODE',
                    `Portal "${portal.id}": its method "${method.name}" in "${fromPath}" calls ${called.effect}-effect method ${target.id}.${called.name} directly (\`${site.via ?? (site.field ? `this.${site.field}` : '<receiver>')}.${site.name}(…)\`), which its design never narrates — the code twin of PORTAL_WRITE_SHORTCUT. A Portal may reach a data component for READS only: route the ${called.effect === 'write' ? 'write' : 'lifecycle change'} through an Orchestrator that owns the workflow.`,
                    impl.id,
                    draftAt(fromPath) || draftAt(toPath),
                    undefined,
                    { at },
                  );
                }
              }
            }
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
            `"${file}" (realizing ${atFile.map(c => c.id).join(', ')}) imports "${specifier}", the package of technology "${tech.label}", whose home is ${[...tech.home].join(', ')} — the code twin of TECH_LEAKAGE. Move the vendor call behind the component that binds it, or bind the technology where it is really used.`,
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
