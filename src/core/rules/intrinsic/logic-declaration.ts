import { SddRule } from '../types.js';
import { isRetired } from '../../../models/index.js';

/**
 * The INTRINSIC half of the dependency-class family: whether the declaration
 * itself belongs on this component. Logic is an Orchestrator, so a
 * dependencyClass is an Orchestrator property; what the class then allows is
 * the stereotype-dependencies verdict. The check reads one component's own
 * componentType + dependencyClass and nothing else, so this is `scope: 'spec'`
 * and also runs at the write boundary — a class on the wrong stereotype is
 * refused when authored. The schema refuses any value but pure and read before
 * a rule runs, so only the stereotype is judged here.
 */
export const logicDeclarationRule: SddRule = {
  name: 'logic-declaration',
  scope: 'spec',
  description:
    'Only an Orchestrator may declare a dependencyClass (DEPENDENCY_CLASS_ON_NON_ORCHESTRATOR); what the class allows is judged by stereotype-dependencies. Intrinsic to one component: no tree required.',
  codes: [
    { code: 'DEPENDENCY_CLASS_ON_NON_ORCHESTRATOR', defaultSeverity: 'error', summary: 'dependencyClass declared on a component that is not an Orchestrator' },
  ],
  check(ctx) {
    for (const comp of ctx.components) {
      const isDraftCtx = ctx.isComponentDraft(comp.id);

      // A retired component is skipped: a Specialist's STEREOTYPE_RETIRED is its
      // one finding, and its migration sets the class.
      if (comp.dependencyClass && comp.componentType !== 'Orchestrator' && !isRetired(comp)) {
        ctx.addIssue(
          'error',
          'DEPENDENCY_CLASS_ON_NON_ORCHESTRATOR',
          `Component "${comp.id}" (${comp.componentType}) declares dependencyClass "${comp.dependencyClass}" — a dependencyClass is an Orchestrator property, because logic is an Orchestrator. Drop it, or make the component an Orchestrator.`,
          comp.id,
          isDraftCtx,
        );
      }
    }
  },
};
