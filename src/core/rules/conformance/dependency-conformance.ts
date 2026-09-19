import { implementationSourceFiles, pathKey, type ComponentSpec, type ImplementationSpec } from '../../../models/index.js';
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
//     edge to the target subsystem's PUBLISHED surface (in-process imports
//     may land in the subsystem's concrete modules; the published-portal
//     declaration is the sanctioned hop, its barrel is cosmetic at runtime).
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
// Type-only imports never reach the model (excluded at collection).
// Chained-subproject implementations validate standalone in their own run and
// are absent from the realization index, as in Level 1.
// ---------------------------------------------------------------------------

export const dependencyConformanceRule: SddRule = {
  name: 'dependency-conformance',
  description:
    'Code↔spec Level 2: runtime import edges between component-mapped source files (a component maps to every file its implementations and their methods name) must be justified by declared relations — a direct dependsOn/owns pair, a shared component, membership in a depended-on pattern, or (across subsystems) a declared edge to the target subsystem\'s published surface (UNDECLARED_DEPENDENCY). Conversely, a declared dependsOn/owns edge between components realized in different files should be visible as an import between any file of the source and any file of the target (UNREALIZED_DEPENDENCY — DI indirection can defeat this, hence warning). Only exact-grade analyzed files participate; type-only imports are exempt; chained subprojects validate standalone.',
  codes: [
    { code: 'UNDECLARED_DEPENDENCY', defaultSeverity: 'warning', summary: 'A runtime import between component-mapped files has no declared dependsOn/owns (or published-surface) justification' },
    { code: 'UNREALIZED_DEPENDENCY', defaultSeverity: 'warning', summary: 'A declared dependsOn/owns edge between components in different files is realized by no import between any of their files' },
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

        // Across subsystems the sanctioned hop is the target subsystem's
        // published surface, whose barrel is cosmetic at runtime: ANY of its
        // mapped files proves the wiring, minus the ones shared with the
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

        const impls = mappedImplsOf(component.id);
        const declaredDependsOn = component.dependsOn.includes(targetId);
        const declaredOwns = (component.owns ?? []).includes(targetId);
        const relation = declaredDependsOn && declaredOwns ? 'dependsOn and owns' : declaredDependsOn ? 'dependsOn' : 'owns';
        const draft = ctx.isComponentDraft(component.id) || ctx.isComponentDraft(targetId)
          || impls.some(i => ctx.isImplementationDraft(i));
        ctx.addIssue(
          'warning',
          'UNREALIZED_DEPENDENCY',
          `Component "${component.id}" declares ${relation} "${targetId}", but no runtime import connects their source files (${fromFiles.join(', ')} ↛ ${crossSubsystem ? `subsystem ${target.subsystem}` : filesOf(targetId).join(', ')}) — either the collaboration is wired indirectly (DI) or the declared edge is stale.`,
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
  },
};
