import { SddRule } from '../types.js';
import { isRetired } from '../../../models/index.js';

/** What a Repository may own: its Store, the Registry that writes it, its read faces, and optionally the Adapter serving it. */
const REPOSITORY_MEMBERS: ReadonlySet<string> = new Set(['Store', 'Registry', 'Index', 'Query', 'Adapter']);

/**
 * What each pattern must contain. A Repository is judged member by member; a
 * FeatureComponent and a RouterComponent are judged by counting, because their
 * shape is about how many of each face they have. Who may own at all, and
 * whether a claim resolves, is pattern-membership's question.
 */
export const patternContainmentRule: SddRule = {
  name: 'pattern-containment',
  description:
    'Holds each pattern to the containment its definition prescribes. A Repository may own only Store, Registry, Index, Query and (optionally) Adapter, judged member by member. A FeatureComponent owns exactly one Orchestrator (the logic side) and one or more Views (its faces — list, detail, form — sharing the one logic component), and nothing else. A RouterComponent owns exactly one Portal as its facade and at least one other child to route to. A counting pattern that still owns a retired member is not judged until that member is migrated: its counts change with the migration, and STEREOTYPE_RETIRED is the one finding.',
  codes: [
    { code: 'REPOSITORY_CONTAINMENT', defaultSeverity: 'error', summary: 'Repository owning a non Store/Registry/Index/Query/Adapter member' },
    { code: 'FEATURE_COMPONENT_CONTAINMENT', defaultSeverity: 'error', summary: 'FeatureComponent not owning exactly one Orchestrator + one or more Views' },
    { code: 'ROUTER_COMPONENT_CONTAINMENT', defaultSeverity: 'error', summary: 'RouterComponent not owning exactly one Portal facade, or owning no children to route to' },
  ],
  check(ctx) {
    // 1. Repository containment, member by member: a retired member is skipped
    //    (its STEREOTYPE_RETIRED is its one finding), a live member's mistake
    //    still reports. A retired Repository is skipped entirely, as
    //    everywhere in this family.
    for (const comp of ctx.components) {
      if (comp.componentType !== 'Repository' || isRetired(comp)) continue;
      const isDraftCtx = ctx.isComponentDraft(comp.id);
      for (const memberId of comp.owns) {
        const member = ctx.componentMap.get(memberId);
        if (!member || isRetired(member) || REPOSITORY_MEMBERS.has(member.componentType)) continue;
        ctx.addIssue('error', 'REPOSITORY_CONTAINMENT', `Repository "${comp.id}" owns "${memberId}" of type ${member.componentType}; a Repository may own only Store, Registry, Index, Query, and (optionally) Adapter.`, comp.id, isDraftCtx);
      }
    }

    // 2. The counting patterns. A FeatureComponent or RouterComponent owning a
    //    retired member is not judged for containment until that member is
    //    migrated: its member counts change with the migration, and the
    //    member's STEREOTYPE_RETIRED is the one finding.
    for (const comp of ctx.components) {
      if (comp.componentType !== 'FeatureComponent' && comp.componentType !== 'RouterComponent') continue;
      if (isRetired(comp)) continue;
      if (comp.owns.some(memberId => {
        const member = ctx.componentMap.get(memberId);
        return member !== undefined && isRetired(member);
      })) continue;
      const isDraftCtx = ctx.isComponentDraft(comp.id);

      // FeatureComponent containment: exactly one Orchestrator and one or
      // more Views — a feature slice often has several faces (list, detail,
      // form) sharing the one logic component. A second Orchestrator is a
      // second feature; anything else does not belong inside the slice.
      if (comp.componentType === 'FeatureComponent') {
        let orchestrators = 0;
        let views = 0;
        let others = 0;
        for (const memberId of comp.owns) {
          const t = ctx.componentMap.get(memberId)?.componentType;
          if (t === 'Orchestrator') orchestrators++;
          else if (t === 'View') views++;
          else if (t) others++;
        }
        if (orchestrators !== 1 || views < 1 || others > 0) {
          ctx.addIssue('error', 'FEATURE_COMPONENT_CONTAINMENT', `FeatureComponent "${comp.id}" must own exactly one Orchestrator (logic side) and one or more Views (UI faces) — no other member types.`, comp.id, isDraftCtx);
        }
      }

      // RouterComponent containment: exactly one Portal facade (a pattern
      // exposes one facade; a second Portal is a second front door) and at
      // least one other child component/View to route to.
      if (comp.componentType === 'RouterComponent') {
        let portals = 0;
        let hasChildren = false;
        for (const memberId of comp.owns) {
          const t = ctx.componentMap.get(memberId)?.componentType;
          if (t === 'Portal') portals++;
          else if (t) hasChildren = true;
        }
        if (portals !== 1) {
          ctx.addIssue('error', 'ROUTER_COMPONENT_CONTAINMENT', `RouterComponent "${comp.id}" must own exactly one Portal component to act as its facade.`, comp.id, isDraftCtx);
        }
        if (!hasChildren) {
          ctx.addIssue('error', 'ROUTER_COMPONENT_CONTAINMENT', `RouterComponent "${comp.id}" must own at least one child component/View to route to.`, comp.id, isDraftCtx);
        }
      }
    }
  },
};
