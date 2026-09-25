import { SddRule, type RuleContext } from '../types.js';
import { ambiguityMessage } from '../../../models/index.js';

/**
 * The bounded-context boundary: what a dependsOn id may reach once it leaves
 * its own subsystem, and what it means when it reaches nothing at all. The
 * intra-subsystem stereotype matrix is judged by the four rules beside this
 * one and never applies across a boundary.
 */
export const subsystemBoundaryDepsRule: SddRule = {
  name: 'subsystem-boundary-dependencies',
  description:
    'Judges every dependsOn edge that leaves its own subsystem, and every one that resolves nowhere. Across subsystems the shape is client Adapter → published remote Portal, OR a direct in-process edge licensed by a trustedLink declared on the SOURCE subsystem (the published-Portal target requirement applies either way). A published surface may also name the subsystems it serves (a publicInterfaces entry\'s consumers): a component every one of whose entries names consumers may be depended on only from those subsystems, which is how a provider keeps a surface — the raw spec writes — away from a door that must not reach it. A reference that names nothing in this tree is resolved against the stored surface snapshots: a hit is a DECLARED remote portal and the same Adapter requirement applies to it, snapshots of several providers that disagree make the reference ambiguous, and a reference authored to leave this root that no snapshot covers warns instead of erroring. Boundary rules are never relaxed by a pack profile.',
  codes: [
    { code: 'INVALID_DEPENDENCY_REFERENCE', defaultSeverity: 'error', summary: 'dependsOn names a non-existent component' },
    { code: 'CROSS_TREE_REF_UNRESOLVED', defaultSeverity: 'warning', summary: 'Cross-tree dependsOn (super::/:: form) with no surface snapshot covering it' },
    { code: 'SURFACE_REF_AMBIGUOUS', defaultSeverity: 'error', summary: 'Cross-tree dependsOn matched by surface snapshots of several providers with different contracts' },
    { code: 'CROSS_SUBSYSTEM_NON_ADAPTER', defaultSeverity: 'error', summary: 'Non-Adapter component crossing a subsystem boundary' },
    { code: 'CROSS_SUBSYSTEM_PRIVATE_ACCESS', defaultSeverity: 'error', summary: 'Cross-subsystem dependency on an unpublished component' },
    { code: 'CROSS_SUBSYSTEM_TARGET_NON_PORTAL', defaultSeverity: 'error', summary: 'Cross-subsystem hop entering through a non-Portal' },
    { code: 'CROSS_SUBSYSTEM_UNLISTED_CONSUMER', defaultSeverity: 'error', summary: 'Cross-subsystem dependency on a surface published only to other subsystems' },
  ],
  check(ctx) {
    for (const edge of ctx.dependencyEdges().all) {
      // An edge with a retired end (a Specialist or Gateway) is judged by no
      // boundary rule: retired-stereotypes reports the retired component once,
      // and its migration decides what the edge becomes. A reference that
      // resolved NOTHING is never marked retired, so it is still judged here.
      if (edge.retired) continue;
      const comp = edge.from;

      switch (edge.reach) {
        case 'missing':
          ctx.addIssue(
            'error',
            'INVALID_DEPENDENCY_REFERENCE',
            `Component "${comp.id}" lists dependency "${edge.ref}" which does not exist.`,
            comp.id,
            edge.draftContext,
          );
          continue;

        case 'unpinned':
          ctx.addIssue(
            'warning',
            'CROSS_TREE_REF_UNRESOLVED',
            `Component "${comp.id}" depends on cross-tree component "${edge.ref}", and no surface snapshot covers it — validate from the parent project, pin the family surfaces ("wairon surface pin"), or import the producing project's surface.`,
            comp.id,
            edge.draftContext,
          );
          continue;

        case 'ambiguous':
          // Snapshots of several providers expose the name with different
          // contracts, so none of them may judge the edge: the ambiguity is
          // the finding. The reach carries the resolution that decided it.
          ctx.addIssue(
            'error',
            'SURFACE_REF_AMBIGUOUS',
            ambiguityMessage(edge.surface!, `Component "${comp.id}" depends on`, edge.ref),
            comp.id,
            edge.draftContext,
          );
          continue;

        case 'surface':
          // A snapshot DECLARES the remote surface, so the cross-boundary
          // shape rule (the source must be an Adapter) applies exactly as it
          // does to a cross-subsystem edge. surfaceResolved: verified against
          // the vendored snapshot — a genuine boundary verdict that keeps full
          // strength even when this tree is a chained subproject validated
          // standalone.
          if (comp.componentType !== 'Adapter') {
            const provider = edge.surface!.kind === 'resolved' ? edge.surface!.snapshot.projectName : '';
            ctx.addIssue(
              'error',
              'CROSS_SUBSYSTEM_NON_ADAPTER',
              `Boundary violation: ${comp.componentType} "${comp.id}" depends directly on "${edge.ref}", a surface of project "${provider}". Only a local client Adapter may cross a project boundary — route this hop through an Adapter.`,
              comp.id,
              edge.draftContext,
              true,
            );
          }
          continue;

        case 'cross-subsystem':
          break;

        default:
          // An intra-subsystem edge: the stereotype matrix judges it.
          continue;
      }

      const depComp = edge.to!;

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
          edge.draftContext,
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
          edge.draftContext,
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
          edge.draftContext,
        );
      }

      // The consumer check runs whatever the portal check said: a surface
      // published to a named set of subsystems may be depended on only from
      // those — it is how a provider keeps a surface (the raw spec writes)
      // away from a door that must not reach it.
      const publishedTo = restrictedConsumers(ctx, depComp.subsystem, depComp.id);
      if (publishedTo && !publishedTo.includes(comp.subsystem)) {
        ctx.addIssue(
          'error',
          'CROSS_SUBSYSTEM_UNLISTED_CONSUMER',
          `Boundary violation: "${comp.id}" (subsystem "${comp.subsystem}") depends on "${depComp.id}", which subsystem "${depComp.subsystem}" publishes only to ${publishedTo.map((s) => `"${s}"`).join(', ')}. Depend on a surface published to "${comp.subsystem}" instead, or — when "${comp.subsystem}" really is a caller the provider meant to serve — add it to the entry's consumers.`,
          comp.id,
          edge.draftContext,
        );
      }
    }
  },
};

/**
 * Who a published component may be depended on by, or null when anyone may.
 * A component is restricted when EVERY publicInterfaces entry of its subsystem
 * that names it declares consumers, and the union of those lists is the set;
 * one entry without the field publishes it to anyone. A component no entry
 * names is not published at all — CROSS_SUBSYSTEM_PRIVATE_ACCESS's question,
 * not this one's — so it answers null rather than an empty set.
 */
function restrictedConsumers(ctx: RuleContext, subsystemId: string, componentId: string): string[] | null {
  const entries = (ctx.subsystems.find((s) => s.id === subsystemId)?.publicInterfaces ?? [])
    .filter((pi) => pi.component === componentId);
  if (entries.length === 0 || entries.some((pi) => pi.consumers === undefined)) return null;
  return [...new Set(entries.flatMap((pi) => pi.consumers ?? []))];
}
