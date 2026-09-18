import { ComponentSpec, ImplementationSpec, InterfaceSpec, TypeSpec, isDraftSubsystem } from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';
import { refMatchesInvariant } from './invariant-ref.js';

// ---------------------------------------------------------------------------
// The invariant registry — an HONEST linter, deliberately not a prover.
//
// An entity declares domain invariants (e.g. "slug unique among siblings" —
// the class of bug where a property held nowhere because nobody owned it).
// Anchoring piggybacks the existing entity→component link (componentClass)
// and the existing effect dial: every write-effect contract method of the
// owning component must carry a narrative step ASSERTING each invariant
// (step.assertsInvariants: ["<type-id>.<invariant-id>"]), mirroring how
// claimed guarantees must be backed by narrative steps.
//
// What a green run proves: someone declared the property AND every write path
// visibly claims to uphold it. What it never proves: that the narrative (or
// the code) actually enforces it — that is implementer correctness, checked
// by tests, not by prose analysis. Findings default to warnings and are
// lint.allow-suppressible.
//
// The two codes are one question asked of one chain — who owns the invariant,
// and does each of that owner's write paths claim it — so the owner resolution
// and its write-method scan are paid once and read by both.
// ---------------------------------------------------------------------------

/**
 * Whether the implementation's realization of the write method carries a step
 * asserting the invariant. An implementation that does not implement the method
 * has no such step: the obligation attaches to the contract's write method,
 * which exists, so the finding stands beside MISSING_IMPLEMENTATION_METHOD and
 * names the invariants the missing narrative must assert.
 */
function stepAsserts(impl: ImplementationSpec, methodName: string, type: TypeSpec, invariantId: string): boolean {
  const method = impl.methods.find(m => m.name === methodName);
  if (!method) return false;
  return method.narrative.some(step =>
    (step.assertsInvariants ?? []).some(ref => refMatchesInvariant(ref, type, invariantId)),
  );
}

/**
 * Whether the entity is draft context: its owning subsystem has status draft
 * or design. A type carries no status of its own, so its subsystem decides,
 * as it does for UNUSED_TYPE.
 */
function isEntityDraft(t: TypeSpec, ctx: RuleContext): boolean {
  const sub = t.subsystem ? ctx.subsystems.find(s => s.id === t.subsystem) : undefined;
  return sub !== undefined && isDraftSubsystem(sub);
}

/**
 * The entity's owning component. componentClass survives namespacing
 * UNQUALIFIED (the loader qualifies type ids but not this link), so a chained
 * subproject's entity names its owner in the child's own id space — resolve
 * exact first, then inside the entity's mount namespace.
 */
function resolveComponentClass(t: TypeSpec, ctx: RuleContext): ComponentSpec | undefined {
  if (!t.componentClass) return undefined;
  const direct = ctx.componentMap.get(t.componentClass);
  if (direct) return direct;
  const at = t.id.lastIndexOf('::');
  if (at === -1) return undefined;
  return ctx.componentMap.get(`${t.id.slice(0, at)}::${t.componentClass}`);
}

export const invariantBackingRule: SddRule = {
  name: 'invariant-backing',
  description:
    'The invariant registry: entities may declare domain invariants (type.invariants), anchored through their componentClass. Every write-effect contract method of the owning component must carry a narrative step asserting each invariant (step.assertsInvariants: "<type-id>.<invariant-id>") — the same declared-and-backed shape as semantic guarantees. This is an HONEST lint over declarations: a green run means every write path visibly claims the invariant, never that the narrative or code actually enforces it. An invariant with no resolvable owner or no declared write path is unanchored, and nothing further is claimed about it.',
  codes: [
    { code: 'INVARIANT_UNANCHORED', defaultSeverity: 'warning', summary: 'An entity declares invariants but has no componentClass, its componentClass does not resolve, or the owning component declares no write-effect contract methods' },
    { code: 'UNASSERTED_INVARIANT', defaultSeverity: 'warning', summary: 'A write-effect method of the invariant\'s owning component has no narrative step asserting it' },
  ],
  check(ctx) {
    for (const t of ctx.types) {
      const invariants = t.invariants ?? [];
      if (invariants.length === 0) continue;
      // Every finding here is draft context while the entity is.
      const entityDraft = isEntityDraft(t, ctx);

      const comp = resolveComponentClass(t, ctx);
      if (!comp) {
        ctx.addIssue(
          'warning',
          'INVARIANT_UNANCHORED',
          `Entity "${t.id}" declares ${invariants.length} invariant(s) but ${t.componentClass ? `its componentClass "${t.componentClass}" does not resolve to a component` : 'has no componentClass'} — without an owning component there is no write path to hold the invariant against. Link the lifecycle owner via componentClass.`,
          t.id,
          entityDraft,
        );
        continue;
      }

      const contracts: InterfaceSpec[] = ctx.interfacesByComponent.get(comp.id) ?? [];
      const writeMethods = contracts.flatMap(intf =>
        intf.methods.filter(m => m.effect === 'write').map(m => ({ intf, method: m })),
      );
      if (writeMethods.length === 0) {
        ctx.addIssue(
          'warning',
          'INVARIANT_UNANCHORED',
          `Entity "${t.id}" declares ${invariants.length} invariant(s) anchored to "${comp.id}", but none of that component's contract methods declare effect: write — the validator cannot identify the write paths that must assert them. Tag the mutating methods with effect: write.`,
          t.id,
          entityDraft || ctx.isComponentDraft(comp.id),
        );
        continue;
      }

      for (const { intf, method } of writeMethods) {
        for (const impl of ctx.implementationsByContract.get(intf.id) ?? []) {
          const isDraftCtx = entityDraft || ctx.isImplementationDraft(impl);
          for (const inv of invariants) {
            if (stepAsserts(impl, method.name, t, inv.id)) continue;
            ctx.addIssue(
              'warning',
              'UNASSERTED_INVARIANT',
              `Write method "${method.name}" of "${comp.id}" (implementation "${impl.id}") has no narrative step asserting invariant "${t.id}.${inv.id}" (${inv.description}). Add the step that upholds it and mark it with assertsInvariants — or lint.allow with a reason. Note: an assertion only declares the intent; it does not prove enforcement.`,
              impl.id,
              isDraftCtx,
            );
          }
        }
      }
    }
  },
};
