import { SddRule } from '../types.js';
import { isPureLogic, isReadLogic, stereotypeOf, storeResolutionHint } from './stereotype-terms.js';

/**
 * Logic is an Orchestrator, and its dependencyClass bounds what it may depend
 * on. Pure logic computes over the values it is handed, so it depends only on
 * other pure logic. Read logic may also read: through read logic, a
 * Repository, an Index or an Adapter. Unset, the Orchestrator is a workflow
 * and this rule has nothing to say about it.
 */
export const logicDependencyClassRule: SddRule = {
  name: 'logic-dependency-class',
  description:
    'Bounds an Orchestrator\'s dependencies by the dependencyClass it declares: pure logic depends only on pure Orchestrators; read logic also on read Orchestrators, Repositories, Indexes and Adapters; an Orchestrator that declares no class is a workflow and may depend on anything the rest of the matrix allows. Whether read logic calls a WRITE method on one of those is judged only once facade methods carry effect tags.',
  codes: [
    { code: 'DEPENDENCY_CLASS_VIOLATION', defaultSeverity: 'error', summary: 'Orchestrator depending on a component its dependencyClass does not allow: pure logic depends only on pure Orchestrators; read logic also on read Orchestrators, Repositories, Indexes and Adapters' },
  ],
  check(ctx) {
    for (const edge of ctx.dependencyEdges().matrix) {
      const comp = edge.from;
      const depComp = edge.to;

      // A Portal or Observer target is entrypoint-dependencies' one finding on
      // that edge (ARCHITECTURE_VIOLATION_PORTAL_DEP): no consumer-side matrix
      // check reports the same edge again.
      if (depComp.componentType === 'Portal' || depComp.componentType === 'Observer') continue;

      const depPure = isPureLogic(depComp);
      const storeHint = depComp.componentType === 'Store' ? storeResolutionHint(comp.componentType, depComp.id) : '';

      if (isPureLogic(comp) && !depPure) {
        ctx.addIssue(
          'error',
          'DEPENDENCY_CLASS_VIOLATION',
          `Architectural violation: Orchestrator "${comp.id}" (dependencyClass pure) cannot depend on ${stereotypeOf(depComp)} "${depComp.id}". Pure logic depends only on pure Orchestrators — move that dependency to the workflow that calls "${comp.id}", or declare "${comp.id}" read when it reads through read logic, a Repository, an Index or an Adapter.`
          + storeHint,
          comp.id,
          edge.draftContext,
        );
      }
      if (isReadLogic(comp) && !depPure && !isReadLogic(depComp)
        && !['Repository', 'Index', 'Adapter'].includes(depComp.componentType)) {
        ctx.addIssue(
          'error',
          'DEPENDENCY_CLASS_VIOLATION',
          `Architectural violation: Orchestrator "${comp.id}" (dependencyClass read) cannot depend on ${stereotypeOf(depComp)} "${depComp.id}". Read logic depends only on pure or read Orchestrators, Repositories, Indexes and Adapters — move that dependency to the workflow that calls "${comp.id}", or unset the dependencyClass of "${comp.id}" when it is itself a workflow.`
          + storeHint,
          comp.id,
          edge.draftContext,
        );
      }
    }
  },
};
