import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Narrative targets inside THIS tree. A call, dispatch or register step names
// the collaborator it reaches and (except for dispatch, which names a
// capability instead) the method it reaches on it. This rule answers: does the
// step name both, is the target a collaborator the caller declares, and does
// the target's contract carry that method with the guarantees the step
// asserts?
//
// Register steps (runtime-callback handoffs) name a target exactly like call
// steps do and get IDENTICAL target validation — the handoff must point at a
// real dependency's real method even though it never invokes. A dispatch
// step's capability is resolved against the target Portal's table by
// dispatch-step-routing, and a target this tree does not contain is
// cross-tree-references' and surface-reference-backing's.
// ---------------------------------------------------------------------------

export const narrativeTargetReferencesRule: SddRule = {
  name: 'narrative-target-references',
  description:
    'A narrative call, dispatch or register step must name a target component, and a target method unless it dispatches. A target this tree contains must be a collaborator the calling component declares, must carry the named method on one of its interfaces, and that method must declare every semantic guarantee the step asserts.',
  codes: [
    { code: 'MISSING_TARGET_COMPONENT', defaultSeverity: 'error', summary: 'Call/register step missing targetComponent' },
    { code: 'MISSING_TARGET_METHOD', defaultSeverity: 'error', summary: 'Call/register step missing targetMethod' },
    { code: 'UNDECLARED_DEPENDENCY_CALL', defaultSeverity: 'error', summary: 'Call step targets a component the caller does not depend on or own' },
    { code: 'INVALID_TARGET_METHOD_REFERENCE', defaultSeverity: 'error', summary: 'Call step targets a method not on any target interface' },
    { code: 'NARRATIVE_SEMANTIC_UNBACKED', defaultSeverity: 'warning', summary: 'Narrative asserts a guarantee the called contract does not declare' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      if (!contract) continue;

      const isDraftCtx = ctx.isImplementationDraft(impl);
      const caller = ctx.componentMap.get(contract.component);

      for (const implMethod of impl.methods) {
        for (const step of implMethod.narrative) {
          if (step.type !== 'call' && step.type !== 'dispatch' && step.type !== 'register') continue;

          if (!step.targetComponent) {
            ctx.addIssue(
              'error',
              'MISSING_TARGET_COMPONENT',
              `Method "${implMethod.name}" in implementation "${impl.id}" has a ${step.type} step (${step.stepNumber}) missing "targetComponent".`,
              impl.id,
              isDraftCtx,
            );
            continue;
          }
          const target = step.targetComponent;

          // Every entry kind reads the same in a finding: only the verb differs.
          const verb = step.type === 'dispatch' ? 'dispatches through'
            : step.type === 'register' ? 'registers callback'
              : 'calls';

          if (step.type !== 'dispatch' && !step.targetMethod) {
            ctx.addIssue(
              'error',
              'MISSING_TARGET_METHOD',
              `Method "${implMethod.name}" in implementation "${impl.id}" has a ${step.type} step (${step.stepNumber}) missing "targetMethod".`,
              impl.id,
              isDraftCtx,
            );
            continue;
          }

          // A target this tree does not contain leaves this rule's subject:
          // whether it resolves is cross-tree-references', and what the surface
          // it resolves to exposes is surface-reference-backing's.
          if (!ctx.componentMap.get(target)) continue;

          // The caller must declare every collaborator a step reaches.
          if (caller && target !== caller.id && !caller.dependsOn.includes(target) && !caller.owns.includes(target)) {
            ctx.addIssue(
              'error',
              'UNDECLARED_DEPENDENCY_CALL',
              `Method "${implMethod.name}" in implementation "${impl.id}" (component "${caller.id}") ${verb} component "${target}" (step ${step.stepNumber}) but component "${caller.id}" does not list "${target}" as a dependency.`,
              impl.id,
              isDraftCtx || ctx.isComponentDraft(caller.id),
            );
          }

          // A dispatch step names a capability, not a method: resolving it
          // against the target Portal's table is dispatch-step-routing's.
          if (step.type === 'dispatch') continue;

          // Check if target component has an interface containing targetMethod
          const targetInterfaces = ctx.interfacesByComponent.get(target) ?? [];
          let targetMethodSpec: (typeof targetInterfaces)[number]['methods'][number] | undefined;
          for (const targetIntf of targetInterfaces) {
            const found = targetIntf.methods.find(m => m.name === step.targetMethod);
            if (found) { targetMethodSpec = found; break; }
          }

          if (!targetMethodSpec) {
            ctx.addIssue(
              'error',
              'INVALID_TARGET_METHOD_REFERENCE',
              `Method "${implMethod.name}" in implementation "${impl.id}" ${verb} method "${step.targetMethod}" on component "${target}" which is not defined on any of its interfaces (step ${step.stepNumber}).`,
              impl.id,
              isDraftCtx || ctx.isComponentDraft(target),
            );
            continue;
          }

          // Semantic cross-check (consistency, not truth): the gate can't read prose, but
          // it CAN catch a narrative step that asserts a guarantee the contract it calls
          // doesn't declare. Data-driven over the recognized guarantee set — a step whose
          // description claims a guarantee must call a method that lists it in `guarantees`.
          // Whether the method truly delivers it is implementation correctness, not here.
          const declared = new Set(targetMethodSpec.guarantees ?? []);
          for (const g of step.assertsGuarantees ?? []) {
            if (!declared.has(g)) {
              ctx.addIssue(
                'warning',
                'NARRATIVE_SEMANTIC_UNBACKED',
                `Step ${step.stepNumber} of "${implMethod.name}" in implementation "${impl.id}" explicitly asserts guarantee "${g}", but the method it calls — "${step.targetMethod}" on "${target}" — does not list "${g}" among its L3 contract guarantees. Declare it on that method (and ensure its shape can deliver it), or revise the narrative.`,
                impl.id,
                isDraftCtx || ctx.isComponentDraft(target),
              );
            }
          }
        }
      }
    }
  },
};
