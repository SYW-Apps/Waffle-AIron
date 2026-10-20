import { SddRule, type RuleContext } from '../types.js';
import { callClaims, claimSite, type ComponentSpec, type MethodSignature } from '../../../models/index.js';

/**
 * The Portal read-face guard. A Portal may reach a Repository facade or an
 * Index directly, but that shortcut is licensed for READS only: a call or a
 * dispatch route that lands on a write-effect method is the persistence
 * shortcut in disguise, and writes go through the workflow layer. Untagged
 * methods are not judged — effect tags are the mechanism, and
 * MISSING_EFFECT_TAG drives their adoption on durable stores.
 */
export const portalWriteShortcutRule: SddRule = {
  name: 'portal-write-shortcut',
  judges: 'design',
  description:
    'A Portal narrative call step, declared call or dispatch-table binding that reaches a write- or lifecycle-effect method on a Repository or Index directly is the write shortcut: the Portal→data-facade edge is licensed for reads only, and a mutation — a write, or a lifecycle change to what exists — routes through an Orchestrator that owns the workflow. A dispatch step reaches its server only through a table binding, so judging every binding judges each dispatch step that takes it, once, where the route is declared. Methods that carry no effect tag are not judged.',
  codes: [
    { code: 'PORTAL_WRITE_SHORTCUT', defaultSeverity: 'error', summary: 'Portal narrative call step, declared call or dispatch-table binding reaches a write- or lifecycle-effect method on a Repository/Index directly — reads may shortcut, mutations route through an Orchestrator (judged on effect-tagged facade methods; untagged methods are not yet judged)' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      const component = contract ? ctx.componentMap.get(contract.component) : undefined;
      if (!component || component.componentType !== 'Portal') continue;
      const isDraftCtx = ctx.isImplementationDraft(impl);

      for (const implMethod of impl.methods) {
        for (const claim of callClaims(implMethod)) {
          const target = ctx.componentMap.get(claim.component);
          const targetMethod = target ? portalShortcutMethod(ctx, target, claim.method) : undefined;
          if (!target || !targetMethod) continue;
          ctx.addIssue(
            'error',
            'PORTAL_WRITE_SHORTCUT',
            `Portal "${component.id}": ${claimSite(claim)} of "${implMethod.name}" calls ${targetMethod.effect}-effect method ${target.id}.${claim.method} directly. The Portal→${target.componentType} shortcut is licensed for READS only — route the ${targetMethod.effect === 'write' ? 'write' : 'lifecycle change'} through an Orchestrator that owns the workflow.`,
            impl.id,
            isDraftCtx || ctx.isComponentDraft(target.id),
          );
        }
      }
    }

    // The same guard on a Portal's dispatch table: a binding that routes a
    // capability straight to a write-effect data-facade method is the write
    // shortcut declared as a route. A dispatch step reaches its server only
    // through such a binding, so judging every binding judges each dispatch
    // step that takes it — once, where the route is declared.
    for (const comp of ctx.components) {
      if (comp.componentType !== 'Portal' || !comp.dispatch || comp.dispatch.length === 0) continue;
      const isDraftCtx = ctx.isComponentDraft(comp.id);

      for (const binding of comp.dispatch) {
        const target = ctx.componentMap.get(binding.component);
        const targetMethod = target ? portalShortcutMethod(ctx, target, binding.method) : undefined;
        if (!target || !targetMethod) continue;
        ctx.addIssue(
          'error',
          'PORTAL_WRITE_SHORTCUT',
          `Portal "${comp.id}": dispatch binding "${binding.capability}" routes to ${targetMethod.effect}-effect method ${target.id}.${binding.method} directly. The Portal→${target.componentType} shortcut is licensed for READS only — route the ${targetMethod.effect === 'write' ? 'write' : 'lifecycle change'} through an Orchestrator that owns the workflow.`,
          comp.id,
          isDraftCtx || ctx.isComponentDraft(target.id),
        );
      }
    }
  },
};

/**
 * The method a Portal's direct call would mutate through, when it is one: a
 * write- or lifecycle-effect method of a Repository or an Index. Anything else
 * — another stereotype, a read, or a method that carries no effect tag — is
 * not this rule's to judge, and answers undefined. The rule asks it of every
 * call step and binding; directEdgeRefusals asks it of the call a forwarder's
 * Portal caller would make instead, so a forwarder in front of a write is
 * required exactly when this rule would refuse the shortcut.
 */
export function portalShortcutMethod(ctx: RuleContext, target: ComponentSpec, methodName: string): MethodSignature | undefined {
  if (target.componentType !== 'Repository' && target.componentType !== 'Index') return undefined;
  const targetMethod = ctx.interfaceMethodsOf(target.id).find(m => m.name === methodName);
  return targetMethod?.effect === 'write' || targetMethod?.effect === 'lifecycle' ? targetMethod : undefined;
}
