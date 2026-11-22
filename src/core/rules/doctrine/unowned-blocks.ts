import { SddRule } from '../types.js';
import { maintainedRegistries } from './entrypoint-dependencies.js';

/**
 * The data blocks that stand outside every pattern. A Store standing alone is
 * the default shape and raises nothing (UNOWNED_STORE is retired); a Registry
 * with no Store to write to and a Query with no Repository to read over may
 * not — each is either mistyped or orphaned.
 */
export const unownedBlocksRule: SddRule = {
  name: 'unowned-blocks',
  judges: 'design',
  description:
    'Judges the data blocks no owner (a pattern, or a Supervisor keeping its supervision state) owns. A Store standing alone is the default shape for state with no lookup needs and raises nothing (UNOWNED_STORE, which once warned about it, is retired): a Repository earns its place only when Indexes, Queries or a backend Adapter are worth keeping private behind one facade. What must never happen is folding the state into a consuming component, where no spec, diagram or conformance check can see it again. A Registry standing alone with no Store to write to is either mistyped (the "file-backed Registry" idiom, a fused persistent store that belongs typed Store) or orphaned — unless a Supervisor maintains it through lifecycle-effect calls: then it is that Supervisor\'s directory of live handles, which holds the handles itself and writes to no Store — or unless it is an abstraction (abstract): an abstract Registry holds a contract and no state, and each implementing Registry wires its own Store. A Query has no standalone form at all: it computes reads over its own Repository\'s Store.',
  retiredCodes: ['UNOWNED_STORE'],
  codes: [
    { code: 'REGISTRY_WITHOUT_STORE', defaultSeverity: 'warning', summary: 'Standalone Registry with no Store to write to — either mistyped (a fused file-backed store belongs typed Store) or orphaned; a Supervisor\'s directory of live handles excepted' },
    { code: 'UNOWNED_QUERY', defaultSeverity: 'error', summary: 'Query not owned by a Repository — a Query computes reads over its own Repository\'s Store' },
  ],
  check(ctx) {
    // The tree's ONE ownership reading: which pattern privately owns each
    // member block, and therefore which blocks stand alone. A retired
    // component is never one of these three stereotypes, so no skip is needed.
    const ownership = ctx.ownershipIndex();
    // The Registries a Supervisor keeps through lifecycle-effect calls: its
    // directory of live handles, shared with the components that look its
    // Actors up there. It holds the handles itself and writes to no Store.
    const handleDirectories = new Set([...maintainedRegistries(ctx).values()].flat());

    for (const comp of ctx.components) {
      if (ownership.ownedMembers.has(comp.id)) continue;
      const isDraftCtx = ctx.isComponentDraft(comp.id);

      // The symmetric tripwire: a Registry is by definition the WRITE PATH to a
      // Store. Standalone with no Store dependency it is either mistyped (the
      // "file-backed Registry" idiom — a fused persistent store that belongs
      // typed Store, where the durability machinery can see it) or orphaned.
      // Repository-owned Registries reach their Store as a sibling member and
      // are exempt from the dependency requirement.
      if (comp.componentType === 'Registry' && comp.abstract !== true && !handleDirectories.has(comp.id)
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
