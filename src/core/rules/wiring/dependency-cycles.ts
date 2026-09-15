import { SddRule } from '../types.js';

/** Dependency-cycle detection over the component dependsOn graph. */
export const cyclesRule: SddRule = {
  name: 'dependency-cycles',
  description: 'The component dependsOn graph must be a DAG; the first detected cycle is reported with its full path.',
  codes: [
    { code: 'CIRCULAR_DEPENDENCY', defaultSeverity: 'error', summary: 'Circular dependency between components' },
  ],
  check(ctx) {
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const dfs = (compId: string, pathTrace: string[]): boolean => {
      visited.add(compId);
      recStack.add(compId);
      pathTrace.push(compId);

      const comp = ctx.componentMap.get(compId);
      if (comp) {
        for (const depId of comp.dependsOn) {
          if (!visited.has(depId)) {
            if (dfs(depId, pathTrace)) {
              recStack.delete(compId);
              pathTrace.pop();
              return true;
            }
          } else if (recStack.has(depId)) {
            pathTrace.push(depId);
            const cyclePath = pathTrace.slice(pathTrace.indexOf(depId)).join(' -> ');
            const isDraftCtx = ctx.isComponentDraft(compId) || ctx.isComponentDraft(depId);
            ctx.addIssue(
              'error',
              'CIRCULAR_DEPENDENCY',
              `Circular dependency detected: ${cyclePath}`,
              compId,
              isDraftCtx,
            );
            pathTrace.pop();
            recStack.delete(compId);
            pathTrace.pop();
            return true;
          }
        }
      }

      recStack.delete(compId);
      pathTrace.pop();
      return false;
    };

    for (const comp of ctx.components) {
      if (!visited.has(comp.id)) {
        if (dfs(comp.id, [])) {
          break;
        }
      }
    }
  },
};
