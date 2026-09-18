import { SddRule } from '../types.js';
import { isRetired } from '../../../models/index.js';

/**
 * Private members stay private. A component may depend on a block inside its
 * OWN group — it is the owning pattern, or a sibling member of the same
 * pattern — on any pattern facade, or on a standalone block; never on a block
 * another pattern privately owns.
 *
 * This rule judges the dependency id as AUTHORED: an id no pattern owns is
 * nobody's private member, whether it names a facade, a standalone block or
 * nothing at all. It therefore reads dependsOn directly rather than the
 * resolved dependency edges — resolution, reach and pack licensing decide
 * nothing here.
 */
export const memberVisibilityRule: SddRule = {
  name: 'member-visibility',
  description:
    'A component may depend on a block within its own group (it is the owning pattern, or a sibling member of the same pattern), on any pattern facade, or on a standalone block — never on a block privately owned by ANOTHER pattern, which must be reached through that pattern\'s facade. A retired depending component is skipped, as everywhere in this family.',
  codes: [
    { code: 'VISIBILITY_VIOLATION', defaultSeverity: 'error', summary: 'Dependency on a block privately owned by another pattern' },
  ],
  check(ctx) {
    const ownership = ctx.ownershipIndex();
    for (const comp of ctx.components) {
      if (isRetired(comp)) continue;
      for (const depId of comp.dependsOn) {
        const owner = ownership.ownerOf(depId);
        if (!owner) continue;                                  // dep is a facade or standalone block — fine
        if (owner === comp.id) continue;                       // the owning pattern depending on its own member — fine
        if (ownership.ownerOf(comp.id) === owner) continue;    // a sibling member of the same group — fine
        ctx.addIssue('error', 'VISIBILITY_VIOLATION', `Component "${comp.id}" depends on "${depId}", which is privately owned by pattern "${owner}". Depend on the facade "${owner}" instead.`, comp.id, ctx.isComponentDraft(comp.id) || ctx.isComponentDraft(depId));
      }
    }
  },
};
