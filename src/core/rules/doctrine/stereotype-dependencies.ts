import { SddRule } from '../types.js';
import { ambiguityMessage, isRetired, type ComponentSpec } from '../../../models/index.js';

// The one shortcut agents reach for when a Store link is refused is the one
// that must never happen: folding the store's state into the consumer. Say so
// on every Store-target violation, next to the CORRECT resolution.
const NEVER_INLINE_STATE =
  ' Never resolve this by merging the store\'s state into the consuming component — state hidden inside a logic block is invisible to the spec and unrecoverable.';

const storeResolutionHint = (consumerType: string, storeId: string): string => {
  if (consumerType === 'Orchestrator') {
    return ` Resolution: wrap "${storeId}" in a Repository pattern (owns: Store + Registry + Index) and depend on that Repository facade instead.${NEVER_INLINE_STATE}`;
  }
  // Any other consumer (a Portal, Observer, View or Supervisor): even the
  // Repository facade is out of its reach — the hop goes through the logic side.
  return ` Resolution: wrap "${storeId}" in a Repository pattern and reach it through an Orchestrator that uses the Repository facade.${NEVER_INLINE_STATE}`;
};

/** Pure logic: an Orchestrator whose dependencyClass is pure. Any block may use it. */
const isPureLogic = (comp: ComponentSpec): boolean =>
  comp.componentType === 'Orchestrator' && comp.dependencyClass === 'pure';

/** Read logic: an Orchestrator whose dependencyClass is read. */
const isReadLogic = (comp: ComponentSpec): boolean =>
  comp.componentType === 'Orchestrator' && comp.dependencyClass === 'read';

/** A component as a finding names it: its stereotype, with its dependencyClass when it declares one. */
const stereotypeOf = (comp: ComponentSpec): string =>
  comp.dependencyClass ? `${comp.componentType} (dependencyClass ${comp.dependencyClass})` : comp.componentType;

/**
 * The stereotype dependency matrix (intra-subsystem) and the bounded-context
 * boundary rules (cross-subsystem): only a local client Adapter may cross a
 * subsystem boundary, and only into the remote subsystem's published Portal.
 */
export const stereotypeDepsRule: SddRule = {
  name: 'stereotype-dependencies',
  description:
    'Enforces the component-stereotype interaction matrix and the cross-subsystem shape. The matrix: a Portal reaches the data layer only through Repository/Index READ faces, and writes route through Orchestrators (PORTAL_WRITE_SHORTCUT); Stores are depended upon; Registries write their Store; Adapters are sinks; Views stay passive; an Orchestrator\'s dependencyClass bounds what it may depend on; a Supervisor reaches data only through workflows; a live Actor is reached through a Supervisor that supervises it; a Query reads its Store; any block may use pure logic. Across subsystems: client Adapter → published remote Portal, OR a direct in-process edge licensed by a trustedLink declared on the SOURCE subsystem (the published-Portal target requirement applies either way). A governing pack profile may license intra-subsystem edges the matrix refuses via allowedEdges (its platform idiom, with the stated reason); boundary rules stay unrelaxable.',
  codes: [
    { code: 'INVALID_DEPENDENCY_REFERENCE', defaultSeverity: 'error', summary: 'dependsOn names a non-existent component' },
    { code: 'CROSS_TREE_REF_UNRESOLVED', defaultSeverity: 'warning', summary: 'Cross-tree dependsOn (super::/:: form) with no surface snapshot covering it' },
    { code: 'SURFACE_REF_AMBIGUOUS', defaultSeverity: 'error', summary: 'Cross-tree dependsOn matched by surface snapshots of several providers with different contracts' },
    { code: 'CROSS_SUBSYSTEM_NON_ADAPTER', defaultSeverity: 'error', summary: 'Non-Adapter component crossing a subsystem boundary' },
    { code: 'CROSS_SUBSYSTEM_PRIVATE_ACCESS', defaultSeverity: 'error', summary: 'Cross-subsystem dependency on an unpublished component' },
    { code: 'CROSS_SUBSYSTEM_TARGET_NON_PORTAL', defaultSeverity: 'error', summary: 'Cross-subsystem hop entering through a non-Portal' },
    { code: 'ARCHITECTURE_VIOLATION_PORTAL_DEP', defaultSeverity: 'error', summary: 'Component depending on a Portal/Observer' },
    { code: 'ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP', defaultSeverity: 'error', summary: 'Portal/Observer reaching the data layer directly' },
    { code: 'ARCHITECTURE_VIOLATION_STORE_DEP', defaultSeverity: 'error', summary: 'Store depending on anything but another Store, a backend Adapter or pure logic' },
    { code: 'ARCHITECTURE_VIOLATION_REGISTRY_DEP', defaultSeverity: 'warning', summary: 'Registry depending on anything but its Store, a backend Adapter or pure logic (warning while new; aligned to the standard §7 validate→write path)' },
    { code: 'ARCHITECTURE_VIOLATION_ADAPTER_DEP', defaultSeverity: 'error', summary: 'Adapter depending on a Store or on an Orchestrator that is not pure' },
    { code: 'ARCHITECTURE_VIOLATION_INDEX_DEP', defaultSeverity: 'error', summary: 'Index depending on anything but its Store, an Adapter or pure logic' },
    { code: 'ARCHITECTURE_VIOLATION_VIEW_DEP', defaultSeverity: 'error', summary: 'View depending on persistence layers or on logic that is not pure' },
    { code: 'PORTAL_WRITE_SHORTCUT', defaultSeverity: 'error', summary: 'Portal narrative call or dispatch-table binding reaches a write-effect method on a Repository/Index directly — reads may shortcut, writes route through an Orchestrator (judged on effect-tagged facade methods; untagged methods are not yet judged)' },
    { code: 'DEPENDENCY_CLASS_VIOLATION', defaultSeverity: 'error', summary: 'Orchestrator depending on a component its dependencyClass does not allow: pure logic depends only on pure Orchestrators; read logic also on read Orchestrators, Repositories, Indexes and Adapters' },
    { code: 'ARCHITECTURE_VIOLATION_SUPERVISOR_DEP', defaultSeverity: 'error', summary: 'Supervisor depending on anything but Actors, Orchestrators, Adapters or other Supervisors — it reaches data only through workflows' },
    { code: 'ACTOR_REACHED_WITHOUT_SUPERVISOR', defaultSeverity: 'error', summary: 'Component depending on a live Actor it does not supervise, without also depending on a Supervisor that supervises it — a live Actor is reached by id through its Supervisor' },
    { code: 'ARCHITECTURE_VIOLATION_QUERY_DEP', defaultSeverity: 'error', summary: 'Query depending on anything but its Store, a backend Adapter or pure logic' },
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
          // A reference made from inside a chained mount that the loader
          // collapsed at this root is resolved the same way, against the
          // snapshots that mount holds — but only a HIT changes anything: from
          // this root the whole tree is loaded, so a collapsed reference no
          // snapshot covers is genuinely missing and keeps its error.
          // Snapshots that answer the reference with different contracts decide
          // nothing either way: the ambiguity is the finding.
          const external = ctx.isExternalNamespaceRef(depId);
          if (external || ctx.isCollapsedCrossTreeRef(depId, comp.subsystem)) {
            const resolved = ctx.resolveSurfaceRef(depId, comp.subsystem);
            if (resolved.kind === 'ambiguous') {
              ctx.addIssue('error', 'SURFACE_REF_AMBIGUOUS', ambiguityMessage(resolved, `Component "${comp.id}" depends on`, depId), comp.id, isDraftCtx);
              continue;
            }
            if (resolved.kind === 'resolved') {
              if (comp.componentType !== 'Adapter') {
                // surfaceResolved: verified against the vendored snapshot — a
                // genuine boundary verdict that keeps full strength even when
                // this tree is a chained subproject validated standalone.
                ctx.addIssue(
                  'error',
                  'CROSS_SUBSYSTEM_NON_ADAPTER',
                  `Boundary violation: ${comp.componentType} "${comp.id}" depends directly on "${depId}", a surface of project "${resolved.snapshot.projectName}". Only a local client Adapter may cross a project boundary — route this hop through an Adapter.`,
                  comp.id,
                  isDraftCtx,
                  true,
                );
              }
              continue;
            }
            if (external) {
              ctx.addIssue(
                'warning',
                'CROSS_TREE_REF_UNRESOLVED',
                `Component "${comp.id}" depends on cross-tree component "${depId}", and no surface snapshot covers it — validate from the parent project, pin the family surfaces ("wairon surface pin"), or import the producing project's surface.`,
                comp.id,
                isDraftCtx,
              );
              continue;
            }
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

        // An edge with a retired end (a Specialist or Gateway) is judged by no
        // boundary or matrix rule: retired-stereotypes reports the retired
        // component once, and its migration decides what the edge becomes.
        if (isRetired(comp) || isRetired(depComp)) continue;

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
          // a published internal Orchestrator/Store. The hop is always: client Adapter →
          // remote Portal → Portal dispatches inward. Allowing a non-Portal target leaks
          // the boundary and breaks the adapter→network→remote-Portal seam.
          const targetIsPublic = ctx.publicSet.get(depComp.subsystem)?.has(depComp.id) ?? false;
          if (!targetIsPublic) {
            ctx.addIssue(
              'error',
              'CROSS_SUBSYSTEM_PRIVATE_ACCESS',
              `Boundary violation: "${comp.id}" depends on "${depComp.id}", which is not part of subsystem "${depComp.subsystem}"'s published public surface. Depend on one of its publicInterfaces components instead.`,
              comp.id,
              crossDraft,
            );
          } else if (depComp.componentType !== 'Portal') {
            // Name the crosser as what it is: the sanctioned client Adapter, or
            // any other stereotype — a trustedLink licenses its crossing, never
            // this target requirement, and an unlicensed one reaches here too.
            const crosser = comp.componentType === 'Adapter' ? 'client Adapter' : comp.componentType;
            ctx.addIssue(
              'error',
              'CROSS_SUBSYSTEM_TARGET_NON_PORTAL',
              `Boundary violation: ${crosser} "${comp.id}" enters subsystem "${depComp.subsystem}" through "${depComp.id}" (${depComp.componentType}), not its inbound Portal. A cross-subsystem hop must target the remote subsystem's Portal (its front door), which dispatches inward — publishing/depending on an internal ${depComp.componentType} leaks the boundary and breaks the distribution seam. Expose a Portal for "${depComp.subsystem}" and point "${comp.id}" at it.`,
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
        // matrix only (the dependency-class, Supervisor, Actor and Query
        // rules included): the cross-subsystem boundary rules above and
        // pattern containment/visibility are never relaxable this way.
        const governingProfile = ctx.ext.profiles[ctx.getComponentProfile(comp.id)];
        if (governingProfile?.allowedEdges?.some(e => e.from.includes(comp.componentType) && e.to.includes(depComp.componentType))) {
          continue;
        }

        const edgeDraft = isDraftCtx || ctx.isComponentDraft(depComp.id);
        const depPure = isPureLogic(depComp);
        const depRead = isReadLogic(depComp);
        const storeHint = depComp.componentType === 'Store' ? storeResolutionHint(comp.componentType, depComp.id) : '';

        // Portal/Observer dependency boundary: components cannot depend on
        // Portals or Observers. That is the edge's one finding — no consumer-side
        // matrix check reports the same edge again.
        if (depComp.componentType === 'Portal' || depComp.componentType === 'Observer') {
          ctx.addIssue(
            'error',
            'ARCHITECTURE_VIOLATION_PORTAL_DEP',
            `Architectural violation: Component "${comp.id}" cannot depend on ${depComp.componentType} component "${depComp.id}". ${depComp.componentType}s are top-level entry points/subscribers and cannot be dependencies.`,
            comp.id,
            edgeDraft,
          );
          continue;
        }

        // Portal dispatches to Orchestrators, and may READ through Indexes and
        // Repository facades (the per-entity empty-Orchestrator ceremony is
        // not required for passthrough reads) — but its WRITES always route
        // through the workflow layer (PORTAL_WRITE_SHORTCUT below), and the
        // raw data blocks (Store/Registry/Query) plus Adapters stay out of
        // reach. Observer forwards to one Orchestrator/Supervisor and may use a
        // message-bus Adapter to subscribe.
        if (comp.componentType === 'Portal' || comp.componentType === 'Observer') {
          const forbiddenTypes = comp.componentType === 'Portal'
            ? ['Store', 'Registry', 'Adapter', 'Query']
            : ['Store', 'Registry', 'Repository', 'Index', 'Query'];
          if (forbiddenTypes.includes(depComp.componentType)) {
            ctx.addIssue(
              'error',
              'ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP',
              `Architectural violation: ${comp.componentType} component "${comp.id}" cannot depend directly on "${depComp.componentType}" component "${depComp.id}". ${comp.componentType}s coordinate through Orchestrators (and Supervisors); they do not reach the data layer directly.`
              + storeHint,
              comp.id,
              edgeDraft,
            );
          }
        }

        // Logic is an Orchestrator, and its dependencyClass bounds what it may
        // depend on. Pure logic computes over the values it is handed, so it
        // depends only on other pure logic. Read logic may also read: through
        // read logic, a Repository, an Index or an Adapter. Whether read logic
        // calls a WRITE method on one of those is judged only once facade
        // methods carry effect tags. Unset, the Orchestrator is a workflow.
        if (isPureLogic(comp) && !depPure) {
          ctx.addIssue(
            'error',
            'DEPENDENCY_CLASS_VIOLATION',
            `Architectural violation: Orchestrator "${comp.id}" (dependencyClass pure) cannot depend on ${stereotypeOf(depComp)} "${depComp.id}". Pure logic depends only on pure Orchestrators — move that dependency to the workflow that calls "${comp.id}", or declare "${comp.id}" read when it reads through read logic, a Repository, an Index or an Adapter.`
            + storeHint,
            comp.id,
            edgeDraft,
          );
        }
        if (isReadLogic(comp) && !depPure && !depRead
          && !['Repository', 'Index', 'Adapter'].includes(depComp.componentType)) {
          ctx.addIssue(
            'error',
            'DEPENDENCY_CLASS_VIOLATION',
            `Architectural violation: Orchestrator "${comp.id}" (dependencyClass read) cannot depend on ${stereotypeOf(depComp)} "${depComp.id}". Read logic depends only on pure or read Orchestrators, Repositories, Indexes and Adapters — move that dependency to the workflow that calls "${comp.id}", or unset the dependencyClass of "${comp.id}" when it is itself a workflow.`
            + storeHint,
            comp.id,
            edgeDraft,
          );
        }

        // Store rule: a Store may depend only on another Store, its backend
        // Adapter, or pure logic. It is depended upon by Registries/Indexes —
        // never the reverse.
        if (comp.componentType === 'Store'
          && depComp.componentType !== 'Store' && depComp.componentType !== 'Adapter' && !depPure) {
          ctx.addIssue(
            'error',
            'ARCHITECTURE_VIOLATION_STORE_DEP',
            `Architectural violation: Store component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". Stores may only depend on other Stores, a backend Adapter or pure logic — Registries and Indexes depend on the Store, never the reverse.`,
            comp.id,
            edgeDraft,
          );
        }

        // Registry rule: the write path to its Store — validate → store.write.
        // It may depend on that Store, a backend Adapter, or the pure logic that
        // validates the write (the standard's §7 write path); reaching
        // workflow, read projections, or boundaries inverts the layering.
        // Warning while the check is new.
        if (comp.componentType === 'Registry'
          && depComp.componentType !== 'Store' && depComp.componentType !== 'Adapter' && !depPure) {
          ctx.addIssue(
            'warning',
            'ARCHITECTURE_VIOLATION_REGISTRY_DEP',
            `Architectural violation: Registry component "${comp.id}" should not depend on "${depComp.componentType}" component "${depComp.id}". A Registry is the write path to its Store and may depend only on that Store, a backend Adapter, or pure logic that validates the write — the Registry never updates Indexes and never drives workflow.`,
            comp.id,
            edgeDraft,
          );
        }

        // Adapter rule: an Adapter is a sink toward the system. It may use pure
        // logic, but never a Store or any other Orchestrator.
        if (comp.componentType === 'Adapter'
          && (depComp.componentType === 'Store' || (depComp.componentType === 'Orchestrator' && !depPure))) {
          ctx.addIssue(
            'error',
            'ARCHITECTURE_VIOLATION_ADAPTER_DEP',
            `Architectural violation: Adapter component "${comp.id}" cannot depend on ${stereotypeOf(depComp)} component "${depComp.id}". An Adapter may use pure logic, but never a Store or any other Orchestrator.`,
            comp.id,
            edgeDraft,
          );
        }

        // Index rule: a read projection — may depend only on its Store, a
        // backend Adapter, or pure logic.
        if (comp.componentType === 'Index'
          && depComp.componentType !== 'Store' && depComp.componentType !== 'Adapter' && !depPure) {
          ctx.addIssue(
            'error',
            'ARCHITECTURE_VIOLATION_INDEX_DEP',
            `Architectural violation: Index component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". An Index is a read projection and may depend only on its Store, a backend Adapter or pure logic.`,
            comp.id,
            edgeDraft,
          );
        }

        // Query rule: a computed read over its Repository's Store — its Store, a
        // backend Adapter where one serves it, and pure logic.
        if (comp.componentType === 'Query'
          && depComp.componentType !== 'Store' && depComp.componentType !== 'Adapter' && !depPure) {
          ctx.addIssue(
            'error',
            'ARCHITECTURE_VIOLATION_QUERY_DEP',
            `Architectural violation: Query "${comp.id}" cannot depend on ${stereotypeOf(depComp)} "${depComp.id}". A Query computes reads over its Store, through a backend Adapter where one serves it, with pure logic — move any other dependency to the workflow that calls the Repository facade.`,
            comp.id,
            edgeDraft,
          );
        }

        // View rule: a passive presenter. Decoupled from persistence and
        // boundary blocks, it uses pure logic at most.
        if (comp.componentType === 'View'
          && (['Store', 'Registry', 'Index', 'Query', 'Adapter', 'Repository'].includes(depComp.componentType)
            || (depComp.componentType === 'Orchestrator' && !depPure))) {
          ctx.addIssue(
            'error',
            'ARCHITECTURE_VIOLATION_VIEW_DEP',
            `Architectural violation: View component "${comp.id}" cannot depend on ${stereotypeOf(depComp)} component "${depComp.id}". Views must remain passive UI blocks that use pure logic at most.`
            + storeHint,
            comp.id,
            edgeDraft,
          );
        }

        // Supervisor rule: a Supervisor reaches data only through workflows. It
        // may depend on Actors, Orchestrators, Adapters and other Supervisors;
        // a Portal or Observer target was reported above, once.
        if (comp.componentType === 'Supervisor'
          && ['Store', 'Registry', 'Repository', 'Index', 'Query', 'View', 'FeatureComponent', 'RouterComponent'].includes(depComp.componentType)) {
          ctx.addIssue(
            'error',
            'ARCHITECTURE_VIOLATION_SUPERVISOR_DEP',
            `Architectural violation: Supervisor "${comp.id}" cannot depend on ${stereotypeOf(depComp)} "${depComp.id}". A Supervisor reaches data only through workflows — depend on the Orchestrator, Actor or Adapter that does that work instead.`
            + storeHint,
            comp.id,
            edgeDraft,
          );
        }

        // A live Actor is reached by id through a Supervisor that supervises it:
        // a Supervisor depending on the Actor supervises it, and any other
        // component must also depend on such a Supervisor.
        if (depComp.componentType === 'Actor' && comp.componentType !== 'Supervisor') {
          const reachedThroughSupervisor = comp.dependsOn.some(id => {
            const supervisor = ctx.componentMap.get(id);
            return supervisor?.componentType === 'Supervisor' && supervisor.dependsOn.includes(depComp.id);
          });
          if (!reachedThroughSupervisor) {
            const supervisors = ctx.components
              .filter(c => c.componentType === 'Supervisor' && c.dependsOn.includes(depComp.id))
              .map(c => `"${c.id}"`);
            const remedy = supervisors.length > 0
              ? `also depend on ${supervisors.length === 1 ? 'its Supervisor' : 'one of its Supervisors'} (${supervisors.join(', ')})`
              : `no Supervisor depends on "${depComp.id}" yet, so give the Actor a Supervisor that depends on it and depend on that Supervisor`;
            ctx.addIssue(
              'error',
              'ACTOR_REACHED_WITHOUT_SUPERVISOR',
              `Architectural violation: ${stereotypeOf(comp)} "${comp.id}" depends on the live Actor "${depComp.id}" without a Supervisor that supervises it. A live Actor is reached by id through a Supervisor that supervises it — ${remedy}.`,
              comp.id,
              edgeDraft,
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
          const targetMethod = ctx.interfaceMethodsOf(target.id)
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

    // The same guard on a Portal's dispatch table: a binding that routes a
    // capability straight to a write-effect data-facade method is the write
    // shortcut declared as a route. A dispatch step reaches its server only
    // through such a binding, so judging every binding judges each dispatch
    // step that takes it — once, where the route is declared.
    for (const comp of ctx.components) {
      if (comp.componentType !== 'Portal' || !comp.dispatch || comp.dispatch.length === 0) continue;
      const isDraftCtx = ctx.isComponentDraft(comp.id);

      for (const binding of comp.dispatch) {
        const target = ctx.componentMap.get(binding.component);
        if (!target || (target.componentType !== 'Repository' && target.componentType !== 'Index')) continue;
        const targetMethod = ctx.interfaceMethodsOf(target.id)
          .find(m => m.name === binding.method);
        if (targetMethod?.effect !== 'write') continue;
        ctx.addIssue(
          'error',
          'PORTAL_WRITE_SHORTCUT',
          `Portal "${comp.id}": dispatch binding "${binding.capability}" routes to write-effect method ${target.id}.${binding.method} directly. The Portal→${target.componentType} shortcut is licensed for READS only — route the write through an Orchestrator that owns the workflow.`,
          comp.id,
          isDraftCtx || ctx.isComponentDraft(target.id),
        );
      }
    }
  },
};
