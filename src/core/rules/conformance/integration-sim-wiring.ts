import { pathKey } from '../../../models/index.js';
import type { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// The integration-sim gate, question three: DOES THE HARNESS WIRE THE REAL
// MODULES (docs/design/integration-conformance.md §4).
//
// This proves — and only proves — that the committed harness's import graph
// REACHES the real modules it claims to exercise: at least one of the
// component's own modules (every existing file its implementations name —
// each implementation's sourcePath and each method's) and at least one module
// of each direct dependency. A missing file is structural conformance's
// finding alone, and chained subprojects' files are the child's own run's.
// Whether the harness PASSES is CI's job; the validator never runs anything.
//
// integration-sim-file's verdict is restated as a guard: a harness that does
// not exist reaches nothing, and reporting it unwired on top of missing would
// be two findings for one fault.
// ---------------------------------------------------------------------------

export const integrationSimWiringRule: SddRule = {
  name: 'integration-sim-wiring',
  description:
    'A committed integration harness\'s import graph — closed transitively over the analyzed module set, exact grade only — must reach at least one of the component\'s own source modules (its implementation\'s or a method\'s) and at least one source module of each direct dependsOn/owns component (technology-boundary dependencies exempt: their contract-faithful fakes are sanctioned). Execution is CI\'s job — this proves wiring, never that the sim passes.',
  codes: [
    { code: 'UNWIRED_INTEGRATION_SIM', defaultSeverity: 'warning', summary: 'Sim file does not import the real modules it claims to wire' },
  ],
  check(ctx: RuleContext): void {
    const code = ctx.codeIndex();
    const realization = ctx.realizationIndex();
    // The harness is walked over EVERY path the run analyzed — the default
    // closed set of the shared import graph. Imports realize wiring;
    // export-from barrels republish it; both count as traces.
    const graph = ctx.importGraph();

    // A named file is a module only when it exists: a missing or escaped file
    // is structural conformance's finding alone, and no harness can reach it.
    const exists = (p: string): boolean => {
      const status = code.factsAt(p)?.status;
      return status === 'analyzed' || status === 'unreadable';
    };
    // Files realizing each component / each subsystem (reach targets), read
    // from the shared realization index. The subsystem set exists for
    // cross-subsystem dependencies: as in dependency-conformance, wiring is
    // proven by reaching ANY module of the target subsystem (where a hop
    // lands is portal-imports' question). Chained
    // subprojects are absent from the index, as in dependency-conformance:
    // their sourcePaths are relative to the child's own root, and the child
    // validates them in its own run.
    const modulesOf = (compId: string): string[] => realization.filesOf(compId).filter(exists);
    const modulesIn = (subsystemId: string): string[] => realization.filesIn(subsystemId).filter(exists);

    // A dependency whose implementations declare technologies is a technology
    // boundary — its contract-faithful fake is sanctioned, so the sim need
    // not import its real module.
    const isTechBoundary = (compId: string): boolean =>
      realization.implementationsOf(compId).some(i => (i.technologies ?? []).length > 0);

    for (const impl of ctx.implementations) {
      if (!impl.simPath) continue;
      const contract = ctx.interfaceMap.get(impl.contract);
      const comp = contract ? ctx.componentMap.get(contract.component) : undefined;
      if (!comp) continue;
      if (ctx.isInChainedSubproject(comp.subsystem)) continue;

      const simPath = pathKey(impl.simPath);
      const facts = code.factsAt(simPath);
      // integration-sim-file's verdict, restated: a harness that resolves to
      // no readable file is its finding, not ours.
      if (!facts || facts.status !== 'analyzed') continue;
      // Only exact-grade import graphs can prove wiring — weaker grades stay
      // silent rather than guess (the honest-lint stance).
      if (facts.analysisGrade !== 'exact') continue;

      const deps = [...new Set([...comp.dependsOn, ...comp.owns])].filter(d => ctx.componentMap.has(d));
      const reach = graph.reachFrom(simPath);
      const ownFiles = modulesOf(comp.id);
      const missing: string[] = [];
      if (ownFiles.length > 0 && !ownFiles.some(f => reach.has(f))) {
        missing.push(`the component's own module (${ownFiles.join(' | ')})`);
      }
      for (const dep of deps) {
        if (isTechBoundary(dep)) continue;
        const depComp = ctx.componentMap.get(dep)!;
        // Cross-subsystem: any reached module of the target subsystem proves
        // the real wiring exists; where it lands is portal-imports' question.
        const depFiles = depComp.subsystem !== comp.subsystem
          ? modulesIn(depComp.subsystem)
          : modulesOf(dep);
        if (depFiles.length === 0) continue; // no existing module here (unrealized, or in a chained subproject) — other findings or the child's own run cover that
        if (!depFiles.some(f => reach.has(f))) {
          const label = depComp.subsystem !== comp.subsystem ? `"${dep}" (any module of subsystem "${depComp.subsystem}")` : `"${dep}" (${depFiles.join(' | ')})`;
          missing.push(label);
        }
      }
      if (missing.length === 0) continue;
      ctx.addIssue(
        'warning',
        'UNWIRED_INTEGRATION_SIM',
        `Sim "${impl.simPath}" of implementation "${impl.id}" does not reach ${missing.join(', nor ')} through its import graph (closed over the analyzed modules, exact grade) — the harness is not wiring the real implementations it claims to exercise. Import the real modules (technology-boundary adapters may stay contract-faithfully faked), or fix the simPath.`,
        impl.id,
        ctx.isImplementationDraft(impl),
      );
    }
  },
};
