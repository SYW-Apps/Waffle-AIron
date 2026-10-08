import { SddRule } from '../types.js';
import { isDraftSubsystem } from '../../../models/index.js';

// ---------------------------------------------------------------------------
// Export tables: every level's table must resolve the way a module resolver
// resolves `export … from`.
//
// The rule does no resolving. The export index follows every re-export to its
// canonical target once per scan and records what it met as problems; the
// validator hands those tables over in ctx.exportTables, and each problem kind
// becomes one finding here, anchored to the table's owner — a subsystem, or
// the L0 system spec for the project's table.
//
// Severities follow what each problem costs today. Two names for one public
// name, and a chain that never grounds, break the published contract now
// (errors). A wildcard cycle still resolves, to the union, so it is only the
// circular-surface smell (a warning). An invalid entry and an unconsumable
// target are notices until stage 4 makes them errors: the resolver binds an
// invalid entry leniently, so no existing published name moves meanwhile.
// ---------------------------------------------------------------------------

export const exportTablesRule: SddRule = {
  name: 'export-tables',
  judges: 'design',
  description:
    "Every level's export table must resolve the way a module resolver resolves `export … from`. One public name binds one target: EXPORT_ID_DUPLICATE when two wildcards (or two explicit entries) bind a name to different targets, or two public names share one nameKey, since a bare import could not tell them apart; the name is left out. No chain leads back to itself: EXPORT_CYCLE, an error for a named chain that never reaches a component or type, a warning for a wildcard cycle, which resolves to its union. Every entry names a source and an item that exist, that the source exports and, for an own type, that the level owns (a subsystem-owned type at L1, a project-level type with no subsystem for an L0 `{ typeDef }` without `from`), under a public name of [a-z0-9-_]+, and an L0 wildcard re-export reaches at least one name — a subsystem or project that exports nothing publishes nothing through it (EXPORT_INVALID) — a named re-export whose source renamed the item names the new name. Every exported component can serve what its role promises (EXPORT_UNCONSUMABLE, at L0 and for L1 re-exports): an entry consumers call must be a Portal (a gateway being a Portal variant) or an Observer for events, and an entry consumers implement (role implement, an extension point) may also be an Adapter whose realization consumers supply. An L0 entry that re-exports a member's or an external's export never declares a wider audience than that export has (EXPORT_WIDENS_AUDIENCE): a re-export can narrow reach, never widen it. An own L0 entry exported to `department` is a notice (EXPORT_AUDIENCE_NARROW): outside a hosted instance only the project's family sees it, and a sibling checkout or git consumer — read at `instance` — is refused; whether its consumers are hosted cannot be told from the tree, so it never fails the gate. An entry's export kind is derived from its backing Portal's transport and no longer authored, so no rule compares an authored kind with the stereotype; the retired public-surface-declared-type rule and its codes are gone. The rule judges the facts the export resolver recorded in the scan, for the bound root's table and every contained member's, and resolves nothing itself.",
  codes: [
    { code: 'EXPORT_ID_DUPLICATE', defaultSeverity: 'error', summary: "One public name bound to different targets by two wildcard re-exports or two explicit entries" },
    { code: 'EXPORT_CYCLE', defaultSeverity: 'error', summary: "A re-export chain leads back to itself (a warning for a wildcard cycle, which resolves to its union)" },
    { code: 'EXPORT_INVALID', defaultSeverity: 'error', summary: "An export entry names a missing source or item, an item its source does not export or its level does not own, or a malformed public name" },
    { code: 'EXPORT_UNCONSUMABLE', defaultSeverity: 'error', summary: "An exported component that cannot serve its role: called but neither a Portal nor an Observer, or implemented but neither a Portal nor an Adapter" },
    { code: 'EXPORT_WIDENS_AUDIENCE', defaultSeverity: 'error', summary: "An L0 entry declares a wider audience than the member or external export it re-exports" },
    { code: 'EXPORT_AUDIENCE_NARROW', defaultSeverity: 'notice', summary: "An L0 entry is exported to `department`: outside a hosted instance only this project's family sees it, and a path or git consumer is refused" },
  ],
  check(ctx) {
    // Step 1: the tables the validator resolved.
    const tables = ctx.exportTables;
    // Steps 2-3: a candidate run carries none.
    if (!tables) return;
    // Step 4: every problem of every table.
    for (const table of tables) {
      // A member project's table is owned by its mount namespace: the mount
      // subsystem is the spec its findings anchor to.
      const sub = ctx.subsystems.find((s) => s.id === table.owner);
      const draft = sub ? isDraftSubsystem(sub) : false;
      const where = table.level === 'subsystem'
        ? `Subsystem "${table.owner}"`
        : sub ? `The L0 export table of the member project mounted at "${table.owner}"` : `The project's L0 export table`;
      for (const problem of table.problems) {
        const name = problem.publicName ? `"${problem.publicName}"` : 'an entry';
        // Step 5: by the problem's kind.
        switch (problem.kind) {
          case 'duplicate':
            // Steps 6-7.
            ctx.addIssue('error', 'EXPORT_ID_DUPLICATE', `${where} binds ${name} to more than one target (${(problem.targets ?? []).join(', ')}), so the name is left out of the table. Narrow one of the wildcards, or add an explicit entry that picks the target.`, table.owner, draft);
            break;
          case 'named-cycle':
            // Steps 8-9.
            ctx.addIssue('error', 'EXPORT_CYCLE', `${where} ${problem.detail}. Export the item from the level that owns it.`, table.owner, draft);
            break;
          case 'wildcard-cycle':
            // Steps 10-11: resolved to the union, still a circular surface.
            ctx.addIssue('warning', 'EXPORT_CYCLE', `${where}: ${problem.detail}. Re-export in one direction only.`, table.owner, draft);
            break;
          case 'invalid':
            // Steps 12-13.
            ctx.addIssue('error', 'EXPORT_INVALID', `${where} ${problem.detail}.`, table.owner, draft);
            break;
          case 'unconsumable':
            // Steps 14-15.
            ctx.addIssue('error', 'EXPORT_UNCONSUMABLE', `${where}: ${problem.detail}.`, table.owner, draft);
            break;
          case 'widens':
            // Step 16: a re-export can narrow reach, never widen it.
            ctx.addIssue('error', 'EXPORT_WIDENS_AUDIENCE', `${where}: ${problem.detail}. A re-export can narrow reach, never widen it — as \`pub use\` of a \`pub(crate)\` item does not compile. Declare audience ${(problem.targets ?? [])[1] ?? 'instance'} or narrower, or widen the export at its source.`, table.owner, draft);
            break;
        }
        // Step 17: reported.
      }
    }
    // Step 18: an own L0 entry exported to `department` — outside a hosted
    // instance only the family sees it; whether its consumers are hosted
    // cannot be told from this tree, so a notice, never a failure.
    const own = tables.find((t) => t.level === 'project' && t.owner === ctx.system.name);
    for (const entry of own?.entries ?? []) {
      if ((entry.audience ?? 'instance') !== 'department') continue;
      ctx.addIssue(
        'notice',
        'EXPORT_AUDIENCE_NARROW',
        `The project's L0 export table exports "${entry.publicName}" to \`department\`. A path, git or hosted consumer outside this project's family reads it at \`instance\` and is refused it (\`externals add\` says so); only this project's family sees it locally, and, on a hosted instance, the units of the owning department — which of those its consumers are cannot be told from this tree. Audiences, narrowest first: project < department < instance < partner < external. Widen it to \`instance\` if a sibling checkout or a git consumer uses it, or keep it (and allow this notice) when its consumers are hosted department units.`,
        own!.owner,
        false,
        undefined,
        { at: entry.publicName },
      );
    }
    // Step 19: judged.
  },
};
