import { SddRule } from '../types.js';
import { isPureLogic, stereotypeOf, storeResolutionHint } from './stereotype-terms.js';

/**
 * The blocks at the system's edges: who may be depended upon at the top
 * (nobody depends on a Portal or an Observer), what those top blocks and a
 * View may reach downward, and how the process layer is entered — a Supervisor
 * reaches data only through workflows, and a live Actor is reached by id
 * through a Supervisor that supervises it.
 */
export const entrypointDepsRule: SddRule = {
  name: 'entrypoint-dependencies',
  description:
    'Judges the edges at the system\'s entry points and its process layer. Portals and Observers are top-level entry points and subscribers, so nothing may depend on them — and that is the edge\'s one finding, which is why no other matrix rule judges it. Downward, a Portal dispatches to Orchestrators and may READ through Indexes and Repository facades but never reaches Store/Registry/Query or an Adapter, while an Observer forwards to one Orchestrator or Supervisor over a message-bus Adapter. A View stays a passive presenter. A Supervisor reaches data only through workflows, and a component depending on a live Actor must also depend on a Supervisor that supervises it.',
  codes: [
    { code: 'ARCHITECTURE_VIOLATION_PORTAL_DEP', defaultSeverity: 'error', summary: 'Component depending on a Portal/Observer' },
    { code: 'ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP', defaultSeverity: 'error', summary: 'Portal/Observer reaching the data layer directly' },
    { code: 'ARCHITECTURE_VIOLATION_VIEW_DEP', defaultSeverity: 'error', summary: 'View depending on persistence layers or on logic that is not pure' },
    { code: 'ARCHITECTURE_VIOLATION_SUPERVISOR_DEP', defaultSeverity: 'error', summary: 'Supervisor depending on anything but Actors, Orchestrators, Adapters or other Supervisors — it reaches data only through workflows' },
    { code: 'ACTOR_REACHED_WITHOUT_SUPERVISOR', defaultSeverity: 'error', summary: 'Component depending on a live Actor it does not supervise, without also depending on a Supervisor that supervises it — a live Actor is reached by id through its Supervisor' },
  ],
  check(ctx) {
    for (const edge of ctx.dependencyEdges().matrix) {
      const comp = edge.from;
      const depComp = edge.to;
      const storeHint = depComp.componentType === 'Store' ? storeResolutionHint(comp.componentType, depComp.id) : '';

      // Portal/Observer dependency boundary: components cannot depend on
      // Portals or Observers. That is the edge's one finding — neither the
      // checks below nor the other matrix rules report the same edge again.
      if (depComp.componentType === 'Portal' || depComp.componentType === 'Observer') {
        ctx.addIssue(
          'error',
          'ARCHITECTURE_VIOLATION_PORTAL_DEP',
          `Architectural violation: Component "${comp.id}" cannot depend on ${depComp.componentType} component "${depComp.id}". ${depComp.componentType}s are top-level entry points/subscribers and cannot be dependencies.`,
          comp.id,
          edge.draftContext,
        );
        continue;
      }

      // Portal dispatches to Orchestrators, and may READ through Indexes and
      // Repository facades (the per-entity empty-Orchestrator ceremony is
      // not required for passthrough reads) — but its WRITES always route
      // through the workflow layer (portal-write-shortcut), and the raw data
      // blocks (Store/Registry/Query) plus Adapters stay out of reach.
      // Observer forwards to one Orchestrator/Supervisor and may use a
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
            edge.draftContext,
          );
        }
      }

      // View rule: a passive presenter. Decoupled from persistence and
      // boundary blocks, it uses pure logic at most.
      if (comp.componentType === 'View'
        && (['Store', 'Registry', 'Index', 'Query', 'Adapter', 'Repository'].includes(depComp.componentType)
          || (depComp.componentType === 'Orchestrator' && !isPureLogic(depComp)))) {
        ctx.addIssue(
          'error',
          'ARCHITECTURE_VIOLATION_VIEW_DEP',
          `Architectural violation: View component "${comp.id}" cannot depend on ${stereotypeOf(depComp)} component "${depComp.id}". Views must remain passive UI blocks that use pure logic at most.`
          + storeHint,
          comp.id,
          edge.draftContext,
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
          edge.draftContext,
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
            edge.draftContext,
          );
        }
      }
    }
  },
};
