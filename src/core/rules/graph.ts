import { SddRule } from './types.js';
import { extractTypeIdentifiers, methodTypeRefs, passesIntentFloor, typeGenericParameters, typeMatchesRef } from '../../models/index.js';
import { walk, type WalkSeed } from './narrative-graph-projector.js';

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
 * components, declared lifecycle flows): unwired components/methods and
 * unreferenced types are flagged. The walk itself is the narrative graph
 * projector's.
 */
export const reachabilityRule: SddRule = {
  name: 'unused-detection',
  description:
    'Walks the narrative execution graph (call steps, register handoffs, dispatch-table routing, lifecycle flows) from every entrypoint (Portal/Observer/published component/lifecycle entrypoint/invokedBy-declared method) and flags components and methods no execution chain reaches, plus types no field or signature references. An interface method declaring invokedBy (a real caller outside the modeled graph) seeds the walk, so its narrative propagates reachability; the declaration itself is audited (thin caller prose, or a method the internal walk already reaches).',
  codes: [
    { code: 'UNUSED_COMPONENT', defaultSeverity: 'warning', summary: 'Component never reached by any narrative call chain' },
    { code: 'UNUSED_METHOD', defaultSeverity: 'warning', summary: 'Method never called by any narrative step' },
    { code: 'UNUSED_TYPE', defaultSeverity: 'warning', summary: 'Type never referenced by fields or signatures' },
    { code: 'INVOKED_BY_UNDESCRIBED', defaultSeverity: 'warning', summary: 'invokedBy declaration whose caller prose is missing or placeholder-thin' },
    { code: 'INVOKED_BY_REDUNDANT', defaultSeverity: 'warning', summary: 'invokedBy declaration on a method the internal narrative walk already reaches — stale, remove it' },
  ],
  check(ctx) {
    // Collect root entry points: Portals, Observers, components backing public
    // subsystem interfaces (all their methods), and declared lifecycle
    // entrypoints (the specific init/shutdown method the runtime invokes).
    const seeds: WalkSeed[] = [];
    for (const comp of ctx.components) {
      if (comp.componentType === 'Portal' || comp.componentType === 'Observer') {
        seeds.push({ compId: comp.id });
      }
    }
    for (const sub of ctx.subsystems) {
      for (const pi of sub.publicInterfaces) {
        if (pi.component) {
          seeds.push({ compId: pi.component });
        }
      }
      for (const le of sub.lifecycle ?? []) {
        seeds.push({ compId: le.component, methodName: le.method });
      }
    }

    // Phase 1 — the INTERNAL walk (no invokedBy seeds): the baseline that
    // decides whether an invokedBy declaration is redundant.
    const baseWalk = walk(ctx, seeds);

    // Audit invokedBy declarations and collect their entrypoint seeds.
    const invokedBySeeds: WalkSeed[] = [];
    for (const intf of ctx.interfaces) {
      // A declaration on an unresolvable component can't be judged (the
      // dangling reference is the hierarchy family's finding).
      if (!ctx.componentMap.has(intf.component)) continue;
      const comp = ctx.componentMap.get(intf.component)!;
      for (const m of intf.methods) {
        if (!m.invokedBy) continue;
        invokedBySeeds.push({ compId: intf.component, methodName: m.name });
        if (!ctx.isSpecInScope(intf.id)) continue;
        const isDraftCtx = comp.status === 'draft' || comp.status === 'design' || intf.status === 'draft' || intf.status === 'design';
        if (!passesIntentFloor(m.invokedBy.caller, m.name)) {
          ctx.addIssue(
            'warning',
            'INVOKED_BY_UNDESCRIBED',
            `Method "${m.name}" on component "${intf.component}" declares invokedBy (${m.invokedBy.kind}) but its "caller" prose is missing or placeholder-thin — state WHO invokes it and when, so the entrypoint claim stays reviewable.`,
            intf.id,
            isDraftCtx,
          );
        }
        if (baseWalk.reachesMethod(intf.component, m.name)) {
          ctx.addIssue(
            'warning',
            'INVOKED_BY_REDUNDANT',
            `Method "${m.name}" on component "${intf.component}" declares invokedBy (${m.invokedBy.kind}), but the internal narrative walk already reaches it — the declaration is stale; remove it.`,
            intf.id,
            isDraftCtx,
          );
        }
      }
    }

    // Phase 2 — the FULL walk (base seeds + invokedBy entrypoints) feeds the
    // UNUSED_* verdicts, so a declared external caller's narrative propagates.
    const reach = invokedBySeeds.length
      ? walk(ctx, [...seeds, ...invokedBySeeds])
      : baseWalk;

    // Generate warnings for unused components
    for (const comp of ctx.components) {
      if (!ctx.isSpecInScope(comp.id)) continue;
      if (!reach.reachesComponent(comp.id)) {
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
        for (const intf of ctx.interfacesByComponent.get(comp.id) ?? []) {
          for (const m of intf.methods) {
            if (!reach.reachesMethod(comp.id, m.name)) {
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
      if (ctx.isBuiltinType(ref)) return;
      for (const spec of ctx.types) {
        if (typeMatchesRef(spec, ref)) {
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
            Array.from(typeGenericParameters(t)).map(g => g.toLowerCase()),
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
