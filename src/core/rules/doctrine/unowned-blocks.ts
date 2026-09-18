import { SddRule } from '../types.js';

/**
 * The data blocks that stand outside every pattern. A Store may do so
 * deliberately; a Registry with no Store to write to and a Query with no
 * Repository to read over may not — each is either mistyped or orphaned.
 */
export const unownedBlocksRule: SddRule = {
  name: 'unowned-blocks',
  description:
    'Judges the data blocks no pattern owns. A Store may stand alone deliberately — the sanctioned lightweight form for genuinely simple state, acknowledged with a lint.allow — while the recommended shape stays a Repository; what must never happen is folding the state into a consuming component, where no spec, diagram or conformance check can see it again. A Registry standing alone with no Store to write to is either mistyped (the "file-backed Registry" idiom, a fused persistent store that belongs typed Store) or orphaned. A Query has no standalone form at all: it computes reads over its own Repository\'s Store.',
  codes: [
    { code: 'UNOWNED_STORE', defaultSeverity: 'warning', summary: 'Store not owned by any pattern — recommended shape is a Repository; a deliberate standalone Store needs a lint.allow' },
    { code: 'REGISTRY_WITHOUT_STORE', defaultSeverity: 'warning', summary: 'Standalone Registry with no Store to write to — either mistyped (a fused file-backed store belongs typed Store) or orphaned' },
    { code: 'UNOWNED_QUERY', defaultSeverity: 'error', summary: 'Query not owned by a Repository — a Query computes reads over its own Repository\'s Store' },
  ],
  check(ctx) {
    // The tree's ONE ownership reading: which pattern privately owns each
    // member block, and therefore which blocks stand alone. A retired
    // component is never one of these three stereotypes, so no skip is needed.
    const ownership = ctx.ownershipIndex();

    for (const comp of ctx.components) {
      if (ownership.ownedMembers.has(comp.id)) continue;
      const isDraftCtx = ctx.isComponentDraft(comp.id);

      // A Store is held state. The RECOMMENDED shape is a Repository (Store +
      // Registry + Index behind one facade); a deliberately standalone Store is
      // the sanctioned LIGHTWEIGHT form for genuinely simple state — visible to
      // the spec, reachable from the workflow layer, acknowledged via
      // lint.allow. What must never happen is the third path: an implementer
      // "solving" a refused link by folding the state into the consumer, where
      // no spec, diagram, or conformance check can ever see it again.
      if (comp.componentType === 'Store') {
        ctx.addIssue(
          'warning',
          'UNOWNED_STORE',
          `Store "${comp.id}" is not owned by any pattern. The recommended shape for held state is a Repository (owns: ["${comp.id}", its Registry, its Index]) with consumers on the facade. For genuinely simple state a deliberately standalone Store is the sanctioned lightweight form — keep it visible as this Store, reachable from the workflow layer (Orchestrator/Supervisor/Actor), and acknowledge it with a lint.allow reason. Never take the third path of merging the state into a consuming component: state hidden inside a logic block disappears from the architecture permanently.`,
          comp.id,
          isDraftCtx,
        );
      }

      // The symmetric tripwire: a Registry is by definition the WRITE PATH to a
      // Store. Standalone with no Store dependency it is either mistyped (the
      // "file-backed Registry" idiom — a fused persistent store that belongs
      // typed Store, where the durability machinery can see it) or orphaned.
      // Repository-owned Registries reach their Store as a sibling member and
      // are exempt from the dependency requirement.
      if (comp.componentType === 'Registry'
        && !comp.dependsOn.some(depId => ctx.componentMap.get(depId)?.componentType === 'Store')) {
        ctx.addIssue(
          'warning',
          'REGISTRY_WITHOUT_STORE',
          `Registry "${comp.id}" stands alone with no Store to write to. A Registry is the write path to a Store — if this component itself holds the persisted state (a file-backed record/config store), retype it as a Store with the honest durability (read-through for no-RAM-copy file I/O) so the durability machinery can see it; otherwise wire its Store, or lint.allow with a reason.`,
          comp.id,
          isDraftCtx,
        );
      }

      // A Query is a computed read over its own Repository's Store, so it has no
      // standalone form. A Query another pattern owns is that pattern's
      // containment finding, not this one.
      if (comp.componentType === 'Query') {
        ctx.addIssue(
          'error',
          'UNOWNED_QUERY',
          `Query "${comp.id}" is not owned by any pattern. A Query computes reads over its own Repository's Store — make it a member of the Repository whose Store it reads (owns: ["${comp.id}", …]).`,
          comp.id,
          isDraftCtx,
        );
      }
    }
  },
};
