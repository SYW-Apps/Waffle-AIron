import { SddRule } from '../types.js';

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
  description:
    'A Portal narrative call step or dispatch-table binding that reaches a write-effect method on a Repository or Index directly is the write shortcut: the Portal→data-facade edge is licensed for reads only, and a write routes through an Orchestrator that owns the workflow. A dispatch step reaches its server only through a table binding, so judging every binding judges each dispatch step that takes it, once, where the route is declared. Methods that carry no effect tag are not judged.',
  codes: [
    { code: 'PORTAL_WRITE_SHORTCUT', defaultSeverity: 'error', summary: 'Portal narrative call or dispatch-table binding reaches a write-effect method on a Repository/Index directly — reads may shortcut, writes route through an Orchestrator (judged on effect-tagged facade methods; untagged methods are not yet judged)' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      const component = contract ? ctx.componentMap.get(contract.component) : undefined;
      if (!component || component.componentType !== 'Portal') continue;
      const isDraftCtx = ctx.isImplementationDraft(impl);

      for (const implMethod of impl.methods) {
        for (const step of implMethod.narrative) {
          if (step.type !== 'call' || !step.targetComponent || !step.targetMethod) continue;
          const target = ctx.componentMap.get(step.targetComponent);
          if (!target || (target.componentType !== 'Repository' && target.componentType !== 'Index')) continue;
          const targetMethod = ctx.interfaceMethodsOf(target.id)
            .find(m => m.name === step.targetMethod);
          if (targetMethod?.effect !== 'write') continue;
          ctx.addIssue(
            'error',
            'PORTAL_WRITE_SHORTCUT',
            `Portal "${component.id}": step ${step.stepNumber} of "${implMethod.name}" calls write-effect method ${target.id}.${step.targetMethod} directly. The Portal→${target.componentType} shortcut is licensed for READS only — route the write through an Orchestrator that owns the workflow.`,
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
        if (!target || (target.componentType !== 'Repository' && target.componentType !== 'Index')) continue;
        const targetMethod = ctx.interfaceMethodsOf(target.id)
          .find(m => m.name === binding.method);
        if (targetMethod?.effect !== 'write') continue;
        ctx.addIssue(
          'error',
          'PORTAL_WRITE_SHORTCUT',
          `Portal "${comp.id}": dispatch binding "${binding.capability}" routes to write-effect method ${target.id}.${binding.method} directly. The Portal→${target.componentType} shortcut is licensed for READS only — route the write through an Orchestrator that owns the workflow.`,
          comp.id,
          isDraftCtx || ctx.isComponentDraft(target.id),
        );
      }
    }
  },
};
