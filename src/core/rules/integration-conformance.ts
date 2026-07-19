import * as path from 'path';
import type { ImplementationSpec } from '../../models/index.js';
import { normalizeSourcePath } from '../source-analysis.js';
import type { RuleContext, SddRule } from './types.js';
import { isInChainedSubproject } from './conformance.js';

// ---------------------------------------------------------------------------
// Integration conformance (docs/design/integration-conformance.md §4).
//
// Unit suites with mocked collaborators prove contract SHAPE; cross-component
// bugs live in the wiring the mocks encode away. The static gate proves — and
// only proves — that a committed integration harness (L4 `simPath`) EXISTS
// and its import graph WIRES the real modules: the component's own sourcePath
// and at least one sourcePath of each direct dependency. Whether the harness
// PASSES is CI's job (it is an ordinary test file); the validator never runs
// anything.
//
// Adoption is subsystem-by-subsystem and mechanical: declaring the FIRST
// simPath in a subsystem activates MISSING_INTEGRATION_SIM for that
// subsystem's other complete, non-leaf implementations — no global flood on
// trees that have not adopted sims yet.
// ---------------------------------------------------------------------------

const normalizePath = normalizeSourcePath;

/** Pure candidate resolution of a relative specifier against the analyzed-file set (mirrors dependency-conformance). */
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

export const integrationConformanceRule: SddRule = {
  name: 'integration-conformance',
  description:
    'A component cannot honestly claim completeness until a committed integration harness wires it to its REAL dependencies (L4 simPath). Statically checked: the harness file exists inside the project root, and its import graph — closed transitively over the analyzed module set, exact grade only — reaches the component\'s own sourcePath module and at least one sourcePath module of each direct dependsOn/owns component (technology-boundary dependencies exempt: their fakes are sanctioned). Execution is CI\'s job — these findings prove wiring, never that the sim passes. MISSING_INTEGRATION_SIM activates per subsystem once its first simPath is declared.',
  codes: [
    { code: 'MISSING_INTEGRATION_SIM', defaultSeverity: 'warning', summary: 'Complete non-leaf implementation in a sim-adopting subsystem declares no simPath' },
    { code: 'SIM_FILE_MISSING', defaultSeverity: 'warning', summary: 'Declared simPath resolves to no file inside the project root' },
    { code: 'UNWIRED_INTEGRATION_SIM', defaultSeverity: 'warning', summary: 'Sim file does not import the real modules it claims to wire' },
    { code: 'SIM_PATH_UNCOVERED', defaultSeverity: 'warning', summary: 'A narrative path has no sim:<component>.<method>[:<label>] anchor in the component\'s coverage-opted harness' },
  ],
  check(ctx: RuleContext): void {
    const factsByPath = new Map(ctx.codeModel.files.map(f => [normalizePath(f.path), f]));
    const allPaths = new Set(factsByPath.keys());

    // Files realizing each component / each subsystem (reach targets). The
    // subsystem set exists for cross-subsystem dependencies: the published
    // portal's barrel is cosmetic at runtime (same doctrine as
    // dependency-conformance), so wiring is proven by reaching ANY module of
    // the target subsystem.
    const filesByComponent = new Map<string, Set<string>>();
    const filesBySubsystem = new Map<string, Set<string>>();
    const implsByComponent = new Map<string, ImplementationSpec[]>();
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      const comp = contract ? ctx.componentMap.get(contract.component) : undefined;
      if (!comp) continue;
      if (!implsByComponent.has(comp.id)) implsByComponent.set(comp.id, []);
      implsByComponent.get(comp.id)!.push(impl);
      if (impl.sourcePath) {
        const p = normalizePath(impl.sourcePath);
        if (!filesByComponent.has(comp.id)) filesByComponent.set(comp.id, new Set());
        filesByComponent.get(comp.id)!.add(p);
        if (!filesBySubsystem.has(comp.subsystem)) filesBySubsystem.set(comp.subsystem, new Set());
        filesBySubsystem.get(comp.subsystem)!.add(p);
      }
    }

    // A dependency whose implementations declare technologies is a technology
    // boundary — its contract-faithful fake is sanctioned, so the sim need
    // not import its real module.
    const isTechBoundary = (compId: string): boolean =>
      (implsByComponent.get(compId) ?? []).some(i => (i.technologies ?? []).length > 0);

    // Subsystems that have adopted sims: any implementation declaring one.
    const adopted = new Set<string>();
    for (const impl of ctx.implementations) {
      if (!impl.simPath) continue;
      const contract = ctx.interfaceMap.get(impl.contract);
      const comp = contract ? ctx.componentMap.get(contract.component) : undefined;
      if (comp) adopted.add(comp.subsystem);
    }

    // Transitive import closure from one file over the analyzed set (imports
    // realize wiring; export-from barrels republish it — both count).
    const reachFrom = (start: string): Set<string> => {
      const seen = new Set<string>([start]);
      const stack = [start];
      while (stack.length) {
        const from = stack.pop()!;
        const facts = factsByPath.get(from);
        if (!facts || facts.status !== 'analyzed') continue;
        for (const spec of [...facts.imports, ...facts.reexports]) {
          const to = resolveAgainst(allPaths, from, spec);
          if (to && !seen.has(to)) { seen.add(to); stack.push(to); }
        }
      }
      return seen;
    };

    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      const comp = contract ? ctx.componentMap.get(contract.component) : undefined;
      if (!comp) continue;
      if (isInChainedSubproject(comp.subsystem, ctx)) continue;

      const deps = [...new Set([...comp.dependsOn, ...comp.owns])].filter(d => ctx.componentMap.has(d));

      if (!impl.simPath) {
        // Expectation half: only for complete implementations, only once the
        // subsystem has adopted sims, and only for non-leaf components (a
        // leaf's unit suite IS its sim).
        if (!adopted.has(comp.subsystem)) continue;
        if (ctx.isImplementationDraft(impl)) continue;
        if (deps.length === 0) continue;
        ctx.addIssue(
          'warning',
          'MISSING_INTEGRATION_SIM',
          `Implementation "${impl.id}" (component "${comp.id}") is complete with ${deps.length} declared dependenc${deps.length === 1 ? 'y' : 'ies'}, its subsystem "${comp.subsystem}" has adopted integration sims, but it declares no simPath — its unit suite proves contract shape against mocks, not that the wired components run together. Declare the committed harness that constructs it with its REAL dependencies (N:1 sharing allowed), or lint.allow with the reason.`,
          impl.id,
        );
        continue;
      }

      // Soundness half: the declared harness must exist and wire the real modules.
      const simPath = normalizePath(impl.simPath);
      const facts = factsByPath.get(simPath);
      const isDraftCtx = ctx.isImplementationDraft(impl);
      if (!facts || facts.status === 'missing' || facts.status === 'escaped' || facts.status === 'unreadable') {
        const why = !facts || facts.status === 'missing'
          ? 'resolves to no file'
          : facts.status === 'escaped' ? 'escapes the project root — sims are project-relative, committed files'
            : 'is not readable as source text';
        ctx.addIssue(
          'warning',
          'SIM_FILE_MISSING',
          `Implementation "${impl.id}" declares simPath "${impl.simPath}", which ${why}. The integration harness must be a committed, re-runnable file inside the project.`,
          impl.id,
          isDraftCtx,
        );
        continue;
      }
      // Only exact-grade import graphs can prove wiring — weaker grades stay
      // silent rather than guess (the honest-lint stance).
      if (facts.analysisGrade !== 'exact') continue;

      const reach = reachFrom(simPath);
      const ownFiles = filesByComponent.get(comp.id) ?? new Set<string>();
      const missing: string[] = [];
      if (ownFiles.size > 0 && ![...ownFiles].some(f => reach.has(f))) {
        missing.push(`the component's own module (${[...ownFiles].join(' | ')})`);
      }
      for (const dep of deps) {
        if (isTechBoundary(dep)) continue;
        const depComp = ctx.componentMap.get(dep)!;
        // Cross-subsystem: the sanctioned hop is the published surface whose
        // barrel is cosmetic — any reached module of the target subsystem
        // proves the real wiring.
        const depFiles = depComp.subsystem !== comp.subsystem
          ? filesBySubsystem.get(depComp.subsystem)
          : filesByComponent.get(dep);
        if (!depFiles || depFiles.size === 0) continue; // unrealized dependency — its own findings cover that
        if (![...depFiles].some(f => reach.has(f))) {
          const label = depComp.subsystem !== comp.subsystem ? `"${dep}" (any module of subsystem "${depComp.subsystem}")` : `"${dep}" (${[...depFiles].join(' | ')})`;
          missing.push(label);
        }
      }
      if (missing.length) {
        ctx.addIssue(
          'warning',
          'UNWIRED_INTEGRATION_SIM',
          `Sim "${impl.simPath}" of implementation "${impl.id}" does not reach ${missing.join(', nor ')} through its import graph (closed over the analyzed modules, exact grade) — the harness is not wiring the real implementations it claims to exercise. Import the real modules (technology-boundary adapters may stay contract-faithfully faked), or fix the simPath.`,
          impl.id,
          isDraftCtx,
        );
      }

      // Path coverage (§4.5) — opt-in PER COMPONENT: only once the harness
      // carries at least one "sim:<component-id>." anchor does this component
      // claim path coverage, and only then are its narrated methods held to
      // it. An anchor proves the harness NAMES the path; whether the driven
      // scenario asserts anything useful stays the test author's craft.
      const simAnchors = new Set(facts.anchoredNames.filter(a => a.startsWith('sim:')));
      if (simAnchors.size === 0) continue;
      const compPrefix = `sim:${comp.id}.`;
      if (![...simAnchors].some(a => a.startsWith(compPrefix))) continue;

      const uncovered: string[] = [];
      for (const method of impl.methods) {
        const steps = method.narrative ?? [];
        if (!steps.length) continue;
        const happy = `sim:${comp.id}.${method.name}`;
        if (!simAnchors.has(happy)) {
          uncovered.push(`the happy path of "${method.name}" (anchor "${happy}")`);
        }
        for (const step of steps) {
          if (step.type !== 'throw' || !step.label) continue;
          const pathAnchor = `sim:${comp.id}.${method.name}:${step.label}`;
          if (!simAnchors.has(pathAnchor)) {
            uncovered.push(`error path "${step.label}" of "${method.name}" (anchor "${pathAnchor}")`);
          }
        }
      }
      if (uncovered.length) {
        ctx.addIssue(
          'warning',
          'SIM_PATH_UNCOVERED',
          `Sim "${impl.simPath}" declares path coverage for component "${comp.id}" (it carries sim: anchors) but does not name ${uncovered.join(', nor ')}. Drive the path and anchor it with the exact string literal, or drop the component's sim: anchors to withdraw the coverage claim. Unlabeled throw steps are not expected — a step's label is the path's identity. Anchors prove the path is NAMED; assertion quality and execution stay CI's job.`,
          impl.id,
          isDraftCtx,
        );
      }
    }
  },
};
