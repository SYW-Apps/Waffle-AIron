import { parseDeclaredCall } from '../../../models/index.js';
import type { ComponentSpec } from '../../../models/index.js';
import { SddRule } from '../types.js';

/**
 * Callers depend on the abstraction, so a call that reaches, on a concrete
 * implementer directly, a method any abstraction it implements declares,
 * directly or through the chain, skips the substitution: the caller stops
 * working when an implementer is added or replaced.
 */
export const abstractionBypassRule: SddRule = {
  name: 'abstraction-bypass',
  judges: 'design',
  description:
    "Callers depend on the abstraction, so a call step, declared call or dispatch binding that reaches, on a concrete implementer directly, a method any abstraction it implements declares, directly or through the chain (ctx.abstractionsOf), skips the substitution: the caller stops working when an implementer is added or replaced. Only a concrete target is judged: calling a narrower abstraction (`dog.eat` on an abstract Dog) is the substitution itself, never a bypass. Calling a method only the implementer declares is its own extra and is fine, and an implementer's own narrative may call its own methods. A decorator, an implementer that also depends on its abstraction and calls it, is legal: its call lands on the abstraction, not on a concrete implementer, and the walk terminates. A Portal over a Portal stays refused by entrypoint-dependencies, which is why a Portal abstraction is judged by parity rather than by calls.",
  codes: [
    { code: 'ABSTRACTION_BYPASSED', defaultSeverity: 'warning', summary: "A call step, declared call or dispatch binding reaches, on a concrete implementer directly, a method an abstraction it implements declares, at any level of the chain; calling the implementer's own extra method, or a narrower abstraction, is fine" },
  ],
  check(ctx) {
    // Step 1: each concrete implementer and every local abstraction it implements, directly or through
    // the chain; an alias::name entry is no local abstraction and is never judged here.
    const abstractionsOf = new Map<string, string[]>();
    for (const comp of ctx.components) {
      if (comp.abstract === true) continue;
      const local = ctx.abstractionsOf(comp.id).filter((id) => ctx.componentMap.get(id)?.abstract === true);
      if (local.length > 0) abstractionsOf.set(comp.id, local);
    }
    if (abstractionsOf.size === 0) return;

    const reported = new Set<string>();
    // Steps 3-4: does a call reach, on a concrete implementer, a method one of its abstractions
    // declares? A method only the implementer declares is its own extra, and a target that is
    // itself an abstraction is the substitution and is never judged.
    const judge = (caller: ComponentSpec, targetComp: string, targetMethod: string): void => {
      const abstractions = abstractionsOf.get(targetComp);
      if (!abstractions || caller.id === targetComp) return;
      for (const abstractionId of abstractions) {
        if (!ctx.interfaceMethodsOf(abstractionId).some((m) => m.name === targetMethod)) continue;
        const key = `${caller.id}>${targetComp}.${targetMethod}`;
        if (reported.has(key)) return;
        reported.add(key);
        ctx.addIssue(
          'warning',
          'ABSTRACTION_BYPASSED',
          `Component "${caller.id}" calls "${targetComp}.${targetMethod}" directly, but "${targetComp}" implements the abstraction "${abstractionId}", which declares "${targetMethod}". Depend on "${abstractionId}" and call it there, so "${caller.id}" keeps working when an implementer is added or replaced.`,
          caller.id,
          ctx.isComponentDraft(caller.id),
          undefined,
          // An edge and a method unit, the two forms a component or method rename rekeys.
          { at: `${caller.id} -> ${targetComp}`, covers: [`${targetComp}.${targetMethod}`] },
        );
        return;
      }
    };

    // Step 2: every call step, register step and declared call.
    for (const resolved of ctx.implementationMethods()) {
      for (const step of resolved.method.narrative ?? []) {
        if ((step.type === 'call' || step.type === 'register') && step.targetComponent && step.targetMethod) {
          judge(resolved.component, step.targetComponent, step.targetMethod);
        }
      }
      for (const ref of resolved.method.calls ?? []) {
        const parsed = parseDeclaredCall(ref);
        if (parsed) judge(resolved.component, parsed.compId, parsed.methodName);
      }
    }
    // … and every dispatch-table binding.
    for (const comp of ctx.components) {
      for (const b of comp.dispatch ?? []) judge(comp, b.component, b.method);
    }
  },
};
