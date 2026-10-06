import { implementationSourceFiles, pathKey } from '../../../models/index.js';
import type { RuleContext, SddRule } from '../types.js';
import { plannedCode } from './source-file-linkage.js';

// ---------------------------------------------------------------------------
// The integration-sim gate, question two: DOES THE DECLARED HARNESS EXIST
// (docs/design/integration-conformance.md §4).
//
// An integration harness is a committed, re-runnable file inside the project:
// a simPath that resolves to nothing, escapes the root, or is not readable as
// source text is a claim with no file behind it. The validator never runs
// anything — whether the harness PASSES is CI's job.
//
// A harness declared for an implementation whose realization has not begun
// (code_index.holdsAny over its named files is false) is PLANNED with the code
// it will wire — a notice, so a design may name its harness up front.
//
// This verdict is the precondition of the two soundness rules that follow:
// integration-sim-wiring and -coverage each restate it, because a file that is
// not there can be neither unwired nor uncovered.
// ---------------------------------------------------------------------------

export const integrationSimFileRule: SddRule = {
  name: 'integration-sim-file',
  judges: 'code',
  description:
    'A declared L4 simPath must resolve to a readable, committed file inside the project root — the integration harness is a re-runnable file, not a claim; execution stays CI\'s job. A harness declared for an implementation whose realization has not begun is planned with the code it will wire (SOURCE_FILE_PLANNED, a notice; an error under rules.conformance.requireCode), so a design may name its harness up front.',
  codes: [
    { code: 'SIM_FILE_MISSING', defaultSeverity: 'warning', summary: 'Declared simPath resolves to no file inside the project root although the implementation it wires has begun' },
    { code: 'SOURCE_FILE_PLANNED', defaultSeverity: 'notice', summary: 'A declared simPath is not on disk and the implementation it wires has no code yet either — planned, not written yet' },
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
      // A harness for code not written yet is planned with it — unless it
      // escapes the root or is unreadable, which no plan explains.
      const broken = facts?.status === 'escaped' || facts?.status === 'unreadable';
      if (!broken && !code.holdsAny(implementationSourceFiles(impl))) {
        const planned = plannedCode(ctx);
        ctx.addIssue(
          planned.severity,
          'SOURCE_FILE_PLANNED',
          `Implementation "${impl.id}" declares simPath "${impl.simPath}", which is planned with the code it wires — not written yet${planned.note}.`,
          impl.id,
          ctx.isImplementationDraft(impl),
        );
        continue;
      }
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
