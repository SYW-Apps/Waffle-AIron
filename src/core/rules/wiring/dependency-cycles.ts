import { SddRule } from '../types.js';

/** Dependency-cycle detection over the component dependsOn graph. */
export const cyclesRule: SddRule = {
  name: 'dependency-cycles',
  description: 'The component dependsOn graph must be a DAG; the first cycle through a component in the run\'s scope is reported with its full path.',
  codes: [
    { code: 'CIRCULAR_DEPENDENCY', defaultSeverity: 'error', summary: 'Circular dependency between components' },
  ],
  check(ctx) {
    /**
     * A dependency path from startId back to itself, or undefined when there is
     * none: a depth-first search along dependsOn that visits each component at
     * most once. The search starts from each component in scope rather than
     * once over the whole graph, because a single search can close an
     * out-of-scope cycle first, or reach a component of the scope's cycle only
     * after an earlier descent has finished with it.
     */
    const cycleFrom = (startId: string): string[] | undefined => {
      const visited = new Set<string>([startId]);
      const pathTrace: string[] = [startId];
      const search = (compId: string): boolean => {
        for (const depId of ctx.componentMap.get(compId)?.dependsOn ?? []) {
          if (depId === startId) {
            pathTrace.push(depId);
            return true;
          }
          if (visited.has(depId)) continue;
          visited.add(depId);
          pathTrace.push(depId);
          if (search(depId)) return true;
          pathTrace.pop();
        }
        return false;
      };
      return search(startId) ? pathTrace : undefined;
    };

    for (const comp of ctx.components) {
      // A scoped run drops a finding anchored outside its subsystem, so it
      // judges the cycles through its own components.
      if (!ctx.isSpecInScope(comp.id)) continue;
      const cycle = cycleFrom(comp.id);
      if (!cycle) continue;
      // The path ends [..., closing, comp.id]: closing's dependency closes the cycle.
      const closing = cycle[cycle.length - 2];
      ctx.addIssue(
        'error',
        'CIRCULAR_DEPENDENCY',
        `Circular dependency detected: ${cycle.join(' -> ')}`,
        comp.id,
        ctx.isComponentDraft(comp.id) || ctx.isComponentDraft(closing),
      );
      return;
    }
  },
};
