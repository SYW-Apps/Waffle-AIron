import { SddRule } from '../types.js';

/**
 * The lifecycle effect is closed under composition. A lifecycle method
 * creates, destroys, or (un)registers an entity's existence or membership and
 * never modifies its domain fields — so what it calls may only read or change
 * what exists. A call to a write-effect method makes the declaration false:
 * either the method is a write, or the write belongs to a workflow beside it.
 * Callees that declare no effect are not judged.
 */
export const lifecycleEffectClosureRule: SddRule = {
  name: 'lifecycle-effect-closure',
  judges: 'design',
  description:
    'A lifecycle-effect method may create, destroy, or (un)register an entity\'s existence or membership, never modify its domain fields — and the effect is closed under composition: its narrative may call only read- and lifecycle-effect methods besides its construction and local steps. A call step to a write-effect method from a lifecycle-effect method is a declaration error: the method is a write, or the write belongs to a workflow beside it. Called methods that declare no effect are not judged.',
  codes: [
    { code: 'LIFECYCLE_CALLS_WRITE', defaultSeverity: 'error', summary: 'Lifecycle-effect method whose narrative calls a write-effect method — the lifecycle effect is closed under composition' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      if (!contract) continue;
      const declared = ctx.interfaceMethodsOf(contract.component);
      const isDraftCtx = ctx.isImplementationDraft(impl);

      for (const implMethod of impl.methods) {
        if (declared.find(m => m.name === implMethod.name)?.effect !== 'lifecycle') continue;
        for (const step of implMethod.narrative) {
          if (step.type !== 'call' || !step.targetComponent || !step.targetMethod) continue;
          const called = ctx.interfaceMethodsOf(step.targetComponent).find(m => m.name === step.targetMethod);
          if (called?.effect !== 'write') continue;
          ctx.addIssue(
            'error',
            'LIFECYCLE_CALLS_WRITE',
            `"${contract.component}.${implMethod.name}" declares effect lifecycle, but step ${step.stepNumber} calls write-effect method ${step.targetComponent}.${step.targetMethod}. A lifecycle method creates, destroys or (un)registers what exists and never modifies domain fields, and the effect is closed under composition — it may call only read and lifecycle methods. Declare the method a write, or move the write to a workflow beside it.`,
            impl.id,
            isDraftCtx,
          );
        }
      }
    }
  },
};
