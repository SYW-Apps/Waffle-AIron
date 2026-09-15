import { SddRule } from '../types.js';
import { walk, type WalkSeed } from '../narrative-graph-projector.js';

// ---------------------------------------------------------------------------
// Durability round-trip — a durable Store's externally-persisted writes must
// have a hydration read-back reachable from a declared lifecycle init flow.
// Every method was individually valid in the historic bug; the missing thing
// was this EDGE (no boot read-back into the RAM projection).
// ---------------------------------------------------------------------------

export const durabilityRule: SddRule = {
  name: 'durability-round-trip',
  description:
    'A durable Store (persisted RAM projection) must carry effect-tagged contract methods, and its writes require a hydration read-back reachable from a lifecycle init entrypoint. read-through is exempt (every read IS the read-back), as are ram-projection (rebuilt not restored) and cache (evictable, loss-safe). The flagship semantic check is opt-out by declaration, never silently absent — the declaration itself is enforced by durability-declaration.',
  codes: [
    { code: 'MISSING_EFFECT_TAG', defaultSeverity: 'warning', summary: 'Durable Store contract method lacks an effect: read | write tag' },
    { code: 'MISSING_HYDRATION', defaultSeverity: 'error', summary: 'Durable Store is written but no read-back is reachable from any lifecycle init entrypoint' },
  ],
  check(ctx) {
    // Reachability from lifecycle INIT flows only — the boot graph.
    const initSeeds: WalkSeed[] = [];
    for (const sub of ctx.subsystems) {
      for (const le of sub.lifecycle ?? []) {
        if (le.phase === 'init' && ctx.componentMap.has(le.component)) {
          initSeeds.push({ compId: le.component, methodName: le.method });
        }
      }
    }
    // followDispatchTables: false — at boot only edges the init narratives
    // actually TAKE count; a hydrating read merely offered in a reached
    // portal's table is not a boot-time read (explicit dispatch steps in the
    // init flow are still followed). followRegisterEdges: false for the same
    // reason — registering a callback at init hands it to the runtime for
    // LATER; it is not a boot-time execution of the hydrating read.
    const initReach = initSeeds.length ? walk(ctx, initSeeds, { followDispatchTables: false, followRegisterEdges: false }) : null;

    for (const comp of ctx.components) {
      const isDraftCtx = ctx.isComponentDraft(comp.id);

      // Misplaced or absent declarations are durability-declaration's verdict.
      // Only `durable` (persisted RAM projection) needs the boot read-back:
      // read-through reads the medium on every call, ram-projection rebuilds,
      // cache loss is behavior-preserving.
      if (comp.componentType !== 'Store') continue;
      if (comp.durability !== 'durable') continue;

      const methods = ctx.interfaceMethodsOf(comp.id);
      const untagged = methods.filter(method => !method.effect);
      if (untagged.length) {
        ctx.addIssue(
          'warning',
          'MISSING_EFFECT_TAG',
          `Durable Store "${comp.id}" has contract methods without an effect tag (${untagged.map(u => `"${u.name}"`).join(', ')}) — the round-trip rule can only pair writes with read-backs over tagged methods.`,
          comp.id,
          isDraftCtx,
        );
      }

      const writes = methods.filter(method => method.effect === 'write');
      const reads = methods.filter(method => method.effect === 'read');
      if (writes.length === 0) continue; // nothing persisted, nothing to hydrate

      const hydrated = initReach !== null
        && reads.some(method => initReach.reachesMethod(comp.id, method.name));
      if (!hydrated) {
        const because = initReach === null
          ? 'no subsystem declares a lifecycle init entrypoint at all'
          : reads.length === 0
            ? 'the store declares no read-effect method to hydrate from'
            : `none of its read-effect methods (${reads.map(r => `"${r.name}"`).join(', ')}) are reachable from any declared lifecycle init flow`;
        ctx.addIssue(
          'error',
          'MISSING_HYDRATION',
          `Durable Store "${comp.id}" is written (${writes.map(w => `"${w.name}"`).join(', ')}) but ${because} — persisted state would never be read back after a restart. Wire a hydrate/read-back into a lifecycle init flow.`,
          comp.id,
          isDraftCtx,
        );
      }
    }
  },
};
