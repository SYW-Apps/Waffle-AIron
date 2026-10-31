import { SddRule } from '../types.js';
import { isDraftSubsystem, isOwnComponentEntry } from '../../../models/index.js';

/**
 * Public surface, question five: WHAT A SHARED ADAPTER MUST BE. An own entry
 * that publishes its component as shared hands every subsystem of the project
 * a component to call directly, so the component must be the generic I/O that
 * is safe to hand out: an Adapter, owned by no pattern or Supervisor, that
 * depends only on pure Orchestrators and other shared Adapters.
 *
 * An entry whose binding is broken (unbound, missing, foreign) says nothing
 * reliable about its component: public-surface-binding reports it, and this
 * rule restates the same preconditions rather than accuse on top of it.
 */
export const publicSurfaceSharedRule: SddRule = {
  name: 'public-surface-shared',
  judges: 'design',
  description:
    'Every own component entry that publishes its component as shared (shared: true) must publish what a shared Adapter is: generic I/O every subsystem of the project calls directly, deployment-neutral because each deployable runs its own copy in-process. So the component is an Adapter (PUBLIC_INTERFACE_SHARED_NOT_ADAPTER); no pattern or Supervisor owns it, since a member is private to its owner (SHARED_ADAPTER_OWNED); and it depends only on pure Orchestrators and other shared Adapters, so it holds no state and reaches nothing a deployable would have to share (SHARED_ADAPTER_DEPENDENCY). An entry whose component is missing or foreign is public-surface-binding\'s, never judged here.',
  codes: [
    { code: 'PUBLIC_INTERFACE_SHARED_NOT_ADAPTER', defaultSeverity: 'error', summary: 'A public interface entry publishes a component that is not an Adapter as shared' },
    { code: 'SHARED_ADAPTER_OWNED', defaultSeverity: 'error', summary: 'An Adapter published as shared is a member a pattern or a Supervisor owns' },
    { code: 'SHARED_ADAPTER_DEPENDENCY', defaultSeverity: 'error', summary: 'An Adapter published as shared depends on something other than a pure Orchestrator or another shared Adapter' },
  ],
  check(ctx) {
    // Step 1: every loaded subsystem.
    for (const sub of ctx.subsystems) {
      // Step 2.
      const isDraftCtx = isDraftSubsystem(sub);
      // Step 3: each OWN component entry that says shared (a re-export publishes nothing of its own).
      for (const pi of sub.publicInterfaces.filter((e) => isOwnComponentEntry(e) && e.shared === true)) {
        // Step 4.
        const backing = pi.component ? ctx.componentMap.get(pi.component) : undefined;
        // Steps 5-6: unbound, missing or foreign is public-surface-binding's.
        if (!backing || !(backing.subsystem === sub.id || backing.subsystem.startsWith(sub.id + '::'))) continue;
        // Steps 7-9: only an Adapter is the generic I/O every subsystem may call.
        if (backing.componentType !== 'Adapter') {
          ctx.addIssue('error', 'PUBLIC_INTERFACE_SHARED_NOT_ADAPTER', `Subsystem "${sub.id}" publishes "${backing.id}", a ${backing.componentType}, as shared. Only an Adapter may be published as shared: publish a Portal for anything else, or drop shared.`, sub.id, isDraftCtx);
          continue;
        }
        // Steps 10-11: a member is private to its owner.
        const owner = ctx.ownershipIndex().ownerOf(backing.id);
        if (owner !== undefined) {
          ctx.addIssue('error', 'SHARED_ADAPTER_OWNED', `Subsystem "${sub.id}" publishes Adapter "${backing.id}" as shared, but "${owner}" owns it: a member is private to its owner, so it cannot be every subsystem's. Publish an Adapter no pattern owns, or drop shared.`, sub.id, isDraftCtx);
        }
        // Step 12: it holds no state and reaches nothing a deployable would have to share.
        for (const depId of backing.dependsOn) {
          const dep = ctx.componentMap.get(depId);
          if (!dep) continue; // INVALID_DEPENDENCY_REFERENCE's, never reported here
          const pureLogic = dep.componentType === 'Orchestrator' && dep.dependencyClass === 'pure';
          const sharedAdapter = ctx.sharedSet.get(dep.subsystem)?.has(dep.id) ?? false;
          if (pureLogic || sharedAdapter) continue;
          ctx.addIssue('error', 'SHARED_ADAPTER_DEPENDENCY', `Adapter "${backing.id}", published as shared by subsystem "${sub.id}", depends on "${dep.id}" (${dep.componentType}). A shared Adapter holds no state and reaches nothing a deployable would have to share: depend only on pure Orchestrators and other shared Adapters, or drop shared.`, sub.id, isDraftCtx);
        }
      }
    }
  },
};
