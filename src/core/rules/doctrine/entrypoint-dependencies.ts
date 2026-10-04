import { SddRule, type RuleContext } from '../types.js';
import { isRetired } from '../../../models/index.js';
import { isPureLogic, stereotypeOf, storeResolutionHint } from './stereotype-terms.js';

/**
 * The Registries each Supervisor maintains: the ones it owns as its
 * supervision state, and the ones it reaches with lifecycle-effect calls
 * (registering and unregistering what exists). A live Actor's callers look it
 * up by id through such a Registry — the hop the code really takes.
 */
function maintainedRegistries(ctx: RuleContext): Map<string, string[]> {
  const maintained = new Map<string, Set<string>>();
  const add = (supervisorId: string, registryId: string): void => {
    let set = maintained.get(supervisorId);
    if (!set) maintained.set(supervisorId, (set = new Set<string>()));
    set.add(registryId);
  };
  for (const comp of ctx.components) {
    if (comp.componentType !== 'Supervisor' || isRetired(comp)) continue;
    for (const memberId of comp.owns) {
      if (ctx.componentMap.get(memberId)?.componentType === 'Registry') add(comp.id, memberId);
    }
  }
  for (const impl of ctx.implementations) {
    const contract = ctx.interfaceMap.get(impl.contract);
    const supervisor = contract ? ctx.componentMap.get(contract.component) : undefined;
    if (!supervisor || supervisor.componentType !== 'Supervisor' || isRetired(supervisor)) continue;
    for (const implMethod of impl.methods) {
      for (const step of implMethod.narrative) {
        if (step.type !== 'call' || !step.targetComponent || !step.targetMethod) continue;
        if (ctx.componentMap.get(step.targetComponent)?.componentType !== 'Registry') continue;
        const called = ctx.interfaceMethodsOf(step.targetComponent).find(m => m.name === step.targetMethod);
        if (called?.effect === 'lifecycle') add(supervisor.id, step.targetComponent);
      }
    }
  }
  return new Map([...maintained].map(([id, set]) => [id, [...set]]));
}

/**
 * The blocks at the system's edges: who may be depended upon at the top
 * (nobody depends on a Portal or an Observer), what those top blocks and a
 * View may reach downward, and how the process layer is entered — a Supervisor
 * stays out of presentation, and a live Actor is reached through its
 * supervision: a Supervisor that supervises it, or a Registry such a
 * Supervisor maintains.
 */
export const entrypointDepsRule: SddRule = {
  name: 'entrypoint-dependencies',
  judges: 'design',
  description:
    'Judges the edges at the system\'s entry points and its process layer. Portals and Observers are top-level entry points and subscribers, so nothing may depend on them — and that is the edge\'s one finding, which is why no other matrix rule judges it. Downward, a Portal dispatches to Orchestrators and may READ through Indexes and Repository facades but never reaches Store/Registry/Query or an Adapter, while an Observer forwards to one Orchestrator or Supervisor over a message-bus Adapter. A View stays a passive presenter. A Supervisor stays out of presentation; what it may do to the data it reaches is judged per call (supervisor-shared-data), and what it owns as its supervision state by the ownership rules. A component depending on a live Actor reaches it through the Actor\'s supervision: by depending on a Supervisor that supervises it, or on a Registry such a Supervisor maintains (owns, or calls with lifecycle-effect methods) — the lookup hop callers really take.',
  codes: [
    { code: 'ARCHITECTURE_VIOLATION_PORTAL_DEP', defaultSeverity: 'error', summary: 'Component depending on a Portal/Observer' },
    { code: 'ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP', defaultSeverity: 'error', summary: 'Portal/Observer reaching the data layer directly' },
    { code: 'ARCHITECTURE_VIOLATION_VIEW_DEP', defaultSeverity: 'error', summary: 'View depending on persistence layers or on logic that is not pure' },
    { code: 'ARCHITECTURE_VIOLATION_SUPERVISOR_DEP', defaultSeverity: 'error', summary: 'Supervisor depending on a presentation block (View, FeatureComponent, RouterComponent) — a Supervisor manages live processes; the data it reaches is judged per call by supervisor-shared-data' },
    { code: 'ACTOR_REACHED_WITHOUT_SUPERVISOR', defaultSeverity: 'error', summary: 'Component depending on a live Actor it does not supervise, reaching it neither through a Supervisor that supervises it nor through a Registry such a Supervisor maintains — model the real lookup hop' },
  ],
  check(ctx) {
    const lookups = maintainedRegistries(ctx);
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

      // Supervisor rule: a Supervisor manages live processes and stays out of
      // presentation. The data blocks it reaches are judged per call
      // (supervisor-shared-data), what it owns by the ownership rules; a
      // Portal or Observer target was reported above, once.
      if (comp.componentType === 'Supervisor'
        && ['View', 'FeatureComponent', 'RouterComponent'].includes(depComp.componentType)) {
        ctx.addIssue(
          'error',
          'ARCHITECTURE_VIOLATION_SUPERVISOR_DEP',
          `Architectural violation: Supervisor "${comp.id}" cannot depend on ${stereotypeOf(depComp)} "${depComp.id}". A Supervisor manages live processes and stays out of presentation — the UI reaches the system through its Portals and workflows, never through a Supervisor's dependencies.`,
          comp.id,
          edge.draftContext,
        );
      }

      // A live Actor is reached through its supervision: a Supervisor
      // depending on the Actor supervises it, and any other component reaches
      // it through such a Supervisor or through a Registry one maintains —
      // the lookup hop a caller really takes to find a live process by id.
      if (depComp.componentType === 'Actor' && comp.componentType !== 'Supervisor') {
        const supervisors = ctx.components.filter(c => c.componentType === 'Supervisor' && c.dependsOn.includes(depComp.id));
        const registries = supervisors.flatMap(s => (lookups.get(s.id) ?? []).map(registry => ({ registry, supervisor: s.id })));
        const reached = supervisors.some(s => comp.dependsOn.includes(s.id))
          || registries.some(r => comp.dependsOn.includes(r.registry));
        if (!reached) {
          let remedy: string;
          if (registries.length > 0) {
            remedy = `depend on ${registries.length === 1 ? 'the Registry' : 'one of the Registries'} its Supervisor maintains (${registries.map(r => `"${r.registry}", kept by "${r.supervisor}"`).join('; ')}) and look the Actor up by id there`;
          } else if (supervisors.length > 0) {
            remedy = `${supervisors.length === 1 ? 'its Supervisor' : 'its Supervisors'} (${supervisors.map(s => `"${s.id}"`).join(', ')}) maintain no Registry of its live handles yet: model that lookup as a Registry the Supervisor keeps through lifecycle-effect methods (registering and unregistering a live handle), and depend on that Registry`;
          } else {
            remedy = `no Supervisor depends on "${depComp.id}" yet: give it a Supervisor that depends on it and maintains a Registry of its live handles through lifecycle-effect methods, and depend on that Registry`;
          }
          ctx.addIssue(
            'error',
            'ACTOR_REACHED_WITHOUT_SUPERVISOR',
            `Architectural violation: ${stereotypeOf(comp)} "${comp.id}" depends on the live Actor "${depComp.id}" without reaching it through its supervision. A live Actor is found by id through a Registry its Supervisor maintains, or messaged through that Supervisor — ${remedy}.`,
            comp.id,
            edge.draftContext,
          );
        }
      }
    }
  },
};
