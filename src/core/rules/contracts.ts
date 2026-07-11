import { SddRule } from './types.js';
import { resolveSurfaceRef } from './namespace.js';

/**
 * Contract ↔ implementation symmetry, and narrative-step resolution: every
 * `call` step targets a real dependency's real method, and any guarantee a
 * step asserts must be declared on the contract it calls.
 */
export const contractsRule: SddRule = {
  name: 'contract-symmetry-and-narratives',
  description:
    'Implementations mirror their contract method-for-method. Narrative call steps must name an existing component and method, the caller must declare the dependency, and asserted semantic guarantees must be backed by the target contract.',
  codes: [
    { code: 'UNEXPECTED_IMPLEMENTATION_METHOD', defaultSeverity: 'error', summary: 'Implementation method not present on the contract' },
    { code: 'MISSING_IMPLEMENTATION_METHOD', defaultSeverity: 'error', summary: 'Contract method missing from the implementation' },
    { code: 'MISSING_TARGET_COMPONENT', defaultSeverity: 'error', summary: 'Call step missing targetComponent' },
    { code: 'MISSING_TARGET_METHOD', defaultSeverity: 'error', summary: 'Call step missing targetMethod' },
    { code: 'INVALID_TARGET_COMPONENT_REFERENCE', defaultSeverity: 'error', summary: 'Call step targets a non-existent component' },
    { code: 'CROSS_TREE_REF_UNRESOLVED', defaultSeverity: 'warning', summary: 'Cross-tree reference (super::/:: form) with no surface snapshot covering it — only the parent project can verify it' },
    { code: 'SURFACE_REF_NOT_EXPOSED', defaultSeverity: 'error', summary: 'Cross-tree reference resolves to a surface snapshot that does not expose the called method/capability' },
    { code: 'UNDECLARED_DEPENDENCY_CALL', defaultSeverity: 'error', summary: 'Call step targets a component the caller does not depend on or own' },
    { code: 'INVALID_TARGET_METHOD_REFERENCE', defaultSeverity: 'error', summary: 'Call step targets a method not on any target interface' },
    { code: 'NARRATIVE_SEMANTIC_UNBACKED', defaultSeverity: 'warning', summary: 'Narrative asserts a guarantee the called contract does not declare' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      if (!contract) continue;

      const isDraftCtx = ctx.isImplementationDraft(impl);

      const contractMethodNames = new Set(contract.methods.map(m => m.name));
      const implMethodNames = new Set(impl.methods.map(m => m.name));

      // Check implementation has extra methods not defined in interface
      for (const implMethod of impl.methods) {
        if (!contractMethodNames.has(implMethod.name)) {
          ctx.addIssue(
            'error',
            'UNEXPECTED_IMPLEMENTATION_METHOD',
            `Implementation "${impl.id}" implements method "${implMethod.name}" which is not defined on contract "${contract.id}".`,
            impl.id,
            isDraftCtx,
          );
        }
      }

      // Check implementation is missing methods defined in interface
      for (const contractMethod of contract.methods) {
        if (!implMethodNames.has(contractMethod.name)) {
          ctx.addIssue(
            'error',
            'MISSING_IMPLEMENTATION_METHOD',
            `Implementation "${impl.id}" is missing implementation for contract method "${contractMethod.name}" from interface "${contract.id}".`,
            impl.id,
            isDraftCtx,
          );
        }
      }

      // Level 5 narrative step validation. Dispatch steps share the component-
      // existence and declared-dependency checks with call steps; capability
      // resolution against the target Portal's table is the dispatch rule's.
      for (const implMethod of impl.methods) {
        for (const step of implMethod.narrative) {
          if (step.type !== 'call' && step.type !== 'dispatch') continue;

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

          // An unresolved relative form (super::/::) means the ref points
          // outside THIS loading root — a chained subproject opened
          // standalone physically does not contain its parent's specs, so the
          // edge is only verifiable from the parent. That is a known-honest
          // state, not a spec defect: warn with its own code instead of
          // raising the same error a genuine typo gets.
          const isCrossTreeForm = step.targetComponent.startsWith('::') || step.targetComponent.startsWith('super::');

          if (step.type === 'dispatch') {
            const dispatchTarget = ctx.componentMap.get(step.targetComponent);
            if (!dispatchTarget) {
              if (isCrossTreeForm) {
                const resolved = resolveSurfaceRef(ctx, step.targetComponent);
                if (resolved) {
                  // Validate the capability against the DECLARED surface.
                  if (step.capability && !(resolved.entry.dispatch ?? []).some(b => b.capability === step.capability)) {
                    ctx.addIssue(
                      'error',
                      'SURFACE_REF_NOT_EXPOSED',
                      `Method "${implMethod.name}" in implementation "${impl.id}" dispatches capability "${step.capability}" through cross-tree portal "${step.targetComponent}" (step ${step.stepNumber}), but the surface snapshot of "${resolved.snapshot.projectName}" does not serve that capability on "${resolved.entry.id}".`,
                      impl.id,
                      isDraftCtx,
                    );
                  }
                  continue;
                }
                ctx.addIssue(
                  'warning',
                  'CROSS_TREE_REF_UNRESOLVED',
                  `Method "${implMethod.name}" in implementation "${impl.id}" dispatches through cross-tree component "${step.targetComponent}" (step ${step.stepNumber}), and no surface snapshot covers it — validate from the parent project, or import/generate the producing project's surface.`,
                  impl.id,
                  isDraftCtx,
                );
              } else {
                ctx.addIssue(
                  'error',
                  'INVALID_TARGET_COMPONENT_REFERENCE',
                  `Method "${implMethod.name}" in implementation "${impl.id}" dispatches through component "${step.targetComponent}" which does not exist (step ${step.stepNumber}).`,
                  impl.id,
                  isDraftCtx,
                );
              }
              continue;
            }
            const dispatchCaller = ctx.componentMap.get(contract.component);
            if (dispatchCaller && step.targetComponent !== dispatchCaller.id
                && !dispatchCaller.dependsOn.includes(step.targetComponent)
                && !dispatchCaller.owns.includes(step.targetComponent)) {
              ctx.addIssue(
                'error',
                'UNDECLARED_DEPENDENCY_CALL',
                `Method "${implMethod.name}" in implementation "${impl.id}" (component "${dispatchCaller.id}") dispatches through component "${step.targetComponent}" (step ${step.stepNumber}) but component "${dispatchCaller.id}" does not list "${step.targetComponent}" as a dependency.`,
                impl.id,
                isDraftCtx || ctx.isComponentDraft(dispatchCaller.id),
              );
            }
            continue;
          }

          if (!step.targetMethod) {
            ctx.addIssue(
              'error',
              'MISSING_TARGET_METHOD',
              `Method "${implMethod.name}" in implementation "${impl.id}" has a call step (${step.stepNumber}) missing "targetMethod".`,
              impl.id,
              isDraftCtx,
            );
            continue;
          }

          const targetComp = ctx.componentMap.get(step.targetComponent);
          if (!targetComp) {
            if (isCrossTreeForm) {
              const resolved = resolveSurfaceRef(ctx, step.targetComponent);
              if (resolved) {
                // Validate method + asserted guarantees against the DECLARED surface.
                const surfaceMethod = resolved.entry.methods.find(m => m.name === step.targetMethod);
                if (!surfaceMethod) {
                  ctx.addIssue(
                    'error',
                    'SURFACE_REF_NOT_EXPOSED',
                    `Method "${implMethod.name}" in implementation "${impl.id}" calls "${step.targetMethod}" on cross-tree component "${step.targetComponent}" (step ${step.stepNumber}), but the surface snapshot of "${resolved.snapshot.projectName}" does not expose that method on "${resolved.entry.id}".`,
                    impl.id,
                    isDraftCtx,
                  );
                } else if (step.assertsGuarantees) {
                  const declared = new Set(surfaceMethod.guarantees ?? []);
                  for (const g of step.assertsGuarantees) {
                    if (!declared.has(g)) {
                      ctx.addIssue(
                        'warning',
                        'NARRATIVE_SEMANTIC_UNBACKED',
                        `Step ${step.stepNumber} of "${implMethod.name}" in implementation "${impl.id}" asserts guarantee "${g}", but the surface snapshot of "${resolved.snapshot.projectName}" does not declare it on "${resolved.entry.id}.${step.targetMethod}".`,
                        impl.id,
                        isDraftCtx,
                      );
                    }
                  }
                }
                continue;
              }
              ctx.addIssue(
                'warning',
                'CROSS_TREE_REF_UNRESOLVED',
                `Method "${implMethod.name}" in implementation "${impl.id}" calls cross-tree component "${step.targetComponent}" (step ${step.stepNumber}), and no surface snapshot covers it — validate from the parent project, or import/generate the producing project's surface.`,
                impl.id,
                isDraftCtx,
              );
            } else {
              ctx.addIssue(
                'error',
                'INVALID_TARGET_COMPONENT_REFERENCE',
                `Method "${implMethod.name}" in implementation "${impl.id}" calls component "${step.targetComponent}" which does not exist (step ${step.stepNumber}).`,
                impl.id,
                isDraftCtx,
              );
            }
            continue;
          }

          // Check if calling component declares targetComponent as dependency
          const callingComponent = ctx.componentMap.get(contract.component);
          if (callingComponent && step.targetComponent !== callingComponent.id) {
            if (!callingComponent.dependsOn.includes(step.targetComponent) &&
                !callingComponent.owns.includes(step.targetComponent)) {
              ctx.addIssue(
                'error',
                'UNDECLARED_DEPENDENCY_CALL',
                `Method "${implMethod.name}" in implementation "${impl.id}" (component "${callingComponent.id}") calls component "${step.targetComponent}" (step ${step.stepNumber}) but component "${callingComponent.id}" does not list "${step.targetComponent}" as a dependency.`,
                impl.id,
                isDraftCtx || ctx.isComponentDraft(callingComponent.id),
              );
            }
          }

          // Check if target component has an interface containing targetMethod
          const targetInterfaces = ctx.interfacesByComponent.get(step.targetComponent) ?? [];
          let targetMethodSpec: (typeof targetInterfaces)[number]['methods'][number] | undefined;
          for (const targetIntf of targetInterfaces) {
            const found = targetIntf.methods.find(m => m.name === step.targetMethod);
            if (found) { targetMethodSpec = found; break; }
          }

          if (!targetMethodSpec) {
            ctx.addIssue(
              'error',
              'INVALID_TARGET_METHOD_REFERENCE',
              `Method "${implMethod.name}" in implementation "${impl.id}" calls method "${step.targetMethod}" on component "${step.targetComponent}" which is not defined on any of its interfaces (step ${step.stepNumber}).`,
              impl.id,
              isDraftCtx || ctx.isComponentDraft(step.targetComponent),
            );
          } else {
            // Semantic cross-check (consistency, not truth): the gate can't read prose, but
            // it CAN catch a narrative step that asserts a guarantee the contract it calls
            // doesn't declare. Data-driven over the recognized guarantee set — a step whose
            // description claims a guarantee must call a method that lists it in `guarantees`.
            // Whether the method truly delivers it is implementation correctness, not here.
            const declared = new Set(targetMethodSpec.guarantees ?? []);
            if (step.assertsGuarantees) {
              for (const g of step.assertsGuarantees) {
                if (!declared.has(g)) {
                  ctx.addIssue(
                    'warning',
                    'NARRATIVE_SEMANTIC_UNBACKED',
                    `Step ${step.stepNumber} of "${implMethod.name}" in implementation "${impl.id}" explicitly asserts guarantee "${g}", but the method it calls — "${step.targetMethod}" on "${step.targetComponent}" — does not list "${g}" among its L3 contract guarantees. Declare it on that method (and ensure its shape can deliver it), or revise the narrative.`,
                    impl.id,
                    isDraftCtx || ctx.isComponentDraft(step.targetComponent),
                  );
                }
              }
            }
          }
        }
      }
    }
  },
};
