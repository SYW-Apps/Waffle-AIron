import * as path from 'path';
import type { ComponentSpec, ImplementationSpec } from '../../models/index.js';
import { RuleContext, SddRule } from './types.js';
import { isInChainedSubproject } from './conformance.js';

// ---------------------------------------------------------------------------
// Dependency conformance (code↔spec Level 2)
//
// The spec declares who collaborates (dependsOn/owns); the code's runtime
// import graph is the physical record of who ACTUALLY collaborates. This rule
// lifts file→file import edges (between component-mapped files only) to
// component sets via the sourcePath map and checks both directions:
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
//     realized in different files with NO import edge realizing it (for a
//     cross-subsystem portal edge: no import landing anywhere in the target
//     subsystem). Skipped when either side shares a file (N:1 collapse) —
//     dependency-injection indirection can also produce false positives,
//     which is why this stays a warning.
//
// Resolution is PURE: import specifiers are resolved string-wise against the
// closed set of component-mapped paths (.js→.ts swaps, index files) — no I/O.
// Only exact-grade (AST) analyzed files participate; pattern/generic imports
// are too coarse to accuse anyone with. Type-only imports never reach the
// model (excluded at collection). Chained-subproject implementations validate
// standalone in their own run and are skipped here, as in Level 1.
// ---------------------------------------------------------------------------

interface FileNode {
  /** Normalized project-relative path (forward slashes). */
  path: string;
  components: ComponentSpec[];
  /** First impl id mapped to this file (deterministic finding anchor). */
  anchorImplId: string;
  imports: string[];
  reexports: string[];
  draft: boolean;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Pure candidate resolution of a relative specifier against the mapped-file set. */
function resolveAgainst(mapped: Set<string>, fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const joined = normalizePath(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier)));
  const candidates = [
    joined,
    joined.replace(/\.js$/, '.ts'), joined.replace(/\.js$/, '.tsx'),
    `${joined}.ts`, `${joined}.tsx`, `${joined}.js`,
    `${joined}/index.ts`, `${joined}/index.js`,
  ];
  for (const c of candidates) {
    if (mapped.has(c)) return c;
  }
  return null;
}

export const dependencyConformanceRule: SddRule = {
  name: 'dependency-conformance',
  description:
    'Code↔spec Level 2: runtime import edges between component-mapped source files must be justified by declared relations — a direct dependsOn/owns pair, a shared component, membership in a depended-on pattern, or (across subsystems) a declared edge to the target subsystem\'s published surface (UNDECLARED_DEPENDENCY). Conversely, a declared dependsOn/owns edge between components realized in different files should be visible as an import (UNREALIZED_DEPENDENCY — DI indirection can defeat this, hence warning). Only exact-grade analyzed files participate; type-only imports are exempt; chained subprojects validate standalone.',
  codes: [
    { code: 'UNDECLARED_DEPENDENCY', defaultSeverity: 'warning', summary: 'A runtime import between component-mapped files has no declared dependsOn/owns (or published-surface) justification' },
    { code: 'UNREALIZED_DEPENDENCY', defaultSeverity: 'warning', summary: 'A declared dependsOn/owns edge between components in different files is realized by no import' },
  ],

  check(ctx: RuleContext): void {
    // ---- build the file→components map (exact-grade, non-chained only) ----
    const factsByPath = new Map(ctx.codeModel.files.map(f => [normalizePath(f.path), f]));
    const nodes = new Map<string, FileNode>();
    const filesByComponent = new Map<string, Set<string>>();
    const implsByComponent = new Map<string, ImplementationSpec[]>();

    for (const impl of ctx.implementations) {
      if (!impl.sourcePath) continue;
      const contract = ctx.interfaceMap.get(impl.contract);
      if (!contract) continue;
      const component = ctx.componentMap.get(contract.component);
      if (!component) continue;
      if (isInChainedSubproject(component.subsystem, ctx)) continue;

      const p = normalizePath(impl.sourcePath);
      const facts = factsByPath.get(p);
      if (!facts || facts.status !== 'analyzed' || facts.analysisGrade !== 'exact') continue;

      let node = nodes.get(p);
      if (!node) {
        node = { path: p, components: [], anchorImplId: impl.id, imports: facts.imports, reexports: facts.reexports, draft: false };
        nodes.set(p, node);
      }
      if (!node.components.some(c => c.id === component.id)) node.components.push(component);
      node.draft = node.draft || ctx.isImplementationDraft(impl);

      if (!filesByComponent.has(component.id)) filesByComponent.set(component.id, new Set());
      filesByComponent.get(component.id)!.add(p);
      if (!implsByComponent.has(component.id)) implsByComponent.set(component.id, []);
      implsByComponent.get(component.id)!.push(impl);
    }

    const mappedPaths = new Set(nodes.keys());

    // ---- resolve import edges between mapped files ----
    // Runtime imports are collaboration (checked); export-from re-exports are
    // surface republication (never accused, but they DO realize a declared
    // forwarding edge — a portal barrel republishing its orchestrator).
    const edges = new Map<string, Set<string>>(); // from path -> to paths
    const realizationEdges = new Map<string, Set<string>>(); // imports ∪ reexports
    for (const node of nodes.values()) {
      const targets = new Set<string>();
      for (const spec of node.imports) {
        const resolved = resolveAgainst(mappedPaths, node.path, spec);
        if (resolved && resolved !== node.path) targets.add(resolved);
      }
      edges.set(node.path, targets);
      const realized = new Set(targets);
      for (const spec of node.reexports) {
        const resolved = resolveAgainst(mappedPaths, node.path, spec);
        if (resolved && resolved !== node.path) realized.add(resolved);
      }
      realizationEdges.set(node.path, realized);
    }

    // ---- justification helpers ----
    const dependsOrOwns = (from: ComponentSpec, toId: string): boolean =>
      from.dependsOn.includes(toId) || (from.owns ?? []).includes(toId);

    // Does `from` declare an edge to the published surface of `subsystemId`?
    const declaresSurfaceEdge = (from: ComponentSpec, subsystemId: string): boolean => {
      const published = ctx.publicSet.get(subsystemId);
      if (!published || published.size === 0) return false;
      return from.dependsOn.some(d => published.has(d));
    };

    const edgeJustified = (fromNode: FileNode, toNode: FileNode): boolean => {
      for (const cf of fromNode.components) {
        for (const cg of toNode.components) {
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
          // member of a pattern the importer depends on (facade hop)
          const owner = ctx.components.find(c => (c.owns ?? []).includes(cg.id));
          if (owner && (dependsOrOwns(cf, owner.id) || cf.id === owner.id)) return true;
          // cross-subsystem: declared edge to the target subsystem's surface
          if (cf.subsystem !== cg.subsystem && declaresSurfaceEdge(cf, cg.subsystem)) return true;
        }
      }
      return false;
    };

    // ---- UNDECLARED_DEPENDENCY: every import edge needs a justification ----
    for (const [fromPath, targets] of edges) {
      const fromNode = nodes.get(fromPath)!;
      for (const toPath of targets) {
        const toNode = nodes.get(toPath)!;
        if (edgeJustified(fromNode, toNode)) continue;
        ctx.addIssue(
          'warning',
          'UNDECLARED_DEPENDENCY',
          `"${fromPath}" (realizing ${fromNode.components.map(c => c.id).join(', ')}) imports "${toPath}" (realizing ${toNode.components.map(c => c.id).join(', ')}) but no declared dependsOn/owns edge justifies it — declare the collaboration on the component that actually uses it, or route the cross-subsystem hop through the target's published surface.`,
          fromNode.anchorImplId,
          fromNode.draft || toNode.draft,
        );
      }
    }

    // ---- UNREALIZED_DEPENDENCY: every declared edge should leave a trace ----
    // A trace is a runtime import, a re-export (barrel forwarding), or — for a
    // mounting declarer (Portal/Observer) — the REVERSE import (the server
    // file imports the portal's file; mutual wiring, one file direction).
    const hasImportBetween = (fromFiles: Set<string>, toFiles: Set<string>, allowReverse: boolean): boolean => {
      for (const f of fromFiles) {
        const targets = realizationEdges.get(f);
        if (!targets) continue;
        for (const t of toFiles) if (targets.has(t)) return true;
      }
      if (allowReverse) {
        for (const t of toFiles) {
          const reverse = realizationEdges.get(t);
          if (!reverse) continue;
          for (const f of fromFiles) if (reverse.has(f)) return true;
        }
      }
      return false;
    };

    for (const component of ctx.components) {
      const fromFiles = filesByComponent.get(component.id);
      if (!fromFiles) continue;

      const isMountingDeclarer = component.componentType === 'Portal' || component.componentType === 'Observer';
      const declaredTargets = [...component.dependsOn, ...(component.owns ?? [])];
      for (const targetId of declaredTargets) {
        const target = ctx.componentMap.get(targetId);
        if (!target) continue;

        if (component.subsystem !== target.subsystem) {
          // Cross-subsystem portal edge: realized when ANY import lands in the
          // target subsystem's mapped files.
          const subsystemFiles = new Set<string>();
          for (const node of nodes.values()) {
            if (node.components.some(c => c.subsystem === target.subsystem)) subsystemFiles.add(node.path);
          }
          if (subsystemFiles.size === 0) continue;
          for (const f of fromFiles) subsystemFiles.delete(f); // shared files satisfy trivially
          if (subsystemFiles.size === 0) continue;
          if (hasImportBetween(fromFiles, subsystemFiles, isMountingDeclarer)) continue;
        } else {
          const toFiles = filesByComponent.get(targetId);
          if (!toFiles) continue; // target unmapped (no sourcePath / non-exact) — Level 1 territory
          if ([...fromFiles].some(f => toFiles.has(f))) continue; // N:1 same-file collapse
          if (hasImportBetween(fromFiles, toFiles, isMountingDeclarer)) continue;
        }

        const impls = implsByComponent.get(component.id) ?? [];
        const anchor = impls[0];
        const draft = ctx.isComponentDraft(component.id) || ctx.isComponentDraft(targetId)
          || impls.some(i => ctx.isImplementationDraft(i));
        ctx.addIssue(
          'warning',
          'UNREALIZED_DEPENDENCY',
          `Component "${component.id}" declares ${component.dependsOn.includes(targetId) ? 'dependsOn' : 'owns'} "${targetId}", but no runtime import connects their source files (${[...fromFiles].join(', ')} ↛ ${target.subsystem !== component.subsystem ? `subsystem ${target.subsystem}` : [...(filesByComponent.get(targetId) ?? [])].join(', ')}) — either the collaboration is wired indirectly (DI) or the declared edge is stale.`,
          anchor?.id ?? component.id,
          draft,
        );
      }
    }
  },
};
