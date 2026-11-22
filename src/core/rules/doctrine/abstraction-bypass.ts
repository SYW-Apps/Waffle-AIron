import { parseDeclaredCall } from '../../../models/index.js';
import type { ComponentSpec } from '../../../models/index.js';
import { SddRule } from '../types.js';

/**
 * Callers depend on the abstraction, so a call that reaches, on an implementer
 * directly, a method its abstraction declares skips the substitution: the
 * caller stops working when an implementer is added or replaced.
 */
export const abstractionBypassRule: SddRule = {
  name: 'abstraction-bypass',
  judges: 'design',
  description:
    "Callers depend on the abstraction, so a call step, declared call or dispatch binding that reaches, on an implementer directly, a method its abstraction declares skips the substitution: the caller stops working when an implementer is added or replaced. Calling a method only the implementer declares is its own extra and is fine, and an implementer's own narrative may call its own methods. A Portal over a Portal stays refused by entrypoint-dependencies, which is why a Portal abstraction is judged by parity rather than by calls.",
  codes: [
    { code: 'ABSTRACTION_BYPASSED', defaultSeverity: 'warning', summary: "A call step, declared call or dispatch binding reaches, on an implementer directly, a method its abstraction declares; calling the implementer's own extra method is fine" },
  ],
  check(ctx) {
    // Step 1: each implementer component and the abstractions it implements (local entries).
    const abstractionsOf = new Map<string, string[]>();
    for (const intf of ctx.interfaces) {
      for (const entry of intf.implements ?? []) {
        if (entry.includes('::')) continue;
        if (ctx.componentMap.get(entry)?.abstract !== true) continue;
        abstractionsOf.set(intf.component, [...(abstractionsOf.get(intf.component) ?? []), entry]);
      }
    }
    if (abstractionsOf.size === 0) return;

    const reported = new Set<string>();
    // Steps 3-4: does a call reach, on an implementer, a method its abstraction
    // declares? A method only the implementer declares is its own extra.
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
          { at: `${targetComp}.${targetMethod}` },
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
