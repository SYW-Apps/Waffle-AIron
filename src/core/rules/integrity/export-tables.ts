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
  description:
    'Every level\'s export table must resolve the way a module resolver resolves `export … from`: one public name binds one target (EXPORT_ID_DUPLICATE when two wildcards — or two explicit entries — bind a name to different targets; the name is left out), no chain leads back to itself (EXPORT_CYCLE — an error for a named chain that never reaches a component or type, a warning for a wildcard cycle, which resolves to its union), every entry names a source and an item that exist, that the source exports and, for an own type, that the level owns, under a public name of [a-z0-9-_]+ (EXPORT_INVALID), and every re-exported component can serve a boundary caller — a Portal, a gateway being a Portal variant, or an Observer for events (EXPORT_UNCONSUMABLE, at L0 and for L1 re-exports). The rule judges the facts the export resolver gathered and resolves nothing itself.',
  codes: [
    { code: 'EXPORT_ID_DUPLICATE', defaultSeverity: 'error', summary: 'One public name bound to different targets by two wildcard re-exports or two explicit entries' },
    { code: 'EXPORT_CYCLE', defaultSeverity: 'error', summary: 'A re-export chain leads back to itself (a warning for a wildcard cycle, which resolves to its union)' },
    { code: 'EXPORT_INVALID', defaultSeverity: 'notice', summary: 'An export entry names a missing source or item, an item its source does not export or its level does not own, or a malformed public name' },
    { code: 'EXPORT_UNCONSUMABLE', defaultSeverity: 'notice', summary: 'An exported component no boundary caller may reach: neither a Portal nor an Observer' },
  ],
  check(ctx) {
    // Step 1: the tables the validator resolved.
    const tables = ctx.exportTables;
    // Steps 2-3: a candidate run carries none.
    if (!tables) return;
    // Step 4: every problem of every table.
    for (const table of tables) {
      const sub = table.level === 'subsystem' ? ctx.subsystems.find((s) => s.id === table.owner) : undefined;
      const draft = sub ? isDraftSubsystem(sub) : false;
      const where = table.level === 'subsystem' ? `Subsystem "${table.owner}"` : `The project's L0 export table`;
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
            ctx.addIssue('notice', 'EXPORT_INVALID', `${where} ${problem.detail}.`, table.owner, draft);
            break;
          case 'unconsumable':
            // Step 14.
            ctx.addIssue('notice', 'EXPORT_UNCONSUMABLE', `${where}: ${problem.detail}.`, table.owner, draft);
            break;
        }
        // Step 15: reported.
      }
    }
    // Step 16: judged.
  },
};
