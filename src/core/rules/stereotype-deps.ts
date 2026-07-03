import { SddRule } from './types.js';

/**
 * The stereotype dependency matrix (intra-subsystem) and the bounded-context
 * boundary rules (cross-subsystem): only a local client Adapter may cross a
 * subsystem boundary, and only into the remote subsystem's published Portal.
 */
export const stereotypeDepsRule: SddRule = {
  name: 'stereotype-dependencies',
  description:
    'Enforces the component-stereotype interaction matrix (Portal never reaches the data layer, Stores are depended upon, Adapters are sinks, Views stay passive, …) and the cross-subsystem shape: client Adapter → published remote Portal only.',
  codes: [
    { code: 'INVALID_DEPENDENCY_REFERENCE', defaultSeverity: 'error', summary: 'dependsOn names a non-existent component' },
    { code: 'CROSS_SUBSYSTEM_NON_ADAPTER', defaultSeverity: 'error', summary: 'Non-Adapter component crossing a subsystem boundary' },
    { code: 'CROSS_SUBSYSTEM_PRIVATE_ACCESS', defaultSeverity: 'error', summary: 'Cross-subsystem dependency on an unpublished component' },
    { code: 'CROSS_SUBSYSTEM_TARGET_NON_PORTAL', defaultSeverity: 'error', summary: 'Cross-subsystem hop entering through a non-Portal' },
    { code: 'ARCHITECTURE_VIOLATION_PORTAL_DEP', defaultSeverity: 'error', summary: 'Component depending on a Portal/Observer' },
    { code: 'ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP', defaultSeverity: 'error', summary: 'Portal/Observer reaching the data layer directly' },
    { code: 'ARCHITECTURE_VIOLATION_SPECIALIST_DEP', defaultSeverity: 'error', summary: 'Specialist depending on workflow/runtime/state blocks' },
    { code: 'ARCHITECTURE_VIOLATION_STORE_DEP', defaultSeverity: 'error', summary: 'Store depending on anything but Store/Registry/Adapter' },
    { code: 'ARCHITECTURE_VIOLATION_ADAPTER_DEP', defaultSeverity: 'error', summary: 'Adapter depending on Orchestrators or Stores' },
    { code: 'ARCHITECTURE_VIOLATION_INDEX_DEP', defaultSeverity: 'error', summary: 'Index depending on anything but its Store or an Adapter' },
    { code: 'ARCHITECTURE_VIOLATION_VIEW_DEP', defaultSeverity: 'error', summary: 'View depending on logic/persistence layers' },
  ],
  check(ctx) {
    for (const comp of ctx.components) {
      const isDraftCtx = ctx.isComponentDraft(comp.id);

      const dependencies = comp.dependsOn;
      for (const depId of dependencies) {
        const depComp = ctx.componentMap.get(depId);
        if (!depComp) {
          ctx.addIssue(
            'error',
            'INVALID_DEPENDENCY_REFERENCE',
            `Component "${comp.id}" lists dependency "${depId}" which does not exist.`,
            comp.id,
            isDraftCtx,
          );
          continue;
        }

        // Cross-subsystem boundary: a dependency crossing into another subsystem is
        // governed ONLY by the boundary rules below — the intra-subsystem type matrix
        // does not apply across a bounded-context boundary, where the sanctioned
        // crosser is an Adapter and the target is an explicitly published component.
        if (depComp.subsystem !== comp.subsystem) {
          const crossDraft = isDraftCtx || ctx.isComponentDraft(depComp.id);

          // "Always an Adapter": only a (local) client Adapter may reach another
          // subsystem; an Orchestrator/etc. must depend on a local Adapter that
          // abstracts the hop (in-process forwarding, REST, gRPC, IPC).
          if (comp.componentType !== 'Adapter') {
            ctx.addIssue(
              'error',
              'CROSS_SUBSYSTEM_NON_ADAPTER',
              `Boundary violation: ${comp.componentType} "${comp.id}" (subsystem "${comp.subsystem}") depends directly on "${depComp.id}" in subsystem "${depComp.subsystem}". Only a local client Adapter may cross a subsystem boundary — route this hop through an Adapter that calls "${depComp.subsystem}"'s public interface.`,
              comp.id,
              crossDraft,
            );
          }

          // The target must be part of the other subsystem's published public surface,
          // AND that surface must be the subsystem's inbound Portal (its front door) — not
          // a published internal Specialist/Orchestrator/Store. The hop is always:
          // client Adapter → remote Portal → Portal dispatches inward. Allowing a non-Portal
          // target leaks the boundary and breaks the adapter→network→remote-Portal seam.
          const targetIsPublic = ctx.publicSet.get(depComp.subsystem)?.has(depComp.id) ?? false;
          if (!targetIsPublic) {
            ctx.addIssue(
              'error',
              'CROSS_SUBSYSTEM_PRIVATE_ACCESS',
              `Boundary violation: "${comp.id}" depends on "${depComp.id}", which is not part of subsystem "${depComp.subsystem}"'s published public surface. Depend on one of its publicInterfaces components instead.`,
              comp.id,
              crossDraft,
            );
          } else if (depComp.componentType !== 'Portal' && depComp.componentType !== 'Gateway') {
            ctx.addIssue(
              'error',
              'CROSS_SUBSYSTEM_TARGET_NON_PORTAL',
              `Boundary violation: client Adapter "${comp.id}" enters subsystem "${depComp.subsystem}" through "${depComp.id}" (${depComp.componentType}), not its inbound Portal. A cross-subsystem hop must target the remote subsystem's Portal (its front door), which dispatches inward — publishing/depending on an internal ${depComp.componentType} leaks the boundary and breaks the distribution seam. Expose a Portal for "${depComp.subsystem}" and point this Adapter at it.`,
              comp.id,
              crossDraft,
            );
          }

          continue;
        }

        // Check Portal/Observer dependency boundary: components cannot depend on Portals or Observers
        if (depComp.componentType === 'Portal' || depComp.componentType === 'Observer') {
          ctx.addIssue(
            'error',
            'ARCHITECTURE_VIOLATION_PORTAL_DEP',
            `Architectural violation: Component "${comp.id}" cannot depend on ${depComp.componentType} component "${depComp.id}". ${depComp.componentType}s are top-level entry points/subscribers and cannot be dependencies.`,
            comp.id,
            isDraftCtx || ctx.isComponentDraft(depComp.id),
          );
        }

        // Portal dispatches to Orchestrators (and may read Indexes); it must not reach
        // the data layer directly. Observer forwards to one Orchestrator/Supervisor and
        // may use a message-bus Adapter to subscribe.
        if (comp.componentType === 'Portal' || comp.componentType === 'Observer') {
          const forbiddenTypes = comp.componentType === 'Portal'
            ? ['Store', 'Registry', 'Repository', 'Adapter']
            : ['Store', 'Registry', 'Repository', 'Index'];
          if (forbiddenTypes.includes(depComp.componentType)) {
            ctx.addIssue(
              'error',
              'ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP',
              `Architectural violation: ${comp.componentType} component "${comp.id}" cannot depend directly on "${depComp.componentType}" component "${depComp.id}". ${comp.componentType}s coordinate through Orchestrators (and Supervisors); they do not reach the data layer directly.`,
              comp.id,
              isDraftCtx || ctx.isComponentDraft(depComp.id),
            );
          }
        }

        // Specialist rule: narrow capability. It MAY use Repositories, Indexes, and
        // Adapters, but must not own/drive bus, persistence, or runtime concerns.
        if (comp.componentType === 'Specialist') {
          const forbiddenTypes = ['Portal', 'Observer', 'Orchestrator', 'Store', 'Supervisor'];
          if (forbiddenTypes.includes(depComp.componentType)) {
            ctx.addIssue(
              'error',
              'ARCHITECTURE_VIOLATION_SPECIALIST_DEP',
              `Architectural violation: Specialist component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". Specialists are narrow capabilities — they may use Repositories, Indexes, and Adapters, but not Orchestrators, Supervisors, Stores, Portals, or Observers.`,
              comp.id,
              isDraftCtx || ctx.isComponentDraft(depComp.id),
            );
          }
        }

        // Store rule: a Store may depend only on another Store or its backend Adapter.
        // It is depended upon by Registries/Indexes — never the reverse.
        if (comp.componentType === 'Store') {
          if (depComp.componentType !== 'Store' && depComp.componentType !== 'Registry' && depComp.componentType !== 'Adapter') {
            ctx.addIssue(
              'error',
              'ARCHITECTURE_VIOLATION_STORE_DEP',
              `Architectural violation: Store component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". Stores may only depend on other Stores, Registries, or a backend Adapter.`,
              comp.id,
              isDraftCtx || ctx.isComponentDraft(depComp.id),
            );
          }
        }

        // Adapter rule: Adapter is a sink toward the system; it cannot call Orchestrators or Stores
        if (comp.componentType === 'Adapter') {
          if (depComp.componentType === 'Orchestrator' || depComp.componentType === 'Store') {
            ctx.addIssue(
              'error',
              'ARCHITECTURE_VIOLATION_ADAPTER_DEP',
              `Architectural violation: Adapter component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". Adapters cannot depend on Orchestrators or Stores.`,
              comp.id,
              isDraftCtx || ctx.isComponentDraft(depComp.id),
            );
          }
        }

        // Index rule: a read projection — may depend only on its Store or a backend Adapter.
        if (comp.componentType === 'Index') {
          if (depComp.componentType !== 'Store' && depComp.componentType !== 'Adapter') {
            ctx.addIssue(
              'error',
              'ARCHITECTURE_VIOLATION_INDEX_DEP',
              `Architectural violation: Index component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". An Index is a read projection and may depend only on its Store or a backend Adapter.`,
              comp.id,
              isDraftCtx || ctx.isComponentDraft(depComp.id),
            );
          }
        }

        // View rule: pure presenter block. Decoupled from logical execution and persistence layers.
        if (comp.componentType === 'View') {
          const forbiddenTypes = ['Store', 'Registry', 'Index', 'Adapter', 'Portal', 'Observer', 'Repository', 'Gateway', 'Orchestrator'];
          if (forbiddenTypes.includes(depComp.componentType)) {
            ctx.addIssue(
              'error',
              'ARCHITECTURE_VIOLATION_VIEW_DEP',
              `Architectural violation: View component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". Views must remain passive UI blocks and be decoupled from logical layers.`,
              comp.id,
              isDraftCtx || ctx.isComponentDraft(depComp.id),
            );
          }
        }
      }
    }
  },
};
