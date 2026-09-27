import { SddRule } from '../types.js';
import { dependencyCycles, type CrossProjectReference } from '../../../models/index.js';

// ---------------------------------------------------------------------------
// Project cycles: projects that depend on each other in a loop cannot be
// approved or released one at a time. Every loop is reported on each project
// in it, with the references that make each edge — the edges with the fewest
// references first, since those are the cheapest to move.
//
// The rule does no I/O. The project graph finds the loops
// (ProjectFamily.dependencyCycles) over the cross-project references it holds.
// ---------------------------------------------------------------------------

/** How a key reads in a finding. */
function named(key: string): string {
  return key === '' ? 'the bound root' : `"${key}"`;
}

export const projectCyclesRule: SddRule = {
  name: 'project-cycles',
  description:
    "Projects that depend on each other in a loop cannot be approved or released one at a time: each needs the other's contract first. Every loop in the project dependency graph (ProjectFamily.dependencyCycles: an edge per cross-project reference or L0 re-export from a member or external; containment is no edge) is PROJECT_DEPENDENCY_CYCLE, reported once per loop on each project in it, naming the loop and, for each edge that closes it, the references that make the edge — so a person can see which few references to move. A warning in stage 3; stage 5's approval pins need an acyclic graph and raise it to an error.",
  codes: [
    { code: 'PROJECT_DEPENDENCY_CYCLE', defaultSeverity: 'warning', summary: "Projects of the family depend on each other in a loop" },
  ],
  check(ctx) {
    // Step 1: the graph.
    const family = ctx.projectFamily;
    // Steps 2-3: a candidate run carries none.
    if (!family) return;
    // Step 4: the loops.
    const loops = dependencyCycles(family);
    // Steps 5-6: each loop, on each project in it.
    for (const loop of loops) {
      const edges: { from: string; to: string; refs: CrossProjectReference[] }[] = [];
      for (let i = 0; i + 1 < loop.length; i++) {
        const from = loop[i];
        const to = loop[i + 1];
        if (edges.some((e) => e.from === from && e.to === to)) continue;
        edges.push({ from, to, refs: family.references.filter((r) => r.consumer === from && r.producer === to) });
      }
      edges.sort((a, b) => a.refs.length - b.refs.length);
      const path = loop.map(named).join(' -> ');
      const detail = edges
        .map((e) => `${named(e.from)} -> ${named(e.to)}: ${e.refs.map((r) => `"${r.specId}" ${r.position} "${r.authored}"`).join(', ')}`)
        .join('; ');
      for (const key of new Set(loop)) {
        ctx.addIssue(
          'warning',
          'PROJECT_DEPENDENCY_CYCLE',
          `Projects ${path} depend on each other in a loop, so neither can be approved or released before the other. The edges, cheapest to move first — ${detail}.`,
          key === '' ? undefined : key,
        );
      }
    }
    // Step 7: judged.
  },
};
