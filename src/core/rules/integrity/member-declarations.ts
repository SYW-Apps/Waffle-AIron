import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Member declarations: a project declares its members in project.yaml
// `members`. The rule does no I/O; it judges the project graph's problems at
// the bound root (kind mismatches, unavailable parts).
// ---------------------------------------------------------------------------

export const memberDeclarationsRule: SddRule = {
  name: 'member-declarations',
  judges: 'design',
  description:
    "A project declares its members in project.yaml `members`, each by one source in one grammar. It judges what each member of the bound project IS against what is declared or written about it, from the scan's problems at the bound root (a member's own members are that member's gate's): what a member is follows from its content — an id, an L0 or a lock make it a project, anything else a part — and every contradiction is ONE finding, MEMBER_KIND_MISMATCH (error), naming the alias and the contradiction: an asserted `as` the content contradicts; a part whose configuration declares project fields (members, externals, rules, extensions, composition, targets) without the id that would make it a project (add the id, or move them to the parent); a non-contained part with no PartOf, or one naming another project (opened alone it could not say what it belongs to); a contained member declaring PartOf; a `use` on a member whose content is a part (its names are already this project's own). A part whose files could not be read — its directory absent, or its git commit not cached and not fetchable (offline, refused, unknown) — is PART_UNAVAILABLE (error): the project's own subsystems are missing, so its verdict cannot be a pass. The member findings name no spec: members live in configuration. It reads the project graph's nodes, the bound root's declared members and its problems.",
  codes: [
    { code: 'MEMBER_KIND_MISMATCH', defaultSeverity: 'error', summary: "What a member's content makes it (an id, L0 or lock: a project; else a part) contradicts what is declared or written about it: an asserted `as`, project fields in a part, a missing or wrong PartOf, a `use` on a part." },
    { code: 'PART_UNAVAILABLE', defaultSeverity: 'error', summary: "A part's files could not be read (absent directory, unpinned or unfetchable git commit): the project's own subsystems are missing." },
  ],
  check(ctx) {
    // Step 1: the graph.
    const family = ctx.projectFamily;
    // Steps 2-3: a candidate run carries none.
    if (!family) return;
    // Steps 4-5: each member problem at the bound root — a member's own members
    // are that member's gate's. The findings name no spec: members live in
    // configuration.
    for (const problem of family.problems) {
      if (problem.projects[0] !== '') continue;
      if (problem.kind === 'kind-mismatch') {
        ctx.addIssue('error', 'MEMBER_KIND_MISMATCH', `Member "${problem.id}": ${problem.detail}.`);
      } else if (problem.kind === 'part-unavailable') {
        ctx.addIssue('error', 'PART_UNAVAILABLE', `Part "${problem.id}" could not be read — this project's own subsystems stored there are missing, so its verdict cannot be a pass: ${problem.detail}.`);
      }
    }
    // Step 8: judged.
  },
};
