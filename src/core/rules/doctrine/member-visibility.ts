import { SddRule, type OwnershipIndex, type RuleContext } from '../types.js';
import { type ComponentSpec } from '../../../models/index.js';
import type { EdgeFinding } from './stereotype-terms.js';

/**
 * Private members stay private. A component may depend on a block inside its
 * OWN group — it is the owner, or a sibling member of the same owner — on any
 * pattern facade, or on a standalone block; never on a block another pattern
 * privately owns. A Store or Registry a Supervisor owns is its supervision
 * state: nobody else depends on it, and one that does is the intruder.
 *
 * This rule judges the dependency id as AUTHORED: an id nobody owns is
 * nobody's private member, whether it names a facade, a standalone block or
 * nothing at all. It therefore reads dependsOn directly rather than the
 * resolved dependency edges — resolution, reach and pack licensing decide
 * nothing here.
 */
export const memberVisibilityRule: SddRule = {
  name: 'member-visibility',
  judges: 'design',
  description:
    'A component may depend on a block within its own group (it is the owner, or a sibling member of the same owner), on any pattern facade, or on a standalone block — never on a block privately owned by ANOTHER pattern, which must be reached through that pattern\'s facade. A Store or Registry a Supervisor owns is that Supervisor\'s supervision state and nobody else depends on it: a component that does is the intruder, and the finding is reported on it, naming the Supervisor and the state. A retired depending component is skipped, as everywhere in this family.',
  codes: [
    { code: 'VISIBILITY_VIOLATION', defaultSeverity: 'error', summary: 'Dependency on a block privately owned by another pattern' },
    { code: 'SUPERVISION_STATE_INTRUSION', defaultSeverity: 'error', summary: 'Dependency on a Store or Registry a Supervisor owns as its supervision state — reported on the intruder, naming the Supervisor and the state' },
  ],
  check(ctx) {
    const ownership = ctx.ownershipIndex();
    for (const comp of ctx.components) {
      for (const depId of comp.dependsOn) {
        const finding = visibilityEdgeFinding(ctx, ownership, comp, depId);
        if (!finding) continue;
        ctx.addIssue(finding.severity, finding.code, finding.message, comp.id, ctx.isComponentDraft(comp.id) || ctx.isComponentDraft(depId));
      }
    }
  },
};

/**
 * What this rule reports on one dependency id of `comp`, judged against the
 * tree's ownership: nothing for a facade, a standalone block, the owner's own
 * member or a sibling's. The rule reports it on every dependsOn id;
 * directEdgeRefusals asks the same question of an edge a forwarder's caller
 * would need.
 */
export function visibilityEdgeFinding(
  ctx: RuleContext,
  ownership: OwnershipIndex,
  comp: ComponentSpec,
  depId: string,
): EdgeFinding | undefined {
  const owner = ownership.ownerOf(depId);
  if (!owner) return undefined;                               // dep is a facade or standalone block — fine
  if (owner === comp.id) return undefined;                    // the owning pattern depending on its own member — fine
  if (ownership.ownerOf(comp.id) === owner) return undefined; // a sibling member of the same group — fine
  // A Supervisor's supervision state is private to it: the dependant is
  // the intruder, and the finding is reported on it.
  if (ctx.componentMap.get(owner)?.componentType === 'Supervisor') {
    return { severity: 'error', code: 'SUPERVISION_STATE_INTRUSION', message: `"${comp.id}" depends on "${depId}", which Supervisor "${owner}" owns as its supervision state. Supervision state is private to its Supervisor — nobody else depends on it. If "${comp.id}" needs this data it is shared data: move "${depId}" out of "${owner}"'s owns into a data component both depend on (the Supervisor keeping it through read and lifecycle calls), or reach what "${comp.id}" needs through "${owner}".` };
  }
  // A shared Adapter is owned by mistake, not private on purpose: the facade
  // cannot stand in for generic I/O, so the remedy is SHARED_ADAPTER_OWNED's.
  if ([...ctx.sharedSet.values()].some(ids => ids.has(depId))) {
    return { severity: 'error', code: 'VISIBILITY_VIOLATION', message: `Component "${comp.id}" depends on "${depId}", which pattern "${owner}" owns — but "${depId}" is published as a shared Adapter, which no pattern may own (SHARED_ADAPTER_OWNED). Take it out of "${owner}"'s owns; "${comp.id}" may then depend on it directly.` };
  }
  return { severity: 'error', code: 'VISIBILITY_VIOLATION', message: `Component "${comp.id}" depends on "${depId}", which is privately owned by pattern "${owner}". Depend on the facade "${owner}" instead.` };
}
