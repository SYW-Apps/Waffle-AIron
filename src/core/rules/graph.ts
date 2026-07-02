import { SddRule } from './types.js';
import { BUILTIN_TYPES, extractTypeIdentifiers, extractTypeGenerics, methodTypeRefs, matchTypeRef } from './type-analysis.js';

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

/**
 * Reachability analysis from entrypoints (Portals, Observers, published
 * components): unwired components/methods and unreferenced types are flagged.
 */
export const reachabilityRule: SddRule = {
  name: 'unused-detection',
  description:
    'Walks the narrative call graph from every entrypoint (Portal/Observer/published component) and flags components and methods no execution chain reaches, plus types no field or signature references.',
  codes: [
    { code: 'UNUSED_COMPONENT', defaultSeverity: 'warning', summary: 'Component never reached by any narrative call chain' },
    { code: 'UNUSED_METHOD', defaultSeverity: 'warning', summary: 'Method never called by any narrative step' },
    { code: 'UNUSED_TYPE', defaultSeverity: 'warning', summary: 'Type never referenced by fields or signatures' },
  ],
  check(ctx) {
    const reachedComponents = new Set<string>();
    const reachedMethods = new Set<string>();
    const queue: { compId: string; methodName: string }[] = [];

    // Key with '#': component ids may themselves contain '::' (namespaced subprojects),
    // so '::' cannot separate component from method.
    const methodKey = (compId: string, methodName: string) => `${compId}#${methodName}`;

    // Collect root entry points (Portals, Observers, and components backing public subsystem interfaces)
    const rootComponents = new Set<string>();
    for (const comp of ctx.components) {
      if (comp.componentType === 'Portal' || comp.componentType === 'Observer') {
        rootComponents.add(comp.id);
      }
    }
    for (const sub of ctx.subsystems) {
      for (const pi of sub.publicInterfaces) {
        if (pi.component) {
          rootComponents.add(pi.component);
        }
      }
    }

    // Initialize queue with methods of root components (across ALL their interfaces)
    for (const compId of rootComponents) {
      reachedComponents.add(compId);
      for (const intf of ctx.interfaces.filter(i => i.component === compId)) {
        for (const m of intf.methods) {
          const key = methodKey(compId, m.name);
          if (!reachedMethods.has(key)) {
            reachedMethods.add(key);
            queue.push({ compId, methodName: m.name });
          }
        }
      }
    }

    // Traverse the call graph recursively
    while (queue.length > 0) {
      const { compId, methodName } = queue.shift()!;

      // The method may be implemented against any of the component's interfaces.
      const compInterfaceIds = new Set(ctx.interfaces.filter(i => i.component === compId).map(i => i.id));
      const impl = ctx.implementations.find(
        imp => compInterfaceIds.has(imp.contract) && imp.methods.some(m => m.name === methodName),
      );
      if (!impl) continue;

      const methodImpl = impl.methods.find(m => m.name === methodName)!;

      for (const step of methodImpl.narrative) {
        if (step.type === 'call' && step.targetComponent && step.targetMethod) {
          reachedComponents.add(step.targetComponent);
          const targetKey = methodKey(step.targetComponent, step.targetMethod);
          if (!reachedMethods.has(targetKey)) {
            reachedMethods.add(targetKey);
            queue.push({ compId: step.targetComponent, methodName: step.targetMethod });
          }
        }
      }
    }

    // Generate warnings for unused components
    for (const comp of ctx.components) {
      if (!ctx.isSpecInScope(comp.id)) continue;
      if (!reachedComponents.has(comp.id)) {
        const isDraftCtx = comp.status === 'draft' || comp.status === 'design';
        ctx.addIssue(
          'warning',
          'UNUSED_COMPONENT',
          `Component "${comp.id}" is defined but never reached by any execution call chain starting from portals or entry points.`,
          comp.id,
          isDraftCtx,
        );
      } else {
        // Warn about unused methods on this reached component (across ALL its interfaces)
        for (const intf of ctx.interfaces.filter(i => i.component === comp.id)) {
          for (const m of intf.methods) {
            if (!reachedMethods.has(methodKey(comp.id, m.name))) {
              const isDraftCtx = comp.status === 'draft' || comp.status === 'design' || intf.status === 'draft' || intf.status === 'design';
              ctx.addIssue(
                'warning',
                'UNUSED_METHOD',
                `Method "${m.name}" on component "${comp.id}" is defined but never called by any narrative step.`,
                comp.id,
                isDraftCtx,
              );
            }
          }
        }
      }
    }

    // Generate warnings for unused types
    const referencedTypes = new Set<string>();
    const markTypeReferenced = (ref: string) => {
      const refLower = ref.toLowerCase();
      if (BUILTIN_TYPES.has(refLower)) return;
      for (const spec of ctx.types) {
        const typeQualifiedId = spec.subsystem && !spec.id.startsWith(`${spec.subsystem}::`)
          ? `${spec.subsystem}::${spec.id}`
          : spec.id;
        if (matchTypeRef(ref, typeQualifiedId)) {
          referencedTypes.add(spec.id);
        }
      }
    };

    // 1. Scan type fields
    for (const t of ctx.types) {
      for (const field of t.fields) {
        const refs = extractTypeIdentifiers(field.type);
        for (const ref of refs) {
          const typeGenerics = new Set(
            Array.from(extractTypeGenerics(t.name)).map(g => g.toLowerCase()),
          );
          if (typeGenerics.has(ref.toLowerCase())) {
            continue;
          }
          markTypeReferenced(ref);
        }
      }
    }

    // 2. Scan interface method signatures & returns (structured params preferred)
    for (const intf of ctx.interfaces) {
      for (const m of intf.methods) {
        const refs = methodTypeRefs(m);
        for (const ref of refs) {
          markTypeReferenced(ref);
        }
      }
    }

    for (const t of ctx.types) {
      if (!ctx.isSpecInScope(t.id)) continue;
      if (!referencedTypes.has(t.id)) {
        const sub = ctx.subsystems.find(s => s.id === t.subsystem);
        const isDraftCtx = sub ? (sub.status === 'draft' || sub.status === 'design') : false;
        ctx.addIssue(
          'warning',
          'UNUSED_TYPE',
          `Type "${t.id}" is defined but never referenced by any type fields or interface methods.`,
          t.id,
          isDraftCtx,
        );
      }
    }
  },
};
