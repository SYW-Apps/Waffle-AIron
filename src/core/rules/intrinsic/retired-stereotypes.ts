import { SddRule } from '../types.js';
import { isRetired } from '../../../models/index.js';

/**
 * Retired stereotypes: a tree still loads a Specialist or a Gateway, so it can
 * be migrated, and this rule reports each one once until it is. Every rule that
 * judges a stereotype's shape skips a retired component, so this finding is the
 * one a retired component gets. The check reads one component's own
 * componentType and nothing else, so this is `scope: 'spec'`: a retired
 * stereotype is refused at the write boundary too.
 */
export const retiredStereotypesRule: SddRule = {
  name: 'retired-stereotypes',
  scope: 'spec',
  description:
    'A component typed with a retired stereotype is an error until it is migrated (STEREOTYPE_RETIRED). A Specialist becomes an Orchestrator with the dependencyClass its dependencies give it, which `wairon doctor --fix` applies. A Gateway becomes the Portal it owns, with the gateway variant: its other members are depended on rather than owned, its consumers depend on that Portal, and the Gateway spec is deleted, steps the finding lists for the author. Intrinsic to one component: no tree required.',
  codes: [
    { code: 'STEREOTYPE_RETIRED', defaultSeverity: 'error', summary: 'Component typed with a retired stereotype: a Specialist is an Orchestrator with a dependencyClass, a Gateway is a Portal with the gateway variant' },
  ],
  check(ctx) {
    for (const comp of ctx.components) {
      const isDraftCtx = ctx.isComponentDraft(comp.id);
      if (!isRetired(comp)) continue;

      if (comp.componentType === 'Specialist') {
        ctx.addIssue(
          'error',
          'STEREOTYPE_RETIRED',
          `Component "${comp.id}" is typed Specialist, a retired stereotype: it is logic, an Orchestrator with the dependencyClass its dependencies give it. Run \`wairon doctor --fix\` to retype it (the doctor names the class), or set componentType: Orchestrator and its dependencyClass yourself.`,
          comp.id,
          isDraftCtx,
        );
        continue;
      }

      // A Gateway is migrated by hand: its members and consumers are edges in
      // other specs, which only the author can move.
      ctx.addIssue(
        'error',
        'STEREOTYPE_RETIRED',
        `Component "${comp.id}" is typed Gateway, a retired stereotype: a gateway is a Portal with the gateway variant. Migrate it: (1) the Portal it owns becomes the front door, with variant: gateway; (2) its other members become dependencies of that Portal instead of owned members; (3) its consumers depend on that Portal; (4) delete the Gateway spec. sdd_rename_component can then give the Portal the Gateway's id.`,
        comp.id,
        isDraftCtx,
      );
    }
  },
};
