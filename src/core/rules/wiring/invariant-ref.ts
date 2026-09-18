import { TypeSpec, typeMatchesRef } from '../../../models/index.js';

// ---------------------------------------------------------------------------
// The invariant REFERENCE grammar: "<type-ref>.<invariant-id>", as a narrative
// step writes it in assertsInvariants.
//
// Two rules read such a reference from opposite ends — one resolves it to find
// whether ANY entity declares it, the other asks whether it denotes THIS
// entity's invariant — and the two must never disagree about what the string
// means. So the grammar is written once and the two readings sit beside it.
// ---------------------------------------------------------------------------

/** Split "<type-ref>.<invariant-id>" at the LAST dot (invariant ids cannot contain dots). */
export function splitInvariantRef(ref: string): { typeRef: string; invariantId: string } | null {
  const at = ref.lastIndexOf('.');
  if (at <= 0 || at === ref.length - 1) return null;
  return { typeRef: ref.slice(0, at), invariantId: ref.slice(at + 1) };
}

/** Resolve an assertsInvariants reference against the declared entity invariants. */
export function resolveInvariantRef(ref: string, types: TypeSpec[]): { type: TypeSpec; invariantId: string } | null {
  const parts = splitInvariantRef(ref);
  if (!parts) return null;
  for (const t of types) {
    if (!t.invariants?.length) continue;
    if (!typeMatchesRef(t, parts.typeRef)) continue;
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
export function refMatchesInvariant(ref: string, type: TypeSpec, invariantId: string): boolean {
  const parts = splitInvariantRef(ref);
  if (!parts || parts.invariantId !== invariantId) return false;
  if (!(type.invariants ?? []).some(inv => inv.id === invariantId)) return false;
  return typeMatchesRef(type, parts.typeRef);
}
