import { SddRule } from '../types.js';
import { practiceIdOf } from '../../../models/practices.js';

/**
 * Resolves the project's practice selection (project.yaml `practices`). Every
 * practice it names, with or without a leading `!`, must be declared by a
 * loaded pack (UNKNOWN_PRACTICE), and every scope key must name something that
 * exists: a subsystem or component of this tree, or a built-in agent role
 * (UNKNOWN_PRACTICE_SCOPE). A selection naming nothing real would otherwise do
 * nothing, silently.
 */
export const practiceReferencesRule: SddRule = {
  name: 'practice-references',
  judges: 'design',
  description:
    "Every practice the project's selection names (with or without a leading `!`) is declared by a loaded pack (UNKNOWN_PRACTICE), and every scope key names something that exists — a subsystem or component of this tree, or a known agent role (UNKNOWN_PRACTICE_SCOPE). A selection that names nothing real would otherwise do nothing, silently.",
  codes: [
    { code: 'UNKNOWN_PRACTICE', defaultSeverity: 'warning', summary: 'The practice selection names a practice no loaded pack declares' },
    { code: 'UNKNOWN_PRACTICE_SCOPE', defaultSeverity: 'warning', summary: 'The practice selection names a subsystem, component or role that does not exist' },
  ],
  check(ctx) {
    // Steps 1-2: nothing selected, nothing to check.
    const selection = ctx.practiceSelection;
    if (!selection) return;

    // Step 3: what may be named.
    const declared = ctx.ext.practices.map((p) => p.id);
    const subsystems = new Set(ctx.subsystems.map((s) => s.id));
    const components = new Set(ctx.components.map((c) => c.id));
    const roles = new Set(ctx.knownRoles);
    const offered = declared.length > 0
      ? `The loaded packs declare: ${declared.join(', ')}.`
      : 'No loaded pack declares any practice.';

    const checkEntries = (where: string, entries: readonly string[] | undefined): void => {
      for (const entry of entries ?? []) {
        // Steps 6-7: the entry names a declared practice.
        if (declared.includes(practiceIdOf(entry))) continue;
        ctx.addIssue(
          'warning',
          'UNKNOWN_PRACTICE',
          `The practice selection in .wai/project.yaml (${where}) names practice "${practiceIdOf(entry)}", which no loaded extension pack declares. ${offered}`,
        );
      }
    };

    // Steps 4-8: every scope, every key, every entry.
    checkEntries('practices.use', selection.use);
    const scopes: [string, Record<string, string[]> | undefined, Set<string>, string][] = [
      ['subsystems', selection.subsystems, subsystems, 'subsystem'],
      ['components', selection.components, components, 'component'],
      ['roles', selection.roles, roles, 'agent role'],
    ];
    for (const [scope, keyed, known, kind] of scopes) {
      for (const [key, entries] of Object.entries(keyed ?? {})) {
        if (!known.has(key)) {
          const may = kind === 'agent role' ? ` A role is one of: ${[...roles].join(', ')}.` : '';
          ctx.addIssue(
            'warning',
            'UNKNOWN_PRACTICE_SCOPE',
            `The practice selection in .wai/project.yaml names ${kind} "${key}" under practices.${scope}, which does not exist, so its practices apply nowhere.${may}`,
          );
        }
        checkEntries(`practices.${scope}.${key}`, entries);
      }
    }
  },
};
