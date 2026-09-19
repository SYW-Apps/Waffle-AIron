// ---------------------------------------------------------------------------
// Canonical JSON
//
// The one deterministic serialization every identity digest is taken over:
// object keys sorted recursively, so key or formatting order never moves a
// digest, and the volatile createdAt/updatedAt metadata stripped, so a re-save
// that only bumps a timestamp never shifts an identity. The content identity
// and the snapshot input keys (sdd_core) and the gate identity (sdd_validator)
// all digest this form; it lives here because the validator must not import
// core to reach it.
// ---------------------------------------------------------------------------

/** Stable serialization: object keys sorted recursively, volatile timestamps stripped. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * The ONE string comparison an identity may sort by: ordinal, i.e. JavaScript's
 * `<` on strings (UTF-16 code-unit order, which is code-point order for every
 * character an id or a rule name can hold).
 *
 * `localeCompare` is the trap this exists to replace. It is locale- and
 * ICU-dependent: it ignores or re-weights hyphens and underscores, and two
 * machines running the same wairon on the same files can order the same names
 * differently — so a digest taken over a localeCompare-sorted list is not an
 * identity, it is an identity PER MACHINE. Ordinal order is fixed everywhere
 * that JavaScript runs, which is exactly what a digest needs and exactly what a
 * human-readable listing does not: display order may keep localeCompare.
 */
export function compareOrdinal(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (k === 'createdAt' || k === 'updatedAt') continue; // volatile metadata
      out[k] = sortKeys(src[k]);
    }
    return out;
  }
  return v;
}
