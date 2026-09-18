import { SddRule } from '../types.js';
import { PATTERN_TYPES, isPattern, isRetired } from '../../../models/index.js';

/**
 * Pattern ownership: only patterns own member blocks (exactly one hop, one
 * owner), containment matches the pattern's definition, and nobody reaches a
 * block privately owned by another pattern.
 */
export const patternsRule: SddRule = {
  name: 'pattern-ownership',
  description:
    'Patterns (Repository/FeatureComponent/RouterComponent) own member blocks with the containment their definition prescribes; blocks own nothing; a member has exactly one owner; and private members are reachable only via their facade or siblings.',
  codes: [
    { code: 'EMPTY_PATTERN', defaultSeverity: 'error', summary: 'Pattern with no owned member blocks' },
    { code: 'BLOCK_OWNS_MEMBERS', defaultSeverity: 'error', summary: 'Building block using owns' },
    { code: 'INVALID_OWNED_MEMBER', defaultSeverity: 'error', summary: 'owns names a non-existent component' },
    { code: 'PATTERN_OWNS_PATTERN', defaultSeverity: 'error', summary: 'Pattern owning another pattern' },
    { code: 'SHARED_OWNED_MEMBER', defaultSeverity: 'error', summary: 'Block owned by two patterns' },
    { code: 'REPOSITORY_CONTAINMENT', defaultSeverity: 'error', summary: 'Repository owning a non Store/Registry/Index/Query/Adapter member' },
    { code: 'FEATURE_COMPONENT_CONTAINMENT', defaultSeverity: 'error', summary: 'FeatureComponent not owning exactly one Orchestrator + one or more Views' },
    { code: 'ROUTER_COMPONENT_CONTAINMENT', defaultSeverity: 'error', summary: 'RouterComponent not owning exactly one Portal facade, or owning no children to route to' },
    { code: 'VISIBILITY_VIOLATION', defaultSeverity: 'error', summary: 'Dependency on a block privately owned by another pattern' },
    { code: 'UNOWNED_STORE', defaultSeverity: 'warning', summary: 'Store not owned by any pattern — recommended shape is a Repository; a deliberate standalone Store needs a lint.allow' },
    { code: 'REGISTRY_WITHOUT_STORE', defaultSeverity: 'warning', summary: 'Standalone Registry with no Store to write to — either mistyped (a fused file-backed store belongs typed Store) or orphaned' },
    { code: 'UNOWNED_QUERY', defaultSeverity: 'error', summary: 'Query not owned by a Repository — a Query computes reads over its own Repository\'s Store' },
  ],
  check(ctx) {
    // The tree's ONE ownership reading, shared with every rule that needs it:
    // which pattern privately owns each member block, with the skips that
    // decide findings (a retired or block claimant records nothing, so does an
    // unresolved member or an inner pattern, and the first claimant wins)
    // stated once in read-model.ts instead of rebuilt here.
    const ownership = ctx.ownershipIndex();
    for (const comp of ctx.components) {
      // A retired component (a Specialist or Gateway) is skipped entirely: it
      // records no ownership and gets no pattern or containment finding —
      // retired-stereotypes reports it once, and its migration decides what its
      // owns becomes.
      if (isRetired(comp)) continue;
      const isDraftCtx = ctx.isComponentDraft(comp.id);
      const pattern = isPattern(comp);

      if (pattern && comp.owns.length === 0) {
        ctx.addIssue('error', 'EMPTY_PATTERN', `Pattern "${comp.id}" (${comp.componentType}) must own member blocks via "owns".`, comp.id, isDraftCtx);
      }
      if (!pattern && comp.owns.length > 0) {
        ctx.addIssue('error', 'BLOCK_OWNS_MEMBERS', `Building block "${comp.id}" (${comp.componentType}) cannot own members; only patterns (${Array.from(PATTERN_TYPES).join('/')}) use "owns".`, comp.id, isDraftCtx);
      }

      for (const memberId of comp.owns) {
        const member = ctx.componentMap.get(memberId);
        if (!member) {
          ctx.addIssue('error', 'INVALID_OWNED_MEMBER', `Component "${comp.id}" owns "${memberId}" which does not exist.`, comp.id, isDraftCtx);
          continue;
        }
        // A building block's owns is wholly the BLOCK_OWNS_MEMBERS finding
        // above: the block records no owner, so a Store or Registry it claims
        // stays standalone for UNOWNED_STORE / REGISTRY_WITHOUT_STORE, and its
        // dependants are judged as if the claim were absent.
        if (!pattern) continue;
        if (isPattern(member)) {
          ctx.addIssue('error', 'PATTERN_OWNS_PATTERN', `Pattern "${comp.id}" owns "${memberId}", which is itself a pattern. Patterns own only building blocks — compose patterns at the subsystem (L1) level.`, comp.id, isDraftCtx);
          // The inner pattern gets no owner: it is composed at L1, so its
          // dependants get no VISIBILITY_VIOLATION on top of this finding.
          continue;
        }
        // The first pattern to claim a member stays its owner, so every later
        // claimant is reported against that first owner.
        const firstOwner = ownership.ownerOf(memberId);
        if (firstOwner && firstOwner !== comp.id) {
          ctx.addIssue('error', 'SHARED_OWNED_MEMBER', `Block "${memberId}" is owned by both "${firstOwner}" and "${comp.id}"; a block has exactly one owner.`, comp.id, isDraftCtx);
        }
      }

      // A FeatureComponent or RouterComponent owning a retired member is not
      // judged for containment until that member is migrated: its member counts
      // change with the migration, and the member's STEREOTYPE_RETIRED is the one
      // finding. Ownership, sharing and visibility above and below still apply.
      if ((comp.componentType === 'FeatureComponent' || comp.componentType === 'RouterComponent')
        && comp.owns.some(memberId => {
          const member = ctx.componentMap.get(memberId);
          return member !== undefined && isRetired(member);
        })) {
        continue;
      }

      // Repository containment: only Store / Registry / Index / Query / Adapter.
      // Each member is judged on its own: a retired member is skipped (its
      // STEREOTYPE_RETIRED is its one finding), a live member's mistake still reports.
      if (comp.componentType === 'Repository') {
        const allowed = new Set(['Store', 'Registry', 'Index', 'Query', 'Adapter']);
        for (const memberId of comp.owns) {
          const member = ctx.componentMap.get(memberId);
          if (!member || isRetired(member) || allowed.has(member.componentType)) continue;
          ctx.addIssue('error', 'REPOSITORY_CONTAINMENT', `Repository "${comp.id}" owns "${memberId}" of type ${member.componentType}; a Repository may own only Store, Registry, Index, Query, and (optionally) Adapter.`, comp.id, isDraftCtx);
        }
      }

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

    // A Store is held state. The RECOMMENDED shape is a Repository (Store +
    // Registry + Index behind one facade); a deliberately standalone Store is
    // the sanctioned LIGHTWEIGHT form for genuinely simple state — visible to
    // the spec, reachable from the workflow layer, acknowledged via
    // lint.allow. What must never happen is the third path: an implementer
    // "solving" a refused link by folding the state into the consumer, where
    // no spec, diagram, or conformance check can ever see it again.
    for (const comp of ctx.components) {
      if (comp.componentType !== 'Store' || ownership.ownedMembers.has(comp.id)) continue;
      ctx.addIssue(
        'warning',
        'UNOWNED_STORE',
        `Store "${comp.id}" is not owned by any pattern. The recommended shape for held state is a Repository (owns: ["${comp.id}", its Registry, its Index]) with consumers on the facade. For genuinely simple state a deliberately standalone Store is the sanctioned lightweight form — keep it visible as this Store, reachable from the workflow layer (Orchestrator/Supervisor/Actor), and acknowledge it with a lint.allow reason. Never take the third path of merging the state into a consuming component: state hidden inside a logic block disappears from the architecture permanently.`,
        comp.id,
        ctx.isComponentDraft(comp.id),
      );
    }

    // The symmetric tripwire: a Registry is by definition the WRITE PATH to a
    // Store. Standalone with no Store dependency it is either mistyped (the
    // "file-backed Registry" idiom — a fused persistent store that belongs
    // typed Store, where the durability machinery can see it) or orphaned.
    // Repository-owned Registries reach their Store as a sibling member and
    // are exempt from the dependency requirement.
    for (const comp of ctx.components) {
      if (comp.componentType !== 'Registry' || ownership.ownedMembers.has(comp.id)) continue;
      const hasStoreDep = comp.dependsOn.some(depId => ctx.componentMap.get(depId)?.componentType === 'Store');
      if (hasStoreDep) continue;
      ctx.addIssue(
        'warning',
        'REGISTRY_WITHOUT_STORE',
        `Registry "${comp.id}" stands alone with no Store to write to. A Registry is the write path to a Store — if this component itself holds the persisted state (a file-backed record/config store), retype it as a Store with the honest durability (read-through for no-RAM-copy file I/O) so the durability machinery can see it; otherwise wire its Store, or lint.allow with a reason.`,
        comp.id,
        ctx.isComponentDraft(comp.id),
      );
    }

    // A Query is a computed read over its own Repository's Store, so it has no
    // standalone form. A Query another pattern owns is that pattern's
    // containment finding, not this one.
    for (const comp of ctx.components) {
      if (comp.componentType !== 'Query' || ownership.ownedMembers.has(comp.id)) continue;
      ctx.addIssue(
        'error',
        'UNOWNED_QUERY',
        `Query "${comp.id}" is not owned by any pattern. A Query computes reads over its own Repository's Store — make it a member of the Repository whose Store it reads (owns: ["${comp.id}", …]).`,
        comp.id,
        ctx.isComponentDraft(comp.id),
      );
    }

    // Visibility rule: a component may depend on (a) blocks within its OWN group
    // (it is the owning pattern, or a sibling member of the same pattern), (b) any
    // pattern facade, or (c) a standalone block — never on a block privately owned by
    // ANOTHER pattern. A retired depending component is skipped, as above.
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
