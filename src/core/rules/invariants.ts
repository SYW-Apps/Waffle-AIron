import { ComponentSpec, ImplementationSpec, InterfaceSpec, TypeSpec } from '../../models/index.js';
import { RuleContext, SddRule } from './types.js';
import { matchTypeRef } from './type-analysis.js';

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
// lint.allow-suppressible; only dangling references are errors.
// ---------------------------------------------------------------------------

/** Split "<type-ref>.<invariant-id>" at the LAST dot (invariant ids cannot contain dots). */
function splitInvariantRef(ref: string): { typeRef: string; invariantId: string } | null {
  const at = ref.lastIndexOf('.');
  if (at <= 0 || at === ref.length - 1) return null;
  return { typeRef: ref.slice(0, at), invariantId: ref.slice(at + 1) };
}

function qualifiedTypeId(spec: TypeSpec): string {
  return spec.subsystem && !spec.id.startsWith(`${spec.subsystem}::`)
    ? `${spec.subsystem}::${spec.id}`
    : spec.id;
}

/** Resolve an assertsInvariants reference against the declared entity invariants. */
export function resolveInvariantRef(ref: string, types: TypeSpec[]): { type: TypeSpec; invariantId: string } | null {
  const parts = splitInvariantRef(ref);
  if (!parts) return null;
  for (const t of types) {
    if (!t.invariants?.length) continue;
    if (!matchTypeRef(parts.typeRef, qualifiedTypeId(t))) continue;
    if (t.invariants.some(inv => inv.id === parts.invariantId)) {
      return { type: t, invariantId: parts.invariantId };
    }
  }
  return null;
}

/**
 * Does this reference denote THIS type's invariant? Matched directly against
 * the type under check (suffix-style over its qualified id) instead of through
 * a global first-in-scan-order resolution: when two subsystems (or a parent
 * and a chained subproject) declare same-named entities with same-named
 * invariants, first-match attributed a bare ref to whichever type the scan
 * happened to list first — crediting the wrong type's write path and flagging
 * the right one. A qualified ref still only matches its own namespace.
 */
function refMatchesInvariant(ref: string, type: TypeSpec, invariantId: string): boolean {
  const parts = splitInvariantRef(ref);
  if (!parts || parts.invariantId !== invariantId) return false;
  if (!(type.invariants ?? []).some(inv => inv.id === invariantId)) return false;
  return matchTypeRef(parts.typeRef, qualifiedTypeId(type));
}

function stepAsserts(impl: ImplementationSpec, methodName: string, type: TypeSpec, invariantId: string): boolean {
  const method = impl.methods.find(m => m.name === methodName);
  if (!method) return false;
  return method.narrative.some(step =>
    (step.assertsInvariants ?? []).some(ref => refMatchesInvariant(ref, type, invariantId)),
  );
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
    'The invariant registry: entities may declare domain invariants (type.invariants), anchored through their componentClass. Every write-effect contract method of the owning component must carry a narrative step asserting each invariant (step.assertsInvariants: "<type-id>.<invariant-id>") — the same declared-and-backed shape as semantic guarantees. This is an HONEST lint over declarations: a green run means every write path visibly claims the invariant, never that the narrative or code actually enforces it. An invariant with no resolvable owner or no declared write path is unanchored; dangling assertion references are errors.',
  codes: [
    { code: 'DUPLICATE_INVARIANT_ID', defaultSeverity: 'error', summary: 'An entity declares two invariants with the same id' },
    { code: 'INVARIANT_UNANCHORED', defaultSeverity: 'warning', summary: 'An entity declares invariants but has no componentClass, its componentClass does not resolve, or the owning component declares no write-effect contract methods' },
    { code: 'UNASSERTED_INVARIANT', defaultSeverity: 'warning', summary: 'A write-effect method of the invariant\'s owning component has no narrative step asserting it' },
    { code: 'UNKNOWN_INVARIANT_REF', defaultSeverity: 'error', summary: 'A narrative step asserts an invariant that no entity declares' },
  ],
  check(ctx) {
    // --- entity side: duplicates, anchoring, and write-path coverage --------
    for (const t of ctx.types) {
      const invariants = t.invariants ?? [];
      if (invariants.length === 0) continue;

      const seen = new Set<string>();
      for (const inv of invariants) {
        if (seen.has(inv.id)) {
          ctx.addIssue(
            'error',
            'DUPLICATE_INVARIANT_ID',
            `Entity "${t.id}" declares invariant id "${inv.id}" more than once — invariant ids must be unique within the entity.`,
            t.id,
          );
        }
        seen.add(inv.id);
      }

      const comp = resolveComponentClass(t, ctx);
      if (!comp) {
        ctx.addIssue(
          'warning',
          'INVARIANT_UNANCHORED',
          `Entity "${t.id}" declares ${invariants.length} invariant(s) but ${t.componentClass ? `its componentClass "${t.componentClass}" does not resolve to a component` : 'has no componentClass'} — without an owning component there is no write path to hold the invariant against. Link the lifecycle owner via componentClass.`,
          t.id,
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
          ctx.isComponentDraft(comp.id),
        );
        continue;
      }

      for (const { intf, method } of writeMethods) {
        for (const impl of ctx.implementationsByContract.get(intf.id) ?? []) {
          const isDraftCtx = ctx.isImplementationDraft(impl);
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

    // --- step side: every assertion reference must resolve ------------------
    for (const impl of ctx.implementations) {
      const isDraftCtx = ctx.isImplementationDraft(impl);
      for (const method of impl.methods) {
        for (const step of method.narrative) {
          for (const ref of step.assertsInvariants ?? []) {
            if (resolveInvariantRef(ref, ctx.types)) continue;
            ctx.addIssue(
              'error',
              'UNKNOWN_INVARIANT_REF',
              `Step ${step.stepNumber} of "${method.name}" in implementation "${impl.id}" asserts invariant "${ref}", but no entity declares it (expected "<type-id>.<invariant-id>" naming a declared entry in that entity's invariants).`,
              impl.id,
              isDraftCtx,
            );
          }
        }
      }
    }
  },
};
