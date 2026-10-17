import { TypeSpec, typeMatchesRef, type ProjectFamily } from '../../../models/index.js';

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

/**
 * Every alias a project of the family declares, with the keys it names — the
 * table a type reference written through an alias (`sdk_cli::credential`) is
 * read by, since a member's key need not be its alias (stage 3: a member with
 * no declared id is keyed by its name slug).
 */
export function familyAliases(family?: ProjectFamily): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const node of family?.nodes ?? []) {
    for (const [alias, key] of node.aliases) {
      if (key === '' || key === alias) continue;
      out.set(alias, [...new Set([...(out.get(alias) ?? []), key])]);
    }
  }
  return out;
}

/** The ways a type reference may be read: as written, and through any alias its first segment is. */
function typeRefReadings(typeRef: string, aliases: Map<string, string[]>): string[] {
  const [first, ...rest] = typeRef.split(/::|\./);
  if (!rest.length) return [typeRef];
  return [typeRef, ...(aliases.get(first) ?? []).map((key) => `${key}::${rest.join('::')}`)];
}

/** Resolve an assertsInvariants reference against the declared entity invariants. */
export function resolveInvariantRef(
  ref: string,
  types: TypeSpec[],
  aliases: Map<string, string[]> = new Map(),
): { type: TypeSpec; invariantId: string } | null {
  const parts = splitInvariantRef(ref);
  if (!parts) return null;
  const readings = typeRefReadings(parts.typeRef, aliases);
  for (const t of types) {
    if (!t.invariants?.length) continue;
    if (!readings.some((reading) => typeMatchesRef(t, reading))) continue;
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
export function refMatchesInvariant(
  ref: string,
  type: TypeSpec,
  invariantId: string,
  aliases: Map<string, string[]> = new Map(),
): boolean {
  const parts = splitInvariantRef(ref);
  if (!parts || parts.invariantId !== invariantId) return false;
  if (!(type.invariants ?? []).some(inv => inv.id === invariantId)) return false;
  return typeRefReadings(parts.typeRef, aliases).some((reading) => typeMatchesRef(type, reading));
}
