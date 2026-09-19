import { parseDeclaredCall } from '../../../models/index.js';
import type { Guarantee, MethodImplementation } from '../../../models/index.js';
import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Narrative targets inside THIS tree. A call, dispatch or register step names
// the collaborator it reaches and (except for dispatch, which names a
// capability instead) the method it reaches on it. This rule answers: does the
// entry name both, is the target a collaborator the caller declares, and does
// the target's contract carry that method with the guarantees the entry
// asserts?
//
// Register steps (runtime-callback handoffs) name a target exactly like call
// steps do and get IDENTICAL target validation — the handoff must point at a
// real dependency's real method even though it never invokes. A dispatch
// step's capability is resolved against the target Portal's table by
// dispatch-step-routing, and a target this tree does not contain is
// cross-tree-references' and surface-reference-backing's.
//
// A method's DECLARED calls (`calls`, what a method says it calls when its
// narrative does not show the steps) name a target the same way, so they ride
// the same loop rather than a second one: they arrive as entries with no step
// number, and the only question they add is whether the reference parses as
// `<component>.<method>` at all. Anything weaker and a declaration would buy
// reachability for free.
// ---------------------------------------------------------------------------

/**
 * One target a method names, however it names it (target_entry): a narrative
 * step, or an entry of the method's declared `calls`. `stepNumber` is what
 * tells them apart in a finding — a declared call has no step to point at —
 * and `unparsed` carries a declared reference that is not
 * `<component>.<method>` at all.
 */
interface TargetEntry {
  kind: 'call' | 'dispatch' | 'register' | 'declared';
  stepNumber?: number;
  targetComponent?: string;
  targetMethod?: string;
  assertsGuarantees?: Guarantee[];
  unparsed?: string;
}

/** The targets one method names, narrative steps first, then declared calls. */
const targetsOf = (implMethod: MethodImplementation): TargetEntry[] => {
  const entries: TargetEntry[] = [];
  for (const step of implMethod.narrative) {
    if (step.type !== 'call' && step.type !== 'dispatch' && step.type !== 'register') continue;
    entries.push({
      kind: step.type,
      stepNumber: step.stepNumber,
      targetComponent: step.targetComponent,
      targetMethod: step.targetMethod,
      assertsGuarantees: step.assertsGuarantees,
    });
  }
  for (const ref of implMethod.calls ?? []) {
    const parsed = parseDeclaredCall(ref);
    entries.push(parsed
      ? { kind: 'declared', targetComponent: parsed.compId, targetMethod: parsed.methodName }
      : { kind: 'declared', unparsed: ref });
  }
  return entries;
};

export const narrativeTargetReferencesRule: SddRule = {
  name: 'narrative-target-references',
  description:
    'A narrative call, dispatch or register step must name a target component, and a target method unless it dispatches; a method\'s declared calls name the same pair as one "<component>.<method>" reference, the spelling the conformance debt register and a lint allow name a unit with. A target this tree contains must be a collaborator the calling component declares, must carry the named method on one of its interfaces, and that method must declare every semantic guarantee the entry asserts.',
  codes: [
    { code: 'MISSING_TARGET_COMPONENT', defaultSeverity: 'error', summary: 'Call/register step missing targetComponent' },
    { code: 'MISSING_TARGET_METHOD', defaultSeverity: 'error', summary: 'Call/register step missing targetMethod' },
    { code: 'MALFORMED_DECLARED_CALL', defaultSeverity: 'error', summary: 'Declared call that is not a "<component>.<method>" reference' },
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
        for (const entry of targetsOf(implMethod)) {
          // Where a finding points: at the step, or at the declared call that
          // has no step to point at.
          const where = entry.stepNumber === undefined ? '' : ` (step ${entry.stepNumber})`;

          // A declared reference that is not "<component>.<method>" names no
          // target at all — the declared-call counterpart of a step missing
          // its targetComponent.
          if (entry.unparsed !== undefined) {
            ctx.addIssue(
              'error',
              'MALFORMED_DECLARED_CALL',
              `Method "${implMethod.name}" in implementation "${impl.id}" declares the call "${entry.unparsed}", which is not a "<component>.<method>" reference — the spelling the conformance debt register and a lint allow name a unit with.`,
              impl.id,
              isDraftCtx,
            );
            continue;
          }

          if (!entry.targetComponent) {
            ctx.addIssue(
              'error',
              'MISSING_TARGET_COMPONENT',
              `Method "${implMethod.name}" in implementation "${impl.id}" has a ${entry.kind} step (${entry.stepNumber}) missing "targetComponent".`,
              impl.id,
              isDraftCtx,
            );
            continue;
          }
          const target = entry.targetComponent;

          // Every entry kind reads the same in a finding: only the verb differs.
          const verb = entry.kind === 'dispatch' ? 'dispatches through'
            : entry.kind === 'register' ? 'registers callback'
              : entry.kind === 'declared' ? 'declares a call to'
                : 'calls';

          if (entry.kind !== 'dispatch' && !entry.targetMethod) {
            ctx.addIssue(
              'error',
              'MISSING_TARGET_METHOD',
              `Method "${implMethod.name}" in implementation "${impl.id}" has a ${entry.kind} step (${entry.stepNumber}) missing "targetMethod".`,
              impl.id,
              isDraftCtx,
            );
            continue;
          }

          // A target this tree does not contain leaves this rule's subject:
          // whether it resolves is cross-tree-references', and what the surface
          // it resolves to exposes is surface-reference-backing's.
          if (!ctx.componentMap.get(target)) continue;

          // The caller must declare every collaborator an entry reaches.
          if (caller && target !== caller.id && !caller.dependsOn.includes(target) && !caller.owns.includes(target)) {
            ctx.addIssue(
              'error',
              'UNDECLARED_DEPENDENCY_CALL',
              `Method "${implMethod.name}" in implementation "${impl.id}" (component "${caller.id}") ${verb} component "${target}"${where} but component "${caller.id}" does not list "${target}" as a dependency.`,
              impl.id,
              isDraftCtx || ctx.isComponentDraft(caller.id),
            );
          }

          // A dispatch step names a capability, not a method: resolving it
          // against the target Portal's table is dispatch-step-routing's.
          if (entry.kind === 'dispatch') continue;

          // Check if target component has an interface containing targetMethod
          const targetInterfaces = ctx.interfacesByComponent.get(target) ?? [];
          let targetMethodSpec: (typeof targetInterfaces)[number]['methods'][number] | undefined;
          for (const targetIntf of targetInterfaces) {
            const found = targetIntf.methods.find(m => m.name === entry.targetMethod);
            if (found) { targetMethodSpec = found; break; }
          }

          if (!targetMethodSpec) {
            ctx.addIssue(
              'error',
              'INVALID_TARGET_METHOD_REFERENCE',
              `Method "${implMethod.name}" in implementation "${impl.id}" ${verb} method "${entry.targetMethod}" on component "${target}" which is not defined on any of its interfaces${where}.`,
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
          for (const g of entry.assertsGuarantees ?? []) {
            if (!declared.has(g)) {
              ctx.addIssue(
                'warning',
                'NARRATIVE_SEMANTIC_UNBACKED',
                `Step ${entry.stepNumber} of "${implMethod.name}" in implementation "${impl.id}" explicitly asserts guarantee "${g}", but the method it calls — "${entry.targetMethod}" on "${target}" — does not list "${g}" among its L3 contract guarantees. Declare it on that method (and ensure its shape can deliver it), or revise the narrative.`,
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
