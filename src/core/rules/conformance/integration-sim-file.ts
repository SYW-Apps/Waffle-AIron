import { pathKey } from '../../../models/index.js';
import type { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// The integration-sim gate, question two: DOES THE DECLARED HARNESS EXIST
// (docs/design/integration-conformance.md §4).
//
// An integration harness is a committed, re-runnable file inside the project:
// a simPath that resolves to nothing, escapes the root, or is not readable as
// source text is a claim with no file behind it. The validator never runs
// anything — whether the harness PASSES is CI's job.
//
// This verdict is the precondition of the two soundness rules that follow:
// integration-sim-wiring and -coverage each restate it, because a file that is
// not there can be neither unwired nor uncovered.
// ---------------------------------------------------------------------------

export const integrationSimFileRule: SddRule = {
  name: 'integration-sim-file',
  description:
    'A declared L4 simPath must resolve to a readable, committed file inside the project root — the integration harness is a re-runnable file, not a claim. Execution stays CI\'s job.',
  codes: [
    { code: 'SIM_FILE_MISSING', defaultSeverity: 'warning', summary: 'Declared simPath resolves to no file inside the project root' },
  ],
  check(ctx: RuleContext): void {
    const code = ctx.codeIndex();

    for (const impl of ctx.implementations) {
      if (!impl.simPath) continue;
      const contract = ctx.interfaceMap.get(impl.contract);
      const comp = contract ? ctx.componentMap.get(contract.component) : undefined;
      if (!comp) continue;
      // A chained child's paths are relative to its own root; it validates
      // them in its own run.
      if (ctx.isInChainedSubproject(comp.subsystem)) continue;

      const facts = code.factsAt(pathKey(impl.simPath));
      if (facts && facts.status === 'analyzed') continue;
      const why = !facts || facts.status === 'missing'
        ? 'resolves to no file'
        : facts.status === 'escaped' ? 'escapes the project root — sims are project-relative, committed files'
          : 'is not readable as source text';
      ctx.addIssue(
        'warning',
        'SIM_FILE_MISSING',
        `Implementation "${impl.id}" declares simPath "${impl.simPath}", which ${why}. The integration harness must be a committed, re-runnable file inside the project.`,
        impl.id,
        ctx.isImplementationDraft(impl),
      );
    }
  },
};
