import type { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// The integration-sim gate, question one: IS A HARNESS EXPECTED HERE
// (docs/design/integration-conformance.md §4).
//
// Unit suites with mocked collaborators prove contract SHAPE; cross-component
// bugs live in the wiring the mocks encode away. A component cannot honestly
// claim completeness until a committed integration harness (L4 simPath) wires
// it to its REAL dependencies — so a complete, non-leaf implementation that
// declares none is reported, and this rule reports nothing else.
//
// Adoption is subsystem-by-subsystem and mechanical: declaring the FIRST
// simPath in a subsystem activates the expectation for that subsystem's other
// complete, non-leaf implementations — no global flood on trees that have not
// adopted sims yet. Whether a DECLARED harness exists, wires and covers is
// integration-sim-file's, -wiring's and -coverage's question.
// ---------------------------------------------------------------------------

export const integrationSimDeclarationRule: SddRule = {
  name: 'integration-sim-declaration',
  description:
    'Once a subsystem has adopted integration sims (its first declared L4 simPath), every OTHER complete, non-leaf implementation of that subsystem must declare one too: its unit suite proves contract shape against mocks, not that the wired components run together. A leaf component\'s unit suite IS its sim, and a subsystem that has adopted nothing is never flooded.',
  codes: [
    { code: 'MISSING_INTEGRATION_SIM', defaultSeverity: 'warning', summary: 'Complete non-leaf implementation in a sim-adopting subsystem declares no simPath' },
  ],
  check(ctx: RuleContext): void {
    // Subsystems that have adopted sims: any implementation declaring one.
    // Chained subprojects are skipped throughout — their sourcePaths are
    // relative to the child's own root, and the child validates them in its
    // own run.
    const adopted = new Set<string>();
    for (const impl of ctx.implementations) {
      if (!impl.simPath) continue;
      const contract = ctx.interfaceMap.get(impl.contract);
      const comp = contract ? ctx.componentMap.get(contract.component) : undefined;
      if (!comp || ctx.isInChainedSubproject(comp.subsystem)) continue;
      adopted.add(comp.subsystem);
    }

    for (const impl of ctx.implementations) {
      if (impl.simPath) continue;
      const contract = ctx.interfaceMap.get(impl.contract);
      const comp = contract ? ctx.componentMap.get(contract.component) : undefined;
      if (!comp) continue;
      if (ctx.isInChainedSubproject(comp.subsystem)) continue;

      // Only for complete implementations, only once the subsystem has adopted
      // sims, and only for non-leaf components (a leaf's unit suite IS its sim).
      if (!adopted.has(comp.subsystem)) continue;
      if (ctx.isImplementationDraft(impl)) continue;
      const deps = [...new Set([...comp.dependsOn, ...comp.owns])].filter(d => ctx.componentMap.has(d));
      if (deps.length === 0) continue;
      ctx.addIssue(
        'warning',
        'MISSING_INTEGRATION_SIM',
        `Implementation "${impl.id}" (component "${comp.id}") is complete with ${deps.length} declared dependenc${deps.length === 1 ? 'y' : 'ies'}, its subsystem "${comp.subsystem}" has adopted integration sims, but it declares no simPath — its unit suite proves contract shape against mocks, not that the wired components run together. Declare the committed harness that constructs it with its REAL dependencies (N:1 sharing allowed), or lint.allow with the reason.`,
        impl.id,
      );
    }
  },
};
