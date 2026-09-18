import { pathKey } from '../../../models/index.js';
import type { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// The integration-sim gate, question four: DOES THE HARNESS NAME EVERY
// NARRATED PATH (docs/design/integration-conformance.md §4.5).
//
// Path coverage is opt-in PER COMPONENT: only once the harness carries at
// least one "sim:<component-id>." anchor does that component claim path
// coverage, and only then are its narrated methods held to it — the happy path
// of every narrated method and every LABELED throw step. An anchor proves the
// harness NAMES the path; whether the driven scenario asserts anything useful
// stays the test author's craft, and execution stays CI's.
//
// integration-sim-file's verdict is restated as a guard: a harness that does
// not exist carries no anchors, and an uncovered-path finding against a file
// that is not there would be a second finding for one fault.
// ---------------------------------------------------------------------------

export const integrationSimCoverageRule: SddRule = {
  name: 'integration-sim-coverage',
  description:
    'Once a committed integration harness carries sim:<component-id>. anchors, that component claims path coverage: every narrated method\'s happy path and every labeled throw step needs its exact sim:<component>.<method>[:<label>] string-literal anchor. Anchors prove the path is NAMED — assertion quality and execution stay CI\'s job.',
  codes: [
    { code: 'SIM_PATH_UNCOVERED', defaultSeverity: 'warning', summary: 'A narrative path has no sim:<component>.<method>[:<label>] anchor in the component\'s coverage-opted harness' },
  ],
  check(ctx: RuleContext): void {
    const code = ctx.codeIndex();

    for (const impl of ctx.implementations) {
      if (!impl.simPath) continue;
      const contract = ctx.interfaceMap.get(impl.contract);
      const comp = contract ? ctx.componentMap.get(contract.component) : undefined;
      if (!comp) continue;
      if (ctx.isInChainedSubproject(comp.subsystem)) continue;

      const facts = code.factsAt(pathKey(impl.simPath));
      // integration-sim-file's verdict, restated: a harness that resolves to
      // no readable file is its finding, not ours.
      if (!facts || facts.status !== 'analyzed') continue;
      // Anchors are read from the file, so only exact-grade analysis may
      // accuse — a weaker grade stays silent rather than guess.
      if (facts.analysisGrade !== 'exact') continue;

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
      if (uncovered.length === 0) continue;
      ctx.addIssue(
        'warning',
        'SIM_PATH_UNCOVERED',
        `Sim "${impl.simPath}" declares path coverage for component "${comp.id}" (it carries sim: anchors) but does not name ${uncovered.join(', nor ')}. Drive the path and anchor it with the exact string literal, or drop the component's sim: anchors to withdraw the coverage claim. Unlabeled throw steps are not expected — a step's label is the path's identity. Anchors prove the path is NAMED; assertion quality and execution stay CI's job.`,
        impl.id,
        ctx.isImplementationDraft(impl),
      );
    }
  },
};
