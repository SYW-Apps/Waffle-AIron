import type { PracticeSelection } from './project.js';

/**
 * The agent roles a practice selection may name under `roles`: the built-in
 * agent templates wairon ships (src/templates/<role>.yaml), the templates a
 * brief is composed from.
 */
export const BUILTIN_AGENT_ROLES: readonly string[] = ['architect', 'domain-owner', 'guardian', 'implementer', 'reviewer', 'tester'];

/** Where a piece of work sits: the scopes a practice selection is resolved for. */
export interface PracticeScope {
  subsystem?: string | null;
  component?: string | null;
  role?: string | null;
  session?: readonly string[];
}

/**
 * practice_selection.resolve — the practice ids in force for a scope: start
 * empty, then apply the entries of `use`, the subsystem's, the component's, the
 * role's and the session's, in that order. An id adds itself once (its first
 * position kept); `!<id>` removes it. Pure.
 */
export function resolvePractices(selection: PracticeSelection | undefined, scope: PracticeScope = {}): string[] {
  const layers: (readonly string[] | undefined)[] = [
    selection?.use,
    scope.subsystem ? selection?.subsystems?.[scope.subsystem] : undefined,
    scope.component ? selection?.components?.[scope.component] : undefined,
    scope.role ? selection?.roles?.[scope.role] : undefined,
    scope.session,
  ];
  const inForce: string[] = [];
  for (const entries of layers) {
    for (const entry of entries ?? []) {
      if (entry.startsWith('!')) {
        const at = inForce.indexOf(entry.slice(1));
        if (at >= 0) inForce.splice(at, 1);
      } else if (!inForce.includes(entry)) {
        inForce.push(entry);
      }
    }
  }
  return inForce;
}

/** The id an entry names: a `!<id>` drop names `<id>`. */
export function practiceIdOf(entry: string): string {
  return entry.startsWith('!') ? entry.slice(1) : entry;
}

/**
 * The guidance of each practice in force that a loaded pack declares, each
 * under its attributed heading, in resolved order — or null when none applies.
 * An id no pack declares is skipped: validation reports it (UNKNOWN_PRACTICE).
 */
export function practiceSections(
  ids: readonly string[],
  practices: readonly { id: string; guidance: string; pack: string }[],
): string | null {
  const sections: string[] = [];
  for (const id of ids) {
    const practice = practices.find((p) => p.id === id);
    if (practice) sections.push(`## Practice "${practice.id}" (pack "${practice.pack}")\n\n${practice.guidance.trim()}`);
  }
  return sections.length > 0 ? sections.join('\n\n') : null;
}
