import { SddRule } from './types.js';
import { resolveSurfaceRef, isExternalNamespaceRef } from './namespace.js';

// The one shortcut agents reach for when a Store link is refused is the one
// that must never happen: folding the store's state into the consumer. Say so
// on every Store-target violation, next to the CORRECT resolution.
const NEVER_INLINE_STATE =
  ' Never resolve this by merging the store\'s state into the consuming component — state hidden inside a logic block is invisible to the spec and unrecoverable.';

const storeResolutionHint = (consumerType: string, storeId: string): string => {
  if (consumerType === 'Specialist') {
    return ` Resolution: wrap "${storeId}" in a Repository pattern (owns: Store + Registry + Index) and depend on that Repository facade instead.${NEVER_INLINE_STATE}`;
  }
  // Portal / Observer / View: even the Repository facade is out of reach —
  // the hop goes through the logic side.
  return ` Resolution: wrap "${storeId}" in a Repository pattern and reach it through an Orchestrator that uses the Repository facade.${NEVER_INLINE_STATE}`;
};

/**
 * The stereotype dependency matrix (intra-subsystem) and the bounded-context
 * boundary rules (cross-subsystem): only a local client Adapter may cross a
 * subsystem boundary, and only into the remote subsystem's published Portal.
 */
export const stereotypeDepsRule: SddRule = {
  name: 'stereotype-dependencies',
  description:
    'Enforces the component-stereotype interaction matrix (Portal reaches the data layer only through Repository/Index READ faces — writes route through Orchestrators (PORTAL_WRITE_SHORTCUT); Stores are depended upon; Registries write their Store; Adapters are sinks; Views stay passive; …) and the cross-subsystem shape: client Adapter → published remote Portal, OR a direct in-process edge licensed by a trustedLink declared on the SOURCE subsystem (the published-Portal target requirement applies either way). A governing pack profile may license intra-subsystem edges the matrix refuses via allowedEdges (its platform idiom, with the stated reason); boundary rules stay unrelaxable.',
  codes: [
    { code: 'INVALID_DEPENDENCY_REFERENCE', defaultSeverity: 'error', summary: 'dependsOn names a non-existent component' },
    { code: 'CROSS_TREE_REF_UNRESOLVED', defaultSeverity: 'warning', summary: 'Cross-tree dependsOn (super::/:: form) with no surface snapshot covering it' },
    { code: 'CROSS_SUBSYSTEM_NON_ADAPTER', defaultSeverity: 'error', summary: 'Non-Adapter component crossing a subsystem boundary' },
    { code: 'CROSS_SUBSYSTEM_PRIVATE_ACCESS', defaultSeverity: 'error', summary: 'Cross-subsystem dependency on an unpublished component' },
    { code: 'CROSS_SUBSYSTEM_TARGET_NON_PORTAL', defaultSeverity: 'error', summary: 'Cross-subsystem hop entering through a non-Portal' },
    { code: 'ARCHITECTURE_VIOLATION_PORTAL_DEP', defaultSeverity: 'error', summary: 'Component depending on a Portal/Observer' },
    { code: 'ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP', defaultSeverity: 'error', summary: 'Portal/Observer reaching the data layer directly' },
    { code: 'ARCHITECTURE_VIOLATION_SPECIALIST_DEP', defaultSeverity: 'error', summary: 'Specialist depending on workflow/runtime/state blocks' },
    { code: 'ARCHITECTURE_VIOLATION_STORE_DEP', defaultSeverity: 'error', summary: 'Store depending on anything but another Store or a backend Adapter' },
    { code: 'ARCHITECTURE_VIOLATION_REGISTRY_DEP', defaultSeverity: 'warning', summary: 'Registry depending on anything but its Store or a backend Adapter (warning while new; NOTE: the written standard also licenses validation Specialists — alignment pending)' },
    { code: 'ARCHITECTURE_VIOLATION_ADAPTER_DEP', defaultSeverity: 'error', summary: 'Adapter depending on Orchestrators or Stores' },
    { code: 'ARCHITECTURE_VIOLATION_INDEX_DEP', defaultSeverity: 'error', summary: 'Index depending on anything but its Store or an Adapter' },
    { code: 'ARCHITECTURE_VIOLATION_VIEW_DEP', defaultSeverity: 'error', summary: 'View depending on logic/persistence layers' },
    { code: 'PORTAL_WRITE_SHORTCUT', defaultSeverity: 'error', summary: 'Portal narrative calls a write-effect method on a Repository/Index directly — reads may shortcut, writes route through an Orchestrator (judged on effect-tagged facade methods; untagged methods are not yet judged)' },
  ],
  check(ctx) {
    for (const comp of ctx.components) {
      const isDraftCtx = ctx.isComponentDraft(comp.id);

      const dependencies = comp.dependsOn;
      for (const depId of dependencies) {
        const depComp = ctx.componentMap.get(depId);
        if (!depComp) {
          // A cross-tree form (super::/::) in a standalone context: resolve
          // against the stored surface snapshots — a hit is a DECLARED remote
          // portal, and the cross-boundary shape rule (source must be an
          // Adapter) applies exactly as it does for cross-subsystem deps.
          if (isExternalNamespaceRef(ctx, depId)) {
            const resolved = resolveSurfaceRef(ctx, depId);
            if (resolved) {
              if (comp.componentType !== 'Adapter') {
                ctx.addIssue(
                  'error',
                  'CROSS_SUBSYSTEM_NON_ADAPTER',
                  `Boundary violation: ${comp.componentType} "${comp.id}" depends directly on "${depId}", a surface of project "${resolved.snapshot.projectName}". Only a local client Adapter may cross a project boundary — route this hop through an Adapter.`,
                  comp.id,
                  isDraftCtx,
                );
              }
              continue;
            }
            ctx.addIssue(
              'warning',
              'CROSS_TREE_REF_UNRESOLVED',
              `Component "${comp.id}" depends on cross-tree component "${depId}", and no surface snapshot covers it — validate from the parent project, or import/generate the producing project's surface.`,
              comp.id,
              isDraftCtx,
            );
            continue;
          }
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
          // EXCEPTION: the SOURCE subsystem may license a direct in-process
          // edge by declaring a trustedLink to the target — the reviewable-
          // exception mechanism instead of a forwarding shim per hop. The
          // published-Portal target requirements below apply regardless, so
          // the distribution seam stays intact at the receiving end.
          const sourceSub = ctx.subsystems.find(s => s.id === comp.subsystem);
          const licensed = sourceSub?.trustedLinks?.some(t => t.subsystem === depComp.subsystem) ?? false;
          if (comp.componentType !== 'Adapter' && !licensed) {
            ctx.addIssue(
              'error',
              'CROSS_SUBSYSTEM_NON_ADAPTER',
              `Boundary violation: ${comp.componentType} "${comp.id}" (subsystem "${comp.subsystem}") depends directly on "${depComp.id}" in subsystem "${depComp.subsystem}". Only a local client Adapter may cross a subsystem boundary — route this hop through an Adapter that calls "${depComp.subsystem}"'s public interface, or declare a trustedLink on "${comp.subsystem}" (with the reason) to license a direct in-process edge to that peer's published Portal.`,
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

        // Profile edge-deltas: the governing pack profile may LICENSE an
        // intra-subsystem edge the builtin matrix refuses — the platform's
        // own idiom (e.g. an ECS system reading component Stores directly),
        // declared with a reason on the profile. Scoped to the stereotype
        // matrix only: the cross-subsystem boundary rules above and pattern
        // containment/visibility are never relaxable this way.
        const governingProfile = ctx.ext.profiles[ctx.getComponentProfile(comp.id)];
        if (governingProfile?.allowedEdges?.some(e => e.from.includes(comp.componentType) && e.to.includes(depComp.componentType))) {
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

        // Portal dispatches to Orchestrators, and may READ through Indexes and
        // Repository facades (the per-entity empty-Orchestrator ceremony is
        // not required for passthrough reads) — but its WRITES always route
        // through the workflow layer (PORTAL_WRITE_SHORTCUT below), and the
        // raw data blocks (Store/Registry) plus Adapters stay out of reach.
        // Observer forwards to one Orchestrator/Supervisor and may use a
        // message-bus Adapter to subscribe.
        if (comp.componentType === 'Portal' || comp.componentType === 'Observer') {
          const forbiddenTypes = comp.componentType === 'Portal'
            ? ['Store', 'Registry', 'Adapter']
            : ['Store', 'Registry', 'Repository', 'Index'];
          if (forbiddenTypes.includes(depComp.componentType)) {
            ctx.addIssue(
              'error',
              'ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP',
              `Architectural violation: ${comp.componentType} component "${comp.id}" cannot depend directly on "${depComp.componentType}" component "${depComp.id}". ${comp.componentType}s coordinate through Orchestrators (and Supervisors); they do not reach the data layer directly.`
              + (depComp.componentType === 'Store' ? storeResolutionHint(comp.componentType, depComp.id) : ''),
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
              `Architectural violation: Specialist component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". Specialists are narrow capabilities — they may use Repositories, Indexes, and Adapters, but not Orchestrators, Supervisors, Stores, Portals, or Observers.`
              + (depComp.componentType === 'Store' ? storeResolutionHint(comp.componentType, depComp.id) : ''),
              comp.id,
              isDraftCtx || ctx.isComponentDraft(depComp.id),
            );
          }
        }

        // Store rule: a Store may depend only on another Store or its backend
        // Adapter. It is depended upon by Registries/Indexes — never the
        // reverse (the Registry allowance the code used to carry contradicted
        // both this comment and the standard, and existed only to serve the
        // since-retyped file-backed "Registries").
        if (comp.componentType === 'Store') {
          if (depComp.componentType !== 'Store' && depComp.componentType !== 'Adapter') {
            ctx.addIssue(
              'error',
              'ARCHITECTURE_VIOLATION_STORE_DEP',
              `Architectural violation: Store component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". Stores may only depend on other Stores or a backend Adapter — Registries and Indexes depend on the Store, never the reverse.`,
              comp.id,
              isDraftCtx || ctx.isComponentDraft(depComp.id),
            );
          }
        }

        // Registry rule: the write path to its Store — it may depend only on
        // that Store (or a backend Adapter); reaching workflow, read
        // projections, or boundaries inverts the layering. Warning while the
        // check is new; the written standard has always claimed it.
        if (comp.componentType === 'Registry') {
          if (depComp.componentType !== 'Store' && depComp.componentType !== 'Adapter') {
            ctx.addIssue(
              'warning',
              'ARCHITECTURE_VIOLATION_REGISTRY_DEP',
              `Architectural violation: Registry component "${comp.id}" should not depend on "${depComp.componentType}" component "${depComp.id}". A Registry is the write path to its Store and may depend only on that Store or a backend Adapter — the Registry never updates Indexes and never drives workflow.`,
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
              `Architectural violation: View component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". Views must remain passive UI blocks and be decoupled from logical layers.`
              + (depComp.componentType === 'Store' ? storeResolutionHint(comp.componentType, depComp.id) : ''),
              comp.id,
              isDraftCtx || ctx.isComponentDraft(depComp.id),
            );
          }
        }
      }
    }

    // Portal read-face guard: the Repository/Index shortcut above is licensed
    // for READS only. A Portal narrative call step that hits a write-effect
    // method on a data facade is the persistence shortcut in disguise —
    // writes go through the workflow layer. Untagged methods are not judged
    // (effect tags are the mechanism; MISSING_EFFECT_TAG drives their
    // adoption on durable stores).
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      const component = contract ? ctx.componentMap.get(contract.component) : undefined;
      if (!component || component.componentType !== 'Portal') continue;
      const isDraftCtx = ctx.isImplementationDraft(impl);

      for (const implMethod of impl.methods) {
        for (const step of implMethod.narrative) {
          if (step.type !== 'call' || !step.targetComponent || !step.targetMethod) continue;
          const target = ctx.componentMap.get(step.targetComponent);
          if (!target || (target.componentType !== 'Repository' && target.componentType !== 'Index')) continue;
          const targetMethod = (ctx.interfacesByComponent.get(target.id) ?? [])
            .flatMap(i => i.methods)
            .find(m => m.name === step.targetMethod);
          if (targetMethod?.effect !== 'write') continue;
          ctx.addIssue(
            'error',
            'PORTAL_WRITE_SHORTCUT',
            `Portal "${component.id}": step ${step.stepNumber} of "${implMethod.name}" calls write-effect method ${target.id}.${step.targetMethod} directly. The Portal→${target.componentType} shortcut is licensed for READS only — route the write through an Orchestrator that owns the workflow.`,
            impl.id,
            isDraftCtx || ctx.isComponentDraft(target.id),
          );
        }
      }
    }
  },
};
